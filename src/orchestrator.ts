/**
 * Orchestrator — the Main Agent loop.
 *
 * This is the core decision engine. It owns all mutable orchestration state —
 * no sub-agent or Gatekeeper instance holds its own conflicting view of progress.
 *
 * Driver model (Phase 2): the loop is run synchronously inside the `/summoner`
 * command invocation, using `ctx.ui` for plan approval and per-step checkpoints
 * (both awaitable and visible). It is NOT spread across `turn_start` events — the
 * previous suspended-promise approval design deadlocked. Ambient detection now
 * only emits a non-blocking hint (see `notifyAmbient`); the LLM also drives work
 * directly by calling the `summon_*` tools.
 *
 * Phase 1: sequential-only, no tmux, session-scoped model.
 */

import type {
  TriggerResult,
  PlanFile,
  PlanStep,
  TrustMode,
  GatekeeperFinding,
} from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as planFile from "./plan-file";
import * as ledger from "./ledger";
import * as agents from "./agents";

/** The slice of the pi context the orchestrator needs. */
export type OrchestratorCtx = Pick<ExtensionContext, "cwd" | "ui" | "hasUI">;

// ---- Logging ----

function log(msg: string): void { console.log(`[summoner] ${msg}`); }
function warn(msg: string): void { console.warn(`[summoner] ${msg}`); }
function err(msg: string): void { console.error(`[summoner] ${msg}`); }

// ---- Orchestrator State ----

interface RunState {
  plan: PlanFile | null;
  trustMode: TrustMode;
  currentStep: number;
  triggeredBy: "ambient" | "manual";
  /** Scout findings from the most recent dispatch, fed into plan drafting */
  lastScoutResult: string | null;
}

let currentRun: RunState | null = null;

/** Is the heavy loop currently running? Used to suppress duplicate ambient hints. */
export function isRunActive(): boolean {
  return currentRun !== null && currentRun.plan !== null;
}

// ---- Ambient hint (non-blocking; runs from turn_start) ----

/**
 * Emit a lightweight, non-blocking hint based on ambient detection. Does NOT run
 * the loop or block the turn — that was the source of the previous deadlock. The
 * LLM has the `summon_*` tools and can act on these signals directly; `/summoner`
 * starts the full orchestrated loop.
 */
export function notifyAmbient(trigger: TriggerResult, ctx: OrchestratorCtx): void {
  if (isRunActive()) return;
  if (trigger.implementIntent) {
    ctx.ui.notify(
      "💡 Implementation intent detected — run /summoner <task> to start the plan → approve → build → verify loop.",
      "info",
    );
  } else if (trigger.needsScout) {
    ctx.ui.notify(
      "🔍 This looks like a codebase question — summon_scout can find the relevant slices.",
      "info",
    );
  }
}

// ---- 7.7 Manual override (/summoner) — the loop driver ----

export async function handleManualSummon(
  task: string,
  ctx: OrchestratorCtx,
): Promise<void> {
  if (isRunActive()) {
    warn(
      `Already running plan: ${currentRun?.plan?.title}. Complete or abort it first.`,
    );
    ctx.ui.notify("A summoner run is already in progress.", "warning");
    return;
  }

  await startLoop(task, ctx);
}

// ---- Internal: start the heavy loop ----

async function startLoop(
  task: string,
  ctx: OrchestratorCtx,
): Promise<void> {
  // 7.4 Hard constraint: check for existing plan BEFORE anything else
  let plan = await planFile.findExisting(task);

  if (plan) {
    // Found existing plan — load it instead of drafting
    log(`Found existing plan: ${plan.title}`);
  } else {
    // 7.1 Draft a new plan — with Scout context if available
    // GAP 3 FIX: Run Scout first to gather codebase context for the plan
    log("Scouting codebase for context...");
    const scoutResult = await dispatchScout(
      `Gather context for: ${task}`,
      ctx.cwd,
    );

    plan = await draftPlan(task, scoutResult, ctx.cwd);
  }

  // 7.2 Present for approval + set trust mode (one decision, via ctx.ui)
  let approval = await requestApproval(plan, ctx);

  // Allow up to 2 revise cycles before giving up.
  let revises = 0;
  while (approval.outcome === "revise" && revises < 2) {
    revises++;
    plan = await draftPlan(
      `${task}\n\nFeedback: ${approval.feedback ?? ""}`,
      null,
      ctx.cwd,
    );
    approval = await requestApproval(plan, ctx);
  }

  if (approval.outcome !== "approved") {
    ctx.ui.notify("Plan not approved — aborting summoner run.", "warning");
    log("Plan rejected/abandoned. Aborting.");
    // Drafted-but-rejected plan file is left in docs/tasks/ for the user.
    return;
  }

  plan.trustMode = approval.trustMode;

  // Initialize run state
  currentRun = {
    plan,
    trustMode: approval.trustMode,
    currentStep: 0,
    triggeredBy: "manual",
    lastScoutResult: null,
  };

  try {
    // 7.3 Execute steps sequentially
    await executeSteps(ctx);

    // 7.5 Always run Gatekeeper after all steps
    await runGatekeeper(ctx);

    // 7.6 Archive on completion
    await planFile.archive(plan.path);
    log(`Task complete! Plan archived: ${plan.title}`);
    ctx.ui.notify(`✅ Summoner complete: ${plan.title}`, "info");
  } catch (loopError) {
    err(
      `Run failed: ${loopError instanceof Error ? loopError.message : String(loopError)}`,
    );
    ctx.ui.notify(
      `Summoner run failed: ${loopError instanceof Error ? loopError.message : String(loopError)}`,
      "error",
    );
  } finally {
    // Reset state
    currentRun = null;
    ledger.resetLedger();
  }
}

// ---- Draft a plan ----

/**
 * GAP 3 FIX: Scout results now feed into plan drafting.
 * When scoutResult is provided, it enriches the plan with codebase context.
 */
async function draftPlan(
  task: string,
  scoutResult: string | null,
  _cwd: string,
): Promise<PlanFile> {
  // Build steps from the task description, enriched with Scout context
  const steps: PlanStep[] = [];

  // If Scout found relevant files/context, include it in the plan
  if (scoutResult && scoutResult.trim()) {
    steps.push({
      description: `Context from Scout: ${scoutResult.slice(0, 200)}`,
      done: true, // Scout is informational, already done
    });
  }

  // Parse task into actionable steps
  const taskSteps = task
    .split(/[\n;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const desc of taskSteps) {
    steps.push({ description: desc, done: false });
  }

  if (steps.length === 0) {
    steps.push({ description: task, done: false });
  }

  const shortTitle = task.slice(0, 60).replace(/\n/g, " ").trim();
  return planFile.write(shortTitle, steps, "checkpoint");
}

// ---- Approval flow (ctx.ui — awaitable, visible) ----

interface ApprovalResult {
  outcome: "approved" | "revise" | "rejected";
  trustMode: TrustMode;
  feedback?: string;
}

const APPROVE_TRUST = "🙈 Approve — Trust mode (auto-proceed through steps)";
const APPROVE_CHECK = "🔍 Approve — Checkpoint mode (confirm each step)";
const REVISE = "✏️  Revise (give feedback)";
const REJECT = "✖  Reject";

/**
 * Present the plan and capture the user's decision via `ctx.ui.select`.
 * One interaction sets both go-ahead AND trust mode (per PRD). Awaitable and
 * visible — no suspended promise across turns.
 *
 * Falls back to Trust-mode approval if no interactive UI is available
 * (e.g. non-TUI mode), so headless/automated runs still proceed.
 */
async function requestApproval(
  plan: PlanFile,
  ctx: OrchestratorCtx,
): Promise<ApprovalResult> {
  const stepList = plan.steps
    .map((s, i) => `  ${i + 1}. [${s.done ? "x" : " "}] ${s.description}`)
    .join("\n");
  const title = `Plan: ${plan.title}`;

  log(`📋 ${title}\n${stepList}`);

  if (!ctx.hasUI) {
    warn("No interactive UI — auto-approving plan in Trust mode.");
    return { outcome: "approved", trustMode: "trust" };
  }

  const choice = await ctx.ui.select(
    `${title} — ${plan.steps.length} step(s). Approve?`,
    [APPROVE_TRUST, APPROVE_CHECK, REVISE, REJECT],
  );

  switch (choice) {
    case APPROVE_TRUST:
      return { outcome: "approved", trustMode: "trust" };
    case APPROVE_CHECK:
      return { outcome: "approved", trustMode: "checkpoint" };
    case REVISE: {
      const feedback = await ctx.ui.input(
        "What should change about the plan?",
        "Describe the revision…",
      );
      return { outcome: "revise", trustMode: "checkpoint", feedback: feedback ?? "" };
    }
    default:
      // REJECT or dialog dismissed (undefined)
      return { outcome: "rejected", trustMode: "checkpoint" };
  }
}

// ---- Step execution loop ----

/**
 * GAP 1 FIX: Ledger is now consulted before every Crafter summon.
 * Previously-touched files are included in the prompt context.
 */
async function executeSteps(
  ctx: OrchestratorCtx,
): Promise<void> {
  if (!currentRun?.plan) return;

  const plan = currentRun.plan;

  for (let i = 0; i < plan.steps.length; i++) {
    currentRun.currentStep = i;
    const step = plan.steps[i];

    if (step.done) continue;

    // Checkpoint mode: actually pause and wait for the user before this step.
    if (currentRun.trustMode === "checkpoint" && ctx.hasUI) {
      const proceed = await ctx.ui.confirm(
        `🔍 Step ${i + 1}/${plan.steps.length}`,
        `${step.description}\n\nProceed with this step?`,
      );
      if (!proceed) {
        log(`Step ${i + 1} skipped by user; stopping run.`);
        ctx.ui.notify("Run stopped at checkpoint.", "info");
        return;
      }
    }

    // Summon Crafter for this step
    const crafterDef = agents.getAgent("crafter");
    if (!crafterDef) {
      throw new Error("Crafter agent not registered");
    }

    // GAP 1: Consult Ledger before summoning — include context about
    // what files have already been touched in previous steps
    const touchedFiles = ledger.getTouchedFiles();
    const touchedContext =
      touchedFiles.length > 0
        ? `\n\nPreviously modified files (from earlier steps):\n${touchedFiles.map((f) => `  - ${f}`).join("\n")}`
        : "";

    const promptWithContext = step.description + touchedContext;

    try {
      const report = await agents.runAgent("crafter", promptWithContext, ctx.cwd);

      // Update state
      step.done = true;
      await planFile.checkOffStep(plan.path, i);
      // Record the actual files Crafter reported changing (not the plan file).
      const changed = parseChangedFiles(report);
      ledger.recordTouches(
        changed.length > 0 ? changed : ["(unspecified)"],
        `crafter-${i + 1}`,
        "write",
      );

      log(`✓ Step ${i + 1} complete: ${step.description}`);
    } catch (stepError) {
      err(
        `✗ Step ${i + 1} failed: ${stepError instanceof Error ? stepError.message : String(stepError)}`,
      );
      throw stepError;
    }
  }
}

// ---- Scout dispatch ----

/** Dispatch Scout and return its findings as a string. */
async function dispatchScout(task: string, _cwd: string): Promise<string | null> {
  const scoutDef = agents.getAgent("scout");
  if (!scoutDef) {
    console.error("[orchestrator] Scout agent not registered");
    return null;
  }

  try {
    const report = await agents.runAgent("scout", task, _cwd);
    ledger.recordTouch("scout-results", "scout-1", "read");
    return report;
  } catch (scoutError) {
    console.error(
      `[orchestrator] Scout failed: ${scoutError instanceof Error ? scoutError.message : String(scoutError)}`,
    );
    return null;
  }
}

// ---- 7.5 Gatekeeper routing ----

/**
 * GAP 2 FIX: parseFindings now actually extracts findings from the
 * Gatekeeper's RPC response instead of returning an empty array.
 */
async function runGatekeeper(
  ctx: { cwd: string },
): Promise<void> {
  const gatekeeperDef = agents.getAgent("gatekeeper");
  if (!gatekeeperDef) {
    throw new Error("Gatekeeper agent not registered");
  }

  log("Gatekeeper reviewing...");

  // Tell Gatekeeper which files this task touched, so it can judge provenance.
  const touched = ledger.getTouchedFiles().filter((f) => !f.startsWith("("));
  const reviewPrompt =
    `Review the completed work. Report all findings.\n\n` +
    (touched.length > 0
      ? `Files changed by this task:\n${touched.map((f) => `  - ${f}`).join("\n")}`
      : `(No specific files recorded as changed.)`);

  const responseText = await agents.runAgent("gatekeeper", reviewPrompt, ctx.cwd);
  const findings = parseFindings(responseText);

  for (const finding of findings) {
    if (finding.inScope) {
      // In-scope: auto-dispatch Crafter to fix, no user approval needed
      warn(
        `Gatekeeper found (in-scope): ${finding.description}\nDispatching Crafter to fix...`,
      );
      await dispatchCrafterFix(finding, ctx.cwd);
    } else {
      // Out-of-scope: ask user
      warn(
        `Gatekeeper found (out-of-scope, pre-existing): ${finding.description}\n` +
          `This was not caused by this task. Type "fix it" to address, or ignore.`,
      );
      // In Phase 1, leave it for the user to decide on next turn
    }
  }

  if (findings.length === 0) {
    log("Gatekeeper: all clear ✓");
  }
}

/**
 * GAP 2 FIX: Parse Gatekeeper findings from the response text.
 *
 * The Gatekeeper subprocess returns findings in a structured format:
 *   - Lines starting with "FINDING:" or "- " are parsed as findings
 *   - "IN-SCOPE:" prefix means the finding is in-scope
 *   - "OUT-OF-SCOPE:" prefix means pre-existing
 */
function parseFindings(responseText: string | null): GatekeeperFinding[] {
  if (!responseText) return [];

  const findings: GatekeeperFinding[] = [];
  const lines = responseText.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match finding markers
    const findingMatch =
      trimmed.match(/^(?:FINDING:|[-*]\s*)(.*)/i);
    if (!findingMatch) continue;

    const content = findingMatch[1].trim();
    if (!content) continue;

    // Determine scope
    const inScope = !/out.of.scope|pre.existing|preexisting/i.test(content);

    // Determine category
    const isQuality =
      /readability|maintainability|quality|style|naming|complexity/i.test(
        content,
      );
    const category = isQuality ? "quality" : "functional";

    // Try to extract file references
    const fileMatches = content.match(/(?:[\w/.-]+\.(?:ts|js|tsx|jsx|md|json|css))/g);
    const files = fileMatches || ["unknown"];

    findings.push({
      description: content,
      inScope,
      category,
      files,
    });
  }

  return findings;
}

/** Dispatch Crafter to fix an in-scope Gatekeeper finding */
async function dispatchCrafterFix(
  finding: GatekeeperFinding,
  _cwd: string,
): Promise<void> {
  const crafterDef = agents.getAgent("crafter");
  if (!crafterDef) return;

  const report = await agents.runAgent(
    "crafter",
    `Fix this Gatekeeper finding: ${finding.description}\nFiles affected: ${finding.files.join(", ")}`,
    _cwd,
  );

  const changed = parseChangedFiles(report);
  ledger.recordTouches(
    changed.length > 0 ? changed : finding.files,
    "crafter-fix",
    "write",
  );
}

// ---- Report parsing ----

/**
 * Extract repo-relative file paths a Crafter reports having changed.
 * Crafter is prompted to list changed files one-per-line; we also pick up
 * any inline path-like tokens as a fallback.
 */
function parseChangedFiles(report: string | null): string[] {
  if (!report) return [];
  const matches = report.match(/[\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|html|yml|yaml)/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

// ---- Cleanup ----

/** Abort the current run and reset orchestration state. */
export async function abortRun(): Promise<void> {
  currentRun = null;
  ledger.resetLedger();
}
