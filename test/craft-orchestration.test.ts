import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORCHESTRATION_MODE,
  parseOrchestrationMode,
  resolveOrchestrationMode,
  shouldBlockMainWrite,
} from "../src/craft-orchestration.js";

describe("craft-orchestration", () => {
  it("defaults to nudge", () => {
    expect(DEFAULT_ORCHESTRATION_MODE).toBe("nudge");
    expect(resolveOrchestrationMode(undefined)).toBe("nudge");
  });

  it("parses valid modes only", () => {
    expect(parseOrchestrationMode("nudge")).toBe("nudge");
    expect(parseOrchestrationMode("hybrid")).toBe("hybrid");
    expect(parseOrchestrationMode("strict")).toBeUndefined();
    expect(parseOrchestrationMode(1)).toBeUndefined();
  });

  it("never blocks main writes until hybrid is implemented", () => {
    expect(shouldBlockMainWrite("nudge")).toBe(false);
    expect(shouldBlockMainWrite("hybrid")).toBe(false);
  });
});
