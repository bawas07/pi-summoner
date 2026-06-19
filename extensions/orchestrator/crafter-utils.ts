/**
 * crafter-utils.ts — Pure logic for the Crafter, separated from Pi runtime imports.
 *
 * These functions are testable outside the Pi runtime. The Crafter's pi-dependent
 * logic (withFileMutationQueue, tool registration) lives in crafter.ts.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Unique ID Generator ──────────────────────────────────────────────────

let _idCounter = 0;

/** Generate a unique owner ID that works even within the same millisecond. */
function uniqueOwnerId(): string {
  return `crafter-${Date.now()}-${++_idCounter}`;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrafterTask {
  file: string;
  instruction: string;
  phase?: number;
  owner?: string;
}

export interface CrafterResult {
  file: string;
  status: "written" | "skipped" | "needs_approval" | "failed";
  summary?: string;
  owner?: string;
  error?: string;
  unplannedFiles?: UnplannedFileReport[];
}

export interface UnplannedFileReport {
  file: string;
  imports: string[];
  reason: string;
}

// ── Import Detection ──────────────────────────────────────────────────────

/**
 * Detect ESM relative imports from a file's content.
 * Used for richer reports when unplanned files are discovered.
 */
export function detectImports(content: string): string[] {
  const imports: string[] = [];
  // Handles: default, named, namespace, mixed, and side-effect imports
  const importRe =
    /import\s+(?:(?:[\w*\s{},]+)\s+from\s+)?['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(content)) !== null) {
    if (match[1].startsWith(".")) {
      imports.push(match[1]);
    }
  }
  return imports;
}

// ── Task Parsing ───────────────────────────────────────────────────────────

/**
 * Parse a task string into a CrafterTask.
 * Accepts JSON or a simple "file:instruction" format.
 */
export function parseTask(task: string, _ctx?: ExtensionContext): CrafterTask {
  try {
    const parsed = JSON.parse(task);
    return {
      file: parsed.file || task,
      instruction: parsed.instruction || task,
      phase: parsed.phase,
      owner: parsed.owner || uniqueOwnerId(),
    };
  } catch {
    // Plain string: try "file: instruction" format
    const colonIdx = task.indexOf(":");
    if (colonIdx > 0) {
      return {
        file: task.slice(0, colonIdx).trim(),
        instruction: task.slice(colonIdx + 1).trim(),
        owner: uniqueOwnerId(),
      };
    }
    return {
      file: task,
      instruction: "Apply the described changes",
      owner: uniqueOwnerId(),
    };
  }
}

// ── File Reading ───────────────────────────────────────────────────────────

/**
 * Read a file's content and detect its imports.
 */
export async function readTargetFile(
  absolutePath: string,
): Promise<{ content: string; imports: string[] }> {
  const { readFile } = await import("node:fs/promises");
  const content = await readFile(absolutePath, "utf8");
  const imports = detectImports(content);
  return { content, imports };
}
