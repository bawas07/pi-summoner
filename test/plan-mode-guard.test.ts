import { describe, expect, it } from "vitest";
import {
  decidePlanModeToolCall,
  isAllowedPlanWritePath,
  isReadOnlyAgentType,
} from "../src/plan-mode-guard.js";
import type { AgentConfig } from "../src/types.js";

function cfg(partial: Partial<AgentConfig> & Pick<AgentConfig, "name" | "description">): AgentConfig {
  return {
    systemPrompt: "",
    promptMode: "replace",
    extensions: true,
    skills: true,
    ...partial,
  };
}

const registry = new Map<string, AgentConfig>([
  ["Scout", cfg({ name: "Scout", description: "ro", builtinToolNames: ["read", "bash", "grep", "find", "ls"] })],
  ["Crafter", cfg({ name: "Crafter", description: "rw" /* all tools */ })],
  ["Gatekeeper", cfg({ name: "Gatekeeper", description: "gate", builtinToolNames: ["read", "grep", "find", "ls"] })],
  ["general-purpose", cfg({ name: "general-purpose", description: "all" })],
  ["code-reviewer", cfg({ name: "code-reviewer", description: "ro", builtinToolNames: ["read", "grep", "find", "ls"] })],
  [
    "explore-custom",
    cfg({ name: "explore-custom", description: "custom ro", builtinToolNames: ["read", "grep", "find", "ls"] }),
  ],
  [
    "writer-custom",
    cfg({ name: "writer-custom", description: "custom rw", builtinToolNames: ["read", "write", "edit"] }),
  ],
  ["all-tools-custom", cfg({ name: "all-tools-custom", description: "omit tools = all" })],
]);

function getAgentConfig(name: string): AgentConfig | undefined {
  if (registry.has(name)) return registry.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of registry) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function decide(toolName: string, input: Record<string, unknown> = {}) {
  return decidePlanModeToolCall({ toolName, input, getAgentConfig });
}

describe("isAllowedPlanWritePath", () => {
  it("allows .md paths only", () => {
    expect(isAllowedPlanWritePath("docs/plan-nudge-orchestration.md")).toBe(true);
    expect(isAllowedPlanWritePath("/tmp/foo.md")).toBe(true);
    expect(isAllowedPlanWritePath("README.md")).toBe(true);
  });

  it("rejects non-md, json, and missing", () => {
    expect(isAllowedPlanWritePath("src/index.ts")).toBe(false);
    expect(isAllowedPlanWritePath("config.json")).toBe(false);
    expect(isAllowedPlanWritePath(undefined)).toBe(false);
    expect(isAllowedPlanWritePath("")).toBe(false);
  });
});

describe("isReadOnlyAgentType", () => {
  it("allows known read-only builtins", () => {
    expect(isReadOnlyAgentType("Scout", getAgentConfig)).toBe(true);
    expect(isReadOnlyAgentType("scout", getAgentConfig)).toBe(true);
    expect(isReadOnlyAgentType("code-reviewer", getAgentConfig)).toBe(true);
  });

  it("blocks write-capable builtins even if misconfigured as read-only tools", () => {
    // Gatekeeper is gate-only tools but still blocked by name in plan mode
    // (implementation/review workflow belongs in craft).
    expect(isReadOnlyAgentType("Crafter", getAgentConfig)).toBe(false);
    expect(isReadOnlyAgentType("Gatekeeper", getAgentConfig)).toBe(false);
    expect(isReadOnlyAgentType("general-purpose", getAgentConfig)).toBe(false);
  });

  it("uses tool list for custom agents", () => {
    expect(isReadOnlyAgentType("explore-custom", getAgentConfig)).toBe(true);
    expect(isReadOnlyAgentType("writer-custom", getAgentConfig)).toBe(false);
    expect(isReadOnlyAgentType("all-tools-custom", getAgentConfig)).toBe(false);
    expect(isReadOnlyAgentType("missing-agent", getAgentConfig)).toBe(false);
    expect(isReadOnlyAgentType(undefined, getAgentConfig)).toBe(false);
  });
});

describe("decidePlanModeToolCall", () => {
  it("allows read/search tools", () => {
    for (const t of ["read", "grep", "find", "ls", "fffind", "ffgrep"]) {
      expect(decide(t).block).toBe(false);
    }
  });

  it("allows ask_user_question and plan_checkpoint", () => {
    expect(decide("ask_user_question").block).toBe(false);
    expect(decide("plan_checkpoint", { summary: "x" }).block).toBe(false);
  });

  it("allows research tools", () => {
    for (const t of ["web_search", "fetch_content", "get_search_content", "analyze_image"]) {
      expect(decide(t).block).toBe(false);
    }
  });

  it("allows get_subagent_result and steer_subagent", () => {
    expect(decide("get_subagent_result", { agent_id: "a1" }).block).toBe(false);
    expect(decide("steer_subagent", { agent_id: "a1", message: "hi" }).block).toBe(false);
  });

  it("allows Agent + Scout / code-reviewer / custom read-only", () => {
    expect(decide("Agent", { subagent_type: "Scout", prompt: "p", description: "d" }).block).toBe(false);
    expect(decide("Agent", { subagent_type: "code-reviewer", prompt: "p", description: "d" }).block).toBe(false);
    expect(decide("Agent", { subagent_type: "explore-custom", prompt: "p", description: "d" }).block).toBe(false);
  });

  it("blocks Agent + Crafter / Gatekeeper / general-purpose / write custom", () => {
    expect(decide("Agent", { subagent_type: "Crafter", prompt: "p", description: "d" }).block).toBe(true);
    expect(decide("Agent", { subagent_type: "Gatekeeper", prompt: "p", description: "d" }).block).toBe(true);
    expect(decide("Agent", { subagent_type: "general-purpose", prompt: "p", description: "d" }).block).toBe(true);
    expect(decide("Agent", { subagent_type: "writer-custom", prompt: "p", description: "d" }).block).toBe(true);
  });

  it("allows Agent resume without subagent_type check", () => {
    expect(decide("Agent", { resume: "agent-123", prompt: "continue", description: "d" }).block).toBe(false);
  });

  // Regression: inverted !md || !json always blocked real .md plans
  it("allows write/edit of .md paths (regression: plan-nudge path)", () => {
    const path = "/home/bawas/code/personal/pi/extentions/agent-summoner/docs/plan-nudge-orchestration.md";
    const w = decide("write", { path, content: "# plan" });
    expect(w.block).toBe(false);

    const e = decide("edit", { path: "README.md", oldText: "a", newText: "b" });
    expect(e.block).toBe(false);

    const tmp = decide("write", { path: "/tmp/foo.md", content: "x" });
    expect(tmp.block).toBe(false);
  });

  it("blocks write/edit of non-md and missing path", () => {
    const ts = decide("write", { path: "src/index.ts", content: "x" });
    expect(ts.block).toBe(true);
    if (ts.block) {
      expect(ts.reason).toContain("src/index.ts");
      // Must not claim a .md path is not md — and for .ts should say not allowed
      expect(ts.reason).not.toMatch(/\.md" is not a \.md file/);
    }

    const json = decide("write", { path: "config.json", content: "{}" });
    expect(json.block).toBe(true);

    const missing = decide("write", { content: "x" });
    expect(missing.block).toBe(true);
  });

  it("does not claim a .md path is not a .md file when blocking for other reasons", () => {
    // Sanity: allowed path never produces the old buggy message
    const ok = decide("write", { path: "docs/x.md", content: "hi" });
    expect(ok.block).toBe(false);
  });

  it("blocks destructive bash and allows read-only bash", () => {
    expect(decide("bash", { command: "rm -rf /tmp/x" }).block).toBe(true);
    expect(decide("bash", { command: "echo hi > file.txt" }).block).toBe(true);
    expect(decide("bash", { command: "ls src" }).block).toBe(false);
    expect(decide("bash", { command: "git status" }).block).toBe(false);
  });

  it("allows harmless /dev/null stderr discard and 2>&1", () => {
    // Real user commands — stderr discard is not a file write
    expect(decide("bash", { command: "ls -la /foo/ 2>/dev/null || echo nope" }).block).toBe(false);
    expect(decide("bash", { command: "ls -la /foo/ 2>/dev/null" }).block).toBe(false);
    expect(decide("bash", { command: "command 2>/dev/null" }).block).toBe(false);
    expect(decide("bash", { command: ">/dev/null 2>&1 echo done" }).block).toBe(false);
  });

  it("still blocks actual file redirections", () => {
    expect(decide("bash", { command: "echo hi > /tmp/out.txt" }).block).toBe(true);
    expect(decide("bash", { command: "cmd >> log.txt" }).block).toBe(true);
    expect(decide("bash", { command: ">& file.txt echo" }).block).toBe(true);
  });

  it("blocks unknown tools", () => {
    const r = decide("apply_patch", { patch: "..." });
    expect(r.block).toBe(true);
    if (r.block) expect(r.reason).toContain("apply_patch");
  });
});
