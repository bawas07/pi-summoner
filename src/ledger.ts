/**
 * Ledger — single source of truth for file-level operations.
 *
 * In-memory only for Phase 1. Only orchestrator.ts has write access;
 * other consumers receive a read-only view via getLedgerSnapshot().
 *
 * Shape: {file, agent, action, timestamp} — chosen to support future
 * parallel Crafters without restructuring.
 */

import type { LedgerEntry, LedgerAction } from "./types";

// ---- In-memory store ----

const entries: LedgerEntry[] = [];

// ---- Write API (orchestrator.ts only) ----

export function recordTouch(
  file: string,
  agent: string,
  action: LedgerAction,
): void {
  entries.push({
    file,
    agent,
    action,
    timestamp: Date.now(),
  });
}

/** Record multiple touches from one agent report */
export function recordTouches(
  files: string[],
  agent: string,
  action: LedgerAction,
): void {
  const now = Date.now();
  for (const file of files) {
    entries.push({ file, agent, action, timestamp: now });
  }
}

/** Clear all entries — used on session restart or new plan start */
export function resetLedger(): void {
  entries.length = 0;
}

// ---- Read API (any consumer) ----

/** Returns a shallow copy — consumers cannot mutate the store */
export function getLedgerSnapshot(): readonly LedgerEntry[] {
  return [...entries];
}

/** Get all files touched by a specific agent */
export function getEntriesByAgent(agentId: string): LedgerEntry[] {
  return entries.filter((e) => e.agent === agentId);
}

/** Get all unique file paths that have been touched */
export function getTouchedFiles(): string[] {
  return [...new Set(entries.map((e) => e.file))];
}

/** Check if a specific file has been touched */
export function isFileTouched(file: string): boolean {
  return entries.some((e) => e.file === file);
}
