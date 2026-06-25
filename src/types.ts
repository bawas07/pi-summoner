/**
 * Shared types for the agent-summoner extension.
 * All modules import from here — no circular dependencies.
 */

// ---- Ledger ----

export type LedgerAction = "read" | "write" | "delete";

export interface LedgerEntry {
  /** Absolute or repo-relative file path */
  file: string;
  /** Which agent instance touched it (e.g. "crafter-1") */
  agent: string;
  /** What was done */
  action: LedgerAction;
  /** Unix epoch milliseconds */
  timestamp: number;
}

// ---- Agent Registry ----

export interface ModelRef {
  provider: string;
  modelId: string;
}

/** Thinking effort level passed to pi --model provider/id:thinking */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** Pi tool names that can be assigned to an agent */
export type ToolName = string;

export interface AgentDefinition {
  /** Unique kebab-case name, becomes tool name summon_<name> */
  name: string;
  /** LLM-readable system prompt for the sub-agent */
  systemPrompt: string;
  /** Hardcoded default model (Phase 1; Phase 2 adds get_available_models) */
  defaultModel: ModelRef;
  /** Default thinking level at spawn */
  defaultThinking: ThinkingLevel;
  /** Tools available to this agent. Gatekeeper's excludes write/edit — architectural enforcement. */
  tools: ToolName[];
  /** true for Scout (read-only, low risk), false for Crafter/Gatekeeper */
  canDispatchWithoutApproval: boolean;
}

/** Represents one running sub-agent instance */
export type AgentStatus = "idle" | "working" | "done" | "failed";

export interface AgentInstance {
  /** Unique instance id (e.g. "crafter-1", "scout-2") */
  id: string;
  /** Matches AgentDefinition.name */
  role: string;
  model: ModelRef;
  thinking: ThinkingLevel;
  status: AgentStatus;
  /** Task description for display */
  task: string;
  /** tmux window name (Phase 2) — set but unused in Phase 1 */
  windowName: string;
}

// ---- Ambient Trigger ----

export interface TriggerResult {
  /** Does Main Agent need codebase information right now (excluding docs)? */
  needsScout: boolean;
  /** Is the user indicating intent to implement a fix or feature? */
  implementIntent: boolean;
}

// ---- Plan Files ----

export type TrustMode = "trust" | "checkpoint";

export interface PlanStep {
  description: string;
  done: boolean;
}

export interface PlanFile {
  /** Full path: docs/tasks/{timestamp}-{short-title}.md */
  path: string;
  /** Short human-readable title */
  title: string;
  /** ISO timestamp string from filename */
  createdAt: string;
  /** 🙈 trust or 🔍 checkpoint — set at approval time */
  trustMode: TrustMode;
  /** Ordered checklist steps */
  steps: PlanStep[];
}

// ---- Gatekeeper ----

export type GatekeeperFindingCategory = "functional" | "quality";

export interface GatekeeperFinding {
  /** Human-readable description of the issue */
  description: string;
  /** Was this caused by this task's own agents? */
  inScope: boolean;
  /** What kind of issue */
  category: GatekeeperFindingCategory;
  /** Which file(s) are affected */
  files: string[];
}

// ---- Orchestrator State ----

export type OrchestratorPhase =
  | "idle"
  | "scouting"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "gatekeeping"
  | "done";

export interface OrchestratorState {
  phase: OrchestratorPhase;
  currentPlan: PlanFile | null;
  currentStepIndex: number;
  activeAgents: AgentInstance[];
}
