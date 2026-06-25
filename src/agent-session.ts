/**
 * Agent session runner — spawns isolated sub-agent sessions in-process.
 *
 * Replaces the previous `pi --mode rpc` child-process transport (rpc-client.ts).
 * Uses the SDK's `createAgentSession()` — the same mechanism tintinweb/pi-subagents
 * uses — which gives each summoned agent its own isolated context, tool set, model,
 * and thinking level, without the fragility of spawning + JSONL framing an OS process.
 *
 * Read-only enforcement is architectural: Scout/Gatekeeper are given tool allowlists
 * that physically exclude `write`/`edit`. Only Crafter gets them.
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types";

// ---- Built-in pi tool names (confirmed against the installed SDK) ----

/** Pure read-only search — no bash, no mutation. Scout. */
export const SCOUT_TOOLS = ["read", "grep", "find", "ls"];
/** Read + run tests/checks (bash), but no write/edit. Gatekeeper. */
export const GATEKEEPER_TOOLS = ["read", "grep", "find", "ls", "bash"];
/** Full coding tool set. Crafter. */
export const CRAFTER_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

export interface RunAgentOptions {
  /** Project working directory (ctx.cwd). */
  cwd: string;
  /** The task / prompt for this agent. */
  task: string;
  /** Tool allowlist. Omit to use pi's defaults (read/bash/edit/write). */
  tools?: string[];
  /** Thinking effort for this session. Omit to inherit from settings. */
  thinkingLevel?: ThinkingLevel;
  /** Optional streaming hook for live status (receives accumulated assistant text). */
  onText?: (text: string) => void;
}

/**
 * Run a single sub-agent session to completion and return its final assistant text.
 *
 * `session.prompt()` resolves only when the agent's turn is fully complete (after any
 * tool calls), so the final text is read from `session.messages` once it resolves.
 */
export async function runAgentSession(opts: RunAgentOptions): Promise<string> {
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: opts.cwd,
  };
  if (opts.tools) sessionOpts.tools = opts.tools;
  if (opts.thinkingLevel) sessionOpts.thinkingLevel = opts.thinkingLevel;

  const { session } = await createAgentSession(sessionOpts);

  let lastEndText: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_end" && !event.willRetry) {
      lastEndText = extractAssistantText(event.messages);
      if (lastEndText && opts.onText) opts.onText(lastEndText);
    }
  });

  try {
    await session.prompt(opts.task);
    // Primary: final messages after the turn resolves. Fallback: last agent_end event.
    const finalText =
      extractAssistantText(session.messages as unknown[]) ?? lastEndText;
    return finalText && finalText.trim()
      ? finalText
      : "(agent completed but returned no text)";
  } finally {
    unsubscribe();
    session.dispose();
  }
}

// ---- Text extraction (defensive: handles string or content-part array) ----

/** Pull the text of the last assistant message out of a message list. */
function extractAssistantText(messages: unknown[]): string | null {
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown } | null;
    if (!msg || msg.role !== "assistant") continue;

    const text = contentToText(msg.content);
    if (text && text.trim()) return text;
  }
  return null;
}

/** Normalize a message `content` (string | parts[]) into plain text. */
function contentToText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const texts = content
    .map((part) => {
      const p = part as { type?: string; text?: string } | null;
      if (p && p.type === "text" && typeof p.text === "string") return p.text;
      return null;
    })
    .filter((t): t is string => t !== null);

  return texts.length > 0 ? texts.join("\n") : null;
}
