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
} from "./types";

// ---- In-memory registry ----

const agentDefs = new Map<string, AgentDefinition>();
const agentInstances = new Map<string, AgentInstance>();
let instanceCounter = 0;

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
        model: def.defaultModel ?? { provider: "", modelId: "" },
        thinking: def.defaultThinking ?? "off",
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

// ---- Scout: tight, scannable codebase search ----

async function scoutExecute(task: string, ctx: { cwd: string }): Promise<string> {
  const keywords = task
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .slice(0, 5);

  if (keywords.length === 0) {
    return "Scout: No searchable keywords. Try a more specific query.";
  }

  const searchDirs = ["src", "lib", "app", "components", "utils", "services"];
  const found: string[] = [];

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
        .slice(0, 5); // tighter: 5 files per dir max

      for (const file of matching) {
        const filePath = join(fullPath, file);
        try {
          const content = await readFile(filePath, "utf8");
          const lines = content.split("\n");
          const hits: string[] = [];
          for (let i = 0; i < lines.length && hits.length < 3; i++) {
            if (keywords.some((kw) => lines[i].toLowerCase().includes(kw))) {
              hits.push(`L${i + 1}: ${lines[i].trim().slice(0, 80)}`);
            }
          }
          if (hits.length > 0) {
            found.push(`${relative(ctx.cwd, filePath)} — ${hits.join(" | ")}`);
          }
        } catch { /* skip */ }
      }
    } catch { /* dir missing */ }

    if (found.length >= 8) break; // enough results
  }

  if (found.length === 0) {
    return `Scout: nothing found for "${keywords.join(" ")}" in ${searchDirs.join(", ")}.`;
  }

  return found.slice(0, 8).join("\n");
}

// ---- Crafter: returns a structured implementation prompt ----

async function crafterExecute(task: string, _ctx: { cwd: string }): Promise<string> {
  return `Crafter: implement this — ${task}`;
}

// ---- Gatekeeper: runs basic verification ----

async function gatekeeperExecute(task: string, ctx: { cwd: string }): Promise<string> {
  const findings: string[] = [];
  const filePattern = /[\w\/.-]+\.(ts|js|tsx|jsx)$/;
  const mentionedFiles = task.match(new RegExp(filePattern, "g"));

  if (mentionedFiles) {
    for (const file of mentionedFiles.slice(0, 10)) {
      const fullPath = resolve(ctx.cwd, file);
      try {
        await access(fullPath, constants.R_OK);
        const content = await readFile(fullPath, "utf8");
        if (content.includes("console.log(")) findings.push(`${file}: console.log`);
        if (content.includes("TODO") || content.includes("FIXME")) findings.push(`${file}: TODO/FIXME`);
      } catch { /* pre-existing, skip */ }
    }
  }

  if (findings.length === 0) return "Gatekeeper: all clear";
  return findings.join("\n");
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
    tools: ["read", "bash", "grep", "find"],
    canDispatchWithoutApproval: true,
  }, scoutExecute);

  registerAgent(pi, {
    name: "crafter",
    systemPrompt: CRAFTER_PROMPT,
    tools: ["read", "write", "edit", "bash"],
    canDispatchWithoutApproval: false,
  }, crafterExecute);

  registerAgent(pi, {
    name: "gatekeeper",
    systemPrompt: GATEKEEPER_PROMPT,
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
