/**
 * Unit tests for plan-file.ts — plan checklist persistence.
 *
 * Uses real temp directories for filesystem operations (fast, isolated,
 * no mocking complexity for Node's fs/promises).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import {
  initPlanFiles,
  write,
  findExisting,
  checkOffStep,
  archive,
  listActivePlans,
} from "./plan-file";

// ---- Setup ----

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "plan-file-test-"));
  initPlanFiles(testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---- Write ----

describe("plan-file — write", () => {
  it("should create a plan file with correct markdown format", async () => {
    const plan = await write("Fix login redirect", [
      { description: "Locate the redirect logic", done: false },
      { description: "Fix the condition", done: false },
      { description: "Add test", done: false },
    ]);

    assert.ok(existsSync(plan.path));
    assert.ok(plan.path.includes("docs/tasks/"));
    assert.ok(plan.path.endsWith(".md"));

    const content = readFileSync(plan.path, "utf8");
    assert.ok(content.includes("# Fix login redirect"));
    assert.ok(content.includes("- [ ] Locate the redirect logic"));
    assert.ok(content.includes("- [ ] Fix the condition"));
    assert.ok(content.includes("- [ ] Add test"));
    assert.ok(content.includes("**Trust mode:**"));
    assert.ok(content.includes("**Progress:** 0/3 steps"));
  });

  it("should create docs/tasks/archived/ directories automatically", async () => {
    await write("Test plan", [{ description: "Step 1", done: false }]);

    const tasksDir = join(testDir, "docs", "tasks");
    const archiveDir = join(testDir, "docs", "tasks", "archived");
    assert.ok(existsSync(tasksDir));
    assert.ok(existsSync(archiveDir));
  });

  it("should mark pre-completed steps with [x]", async () => {
    const plan = await write("Mixed plan", [
      { description: "Already done", done: true },
      { description: "To do", done: false },
    ]);

    const content = readFileSync(plan.path, "utf8");
    assert.ok(content.includes("- [x] Already done"));
    assert.ok(content.includes("- [ ] To do"));
    assert.ok(content.includes("**Progress:** 1/2 steps"));
  });

  it("should set trust mode icon correctly", async () => {
    const trustPlan = await write(
      "Trust test",
      [{ description: "Step", done: false }],
      "trust",
    );
    const checkPlan = await write(
      "Check test",
      [{ description: "Step", done: false }],
      "checkpoint",
    );

    const trustContent = readFileSync(trustPlan.path, "utf8");
    const checkContent = readFileSync(checkPlan.path, "utf8");

    assert.ok(trustContent.includes("🙈"));
    assert.ok(trustContent.includes("trust"));
    assert.ok(checkContent.includes("🔍"));
    assert.ok(checkContent.includes("checkpoint"));
  });

  it("should use ISO date in filename", async () => {
    const plan = await write("Test", [{ description: "Step", done: false }]);
    const filename = basename(plan.path);

    // Match YYYY-MM-DD format
    assert.ok(/^\d{4}-\d{2}-\d{2}-/.test(filename));
  });
});

// ---- findExisting ----

describe("plan-file — findExisting", () => {
  it("should find a plan matching the task description by title", async () => {
    await write("Fix login redirect bug", [
      { description: "Fix it", done: false },
    ]);

    const found = await findExisting("login redirect");
    assert.ok(found !== null);
    assert.ok(found!.title.includes("Fix login redirect"));
  });

  it("should find a plan matching the task description by body", async () => {
    await write("Auth improvements", [
      { description: "Fix the login redirect logic", done: false },
    ]);

    const found = await findExisting("login redirect");
    assert.ok(found !== null);
  });

  it("should return null when no plan matches", async () => {
    const found = await findExisting("nonexistent task");
    assert.equal(found, null);
  });

  it("should handle empty tasks directory", async () => {
    const found = await findExisting("anything");
    assert.equal(found, null);
  });
});

// ---- checkOffStep ----

describe("plan-file — checkOffStep", () => {
  it("should mark a specific step as done", async () => {
    const plan = await write("Test plan", [
      { description: "Step one", done: false },
      { description: "Step two", done: false },
      { description: "Step three", done: false },
    ]);

    await checkOffStep(plan.path, 1);

    const content = readFileSync(plan.path, "utf8");
    assert.ok(content.includes("- [ ] Step one"));
    assert.ok(content.includes("- [x] Step two"));
    assert.ok(content.includes("- [ ] Step three"));
  });

  it("should update progress counter in header", async () => {
    const plan = await write("Progress test", [
      { description: "A", done: false },
      { description: "B", done: false },
    ]);

    await checkOffStep(plan.path, 0);

    const content = readFileSync(plan.path, "utf8");
    assert.ok(content.includes("**Progress:** 1/2 steps"));
  });
});

// ---- archive ----

describe("plan-file — archive", () => {
  it("should move plan to archived/ directory", async () => {
    const plan = await write("To archive", [
      { description: "Done", done: true },
    ]);

    const archivePath = await archive(plan.path);

    assert.ok(archivePath.includes("archived"));
    assert.ok(existsSync(archivePath));
    assert.ok(!existsSync(plan.path)); // original removed
  });
});

// ---- listActivePlans ----

describe("plan-file — listActivePlans", () => {
  it("should list all active plan files", async () => {
    await write("Plan A", [{ description: "Step", done: false }]);
    await write("Plan B", [{ description: "Step", done: false }]);

    const plans = await listActivePlans();
    assert.equal(plans.length, 2);
  });

  it("should return empty array when no plans exist", async () => {
    const plans = await listActivePlans();
    assert.equal(plans.length, 0);
  });

  it("should not include archived plans", async () => {
    const plan = await write("Archive me", [
      { description: "Step", done: true },
    ]);
    await archive(plan.path);

    const plans = await listActivePlans();
    assert.equal(plans.length, 0);
  });
});
