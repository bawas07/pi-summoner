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
import { handleManualSummon, notifyAmbient, isRunActive } from "./orchestrator";

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
        ctx.ui.notify("Usage: /summoner <task>", "warning");
        return;
      }

      console.log(`[summoner] Manual summon: ${task}`);
      await handleManualSummon(task, ctx);
    },
  });

  // 8.3 Ambient trigger: evaluate every conversation turn (non-blocking hint only).
  // The loop is NOT run from here — that previously deadlocked. We only nudge;
  // the LLM acts via summon_* tools, and /summoner starts the full loop.
  pi.on("turn_start", async (_event, ctx) => {
    if (isRunActive()) return;

    const message = extractLatestMessage(ctx as unknown as Record<string, unknown>);
    if (!message) return;

    const triggerResult = evaluateTurn({
      message,
      recentHistory: [],
      currentPhase: undefined,
    });

    if (!triggerResult.needsScout && !triggerResult.implementIntent) return;

    notifyAmbient(triggerResult, ctx);
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
