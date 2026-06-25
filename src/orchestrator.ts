/**
 * Orchestrator — the Main Agent loop.
 *
 * This is the core decision engine. It owns all mutable orchestration state —
 * no sub-agent or Gatekeeper instance holds its own conflicting view of progress.
 *
 * Two entry paths:
 *   - Ambient: trigger.ts's TriggerResult from the turn_start hook
 *   - Manual: /summoner <task> command bypassing ambient detection
 *
 * Phase 1: sequential-only, no tmux, hardcoded model, heuristics-based trigger.
 */

import type {
  TriggerResult,
  PlanFile,
  PlanStep,
  TrustMode,
  GatekeeperFinding,
} from "./types";
import * as planFile from "./plan-file";
import * as ledger from "./ledger";
import * as agents from "./agents";
import type { SubprocessClient, RpcResponse } from "./rpc-client";
import { spawnSubprocess } from "./rpc-client";

// ---- Logging ----

function log(msg: string): void { console.log(`[summoner] ${msg}`); }
function warn(msg: string): void { console.warn(`[summoner] ${msg}`); }
function err(msg: string): void { console.error(`[summoner] ${msg}`); }

// ---- Orchestrator State ----

interface RunState {
  plan: PlanFile | null;
  trustMode: TrustMode;
  currentStep: number;
  activeClient: SubprocessClient | null;
  triggeredBy: "ambient" | "manual";
  /** Scout findings from the most recent dispatch, fed into plan drafting */
  lastScoutResult: string | null;
  /** Pending approval — set when waiting for user response */
  pendingApproval: {
    plan: PlanFile;
    resolve: (result: ApprovalResult) => void;
  } | null;
}

let currentRun: RunState | null = null;

// ---- 7.1 Core entry point ----

export async function handleTrigger(
  trigger: TriggerResult,
  task: string,
  ctx: { cwd: string },
): Promise<void> {
  // If awaiting approval, check if this turn is the user's response
  if (currentRun?.pendingApproval) {
    const response = parseApprovalResponse(task);
    currentRun.pendingApproval.resolve(response);
    return;
  }

  // If already in a run, don't start another
  if (currentRun && currentRun.plan) {
    // But Scout can still dispatch mid-run
    if (trigger.needsScout && !trigger.implementIntent) {
      const scoutResult = await dispatchScout(task, ctx.cwd);
      if (currentRun) currentRun.lastScoutResult = scoutResult;
    }
    return;
  }

  // Scout-only: dispatch immediately, no approval
  if (trigger.needsScout && !trigger.implementIntent) {
    await dispatchScout(task, ctx.cwd);
    return;
  }

  // Implement intent: start the heavy loop
  if (trigger.implementIntent) {
    await startLoop(task, ctx);
  }
}

// ---- 7.7 Manual override (/summoner) ----

export async function handleManualSummon(
  task: string,
  ctx: { cwd: string },
): Promise<void> {
  // If awaiting approval, check if this turn is the user's response
  if (currentRun?.pendingApproval) {
    const response = parseApprovalResponse(task);
    currentRun.pendingApproval.resolve(response);
    return;
  }

  // If already in a run, warn
  if (currentRun && currentRun.plan) {
    warn(
      `Already running plan: ${currentRun.plan.title}. Complete or abort it first.`,
    );
    return;
  }

  // Force implementIntent = true, skip ambient trigger
  await startLoop(task, ctx);
}

// ---- Internal: start the heavy loop ----

async function startLoop(
  task: string,
  ctx: { cwd: string },
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

  // 7.2 Present for approval + set trust mode
  const approval = await requestApproval(plan);
  if (!approval.approved) {
    if (approval.feedback) {
      // User wants revisions — redraft
      plan = await draftPlan(`${task}\n\nFeedback: ${approval.feedback}`, null, ctx.cwd);
      const reApproval = await requestApproval(plan);
      if (!reApproval.approved) {
        err("Plan rejected. Aborting.");
        return;
      }
      plan.trustMode = reApproval.trustMode;
    } else {
      err("Plan rejected. Aborting.");
      return;
    }
  } else {
    plan.trustMode = approval.trustMode;
  }

  // Initialize run state
  currentRun = {
    plan,
    trustMode: approval.trustMode,
    currentStep: 0,
    activeClient: null,
    triggeredBy: "ambient",
    lastScoutResult: null,
    pendingApproval: null,
  };

  // 7.3 Execute steps sequentially
  await executeSteps(ctx);

  // 7.5 Always run Gatekeeper after all steps
  await runGatekeeper(ctx);

  // 7.6 Archive on completion
  await planFile.archive(plan.path);
  log(`Task complete! Plan archived: ${plan.title}`);

  // Reset state
  currentRun = null;
  ledger.resetLedger();
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

// ---- Approval flow ----

interface ApprovalResult {
  approved: boolean;
  trustMode: TrustMode;
  feedback?: string;
}

/**
 * GAP 4 FIX: Real approval flow that waits for user response.
 *
 * In Phase 1, approval uses pi's notification system. The function
 * presents the plan and returns a promise that resolves when the
 * user responds (detected on the next turn_start).
 */
async function requestApproval(
  plan: PlanFile,
): Promise<ApprovalResult> {
  const stepList = plan.steps
    .map((s, i) => `  ${i + 1}. [${s.done ? "x" : " "}] ${s.description}`)
    .join("\n");

  log(
    `📋 **Plan: ${plan.title}**\n\n` +
      `${stepList}\n\n` +
      `Reply with:\n` +
      `  "go" or "trust" — approve with 🙈 trust mode (auto-proceed)\n` +
      `  "step" or "check" — approve with 🔍 checkpoint mode (confirm each step)\n` +
      `  "no" or describe changes — reject/revise`,
  );

  // GAP 4: Return a promise that resolves when the user responds.
  // The response is captured on the next turn_start or /summoner invocation.
  return new Promise<ApprovalResult>((resolve) => {
    if (!currentRun) {
      // Edge case: no run state yet, set up pending approval
      const pendingState: RunState = {
        plan,
        trustMode: "checkpoint",
        currentStep: 0,
        activeClient: null,
        triggeredBy: "ambient",
        lastScoutResult: null,
        pendingApproval: {
          plan,
          resolve: (result: ApprovalResult) => {
            // Clean up the pending state
            const state = currentRun;
            if (state) state.pendingApproval = null;
            resolve(result);
          },
        },
      };
      currentRun = pendingState;
    } else {
      currentRun.pendingApproval = {
        plan,
        resolve: (result: ApprovalResult) => {
          if (currentRun) currentRun.pendingApproval = null;
          resolve(result);
        },
      };
    }
  });
}

/** Parse the user's approval response from a message */
function parseApprovalResponse(message: string): ApprovalResult {
  const trimmed = message.trim().toLowerCase();

  // Trust mode keywords
  if (/^(go|trust|yes|approve|proceed)$/.test(trimmed)) {
    return { approved: true, trustMode: "trust" };
  }

  // Checkpoint mode keywords
  if (/^(step|check|checkpoint|confirm)$/.test(trimmed)) {
    return { approved: true, trustMode: "checkpoint" };
  }

  // Rejection — anything else is treated as feedback for revision
  return { approved: false, trustMode: "checkpoint", feedback: message };
}

// ---- Step execution loop ----

/**
 * GAP 1 FIX: Ledger is now consulted before every Crafter summon.
 * Previously-touched files are included in the prompt context.
 */
async function executeSteps(
  ctx: { cwd: string },
): Promise<void> {
  if (!currentRun?.plan) return;

  const plan = currentRun.plan;

  for (let i = 0; i < plan.steps.length; i++) {
    currentRun.currentStep = i;
    const step = plan.steps[i];

    if (step.done) continue;

    // Checkpoint mode: pause and wait for user
    if (currentRun.trustMode === "checkpoint" && i > 0) {
      log(
        `🔍 Step ${i + 1}/${plan.steps.length}: ${step.description}\nProceed? Reply "go" or "skip".`,
      );
      // In checkpoint mode, the orchestrator pauses here.
      // The user's next message is captured by the approval flow.
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

    const client = spawnSubprocess(crafterDef.defaultModel, crafterDef.defaultThinking);
    currentRun.activeClient = client;

    try {
      await client.send({
        id: `crafter-step-${i}`,
        type: "prompt",
        content: promptWithContext,
      });

      // Update state
      step.done = true;
      await planFile.checkOffStep(plan.path, i);
      ledger.recordTouch(plan.path, `crafter-${i + 1}`, "write");

      log(`✓ Step ${i + 1} complete: ${step.description}`);
    } catch (err) {
      err(
        `✗ Step ${i + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    } finally {
      await client.terminate();
      currentRun.activeClient = null;
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

  const client = spawnSubprocess(scoutDef.defaultModel, scoutDef.defaultThinking);
  try {
    const response = await client.send({
      id: "scout-1",
      type: "prompt",
      content: task,
    });

    ledger.recordTouch("scout-results", "scout-1", "read");

    // Extract text content from the RPC response
    return extractTextContent(response);
  } catch (err) {
    console.error(
      `[orchestrator] Scout failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    await client.terminate();
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

  const client = spawnSubprocess(
    gatekeeperDef.defaultModel,
    gatekeeperDef.defaultThinking,
  );

  try {
    const response = await client.send({
      id: "gatekeeper-1",
      type: "prompt",
      content: "Review the completed work. Report all findings.",
    });

    // GAP 2: Parse findings from the actual response text
    const responseText = extractTextContent(response);
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
  } finally {
    await client.terminate();
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

  const client = spawnSubprocess(crafterDef.defaultModel, crafterDef.defaultThinking);
  try {
    await client.send({
      id: "crafter-fix",
      type: "prompt",
      content: `Fix this Gatekeeper finding: ${finding.description}\nFiles affected: ${finding.files.join(", ")}`,
    });

    for (const file of finding.files) {
      ledger.recordTouch(file, "crafter-fix", "write");
    }
  } finally {
    await client.terminate();
  }
}

// ---- RPC Response Helpers ----

/** Extract text content from an RPC response object */
function extractTextContent(response: RpcResponse): string | null {
  // Try common response shapes from pi's RPC mode
  const resp = response as Record<string, unknown>;

  if (typeof resp.result === "string") return resp.result;
  if (typeof resp.content === "string") return resp.content;
  if (typeof resp.text === "string") return resp.text;

  // Content array (MCP-style)
  if (Array.isArray(resp.content)) {
    const texts = (resp.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!);
    if (texts.length > 0) return texts.join("\n");
  }

  // Fallback: stringify the whole response for inspection
  try {
    return JSON.stringify(response, null, 2);
  } catch {
    return null;
  }
}

// ---- Cleanup ----

/** Abort the current run, killing any active subprocess */
export async function abortRun(): Promise<void> {
  if (currentRun?.activeClient) {
    await currentRun.activeClient.terminate();
  }
  currentRun = null;
  ledger.resetLedger();
}

/** Check if orchestrator is currently awaiting user approval */
export function isAwaitingApproval(): boolean {
  return currentRun?.pendingApproval !== null && currentRun?.pendingApproval !== undefined;
}
