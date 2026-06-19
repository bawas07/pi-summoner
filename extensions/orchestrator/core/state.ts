/**
 * state.ts — Shared module state for the orchestrator.
 *
 * All agents read/write this state. No agent maintains its own conflicting
 * view. Cross-module imports (ledger, agents, ui, commands) all reference
 * the same module-scoped variables.
 *
 * @see docs/plan.md Task 0.4
 */

// ── Scout Cache Invalidation ───────────────────────────────────────────────

/**
 * Set of file paths whose cached dependency graphs are stale.
 * Crafter adds paths here on write. Scout checks before returning cached results.
 * Includes transitive reverse-dependencies: if A imports B and B is dirtied,
 * A is also added to this set.
 */
export const dirtyScoutCache = new Set<string>();

/** Mark a file (and optionally its reverse dependencies) as dirty. */
export function markScoutDirty(path: string): void {
  dirtyScoutCache.add(path);
}

/** Check and clear — returns true if file was dirty and clears it. */
export function checkAndClearDirty(path: string): boolean {
  const was = dirtyScoutCache.has(path);
  dirtyScoutCache.delete(path);
  return was;
}

// ── Agent Activity Log ─────────────────────────────────────────────────────

export interface AgentActivity {
  agentName: string;
  status: "active" | "waiting" | "done" | "failed" | "pending";
  currentFile?: string;
  detail?: string;
  startedAt: number;
}

/** Live log of all agent activity — powers status widget + watch mode. */
export const agentActivityLog = new Map<string, AgentActivity>();

export function updateAgentActivity(
  agentId: string,
  update: Partial<AgentActivity>,
): void {
  const existing = agentActivityLog.get(agentId);
  if (existing) {
    agentActivityLog.set(agentId, { ...existing, ...update });
  } else {
    agentActivityLog.set(agentId, {
      agentName: agentId,
      status: "pending",
      startedAt: Date.now(),
      ...update,
    });
  }
}

export function removeAgentActivity(agentId: string): void {
  agentActivityLog.delete(agentId);
}

// ── Running Agents (crash/timeout detection) ───────────────────────────────

export interface RunningAgent {
  startedAt: number;
  owner: string; // e.g., "crafter-1"
}

/** Tracks which agents are currently executing, with start timestamps. */
export const runningAgents = new Map<string, RunningAgent>();

export function markAgentRunning(agentId: string, owner: string): void {
  runningAgents.set(agentId, { startedAt: Date.now(), owner });
}

export function markAgentDone(agentId: string): void {
  runningAgents.delete(agentId);
}

// ── Trust Mode ─────────────────────────────────────────────────────────────

export type TrustMode = "trust" | "checkpoint";

/** Set at plan approval. Read by Crafter and Gatekeeper. */
export let trustMode: TrustMode = "checkpoint";

export function setTrustMode(mode: TrustMode): void {
  trustMode = mode;
}

export function getTrustMode(): TrustMode {
  return trustMode;
}
