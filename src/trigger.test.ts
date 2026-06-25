/**
 * Unit tests for trigger.ts — ambient trigger evaluation.
 *
 * Tests the heuristic keyword detection for needsScout and implementIntent.
 * These are the highest-risk tests in Phase 1 (per plan.md: "expect this phase
 * to involve more prompt iteration on trigger.ts than the other modules combined").
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateTurn, type TurnContext } from "./trigger";

// ---- Helpers ----

function ctx(
  message: string,
  recentHistory: string[] = [],
  currentPhase?: string,
): TurnContext {
  return { message, recentHistory, currentPhase };
}

// ---- needsScout tests ----

describe("evaluateTurn — needsScout", () => {
  // Happy path: codebase references
  it("should detect needsScout when message mentions a file path", () => {
    const result = evaluateTurn(ctx("where is src/auth/login.ts?"));
    assert.equal(result.needsScout, true);
    assert.equal(result.implementIntent, false);
  });

  it("should detect needsScout when message mentions a function", () => {
    const result = evaluateTurn(ctx("how does the validateToken function work?"));
    assert.equal(result.needsScout, true);
  });

  it("should detect needsScout when message mentions an endpoint", () => {
    const result = evaluateTurn(ctx("what does the /api/login endpoint return?"));
    assert.equal(result.needsScout, true);
  });

  it("should detect needsScout when message mentions modules/components", () => {
    const result = evaluateTurn(ctx("check the auth middleware implementation"));
    assert.equal(result.needsScout, true);
  });

  it("should detect needsScout with import/export references", () => {
    const result = evaluateTurn(ctx("what does this module export and import?"));
    assert.equal(result.needsScout, true);
  });

  // Docs-only: no Scout
  it("should NOT detect needsScout for PRD/doc questions", () => {
    const result = evaluateTurn(ctx("what does the PRD say about Gatekeeper?"));
    assert.equal(result.needsScout, false);
  });

  it("should NOT detect needsScout for README questions", () => {
    const result = evaluateTurn(ctx("can you check the README for installation steps?"));
    assert.equal(result.needsScout, false);
  });

  it("should NOT detect needsScout for design doc questions", () => {
    const result = evaluateTurn(ctx("what does the architecture decision say?"));
    assert.equal(result.needsScout, false);
  });

  // Edge cases
  it("should return false for empty message", () => {
    const result = evaluateTurn(ctx(""));
    assert.equal(result.needsScout, false);
  });

  it("should detect needsScout during executing phase", () => {
    const result = evaluateTurn(ctx("what file is that in?", [], "executing"));
    assert.equal(result.needsScout, true);
  });

  it("should detect needsScout during scouting phase", () => {
    const result = evaluateTurn(ctx("any updates?", [], "scouting"));
    assert.equal(result.needsScout, true);
  });

  // Short follow-up after code discussion
  it("should detect needsScout for short follow-up after code discussion", () => {
    const result = evaluateTurn(
      ctx(
        "where is it defined?",
        ["i was looking at the auth middleware in src/auth/"],
      ),
    );
    assert.equal(result.needsScout, true);
  });
});

// ---- implementIntent tests ----

describe("evaluateTurn — implementIntent", () => {
  // Happy path: clear implementation requests
  it("should detect implementIntent for 'fix' command", () => {
    const result = evaluateTurn(ctx("fix the login redirect bug"));
    assert.equal(result.implementIntent, true);
  });

  it("should detect implementIntent for 'build' command", () => {
    const result = evaluateTurn(ctx("build a user settings page"));
    assert.equal(result.implementIntent, true);
  });

  it("should detect implementIntent for 'add' command", () => {
    const result = evaluateTurn(ctx("add input validation to the signup form"));
    assert.equal(result.implementIntent, true);
  });

  it("should detect implementIntent for 'implement' command", () => {
    const result = evaluateTurn(ctx("implement the new payment flow"));
    assert.equal(result.implementIntent, true);
  });

  it("should detect implementIntent for 'remove' command", () => {
    const result = evaluateTurn(ctx("remove the deprecated analytics code"));
    assert.equal(result.implementIntent, true);
  });

  it("should detect implementIntent for 'refactor' command", () => {
    const result = evaluateTurn(ctx("refactor the user service into smaller modules"));
    assert.equal(result.implementIntent, true);
  });

  it("should detect implementIntent for 'go ahead' commands", () => {
    const result = evaluateTurn(ctx("yes, go ahead and do it"));
    assert.equal(result.implementIntent, true);
  });

  // Discussion: no implementation intent
  it("should NOT detect implementIntent for 'what is' questions", () => {
    const result = evaluateTurn(ctx("what is the current auth flow?"));
    assert.equal(result.implementIntent, false);
  });

  it("should NOT detect implementIntent for 'how does' questions", () => {
    const result = evaluateTurn(ctx("how does the login redirect work?"));
    assert.equal(result.implementIntent, false);
  });

  it("should NOT detect implementIntent for 'can we' exploration", () => {
    const result = evaluateTurn(ctx("can we add a dark mode?"));
    assert.equal(result.implementIntent, false);
  });

  it("should NOT detect implementIntent for 'should we' deliberation", () => {
    const result = evaluateTurn(ctx("should we refactor the database layer?"));
    assert.equal(result.implementIntent, false);
  });

  it("should NOT detect implementIntent for brainstorming", () => {
    const result = evaluateTurn(ctx("let's discuss the new feature ideas"));
    assert.equal(result.implementIntent, false);
  });

  it("should NOT detect implementIntent for opinion questions", () => {
    const result = evaluateTurn(ctx("what do you think about using Redis?"));
    assert.equal(result.implementIntent, false);
  });

  it("should NOT detect implementIntent for 'why' questions", () => {
    const result = evaluateTurn(ctx("why is the auth middleware slow?"));
    assert.equal(result.implementIntent, false);
  });

  // Edge cases
  it("should return false for empty message", () => {
    const result = evaluateTurn(ctx(""));
    assert.equal(result.implementIntent, false);
  });

  // Implicit intent: short message about a file/function after implementation discussion
  it("should detect implementIntent for short code reference after implementation discussion", () => {
    const result = evaluateTurn(
      ctx(
        "the auth middleware login.ts is broken",
        ["we need to implement a fix for the auth flow"],
      ),
    );
    assert.equal(result.implementIntent, true);
  });
});

// ---- Independence of signals ----

describe("evaluateTurn — independent signals", () => {
  it("should have needsScout true but implementIntent false for code questions", () => {
    const result = evaluateTurn(ctx("where is the auth middleware defined?"));
    assert.equal(result.needsScout, true);
    assert.equal(result.implementIntent, false);
  });

  it("should have implementIntent true regardless of needsScout", () => {
    const result = evaluateTurn(ctx("fix the login redirect"));
    assert.equal(result.implementIntent, true);
    // needsScout may or may not be true; they're independent
  });

  it("should have both false for casual conversation", () => {
    const result = evaluateTurn(ctx("thanks, that helped!"));
    assert.equal(result.needsScout, false);
    assert.equal(result.implementIntent, false);
  });

  it("should have both false for docs-only question", () => {
    const result = evaluateTurn(ctx("what does the README say about setup?"));
    assert.equal(result.needsScout, false);
    assert.equal(result.implementIntent, false);
  });
});
