/**
 * RPC subprocess client — spawns and communicates with pi --mode rpc subprocesses.
 *
 * Each summoned agent runs as an independent pi process. Communication is
 * JSONL on stdin/stdout, matched by id. This module wraps the full lifecycle:
 * spawn, send, receive, terminate.
 *
 * CRITICAL: Does NOT use Node's readline — custom buffer-accumulate-and-split
 * for protocol compliance with pi's RPC framing.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable } from "node:stream";
import type { ModelRef, ThinkingLevel } from "./types";

// ---- Types ----

export interface RpcRequest {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  id: string;
  type: "response" | "event" | "error";
  [key: string]: unknown;
}

export interface SubprocessClient {
  process: ChildProcess;
  /** Send a request and wait for the matching response */
  send: (request: RpcRequest) => Promise<RpcResponse>;
  /** Kill the subprocess and clean up */
  terminate: () => Promise<void>;
  /** Whether the process is still alive */
  alive: boolean;
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
}

// ---- 5.1 spawnSubprocess() ----

const DEFAULT_MODEL: ModelRef = {
  provider: "anthropic",
  modelId: "claude-sonnet-4-5",
};
const DEFAULT_THINKING: ThinkingLevel = "medium";

export function spawnSubprocess(
  model?: ModelRef,
  thinking?: ThinkingLevel,
): SubprocessClient {
  const modelRef = model ?? DEFAULT_MODEL;
  const thinkingLevel = thinking ?? DEFAULT_THINKING;

  const modelArg = `--model ${modelRef.provider}/${modelRef.modelId}:${thinkingLevel}`;

  const args = ["--mode", "rpc", modelArg];

  let child: ChildProcess;
  try {
    child = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
      env: { ...process.env },
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn pi subprocess: ${err instanceof Error ? err.message : String(err)}. ` +
        `Is pi installed and in PATH?`,
    );
  }

  child.on("error", (err) => {
    // Process-level errors (e.g., cannot spawn)
    // The caller should already have caught the spawn error above,
    // but this handles async errors after spawn succeeds.
    throw new Error(`pi subprocess error: ${err.message}`);
  });

  // Log stderr for debugging
  if (child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      const msg = data.toString("utf8").trim();
      if (msg) {
        console.error(`[pi-rpc:stderr] ${msg}`);
      }
    });
  }

  let alive = true;

  child.on("exit", (code) => {
    alive = false;
    if (code !== 0 && code !== null) {
      console.error(`[pi-rpc] subprocess exited with code ${code}`);
    }
  });

  // ---- 5.2 JSONL line reader ----

  const pending = new Map<string, PendingRequest>();
  let buffer = "";
  let requestCounter = 0;

  function processChunk(chunk: string): void {
    buffer += chunk;
    const lines = buffer.split("\n");
    // Last element may be incomplete — keep it in buffer
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed: RpcResponse = JSON.parse(line);
        const pendingReq = pending.get(parsed.id);
        if (pendingReq) {
          pending.delete(parsed.id);
          pendingReq.resolve(parsed);
        }
        // Events without a pending request are logged but not
        // treated as errors — the protocol allows unsolicited events.
      } catch {
        console.error(`[pi-rpc] failed to parse JSONL line: ${line.slice(0, 200)}`);
      }
    }
  }

  if (child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      processChunk(data.toString("utf8"));
    });
  }

  // ---- 5.3 sendPrompt() ----

  async function send(request: RpcRequest): Promise<RpcResponse> {
    if (!alive) {
      throw new Error("Cannot send to a dead subprocess");
    }

    const id = request.id || `${++requestCounter}`;
    const reqWithId = { ...request, id };

    return new Promise<RpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });

      const line = JSON.stringify(reqWithId) + "\n";
      (child.stdin as Writable).write(line, (err) => {
        if (err) {
          pending.delete(id);
          reject(new Error(`Failed to write to subprocess stdin: ${err.message}`));
        }
      });

      // Timeout after 5 minutes for Phase 1 (no crash detection yet)
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Request ${id} timed out after 5 minutes`));
        }
      }, 5 * 60 * 1000);
    });
  }

  // ---- 5.4 terminate() ----

  async function terminate(): Promise<void> {
    if (!alive) return;

    return new Promise<void>((resolve) => {
      child.on("exit", () => {
        alive = false;
        // Reject all pending requests
        for (const [id, { reject }] of pending) {
          reject(new Error(`Subprocess terminated before request ${id} completed`));
        }
        pending.clear();
        resolve();
      });

      // Close stdin to signal graceful shutdown, then kill if it doesn't exit
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }

      // Force kill after 5 seconds if still alive
      setTimeout(() => {
        if (alive) {
          child.kill("SIGTERM");
          setTimeout(() => {
            if (alive) child.kill("SIGKILL");
          }, 2000);
        }
      }, 5000);
    });
  }

  return { process: child, send, terminate, alive };
}
