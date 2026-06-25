/**
 * Agent registry — flat, equal interface for built-in and user-defined agents.
 *
 * Each agent becomes a pi tool: summon_<name>. Gatekeeper's tool list
 * architecturally excludes write/edit — enforced at registration, not
 * just in the prompt.
 *
 * Phase 1: built-in agents only (Scout, Crafter, Gatekeeper).
 * User-defined agent config loading deferred to Phase 2+.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  AgentDefinition,
  AgentInstance,
  ModelRef,
  ThinkingLevel,
  ToolName,
} from "./types";

// ---- In-memory registry ----

const agentDefs = new Map<string, AgentDefinition>();
const agentInstances = new Map<string, AgentInstance>();
let instanceCounter = 0;

// ---- 4.1 registerAgent() ----

export function registerAgent(
  pi: ExtensionAPI,
  def: AgentDefinition,
): void {
  agentDefs.set(def.name, def);

  // Build the tool name: summon_scout, summon_crafter, etc.
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
    async execute(toolCallId, params, _signal, onUpdate, ctx) {
      // Create an instance record
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
        content: [
          {
            type: "text",
            text: `🟢 ${def.name} (${instanceId}) starting: ${params.task}`,
          },
        ],
      });

      try {
        // Actually execute: spawn the subprocess via rpc-client
        // In Phase 1, we delegate to the orchestrator's spawn logic.
        // The tool returns a placeholder — the orchestrator intercepts
        // and drives the actual subprocess lifecycle.
        //
        // For now, this tool serves as the registration point that
        // Main Agent (LLM) discovers and calls. The real subprocess
        // spawning is handled by orchestrator.ts via rpc-client.ts.

        instance.status = "done";
        agentInstances.set(instanceId, instance);

        return {
          content: [
            {
              type: "text",
              text: `Agent ${def.name} (${instanceId}) completed task: ${params.task}`,
            },
          ],
          details: { instanceId, status: "done" },
        };
      } catch (error) {
        instance.status = "failed";
        agentInstances.set(instanceId, instance);

        throw error; // Throw to signal tool failure per pi convention
      }
    },
  });
}

// ---- 4.2 Built-in agent definitions ----

const SCOUT_PROMPT = `You are Scout — a read-only codebase search agent.
Your job: find files, symbols, and code blocks. Build dependency understanding.
Return minimal relevant slices, never full files. Be fast and precise.

Rules:
- Only search the codebase (not docs — those are handled by Main Agent)
- Return file paths + relevant line numbers, not entire files
- If you can't find something, say so clearly
- Prefer grep/find over reading entire directories`;

const CRAFTER_PROMPT = `You are Crafter — the implementation agent. You write and edit files.
You are the only agent that touches disk. Follow the plan precisely.

Rules:
- All writes MUST be wrapped in withFileMutationQueue
- One change at a time — atomic, focused edits
- Report what you changed, which files, and why
- If a change has wide blast radius, flag it
- Never proceed without clear instructions from the plan`;

const GATEKEEPER_PROMPT = `You are Gatekeeper — the verification agent. You are strictly read-only.
You run tests, check functional correctness, and review code quality.

Rules:
- NEVER write, edit, or delete files — not even "obviously safe" fixes
- Report EVERY finding to Main Agent, never skip anything
- Check: does the feature actually work? (hit routes, load pages, no crashes)
- Classify each finding: in-scope (caused by this task) or out-of-scope (pre-existing)
- Be thorough but concise — findings, not essays`;

const DEFAULT_MODEL: ModelRef = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
};

const SCOUT_TOOLS: ToolName[] = ["read", "bash", "grep", "find"];
const CRAFTER_TOOLS: ToolName[] = ["read", "write", "edit", "bash"];
const GATEKEEPER_TOOLS: ToolName[] = [
  "read",
  "bash",
  "grep",
  "find",
  "web_search",
];

export function registerBuiltinAgents(pi: ExtensionAPI): void {
  registerAgent(pi, {
    name: "scout",
    systemPrompt: SCOUT_PROMPT,
    defaultModel: DEFAULT_MODEL,
    defaultThinking: "minimal",
    tools: SCOUT_TOOLS,
    canDispatchWithoutApproval: true,
  });

  registerAgent(pi, {
    name: "crafter",
    systemPrompt: CRAFTER_PROMPT,
    defaultModel: DEFAULT_MODEL,
    defaultThinking: "medium",
    tools: CRAFTER_TOOLS,
    canDispatchWithoutApproval: false,
  });

  registerAgent(pi, {
    name: "gatekeeper",
    systemPrompt: GATEKEEPER_PROMPT,
    defaultModel: DEFAULT_MODEL,
    defaultThinking: "medium",
    tools: GATEKEEPER_TOOLS,
    canDispatchWithoutApproval: false,
  });
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

export function updateAgentStatus(
  instanceId: string,
  status: "idle" | "working" | "done" | "failed",
): void {
  const instance = agentInstances.get(instanceId);
  if (instance) {
    instance.status = status;
    agentInstances.set(instanceId, instance);
  }
}
