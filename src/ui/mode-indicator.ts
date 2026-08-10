/**
 * mode-indicator.ts — Single-line mode indicator widget above the editor.
 *
 * Shows "🔮 Plan" or "⚡ General" like a terminal $ prompt, so the user always
 * knows what mode they're in before typing.
 */

import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "../ui/agent-widget.js";

const MODE_KEY = "agent-summoner-mode";

type PlanPhase = "analyzing" | "designing" | "breakdown" | null;

let currentMode: "plan" | "crafting" = "plan";
let currentPhase: PlanPhase = null;
let registered = false;
let ui: ExtensionUIContext | undefined;

/** Update the in-memory mode and re-render the widget. */
export function setModeIndicator(mode: "plan" | "crafting", uiOverride?: ExtensionUIContext): void {
  currentMode = mode;
  currentPhase = null; // reset phase on mode switch
  // Update the stored reference if an override is provided (e.g. from plan_checkpoint)
  if (uiOverride) {
    ui = uiOverride;
  }
  if (!ui) {
    console.warn("[agent-summoner] setModeIndicator called before ui registered — update deferred");
    return;
  }
  ui.setWidget(MODE_KEY, createRenderer(), { placement: "aboveEditor" });
  registered = true;
}

/** Update the current planning phase shown in the indicator. */
export function setPlanPhase(phase: PlanPhase): void {
  if (currentMode !== "plan") return;
  currentPhase = phase;
  if (!ui) return;
  ui.setWidget(MODE_KEY, createRenderer(), { placement: "aboveEditor" });
  registered = true;
}

/** Register the mode indicator widget. Call once per session. */
export function registerModeIndicator(ctx: ExtensionUIContext, mode: "plan" | "crafting"): void {
  currentMode = mode;
  ui = ctx;
  registered = true;
  ui.setWidget(MODE_KEY, createRenderer(), { placement: "aboveEditor" });
}

/** Get current mode for external sync. */
export function getCurrentMode(): "plan" | "crafting" {
  return currentMode;
}

/** Unregister (cleanup). */
export function unregisterModeIndicator(): void {
  if (ui && registered) {
    ui.setWidget(MODE_KEY, undefined);
    registered = false;
  }
  ui = undefined;
}

const PHASE_DISPLAY: Record<NonNullable<PlanPhase>, { icon: string; label: string }> = {
  analyzing: { icon: "🔍", label: "Analyzing" },
  designing: { icon: "🏗️", label: "Designing" },
  breakdown: { icon: "📋", label: "Task Breakdown" },
};

function createRenderer() {
  return (_tui: any, theme: Theme) => {
    const isPlan = currentMode === "plan";

    if (isPlan && currentPhase) {
      const phase = PHASE_DISPLAY[currentPhase];
      const line = `${phase.icon} ${theme.fg("accent", phase.label)}  ${theme.fg("dim", "— plan mode")}`;
      return {
        render: (_w: number) => [line],
        invalidate: () => { registered = false; },
      };
    }

    const icon = isPlan ? "🔮" : "⚡";
    const label = isPlan ? "Plan in session" : "Craft in session";
    const dim = theme.fg("dim", isPlan ? "— analysis & planning only" : "— crafting mode");
    const line = `${icon} ${theme.fg("accent", label)}  ${dim}`;

    return {
      render: (_w: number) => [line],
      invalidate: () => { registered = false; },
    };
  };
}
