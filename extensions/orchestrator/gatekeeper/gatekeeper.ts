/**
 * gatekeeper.ts — Test execution and failure classification.
 *
 * Gatekeeper runs the project's test suite (always fresh, no cache) and
 * classifies failures against the Ledger and a pre-task baseline:
 *
 *   in-scope            — file was in the plan (touched by this task)
 *   out-of-scope-new    — file NOT in plan AND was passing in baseline
 *   out-of-scope-pre-existing — file NOT in plan AND was failing in baseline
 *
 * Trust mode determines handling:
 *   🙈 Trust:      auto-fix in-scope failures (max 3 attempts), log only
 *   🔍 Checkpoint: ask user before fixing in-scope failures
 *   Both modes:    out-of-scope failures ALWAYS ask user (non-negotiable gate)
 *
 * @see docs/prd.md §5.1 — Trust modes
 * @see docs/flow.md §5 — Approval gates
 * @see docs/plan.md Phase 4
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAgent } from "../core/agents";
import { getAllFiles } from "../core/ledger";
import { getTrustMode } from "../core/state";

// ── Types ──────────────────────────────────────────────────────────────────

export interface BaselineEntry {
  file: string;
  passing: boolean;
}

export interface TestFailure {
  file: string;
  testName: string;
  message: string;
}

export type FailureCategory =
  | "in-scope"
  | "out-of-scope-new"
  | "out-of-scope-pre-existing";

export interface ClassifiedFailure {
  file: string;
  testName: string;
  message: string;
  category: FailureCategory;
}

export interface GatekeeperResult {
  phase: "baseline" | "verify";
  totalTests: number;
  passed: number;
  failed: number;
  failures: ClassifiedFailure[];
  baseline?: BaselineEntry[];
  actions?: GatekeeperAction[];
  trustMode?: string;
}

// ── Baseline ───────────────────────────────────────────────────────────────

/** In-memory baseline captured before Phase 1 execution. */
let baseline: BaselineEntry[] = [];

export function setBaseline(entries: BaselineEntry[]): void {
  baseline = entries;
}

export function getBaseline(): readonly BaselineEntry[] {
  return baseline;
}

// ── Test Command Detection ─────────────────────────────────────────────────

/**
 * Detect the project's test command from package.json.
 * Returns the command string and a label.
 */
export function detectTestCommand(cwd: string): { command: string; label: string } {
  try {
    const { readFileSync } = require("node:fs");
    const { join } = require("node:path");
    const pkgPath = join(cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts = pkg.scripts || {};

    if (scripts.test) {
      return { command: "npm test", label: "npm test" };
    }
  } catch {
    // No package.json or unreadable — fall through
  }
  return { command: "npm test", label: "npm test (default)" };
}

// ── Test Execution ─────────────────────────────────────────────────────────

/**
 * Parse test runner output to extract failures.
 * Handles common formats: node:test, jest, vitest, mocha.
 */
export function parseTestOutput(
  output: string,
): { total: number; passed: number; failed: number; failures: TestFailure[] } {
  const failures: TestFailure[] = [];

  // node:test format: "✖ failing tests:\n\ntest at <file>\n✖ <name> (...)\n  AssertionError ..."
  // Look for failure blocks
  const failBlockRe = /test at ([^\n]+)\n[=─]*\n\s*[✖✗×]\s+(.+?)(?:\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = failBlockRe.exec(output)) !== null) {
    const file = match[1].trim();
    const name = match[2].trim();
    // Try to find the error message (next indented block)
    const afterName = output.indexOf(name, match.index);
    const nextSection = output.indexOf("\n\n", afterName + name.length);
    const msgBlock = nextSection > 0
      ? output.slice(afterName + name.length, nextSection).trim()
      : "";
    const msgLine = msgBlock.split("\n").find((l) => l.includes("Error")) || name;

    failures.push({ file, testName: name, message: msgLine.slice(0, 200) });
  }

  // Count totals from summary line
  // e.g., "ℹ tests 42\nℹ pass 38\nℹ fail 4"
  const totalMatch = output.match(/tests\s+(\d+)/);
  const passMatch = output.match(/pass\s+(\d+)/);
  const failMatch = output.match(/fail\s+(\d+)/);

  const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const passed = passMatch ? parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? parseInt(failMatch[1], 10) : failures.length;

  return { total, passed, failed, failures };
}

// ── Failure Classification ─────────────────────────────────────────────────

/**
 * Extract the actual file path from a test failure reference.
 * Test output often references paths like "extensions/orchestrator/ledger.test.ts"
 * — we need to normalize these to find matches in the Ledger and baseline.
 */
function normalizeFilePath(ref: string): string {
  // Remove line numbers: "file.ts:123:45" → "file.ts"
  return ref.replace(/:\d+(:\d+)?$/, "").trim();
}

/**
 * Classify test failures against the Ledger and baseline.
 *
 * Rules:
 *   in-scope:    file appears in Ledger (was touched by this task)
 *   out-of-scope-new: file NOT in Ledger AND was passing in baseline
 *   out-of-scope-pre-existing: file NOT in Ledger AND was failing in baseline
 */
export function classifyFailures(
  failures: TestFailure[],
  baselineEntries: BaselineEntry[],
  ledgerFiles: Record<string, unknown>,
): ClassifiedFailure[] {
  return failures.map((f) => {
    const normalizedFile = normalizeFilePath(f.file);

    // Check if file is in the Ledger (touched by this task)
    const inLedger = Object.keys(ledgerFiles).some(
      (ledgerPath) =>
        normalizedFile.includes(ledgerPath) ||
        ledgerPath.includes(normalizedFile) ||
        normalizedFile.endsWith(ledgerPath),
    );

    if (inLedger) {
      return { ...f, category: "in-scope" as FailureCategory };
    }

    // Check baseline
    const baselineEntry = baselineEntries.find((b) => {
      const bFile = normalizeFilePath(b.file);
      return (
        normalizedFile.includes(bFile) ||
        bFile.includes(normalizedFile) ||
        normalizedFile.endsWith(bFile)
      );
    });

    if (!baselineEntry) {
      // No baseline data — treat as out-of-scope-new (conservative)
      return { ...f, category: "out-of-scope-new" as FailureCategory };
    }

    if (baselineEntry.passing) {
      return { ...f, category: "out-of-scope-new" as FailureCategory };
    }

    return { ...f, category: "out-of-scope-pre-existing" as FailureCategory };
  });
}

// ── Trust Mode Logic ───────────────────────────────────────────────────────

export type GatekeeperAction =
  | { type: "auto-fix"; failures: ClassifiedFailure[] }
  | { type: "ask-user"; failures: ClassifiedFailure[]; reason: string };

/**
 * Determine what to do with classified failures based on trust mode.
 *
 * Trust mode (🙈): in-scope → auto-fix; out-of-scope → always ask
 * Checkpoint (🔍): in-scope → ask; out-of-scope → always ask
 */
export function decideAction(
  classified: ClassifiedFailure[],
  mode: "trust" | "checkpoint",
): GatekeeperAction[] {
  const actions: GatekeeperAction[] = [];

  const inScope = classified.filter((f) => f.category === "in-scope");
  const outOfScope = classified.filter((f) => f.category.startsWith("out-of-scope"));

  if (inScope.length > 0) {
    if (mode === "trust") {
      actions.push({ type: "auto-fix", failures: inScope });
    } else {
      actions.push({
        type: "ask-user",
        failures: inScope,
        reason: `${inScope.length} in-scope test failure(s) found.`,
      });
    }
  }

  if (outOfScope.length > 0) {
    // Always ask for out-of-scope — non-negotiable per flow.md §5
    actions.push({
      type: "ask-user",
      failures: outOfScope,
      reason: `${outOfScope.length} out-of-scope test failure(s) — may be pre-existing or caused by this task.`,
    });
  }

  return actions;
}

// ── Tool Registration ──────────────────────────────────────────────────────

export function registerGatekeeper(pi: ExtensionAPI): void {
  registerAgent(pi, {
    name: "gatekeeper",
    description:
      "Runs the project's test suite and classifies failures. " +
      "Compares against a pre-task baseline to distinguish 'we broke it' from 'already broken'. " +
      "Out-of-scope failures always require user approval regardless of trust mode.",
    promptSnippet: "Run tests and verify results",
    promptGuidelines: [
      "Use summon_gatekeeper with phase='baseline' before any edits to capture a baseline.",
      "Use summon_gatekeeper with phase='verify' after all phases to run tests and classify failures.",
      "Out-of-scope failures always require user input — do not auto-fix without asking.",
    ],
    handler: createGatekeeperHandler(),
  });
}

function createGatekeeperHandler() {
  return async function gatekeeperHandler(
    task: string,
    ctx: ExtensionContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> {
    let params: { phase?: string };
    try {
      params = JSON.parse(task);
    } catch {
      params = { phase: task };
    }

    const phase = params.phase || "verify";
    const cwd = ctx.cwd;

    try {
      const { command, label } = detectTestCommand(cwd);

      if (phase === "baseline") {
        // Capture baseline — run tests, store results
        const { execSync } = await import("node:child_process");
        let output: string;
        try {
          output = execSync(command, { cwd, encoding: "utf8", timeout: 120_000 });
        } catch (err: unknown) {
          // Tests failed — still capture the output as baseline
          const execError = err as { stdout?: string; stderr?: string };
          output = (execError.stdout || "") + "\n" + (execError.stderr || "");
        }

        const parsed = parseTestOutput(output);
        const baselineEntries: BaselineEntry[] = [];

        // We don't have a full file list, so we store what we know
        for (const f of parsed.failures) {
          baselineEntries.push({
            file: normalizeFilePath(f.file),
            passing: false,
          });
        }

        setBaseline(baselineEntries);

        return {
          content: [{
            type: "text",
            text: `Baseline captured: ${parsed.total} tests, ${parsed.passed} passed, ${parsed.failed} failed.\nCommand: ${label}`,
          }],
          details: {
            phase: "baseline",
            totalTests: parsed.total,
            passed: parsed.passed,
            failed: parsed.failed,
            failures: [],
            baseline: baselineEntries,
          } satisfies GatekeeperResult,
        };
      }

      // Verify phase — run tests and classify
      const { execSync } = await import("node:child_process");
      let output: string;
      try {
        output = execSync(command, { cwd, encoding: "utf8", timeout: 120_000 });
      } catch (err: unknown) {
        const execError = err as { stdout?: string; stderr?: string };
        output = (execError.stdout || "") + "\n" + (execError.stderr || "");
      }

      const parsed = parseTestOutput(output);
      const ledgerFiles = getAllFiles();
      const baselineEntries = [...baseline];
      const classified = classifyFailures(parsed.failures, baselineEntries, ledgerFiles);
      const trustMode = getTrustMode();
      const actions = decideAction(classified, trustMode);

      // Format result
      const lines: string[] = [];
      lines.push(`## Gatekeeper Report`);
      lines.push("");
      lines.push(`**${parsed.passed}/${parsed.total}** tests passed.`);
      if (parsed.failed > 0) {
        lines.push(`**${parsed.failed}** failure(s).`);
      }
      lines.push(`Trust mode: ${trustMode === "trust" ? "🙈 Trust" : "🔍 Checkpoint"}`);
      lines.push("");

      if (classified.length === 0) {
        lines.push("✅ All tests passing. No issues found.");
      } else {
        for (const action of actions) {
          const label = action.type === "auto-fix" ? "🤖 Auto-fix" : "👆 Needs approval";
          lines.push(`### ${label}`);
          for (const f of action.failures) {
            lines.push(`- \`${f.file}\` — ${f.category}: ${f.testName}`);
          }
          lines.push("");
        }
      }

      // If trust mode auto-fix, note that Main Agent should re-run with fixes
      const needsAutoFix = actions.some((a) => a.type === "auto-fix");
      if (needsAutoFix) {
        lines.push("> ⚡ In-scope failures will be auto-fixed. Main Agent should summon Crafter for fixes, then re-run Gatekeeper.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          phase: "verify",
          totalTests: parsed.total,
          passed: parsed.passed,
          failed: parsed.failed,
          failures: classified,
          baseline: baselineEntries,
          actions,
          trustMode,
        } satisfies GatekeeperResult,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Gatekeeper failed: ${msg}`);
    }
  };
}


