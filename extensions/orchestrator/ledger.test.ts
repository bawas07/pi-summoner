/**
 * ledger.test.ts — Unit tests for the Ledger module.
 *
 * Covers: setFileStatus, isPhaseComplete, canStartPhase,
 * populateFromPlan, replayFromEntries, resetLedger.
 *
 * @see docs/plan.md Task 0.2
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";

import {
  getLedger,
  getFileEntry,
  getFilesByPhase,
  isPhaseComplete,
  allPhasesComplete,
  canStartPhase,
  getPendingFiles,
  setFileStatus,
  populateFromPlan,
  replayFromEntries,
  resetLedger,
} from "./ledger";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a mock ledger-update entry as pi.appendEntry would produce. */
function ledgerEntry(path: string, entry: Record<string, unknown>) {
  return {
    type: "custom",
    customType: "ledger-update",
    data: { path, ...entry },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Ledger", () => {
  beforeEach(() => {
    resetLedger();
  });

  // ── setFileStatus ──────────────────────────────────────────────────────

  describe("setFileStatus", () => {
    it("should create a new entry when file path is unknown", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "in_progress", owner: "crafter-1" });

      const entry = getFileEntry("src/a.ts");
      assert.ok(entry);
      assert.equal(entry!.status, "in_progress");
      assert.equal(entry!.phase, 1);
      assert.equal(entry!.owner, "crafter-1");
    });

    it("should merge with existing entry (partial update)", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "pending" });
      setFileStatus("src/a.ts", { status: "in_progress", owner: "crafter-1" });

      const entry = getFileEntry("src/a.ts")!;
      assert.equal(entry.status, "in_progress");
      assert.equal(entry.phase, 1); // unchanged from first call
      assert.equal(entry.owner, "crafter-1");
    });

    it("should track the full lifecycle: pending → in_progress → done", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "pending" });
      assert.equal(getFileEntry("src/a.ts")!.status, "pending");

      setFileStatus("src/a.ts", { status: "in_progress", owner: "crafter-1" });
      assert.equal(getFileEntry("src/a.ts")!.status, "in_progress");

      setFileStatus("src/a.ts", { status: "done", summary: "updated" });
      const entry = getFileEntry("src/a.ts")!;
      assert.equal(entry.status, "done");
      assert.equal(entry.summary, "updated");
      assert.equal(entry.owner, "crafter-1"); // preserved
    });

    it("should mark discovered files", () => {
      setFileStatus("src/unplanned.ts", {
        phase: 1,
        status: "in_progress",
        owner: "crafter-1",
        discovered: true,
      });

      const entry = getFileEntry("src/unplanned.ts")!;
      assert.equal(entry.discovered, true);
    });
  });

  // ── getFilesByPhase ────────────────────────────────────────────────────

  describe("getFilesByPhase", () => {
    it("should return only files in the requested phase", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "pending" });
      setFileStatus("src/b.ts", { phase: 1, status: "pending" });
      setFileStatus("src/c.ts", { phase: 2, status: "pending" });
      setFileStatus("src/d.ts", { phase: 0, status: "pending" });

      const phase1 = getFilesByPhase(1);
      assert.equal(phase1.length, 2);
      assert.ok(phase1.some(([p]) => p === "src/a.ts"));
      assert.ok(phase1.some(([p]) => p === "src/b.ts"));

      const phase2 = getFilesByPhase(2);
      assert.equal(phase2.length, 1);
      assert.equal(phase2[0][0], "src/c.ts");

      const phase0 = getFilesByPhase(0);
      assert.equal(phase0.length, 1);
    });

    it("should return empty array for phase with no files", () => {
      const result = getFilesByPhase(99);
      assert.equal(result.length, 0);
    });
  });

  // ── isPhaseComplete ────────────────────────────────────────────────────

  describe("isPhaseComplete", () => {
    it("should return true when all files in phase are done", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done" });
      setFileStatus("src/b.ts", { phase: 1, status: "done" });

      assert.equal(isPhaseComplete(1), true);
    });

    it("should return false when any file in phase is not done", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done" });
      setFileStatus("src/b.ts", { phase: 1, status: "in_progress" });

      assert.equal(isPhaseComplete(1), false);
    });

    it("should return false when any file is still pending", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "pending" });

      assert.equal(isPhaseComplete(1), false);
    });

    it("should return false when a file is blocked", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "blocked" });

      assert.equal(isPhaseComplete(1), false);
    });

    it("should return true for an empty phase (no files)", () => {
      assert.equal(isPhaseComplete(42), true);
    });
  });

  // ── canStartPhase ──────────────────────────────────────────────────────

  describe("canStartPhase", () => {
    it("should allow phase 0 (nothing before it)", () => {
      assert.equal(canStartPhase(0), true);
    });

    it("should block phase 2 when phase 1 is not complete", () => {
      populateFromPlan(
        [
          { path: "src/a.ts", phase: 1 },
          { path: "src/b.ts", phase: 2 },
        ],
        3,
      );

      // Phase 1 still pending
      assert.equal(canStartPhase(2), false);
    });

    it("should allow phase 2 when all prior phases are done", () => {
      populateFromPlan(
        [
          { path: "src/a.ts", phase: 1 },
          { path: "src/b.ts", phase: 2 },
        ],
        3,
      );

      setFileStatus("src/a.ts", { status: "done" });

      assert.equal(canStartPhase(2), true);
    });

    it("should check ALL prior phases, not just the immediate one", () => {
      populateFromPlan(
        [
          { path: "src/a.ts", phase: 0 },
          { path: "src/b.ts", phase: 1 },
          { path: "src/c.ts", phase: 2 },
        ],
        3,
      );

      // Phase 0 done, Phase 1 still pending
      setFileStatus("src/a.ts", { status: "done" });
      assert.equal(canStartPhase(2), false);

      // Both prior phases done
      setFileStatus("src/b.ts", { status: "done" });
      assert.equal(canStartPhase(2), true);
    });
  });

  // ── allPhasesComplete ──────────────────────────────────────────────────

  describe("allPhasesComplete", () => {
    it("should return true when all phases are done", () => {
      populateFromPlan(
        [
          { path: "src/a.ts", phase: 0 },
          { path: "src/b.ts", phase: 1 },
        ],
        2,
      );

      setFileStatus("src/a.ts", { status: "done" });
      setFileStatus("src/b.ts", { status: "done" });

      assert.equal(allPhasesComplete(), true);
    });

    it("should return false when any phase is incomplete", () => {
      populateFromPlan(
        [
          { path: "src/a.ts", phase: 0 },
          { path: "src/b.ts", phase: 1 },
        ],
        2,
      );

      setFileStatus("src/a.ts", { status: "done" });
      // b.ts still pending

      assert.equal(allPhasesComplete(), false);
    });
  });

  // ── getPendingFiles ────────────────────────────────────────────────────

  describe("getPendingFiles", () => {
    it("should return only non-done files", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done" });
      setFileStatus("src/b.ts", { phase: 1, status: "in_progress" });
      setFileStatus("src/c.ts", { phase: 2, status: "pending" });
      setFileStatus("src/d.ts", { phase: 2, status: "blocked" });

      const pending = getPendingFiles();
      assert.equal(pending.length, 3);
      const paths = pending.map(([p]) => p);
      assert.ok(paths.includes("src/b.ts"));
      assert.ok(paths.includes("src/c.ts"));
      assert.ok(paths.includes("src/d.ts"));
      assert.ok(!paths.includes("src/a.ts"));
    });
  });

  // ── populateFromPlan ───────────────────────────────────────────────────

  describe("populateFromPlan", () => {
    it("should populate all plan files as pending", () => {
      populateFromPlan(
        [
          { path: "lib/api.ts", phase: 1 },
          { path: "dashboard.ts", phase: 2 },
          { path: "settings.ts", phase: 2 },
        ],
        3,
      );

      const state = getLedger();
      assert.equal(state.totalPhases, 3);
      assert.equal(Object.keys(state.files).length, 3);
      assert.equal(state.files["lib/api.ts"].status, "pending");
      assert.equal(state.files["lib/api.ts"].phase, 1);
      assert.equal(state.files["dashboard.ts"].phase, 2);
      assert.equal(state.files["settings.ts"].phase, 2);
      assert.equal(state.files["dashboard.ts"].owner, null);
    });

    it("should overwrite existing Ledger state", () => {
      setFileStatus("old.ts", { phase: 0, status: "done" });

      populateFromPlan([{ path: "new.ts", phase: 1 }], 2);

      const state = getLedger();
      assert.equal(Object.keys(state.files).length, 1);
      assert.equal(state.files["old.ts"], undefined);
      assert.ok(state.files["new.ts"]);
    });
  });

  // ── replayFromEntries ──────────────────────────────────────────────────

  describe("replayFromEntries", () => {
    it("should rebuild Ledger from persisted entries", () => {
      const entries = [
        ledgerEntry("src/a.ts", { status: "done", phase: 1, owner: "crafter-1" }),
        ledgerEntry("src/b.ts", { status: "done", phase: 2, owner: "crafter-2" }),
      ];

      replayFromEntries(entries);

      const state = getLedger();
      assert.equal(Object.keys(state.files).length, 2);
      assert.equal(state.files["src/a.ts"].status, "done");
      assert.equal(state.files["src/b.ts"].owner, "crafter-2");
      assert.equal(state.totalPhases, 3); // max phase 2 + 1
    });

    it("should use latest-wins for duplicate paths", () => {
      const entries = [
        ledgerEntry("src/a.ts", { status: "pending", phase: 1 }),
        ledgerEntry("src/a.ts", { status: "in_progress", phase: 1 }),
        ledgerEntry("src/a.ts", { status: "done", phase: 1 }),
      ];

      replayFromEntries(entries);

      // Latest entry wins
      assert.equal(getFileEntry("src/a.ts")!.status, "done");
    });

    it("should handle entries in any order (latest-wins per path)", () => {
      // Later entries override earlier ones for the same path
      const entries = [
        ledgerEntry("src/a.ts", { status: "done", phase: 1 }),
        ledgerEntry("src/a.ts", { status: "pending", phase: 1 }), // later → wins
      ];

      replayFromEntries(entries);

      assert.equal(getFileEntry("src/a.ts")!.status, "pending");
    });

    it("should skip non-ledger-update entries", () => {
      const entries = [
        { type: "message", data: {} },
        ledgerEntry("src/a.ts", { status: "done", phase: 1 }),
        { type: "custom", customType: "other-thing", data: {} },
      ];

      replayFromEntries(entries);

      assert.equal(Object.keys(getLedger().files).length, 1);
      assert.equal(getFileEntry("src/a.ts")!.status, "done");
    });

    it("should skip entries with missing data", () => {
      const entries = [
        { type: "custom", customType: "ledger-update" }, // no data
        { type: "custom", customType: "ledger-update", data: {} }, // no path
        ledgerEntry("src/a.ts", { status: "done", phase: 1 }),
      ];

      replayFromEntries(entries);

      // Should not crash; only valid entries processed
      assert.equal(Object.keys(getLedger().files).length, 1);
    });

    it("should determine currentPhase from first incomplete phase", () => {
      const entries = [
        ledgerEntry("src/a.ts", { status: "done", phase: 0 }),
        ledgerEntry("src/b.ts", { status: "done", phase: 1 }),
        ledgerEntry("src/c.ts", { status: "pending", phase: 2 }),
      ];

      replayFromEntries(entries);

      assert.equal(getLedger().currentPhase, 2);
    });

    it("should set currentPhase to totalPhases when all complete", () => {
      const entries = [
        ledgerEntry("src/a.ts", { status: "done", phase: 0 }),
        ledgerEntry("src/b.ts", { status: "done", phase: 1 }),
      ];

      replayFromEntries(entries);

      assert.equal(getLedger().currentPhase, 2);
      assert.equal(getLedger().totalPhases, 2);
    });
  });

  // ── resetLedger ────────────────────────────────────────────────────────

  describe("resetLedger", () => {
    it("should clear all state", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done" });
      assert.equal(Object.keys(getLedger().files).length, 1);

      resetLedger();

      assert.equal(Object.keys(getLedger().files).length, 0);
      assert.equal(getLedger().totalPhases, 0);
      assert.equal(getLedger().currentPhase, 0);
    });
  });
});
