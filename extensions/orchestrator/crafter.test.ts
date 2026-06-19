/**
 * crafter.test.ts — Unit tests for Crafter pure logic.
 *
 * Covers: detectImports (ESM import parsing), parseTask (JSON + plain formats).
 *
 * Pi-runtime functions (withFileMutationQueue) are not testable outside Pi;
 * those paths are covered by Phase 8 integration tests.
 *
 * @see docs/plan.md Phase 3
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { detectImports, parseTask } from "./crafter-utils";

describe("Crafter", () => {
  describe("detectImports", () => {
    it("should detect default imports", () => {
      const imports = detectImports(`import foo from "./bar";`);
      assert.deepStrictEqual(imports, ["./bar"]);
    });

    it("should detect named imports", () => {
      const imports = detectImports(`import { a, b } from "./utils";`);
      assert.deepStrictEqual(imports, ["./utils"]);
    });

    it("should detect namespace imports", () => {
      const imports = detectImports(`import * as lib from "./lib/api";`);
      assert.deepStrictEqual(imports, ["./lib/api"]);
    });

    it("should detect mixed imports", () => {
      const imports = detectImports(`import React, { useState } from "./react";`);
      assert.deepStrictEqual(imports, ["./react"]);
    });

    it("should detect multiple imports", () => {
      const code = [
        `import { a } from "./a";`,
        `import { b } from "./b";`,
        `import c from "./c";`,
      ].join("\n");

      const imports = detectImports(code);
      assert.deepStrictEqual(imports, ["./a", "./b", "./c"]);
    });

    it("should skip external (non-relative) imports", () => {
      const code = [
        `import fs from "fs";`,
        `import { useState } from "react";`,
        `import { local } from "./local";`,
      ].join("\n");

      const imports = detectImports(code);
      // Only relative imports are reported for richer reporting
      assert.deepStrictEqual(imports, ["./local"]);
    });

    it("should return empty array for files with no imports", () => {
      const imports = detectImports(`export const x = 1;`);
      assert.deepStrictEqual(imports, []);
    });

    it("should handle empty content", () => {
      const imports = detectImports("");
      assert.deepStrictEqual(imports, []);
    });
  });

  describe("parseTask", () => {
    it("should parse JSON task with file and instruction", () => {
      const task = parseTask(
        JSON.stringify({ file: "src/app.ts", instruction: "Update the header" }),
      );

      assert.equal(task.file, "src/app.ts");
      assert.equal(task.instruction, "Update the header");
    });

    it("should parse JSON task with phase and owner", () => {
      const task = parseTask(
        JSON.stringify({
          file: "src/app.ts",
          instruction: "Update",
          phase: 2,
          owner: "crafter-1",
        }),
      );

      assert.equal(task.file, "src/app.ts");
      assert.equal(task.phase, 2);
      assert.equal(task.owner, "crafter-1");
    });

    it("should parse 'file: instruction' format", () => {
      const task = parseTask("src/app.ts: Update the header");

      assert.equal(task.file, "src/app.ts");
      assert.equal(task.instruction, "Update the header");
    });

    it("should handle plain string as file path", () => {
      const task = parseTask("src/app.ts");

      assert.equal(task.file, "src/app.ts");
      assert.equal(task.instruction, "Apply the described changes");
    });

    it("should generate a unique owner ID", () => {
      const task1 = parseTask("a.ts");
      const task2 = parseTask("b.ts");

      assert.ok(task1.owner);
      assert.ok(task2.owner);
      assert.notEqual(task1.owner, task2.owner);
    });

    it("should handle JSON without file field", () => {
      const task = parseTask(JSON.stringify({ instruction: "do stuff" }));

      // Falls back to the JSON string as file
      assert.ok(task.file);
      assert.equal(task.instruction, "do stuff");
      assert.ok(task.owner);
    });
  });
});
