/**
 * commands.ts — Slash commands for the orchestrator.
 *
 * /summon <agent> [task]  — triggers an agent tool call (nudges LLM)
 * /watch  <agent>         — read-only live feed of agent activity
 * /back                    — return from watch mode to Main Agent view
 *
 * @see docs/prd.md §5.2 — Watch mode
 * @see docs/plan.md Phase 6
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredAgents } from "./agents";
import { agentActivityLog } from "./state";

// ── Command Registration ──────────────────────────────────────────────────

export function registerCommands(pi: ExtensionAPI): void {
  // /summon — trigger an agent
  pi.registerCommand("summon", {
    description: "Summon an agent for a task",
    getArgumentCompletions: (prefix: string) => {
      const agents = getRegisteredAgents();
      if (!prefix) return agents.map((a) => ({ value: a, label: a }));
      return agents
        .filter((a) => a.startsWith(prefix))
        .map((a) => ({ value: a, label: a }));
    },
    handler: async (args, ctx) => {
      const parts = args ? args.trim().split(/\s+/) : [];
      if (parts.length === 0) {
        const agents = getRegisteredAgents();
        const msg = agents.length > 0
          ? `Available agents: ${agents.join(", ")}`
          : "No agents registered.";
        ctx.ui.notify(msg, "info");
        return;
      }

      const agentName = parts[0];
      const registered = getRegisteredAgents();
      if (!registered.includes(agentName)) {
        ctx.ui.notify(
          `Unknown agent "${agentName}". Available: ${registered.join(", ")}`,
          "error",
        );
        return;
      }

      const task = parts.slice(1).join(" ") || "Execute task";
      ctx.ui.notify(
        `Summoning ${agentName}... Use summon_${agentName} tool with task: "${task}"`,
        "info",
      );
    },
  });

  // /watch — live agent feed (read-only)
  pi.registerCommand("watch", {
    description: "Read-only live view of a summoned agent's activity",
    getArgumentCompletions: (_prefix: string) => {
      const active: string[] = [];
      for (const [, activity] of agentActivityLog) {
        if (activity.status === "active" || activity.status === "waiting") {
          active.push(activity.agentName || "unknown");
        }
      }
      if (active.length === 0) return [{ value: "", label: "No active agents" }];
      return active.map((a) => ({ value: a, label: a }));
    },
    handler: async (args, ctx) => {
      const agentName = args?.trim();
      if (!agentName) {
        const active: Array<{ name: string; status: string; file?: string }> = [];
        for (const [, activity] of agentActivityLog) {
          if (activity.status === "active" || activity.status === "waiting") {
            active.push({
              name: activity.agentName,
              status: activity.status,
              file: activity.currentFile,
            });
          }
        }
        if (active.length === 0) {
          ctx.ui.notify("No active agents to watch.", "info");
          return;
        }
        const list = active
          .map((a) => `  ${a.status === "active" ? "🟢" : "🟡"} ${a.name}${a.file ? ` — ${a.file}` : ""}`)
          .join("\n");
        ctx.ui.notify(`Watchable agents:\n${list}\n\nUse /watch <name> to watch one.`, "info");
        return;
      }

      const agentId = [...agentActivityLog.keys()].find(
        (id) => agentActivityLog.get(id)?.agentName === agentName,
      );

      if (!agentId) {
        ctx.ui.notify(`Agent "${agentName}" not found or not active.`, "error");
        return;
      }

      // Show live feed via a simple panel
      // Full TUI takeover requires @earendil-works/pi-tui — for now, notify with current state
      const activity = agentActivityLog.get(agentId);
      if (activity) {
        const icon =
          activity.status === "active" ? "🟢" :
          activity.status === "waiting" ? "🟡" :
          activity.status === "done" ? "✅" :
          activity.status === "failed" ? "❌" : "⏳";

        const lines = [
          `Watch: ${agentName} (read-only)`,
          `${icon} Status: ${activity.status}`,
          activity.currentFile ? `   File: ${activity.currentFile}` : "",
          activity.detail ? `   ${activity.detail}` : "",
          "",
          "Use /watch again to refresh, or continue working.",
        ].filter(Boolean);

        ctx.ui.notify(lines.join("\n"), "info");
      }
    },
  });

  // /back — return from watch mode
  pi.registerCommand("back", {
    description: "Return from watch mode to Main Agent view",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Returned to Main Agent.", "info");
    },
  });
}
