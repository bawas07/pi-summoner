/**
 * gatekeeper.test.ts — Unit tests for Gatekeeper pure logic.
 *
 * Covers: classifyFailures, decideAction, parseTestOutput, detectTestCommand.
 *
 * Test execution (execSync) not tested — integration tests in Phase 8.
 *
 * @see docs/plan.md Phase 4
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  classifyFailures,
  decideAction,
  parseTestOutput,
  detectTestCommand,
} from "./gatekeeper";
import type { TestFailure, BaselineEntry } from "./gatekeeper";

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Gatekeeper", () => {
  describe("classifyFailures", () => {
    it("should classify in-scope failures (file in Ledger)", () => {
      const failures: TestFailure[] = [
        { file: "src/app.ts:10:5", testName: "should render", message: "expected true" },
      ];
      const baseline: BaselineEntry[] = [];
      const ledger = { "src/app.ts": { status: "done" } };

      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result.length, 1);
      assert.equal(result[0].category, "in-scope");
    });

    it("should classify out-of-scope-new (not in Ledger, passing in baseline)", () => {
      const failures: TestFailure[] = [
        { file: "src/untouched.ts:5:1", testName: "should work", message: "broken" },
      ];
      const baseline: BaselineEntry[] = [
        { file: "src/untouched.ts", passing: true },
      ];
      const ledger = { "src/app.ts": { status: "done" } };

      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result.length, 1);
      assert.equal(result[0].category, "out-of-scope-new");
    });

    it("should classify out-of-scope-pre-existing (not in Ledger, failing in baseline)", () => {
      const failures: TestFailure[] = [
        { file: "src/old-bug.ts:20:3", testName: "known issue", message: "fails" },
      ];
      const baseline: BaselineEntry[] = [
        { file: "src/old-bug.ts", passing: false },
      ];
      const ledger = { "src/app.ts": { status: "done" } };

      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result.length, 1);
      assert.equal(result[0].category, "out-of-scope-pre-existing");
    });

    it("should treat missing baseline as out-of-scope-new (conservative)", () => {
      const failures: TestFailure[] = [
        { file: "src/unknown.ts:1:1", testName: "mystery", message: "fail" },
      ];
      const baseline: BaselineEntry[] = [];
      const ledger = {};

      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result.length, 1);
      assert.equal(result[0].category, "out-of-scope-new");
    });

    it("should handle multiple failures with mixed categories", () => {
      const failures: TestFailure[] = [
        { file: "src/app.ts:10:5", testName: "render test", message: "fail" },
        { file: "src/other.ts:5:1", testName: "other test", message: "fail" },
        { file: "src/old.ts:20:3", testName: "old test", message: "fail" },
      ];
      const baseline: BaselineEntry[] = [
        { file: "src/other.ts", passing: true },
        { file: "src/old.ts", passing: false },
      ];
      const ledger = { "src/app.ts": { status: "done" } };

      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result.length, 3);
      assert.equal(result[0].category, "in-scope");
      assert.equal(result[1].category, "out-of-scope-new");
      assert.equal(result[2].category, "out-of-scope-pre-existing");
    });

    it("should normalize file paths (strip line numbers)", () => {
      const failures: TestFailure[] = [
        { file: "src/app.ts:42:10", testName: "test", message: "fail" },
      ];
      const ledger = { "src/app.ts": { status: "done" } };
      const baseline: BaselineEntry[] = [];

      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result[0].category, "in-scope");
    });

    it("should not match test files against source files (different paths)", () => {
      const failures: TestFailure[] = [
        { file: "/home/user/project/src/app.test.ts:5:1", testName: "test", message: "fail" },
      ];
      const ledger = { "src/app.ts": { status: "done" } };
      const baseline: BaselineEntry[] = [{ file: "src/app.test.ts", passing: true }];

      // Test file "app.test.ts" is NOT the same as source "app.ts"
      // If the test file was passing in baseline and is failing now → out-of-scope-new
      const result = classifyFailures(failures, baseline, ledger);

      assert.equal(result[0].category, "out-of-scope-new");
    });
  });

  describe("decideAction", () => {
    it("should auto-fix in-scope failures in trust mode", () => {
      const classified = [
        { file: "src/a.ts", testName: "t1", message: "fail", category: "in-scope" as const },
      ];

      const actions = decideAction(classified, "trust");

      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, "auto-fix");
    });

    it("should ask user for in-scope failures in checkpoint mode", () => {
      const classified = [
        { file: "src/a.ts", testName: "t1", message: "fail", category: "in-scope" as const },
      ];

      const actions = decideAction(classified, "checkpoint");

      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, "ask-user");
    });

    it("should always ask for out-of-scope failures regardless of trust mode", () => {
      const classified = [
        { file: "src/b.ts", testName: "t2", message: "fail", category: "out-of-scope-new" as const },
      ];

      const trustActions = decideAction(classified, "trust");
      const checkpointActions = decideAction(classified, "checkpoint");

      assert.equal(trustActions[0].type, "ask-user");
      assert.equal(checkpointActions[0].type, "ask-user");
    });

    it("should return separate actions for in-scope and out-of-scope failures", () => {
      const classified = [
        { file: "src/a.ts", testName: "t1", message: "fail", category: "in-scope" as const },
        { file: "src/b.ts", testName: "t2", message: "fail", category: "out-of-scope-new" as const },
      ];

      const actions = decideAction(classified, "trust");

      // One auto-fix (in-scope), one ask-user (out-of-scope)
      assert.equal(actions.length, 2);
      assert.equal(actions[0].type, "auto-fix");
      assert.equal(actions[1].type, "ask-user");
    });

    it("should return empty actions when no failures", () => {
      const actions = decideAction([], "trust");
      assert.equal(actions.length, 0);
    });

    it("should group pre-existing out-of-scope correctly", () => {
      const classified = [
        { file: "src/c.ts", testName: "t3", message: "fail", category: "out-of-scope-pre-existing" as const },
      ];

      const actions = decideAction(classified, "trust");

      assert.equal(actions.length, 1);
      assert.equal(actions[0].type, "ask-user");
    });
  });

  describe("parseTestOutput", () => {
    it("should parse node:test summary lines", () => {
      const output = "ℹ tests 42\nℹ pass 38\nℹ fail 4\nℹ duration_ms 1234";

      const result = parseTestOutput(output);

      assert.equal(result.total, 42);
      assert.equal(result.passed, 38);
      assert.equal(result.failed, 4);
    });

    it("should return zero counts for empty output", () => {
      const result = parseTestOutput("");

      assert.equal(result.total, 0);
      assert.equal(result.passed, 0);
      assert.equal(result.failed, 0);
    });
  });

  describe("detectTestCommand", () => {
    it("should return npm test by default", () => {
      const result = detectTestCommand("/nonexistent/path");
      assert.equal(result.command, "npm test");
    });
  });
});
