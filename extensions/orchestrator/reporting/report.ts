/**
 * report.ts — Final report generation from the Ledger.
 *
 * After all phases execute and Gatekeeper verifies, the Main Agent walks
 * the completed Ledger and synthesizes a human-readable report. There is
 * no separate reporting mechanism — the Ledger IS the data source.
 *
 * @see docs/plan.md Phase 5
 */

import { getAllFiles, type FileEntry } from "../core/ledger";
import type { ClassifiedFailure, GatekeeperAction } from "../gatekeeper/gatekeeper";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReportSection {
  phase: number;
  label: string;
  files: Array<{
    path: string;
    status: string;
    owner: string | null;
    summary?: string;
    discovered?: boolean;
  }>;
}

export interface ReportData {
  sections: ReportSection[];
  totalFiles: number;
  completedFiles: number;
  unplannedFiles: string[];
  testResults?: {
    total: number;
    passed: number;
    failed: number;
    failures: ClassifiedFailure[];
    actions: GatekeeperAction[];
  };
}

// ── Report Generation ─────────────────────────────────────────────────────

/**
 * Build a structured report from the current Ledger state.
 */
export function buildReportData(): ReportData {
  const allFiles = getAllFiles();
  const entries = Object.entries(allFiles);

  // Group by phase
  const byPhase = new Map<number, Array<[string, FileEntry]>>();
  for (const [path, entry] of entries) {
    const phase = entry.phase;
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push([path, entry]);
  }

  // Sort phases
  const sortedPhases = [...byPhase.entries()].sort(([a], [b]) => a - b);

  const sections: ReportSection[] = sortedPhases.map(([phase, files]) => ({
    phase,
    label: phase === 0 ? "Dependency Installation" : `Phase ${phase}`,
    files: files.map(([path, entry]) => ({
      path,
      status: entry.status,
      owner: entry.owner,
      summary: entry.summary,
      discovered: entry.discovered,
    })),
  }));

  const totalFiles = entries.length;
  const completedFiles = entries.filter(([, e]) => e.status === "done").length;
  const unplannedFiles = entries
    .filter(([, e]) => e.discovered)
    .map(([path]) => path);

  return {
    sections,
    totalFiles,
    completedFiles,
    unplannedFiles,
  };
}

/**
 * Format a report as human-readable markdown.
 */
export function formatReport(data: ReportData): string {
  const lines: string[] = [];

  lines.push("# Task Report");
  lines.push("");
  lines.push(
    `**${data.completedFiles}/${data.totalFiles}** files completed.`,
  );
  lines.push("");

  // Phase sections
  for (const section of data.sections) {
    const doneCount = section.files.filter((f) => f.status === "done").length;
    const icon = doneCount === section.files.length ? "✅" : "🔄";

    lines.push(`## ${icon} ${section.label} (${doneCount}/${section.files.length})`);
    lines.push("");

    for (const file of section.files) {
      const statusIcon =
        file.status === "done" ? "✅" :
        file.status === "in_progress" ? "🟢" :
        file.status === "blocked" ? "🟡" :
        file.status === "failed" ? "❌" : "⏳";

      const discovered = file.discovered ? " *(unplanned)*" : "";
      const summary = file.summary ? ` — ${file.summary}` : "";
      const owner = file.owner ? ` [${file.owner}]` : "";

      lines.push(`- ${statusIcon} \`${file.path}\`${owner}${discovered}${summary}`);
    }
    lines.push("");
  }

  // Unplanned discoveries
  if (data.unplannedFiles.length > 0) {
    lines.push("## 🔍 Unplanned Discoveries");
    lines.push("");
    for (const file of data.unplannedFiles) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  // Test results
  if (data.testResults) {
    const tr = data.testResults;
    const icon = tr.failed === 0 ? "✅" : "⚠️";
    lines.push(`## ${icon} Test Results`);
    lines.push("");
    lines.push(`**${tr.passed}/${tr.total}** tests passed.`);

    if (tr.failed > 0) {
      lines.push(`**${tr.failed}** failure(s):`);
      lines.push("");

      for (const failure of tr.failures) {
        lines.push(`- \`${failure.file}\` — ${failure.category}: **${failure.testName}**`);
        lines.push(`  ${failure.message.slice(0, 200)}`);
      }
      lines.push("");

      // Actions
      for (const action of tr.actions) {
        const actionIcon = action.type === "auto-fix" ? "🤖" : "👆";
        lines.push(`### ${actionIcon} ${action.type === "auto-fix" ? "Auto-fixed" : "Needs approval"}`);
        for (const f of action.failures) {
          lines.push(`- \`${f.file}\` — ${f.testName}`);
        }
        lines.push("");
      }
    } else {
      lines.push("All tests passing. ✨");
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Attach Gatekeeper test results to a report.
 */
export function attachTestResults(
  data: ReportData,
  results: {
    total: number;
    passed: number;
    failed: number;
    failures: ClassifiedFailure[];
    actions: GatekeeperAction[];
  },
): ReportData {
  return { ...data, testResults: results };
}
