/**
 * party-rules.ts — party.rules.json config for agent model overrides.
 *
 * Format:
 * {
 *   "model": {
 *     "scout": "provider/modelId",      // optional
 *     "crafter": "provider/modelId",    // optional
 *     "gatekeeper": "provider/modelId"  // optional
 *   }
 * }
 *
 * Keys are lowercase agent type names. When set, the model override is used
 * instead of the agent definition's model or parent inheritance.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface PartyModelOverrides {
  scout?: string;
  crafter?: string;
  gatekeeper?: string;
}

export interface PartyRules {
  model?: PartyModelOverrides;
}

const CONFIG_FILENAME = "party.rules.json";

/** Path to party.rules.json in the project root. */
function configPath(cwd: string): string {
  return join(cwd, CONFIG_FILENAME);
}

/** Read party.rules.json. Returns empty object if missing or malformed. */
export function loadPartyRules(cwd: string = process.cwd()): PartyRules {
  const path = configPath(cwd);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PartyRules;
  } catch {
    console.warn(`[agent-summoner] Ignoring malformed config at ${path}`);
    return {};
  }
}

/** Write party.rules.json. Returns true on success. */
export function savePartyRules(rules: PartyRules, cwd: string = process.cwd()): boolean {
  const path = configPath(cwd);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(rules, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the model override for a given agent type from party.rules.json.
 * Returns the model string ("provider/modelId") if configured, undefined otherwise.
 * Agent type names are matched case-insensitively.
 */
export function resolvePartyModel(
  agentType: string,
  rules: PartyRules,
): string | undefined {
  const overrides = rules.model;
  if (!overrides) return undefined;

  const key = agentType.toLowerCase();
  const map: Record<string, string | undefined> = {
    scout: overrides.scout,
    crafter: overrides.crafter,
    gatekeeper: overrides.gatekeeper,
  };

  return map[key];
}
