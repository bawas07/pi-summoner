## ADDED Requirements

### Requirement: Scout-need detection on every turn
The system SHALL evaluate every conversation turn to determine whether Main Agent needs codebase information to answer or proceed. This evaluation MUST run on every message regardless of timing — start of a topic, mid-discussion, mid-task, post-task, or in response to a side-question.

#### Scenario: Fresh topic requiring codebase knowledge
- **WHEN** the user starts a new topic that references codebase entities (files, functions, modules)
- **THEN** `trigger.ts` sets `needsScout` to `true` and Main Agent dispatches Scout

#### Scenario: Docs lookup, not codebase
- **WHEN** the user asks about project documentation (README, PRD, architecture decisions)
- **THEN** `trigger.ts` sets `needsScout` to `false`; Main Agent reads docs directly without summoning Scout

#### Scenario: Casual conversation with no codebase need
- **WHEN** the user engages in discussion, brainstorming, or questions that require no codebase knowledge
- **THEN** `trigger.ts` sets `needsScout` to `false`; no Scout is dispatched

### Requirement: Implement-intent detection on every turn
The system SHALL evaluate every conversation turn for signals that the user intends to implement a change (bug fix or feature), not merely discuss or explore it. This signal is narrower and higher-stakes than Scout-need — false positives here trigger the full plan→execute→verify loop.

#### Scenario: Clear implementation request
- **WHEN** the user says "fix the login redirect bug" or "build the user settings page"
- **THEN** `trigger.ts` sets `implementIntent` to `true`

#### Scenario: Discussion without implementation intent
- **WHEN** the user says "how does the login redirect work right now?" or "what if we had a settings page?"
- **THEN** `trigger.ts` sets `implementIntent` to `false`; only Scout may be dispatched, no heavy loop

#### Scenario: Ambiguous intent
- **WHEN** the user says "the login redirect is broken" without explicitly asking for a fix
- **THEN** `trigger.ts` sets `implementIntent` to `true` — the bar is intent-to-implement generally, not a specific magic phrase

### Requirement: Manual override via /summoner command
The system SHALL register `/summoner <task>` as a command that forces the heavy loop to start regardless of what ambient detection would have decided. This is the fallback when `trigger.ts` is misfiring or when the user wants explicit control.

#### Scenario: Command overrides ambient detection
- **WHEN** the user types `/summoner fix the auth middleware`
- **THEN** `implementIntent` is treated as `true` and the orchestrator loop begins, bypassing the ambient trigger evaluation

### Requirement: Independent trigger evaluation
The two trigger signals (`needsScout` and `implementIntent`) SHALL be evaluated independently. Needing Scout MUST NOT imply implement-intent, and implement-intent MUST NOT force a Scout dispatch if not needed.

#### Scenario: Needs codebase info but no implementation intent
- **WHEN** the user asks "where is the auth middleware defined?"
- **THEN** `needsScout` is `true` and `implementIntent` is `false`; only Scout is dispatched

#### Scenario: Implementation intent without prior Scout need
- **WHEN** the user says "fix the login redirect" after a discussion that already covered the relevant code
- **THEN** `implementIntent` is `true` and `needsScout` may be `false`; the orchestrator loop may start without a Scout dispatch
