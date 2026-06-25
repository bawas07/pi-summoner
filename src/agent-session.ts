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

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "./types";

/** Hard ceiling so a stuck sub-agent fails loudly instead of hanging forever. */
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

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
  /** Extra (custom) tools to register in addition to the built-ins. */
  customTools?: ToolDefinition[];
  /** Thinking effort for this session. Omit to inherit from settings. */
  thinkingLevel?: ThinkingLevel;
  /** Live progress hook — fired on tool activity and streamed text. */
  onProgress?: (status: string) => void;
  /** Override the hang-guard timeout (ms). */
  timeoutMs?: number;
}

/**
 * Run a single sub-agent session to completion and return its final assistant text.
 *
 * `session.prompt()` resolves only when the agent's turn is fully complete (after any
 * tool calls), so the final text is read from `session.messages` once it resolves.
 * Progress events are surfaced via `onProgress` so callers can show live activity, and
 * a timeout aborts the session so it can never hang silently.
 */
export async function runAgentSession(opts: RunAgentOptions): Promise<string> {
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd: opts.cwd,
    // Isolate the sub-agent: an in-memory session keeps its messages OUT of the
    // user's main on-disk session, so Scout/Crafter/Gatekeeper transcripts don't
    // flood the main chat. We surface only their final report + live progress.
    sessionManager: SessionManager.inMemory(opts.cwd),
  };
  if (opts.tools) sessionOpts.tools = opts.tools;
  if (opts.customTools && opts.customTools.length > 0) {
    sessionOpts.customTools = opts.customTools;
  }
  if (opts.thinkingLevel) sessionOpts.thinkingLevel = opts.thinkingLevel;

  const { session } = await createAgentSession(sessionOpts);

  let lastEndText: string | null = null;
  const unsubscribe = session.subscribe((event) => {
    switch (event.type) {
      case "tool_execution_start":
        opts.onProgress?.(`running ${event.toolName}…`);
        break;
      case "message_update": {
        const snippet = extractAssistantText([
          (event as { message?: unknown }).message,
        ]);
        if (snippet) opts.onProgress?.(snippet.trim().slice(-100));
        break;
      }
      case "agent_end":
        if (!event.willRetry) {
          lastEndText = extractAssistantText(event.messages);
        }
        break;
    }
  });

  // Hang guard: abort the session if it runs past the timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void session.abort();
      reject(
        new Error(
          `Sub-agent timed out after ${Math.round(
            (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000,
          )}s`,
        ),
      );
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });

  try {
    await Promise.race([session.prompt(opts.task), timeout]);
    const finalText =
      extractAssistantText(session.messages as unknown[]) ?? lastEndText;
    return finalText && finalText.trim()
      ? finalText
      : "(agent completed but returned no text)";
  } finally {
    if (timer) clearTimeout(timer);
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
