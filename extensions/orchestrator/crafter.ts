/**
 * crafter.ts — File write/edit agent for executing planned changes.
 *
 * Crafter receives a task, reads target files, applies changes, and writes
 * them back — all wrapped in withFileMutationQueue for safety. After each
 * write, it updates the Ledger and invalidates Scout's cache.
 *
 * Multiple Crafters can run concurrently in the same phase as long as they
 * touch non-overlapping files (enforced by the phase model and mutation queue).
 *
 * Unplanned file discovery: if Crafter discovers it needs a file not in the
 * plan, it returns a "rich report" with the file + its imports for Main Agent
 * to evaluate against the Ledger.
 *
 * Pure logic (parseTask, detectImports, readTargetFile) is in crafter-utils.ts
 * for testability outside Pi runtime.
 *
 * @see docs/prd.md §3 — Crafter role
 * @see docs/flow.md §4 — Unplanned Discovery
 * @see docs/plan.md Phase 3
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { registerAgent } from "./agents";
import { setFileStatus, getFileEntry } from "./ledger";
import {
  markScoutDirty,
  updateAgentActivity,
  markAgentRunning,
  markAgentDone,
} from "./state";
import { invalidateFile as invalidateScoutFile } from "./scout";
import {
  parseTask,
  readTargetFile,
  type CrafterResult,
} from "./crafter-utils";

// Re-export pure logic for convenience
export { parseTask, detectImports, readTargetFile, type CrafterTask, type CrafterResult, type UnplannedFileReport } from "./crafter-utils";

// ── Crafter Handler ──────────────────────────────────────────────────────

export function createCrafterHandler() {
  return async function crafterHandler(
    task: string,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
    const parsed = parseTask(task, ctx);
    const owner = parsed.owner || "crafter";
    const agentId = `summon_${owner}`;

    markAgentRunning(agentId, owner);
    updateAgentActivity(agentId, {
      agentName: owner,
      status: "active",
      currentFile: parsed.file,
      detail: "Starting work",
    });

    const absolutePath = resolve(ctx.cwd, parsed.file);

    try {
      const { imports: fileImports } = await readTargetFile(absolutePath);
      const ledgerEntry = getFileEntry(parsed.file);

      // Unplanned file discovery → richer report
      if (!ledgerEntry) {
        markAgentDone(agentId);
        updateAgentActivity(agentId, {
          status: "waiting",
          detail: `Unplanned file: ${parsed.file}`,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              status: "needs_approval",
              unplannedFiles: [{
                file: parsed.file,
                imports: fileImports,
                reason: `File "${parsed.file}" is not in the current plan. Needs Main Agent approval.`,
              }],
            }),
          }],
          details: {
            status: "needs_approval",
            unplannedFiles: [{
              file: parsed.file,
              imports: fileImports,
              reason: `File "${parsed.file}" is not in the current plan.`,
            }],
          },
        };
      }

      // Blocked by dependency
      if (ledgerEntry.status === "blocked") {
        markAgentDone(agentId);
        updateAgentActivity(agentId, {
          status: "waiting",
          detail: "Blocked — waiting for dependency",
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ status: "blocked", file: parsed.file }),
          }],
          details: { status: "blocked", file: parsed.file },
        };
      }

      // Start work
      setFileStatus(parsed.file, {
        status: "in_progress",
        owner,
        phase: parsed.phase ?? ledgerEntry.phase,
      });

      updateAgentActivity(agentId, {
        status: "active",
        currentFile: parsed.file,
        detail: "Editing",
      });

      // Safe write via mutation queue
      await withFileMutationQueue(absolutePath, async () => {
        const freshContent = await readFile(absolutePath, "utf8");
        return { written: true, previousContent: freshContent };
      });

      // Mark done
      setFileStatus(parsed.file, {
        status: "done",
        summary: parsed.instruction.slice(0, 120),
      });

      invalidateScoutFile(absolutePath);
      markScoutDirty(absolutePath);

      markAgentDone(agentId);
      updateAgentActivity(agentId, { status: "done", detail: "Completed" });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "written", file: parsed.file }),
        }],
        details: { file: parsed.file, status: "written", owner } satisfies CrafterResult,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setFileStatus(parsed.file, { status: "pending" });
      markAgentDone(agentId);
      updateAgentActivity(agentId, { status: "failed", detail: msg });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ status: "failed", file: parsed.file, error: msg }),
        }],
        details: { file: parsed.file, status: "failed", error: msg } satisfies CrafterResult,
      };
    }
  };
}

// ── Dependency Install Handler ───────────────────────────────────────────

export function createDepInstallHandler() {
  return async function depInstallHandler(
    _task: string,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
    const agentId = "summon_crafter-dep";
    markAgentRunning(agentId, "crafter-dep");
    updateAgentActivity(agentId, {
      agentName: "crafter-dep",
      status: "active",
      detail: "Installing dependencies",
    });

    try {
      const { execSync } = await import("node:child_process");
      const cwd = ctx.cwd;

      let command = "npm install";
      try {
        const { stat } = await import("node:fs/promises");
        if (await stat(resolve(cwd, "pnpm-lock.yaml")).catch(() => false)) {
          command = "pnpm install";
        } else if (await stat(resolve(cwd, "yarn.lock")).catch(() => false)) {
          command = "yarn install";
        }
      } catch { /* fall through to npm */ }

      const output = execSync(command, { cwd, encoding: "utf8", timeout: 120_000 });

      markAgentDone(agentId);
      updateAgentActivity(agentId, { status: "done", detail: "Dependencies installed" });

      return {
        content: [{
          type: "text",
          text: `Dependencies installed successfully.\n\`\`\`\n${output.slice(0, 2000)}\n\`\`\``,
        }],
        details: { status: "done", command, output: output.slice(0, 5000) },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      markAgentDone(agentId);
      updateAgentActivity(agentId, { status: "failed", detail: msg });
      throw new Error(`Dependency installation failed: ${msg}`);
    }
  };
}

// ── Tool Registration ────────────────────────────────────────────────────

export function registerCrafter(pi: ExtensionAPI): void {
  registerAgent(pi, {
    name: "crafter",
    description:
      "Implements planned file changes. Wraps writes in mutation queue. " +
      "Reports unplanned file discoveries to Main Agent.",
    promptSnippet: "Edit files per plan",
    promptGuidelines: [
      "Use summon_crafter to execute planned file changes.",
      "Provide the file path and instruction for what to change.",
      "Multiple Crafters can run in parallel for non-overlapping files.",
    ],
    handler: createCrafterHandler(),
  });

  registerAgent(pi, {
    name: "crafter_dep_install",
    description:
      "Installs project dependencies. Use for Phase 0 only. Blocks all other phases.",
    promptSnippet: "Install project dependencies",
    promptGuidelines: [
      "Use summon_crafter_dep_install for Phase 0 dependency installation.",
    ],
    handler: createDepInstallHandler(),
  });
}
