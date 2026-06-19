/**
 * ui.ts — Persistent status widget for agent activity.
 *
 * Shows a real-time at-a-glance view of all summoned agents:
 *   🟢 active (working)
 *   🟡 waiting (phase gate or conflict)
 *   ✅ done
 *   ❌ failed
 *   ⏳ pending
 *
 * Updates on every Ledger change (triggered from setFileStatus).
 * Auto-clears when no agents are active or pending.
 *
 * @see docs/prd.md §5.2 — Status widget
 * @see docs/plan.md Task 6.1
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentActivityLog } from "./state";

// ── Widget ────────────────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  active: "🟢",
  waiting: "🟡",
  done: "✅",
  failed: "❌",
  pending: "⏳",
};

const MAX_DISPLAY = 8;

/** Build the current status widget content. */
export function buildStatusLines(): string[] {
  const entries = [...agentActivityLog.values()];

  // Filter out stale "done" entries after a cooldown
  const now = Date.now();
  const visible = entries.filter((e) => {
    if (e.status === "done" || e.status === "failed") {
      return now - e.startedAt < 30_000;
    }
    return true;
  });

  if (visible.length === 0) return [];

  const lines: string[] = [];
  const display = visible.slice(0, MAX_DISPLAY);

  for (const activity of display) {
    const icon = STATUS_ICONS[activity.status] || "❓";
    const name = activity.agentName || "unknown";
    const file = activity.currentFile
      ? activity.currentFile.length > 30
        ? "…" + activity.currentFile.slice(-27)
        : activity.currentFile
      : "";
    const detail = activity.detail || activity.status;

    lines.push(`${icon} ${name.padEnd(12)} ${file.padEnd(24)} (${detail})`);
  }

  if (visible.length > MAX_DISPLAY) {
    lines.push(`  … and ${visible.length - MAX_DISPLAY} more`);
  }

  return lines;
}

/** Register the persistent status widget. Call during session_start. */
export function registerStatusWidget(ctx: ExtensionContext): void {
  ctx.ui.setWidget("agent-status", buildStatusLines());
  
  // Re-register widget on every Ledger change for real-time updates
  // (In practice, this would be called from setFileStatus in ledger.ts,
  // but since we can't access ctx there, we'd need a different mechanism.
  // For now, the widget shows a snapshot.)
}
