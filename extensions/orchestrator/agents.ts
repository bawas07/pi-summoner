/**
 * agents.ts — Agent registration interface.
 *
 * Built-in agents (Scout, Crafter, Gatekeeper) and user-defined agents
 * are registered through the exact same `registerAgent` function.
 * There is no special-cased "core" agent — flat and equal.
 *
 * Each agent becomes a Pi tool named `summon_<name>`.
 * The Main Agent (LLM) decides when to call these tools based on
 * their `description` and `promptGuidelines`.
 *
 * @see docs/prd.md §3 — Agent Roles
 * @see docs/plan.md Task 0.3
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ── Types ──────────────────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Unique name (e.g., "scout", "crafter", "gatekeeper"). Produces tool `summon_<name>`. */
  name: string;
  /** LLM-readable description — Main Agent uses this to decide WHEN to summon. */
  description: string;
  /** Opt-in persistent memory. Built-ins have this fixed per prd.md §3. */
  memory?: boolean;
  /** Prompt snippet shown in tool listing. */
  promptSnippet?: string;
  /** Guidelines for the LLM about when to use this agent. */
  promptGuidelines?: string[];
  /** The handler: receives task text, returns result. */
  handler: (
    task: string,
    ctx: ExtensionContext,
  ) => Promise<AgentToolResult<unknown>>;
}

// ── Registration ───────────────────────────────────────────────────────────

/** All registered agent names (for autocomplete, listing). */
const registeredAgents = new Set<string>();

/**
 * Register an agent as a Pi tool. Built-in and user-defined agents
 * use the same path — no special-casing.
 */
export function registerAgent(pi: ExtensionAPI, def: AgentDefinition): void {
  const toolName = `summon_${def.name}`;
  registeredAgents.add(def.name);

  pi.registerTool({
    name: toolName,
    label: def.name.charAt(0).toUpperCase() + def.name.slice(1),
    description: def.description,
    promptSnippet: def.promptSnippet,
    promptGuidelines: def.promptGuidelines,
    parameters: Type.Object({
      task: Type.String({ description: "Task description for this agent" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return def.handler(params.task, ctx);
    },
  });
}

/** Get all registered agent names (for /summon autocomplete). */
export function getRegisteredAgents(): string[] {
  return [...registeredAgents];
}

// ── User-Defined Agent Discovery ──────────────────────────────────────────

interface UserAgentConfig {
  name: string;
  description: string;
  memory?: boolean;
  handlerPath?: string;
}

/**
 * Discover and register user-defined agents from config files.
 * Reads from project-local and global config locations.
 * Invalid configs are skipped silently (logged to console).
 */
export async function discoverUserAgents(pi: ExtensionAPI, cwd: string): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { homedir } = await import("node:os");

  const configPaths = [
    join(cwd, ".pi", "agents.json"),           // project-local
    join(homedir(), ".pi", "agent", "agents.json"), // global
  ];

  for (const configPath of configPaths) {
    let raw: string;
    try {
      raw = await readFile(configPath, "utf8");
    } catch {
      continue; // file doesn't exist — skip silently
    }

    let configs: UserAgentConfig[];
    try {
      configs = JSON.parse(raw);
      if (!Array.isArray(configs)) {
        configs = [configs];
      }
    } catch {
      console.warn(`[agent-summoner] Invalid JSON in ${configPath}, skipping.`);
      continue;
    }

    for (const cfg of configs) {
      if (!cfg.name || !cfg.description) {
        console.warn(`[agent-summoner] Skipping agent config without name/description in ${configPath}`);
        continue;
      }

      // If handlerPath specified, try to load the handler module
      let handler: AgentDefinition["handler"];
      if (cfg.handlerPath) {
        try {
          const modPath = join(configPath, "..", cfg.handlerPath);
          const mod = await import(modPath);
          handler = mod.default || mod.handler;
          if (typeof handler !== "function") {
            console.warn(`[agent-summoner] Handler at ${cfg.handlerPath} is not a function, skipping ${cfg.name}.`);
            continue;
          }
        } catch (err) {
          console.warn(`[agent-summoner] Could not load handler for ${cfg.name} at ${cfg.handlerPath}: ${err}`);
          continue;
        }
      } else {
        // No handlerPath — agent is descriptive only (LLM knows about it but can't execute)
        // This is useful for documentation/guidance purposes
        handler = async (_task: string, _ctx: ExtensionContext) => ({
          content: [{ type: "text", text: `Agent "${cfg.name}" has no executable handler.` }],
          details: {},
        });
      }

      registerAgent(pi, {
        name: cfg.name,
        description: cfg.description,
        memory: cfg.memory,
        handler,
      });

      console.log(`[agent-summoner] Registered user agent: ${cfg.name}`);
    }
  }
}
