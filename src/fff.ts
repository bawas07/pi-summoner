/**
 * Optional FFF integration (@ff-labs/pi-fff / @ff-labs/fff-node).
 *
 * When the FFF native engine is installed in the environment, Scout gets fast,
 * Rust-native, frecency-ranked search tools (`fff_grep`, `fff_find`) instead of
 * relying on the built-in grep/find (which spawn rg/fd subprocesses). When it is
 * NOT installed, every entry point degrades gracefully — Scout falls back to the
 * built-in tools and nothing breaks.
 *
 * We deliberately call the `fff-node` library directly (not bind the pi-fff
 * extension) so this works inside an isolated `createAgentSession` without loading
 * extensions or risking summoner re-entrancy.
 */

import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// `fff-node` is an optional, env-provided peer (native binaries) — never a hard
// dependency. Loaded via dynamic import and cached; `null` means unavailable.
type FffModule = {
  binaryExists?: () => boolean;
  FileFinder: {
    create: (opts: { basePath: string; aiMode?: boolean }) =>
      | { ok: true; value: FffFinder }
      | { ok: false; error: string };
  };
};

interface FffFinder {
  isDestroyed: boolean;
  destroy(): void;
  grep(
    query: string,
    options?: Record<string, unknown>,
  ): { ok: true; value: { items: FffGrepMatch[] } } | { ok: false; error: string };
  fileSearch(
    query: string,
    options?: Record<string, unknown>,
  ):
    | { ok: true; value: { items: { relativePath: string }[] } }
    | { ok: false; error: string };
}

interface FffGrepMatch {
  relativePath: string;
  lineNumber: number;
  lineContent: string;
  isDefinition?: boolean;
}

let cached: { mod: FffModule | null } | null = null;

async function loadFff(): Promise<FffModule | null> {
  if (cached) return cached.mod;
  try {
    // Non-literal specifier: this is an OPTIONAL, env-provided package that is not a
    // declared dependency, so we must not let TS/bundlers try to resolve it statically.
    const spec = "@ff-labs/fff-node";
    const mod = (await import(spec)) as unknown as FffModule;
    const ok = typeof mod.binaryExists === "function" ? mod.binaryExists() : true;
    cached = { mod: ok ? mod : null };
  } catch {
    cached = { mod: null };
  }
  return cached.mod;
}

/** Whether the FFF engine is available in this environment. */
export async function isFffAvailable(): Promise<boolean> {
  return (await loadFff()) !== null;
}

// One finder per base path, reused across calls (the watcher keeps it fresh).
const finders = new Map<string, FffFinder>();

function getFinder(mod: FffModule, cwd: string): FffFinder {
  const existing = finders.get(cwd);
  if (existing && !existing.isDestroyed) return existing;
  const result = mod.FileFinder.create({ basePath: cwd, aiMode: true });
  if (!result.ok) throw new Error(`FFF init failed: ${result.error}`);
  finders.set(cwd, result.value);
  return result.value;
}

/**
 * Build the FFF-backed search tools for a given working directory.
 * Returns `[]` when FFF is unavailable (caller falls back to built-in tools).
 */
export async function fffTools(cwd: string): Promise<ToolDefinition[]> {
  const mod = await loadFff();
  if (!mod) return [];

  const grepTool = defineTool({
    name: "fff_grep",
    label: "fff grep",
    description:
      "FFF-powered content search (Rust-native, SIMD, frecency-ranked). PREFER this " +
      "over the built-in grep. Returns lines as `path:line: content`.",
    parameters: Type.Object({
      pattern: Type.String({ description: "Substring or identifier to search for" }),
      maxResults: Type.Optional(
        Type.Number({ description: "Max matches to return (default 40)" }),
      ),
    }),
    async execute(_id: string, params: { pattern: string; maxResults?: number }) {
      const finder = getFinder(mod, cwd);
      const res = finder.grep(params.pattern, {
        pageSize: params.maxResults ?? 40,
        classifyDefinitions: true,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `fff_grep failed: ${res.error}` }],
          details: { count: 0 },
        };
      }
      const lines = res.value.items.map(
        (m) =>
          `${m.relativePath}:${m.lineNumber}:${m.isDefinition ? " [def]" : ""} ${String(
            m.lineContent,
          )
            .trim()
            .slice(0, 160)}`,
      );
      const text = lines.length
        ? lines.join("\n")
        : `No matches for "${params.pattern}".`;
      return { content: [{ type: "text", text }], details: { count: lines.length } };
    },
  });

  const findTool = defineTool({
    name: "fff_find",
    label: "fff find",
    description:
      "FFF-powered fuzzy file-name search (frecency-ranked, git-aware). PREFER this " +
      "over the built-in find. Returns matching file paths.",
    parameters: Type.Object({
      query: Type.String({ description: "Fuzzy file name / path query" }),
      maxResults: Type.Optional(
        Type.Number({ description: "Max files to return (default 30)" }),
      ),
    }),
    async execute(_id: string, params: { query: string; maxResults?: number }) {
      const finder = getFinder(mod, cwd);
      const res = finder.fileSearch(params.query, {
        pageSize: params.maxResults ?? 30,
      });
      if (!res.ok) {
        return {
          content: [{ type: "text", text: `fff_find failed: ${res.error}` }],
          details: { count: 0 },
        };
      }
      const paths = res.value.items.map((i) => i.relativePath);
      const text = paths.length
        ? paths.join("\n")
        : `No files matching "${params.query}".`;
      return { content: [{ type: "text", text }], details: { count: paths.length } };
    },
  });

  return [grepTool as ToolDefinition, findTool as ToolDefinition];
}
