/**
 * Ambient trigger evaluation — runs on every conversation turn.
 *
 * Two independent checks evaluated separately. This module is intentionally
 * the ONLY place trigger logic lives — orchestrator.ts just acts on the result.
 *
 * Phase 1: keyword/heuristic-based classification. Simple, fast, cheap.
 * Designed for prompt iteration — the structure (TriggerResult, independent
 * signals) stays stable while the implementation can be swapped for LLM-based
 * classification without touching orchestrator.ts.
 */

import type { TriggerResult } from "./types";

// ---- Turn context (what we receive from pi's turn_start event) ----

export interface TurnContext {
  /** The full message text from the user (most recent turn) */
  message: string;
  /** Previous messages in conversation (truncated, last N) */
  recentHistory: string[];
  /** Current orchestrator phase if any */
  currentPhase?: string;
}

// ---- Scout-need signals ----

// Patterns indicating the user is asking about codebase entities
const CODEBASE_REFERENCE_PATTERNS = [
  /\b(?:file|module|function|class|component|endpoint|route|api|middleware|service|util|helper|hook|handler)\b/i,
  /\b(?:src|lib|app|components|utils|services|middleware|routes|api|pages)\//i,
  /\b(?:import|export|require)\b/i,
  /\b(?:where is|find|locate|search for|look at|check|show me)\b.+/i,
  /\b(?:codebase|source code|implementation|how does .+ work)\b/i,
  /\b\.(?:ts|js|tsx|jsx|json|yaml|yml|md)$/i,
];

// Patterns that indicate docs-only lookup (NOT codebase)
const DOCS_ONLY_PATTERNS = [
  /\b(?:PRD|README|readme|documentation|docs|spec|specs|requirements)\b/i,
  /\b(?:architecture decision|ADR|design doc)\b/i,
];

// ---- Implement-intent signals ----

// Strong action verbs that signal implementation intent
const IMPLEMENT_ACTION_VERBS = [
  /\b(?:fix|resolve|patch|correct)\b/i,
  /\b(?:build|create|make|develop|construct)\b/i,
  /\b(?:add|implement|introduce)\b/i,
  /\b(?:change|modify|update|alter|revise)\b/i,
  /\b(?:remove|delete|deprecate|drop)\b/i,
  /\b(?:refactor|restructure|reorganize)\b/i,
  /\b(?:go ahead|proceed|let'?s do|do it|yes[,.]? do)\b/i,
];

// Discussion/casual language that signals NO implementation intent
const DISCUSSION_ONLY_PATTERNS = [
  /^what (?:is|are|if|about|would|do you think|does)\b/i,
  /^how (?:does|would|should|about|do I|can I)\b/i,
  /^can (?:you|we|I)\b/i,
  /^is (?:there|it)\b/i,
  /^why (?:is|does|would)\b/i,
  /^should (?:we|I)\b/i,
  /\b(?:wonder|curious|explain|tell me about)\b/i,
  /\b(?:thoughts|opinion|idea|suggestion|maybe|perhaps)\b/i,
  /\b(?:let'?s discuss|let'?s think|brainstorm|explore)\b/i,
];

// ---- 6.1 evaluateTurn() ----

export function evaluateTurn(ctx: TurnContext): TriggerResult {
  return {
    needsScout: detectNeedsScout(ctx),
    implementIntent: detectImplementIntent(ctx),
  };
}

// ---- 6.2 needsScout detection ----

function detectNeedsScout(ctx: TurnContext): boolean {
  const msg = ctx.message;
  if (!msg || msg.trim().length === 0) return false;

  // If it's clearly a docs-only lookup, skip Scout
  if (DOCS_ONLY_PATTERNS.some((p) => p.test(msg))) {
    return false;
  }

  // If it references codebase entities, dispatch Scout
  if (CODEBASE_REFERENCE_PATTERNS.some((p) => p.test(msg))) {
    return true;
  }

  // Check recent history for mid-task context
  // If we're in the middle of a discussion about code, and the
  // user asks a follow-up, treat it as potential Scout-need
  const recentText = ctx.recentHistory.join(" ").toLowerCase();
  if (
    ctx.currentPhase === "executing" ||
    ctx.currentPhase === "scouting"
  ) {
    return true;
  }

  // If recent history mentions codebase entities and user is asking
  // a follow-up question
  if (
    CODEBASE_REFERENCE_PATTERNS.some((p) => p.test(recentText)) &&
    msg.length < 200
  ) {
    return true;
  }

  return false;
}

// ---- 6.3 implementIntent detection ----

function detectImplementIntent(ctx: TurnContext): boolean {
  const msg = ctx.message;
  if (!msg || msg.trim().length === 0) return false;

  // Explicit discussion language suppresses intent
  if (DISCUSSION_ONLY_PATTERNS.some((p) => p.test(msg))) {
    return false;
  }

  // Strong action verbs signal intent
  if (IMPLEMENT_ACTION_VERBS.some((p) => p.test(msg))) {
    return true;
  }

  // Short messages with implicit intent (e.g., "the login is broken")
  // after a longer discussion about code signal intent
  if (msg.length < 150) {
    const recentText = ctx.recentHistory.join(" ").toLowerCase();
    if (
      CODEBASE_REFERENCE_PATTERNS.some((p) => p.test(msg)) &&
      IMPLEMENT_ACTION_VERBS.some((p) => p.test(recentText))
    ) {
      return true;
    }
  }

  return false;
}
