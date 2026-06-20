/**
 * plan-file.ts — Plan file writer using the structured Plan Request format.
 *
 * Writes to .pi/bulletin/<slug>_<timestamp>.md with:
 *   - Context, Scope, Out of Scope
 *   - Numbered implementation steps with file paths and code snippets
 *   - Files to Modify table
 *   - Verification steps
 *   - TODO checklist (completed items preserved, never deleted)
 *
 * Plan is written BEFORE user acceptance. Updated on every revision.
 *
 * @see commands.ts — /summoner workflow instructions
 */

import { join } from "node:path";
import { getLedger } from "../core/ledger";
import { getTrustMode } from "../core/state";

// ── Plan File Path ───────────────────────────────────────────────────────

export function planFilePath(cwd: string, slug?: string): string {
  const ts = new Date()
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\..+/, "")
    .replace("T", "_");
  const name = slug ? `${slug}_${ts}` : ts;
  return join(cwd, ".pi", "bulletin", `${name}.md`);
}

export function generatePlanSlug(task: string): string {
  const slug = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .replace(/-$/, "");

  return slug || "untitled";
}

// ── Plan Template ────────────────────────────────────────────────────────

/**
 * Generate a Plan Request document following the structured format.
 * This is written before user approval and updated on revisions.
 */
export function generatePlanContent(params: {
  taskName: string;
  context: string;
  scope: string[];
  outOfScope: string[];
  steps: PlanStep[];
  filesToModify: PlanFileChange[];
  verification: string[];
  risks?: string[];
}): string {
  const now = new Date().toISOString();
  const ledger = getLedger();
  const trustMode = getTrustMode();

  const lines: string[] = [];

  // Header
  lines.push(`# Plan Request: ${params.taskName}`);
  lines.push("");
  lines.push(
    "> Instructions for the LLM generating this plan: Follow the structure below exactly. " +
    "Do not skip sections. Keep code snippets minimal and illustrative — actual implementation " +
    "happens after this plan is approved, not inside the plan itself.",
  );
  lines.push("");

  // Context
  lines.push("## Context");
  lines.push("");
  lines.push(params.context);
  lines.push("");

  // Scope
  lines.push("---");
  lines.push("");
  lines.push("## Scope");
  lines.push("");
  lines.push("What this plan SHOULD cover:");
  for (const item of params.scope) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  // Out of Scope
  lines.push("## Out of Scope / What NOT to Do");
  lines.push("");
  for (const item of params.outOfScope) {
    lines.push(`- ${item}`);
  }
  lines.push("");

  // Implementation Steps
  lines.push("---");
  lines.push("");
  lines.push("## Implementation Steps");
  lines.push("");

  for (let i = 0; i < params.steps.length; i++) {
    const step = params.steps[i];

    lines.push(`### ${i + 1}. ${step.title} — \`${step.file}\``);
    lines.push("");

    if (step.description) {
      lines.push(step.description);
      lines.push("");
    }

    if (step.code) {
      lines.push("```" + (step.language || "typescript"));
      lines.push(step.code);
      lines.push("```");
      lines.push("");
    }

    if (step.logic && step.logic.length > 0) {
      lines.push("Logic:");
      for (let j = 0; j < step.logic.length; j++) {
        lines.push(`${j + 1}. ${step.logic[j]}`);
      }
      lines.push("");
    }

    if (step.note) {
      lines.push(`> ${step.note}`);
      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  // Files to Modify
  lines.push("## Files to Modify");
  lines.push("");
  lines.push("| File | Change |");
  lines.push("|---|---|");
  for (const f of params.filesToModify) {
    const entry = ledger.files[f.path];
    const statusIcon =
      entry?.status === "done" ? " ✅" :
      entry?.status === "in_progress" ? " 🟢" :
      entry?.status === "failed" ? " ❌" : "";
    lines.push(`| \`${f.path}\` | ${f.change}${statusIcon} |`);
  }
  lines.push("");

  // Risks
  if (params.risks && params.risks.length > 0) {
    lines.push("## ⚠️ Risks");
    lines.push("");
    for (const risk of params.risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  // Verification
  lines.push("---");
  lines.push("");
  lines.push("## Verification");
  lines.push("");

  for (let i = 0; i < params.verification.length; i++) {
    lines.push(`${i + 1}. ${params.verification[i]}`);
  }
  lines.push("");

  // Trust Mode
  lines.push("---");
  lines.push("");
  lines.push("## Trust Mode");
  lines.push("");
  lines.push(
    `${trustMode === "trust" ? "🙈 Trust" : "🔍 Checkpoint"} — ` +
    (trustMode === "trust"
      ? "auto-proceed on in-scope issues, auto-fix test failures"
      : "ask before every significant action"),
  );
  lines.push("");

  // TODO Checklist
  lines.push("---");
  lines.push("");
  lines.push("## TODO Checklist");
  lines.push("");

  // Build todo from steps and files
  const todoItems: string[] = [];

  // Add file-level todos
  for (const f of params.filesToModify) {
    const entry = ledger.files[f.path];
    const checked = entry?.status === "done" ? "x" : " ";
    todoItems.push(`- [${checked}] \`${f.path}\` — ${f.change}`);
    // Also add a test todo for each file
    todoItems.push(`- [ ] Write tests for \`${f.path}\` (unit / integration / e2e)`);
  }

  // Add verification todos
  for (const v of params.verification) {
    todoItems.push(`- [ ] ${v}`);
  }

  // Add general todos
  const generalTodos = [
    "Confirm scope and out-of-scope boundaries with reviewer before starting",
    "Run full test suite — confirm all green",
    "Self-review diff against Out-of-Scope list before PR",
  ];

  for (const t of generalTodos) {
    todoItems.push(`- [ ] ${t}`);
  }

  lines.push(todoItems.join("\n"));
  lines.push("");

  // Footer
  lines.push("---");
  lines.push("");
  lines.push(`> Generated by Agent Summoner | ${now}`);
  lines.push("> *Completed tasks are preserved. Requirements can be updated — done items will not be removed.*");
  lines.push("");

  return lines.join("\n");
}

// ── Types ────────────────────────────────────────────────────────────────

export interface PlanStep {
  title: string;
  file: string;
  description?: string;
  code?: string;
  language?: string;
  logic?: string[];
  note?: string;
}

export interface PlanFileChange {
  path: string;
  change: string;
}

// ── Plan Parsing (for reconciliation) ───────────────────────────────────

export interface ParsedTodo {
  checked: boolean;
  text: string;
  file?: string;
}

export interface ParsedPlan {
  taskName: string;
  filesToModify: Array<{ path: string; change: string; done: boolean }>;
  todos: ParsedTodo[];
  doneCount: number;
  totalCount: number;
}

/**
 * Parse an existing plan file to extract TODOs and file status.
 * Used for session continuation — understanding what's done vs remaining.
 */
export function parsePlanFile(content: string): ParsedPlan {
  // Extract task name from header
  const titleMatch = content.match(/^# Plan Request: (.+)$/m);
  const taskName = titleMatch ? titleMatch[1].trim() : "Unknown";

  // Extract todos from the TODO Checklist section
  const todoSection = content.match(/## TODO Checklist\n\n([\s\S]*?)(?:\n---|\n> Generated|$)/);
  const todos: ParsedTodo[] = [];

  if (todoSection) {
    const todoLines = todoSection[1].split("\n");
    for (const line of todoLines) {
      const match = line.match(/^- \[([ x])\] (.+)$/);
      if (match) {
        const checked = match[1] === "x";
        const text = match[2].trim();
        // Extract file path if present: `file.ts` — description
        const fileMatch = text.match(/^`([^`]+)`/);
        todos.push({
          checked,
          text,
          file: fileMatch ? fileMatch[1] : undefined,
        });
      }
    }
  }

  // Extract files from the Files to Modify table
  const tableSection = content.match(/## Files to Modify\n\n\| File \| Change \|\n\|[| -]+\|\n([\s\S]*?)(?:\n\n|$)/);
  const filesToModify: Array<{ path: string; change: string; done: boolean }> = [];

  if (tableSection) {
    const rows = tableSection[1].split("\n");
    for (const row of rows) {
      const match = row.match(/^\| `([^`]+)` \| (.+?)(?: ✅| 🟢| ❌)? \|$/);
      if (match) {
        const done = row.includes("✅");
        filesToModify.push({
          path: match[1].trim(),
          change: match[2].trim(),
          done,
        });
      }
    }
  }

  const doneCount = todos.filter((t) => t.checked).length;
  const totalCount = todos.length;

  return { taskName, filesToModify, todos, doneCount, totalCount };
}

// ── Todo Update ──────────────────────────────────────────────────────────

/**
 * Update only the TODO checklist section of an existing plan file.
 * Preserves all other sections; only changes checkbox states.
 */
export function updatePlanTodos(existingContent: string): string {
  const ledger = getLedger();

  let updated = existingContent;

  for (const [filePath, entry] of Object.entries(ledger.files)) {
    const checked = entry.status === "done" ? "x" : " ";

    // Match: `- [ ] \`filePath\` — ...` or `- [x] \`filePath\` — ...`
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      `(- \\[)([ x])(\\] \`${escaped}\` —)`,
      "g",
    );

    updated = updated.replace(pattern, `$1${checked}$3`);
  }

  // Update timestamp
  const now = new Date().toISOString();
  updated = updated.replace(
    /> Generated by Agent Summoner \| .*/,
    `> Generated by Agent Summoner | ${now} (updated)`,
  );

  return updated;
}
