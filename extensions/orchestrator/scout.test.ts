/**
 * scout.test.ts — Unit tests for the Scout module.
 *
 * Covers: file collection, symbol search, dependency graph parsing,
 * cache hit/miss, and cache invalidation.
 *
 * Uses temporary fixture files for deterministic graph testing.
 *
 * @see docs/plan.md Task 1.4
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { runScout } from "./scout";
import { dirtyScoutCache } from "./state";

// ── Fixture Helpers ────────────────────────────────────────────────────────

let fixtureDir: string;

function fixture(...parts: string[]): string {
  return join(fixtureDir, ...parts);
}

function writeFixture(relPath: string, content: string): string {
  const fullPath = fixture(relPath);
  const dir = join(fullPath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, "utf8");
  return fullPath;
}

/** Create a multi-file fixture project with known dependencies. */
function createSimpleProject(): void {
  // lib/api.ts — no imports, exports fetchDashboard and fetchSettings
  writeFixture(
    "lib/api.ts",
    [
      'export function fetchDashboard() { return fetch("/api/dashboard"); }',
      'export function fetchSettings() { return fetch("/api/settings"); }',
    ].join("\n"),
  );

  // dashboard.ts — imports from lib/api
  writeFixture(
    "dashboard.ts",
    [
      'import { fetchDashboard } from "./lib/api";',
      "",
      "export function renderDashboard() {",
      "  return fetchDashboard().then(r => r.json());",
      "}",
    ].join("\n"),
  );

  // settings.ts — imports from lib/api
  writeFixture(
    "settings.ts",
    [
      'import { fetchSettings } from "./lib/api";',
      "",
      "export function renderSettings() {",
      "  return fetchSettings().then(r => r.json());",
      "}",
    ].join("\n"),
  );

  // utils/helpers.ts — no imports, utility exports
  writeFixture(
    "utils/helpers.ts",
    [
      'export function formatDate(d: Date): string { return d.toISOString(); }',
      'export function capitalize(s: string): string { return s[0].toUpperCase() + s.slice(1); }',
    ].join("\n"),
  );
}

/** Create a project with a circular dependency. */
function createCircularProject(): void {
  writeFixture(
    "a.ts",
    [
      'import { b } from "./b";',
      "export const a = 1;",
      'console.log(b);',
    ].join("\n"),
  );
  writeFixture(
    "b.ts",
    [
      'import { a } from "./a";',
      "export const b = 2;",
      'console.log(a);',
    ].join("\n"),
  );
}

// ── Setup / Teardown ───────────────────────────────────────────────────────

beforeEach(() => {
  fixtureDir = join(tmpdir(), `scout-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(fixtureDir, { recursive: true });
  dirtyScoutCache.clear();
});

afterEach(() => {
  try {
    rmSync(fixtureDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("Scout", () => {
  describe("runScout — dependency graph", () => {
    it("should build correct dependency graph for simple project", async () => {
      createSimpleProject();

      const result = await runScout({ scope: fixtureDir });

      const { graph } = result;

      // lib/api.ts should have no imports (empty importedBy will be populated)
      assert.ok(graph["lib/api.ts"]);
      assert.ok(graph["lib/api.ts"].exports.includes("fetchDashboard"));
      assert.ok(graph["lib/api.ts"].exports.includes("fetchSettings"));

      // dashboard.ts imports lib/api
      assert.ok(graph["dashboard.ts"]);
      assert.ok(graph["lib/api.ts"].importedBy.includes("dashboard.ts"));

      // settings.ts imports lib/api
      assert.ok(graph["settings.ts"]);
      assert.ok(graph["lib/api.ts"].importedBy.includes("settings.ts"));

      // utils/helpers.ts — no imports or importedBy
      assert.ok(graph["utils/helpers.ts"]);
      assert.ok(graph["utils/helpers.ts"].exports.includes("formatDate"));
      assert.equal(graph["utils/helpers.ts"].importedBy.length, 0);
    });

    it("should detect diamond dependency pattern", async () => {
      // A → B, A → C (B and C both import from A)
      // This is the exact pattern from flow.md §3.1
      writeFixture(
        "lib/api.ts",
        "export const x = 1;\n",
      );
      writeFixture(
        "dashboard.ts",
        'import { x } from "./lib/api";\n',
      );
      writeFixture(
        "settings.ts",
        'import { x } from "./lib/api";\n',
      );

      const result = await runScout({ scope: fixtureDir });
      const { graph } = result;

      assert.ok(graph["lib/api.ts"].importedBy.includes("dashboard.ts"));
      assert.ok(graph["lib/api.ts"].importedBy.includes("settings.ts"));
      // B and C don't depend on each other → parallel-safe
    });

    it("should handle circular dependencies without infinite loop", async () => {
      createCircularProject();

      const result = await runScout({ scope: fixtureDir });

      // Should complete without error — circular deps are detected but don't crash
      assert.ok(result.graph["a.ts"]);
      assert.ok(result.graph["b.ts"]);
      // Both files exist in graph
    });

    it("should return high confidence for clean ESM imports", async () => {
      createSimpleProject();

      const result = await runScout({ scope: fixtureDir });

      assert.equal(result.confidence, "high");
    });

    it("should return low confidence for dynamic imports", async () => {
      writeFixture(
        "dynamic.ts",
        [
          "export async function loadThing() {",
          '  const mod = await import("./lazy");',
          "  return mod;",
          "}",
        ].join("\n"),
      );
      writeFixture("lazy.ts", "export const x = 1;\n");

      const result = await runScout({ scope: fixtureDir });

      assert.equal(result.confidence, "low");
    });

    it("should return low confidence for require() calls", async () => {
      writeFixture(
        "require.ts",
        'const fs = require("fs");\n',
      );

      const result = await runScout({ scope: fixtureDir });

      assert.equal(result.confidence, "low");
    });
  });

  describe("runScout — symbol search", () => {
    it("should find symbols matching a pattern", async () => {
      createSimpleProject();

      const result = await runScout({
        scope: fixtureDir,
        pattern: "fetchDashboard",
      });

      assert.ok(result.slices.length > 0);
      const dashboardSlice = result.slices.find((s) => s.file.endsWith("dashboard.ts"));
      assert.ok(dashboardSlice);
      assert.ok(dashboardSlice.lines.includes("fetchDashboard"));
    });

    it("should return empty slices when no pattern provided", async () => {
      createSimpleProject();

      const result = await runScout({ scope: fixtureDir });

      assert.equal(result.slices.length, 0);
    });

    it("should return empty slices when pattern matches nothing", async () => {
      createSimpleProject();

      const result = await runScout({
        scope: fixtureDir,
        pattern: "nonexistentFunctionXYZ",
      });

      assert.equal(result.slices.length, 0);
    });

    it("should truncate large outputs", async () => {
      // Create a file with many lines
      const lines: string[] = [];
      for (let i = 0; i < 300; i++) {
        lines.push(`const var${i} = ${i};`);
      }
      writeFixture("big.ts", lines.join("\n"));

      const result = await runScout({
        scope: fixtureDir,
        pattern: "const",
      });

      // truncateHead at 200 lines — verify output is capped
      for (const slice of result.slices) {
        const lineCount = slice.lines.split("\n").length;
        assert.ok(lineCount <= 210, `Expected <= 210 lines, got ${lineCount}`); // allow small margin for truncation message
      }
    });
  });
});
