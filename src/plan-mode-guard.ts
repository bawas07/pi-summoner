/**
 * plan-mode-guard.ts — Pure plan-mode tool_call policy.
 *
 * Hard layer that enforces "analysis only" while the soft layer (PLAN_MODE_PERSONA)
 * guides behavior. Extracted for unit testing without booting the extension.
 *
 * HYBRID NOTE (craft orchestration):
 * This module is plan-mode only. Future craft-mode write blocking lives in
 * craft-orchestration.ts (orchestrationMode: "hybrid"). Do not overload this
 * file with craft rules.
 */

import type { AgentConfig } from "./types.js";

export type PlanGuardDecision =
  | { block: false }
  | { block: true; reason: string };

const WRITE_TOOLS = new Set(["write", "edit"]);

/** Tools that never mutate the repo and are always safe in plan mode. */
const PLAN_SAFE_TOOLS = new Set([
  // read / search
  "read",
  "grep",
  "find",
  "ls",
  "fffind",
  "ffgrep",
  // research
  "web_search",
  "fetch_content",
  "get_search_content",
  "analyze_image",
  // user I/O
  "ask_user_question",
  "plan_checkpoint",
  // subagent ops (spawn still filtered by agent type)
  "Agent",
  "get_subagent_result",
  "steer_subagent",
]);

/** Built-in agents known to be read-only (explicit allow in plan mode). */
const READ_ONLY_BUILTIN_AGENTS = new Set([
  "scout",
  "code-reviewer",
  "architect-reviewer",
  "security-auditor",
]);

/** Built-in agents that must never spawn while planning. */
const WRITE_CAPABLE_BUILTIN_AGENTS = new Set([
  "crafter",
  "gatekeeper",
  "general-purpose",
]);

const MUTATING_BUILTIN_TOOLS = new Set(["write", "edit"]);

export interface PlanGuardInput {
  toolName: string;
  input: Record<string, unknown>;
  /** Resolve agent config by type name (case-insensitive ok). */
  getAgentConfig: (name: string) => AgentConfig | undefined;
}

/** True when path is an allowed plan artifact (markdown only). */
export function isAllowedPlanWritePath(path: string | undefined): boolean {
  if (!path || typeof path !== "string") return false;
  return path.endsWith(".md");
}

/**
 * Whether an agent type is read-only enough to spawn in plan mode.
 *
 * Rules:
 * 1. Known write-capable builtins → no
 * 2. Known read-only builtins → yes
 * 3. Custom / other: builtinToolNames must be defined (not "all tools") and
 *    must not include write/edit
 * 4. Missing config → no (fail closed)
 */
export function isReadOnlyAgentType(
  typeName: string | undefined,
  getAgentConfig: (name: string) => AgentConfig | undefined,
): boolean {
  if (!typeName || typeof typeName !== "string") return false;

  const lower = typeName.toLowerCase();
  if (WRITE_CAPABLE_BUILTIN_AGENTS.has(lower)) return false;
  if (READ_ONLY_BUILTIN_AGENTS.has(lower)) return true;

  const config = getAgentConfig(typeName);
  if (!config) return false;

  // Omitted builtinToolNames means full tool surface → write-capable
  if (config.builtinToolNames === undefined) return false;

  const tools = config.builtinToolNames.map((t) => t.toLowerCase());
  if (tools.some((t) => MUTATING_BUILTIN_TOOLS.has(t))) return false;

  // Explicit empty tool list is read-only (degenerate but safe)
  return true;
}

function block(reason: string): PlanGuardDecision {
  return { block: true, reason };
}

function allow(): PlanGuardDecision {
  return { block: false };
}

function decideBash(cmd: string): PlanGuardDecision {
  // Allow harmless stderr / stdout discard to /dev/null (not a file write)
  if (/\d?>\s*\/dev\/null/.test(cmd)) {
    return allow();
  }
  // Allow 2>&1 (merge stderr to stdout, no file written)
  if (/\d+>&\d+/.test(cmd) && !/\d+>>?\s*[^&\d]/.test(cmd)) {
    return allow();
  }

  // Block output redirection (writing to files via >, >>, &>, 2>)
  // [^<]?> matches > at any position (including start of string)
  // &>file or >&file (with non-digit target) = file redirect
  if (/[^<]?>\s*[^\s=&]/.test(cmd)) {
    return block(
      "🔮 Plan mode: bash file redirection is disabled. Only .md file writes are permitted.",
    );
  }
  if (/&>\s*[^\s&]/.test(cmd) || />&\s*[^\d]/.test(cmd)) {
    return block(
      "🔮 Plan mode: bash file redirection is disabled. Only .md file writes are permitted.",
    );
  }

  // Block known destructive / mutating commands
  if (
    /\b(rm\b|mkdir|rmdir|mv|cp\b|chmod|chown|touch|ln\b|truncate|dd\b|mkfs|sed\s+.*-i|tee\b|npm\s+i(nstall)?\b|git\s+commit\b)\b/.test(
      cmd,
    )
  ) {
    return block(
      "🔮 Plan mode: destructive bash commands are disabled. Only .md file writes are permitted.",
    );
  }

  return allow();
}

function decideAgentSpawn(
  input: Record<string, unknown>,
  getAgentConfig: (name: string) => AgentConfig | undefined,
): PlanGuardDecision {
  // Resume continues an existing agent — spawn-type filter does not apply
  if (typeof input.resume === "string" && input.resume.length > 0) {
    return allow();
  }

  const subagentType =
    typeof input.subagent_type === "string" ? input.subagent_type : undefined;

  if (isReadOnlyAgentType(subagentType, getAgentConfig)) {
    return allow();
  }

  const label = subagentType ?? "(missing subagent_type)";
  return block(
    `🔮 Plan mode: cannot spawn write-capable agent "${label}". ` +
      "Use Scout (or another read-only agent) for exploration. " +
      "Switch to craft mode to use Crafter/Gatekeeper.",
  );
}

function decideWrite(input: Record<string, unknown>): PlanGuardDecision {
  const path = typeof input.path === "string" ? input.path : undefined;
  if (!isAllowedPlanWritePath(path)) {
    const shown = path ?? "(missing path)";
    return block(
      `🔮 Plan mode: only .md files can be written. "${shown}" is not allowed.`,
    );
  }
  return allow();
}

/**
 * Decide whether a tool call is permitted in plan mode.
 * Caller must only invoke this when plan mode is active.
 */
export function decidePlanModeToolCall(event: PlanGuardInput): PlanGuardDecision {
  const { toolName, input, getAgentConfig } = event;

  if (toolName === "bash") {
    const cmd = typeof input.command === "string" ? input.command : "";
    return decideBash(cmd);
  }

  if (WRITE_TOOLS.has(toolName)) {
    return decideWrite(input);
  }

  if (toolName === "Agent") {
    return decideAgentSpawn(input, getAgentConfig);
  }

  if (PLAN_SAFE_TOOLS.has(toolName)) {
    return allow();
  }

  return block(
    `🔮 Plan mode: tool "${toolName}" is not available. ` +
      "Only read/search tools, ask_user_question, plan_checkpoint, read-only agents, and .md writes are permitted.",
  );
}
