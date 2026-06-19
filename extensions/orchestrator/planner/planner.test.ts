/**
 * planner.test.ts — Unit tests for topological sort and plan building.
 *
 * Covers: linear chains, diamond patterns, isolated files, cycles,
 * Phase 0 prepending, and plan formatting.
 *
 * @see docs/plan.md Phase 2
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPhases, buildPlan, formatPlan, approvePlan } from "./planner";
import { getLedger, resetLedger } from "../core/ledger";
import type { DependencyGraph } from "../scout/scout";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a minimal graph node. */
function node(
  imports: string[] = [],
  importedBy: string[] = [],
  exports: string[] = [],
) {
  return { exports, imports, importedBy };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Planner", () => {
  describe("buildPhases", () => {
    it("should handle empty graph", () => {
      const result = buildPhases({});
      assert.equal(result.phases.length, 0);
      assert.equal(result.cycles.length, 0);
    });

    it("should put isolated files into a single phase", () => {
      // A, B, C — no dependencies between them
      const graph: DependencyGraph = {
        "a.ts": node(),
        "b.ts": node(),
        "c.ts": node(),
      };

      const { phases, cycles } = buildPhases(graph);

      assert.equal(phases.length, 1);
      assert.equal(phases[0].files.length, 3);
      assert.equal(phases[0].parallelSafe, true);
      assert.equal(cycles.length, 0);
    });

    it("should create sequential phases for linear dependency (A→B→C)", () => {
      // B imports A, C imports B
      const graph: DependencyGraph = {
        "a.ts": node([], ["b.ts"]),
        "b.ts": node(["a.ts"], ["c.ts"]),
        "c.ts": node(["b.ts"], []),
      };

      const { phases, cycles } = buildPhases(graph);

      assert.equal(phases.length, 3);
      assert.equal(cycles.length, 0);

      // Phase 1: a.ts (no deps)
      assert.deepStrictEqual(phases[0].files, ["a.ts"]);

      // Phase 2: b.ts (depends on a)
      assert.deepStrictEqual(phases[1].files, ["b.ts"]);

      // Phase 3: c.ts (depends on b)
      assert.deepStrictEqual(phases[2].files, ["c.ts"]);
    });

    it("should group parallel-safe files in same phase (diamond: A→B, A→C)", () => {
      // B and C both import A, but not each other → same phase
      const graph: DependencyGraph = {
        "a.ts": node([], ["b.ts", "c.ts"]),
        "b.ts": node(["a.ts"], []),
        "c.ts": node(["a.ts"], []),
      };

      const { phases, cycles } = buildPhases(graph);

      assert.equal(phases.length, 2);
      assert.equal(cycles.length, 0);

      // Phase 1: a.ts
      assert.deepStrictEqual(phases[0].files, ["a.ts"]);

      // Phase 2: b.ts + c.ts (parallel-safe)
      assert.deepStrictEqual(phases[1].files.sort(), ["b.ts", "c.ts"].sort());
    });

    it("should handle multi-level dependency chain (A→B→C, A→D)", () => {
      // B imports A, C imports B, D imports A
      const graph: DependencyGraph = {
        "a.ts": node([], ["b.ts", "d.ts"]),
        "b.ts": node(["a.ts"], ["c.ts"]),
        "c.ts": node(["b.ts"], []),
        "d.ts": node(["a.ts"], []),
      };

      const { phases, cycles } = buildPhases(graph);

      // Phase 1: a.ts
      // Phase 2: b.ts + d.ts (both depend only on a)
      // Phase 3: c.ts (depends on b)
      assert.equal(phases.length, 3);
      assert.equal(cycles.length, 0);

      assert.deepStrictEqual(phases[0].files, ["a.ts"]);
      assert.deepStrictEqual(phases[1].files.sort(), ["b.ts", "d.ts"].sort());
      assert.deepStrictEqual(phases[2].files, ["c.ts"]);
    });

    it("should detect and break cycles (A↔B)", () => {
      // A imports B, B imports A → cycle
      const graph: DependencyGraph = {
        "a.ts": node(["b.ts"], ["b.ts"]),
        "b.ts": node(["a.ts"], ["a.ts"]),
      };

      const { phases, cycles } = buildPhases(graph);

      // Should complete without infinite loop
      assert.ok(phases.length > 0);
      assert.ok(cycles.length > 0, "Cycle should be detected");
    });

    it("should handle files with external imports (not in graph)", () => {
      // A imports an external package (not in graph) → in-degree unaffected
      const graph: DependencyGraph = {
        "a.ts": node(["external-lib"], []),
        "b.ts": node([], []),
      };

      const { phases, cycles } = buildPhases(graph);

      assert.equal(phases.length, 1);
      assert.equal(cycles.length, 0);
      // Both files have in-degree 0 (external-lib not in graph)
      assert.equal(phases[0].files.length, 2);
    });
  });

  describe("buildPlan", () => {
    it("should build a plan with risks for low confidence", () => {
      const graph: DependencyGraph = {
        "a.ts": node(),
      };

      const plan = buildPlan(graph, "low");

      assert.equal(plan.confidence, "low");
      assert.ok(plan.risks.length > 0);
      assert.ok(plan.risks.some((r) => r.includes("LOW")));
      assert.equal(plan.hasPhase0, false);
    });

    it("should build a plan without risks for high confidence", () => {
      const graph: DependencyGraph = {
        "a.ts": node(),
      };

      const plan = buildPlan(graph, "high");

      assert.equal(plan.confidence, "high");
      assert.equal(plan.risks.length, 0);
    });

    it("should prepend Phase 0 when needsDeps is true", () => {
      const graph: DependencyGraph = {
        "a.ts": node([], ["b.ts"]),
        "b.ts": node(["a.ts"], []),
      };

      const plan = buildPlan(graph, "high", true);

      assert.equal(plan.hasPhase0, true);
      assert.equal(plan.phases[0].label, "Dependency Installation");
      assert.equal(plan.phases[0].phaseNumber, 0);
      // Original phases renumbered to 1, 2
      assert.equal(plan.phases[1].phaseNumber, 1);
      assert.equal(plan.phases[2].phaseNumber, 2);
    });

    it("should include cycle info in risks", () => {
      const graph: DependencyGraph = {
        "a.ts": node(["b.ts"], ["b.ts"]),
        "b.ts": node(["a.ts"], ["a.ts"]),
      };

      const plan = buildPlan(graph, "high");

      assert.ok(plan.cycles.length > 0);
      assert.ok(plan.risks.some((r) => r.includes("circular")));
    });
  });

  describe("formatPlan", () => {
    it("should produce human-readable output", () => {
      const graph: DependencyGraph = {
        "a.ts": node([], ["b.ts"]),
        "b.ts": node(["a.ts"], []),
      };

      const plan = buildPlan(graph, "high");
      const formatted = formatPlan(plan);

      assert.ok(formatted.includes("Execution Plan"));
      assert.ok(formatted.includes("a.ts"));
      assert.ok(formatted.includes("b.ts"));
      assert.ok(formatted.includes("parallel-safe"));
      assert.ok(formatted.includes("high"));
    });

    it("should include risk section when risks exist", () => {
      const graph: DependencyGraph = {
        "a.ts": node(["b.ts"], ["b.ts"]),
        "b.ts": node(["a.ts"], ["a.ts"]),
      };

      const plan = buildPlan(graph, "high");
      const formatted = formatPlan(plan);

      assert.ok(formatted.includes("⚠️ Risks"));
    });
  });

  describe("approvePlan", () => {
    it("should populate Ledger with planned files as pending", () => {
      resetLedger();

      const graph: DependencyGraph = {
        "lib/api.ts": node([], ["dashboard.ts", "settings.ts"]),
        "dashboard.ts": node(["lib/api.ts"], []),
        "settings.ts": node(["lib/api.ts"], []),
      };

      const plan = buildPlan(graph, "high");
      approvePlan(plan);

      const ledger = getLedger();
      assert.equal(Object.keys(ledger.files).length, 3);
      assert.equal(ledger.files["lib/api.ts"].status, "pending");
      assert.equal(ledger.files["dashboard.ts"].status, "pending");
      assert.equal(ledger.files["settings.ts"].status, "pending");
      // Phase 0 not present (no deps)
      assert.equal(ledger.totalPhases, 2);
    });

    it("should skip Phase 0 synthetic marker", () => {
      resetLedger();

      const graph: DependencyGraph = {
        "a.ts": node(),
      };

      const plan = buildPlan(graph, "high", true);
      approvePlan(plan);

      const ledger = getLedger();
      // Only real files, not the "[Dependency Installation]" marker
      assert.equal(Object.keys(ledger.files).length, 1);
      assert.ok(ledger.files["a.ts"]);
    });
  });
});
