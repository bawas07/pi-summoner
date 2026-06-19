/**
 * planner.ts — Topological sort and phase building from Scout's dependency graph.
 *
 * Converts a DependencyGraph into ordered phases where:
 *   - Files with no mutual dependencies are grouped into the same phase.
 *   - Phases execute sequentially; files within a phase run in parallel.
 *   - Cycles are detected, broken arbitrarily, and flagged as risks.
 *
 * Also handles plan presentation and trust-mode prompting.
 *
 * @see docs/flow.md §3 — Dependency Graph → Phases
 * @see docs/plan.md Phase 2
 */

import type { DependencyGraph } from "../scout/scout";
import { populateFromPlan } from "../core/ledger";

// ── Types ──────────────────────────────────────────────────────────────────

export interface Phase {
  phaseNumber: number;
  files: string[];
  /** True when all files in this phase can be edited concurrently. */
  parallelSafe: boolean;
  /** Label for display (e.g., "Dependency Installation", "Core Changes"). */
  label?: string;
}

export interface Plan {
  phases: Phase[];
  /** Total number of files across all phases. */
  totalFiles: number;
  /** Overall confidence from Scout's analysis. */
  confidence: "high" | "low";
  /** Any cycles that were detected and broken. */
  cycles: string[][];
  /** Risk notes for the user. */
  risks: string[];
  /** Whether Phase 0 (dependency install) is needed. */
  hasPhase0: boolean;
}

// ── Topological Sort (Kahn's Algorithm) ────────────────────────────────────

/**
 * Build ordered phases from a dependency graph.
 *
 * Algorithm: Kahn's algorithm with phase grouping.
 * 1. Compute in-degree for each file (how many deps it has within the graph).
 * 2. Start with files having in-degree 0 → Phase 1.
 * 3. Remove processed files, decrement in-degrees of their dependents.
 * 4. Files that become available concurrently form the next phase.
 * 5. Handle cycles: if stuck, pick an arbitrary file, break the cycle, flag as risk.
 */
export function buildPhases(
  graph: DependencyGraph,
  scopeDir?: string,
): { phases: Phase[]; cycles: string[][] } {
  const files = Object.keys(graph);
  if (files.length === 0) return { phases: [], cycles: [] };

  // Compute in-degree: how many files within the graph does each file import?
  const inDegree: Record<string, number> = {};
  // Adjacency: for each file, which files depend on it?
  // (edge F → D means D depends on F, so D must wait for F)
  const dependents: Record<string, string[]> = {};

  for (const file of files) {
    inDegree[file] = 0;
    dependents[file] = [];
  }

  for (const file of files) {
    const node = graph[file];
    if (!node) continue;

    // Count imports that resolve to files in the graph
    for (const imp of node.imports) {
      if (graph[imp]) {
        inDegree[file] = (inDegree[file] || 0) + 1;
        // file depends on imp → edge imp → file
        dependents[imp] = dependents[imp] || [];
        dependents[imp].push(file);
      }
    }
  }

  // Kahn's algorithm with phase grouping
  const phases: Phase[] = [];
  const cycles: string[][] = [];
  let phaseNum = 1;

  // Track processed files
  const processed = new Set<string>();
  const remaining = new Set(files);

  while (remaining.size > 0) {
    // Find all files with in-degree 0 that haven't been processed
    const ready: string[] = [];
    for (const file of remaining) {
      if ((inDegree[file] || 0) === 0) {
        ready.push(file);
      }
    }

    if (ready.length === 0) {
      // Cycle detected — pick an arbitrary remaining file and break
      const cycleMembers = [...remaining];
      const breakFile = cycleMembers[0];
      cycles.push(cycleMembers);

      // Break the cycle by forcing this file's in-degree to 0
      inDegree[breakFile] = 0;
      continue;
    }

    // All ready files become a phase — they have no unresolved dependencies
    phases.push({
      phaseNumber: phaseNum++,
      files: ready,
      parallelSafe: true,
    });

    // Process: remove from remaining, decrement dependents' in-degree
    for (const file of ready) {
      remaining.delete(file);
      processed.add(file);
      for (const dep of dependents[file] || []) {
        inDegree[dep] = Math.max(0, (inDegree[dep] || 0) - 1);
      }
    }
  }

  return { phases, cycles };
}

// ── Plan Building ──────────────────────────────────────────────────────────

/**
 * Build a complete Plan from Scout's results.
 * Prepends Phase 0 if dependency installation is needed.
 */
export function buildPlan(
  graph: DependencyGraph,
  confidence: "high" | "low",
  needsDeps: boolean = false,
): Plan {
  const { phases, cycles } = buildPhases(graph);

  const risks: string[] = [];

  if (confidence === "low") {
    risks.push(
      "Scout confidence is LOW — some imports may have been missed. " +
        "Unplanned file discoveries are more likely.",
    );
  }

  if (cycles.length > 0) {
    risks.push(
      `${cycles.length} circular dependenc${cycles.length === 1 ? "y" : "ies"} detected. ` +
        "Phases may not fully prevent conflicts. Review carefully.",
    );
  }

  // If dependency installation is needed, prepend Phase 0
  const allPhases = [...phases];
  let hasPhase0 = false;

  if (needsDeps) {
    allPhases.unshift({
      phaseNumber: 0,
      files: ["[Dependency Installation]"],
      parallelSafe: false,
      label: "Dependency Installation",
    });
    hasPhase0 = true;
    // Renumber existing phases
    for (const p of allPhases) {
      if (p.phaseNumber > 0 || p.label) continue;
      p.phaseNumber++;
    }
  }

  const totalFiles = allPhases.reduce((sum, p) => sum + p.files.length, 0);

  return {
    phases: allPhases,
    totalFiles,
    confidence,
    cycles,
    risks,
    hasPhase0,
  };
}

// ── Plan Presentation ──────────────────────────────────────────────────────

/**
 * Format a Plan as human-readable text for presentation to the user.
 */
export function formatPlan(plan: Plan): string {
  const lines: string[] = [];

  lines.push("## Execution Plan");
  lines.push("");

  // Summary
  lines.push(
    `**${plan.totalFiles} file${plan.totalFiles !== 1 ? "s" : ""}** across ` +
      `${plan.phases.length} phase${plan.phases.length !== 1 ? "s" : ""}. ` +
      `Confidence: **${plan.confidence}**.`,
  );
  lines.push("");

  // Phase breakdown
  for (const phase of plan.phases) {
    const label = phase.label || `Phase ${phase.phaseNumber}`;
    const parallel = phase.parallelSafe ? "⚡ parallel-safe" : "🔒 serial";
    lines.push(`### ${label} (${parallel})`);
    lines.push("");

    for (const file of phase.files) {
      lines.push(`- \`${file}\``);
    }
    lines.push("");
  }

  // Risks
  if (plan.risks.length > 0) {
    lines.push("### ⚠️ Risks");
    lines.push("");
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`);
    }
    lines.push("");
  }

  // Cycles
  if (plan.cycles.length > 0) {
    lines.push("### 🔄 Circular Dependencies");
    lines.push("");
    for (const cycle of plan.cycles) {
      lines.push(`- ${cycle.join(" → ")}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Plan → Ledger Population ───────────────────────────────────────────────

/**
 * Populate the Ledger from an approved Plan.
 * All planned files start as "pending" in their assigned phase.
 */
export function approvePlan(plan: Plan): void {
  const planFiles: { path: string; phase: number }[] = [];
  for (const phase of plan.phases) {
    for (const file of phase.files) {
      // Skip the synthetic Phase 0 marker
      if (file === "[Dependency Installation]") continue;
      planFiles.push({ path: file, phase: phase.phaseNumber });
    }
  }
  populateFromPlan(planFiles, plan.phases.length);
}


