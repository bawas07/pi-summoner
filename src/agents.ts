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
import type {
  AgentDefinition,
  AgentInstance,
} from "./types";
import {
  runAgentSession,
  SCOUT_TOOLS,
  CRAFTER_TOOLS,
  GATEKEEPER_TOOLS,
} from "./agent-session";
import { listActivePlans } from "./plan-file";

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
        details: { instanceId, status: "working" },
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

// ---- Scout: isolated read-only search session ----

async function scoutExecute(task: string, ctx: { cwd: string }): Promise<string> {
  return runAgentSession({
    cwd: ctx.cwd,
    tools: SCOUT_TOOLS,
    task:
      `${SCOUT_PROMPT}\n\n` +
      `Search the codebase for the following and report back the minimal relevant ` +
      `slices (file paths + line numbers + the few key lines), never whole files:\n\n${task}`,
  });
}

// ---- Crafter: isolated coding session (read/write/edit/bash) ----

async function crafterExecute(task: string, ctx: { cwd: string }): Promise<string> {
  // Hard constraint (PRD): never let Crafter touch disk without a plan existing.
  // The orchestrator writes the plan file before executing steps, so an active
  // plan is present during a real run; a direct, plan-less Crafter call is refused.
  const activePlans = await listActivePlans();
  if (activePlans.length === 0) {
    throw new Error(
      "Crafter refused: no active plan in docs/tasks/. Draft/approve a plan first " +
        "(run /summoner <task>), then implement.",
    );
  }

  return runAgentSession({
    cwd: ctx.cwd,
    tools: CRAFTER_TOOLS,
    task:
      `${CRAFTER_PROMPT}\n\n` +
      `Implement the following. When done, report concisely WHICH FILES you changed ` +
      `(one per line, repo-relative path) and what you did:\n\n${task}`,
  });
}

// ---- Gatekeeper: isolated read-only verification session (no write/edit) ----

async function gatekeeperExecute(task: string, ctx: { cwd: string }): Promise<string> {
  return runAgentSession({
    cwd: ctx.cwd,
    tools: GATEKEEPER_TOOLS,
    task:
      `${GATEKEEPER_PROMPT}\n\n` +
      `Verify the completed work below. Run tests / functional checks as needed. ` +
      `Report EVERY finding as a line starting with "FINDING:", and mark each as ` +
      `"IN-SCOPE" (caused by this task) or "OUT-OF-SCOPE" (pre-existing). If clean, ` +
      `say so explicitly. You cannot edit files — only report.\n\n${task}`,
  });
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

/** Role → execute fn, so the orchestrator runs agents through the same path as the tools. */
const EXECUTORS: Record<
  string,
  (task: string, ctx: { cwd: string }) => Promise<string>
> = {
  scout: scoutExecute,
  crafter: crafterExecute,
  gatekeeper: gatekeeperExecute,
};

/** Run a built-in agent role to completion, returning its final report text. */
export async function runAgent(
  role: string,
  task: string,
  cwd: string,
): Promise<string> {
  const exec = EXECUTORS[role];
  if (!exec) throw new Error(`Unknown agent role: ${role}`);
  return exec(task, { cwd });
}

export function registerBuiltinAgents(pi: ExtensionAPI): void {
  registerAgent(pi, {
    name: "scout",
    systemPrompt: SCOUT_PROMPT,
    tools: SCOUT_TOOLS,
    canDispatchWithoutApproval: true,
  }, scoutExecute);

  registerAgent(pi, {
    name: "crafter",
    systemPrompt: CRAFTER_PROMPT,
    tools: CRAFTER_TOOLS,
    canDispatchWithoutApproval: false,
  }, crafterExecute);

  registerAgent(pi, {
    name: "gatekeeper",
    systemPrompt: GATEKEEPER_PROMPT,
    tools: GATEKEEPER_TOOLS,
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
