/**
 * scout.ts — File/symbol search and AST-level dependency graph builder.
 *
 * Scout is summoned before any multi-file change to map dependencies.
 * It returns minimal slices (never full files) to keep context lean.
 * Results are cached per-session; cache invalidates when Crafters write.
 *
 * Architecture:
 *   1. Glob + grep for file/symbol discovery (zero deps, node:fs)
 *   2. Regex-based ESM import/export parsing (confidence: "high" for ESM,
 *      "low" for ambiguous/dynamic cases)
 *   3. Session-scoped cache with proactive invalidation
 *
 * @see docs/prd.md §3 — Scout role
 * @see docs/flow.md §3 — Dependency Graph → Phases
 * @see docs/plan.md Phase 1
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, extname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Truncation (own impl — pi runtime functions not available in tests) ────

interface TruncationResult {
  content: string;
  truncated: boolean;
  outputLines: number;
  totalLines: number;
}

function truncateHead(
  content: string,
  opts: { maxLines?: number; maxBytes?: number },
): TruncationResult {
  const maxLines = opts.maxLines ?? 200;
  const maxBytes = opts.maxBytes ?? 10_000;

  const allLines = content.split("\n");
  const totalLines = allLines.length;

  let output = "";
  let outputLines = 0;
  let truncated = false;

  for (const line of allLines) {
    const candidate = output ? output + "\n" + line : line;
    if (
      outputLines + 1 > maxLines ||
      Buffer.byteLength(candidate, "utf8") > maxBytes
    ) {
      truncated = true;
      break;
    }
    output = candidate;
    outputLines++;
  }

  return { content: output, truncated, outputLines, totalLines };
}
import { registerAgent } from "../core/agents";
import { checkAndClearDirty, markScoutDirty } from "../core/state";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScoutSlice {
  file: string;
  lines: string;
  matchLines: number[];
}

export interface DependencyGraph {
  [file: string]: {
    exports: string[];
    imports: string[];
    importedBy: string[];
  };
}

export interface ScoutResult {
  graph: DependencyGraph;
  slices: ScoutSlice[];
  confidence: "high" | "low";
}

interface CacheEntry {
  graph: DependencyGraph;
  mtime: number;
  confidence: "high" | "low";
}

// ── Cache ──────────────────────────────────────────────────────────────────

const graphCache = new Map<string, CacheEntry>();

function getMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function cacheKey(scope: string): string {
  return resolve(scope);
}

// ── File Discovery ─────────────────────────────────────────────────────────

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts", ".cjs", ".cts",
]);

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(path));
}

function shouldSkipDir(name: string): boolean {
  return (
    name.startsWith(".") ||
    name === "node_modules" ||
    name === "dist" ||
    name === "build" ||
    name === ".git"
  );
}

/** Recursively collect source files under a directory. */
function collectFiles(dir: string, accumulator: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return accumulator;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (!shouldSkipDir(entry)) {
        collectFiles(fullPath, accumulator);
      }
    } else if (stat.isFile() && isSourceFile(fullPath)) {
      accumulator.push(fullPath);
    }
  }

  return accumulator;
}

// ── Symbol Search ──────────────────────────────────────────────────────────

interface SearchMatch {
  file: string;
  line: number;
}

/** Grep for a pattern across collected files. Returns file + line numbers. */
function grepFiles(files: string[], pattern: string): SearchMatch[] {
  const results: SearchMatch[] = [];
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "gm");
  } catch {
    return results; // invalid regex, return empty
  }

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        results.push({ file, line: i + 1 }); // 1-indexed
      }
    }
  }

  return results;
}

// ── Slice Extraction ───────────────────────────────────────────────────────

/** Extract relevant slices from matched files. Returns minimal context. */
function extractSlices(matches: SearchMatch[]): ScoutSlice[] {
  const byFile = new Map<string, number[]>();
  for (const m of matches) {
    const lines = byFile.get(m.file) || [];
    lines.push(m.line);
    byFile.set(m.file, lines);
  }

  const slices: ScoutSlice[] = [];
  for (const [file, matchLines] of byFile) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    const truncation = truncateHead(content, { maxLines: 200, maxBytes: 10_000 });
    let result = truncation.content;
    if (truncation.truncated) {
      result += `\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines]`;
    }
    slices.push({
      file,
      lines: result,
      matchLines,
    });
  }

  return slices;
}

// ── AST Parsing (regex-based) ──────────────────────────────────────────────

/**
 * Parse import/export statements using regex.
 * Returns a dependency graph and confidence level.
 *
 * "high" confidence: all imports/exports parsed cleanly via regex.
 * "low" confidence: dynamic imports, require(), or parse errors encountered.
 */
function parseDependencyGraph(files: string[]): { graph: DependencyGraph; confidence: "high" | "low" } {
  const graph: DependencyGraph = {};
  let confidence: "high" | "low" = "high";

  // Regex patterns for ESM
  const importRe = /import\s+(?:(?:\{[^}]*\}|[\w*\s,]+)\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const exportRe = /export\s+(?:const|let|var|function|class|default|type|interface|enum|abstract|async)?\s*(\w+)/g;

  // Initialize graph entries — use scope dir as base for relative paths
  const baseDir = files.length > 0 ? dirname(files[0]) : process.cwd();
  for (const file of files) {
    const relPath = relative(baseDir, file);
    graph[relPath] = { exports: [], imports: [], importedBy: [] };
  }

  // Pass 1: collect imports for each file
  const fileToImportPaths = new Map<string, string[]>();

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      confidence = "low";
      continue;
    }

    const relFile = relative(baseDir, file);
    const imports: string[] = [];

    // Static ESM imports
    let match: RegExpExecArray | null;
    importRe.lastIndex = 0;
    while ((match = importRe.exec(content)) !== null) {
      imports.push(match[1]);
    }

    // Dynamic imports → lower confidence
    dynamicImportRe.lastIndex = 0;
    if (dynamicImportRe.test(content)) {
      confidence = "low";
    }

    // require() calls → lower confidence
    requireRe.lastIndex = 0;
    if (requireRe.test(content)) {
      confidence = "low";
    }

    // Exports
    exportRe.lastIndex = 0;
    while ((match = exportRe.exec(content)) !== null) {
      if (match[1]) {
        graph[relFile].exports.push(match[1]);
      }
    }

    fileToImportPaths.set(relFile, imports);
  }

  // Pass 2: resolve imports to actual files and build imports + importedBy
  for (const [relFile, importPaths] of fileToImportPaths) {
    for (const importPath of importPaths) {
      const resolved = resolveImport(importPath, relFile, files, baseDir);
      if (resolved) {
        graph[relFile].imports.push(resolved);
        graph[resolved].importedBy.push(relFile);
      }
    }
  }

  return { graph, confidence };
}

/**
 * Resolve a relative import path to an actual file in the project.
 * Handles extension-less imports (TypeScript convention).
 */
function resolveImport(
  importPath: string,
  fromFile: string,
  allFiles: string[],
  baseDir: string,
): string | null {
  // Skip external packages
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
    return null;
  }

  const fromDir = dirname(resolve(baseDir, fromFile));
  const resolved = resolve(fromDir, importPath);

  // Try exact match first
  for (const f of allFiles) {
    if (f === resolved) return relative(baseDir, f);
  }

  // Try with extensions
  for (const ext of SOURCE_EXTENSIONS) {
    const withExt = resolved + ext;
    for (const f of allFiles) {
      if (f === withExt) return relative(baseDir, f);
    }
  }

  // Try /index.ext
  for (const ext of SOURCE_EXTENSIONS) {
    const indexPath = join(resolved, "index" + ext);
    for (const f of allFiles) {
      if (f === indexPath) return relative(baseDir, f);
    }
  }

  return null;
}

// ── Main Scout Logic ──────────────────────────────────────────────────────

export interface ScoutParams {
  scope: string;
  pattern?: string;
}

export async function runScout(params: ScoutParams): Promise<ScoutResult> {
  const scopePath = resolve(params.scope);
  const files = collectFiles(scopePath);

  // Build / retrieve dependency graph (with cache)
  const key = cacheKey(params.scope);
  let graphResult: { graph: DependencyGraph; confidence: "high" | "low" };

  const cached = graphCache.get(key);
  const isDirty = checkAndClearDirty(key); // also checks individual file dirtiness

  if (cached && !isDirty) {
    // Still need to check per-file mtimes
    let anyStale = false;
    for (const file of files) {
      const mtime = getMtime(file);
      if (mtime > cached.mtime) {
        anyStale = true;
        break;
      }
    }
    if (!anyStale) {
      graphResult = { graph: cached.graph, confidence: cached.confidence };
    } else {
      graphResult = parseDependencyGraph(files);
      graphCache.set(key, { ...graphResult, mtime: Date.now() });
    }
  } else {
    graphResult = parseDependencyGraph(files);
    graphCache.set(key, { ...graphResult, mtime: Date.now() });
  }

  // Symbol search if pattern provided
  let slices: ScoutSlice[] = [];
  if (params.pattern) {
    const matches = grepFiles(files, params.pattern);
    slices = extractSlices(matches);
  }

  return {
    graph: graphResult.graph,
    slices,
    confidence: graphResult.confidence,
  };
}

/** Invalidate cached graph for a file and its reverse dependencies. */
export function invalidateFile(filePath: string): void {
  // Invalidate the file itself
  markScoutDirty(filePath);

  // Also invalidate all files that import this file (transitive)
  for (const [key, entry] of graphCache) {
    const relPath = relative(process.cwd(), filePath);
    const deps = entry.graph[relPath]?.importedBy;
    if (deps) {
      for (const dep of deps) {
        markScoutDirty(dep);
      }
      // Invalidate the whole cache entry since any file inside may be affected
      markScoutDirty(key);
    }
  }
}

// ── Tool Registration ──────────────────────────────────────────────────────

export function registerScout(pi: ExtensionAPI): void {
  registerAgent(pi, {
    name: "scout",
    description:
      "Finds files, symbols, and builds AST-level dependency graphs. " +
      "Returns minimal slices (not full files) to keep context lean. " +
      "Use before planning any multi-file change.",
    promptSnippet: "Map file dependencies and find symbols",
    promptGuidelines: [
      "Use summon_scout before planning any multi-file change to build a dependency graph first.",
      "Provide a scope (directory) and optional pattern (symbol to find).",
      "If confidence is 'low', treat the plan as single-phase (serial execution).",
    ],
    async handler(task, _ctx) {
      // Parse task as JSON or plain scope string
      let params: ScoutParams;
      try {
        params = JSON.parse(task);
      } catch {
        params = { scope: task };
      }

      const result = await runScout(params);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
        details: result,
      };
    },
  });
}
