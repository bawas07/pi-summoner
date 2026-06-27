/**
 * Agent session runner — spawns isolated sub-agent sessions as child processes.
 *
 * Each summoned agent gets its own `pi --mode json -p` subprocess with a
 * role-scoped tool allowlist. JSONL stdout is parsed for progress events and
 * the final assistant text is returned to the orchestrator.
 *
 * No external dependencies beyond Node.js built-ins. No dependency on
 * pi-subagents — this is a minimal reimplementation of the core idea:
 *   spawn("pi", ["--mode", "json", ...]) → parse JSONL → return text.
 *
 * Read-only enforcement is architectural: Scout/Gatekeeper get tool allowlists
 * that exclude "write"/"edit". Only Crafter gets them.
 */

import { spawn } from "node:child_process";

// ---- Built-in pi tool names ----

/** Pure read-only search — no bash, no mutation. Scout. */
export const SCOUT_TOOLS = ["read", "grep", "find", "ls"];
/** Read + run tests/checks (bash), but no write/edit. Gatekeeper. */
export const GATEKEEPER_TOOLS = ["read", "grep", "find", "ls", "bash"];
/** Full coding tool set. Crafter. */
export const CRAFTER_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"];

export interface RunAgentOptions {
  /** Project working directory. */
  cwd: string;
  /** The task / prompt for this agent (includes role instructions). */
  task: string;
  /** Tool allowlist. */
  tools: string[];
  /** Live progress hook — fired on tool activity. */
  onProgress?: (status: string) => void;
  /** Override the hang-guard timeout (ms). Default: 4 minutes. */
  timeoutMs?: number;
}

/** Hard ceiling so a stuck sub-agent fails loudly instead of hanging forever. */
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Run a single sub-agent as a `pi` child process and return its final assistant text.
 *
 * Spawns: `pi --mode json -p --no-session --tools "<tools>" "Task: <task>"`
 * Parses JSONL stdout for progress and the final response.
 * The subprocess is killed on timeout.
 */
export async function runAgentSession(opts: RunAgentOptions): Promise<string> {
  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--tools", opts.tools.join(","),
    `Task: ${opts.task}`,
  ];

  opts.onProgress?.(`spawning pi ${opts.tools.join(",")}…`);

  const child = spawn("pi", args, {
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  let lastAssistantText = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;

  // ---- Timeout guard ----
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => {
    if (settled) return;
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 3000);
  }, timeoutMs);

  // ---- Stdout: parse JSONL events ----
  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;

      let event: { type?: string; message?: JsonlMessage; toolName?: string };
      try {
        event = JSON.parse(line);
      } catch {
        continue; // non-JSON output, ignore
      }

      // Progress: tool activity
      if (event.type === "tool_execution_start" && event.toolName) {
        opts.onProgress?.(`running ${event.toolName}…`);
      }

      // Progress: tool results
      if (event.type === "tool_result_end") {
        opts.onProgress?.("tool result received");
      }

      // Collect assistant text from message_end events
      if (
        event.type === "message_end" &&
        event.message?.role === "assistant"
      ) {
        const text = extractText(event.message);
        if (text) {
          lastAssistantText = text;
          // Show snippet of what the agent is thinking/saying
          const snippet = text.trim().split("\n").slice(-3).join(" ");
          if (snippet) opts.onProgress?.(snippet.slice(-120));
        }
      }

      // agent_end: final signal, but we continue reading until process closes
    }
  });

  // ---- Stderr: collect for error reporting ----
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  // ---- Wait for process to close ----
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("close", (code) => {
      settled = true;
      clearTimeout(timeout);
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
  });

  // Drain any remaining buffered stdout lines
  if (buf.trim()) {
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { type?: string; message?: JsonlMessage };
        if (
          event.type === "message_end" &&
          event.message?.role === "assistant"
        ) {
          const text = extractText(event.message);
          if (text) lastAssistantText = text;
        }
      } catch { /* ignore */ }
    }
  }

  // ---- Determine result ----
  if (timedOut) {
    throw new Error(
      `Sub-agent timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }

  if (exitCode !== 0) {
    const errMsg = stderr.trim() || `Sub-agent exited with code ${exitCode}`;
    if (lastAssistantText) {
      // Agent produced output but errored — return what we have, let the
      // orchestrator decide. This matches pi-subagents' behavior.
      return lastAssistantText.trim();
    }
    throw new Error(errMsg);
  }

  return lastAssistantText.trim() || "(agent completed but returned no text)";
}

// ---- Helpers ----

/** Shape of a message in the JSONL stream. */
interface JsonlMessage {
  role?: string;
  content?: string | Array<{ type?: string; text?: string }>;
}

/** Extract plain text from a message's content (string or content-part array). */
function extractText(msg: JsonlMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";

  return msg.content
    .filter((p): p is { type: "text"; text: string } =>
      p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n");
}
