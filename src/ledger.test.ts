/**
 * Unit tests for ledger.ts — file touch tracking.
 *
 * Tests record, query, and the read-only consumer contract.
 * Uses resetLedger() between tests to avoid state leakage (per test-making skill:
 * "Shared mutable state between tests — always reset").
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  recordTouch,
  recordTouches,
  resetLedger,
  getLedgerSnapshot,
  getEntriesByAgent,
  getTouchedFiles,
  isFileTouched,
} from "./ledger";

// ---- Setup ----

beforeEach(() => {
  resetLedger();
});

// ---- Record ----

describe("ledger — recordTouch", () => {
  it("should add a single entry to the ledger", () => {
    recordTouch("src/auth/login.ts", "crafter-1", "write");

    const snapshot = getLedgerSnapshot();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].file, "src/auth/login.ts");
    assert.equal(snapshot[0].agent, "crafter-1");
    assert.equal(snapshot[0].action, "write");
    assert.ok(typeof snapshot[0].timestamp === "number");
  });

  it("should set timestamp to current time", () => {
    const before = Date.now();
    recordTouch("src/auth/login.ts", "crafter-1", "write");
    const after = Date.now();

    const snapshot = getLedgerSnapshot();
    assert.ok(snapshot[0].timestamp >= before);
    assert.ok(snapshot[0].timestamp <= after);
  });

  it("should support all action types", () => {
    recordTouch("file1.ts", "scout-1", "read");
    recordTouch("file2.ts", "crafter-1", "write");
    recordTouch("file3.ts", "crafter-2", "delete");

    const snapshot = getLedgerSnapshot();
    assert.equal(snapshot.length, 3);
    assert.equal(snapshot[0].action, "read");
    assert.equal(snapshot[1].action, "write");
    assert.equal(snapshot[2].action, "delete");
  });
});

describe("ledger — recordTouches", () => {
  it("should add multiple entries for a list of files", () => {
    recordTouches(
      ["src/auth/login.ts", "src/auth/logout.ts", "src/auth/middleware.ts"],
      "crafter-1",
      "write",
    );

    const snapshot = getLedgerSnapshot();
    assert.equal(snapshot.length, 3);
    assert.equal(snapshot[0].file, "src/auth/login.ts");
    assert.equal(snapshot[1].file, "src/auth/logout.ts");
    assert.equal(snapshot[2].file, "src/auth/middleware.ts");
  });

  it("should assign same timestamp to all files in a batch", () => {
    recordTouches(["file1.ts", "file2.ts"], "crafter-1", "write");

    const snapshot = getLedgerSnapshot();
    assert.equal(snapshot[0].timestamp, snapshot[1].timestamp);
  });

  it("should handle empty array", () => {
    recordTouches([], "scout-1", "read");
    assert.equal(getLedgerSnapshot().length, 0);
  });
});

// ---- Query ----

describe("ledger — getEntriesByAgent", () => {
  it("should return entries filtered by agent id", () => {
    recordTouch("file1.ts", "crafter-1", "write");
    recordTouch("file2.ts", "crafter-1", "write");
    recordTouch("file3.ts", "scout-1", "read");

    const crafterEntries = getEntriesByAgent("crafter-1");
    assert.equal(crafterEntries.length, 2);
    assert.equal(crafterEntries[0].agent, "crafter-1");
    assert.equal(crafterEntries[1].agent, "crafter-1");
  });

  it("should return empty array for unknown agent", () => {
    const entries = getEntriesByAgent("nonexistent");
    assert.equal(entries.length, 0);
  });
});

describe("ledger — getTouchedFiles", () => {
  it("should return unique file paths", () => {
    recordTouch("file1.ts", "crafter-1", "write");
    recordTouch("file1.ts", "crafter-2", "read"); // same file, different agent
    recordTouch("file2.ts", "scout-1", "read");

    const files = getTouchedFiles();
    assert.equal(files.length, 2);
    assert.ok(files.includes("file1.ts"));
    assert.ok(files.includes("file2.ts"));
  });

  it("should return empty array for empty ledger", () => {
    assert.equal(getTouchedFiles().length, 0);
  });
});

describe("ledger — isFileTouched", () => {
  it("should return true if file has been touched", () => {
    recordTouch("src/auth/login.ts", "crafter-1", "write");
    assert.equal(isFileTouched("src/auth/login.ts"), true);
  });

  it("should return false if file has not been touched", () => {
    assert.equal(isFileTouched("src/auth/login.ts"), false);
  });
});

// ---- Snapshot immutability ----

describe("ledger — snapshot immutability", () => {
  it("should return a shallow copy, not the internal array", () => {
    recordTouch("file1.ts", "crafter-1", "write");
    const snapshot1 = getLedgerSnapshot();
    const snapshot2 = getLedgerSnapshot();

    // Mutating one snapshot should not affect the other
    // (shallow copy via spread operator)
    assert.notStrictEqual(snapshot1, snapshot2);
    assert.equal(snapshot1.length, snapshot2.length);
  });
});

// ---- Reset ----

describe("ledger — resetLedger", () => {
  it("should clear all entries", () => {
    recordTouch("file1.ts", "crafter-1", "write");
    recordTouch("file2.ts", "scout-1", "read");
    assert.equal(getLedgerSnapshot().length, 2);

    resetLedger();
    assert.equal(getLedgerSnapshot().length, 0);
  });

  it("should work on empty ledger without error", () => {
    resetLedger();
    assert.equal(getLedgerSnapshot().length, 0);
  });
});

// ---- Integration: full workflow ----

describe("ledger — integration", () => {
  it("should track a full workflow: scout → crafter → gatekeeper", () => {
    // Scout finds files
    recordTouches(
      ["src/auth/login.ts", "src/auth/middleware.ts"],
      "scout-1",
      "read",
    );

    // Crafter modifies them
    recordTouch("src/auth/login.ts", "crafter-1", "write");

    // Gatekeeper reads them
    recordTouch("src/auth/login.ts", "gatekeeper-1", "read");

    const snapshot = getLedgerSnapshot();
    assert.equal(snapshot.length, 4);

    // Verify all agents represented
    const files = getTouchedFiles();
    assert.equal(files.length, 2);

    // Crafter's modification is tracked
    const crafterWrites = getEntriesByAgent("crafter-1")
      .filter((e) => e.action === "write");
    assert.equal(crafterWrites.length, 1);
  });
});
