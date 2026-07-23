/**
 * agent-tool.ts — Agent tool definition extracted from index.ts.
 *
 * Factory that creates the Agent tool's execute function given its dependencies.
 * The tool registration (pi.registerTool) stays in index.ts for wiring clarity.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agents/agent-manager.js";
import { resolveModel } from "../model-resolver.js";
import { resolveAgentInvocationConfig } from "../agents/invocation-config.js";
import { resolveType, getAgentConfig, getAvailableTypes } from "../agents/agent-types.js";
import { normalizeMaxTurns, getDefaultMaxTurns } from "../agents/agent-runner.js";
import { isModelInScope, readEnabledModels, resolveEnabledModels } from "../enabled-models.js";
import { resolveJoinMode } from "../agents/invocation-config.js";
import { createOutputFilePath, streamToOutputFile, writeInitialEntry } from "../output-file.js";
import { type JoinMode, type AgentInvocation, type SubagentType, type AgentRecord } from "../types.js";
import {
  type AgentActivity,
  type AgentDetails,
  buildInvocationTags,
  describeActivity,
  formatMs,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
} from "../ui/agent-widget.js";
import {
  buildDetails,
  createActivityTracker,
  formatLifetimeTokens,
  textResult,
} from "../notifications.js";
import { getStatusNote } from "../status-note.js";

export interface AgentToolDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  reloadCustomAgents: () => void;
  isScopeModelsEnabled: () => boolean;
  getDefaultJoinMode: () => JoinMode;
  currentBatchAgents: { id: string; joinMode: JoinMode }[];
  batchFinalizeTimer: { current: ReturnType<typeof setTimeout> | undefined };
  finalizeBatch: () => void;
  widget: { setUICtx: (ctx: any) => void; ensureTimer: () => void; update: () => void; markFinished: (id: string) => void };
  fleet: { setUICtx: (ctx: any) => void; ensureTimer: () => void; update: () => void; onAgentFinished: (id: string) => void };
  getDefaultMaxTurns: () => number | undefined;
}

/**
 * Execute the Agent tool. All dependencies are injected explicitly.
 */
export async function executeAgent(
  toolCallId: string,
  params: {
    prompt: string;
    description: string;
    subagent_type: string;
    model?: string;
    thinking?: string;
    max_turns?: number;
    run_in_background?: boolean;
    resume?: string;
    isolated?: boolean;
    inherit_context?: boolean;
    isolation?: "worktree";
  },
  signal: AbortSignal | undefined,
  onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
  deps: AgentToolDeps,
) {
  const { pi, manager, agentActivity, reloadCustomAgents, isScopeModelsEnabled,
    getDefaultJoinMode, currentBatchAgents,
    batchFinalizeTimer, finalizeBatch, widget, fleet } = deps;

  widget.setUICtx(ctx.ui as any);

  reloadCustomAgents();

  const rawType = params.subagent_type as SubagentType;
  const resolved = resolveType(rawType);
  const subagentType = resolved ?? "general-purpose";
  const fellBack = resolved === undefined;

  const displayName = getDisplayName(subagentType);
  const customConfig = getAgentConfig(subagentType);
  const resolvedConfig = resolveAgentInvocationConfig(customConfig, params);

  // Resolve model
  let model = ctx.model;
  if (resolvedConfig.modelInput) {
    const resolvedModel = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
    if (typeof resolvedModel === "string") {
      if (resolvedConfig.modelFromParams) return textResult(resolvedModel);
    } else {
      model = resolvedModel;
    }
  }

  // Scope validation
  if (isScopeModelsEnabled() && model) {
    const allowed = resolveEnabledModels(readEnabledModels(ctx.cwd), ctx.modelRegistry, ctx.cwd);
    if (allowed && !isModelInScope(model, allowed)) {
      if (resolvedConfig.modelFromParams) {
        const list = [...allowed].sort().map(m => `  ${m}`).join("\n");
        return textResult(
          `Model not in scope: "${resolvedConfig.modelInput}".\n\n` +
          `Allowed models (from enabledModels):\n${list}`,
        );
      }
      const agentLabel = customConfig?.displayName ?? subagentType;
      const modelLabel = resolvedConfig.modelInput ?? `${model.provider}/${model.id}`;
      ctx.ui.notify(
        `Agent "${agentLabel}" using out-of-scope model "${modelLabel}"`,
        "warning",
      );
    }
  }

  const thinking = resolvedConfig.thinking;
  const inheritContext = resolvedConfig.inheritContext;
  const runInBackground = resolvedConfig.runInBackground;
  const isolated = resolvedConfig.isolated;
  const isolation = resolvedConfig.isolation;

  const parentModelId = ctx.model?.id;
  const effectiveModelId = model?.id;
  const modelName = effectiveModelId && effectiveModelId !== parentModelId
    ? (model?.name ?? effectiveModelId).replace(/^Claude\s+/i, "").toLowerCase()
    : undefined;
  const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? deps.getDefaultMaxTurns());
  const agentInvocation: AgentInvocation = {
    modelName,
    thinking,
    maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
    isolated,
    inheritContext,
    runInBackground,
    isolation,
  };
  const modeLabel = getPromptModeLabel(subagentType);
  const { tags: invocationTags } = buildInvocationTags(agentInvocation);
  const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
  const detailBase = {
    displayName,
    description: params.description,
    subagentType,
    modelName,
    tags: agentTags.length > 0 ? agentTags : undefined,
  };

  // ---- Resume ----
  if (params.resume) {
    const existing = manager.getRecord(params.resume);
    if (!existing) {
      return textResult(`Agent not found: "${params.resume}". It may have been cleaned up.`);
    }
    if (!existing.session) {
      return textResult(`Agent "${params.resume}" has no active session to resume.`);
    }
    const record = await manager.resume(params.resume, params.prompt, signal);
    if (!record) {
      return textResult(`Failed to resume agent "${params.resume}".`);
    }
    return textResult(
      record.result?.trim() || record.error?.trim() || "No output.",
      buildDetails(detailBase, record),
    );
  }

  // ---- Background ----
  if (runInBackground) {
    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

    let id: string;
    const origBgOnSession = bgCallbacks.onSessionCreated;
    bgCallbacks.onSessionCreated = (session: any) => {
      origBgOnSession(session);
      const rec = manager.getRecord(id);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, id, ctx.cwd);
      }
    };

    try {
      id = manager.spawn(pi, ctx, subagentType, params.prompt, {
        description: params.description,
        model,
        maxTurns: effectiveMaxTurns,
        isolated,
        inheritContext,
        thinkingLevel: thinking,
        isBackground: true,
        isolation,
        invocation: agentInvocation,
        ...bgCallbacks,
      });
    } catch (err) {
      return textResult(err instanceof Error ? err.message : String(err));
    }

    const joinMode = resolveJoinMode(getDefaultJoinMode(), true);
    const record = manager.getRecord(id);
    if (record && joinMode) {
      record.joinMode = joinMode;
      record.toolCallId = toolCallId;
      record.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      writeInitialEntry(record.outputFile, id, params.prompt, ctx.cwd);
    }

    if (joinMode == null || joinMode === 'async') {
      // Not part of batch
    } else {
      currentBatchAgents.push({ id, joinMode });
      if (batchFinalizeTimer.current) clearTimeout(batchFinalizeTimer.current);
      batchFinalizeTimer.current = setTimeout(finalizeBatch, 100);
    }

    agentActivity.set(id, bgState);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    pi.events.emit("summoner:created", {
      id,
      type: subagentType,
      description: params.description,
      isBackground: true,
    });

    const isQueued = record?.status === "queued";
    return textResult(
      `Agent ${isQueued ? "queued" : "started"} in background.\n` +
      `Agent ID: ${id}\n` +
      `Type: ${displayName}\n` +
      `Description: ${params.description}\n` +
      (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
      (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
      `\nYou will be notified when this agent completes.\n` +
      `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
      `Do not duplicate this agent's work.`,
      { ...detailBase, toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
    );
  }

  // ---- Foreground ----
  let spinnerFrame = 0;
  const startedAt = Date.now();
  let fgId: string | undefined;

  const streamUpdate = () => {
    const details: AgentDetails = {
      ...detailBase,
      toolUses: fgState.toolUses,
      tokens: formatLifetimeTokens(fgState),
      turnCount: fgState.turnCount,
      maxTurns: fgState.maxTurns,
      durationMs: Date.now() - startedAt,
      status: "running",
      activity: describeActivity(fgState.activeTools, fgState.responseText),
      spinnerFrame: spinnerFrame % SPINNER.length,
    };
    onUpdate?.({
      content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
      details: details as any,
    });
  };

  const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

  const origOnSession = fgCallbacks.onSessionCreated;
  fgCallbacks.onSessionCreated = (session: any) => {
    origOnSession(session);
    for (const a of manager.listAgents()) {
      if (a.session === session) {
        fgId = a.id;
        agentActivity.set(a.id, fgState);
        widget.ensureTimer();
        fleet.ensureTimer();
        fleet.update();
        break;
      }
    }
    if (fgId) {
      const rec = manager.getRecord(fgId);
      if (rec?.outputFile) {
        rec.outputCleanup = streamToOutputFile(session, rec.outputFile, fgId, ctx.cwd);
      }
    }
  };

  const spinnerInterval = setInterval(() => {
    spinnerFrame++;
    streamUpdate();
  }, 80);

  streamUpdate();

  let record: AgentRecord;
  try {
    const fgResult = await manager.spawnAndWait(pi, ctx, subagentType, params.prompt, {
      description: params.description,
      model,
      maxTurns: effectiveMaxTurns,
      isolated,
      inheritContext,
      thinkingLevel: thinking,
      isolation,
      invocation: agentInvocation,
      signal,
      ...fgCallbacks,
    }, (fgAgentId: string) => {
      const fgRec = manager.getRecord(fgAgentId);
      if (fgRec) {
        fgRec.outputFile = createOutputFilePath(ctx.cwd, fgAgentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(fgRec.outputFile, fgAgentId, params.prompt, ctx.cwd);
      }
    });
    record = fgResult.record;
  } catch (err) {
    clearInterval(spinnerInterval);
    return textResult(err instanceof Error ? err.message : String(err));
  }

  clearInterval(spinnerInterval);

  if (fgId) {
    agentActivity.delete(fgId);
    widget.markFinished(fgId);
    fleet.onAgentFinished(fgId);
  }

  const tokenText = formatLifetimeTokens(fgState);
  const details = buildDetails(detailBase, record, fgState, { tokens: tokenText });

  const fallbackNote = fellBack
    ? `Note: Unknown agent type "${rawType}" — using ${resolveType("general-purpose") ? "general-purpose" : "the fallback agent config"}.\n\n`
    : "";

  if (record.status === "error") {
    return textResult(`${fallbackNote}Agent failed: ${record.error}`, details);
  }

  const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
  const statsParts = [`${record.toolUses} tool uses`];
  if (tokenText) statsParts.push(tokenText);
  return textResult(
    `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getStatusNote(record.status)}.\n\n` +
    (record.result?.trim() || "No output."),
    details,
  );
}
