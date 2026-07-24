/**
 * craft-orchestration.ts — Craft-mode implementation policy for the main session.
 *
 * Modes:
 * - "nudge" (default, implemented): main keeps write/edit; persona + tool copy
 *   push the model to spawn Crafter / Gatekeeper.
 * - "hybrid" (reserved, NOT implemented): main write/edit blocked by default;
 *   must spawn Crafter. Solo escape via future /solo or explicit user override.
 *   Pure strict (no escape) is intentionally not a mode.
 *
 * When hybrid is selected before enforcement ships, runtime behaves as nudge.
 */

export type OrchestrationMode = "nudge" | "hybrid";

export const DEFAULT_ORCHESTRATION_MODE: OrchestrationMode = "nudge";

const VALID_MODES = new Set<OrchestrationMode>(["nudge", "hybrid"]);

/** Parse a raw setting value; invalid → undefined (caller applies default). */
export function parseOrchestrationMode(raw: unknown): OrchestrationMode | undefined {
  if (typeof raw !== "string") return undefined;
  return VALID_MODES.has(raw as OrchestrationMode) ? (raw as OrchestrationMode) : undefined;
}

/**
 * Whether the main session should be blocked from write/edit.
 *
 * Nudge: always false.
 * Hybrid: future — return true unless solo escape is active.
 * Today hybrid is not enforced; always returns false so behavior stays nudge.
 */
export function shouldBlockMainWrite(_mode: OrchestrationMode): boolean {
  // HYBRID: when implementing, return _mode === "hybrid" && !isSoloEscapeActive()
  return false;
}

/** Normalize missing/invalid to the default implemented mode. */
export function resolveOrchestrationMode(
  mode: OrchestrationMode | undefined,
): OrchestrationMode {
  return mode ?? DEFAULT_ORCHESTRATION_MODE;
}
