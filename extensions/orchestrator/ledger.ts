/**
 * ledger.ts — Single source of truth for file state across all agents.
 *
 * The Ledger is owned exclusively by Main Agent. Every Crafter write and
 * Gatekeeper result flows through here. No agent maintains its own view of
 * "what's done" — they read from the Ledger.
 *
 * Persistence: pi.appendEntry("ledger-update", ...) on every mutation.
 * Replay: on session_start, iterate session entries to rebuild state.
 *
 * @see docs/flow.md §2 — Ledger state machine
 * @see docs/plan.md Task 0.2
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ──────────────────────────────────────────────────────────────────

export type FileStatus = "pending" | "in_progress" | "done" | "blocked" | "failed";

export interface FileEntry {
  status: FileStatus;
  phase: number;
  owner: string | null;
  summary?: string;
  /** True if this file was not in the original plan (unplanned discovery). */
  discovered?: boolean;
}

export interface LedgerState {
  currentPhase: number;
  totalPhases: number;
  files: Record<string, FileEntry>;
}

// ── Module State ───────────────────────────────────────────────────────────

let ledgerState: LedgerState = {
  currentPhase: 0,
  totalPhases: 0,
  files: {},
};

let _pi: ExtensionAPI | null = null;

// ── Init ───────────────────────────────────────────────────────────────────

/** Call once during session_start to wire pi for persistence. */
export function initLedger(pi: ExtensionAPI): void {
  _pi = pi;
}

// ── Read ───────────────────────────────────────────────────────────────────

export function getLedger(): Readonly<LedgerState> {
  return ledgerState;
}

export function getFileEntry(path: string): FileEntry | undefined {
  return ledgerState.files[path];
}

export function getFilesByPhase(phase: number): [string, FileEntry][] {
  return Object.entries(ledgerState.files).filter(
    ([, entry]) => entry.phase === phase,
  );
}

/** True when every file in the given phase has status "done". */
export function isPhaseComplete(phase: number): boolean {
  const phaseFiles = getFilesByPhase(phase);
  if (phaseFiles.length === 0) return true; // empty phase is complete
  return phaseFiles.every(([, e]) => e.status === "done");
}

/** True when all phases (0..totalPhases-1) are complete. */
export function allPhasesComplete(): boolean {
  for (let p = 0; p < ledgerState.totalPhases; p++) {
    if (!isPhaseComplete(p)) return false;
  }
  return true;
}

/**
 * Phase gate: true when all files in every prior phase are "done".
 * This is the mechanism that prevents two Crafters from touching files
 * with an unresolved dependency between them.
 */
export function canStartPhase(phase: number): boolean {
  for (let p = 0; p < phase; p++) {
    if (!isPhaseComplete(p)) return false;
  }
  return true;
}

/** All files that are not yet done (for crash recovery / reassignment). */
export function getPendingFiles(): [string, FileEntry][] {
  return Object.entries(ledgerState.files).filter(
    ([, e]) => e.status !== "done",
  );
}

/** All files in the Ledger (for report generation). */
export function getAllFiles(): Record<string, FileEntry> {
  return { ...ledgerState.files };
}

// ── Write ──────────────────────────────────────────────────────────────────

/**
 * Update a file's entry in the Ledger. Merges with existing entry.
 * Persists via pi.appendEntry if pi is wired.
 * Triggers status widget refresh (caller's responsibility — see ui.ts).
 */
export function setFileStatus(
  path: string,
  update: Partial<FileEntry>,
): FileEntry {
  const existing = ledgerState.files[path] || {
    status: "pending" as FileStatus,
    phase: 0,
    owner: null,
  };
  const merged: FileEntry = { ...existing, ...update };
  ledgerState.files[path] = merged;

  // Persist to session JSONL (survives /reload, crash recovery)
  if (_pi) {
    _pi.appendEntry("ledger-update", { path, ...merged });
  }

  return merged;
}

/**
 * Bulk-populate the Ledger from an approved plan.
 * All files start as "pending" with their assigned phase.
 */
export function populateFromPlan(
  planFiles: { path: string; phase: number }[],
  totalPhases: number,
): void {
  ledgerState.totalPhases = totalPhases;
  ledgerState.currentPhase = 0;
  ledgerState.files = {}; // clear previous plan
  for (const { path, phase } of planFiles) {
    ledgerState.files[path] = {
      status: "pending",
      phase,
      owner: null,
    };
  }
}

// ── Persistence / Replay ───────────────────────────────────────────────────

/**
 * Rebuild Ledger state from session entries on session_start.
 * Replays in tree order (id/parentId); latest update per file path wins.
 */
export function replayFromEntries(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): void {
  // Reset to empty
  ledgerState = { currentPhase: 0, totalPhases: 0, files: {} };

  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === "ledger-update") {
      const data = entry.data as Record<string, unknown> | undefined;
      if (!data || typeof data.path !== "string") continue;

      const { path, ...rest } = data;
      const fileEntry = rest as unknown as FileEntry;

      // latest-wins: overwrite whatever was there before
      ledgerState.files[path] = fileEntry;

      // Track highest phase seen
      if (typeof fileEntry.phase === "number" && fileEntry.phase >= ledgerState.totalPhases) {
        ledgerState.totalPhases = fileEntry.phase + 1;
      }
    }
  }

  // Determine currentPhase: first phase that isn't fully "done"
  for (let p = 0; p < ledgerState.totalPhases; p++) {
    if (!isPhaseComplete(p)) {
      ledgerState.currentPhase = p;
      return;
    }
  }
  ledgerState.currentPhase = ledgerState.totalPhases;
}

// ── Reset ──────────────────────────────────────────────────────────────────

/** Clear the Ledger entirely (e.g., for a fresh task). */
export function resetLedger(): void {
  ledgerState = { currentPhase: 0, totalPhases: 0, files: {} };
}
