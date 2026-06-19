/**
 * orchestrator/index.ts — Agent Summoner extension entry point
 *
 * Multi-agent orchestration layer for Pi:
 *   Scout     — finds files/symbols, builds AST dependency graphs
 *   Crafter   — implements planned changes, installs dependencies
 *   Gatekeeper — runs tests, verifies results, classifies failures
 *
 * All coordinated through a Ledger (single source of truth) owned by Main Agent.
 *
 * @see docs/prd.md  — what and why
 * @see docs/flow.md — system mechanics
 * @see docs/plan.md — implementation phases
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initLedger, replayFromEntries } from "./ledger";
import { registerScout } from "./scout";
import { registerCrafter } from "./crafter";
import { registerGatekeeper } from "./gatekeeper";
import { registerCommands } from "./commands";
import { registerStatusWidget } from "./ui";
import { discoverUserAgents } from "./agents";

export default function (pi: ExtensionAPI) {
  // Wire Ledger to pi for persistence
  initLedger(pi);

  // Register built-in agents
  registerScout(pi);
  registerCrafter(pi);
  registerGatekeeper(pi);

  // Register UI commands (available globally)
  registerCommands(pi);

  pi.on("session_start", async (_event, ctx) => {
    // Rebuild Ledger from persisted session entries (survives /reload)
    const entries = ctx.sessionManager.getEntries();
    replayFromEntries(entries);

    // Register per-session UI
    registerStatusWidget(ctx);

    // Discover and register user-defined agents
    await discoverUserAgents(pi, ctx.cwd);

    ctx.ui.notify("Orchestrator loaded", "info");
  });
}
