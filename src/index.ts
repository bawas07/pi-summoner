/**
 * Agent Summoner — pi.dev extension entry point.
 *
 * Registers:
 *   - /summoner <task> command (manual override)
 *   - turn_start hook for ambient trigger evaluation
 *   - Built-in agents (Scout, Crafter, Gatekeeper) as summon_* tools
 *
 * Phase 1: core loop with functional tools (no subprocess spawn).
 * Phase 2 (deferred): tmux, incantation, model assignment, real RPC subprocesses.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { evaluateTurn } from "./trigger";
import { registerBuiltinAgents } from "./agents";
import { initPlanFiles } from "./plan-file";
import { handleManualSummon, handleTrigger, isAwaitingApproval } from "./orchestrator";

export default function (pi: ExtensionAPI): void {
  // 8.4 Initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    initPlanFiles(ctx.cwd);
    registerBuiltinAgents(pi);
    console.log("[summoner] Agent Summoner loaded — Scout | Crafter | Gatekeeper");
  });

  // 8.2 Register /summoner command (manual override)
  pi.registerCommand("summoner", {
    description:
      "Summon the orchestrator for a task. Starts the plan→approve→execute→verify loop.",
    getArgumentCompletions: (prefix) => {
      const completions = ["scout", "crafter", "gatekeeper"];
      return completions
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a }));
    },
    handler: async (args, ctx) => {
      const task = args.trim();
      if (!task) {
        console.warn("[summoner] /summoner called without task");
        return;
      }

      console.log(`[summoner] Manual summon: ${task}`);
      await handleManualSummon(task, { cwd: ctx.cwd });
    },
  });

  // 8.3 Ambient trigger: evaluate every conversation turn
  pi.on("turn_start", async (_event, ctx) => {
    const message = extractLatestMessage(ctx);
    if (!message) return;

    // If orchestrator is awaiting user approval, route this message
    if (isAwaitingApproval()) {
      await handleTrigger(
        { needsScout: false, implementIntent: true },
        message,
        { cwd: ctx.cwd },
      );
      return;
    }

    // Normal trigger evaluation
    const triggerResult = evaluateTurn({
      message,
      recentHistory: [],
      currentPhase: undefined,
    });

    if (!triggerResult.needsScout && !triggerResult.implementIntent) return;

    await handleTrigger(triggerResult, message, { cwd: ctx.cwd });
  });
}

// ---- Helpers ----

function extractLatestMessage(ctx: Record<string, unknown>): string | null {
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
