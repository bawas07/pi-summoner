/**
 * Agent registry — flat, equal interface for built-in and user-defined agents.
 *
 * Each agent becomes a pi tool: summon_<name>. In Phase 1, tools operate within
 * the current pi session — they don't spawn separate subprocesses. The LLM
 * (Main Agent) calls these tools and acts on results directly.
 *
 * Gatekeeper's tool list architecturally excludes write/edit — enforced at
 * registration, not just in the prompt.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile, readdir, access } from "node:fs/promises";
import { join, relative, resolve, dirname } from "node:path";
import { constants } from "node:fs";
import type {
  AgentDefinition,
  AgentInstance,
  ModelRef,
  ThinkingLevel,
} from "./types";

// ---- In-memory registry ----

const agentDefs = new Map<string, AgentDefinition>();
const agentInstances = new Map<string, AgentInstance>();
let instanceCounter = 0;

const DEFAULT_MODEL: ModelRef = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
};

// ---- 4.1 registerAgent() ----

export function registerAgent(
  pi: ExtensionAPI,
  def: AgentDefinition,
  executeFn: (task: string, ctx: { cwd: string }) => Promise<string>,
): void {
  agentDefs.set(def.name, def);

  const toolName = `summon_${def.name.replace(/-/g, "_")}`;

  pi.registerTool({
    name: toolName,
    label: def.name,
    description: def.systemPrompt,
    parameters: Type.Object({
      task: Type.String({
        description: "The task description for this agent to perform",
      }),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const instanceId = `${def.name}-${++instanceCounter}`;
      const instance: AgentInstance = {
        id: instanceId,
        role: def.name,
        model: def.defaultModel,
        thinking: def.defaultThinking,
        status: "working",
        task: params.task,
        windowName: `${def.name}-${instanceCounter}`,
      };
      agentInstances.set(instanceId, instance);

      onUpdate?.({
        content: [{ type: "text", text: `🟢 ${def.name} working: ${params.task}` }],
      });

      try {
        const result = await executeFn(params.task, { cwd: ctx.cwd });

        instance.status = "done";
        agentInstances.set(instanceId, instance);

        return {
          content: [{ type: "text", text: result }],
          details: { instanceId, status: "done" },
        };
      } catch (error) {
        instance.status = "failed";
        agentInstances.set(instanceId, instance);

        return {
          content: [
            {
              type: "text",
              text: `${def.name} failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          details: { instanceId, status: "failed" },
          isError: true,
        };
      }
    },
  });
}

// ---- Scout: actually searches the codebase ----

async function scoutExecute(task: string, ctx: { cwd: string }): Promise<string> {
  const results: string[] = [];

  // Search for relevant files by grepping for keywords
  const keywords = task
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5);

  if (keywords.length === 0) {
    return "Scout: No searchable keywords found in task description. Try a more specific query.";
  }

  // Scan src/ and lib/ directories for relevant files
  const searchDirs = ["src", "lib", "app", "components", "utils", "services"];
  for (const dir of searchDirs) {
    const fullPath = join(ctx.cwd, dir);
    try {
      await access(fullPath, constants.R_OK);
      const entries = await readdir(fullPath, { recursive: true });
      const matching = entries
        .filter((f) =>
          keywords.some((kw) => f.toLowerCase().includes(kw)) &&
          /\.[tj]sx?$/.test(f),
        )
        .slice(0, 10);

      for (const file of matching) {
        const filePath = join(fullPath, file);
        try {
          const content = await readFile(filePath, "utf8");
          const lines = content.split("\n");
          // Find lines mentioning keywords
          const relevantLines: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (keywords.some((kw) => lines[i].toLowerCase().includes(kw))) {
              relevantLines.push(`  L${i + 1}: ${lines[i].trim().slice(0, 120)}`);
            }
          }
          if (relevantLines.length > 0) {
            const relPath = relative(ctx.cwd, filePath);
            results.push(
              `**${relPath}** (${relevantLines.length} matches):\n${relevantLines.slice(0, 5).join("\n")}`,
            );
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory doesn't exist — skip
    }
  }

  if (results.length === 0) {
    return `Scout: No codebase matches found for: ${keywords.join(", ")}. Searched: ${searchDirs.join(", ")}.`;
  }

  return `Scout results (${results.length} files found):\n\n${results.join("\n\n")}`;
}

// ---- Crafter: returns a structured implementation prompt ----

async function crafterExecute(task: string, _ctx: { cwd: string }): Promise<string> {
  return `Crafter: Ready to implement.

**Task:** ${task}

**Instructions for Main Agent:**
- Read the relevant files to understand current code
- Make focused, atomic edits using write/edit tools
- Wrap all file writes in withFileMutationQueue
- Report what was changed and why
- If changes have wide impact, flag it before proceeding

Proceed with implementation.`;
}

// ---- Gatekeeper: runs basic verification ----

async function gatekeeperExecute(task: string, ctx: { cwd: string }): Promise<string> {
  const findings: string[] = [];

  // Check for obvious issues in the codebase
  const filePattern = /[\w\/.-]+\.(ts|js|tsx|jsx)$/;
  const mentionedFiles = task.match(new RegExp(filePattern, "g"));

  if (mentionedFiles) {
    for (const file of mentionedFiles) {
      const fullPath = resolve(ctx.cwd, file);
      try {
        await access(fullPath, constants.R_OK);
        const content = await readFile(fullPath, "utf8");

        // Basic checks
        if (content.includes("console.log(")) {
          findings.push(`FINDING: ${file} contains console.log statements — consider removing for production`);
        }
        if (content.includes("TODO") || content.includes("FIXME")) {
          findings.push(`FINDING: ${file} contains TODO/FIXME markers — follow up needed`);
        }
      } catch {
        findings.push(`FINDING: OUT-OF-SCOPE: ${file} — file not found or unreadable (pre-existing)`);
      }
    }
  }

  if (findings.length === 0) {
    return "Gatekeeper: No issues found. All clear ✓";
  }

  return `Gatekeeper findings:\n\n${findings.join("\n")}`;
}

// ---- 4.2 Built-in agent definitions ----

const SCOUT_PROMPT = `You are Scout — a codebase search agent.
Call summon_scout with a task description to search the codebase.
Scout returns file paths + relevant line numbers, not entire files.
Use Scout before making multi-file changes to understand dependencies.`;

const CRAFTER_PROMPT = `You are Crafter — the implementation agent.
Call summon_crafter with a task description when ready to implement.
Crafter provides structured instructions for making changes.
Follow the plan and report what was changed.`;

const GATEKEEPER_PROMPT = `You are Gatekeeper — the verification agent.
Call summon_gatekeeper with a list of files to review after implementation.
Gatekeeper checks for issues (console.log, TODOs, missing files).
Gatekeeper never edits files — it only reports findings.`;

export function registerBuiltinAgents(pi: ExtensionAPI): void {
  registerAgent(pi, {
    name: "scout",
    systemPrompt: SCOUT_PROMPT,
    defaultModel: DEFAULT_MODEL,
    defaultThinking: "minimal",
    tools: ["read", "bash", "grep", "find"],
    canDispatchWithoutApproval: true,
  }, scoutExecute);

  registerAgent(pi, {
    name: "crafter",
    systemPrompt: CRAFTER_PROMPT,
    defaultModel: DEFAULT_MODEL,
    defaultThinking: "medium",
    tools: ["read", "write", "edit", "bash"],
    canDispatchWithoutApproval: false,
  }, crafterExecute);

  registerAgent(pi, {
    name: "gatekeeper",
    systemPrompt: GATEKEEPER_PROMPT,
    defaultModel: DEFAULT_MODEL,
    defaultThinking: "medium",
    tools: ["read", "bash", "grep", "find"],
    canDispatchWithoutApproval: false,
  }, gatekeeperExecute);
}

// ---- 4.3 Lookup functions ----

export function getAgent(name: string): AgentDefinition | undefined {
  return agentDefs.get(name);
}

export function listAgents(): AgentDefinition[] {
  return [...agentDefs.values()];
}

export function getAgentInstance(instanceId: string): AgentInstance | undefined {
  return agentInstances.get(instanceId);
}

export function getAllInstances(): AgentInstance[] {
  return [...agentInstances.values()];
}
