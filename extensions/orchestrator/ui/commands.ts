/**
 * commands.ts — Slash commands for the orchestrator.
 *
 * /summoner [task] — triggers the full orchestrator workflow (Scout → Plan → Crafter → Gatekeeper)
 * /summon <agent> [task]  — triggers a single agent tool call (nudges LLM)
 * /watch  <agent>         — read-only live feed of agent activity
 * /back                    — return from watch mode to Main Agent view
 *
 * @see docs/prd.md §5.2 — Watch mode
 * @see docs/plan.md Phase 6
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRegisteredAgents } from "../core/agents";
import { agentActivityLog } from "../core/state";

// ── Command Registration ──────────────────────────────────────────────────

export function registerCommands(pi: ExtensionAPI): void {
  // /summoner — full orchestrator workflow
  pi.registerCommand("summoner", {
    description: "Launch the full orchestrator workflow: Scout → Plan → Crafter → Gatekeeper",
    handler: async (args, ctx) => {
      const task = args?.trim() || "the current task";

      // Send a user message that the LLM will immediately act on.
      // This triggers the actual workflow — the LLM reads this and starts calling tools.
      pi.sendUserMessage(
        `🏰 **Agent Summoner workflow initiated.**

` +
        `**Task:** ${task}

` +
        `Follow this workflow step by step. Do NOT just describe it — actually call the tools.

` +
        `## Step 0 — Check for existing plan
` +
        `Check if a plan already exists for this task:
` +
        `- Look in \`.pi/bulletin/\` for a matching plan file
` +
        `- Check for OpenSpec plans or other plan formats in the project
` +
        `- Read any existing plan file that matches the task

` +
        `### If a plan already exists:
` +
        `Read the plan file carefully. It may be partially executed from a previous session.
` +
        `Do NOT skip analysis — reconcile the current state first.

` +
        `#### Reconciliation (MANDATORY):
` +
        `1. **Read every TODO in the checklist.** Note which are checked \`- [x]\` and which are \`- [ ]\`.
` +
        `2. **For items marked done \`- [x]\`:**
` +
        `   - Check if the code actually exists in the file. The checkbox may be stale.
` +
        `   - If code exists AND tests pass → keep as done.
` +
        `   - If code exists but no tests were run → run the tests. If passing, keep done.
` +
        `   - If checked but code is missing → mark back to \`- [ ]\` (stale).
` +
        `3. **For items NOT done \`- [ ]\`:**
` +
        `   - Read the current file state. Has it been partially implemented?
` +
        `   - If partially done: note what's missing vs what's there.
` +
        `4. **Check the Files to Modify table.** Cross-reference each file against actual code.
` +
        `5. **Build a gap report** — present to the user:
` +
        `   - ✅ Done (N items): <list>
` +
        `   - 🟢 Partially done (N items): <list with what's missing>
` +
        `   - ⏳ Not started (N items): <list>
` +
        `   - ❌ Stale checkboxes (N items): <list — checked but code missing>
` +
        `6. **Ask the user:** "Here's the current state. Should I continue with the remaining items, or update the plan?"
` +
        `7. After they confirm, ask for trust mode (Step 2d), then execute starting from the first incomplete item.

` +
        `### If no plan exists:
` +
        `- Continue to Step 1 below.

` +
        `## Step 1 — Scout
` +
        `Call \`summon_scout\` now to map dependencies. Determine the scope from the task.
` +
        `Provide a JSON object: { "scope": "<dir>", "pattern": "<optional symbol>" }

` +
        `## Step 2 — Plan (write first, then ask)

` +
        `### 2a. Write the plan file FIRST
` +
        `Based on Scout's results, write a structured plan to \`.pi/bulletin/<slug>_<timestamp>.md\`.
` +
        `Use this exact format:

` +
        `# Plan Request: <feature/task name>
` +
        `> Instructions for the LLM generating this plan: Follow the structure below exactly.

` +
        `## Context
` +
        `<explanation of what this feature/task is and why it's needed>

` +
        `---

` +
        `## Scope
` +
        `What this plan SHOULD cover:
` +
        `- <capability/behavior 1>
` +
        `- <capability/behavior 2>

` +
        `## Out of Scope / What NOT to Do
` +
        `- Do NOT modify \`<file/module>\` — <reason>
` +
        `- Do NOT introduce new dependencies unless explicitly listed
` +
        `- Do NOT add features not explicitly requested

` +
        `---

` +
        `## Implementation Steps

` +
        `### 1. <step title> — \`<file path>\`
` +
        `<description>
` +
        `\`\`\`typescript
` +
        `<code snippet>
` +
        `\`\`\`

` +
        `### 2. <step title> — \`<file path>\`
` +
        `...

` +
        `---

` +
        `## Files to Modify
` +
        `| File | Change |
` +
        `|---|---|
` +
        `| \`<path>\` | <summary> |

` +
        `---

` +
        `## Verification
` +
        `1. Run \`<test command>\` — all tests pass.
` +
        `2. Manually: <test scenario>.

` +
        `---

` +
        `## TODO Checklist
` +
        `- [ ] \`<file>\` — <change>
` +
        `- [ ] Run full test suite
` +
        `- [ ] Self-review diff against Out-of-Scope

` +
        `---
` +
        `> Generated by Agent Summoner | <timestamp>

` +
        `### 2b. Present the plan to the user
` +
        `After writing the file, show a summary and **ASK ONLY about the plan:**
` +
        `"Here's the plan I wrote to \`.pi/bulletin/<file>.md\`. Does it look good? Anything to change?"

` +
        `### 2c. Handle feedback
` +
        `- If the user wants changes: **update the plan file** with their feedback.
` +
        `  Re-invoke Scout if the scope changed. Present the revised plan and ask again.
` +
        `- Do NOT mention trust mode yet. Only discuss the plan itself.
` +
        `- Do NOT proceed until the user explicitly says the plan is ok.

` +
        `### 2d. After plan is approved — ask trust mode
` +
        `- Only AFTER the user approves the plan, THEN ask:
` +
        `  "How should I proceed? 🙈 Trust (auto-proceed, auto-fix) or 🔍 Checkpoint (ask before each action)?"
` +
        `- Wait for their choice, then call \`set_trust_mode\` with it.

` +
        `## Step 3 — Execute
` +
        `Summon \`summon_crafter\` for each file in each phase. Same-phase files can run in parallel.
` +
        `If Phase 0 is needed (new deps), call \`summon_crafter_dep_install\` first.
` +
        `Unplanned file discovery: check the Ledger, approve if no conflict, wait if blocked.
` +
        `**After EACH phase completes, update the .pi/bulletin plan file:**
` +
        `- Check off completed files: change \`- [ ]\` to \`- [x]\` for done items
` +
        `- Add any discovered (unplanned) files to the plan
` +
        `- If requirements changed mid-way: update the Requirements section but KEEP completed checkboxes
` +
        `- Update the timestamp

` +
        `Unplanned file discovery: check the Ledger, approve if no conflict, wait if blocked.

` +
        `## Step 4 — Verify
` +
        `Call \`summon_gatekeeper\` with { "phase": "baseline" } BEFORE any edits.
` +
        `After all edits, call \`summon_gatekeeper\` with { "phase": "verify" }.
` +
        `Out-of-scope failures: ALWAYS ask the user before fixing.

` +
        `## Step 5 — Report
` +
        `Walk the Ledger and present the final report.
` +
        `Update the .pi/bulletin plan file with final status — all checkboxes should be \`- [x]\` or \`- [ ] ❌\` for failed.

` +
        `---
` +
        `**Start now.** Call summon_scout for Step 1.`,
      );
    },
  });

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
