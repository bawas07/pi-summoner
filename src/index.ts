/**
 * Agent Summoner — pi.dev extension entry point.
 *
 * Registers:
 *   - /summoner <task> command (manual override)
 *   - turn_start hook for ambient trigger evaluation
 *   - Built-in agents (Scout, Crafter, Gatekeeper) as summon_* tools
 *
 * Phase 1: core loop, RPC subprocesses, plan files, Ledger.
 * Phase 2 (deferred): tmux, incantation, model assignment.
 * Phase 3 (deferred): code-quality Gatekeeper, crash recovery.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateTurn } from "./trigger";
import { registerBuiltinAgents } from "./agents";
import { initPlanFiles } from "./plan-file";
import { handleTrigger, handleManualSummon, isAwaitingApproval } from "./orchestrator";

// ---- 8.1 Entry point ----

export default function (pi: ExtensionAPI): void {
  // 8.4 Initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    initPlanFiles(ctx.cwd);
    registerBuiltinAgents(pi);
    ctx.ui.notify("Agent Summoner loaded — Scout | Crafter | Gatekeeper", "info");
  });

  // 8.2 Register /summoner command (manual override)
  pi.registerCommand("summoner", {
    description:
      "Summon the orchestrator for a task (manual override). Use for explicit task dispatch.",
    getArgumentCompletions: (prefix) => {
      const completions = ["scout", "crafter", "gatekeeper"];
      return completions
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a }));
    },
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        ctx.ui.notify(
          "Usage: /summoner <task description>\nExample: /summoner fix the login redirect bug",
          "warn",
        );
        return;
      }

      await handleManualSummon(task, pi, {
        cwd: ctx.cwd,
      });
    },
  });

  // 8.3 Ambient trigger: evaluate every conversation turn
  pi.on("turn_start", async (_event, ctx) => {
    const message = extractLatestMessage(ctx);
    if (!message) return;

    // If orchestrator is awaiting user approval, route this message
    // as an approval response instead of evaluating triggers
    if (isAwaitingApproval()) {
      const triggerResult = { needsScout: false, implementIntent: true };
      await handleTrigger(triggerResult, message, pi, { cwd: ctx.cwd });
      return;
    }

    // Normal trigger evaluation for ambient detection
    const triggerResult = evaluateTurn({
      message,
      recentHistory: [],
      currentPhase: undefined,
    });

    // Only proceed if there's something to do
    if (!triggerResult.needsScout && !triggerResult.implementIntent) {
      return;
    }

    // 8.5 Wire into orchestrator
    await handleTrigger(triggerResult, message, pi, {
      cwd: ctx.cwd,
    });
  });
}

// ---- Helpers ----

/**
 * Extract the latest user message from the turn context.
 *
 * The exact shape of the turn_start event data depends on pi's API.
 * This function safely extracts whatever is available.
 */
function extractLatestMessage(ctx: Record<string, unknown>): string | null {
  // Try common patterns for where pi puts the latest message
  if (typeof ctx.message === "string") return ctx.message;
  if (
    ctx.turn &&
    typeof ctx.turn === "object" &&
    ctx.turn !== null &&
    "message" in ctx.turn
  ) {
    const m = (ctx.turn as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  if (ctx.text && typeof ctx.text === "string") return ctx.text;
  if (ctx.content && typeof ctx.content === "string") return ctx.content;

  return null;
}
