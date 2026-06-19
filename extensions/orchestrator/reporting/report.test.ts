/**
 * report.test.ts — Unit tests for report generation.
 *
 * @see docs/plan.md Phase 5
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { buildReportData, formatReport, attachTestResults } from "./report";
import { resetLedger, setFileStatus } from "../core/ledger";

describe("Report", () => {
  beforeEach(() => {
    resetLedger();
  });

  describe("buildReportData", () => {
    it("should group files by phase", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done", owner: "c1", summary: "updated" });
      setFileStatus("src/b.ts", { phase: 1, status: "done", owner: "c2" });
      setFileStatus("src/c.ts", { phase: 2, status: "pending", owner: null });

      const data = buildReportData();

      assert.equal(data.sections.length, 2);
      assert.equal(data.sections[0].phase, 1);
      assert.equal(data.sections[0].files.length, 2);
      assert.equal(data.sections[1].phase, 2);
      assert.equal(data.sections[1].files.length, 1);
      assert.equal(data.totalFiles, 3);
      assert.equal(data.completedFiles, 2);
    });

    it("should track unplanned discoveries", () => {
      setFileStatus("src/planned.ts", { phase: 1, status: "done" });
      setFileStatus("src/found.ts", { phase: 1, status: "done", discovered: true });

      const data = buildReportData();

      assert.equal(data.unplannedFiles.length, 1);
      assert.equal(data.unplannedFiles[0], "src/found.ts");
    });

    it("should handle empty Ledger", () => {
      const data = buildReportData();

      assert.equal(data.sections.length, 0);
      assert.equal(data.totalFiles, 0);
      assert.equal(data.completedFiles, 0);
      assert.equal(data.unplannedFiles.length, 0);
    });

    it("should label phase 0 as Dependency Installation", () => {
      setFileStatus("package.json", { phase: 0, status: "done" });

      const data = buildReportData();

      assert.equal(data.sections[0].label, "Dependency Installation");
    });
  });

  describe("formatReport", () => {
    it("should produce markdown with all sections", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done", owner: "c1", summary: "updated API" });
      setFileStatus("src/b.ts", { phase: 1, status: "pending", owner: null });
      setFileStatus("src/found.ts", { phase: 1, status: "done", discovered: true });

      const data = buildReportData();
      const report = formatReport(data);

      assert.ok(report.includes("Task Report"));
      assert.ok(report.includes("src/a.ts"));
      assert.ok(report.includes("updated API"));
      assert.ok(report.includes("unplanned"));
      assert.ok(report.includes("Unplanned Discoveries"));
    });

    it("should include test results when attached", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done" });

      let data = buildReportData();
      data = attachTestResults(data, {
        total: 10,
        passed: 9,
        failed: 1,
        failures: [
          { file: "test/a.test.ts", testName: "broken test", message: "assertion", category: "out-of-scope-new" },
        ],
        actions: [
          { type: "ask-user", failures: [{ file: "test/a.test.ts", testName: "broken test", message: "assertion", category: "out-of-scope-new" }], reason: "out-of-scope" },
        ],
      });

      const report = formatReport(data);

      assert.ok(report.includes("Test Results"));
      assert.ok(report.includes("9/10"));
      assert.ok(report.includes("broken test"));
      assert.ok(report.includes("Needs approval"));
    });

    it("should show all-clear when all tests pass", () => {
      setFileStatus("src/a.ts", { phase: 1, status: "done" });

      let data = buildReportData();
      data = attachTestResults(data, {
        total: 10,
        passed: 10,
        failed: 0,
        failures: [],
        actions: [],
      });

      const report = formatReport(data);

      assert.ok(report.includes("All tests passing"));
    });

    it("should show correct status icons", () => {
      setFileStatus("src/done.ts", { phase: 1, status: "done" });
      setFileStatus("src/pending.ts", { phase: 1, status: "pending" });
      setFileStatus("src/inprog.ts", { phase: 1, status: "in_progress" });
      setFileStatus("src/blocked.ts", { phase: 1, status: "blocked" });
      setFileStatus("src/failed.ts", { phase: 1, status: "failed" });

      const data = buildReportData();
      const report = formatReport(data);

      assert.ok(report.includes("✅"));
      assert.ok(report.includes("⏳"));
      assert.ok(report.includes("🟢"));
      assert.ok(report.includes("🟡"));
      assert.ok(report.includes("❌"));
    });
  });
});
