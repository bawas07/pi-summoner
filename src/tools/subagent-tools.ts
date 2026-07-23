/**
 * subagent-tools.ts — get_subagent_result and steer_subagent tool execute functions.
 *
 * Factory functions that create tool execute handlers given their dependencies.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.js";
import { getAgentConversation, steerAgent } from "../agents/agent-runner.js";
import { formatDuration, formatTokens, getDisplayName } from "../ui/agent-widget.js";
import { formatLifetimeTokens } from "../notifications.js";
import { getSessionContextPercent } from "../usage.js";
import { getStatusNote } from "../status-note.js";

export interface SubagentToolsDeps {
  manager: AgentManager;
  agentActivity: Map<string, any>;
  cancelNudge: (key: string) => void;
  widget: { markFinished: (id: string) => void; update: () => void };
  fleet: { onAgentFinished: (id: string) => void; update: () => void };
  events: { emit: (event: string, payload: any) => void };
}

/** Tool execute return value for a text response. */
function textResult(msg: string, details?: any) {
  return { content: [{ type: "text" as const, text: msg }], details: details as any };
}

/**
 * Execute get_subagent_result — check status and retrieve results from a background agent.
 */
export async function executeGetSubagentResult(
  params: { agent_id: string; wait?: boolean; verbose?: boolean },
  deps: SubagentToolsDeps,
) {
  const { manager, cancelNudge } = deps;
  const record = manager.getRecord(params.agent_id);
  if (!record) {
    return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
  }

  if (params.wait && record.status === "running" && record.promise) {
    record.resultConsumed = true;
    cancelNudge(params.agent_id);
    await record.promise;
  }

  const displayName = getDisplayName(record.type);
  const duration = formatDuration(record.startedAt, record.completedAt);
  const tokens = formatLifetimeTokens(record);
  const contextPercent = getSessionContextPercent(record.session);
  const statsParts = [`Tool uses: ${record.toolUses}`];
  if (tokens) statsParts.push(tokens);
  if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
  if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
  statsParts.push(`Duration: ${duration}`);

  let output =
    `Agent: ${record.id}\n` +
    `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
    `Description: ${record.description}\n\n`;

  if (record.status === "running") {
    output += "Agent is still running. Use wait: true or check back later.";
  } else if (record.status === "error") {
    output += `Error: ${record.error}`;
  } else {
    output += record.result?.trim() || "No output.";
  }

  if (record.status !== "running" && record.status !== "queued") {
    record.resultConsumed = true;
    cancelNudge(params.agent_id);
  }

  if (params.verbose && record.session) {
    const conversation = getAgentConversation(record.session);
    if (conversation) {
      output += `\n\n--- Agent Conversation ---\n${conversation}`;
    }
  }

  return textResult(output);
}

/**
 * Execute steer_subagent — send a steering message to a running agent.
 */
export async function executeSteerSubagent(
  params: { agent_id: string; message: string },
  deps: SubagentToolsDeps,
) {
  const { manager } = deps;
  const record = manager.getRecord(params.agent_id);
  if (!record) {
    return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
  }
  if (record.status !== "running") {
    return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
  }
  if (!record.session) {
    if (!record.pendingSteers) record.pendingSteers = [];
    record.pendingSteers.push(params.message);
    deps.events.emit("summoner:steered", { id: record.id, message: params.message });
    return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
  }

  try {
    await steerAgent(record.session, params.message);
    deps.events.emit("summoner:steered", { id: record.id, message: params.message });
    const tokens = formatLifetimeTokens(record);
    const contextPercent = getSessionContextPercent(record.session);
    const stateParts: string[] = [];
    if (tokens) stateParts.push(tokens);
    stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
    if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
    if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
    return textResult(
      `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
      `Current state: ${stateParts.join(" · ")}`,
    );
  } catch (err) {
    return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
  }
}
