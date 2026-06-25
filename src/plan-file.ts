/**
 * Plan file persistence — the one piece of disk-writing Main Agent does directly.
 *
 * Plans live in docs/tasks/{timestamp}-{short-title}.md as markdown checklists.
 * On completion, they move to docs/tasks/archived/.
 *
 * This is the persisted, glanceable record of what the orchestrator is doing,
 * separate from the Ledger's file-level conflict-avoidance tracking.
 */

import { readFile, writeFile, readdir, rename, mkdir, access } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { constants } from "node:fs";
import type { PlanFile, PlanStep, TrustMode } from "./types";

// ---- Constants ----

const PLANS_DIR = "docs/tasks";
const ARCHIVE_DIR = "docs/tasks/archived";

/** CWD-relative, set once by index.ts at init */
let cwd: string;

export function initPlanFiles(projectRoot: string): void {
  cwd = projectRoot;
}

function plansDir(): string {
  return join(cwd, PLANS_DIR);
}

function archiveDir(): string {
  return join(cwd, ARCHIVE_DIR);
}

// ---- Helpers ----

function toKebabCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildFilename(title: string): string {
  return `${formatTimestamp()}-${toKebabCase(title)}.md`;
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await access(dirPath, constants.F_OK);
  } catch {
    await mkdir(dirPath, { recursive: true });
  }
}

// ---- 3.1 write() ----

export async function write(
  title: string,
  steps: PlanStep[],
  trustMode: TrustMode = "checkpoint",
): Promise<PlanFile> {
  await ensureDir(plansDir());
  await ensureDir(archiveDir());

  const filename = buildFilename(title);
  const path = join(plansDir(), filename);
  const createdAt = new Date().toISOString();

  // Build markdown content
  const trustIcon = trustMode === "trust" ? "🙈" : "🔍";
  const checkedOff = steps.filter((s) => s.done).length;

  const content = [
    `# ${title}`,
    "",
    `> **Created:** ${createdAt}  `,
    `> **Trust mode:** ${trustIcon} ${trustMode}  `,
    `> **Progress:** ${checkedOff}/${steps.length} steps`,
    "",
    "## Steps",
    "",
    ...steps.map((s) => `- [${s.done ? "x" : " "}] ${s.description}`),
    "",
  ].join("\n");

  await writeFile(path, content, "utf8");

  return { path, title, createdAt, trustMode, steps };
}

// ---- 3.2 findExisting() ----

export async function findExisting(
  taskDescription: string,
): Promise<PlanFile | null> {
  await ensureDir(plansDir());

  let files: string[];
  try {
    files = await readdir(plansDir());
  } catch {
    return null;
  }

  const planFiles = files.filter((f) => f.endsWith(".md"));

  // Simple heuristic: check if any plan file's title or content
  // mentions the task description keywords. This is intentionally
  // lightweight — the orchestrator can present multiple matches to
  // the user for confirmation.
  for (const file of planFiles) {
    const fullPath = join(plansDir(), file);
    try {
      const content = await readFile(fullPath, "utf8");
      const titleLine = content.split("\n")[0]?.replace(/^# /, "") || "";
      const lowerContent = content.toLowerCase();
      const lowerTask = taskDescription.toLowerCase();

      // Match against title or body
      if (
        lowerContent.includes(lowerTask) ||
        titleLine.toLowerCase().includes(lowerTask)
      ) {
        return parsePlanFile(fullPath);
      }
    } catch {
      continue;
    }
  }

  return null;
}

/** List all active plan files for the orchestrator to choose from */
export async function listActivePlans(): Promise<PlanFile[]> {
  await ensureDir(plansDir());

  let files: string[];
  try {
    files = await readdir(plansDir());
  } catch {
    return [];
  }

  const plans: PlanFile[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    try {
      const plan = await parsePlanFile(join(plansDir(), file));
      if (plan) plans.push(plan);
    } catch {
      continue;
    }
  }

  return plans;
}

// ---- 3.3 checkOffStep() ----

export async function checkOffStep(
  planPath: string,
  stepIndex: number,
): Promise<void> {
  const content = await readFile(planPath, "utf8");
  const lines = content.split("\n");

  let checklistLineCount = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^- \[[ x]\] /)) {
      if (checklistLineCount === stepIndex) {
        lines[i] = lines[i].replace(/^- \[ \] /, "- [x] ");
      }
      checklistLineCount++;
    }
  }

  // Update progress counter in the header
  const total = checklistLineCount;
  const doneCount = lines.filter((l) => l.match(/^- \[x\] /)).length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("> **Progress:**")) {
      lines[i] = `> **Progress:** ${doneCount}/${total} steps`;
      break;
    }
  }

  await writeFile(planPath, lines.join("\n"), "utf8");
}

// ---- 3.4 archive() ----

export async function archive(planPath: string): Promise<string> {
  await ensureDir(archiveDir());

  const filename = basename(planPath);
  const archivePath = join(archiveDir(), filename);

  await rename(planPath, archivePath);
  return archivePath;
}

// ---- Internal: parse a plan file back into PlanFile object ----

async function parsePlanFile(fullPath: string): Promise<PlanFile | null> {
  const content = await readFile(fullPath, "utf8");
  const lines = content.split("\n");

  const title = lines[0]?.replace(/^# /, "") || basename(fullPath, ".md");

  // Extract trust mode
  let trustMode: TrustMode = "checkpoint";
  for (const line of lines) {
    const match = line.match(/^\> \*\*Trust mode:\*\* .+ (trust|checkpoint)/);
    if (match) {
      trustMode = match[1] as TrustMode;
      break;
    }
  }

  // Extract steps
  const steps: PlanStep[] = [];
  for (const line of lines) {
    const match = line.match(/^- \[(.)\] (.+)$/);
    if (match) {
      steps.push({
        description: match[2],
        done: match[1] === "x",
      });
    }
  }

  // Extract creation date from filename
  const filename = basename(fullPath, extname(fullPath));
  const dateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
  const createdAt = dateMatch ? dateMatch[1] : "";

  return { path: fullPath, title, createdAt, trustMode, steps };
}
