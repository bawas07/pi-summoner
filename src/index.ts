/**
 * agent-summoner — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, Key, matchesKey, type SettingItem, SettingsList, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { AgentManager } from "./agents/agent-manager.js";
import { getAgentConversation, getDefaultMaxTurns, getGraceTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES, setDefaultMaxTurns, setGraceTurns, steerAgent } from "./agents/agent-runner.js";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getAllTypes, getAvailableTypes, isDefaultsDisabled, registerAgents, resolveType, setDefaultsDisabled } from "./agents/agent-types.js";
import { registerRpcHandlers } from "./cross-extension-rpc.js";
import { loadCustomAgents } from "./agents/custom-agents.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "./enabled-models.js";
import { GroupJoinManager } from "./group-join.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "./agents/invocation-config.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "./output-file.js";
import { applyAndEmitLoaded, type SubagentsSettings, saveAndEmitChanged, type ToolDescriptionMode } from "./settings.js";
import { getStatusNote } from "./status-note.js";
import { type AgentConfig, type AgentInvocation, type AgentRecord, type JoinMode, type NotificationDetails, type SubagentType } from "./types.js";
import {
  type AgentActivity,
  type AgentDetails,
  AgentWidget,
  buildInvocationTags,
  describeActivity,
  formatDuration,
  formatMs,
  formatTokens,
  formatTurns,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type UICtx,
} from "./ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "./ui/fleet-list.js";
import { addUsage, getLifetimeTotal, getSessionContextPercent, type LifetimeUsage } from "./usage.js";
import { buildDetails, buildNotificationDetails, createActivityTracker, escapeXml, formatLifetimeTokens, formatTaskNotification, getStatusLabel, textResult } from "./notifications.js";
import { MAIN_CRAFTER_PERSONA, PLAN_MODE_PERSONA } from "./personas.js";
import { loadPartyRules, savePartyRules, type PartyRules } from "./party-rules.js";
import { registerModeIndicator, setModeIndicator } from "./ui/mode-indicator.js";
import { executeAgent } from "./tools/agent-tool.js";
import { executeGetSubagentResult, executeSteerSubagent } from "./tools/subagent-tools.js";
import { createAgentsMenuHandler } from "./menu/agents-menu.js";

// ---- Shared helpers (extracted to notifications.ts) ----

export default function (pi: ExtensionAPI) {
  // ---- Register custom notification renderer ----
  pi.registerMessageRenderer<NotificationDetails>(
    "subagent-notification",
    (message, { expanded }, theme) => {
      const d = message.details;
      if (!d) return undefined;

      function renderOne(d: NotificationDetails): string {
        const isError = d.status === "error" || d.status === "stopped" || d.status === "aborted";
        const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        const statusText = isError ? d.status
          : d.status === "steered" ? "completed (steered)"
          : "completed";

        // Line 1: icon + agent description + status
        let line = `${icon} ${theme.bold(d.description)} ${theme.fg("dim", statusText)}`;

        // Line 2: stats
        const parts: string[] = [];
        if (d.turnCount > 0) parts.push(formatTurns(d.turnCount, d.maxTurns));
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.totalTokens > 0) parts.push(formatTokens(d.totalTokens));
        if (d.durationMs > 0) parts.push(formatMs(d.durationMs));
        if (parts.length) {
          line += "\n  " + parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
        }

        // Line 3: result preview (collapsed) or full (expanded)
        if (expanded) {
          const lines = d.resultPreview.split("\n").slice(0, 30);
          for (const l of lines) line += "\n" + theme.fg("dim", `  ${l}`);
        } else {
          const preview = d.resultPreview.split("\n")[0]?.slice(0, 80) ?? "";
          line += "\n  " + theme.fg("dim", `⎿  ${preview}`);
        }

        // Line 4: output file link (if present)
        if (d.outputFile) {
          line += "\n  " + theme.fg("muted", `transcript: ${d.outputFile}`);
        }

        return line;
      }

      const all = [d, ...(d.others ?? [])];
      return new Text(all.map(renderOne).join("\n"), 0, 0);
    }
  );

  /** Reload agents from .pi/agents/*.md and merge with defaults (called on init and each Agent invocation). */
  const reloadCustomAgents = () => {
    const userAgents = loadCustomAgents(process.cwd());
    registerAgents(userAgents);
  };

  // Initial load
  reloadCustomAgents();

  // ---- Agent activity tracking + widget ----
  const agentActivity = new Map<string, AgentActivity>();

  // ---- Cancellable pending notifications ----
  // Holds notifications briefly so get_subagent_result can cancel them
  // before they reach pi.sendMessage (fire-and-forget).
  const pendingNudges = new Map<string, ReturnType<typeof setTimeout>>();
  const NUDGE_HOLD_MS = 200;

  function scheduleNudge(key: string, send: () => void, delay = NUDGE_HOLD_MS) {
    cancelNudge(key);
    pendingNudges.set(key, setTimeout(() => {
      pendingNudges.delete(key);
      try { send(); } catch { /* ignore stale completion side-effect errors */ }
    }, delay));
  }

  function cancelNudge(key: string) {
    const timer = pendingNudges.get(key);
    if (timer != null) {
      clearTimeout(timer);
      pendingNudges.delete(key);
    }
  }

  // ---- Individual nudge helper (async join mode) ----
  function emitIndividualNudge(record: AgentRecord) {
    if (record.resultConsumed) return;  // re-check at send time

    const notification = formatTaskNotification(record, 500);
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';

    pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: notification + footer,
      display: true,
      details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
    }, { deliverAs: "followUp", triggerTurn: true });
  }

  function sendIndividualNudge(record: AgentRecord) {
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    scheduleNudge(record.id, () => emitIndividualNudge(record));
    widget.update();
  }

  // ---- Group join manager ----
  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); fleet.onAgentFinished(r.id); }

      const groupKey = `group:${records.map(r => r.id).join(",")}`;
      scheduleNudge(groupKey, () => {
        // Re-check at send time
        const unconsumed = records.filter(r => !r.resultConsumed);
        if (unconsumed.length === 0) { widget.update(); return; }

        const notifications = unconsumed.map(r => formatTaskNotification(r, 300)).join('\n\n');
        const label = partial
          ? `${unconsumed.length} agent(s) finished (partial — others still running)`
          : `${unconsumed.length} agent(s) finished`;

        const [first, ...rest] = unconsumed;
        const details = buildNotificationDetails(first, 300, agentActivity.get(first.id));
        if (rest.length > 0) {
          details.others = rest.map(r => buildNotificationDetails(r, 300, agentActivity.get(r.id)));
        }

        pi.sendMessage<NotificationDetails>({
          customType: "subagent-notification",
          content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
          display: true,
          details,
        }, { deliverAs: "followUp", triggerTurn: true });
      });
      widget.update();
    },
    30_000,
  );

  /** Helper: build event data for lifecycle events from an AgentRecord. */
  function buildEventData(record: AgentRecord) {
    const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
    // All three fields are lifetime-accumulated (Σ over every assistant message_end),
    // so they survive compaction together — input + output ≤ total always.
    // tokens is omitted when nothing was ever produced (e.g. agent errored before
    // any message_end fired), preserving prior payload shape.
    const u = record.lifetimeUsage;
    const total = getLifetimeTotal(u);
    const tokens = total > 0
      ? { input: u.input, output: u.output, total }
      : undefined;
    return {
      id: record.id,
      type: record.type,
      description: record.description,
      result: record.result,
      error: record.error,
      status: record.status,
      toolUses: record.toolUses,
      durationMs,
      tokens,
    };
  }

  // Background completion: route through group join or send individual nudge
  const manager = new AgentManager((record) => {
    // Emit lifecycle event based on terminal status
    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("summoner:failed", eventData);
    } else {
      pi.events.emit("summoner:completed", eventData);
    }

    // Persist final record for cross-extension history reconstruction
    pi.appendEntry("summoner:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

    // Skip notification if result was already consumed via get_subagent_result
    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      fleet.onAgentFinished(record.id);
      widget.update();
      return;
    }

    // If this agent is pending batch finalization (debounce window still open),
    // don't send an individual nudge — finalizeBatch will pick it up retroactively.
    if (currentBatchAgents.some(a => a.id === record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    // 'held' → do nothing, group will fire later
    // 'delivered' → group callback already fired
    widget.update();
  }, undefined, (record) => {
    // Emit started event when agent transitions to running (including from queue)
    pi.events.emit("summoner:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    // Emit compacted event when agent's session compacts (preserves count on record).
    pi.events.emit("summoner:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  });

  // Expose manager via Symbol.for() global registry for cross-package access.
  // Standard Node.js pattern for cross-package singletons (used by OpenTelemetry, etc.).
  const MANAGER_KEY = Symbol.for("agent-summoner:manager");
  (globalThis as any)[MANAGER_KEY] = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: (piRef: any, ctx: any, type: string, prompt: string, options: any) =>
      manager.spawn(piRef, ctx, type, prompt, options),
    getRecord: (id: string) => manager.getRecord(id),
  };

  // --- Cross-extension RPC via pi.events ---
  let currentCtx: ExtensionContext | undefined;
  let unsubModeKey: (() => void) | undefined;

  /** Toggle plan/crafting mode and persist. */
  function toggleMode(ctx: { ui: { notify: (message: string, type?: "error" | "info" | "warning") => void } }) {
    const newMode = !isPlanModeEnabled();
    setPlanModeEnabled(newMode);
    const modeLabel = newMode ? "plan" : "crafting";
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      `Mode set to ${modeLabel}`,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  // Capture ctx from session_start for RPC spawn handler.
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    manager.clearCompleted(true);
    registerModeIndicator(ctx.ui, isPlanModeEnabled() ? "plan" : "crafting");
    setModeIndicator(isPlanModeEnabled() ? "plan" : "crafting"); // ensure widget is synced with in-memory mode
    updateStatusBar();
    const mode = isPlanModeEnabled() ? "🔮 planning" : "⚡ crafting";
    ctx.ui.notify(`🎉 agent-summoner is ${mode}! What do you want to do?`, "info");

    // Register Shift+Tab shortcut to toggle plan/crafting mode
    unsubModeKey?.();
    unsubModeKey = (ctx.ui as any).onTerminalInput?.((data: string) => {
      if (matchesKey(data, "shift+tab")) {
        toggleMode(ctx);
        return { consume: true };
      }
      return undefined;
    });
  });

  // ---- Plan mode tool guard — hard enforcement ----
  // In plan mode, block all destructive tool calls except .md file writes.
  // This is the hard guard; the prompt instructions are the soft layer.
  pi.on("tool_call", (event) => {
    if (!isPlanModeEnabled()) return; // crafting mode: allow everything

    // Read-only tools — always allowed
    if (event.toolName === "read" || event.toolName === "grep" ||
        event.toolName === "find" || event.toolName === "ls" ||
        event.toolName === "fffind" || event.toolName === "ffgrep") {
      return;
    }

    // plan_checkpoint — always allowed (official escape hatch from plan mode)
    if (event.toolName === "plan_checkpoint") {
      return;
    }

    // Bash — allow read-only commands; block destructive ones
    if (event.toolName === "bash") {
      const cmd: string = (event.input as Record<string, unknown>).command as string || "";

      // Block output redirection (writing to files via >, >>, 2>, &>)
      if (/[^<]>\s*[^\s=]/.test(cmd)) {
        return {
          block: true,
          reason: "🔮 Plan mode: bash file redirection is disabled. Only .md file writes are permitted.",
        };
      }

      // Block known destructive commands
      if (/\b(rm\b|mkdir|rmdir|mv|cp\b|chmod|chown|touch|ln\b|truncate|dd\b|mkfs)\b/.test(cmd)) {
        return {
          block: true,
          reason: "🔮 Plan mode: destructive bash commands are disabled. Only .md file writes are permitted.",
        };
      }

      // Allow read-only commands (cat, ls, grep, find, head, tail, tests, etc.)
      return;
    }

    // Write / Edit — allowed only for .md files
    if (event.toolName === "write" || event.toolName === "edit") {
      const path: string | undefined = (event.input as Record<string, unknown>).path as string | undefined;
      if (path && (!path.endsWith(".md") || !path.endsWith(".json"))) {
        return {
          block: true,
          reason: `🔮 Plan mode: only .md files can be written. "${path}" is not a .md file.`,
        };
      }
      // .md file — allow
      return;
    }

    // Custom/unknown tools — block in plan mode (safety-first)
    return {
      block: true,
      reason: `🔮 Plan mode: tool "${event.toolName}" is not available. Only read/search tools and .md file writes are permitted.`,
    };
  });

  // Lightweight heuristic: is the prompt coding-related?
  // Checks for file paths, code constructs, and engineering terms.
  const CODING_SIGNALS = [
    /\.(ts|js|jsx|tsx|py|rs|go|java|rb|php|cpp|c|h|css|html|json|yaml|yml|md|sql|sh|bash|toml)$/m,
    /\b(function|class|interface|type|enum|const|let|var|import|export|async|await|try|catch|throw)\b/,
    /\b(bug|fix|refactor|implement|build|deploy|test|debug|optimize|migrate|upgrade|patch|release)\b/,
    /\b(API|endpoint|route|middleware|database|schema|migration|component|hook|module|package|dependency)\b/,
    /\b(src\/|app\/|lib\/|test\/|components\/|utils\/|services\/|hooks\/|pages\/|routes\/)/,
    /\b(merge|commit|branch|PR|pull request|code review|refactor|architecture|design pattern)\b/i,
    /\b(write|create|add|change|modify|update|delete|remove)\s+(a|the|new|this)\s+(file|function|class|component|module|endpoint|route|test)/i,
  ];

  function isCodingRelated(prompt: string): boolean {
    if (!prompt) return false;
    return CODING_SIGNALS.some((re) => re.test(prompt));
  }

  // Inject mode-appropriate persona into the system prompt for every agent turn.
  // Plan mode always injects. crafting mode only injects for coding-related prompts.
  pi.on("before_agent_start", async (event) => {
    if (isPlanModeEnabled()) {
      return { systemPrompt: event.systemPrompt + PLAN_MODE_PERSONA };
    }
    // crafting mode: only inject Main Crafter for coding-related conversations
    if (isCodingRelated(event.prompt)) {
      return { systemPrompt: event.systemPrompt + MAIN_CRAFTER_PERSONA };
    }
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
  });

  const { unsubPing: unsubPingRpc, unsubSpawn: unsubSpawnRpc, unsubStop: unsubStopRpc } = registerRpcHandlers({
    events: pi.events,
    pi,
    getCtx: () => currentCtx,
    manager,
  });

  // Broadcast readiness so extensions loaded after us can discover us
  pi.events.emit("summoner:ready", {});

  // On shutdown, abort all agents immediately and clean up.
  // If the session is going down, there's nothing left to consume agent results.
  pi.on("session_shutdown", async () => {
    unsubSpawnRpc();
    unsubStopRpc();
    unsubPingRpc();
    currentCtx?.ui.setStatus("agent-summoner", undefined);
    currentCtx = undefined;
    delete (globalThis as any)[MANAGER_KEY];
    unsubModeKey?.();
    unsubModeKey = undefined;
    manager.abortAll();
    for (const timer of pendingNudges.values()) clearTimeout(timer);
    pendingNudges.clear();
    fleet.dispose();
    manager.dispose();
  });

  // Live widget: show running agents above editor
  const widget = new AgentWidget(manager, agentActivity);

  // Claude Code-style FleetView: navigable list of main + subagents below the editor.
  const fleet = new FleetList(manager, agentActivity);
  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  // ---- Join mode configuration ----
  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  // ---- Scope models configuration ----
  // When enabled, subagent model choices are validated against `enabledModels`
  // from pi's settings — both global `<agentDir>/settings.json` and
  // project-local `<cwd>/.pi/settings.json` (project overrides global).
  // Off by default; opt-in via `/agents → Settings`. See docstring on
  // SubagentsSettings.scopeModels for the hard-error vs warn-and-proceed
  // policy and its rationale.
  let scopeModelsEnabled = false;
  function isScopeModelsEnabled(): boolean { return scopeModelsEnabled; }
  function setScopeModelsEnabled(enabled: boolean): void { scopeModelsEnabled = enabled; }

  // ---- Plan mode configuration ----
  // When enabled (default), the system operates in Plan mode:
  // write/edit tools are restricted to .md files only.
  // Toggle via `/mode` command.
  let planModeEnabled = true;
  function isPlanModeEnabled(): boolean { return planModeEnabled; }
  function setPlanModeEnabled(b: boolean): void {
    planModeEnabled = b;
    setModeIndicator(b ? "plan" : "crafting");
    updateStatusBar();
  }

  /** Update the TUI status bar to show mode. */
  function updateStatusBar() {
    if (!currentCtx) {
      console.warn("[agent-summoner] updateStatusBar: currentCtx not set — skipping");
      return;
    }
    const icon = isPlanModeEnabled() ? "🔮" : "⚡";
    const label = isPlanModeEnabled() ? "plan" : "crafting";
    currentCtx.ui.setStatus("agent-summoner", `${icon} agent-summoner · ${label}`);
  }

  // ---- Disable default agents configuration ----
  // When enabled, the three hardcoded default agents (general-purpose, Scout,
  // Plan) are not registered. User-defined agents from .pi/agents/*.md are
  // completely unaffected — only DEFAULT_AGENTS are suppressed.
  // Defaults to false; opt-in via `/agents → Settings` or summoner.json.
  // State lives in agent-types.ts (isDefaultsDisabled) because registerAgents
  // needs it; this wrapper just re-registers after flipping it.
  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents(); // re-register with new setting
  }

  // ---- Agent tool description mode ----
  // "full" (default) keeps the rich Claude Code-style description; "compact"
  // swaps in a ~75% smaller one for small/local models (#91). Read once at
  // tool registration — flipping it applies on the next pi session.
  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  // ---- Batch tracking for smart join mode ----
  // Collects background agent IDs spawned in the current turn for smart grouping.
  // Uses a debounced timer: each new agent resets the 100ms window so that all
  // parallel tool calls (which may be dispatched across multiple microtasks by the
  // framework) are captured in the same batch.
  let currentBatchAgents: { id: string; joinMode: JoinMode }[] = [];
  let batchFinalizeTimer: ReturnType<typeof setTimeout> | undefined;
  let batchCounter = 0;

  /** Finalize the current batch: if 2+ smart-mode agents, register as a group. */
  function finalizeBatch() {
    batchFinalizeTimer = undefined;
    const batchAgents = [...currentBatchAgents];
    currentBatchAgents = [];

    const smartAgents = batchAgents.filter(a => a.joinMode === 'smart' || a.joinMode === 'group');
    if (smartAgents.length >= 2) {
      const groupId = `batch-${++batchCounter}`;
      const ids = smartAgents.map(a => a.id);
      groupJoin.registerGroup(groupId, ids);
      // Retroactively process agents that already completed during the debounce window.
      // Their onComplete fired but was deferred (agent was in currentBatchAgents),
      // so we feed them into the group now.
      for (const id of ids) {
        const record = manager.getRecord(id);
        if (!record) continue;
        record.groupId = groupId;
        if (record.completedAt != null && !record.resultConsumed) {
          groupJoin.onAgentComplete(record);
        }
      }
    } else {
      // No group formed — send individual nudges for any agents that completed
      // during the debounce window and had their notification deferred.
      for (const { id } of batchAgents) {
        const record = manager.getRecord(id);
        if (record?.completedAt != null && !record.resultConsumed) {
          sendIndividualNudge(record);
        }
      }
    }
  }

  // Grab UI context from first tool execution + clear lingering widget on new turn
  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    widget.onTurnStart();
  });

  /** Format an agent's tool scope: "*" when it has all built-ins, else a comma-separated list. */
  const formatToolsSuffix = (cfg: AgentConfig | undefined): string => {
    const tools = cfg?.builtinToolNames;
    if (!tools || tools.length === 0) return "*";
    const isFullSet =
      tools.length === BUILTIN_TOOL_NAMES.length
      && BUILTIN_TOOL_NAMES.every((t) => tools.includes(t));
    return isFullSet ? "*" : tools.join(", ");
  };

  /** Build the full type list text dynamically from available agents only. */
  const buildTypeListText = () => {
    const available = getAvailableTypes();

    return available.map((name) => {
      const cfg = getAgentConfig(name);
      const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
      const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
      return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
    }).join("\n");
  };

  /** First sentence of an agent description — for the compact type list. */
  const firstSentence = (text: string): string => {
    const match = text.match(/^.*?[.!?](?=\s|$)/s);
    return (match ? match[0] : text).replace(/\s+/g, " ").trim();
  };

  /** Compact type list: one line per agent, first sentence only. */
  const buildCompactTypeListText = () =>
    getAvailableTypes().map((name) => {
      const cfg = getAgentConfig(name);
      return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
    }).join("\n");

  /** Derive a short model label from a model string. */
  function getModelLabelFromConfig(model: string): string {
    // Strip provider prefix (e.g. "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6")
    const name = model.includes("/") ? model.split("/").pop()! : model;
    // Strip trailing date suffix (e.g. "claude-haiku-4-5-20251001" → "claude-haiku-4-5")
    return name.replace(/-\d{8}$/, "");
  }

  // Apply persisted settings on startup and emit `summoner:settings_loaded`.
  // Global + project merged; missing → defaults; corrupt file emits a warning
  // to stderr and falls back to defaults.
  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setScopeModels: setScopeModelsEnabled,
      setDisableDefaultAgents: setDisableDefaultAgents,
      setToolDescriptionMode: setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
      setPlanMode: setPlanModeEnabled,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  // ---- Agent tool ----

  // Compact Agent tool description (#91, `toolDescriptionMode: "compact"`) —
  // the same load-bearing facts as the full version at ~75% fewer tokens, for
  // small/local models. Per-option details live in the param descriptions.
  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls, run_in_background: true on each. You are notified when background agents finish — never poll or sleep.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.
- isolation: "worktree" runs the agent in an isolated git worktree; changes land on a branch.`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses, with run_in_background: true on each, so they run concurrently. If the user specifies that they want agents run "in parallel", you MUST send a single message with multiple tool calls. Foreground calls run sequentially — only one executes at a time.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting work as done.
- Use run_in_background for work you don't need immediately. You will be notified when it completes — do NOT poll or sleep waiting for it. Continue with other work or respond to the user instead.
- Foreground vs background: use foreground (default) when you need the agent's results before you can proceed. Use background when you have genuinely independent work to do in parallel.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.
- Use isolation: "worktree" to run the agent in an isolated git worktree (safe parallel file modifications). The worktree is automatically cleaned up if the agent makes no changes; otherwise the path and branch are returned in the result.

## Writing the prompt

Provide clear, detailed prompts so the agent can work autonomously. Brief it like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  // `toolDescriptionMode: "custom"` — user-authored description with live
  // dynamic parts. Project file wins over global; missing/empty falls back to
  // "full" (a stale fallback beats a blank tool description). Only the prose
  // is customizable — the parameter schema stays code-owned.
  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
    };
    // Replacement callback (not a string) — agent descriptions may contain `$&` etc.
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[agent-summoner] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[agent-summoner] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[agent-summoner] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  const agentToolDescription = (() => {
    const mode = getToolDescriptionMode();
    if (mode === "compact") return compactAgentToolDescription;
    if (mode === "custom") {
      const custom = loadCustomToolDescription();
      if (custom) return custom;
      console.warn('[agent-summoner] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
    }
    return fullAgentToolDescription;
  })();

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description: agentToolDescription,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Scout). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
      ...(isPlanModeEnabled() ? ["🔮 Plan mode active — you are in analysis & planning mode. Write/edit only to .md files. Toggle with /mode."] : []),
    ],
    parameters: Type.Object({
      prompt: Type.String({
        description: "The task for the agent to perform.",
      }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.String({
        description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
      }),
      model: Type.Optional(
        Type.String({
          description:
            'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
        }),
      ),
      thinking: Type.Optional(
        Type.String({
          description: "Thinking level: off, minimal, low, medium, high, xhigh. Overrides agent default.",
        }),
      ),
      max_turns: Type.Optional(
        Type.Number({
          description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
          minimum: 1,
        }),
      ),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Set to true to run in background. Returns agent ID immediately. You will be notified on completion.",
        }),
      ),
      resume: Type.Optional(
        Type.String({
          description: "Optional agent ID to resume from. Continues from previous context.",
        }),
      ),
      isolated: Type.Optional(
        Type.Boolean({
          description: "If true, agent gets no extension/MCP tools — only built-in tools.",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Boolean({
          description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
        }),
      ),
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description: 'Set to "worktree" to run the agent in a temporary git worktree (isolated copy of the repo). Changes are saved to a branch on completion.',
        }),
      ),
    }),

    // ---- Custom rendering: Claude Code style ----

    renderCall(args, theme) {
      const displayName = args.subagent_type ? getDisplayName(args.subagent_type) : "Agent";
      const desc = args.description ?? "";
      return new Text("▸ " + theme.fg("toolTitle", theme.bold(displayName)) + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as AgentDetails | undefined;
      if (!details) {
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        return new Text(text, 0, 0);
      }

      // Helper: build "haiku · thinking: high · ↻5≤30 · 3 tool uses · 33.8k tokens" stats string
      const stats = (d: AgentDetails) => {
        const parts: string[] = [];
        if (d.modelName) parts.push(d.modelName);
        if (d.tags) parts.push(...d.tags);
        if (d.turnCount != null && d.turnCount > 0) {
          parts.push(formatTurns(d.turnCount, d.maxTurns));
        }
        if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
        if (d.tokens) parts.push(d.tokens);
        return parts.map(p => theme.fg("dim", p)).join(" " + theme.fg("dim", "·") + " ");
      };

      // ---- While running (streaming) ----
      if (isPartial || details.status === "running") {
        const frame = SPINNER[details.spinnerFrame ?? 0];
        const s = stats(details);
        let line = theme.fg("accent", frame) + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", `  ⎿  ${details.activity ?? "thinking…"}`);
        return new Text(line, 0, 0);
      }

      // ---- Background agent launched ----
      if (details.status === "background") {
        return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
      }

      // ---- Completed / Steered ----
      if (details.status === "completed" || details.status === "steered") {
        const duration = formatMs(details.durationMs);
        const isSteered = details.status === "steered";
        const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
        const s = stats(details);
        let line = icon + (s ? " " + s : "");
        line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

        if (expanded) {
          const resultText = result.content[0]?.type === "text" ? result.content[0].text : "";
          if (resultText) {
            const lines = resultText.split("\n").slice(0, 50);
            for (const l of lines) {
              line += "\n" + theme.fg("dim", `  ${l}`);
            }
            if (resultText.split("\n").length > 50) {
              line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
            }
          }
        } else {
          const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
          line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
        }
        return new Text(line, 0, 0);
      }

      // ---- Stopped (user-initiated abort) ----
      if (details.status === "stopped") {
        const s = stats(details);
        let line = theme.fg("dim", "■") + (s ? " " + s : "");
        line += "\n" + theme.fg("dim", "  ⎿  Stopped");
        return new Text(line, 0, 0);
      }

      // ---- Error / Aborted (hard max_turns) ----
      const s = stats(details);
      let line = theme.fg("error", "✗") + (s ? " " + s : "");

      if (details.status === "error") {
        line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
      } else {
        line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
      }

      return new Text(line, 0, 0);
    },

    // ---- Execute (delegated to tools/agent-tool.ts) ----

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      return executeAgent(toolCallId, params as any, signal, onUpdate, ctx, {
        pi,
        manager,
        agentActivity,
        reloadCustomAgents,
        isScopeModelsEnabled,
        getDefaultJoinMode,
        currentBatchAgents,
        batchFinalizeTimer: { current: batchFinalizeTimer },
        finalizeBatch,
        widget,
        fleet,
        getDefaultMaxTurns,
      });
    },
  }));


  // ---- get_subagent_result tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve results from a background agent. Use the agent ID returned by Agent with run_in_background.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check.",
      }),
      wait: Type.Optional(
        Type.Boolean({
          description: "If true, wait for the agent to complete before returning. Default: false.",
        }),
      ),
      verbose: Type.Optional(
        Type.Boolean({
          description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      return executeGetSubagentResult(params, { manager, agentActivity, cancelNudge, widget, fleet, events: pi.events });
    },
  }));

  // ---- steer_subagent tool ----

  pi.registerTool(defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      return executeSteerSubagent(params, { manager, agentActivity, cancelNudge, widget, fleet, events: pi.events });
    },
  }));

  // ---- plan_checkpoint tool — structured plan approval ----

  pi.registerTool(defineTool({
    name: "plan_checkpoint",
    label: "Plan Checkpoint",
    description:
      "Present a structured approval checkpoint after delivering a plan. " +
      "Call this when you've finished planning and want to ask the user whether to start implementing or revise.",
    promptSnippet: "Ask user: start implementing or revise the plan?",
    parameters: Type.Object({
      summary: Type.String({
        description: "One-line summary of the plan for the checkpoint prompt.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const summary = (params as { summary: string }).summary ?? "the plan";

      if (!ctx.hasUI) {
        return textResult(
          "No UI available. Ask the user directly: 'Ready to implement? Type /mode to switch.'",
        );
      }

      const choice = await ctx.ui.select(
        `Plan complete: ${summary}`,
        [
          "✅ Yes — start implementing (switch to crafting mode)",
          "🔄 No — I have feedback (stay in Plan mode)",
        ],
      );

      if (!choice) {
        return textResult("Checkpoint cancelled — staying in plan mode.");
      }

      if (choice.startsWith("✅")) {
        setPlanModeEnabled(false);
        saveAndEmitChanged(
          snapshotSettings(),
          "Switched to crafting mode (plan approved)",
          (evt, payload) => pi.events.emit(evt, payload),
        );
        return textResult(
          "✅ Plan approved! Mode switched to crafting. You now have full editing access. Proceed with implementation.",
        );
      }

      // User wants revisions — prompt for feedback
      const feedback = await ctx.ui.input(
        "What needs to change?",
        "e.g. add error handling, split into smaller tasks...",
      );

      if (!feedback) {
        return textResult("No feedback provided — staying in plan mode.");
      }

      return textResult(
        `🔄 Feedback received (staying in plan mode):\n\n${feedback}\n\nUpdate the plan accordingly and call plan_checkpoint again when ready.`,
      );
    },
  }));

  // ---- /agents interactive menu (delegated to menu/agents-menu.ts) ----

  const showAgentsMenu = createAgentsMenuHandler({
    pi,
    manager,
    widget,
    fleet,
    agentActivity,
    reloadCustomAgents,
    getDefaultJoinMode,
    isScopeModelsEnabled,
    isFleetViewEnabled,
    getToolDescriptionMode,
    setDefaultJoinMode,
    setScopeModelsEnabled,
    setFleetViewEnabled,
    setPlanModeEnabled,
    isPlanModeEnabled,
    setToolDescriptionMode,
    setDisableDefaultAgents,
  });

  function snapshotSettings(): SubagentsSettings {
    return {
      maxConcurrent: manager.getMaxConcurrent(),
      defaultMaxTurns: getDefaultMaxTurns() ?? 0,
      graceTurns: getGraceTurns(),
      defaultJoinMode: getDefaultJoinMode(),
      scopeModels: isScopeModelsEnabled(),
      disableDefaultAgents: isDefaultsDisabled(),
      toolDescriptionMode: getToolDescriptionMode(),
      fleetView: isFleetViewEnabled(),
      planMode: isPlanModeEnabled(),
    };
  }

  function notifyApplied(ctx: ExtensionCommandContext, successMsg: string) {
    const { message, level } = saveAndEmitChanged(
      snapshotSettings(),
      successMsg,
      (event, payload) => pi.events.emit(event, payload),
    );
    ctx.ui.notify(message, level);
  }

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (_args, ctx) => { await showAgentsMenu(ctx); },
  });

  pi.registerCommand("mode", {
    description: "Toggle between plan mode (default) and crafting mode",
    handler: async (_args, ctx) => {
      const current = isPlanModeEnabled() ? "plan" : "crafting";
      const choice = await ctx.ui.select(
        `Mode: ${current}`,
        [
          `🔮 Plan (current${current === "plan" ? ", active" : ""}) — analysis & planning, .md writes only`,
          `⚡ Crafting${current === "crafting" ? " (current, active)" : ""} — full code editing enabled`,
        ],
      );
      if (!choice) return;
      const newMode = choice.startsWith("🔮") ? "plan" : "crafting";
      setPlanModeEnabled(newMode === "plan");
      const { message, level } = saveAndEmitChanged(
        snapshotSettings(),
        `Mode set to ${newMode}`,
        (event, payload) => pi.events.emit(event, payload),
      );
      ctx.ui.notify(message, level);
    },
  });

  pi.registerCommand("party:start", {
    description: "Configure agent models interactively and generate party.rules.json",
    handler: async (_args, ctx) => {
      const available = ctx.modelRegistry.getAvailable() as Array<{ provider: string; id: string; name: string }>;
      if (!available || available.length === 0) {
        ctx.ui.notify("No models available. Configure API keys in settings first.", "warning");
        return;
      }

      const modelOptions = [
        "⏭️  Skip — inherit from parent / use default",
        ...available.map(m => `${m.provider}/${m.id}  (${m.name})`),
      ];

      const existing = loadPartyRules(ctx.cwd);
      const rules: PartyRules = { model: {} };

      const agents = [
        { key: "scout" as const, label: "🔍 Scout" },
        { key: "crafter" as const, label: "🛠️  Crafter" },
        { key: "gatekeeper" as const, label: "🚧 Gatekeeper" },
      ];

      for (const agent of agents) {
        const current = existing.model?.[agent.key];
        const currentLabel = current
          ? ` (current: ${current})`
          : " (current: inherited)";

        const choice = await ctx.ui.select(
          `Select model for ${agent.label}${currentLabel}`,
          modelOptions,
        );
        if (!choice) {
          ctx.ui.notify("Setup cancelled.", "info");
          return;
        }
        if (!choice.startsWith("⏭️")) {
          const modelKey = choice.split("  (")[0];
          rules.model![agent.key] = modelKey;
        }
      }

      // Check if any models were actually configured
      const hasAny = Object.values(rules.model!).some(v => v !== undefined);
      if (!hasAny) {
        ctx.ui.notify("No models configured — all agents will inherit defaults.", "info");
        return;
      }

      const saved = savePartyRules(rules, ctx.cwd);
      if (saved) {
        const summary = Object.entries(rules.model!)
          .filter(([, v]) => v)
          .map(([k, v]) => `  ${k}: ${v}`)
          .join("\n");
        ctx.ui.notify(`party.rules.json saved:\n${summary} \n\n ---------------------------- \n\n🎉 Party assembled! Let's venture!\n\n----------------------------`, "info");
      } else {
        ctx.ui.notify("Failed to save party.rules.json.", "warning");
      }
    },
  });
}
