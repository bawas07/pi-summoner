## ADDED Requirements

### Requirement: No Crafter without a plan (hard constraint)
The system SHALL never summon Crafter without a plan existing first. This is a hard constraint with zero exceptions, regardless of how small the task appears. If no plan exists, the orchestrator MUST first draft a plan, present it to the user for approval, and only then proceed.

#### Scenario: Small task, no plan exists
- **WHEN** the user says "add a console.log in the login function"
- **THEN** the orchestrator creates a plan (even a minimal one-line plan), gets approval, then summons Crafter — never summons Crafter directly

#### Scenario: Plan already exists from earlier session
- **WHEN** `plan-file.ts` finds a matching plan in `docs/tasks/` and the user approves loading it
- **THEN** the orchestrator proceeds to summon Crafter for the first unchecked step

### Requirement: Plan approval sets trust mode
The system SHALL present the action plan to the user for approval before any Crafter step executes. The approval interaction MUST also set the trust mode for this plan (🙈 trust mode or 🔍 checkpoint mode) as a single decision point.

#### Scenario: User approves plan with trust mode
- **WHEN** the user approves the plan and selects trust mode
- **THEN** the orchestrator proceeds through all steps without re-asking at each one

#### Scenario: User approves plan with checkpoint mode
- **WHEN** the user approves the plan and selects checkpoint mode
- **THEN** the orchestrator checks in with the user at each step before summoning the next agent

#### Scenario: User rejects plan
- **WHEN** the user does not approve the plan
- **THEN** the orchestrator revises based on feedback and re-presents; no Crafter is summoned

### Requirement: Sequential step execution
The system SHALL execute plan steps sequentially — one agent at a time, one step at a time. After each agent reports back, the orchestrator MUST update the Ledger and plan file before deciding the next action.

#### Scenario: Two-step plan execution
- **WHEN** a plan has steps "add auth middleware" then "update routes"
- **THEN** Crafter completes step 1 → reports → Ledger/plan updated → Crafter summoned for step 2 → completes → reports

### Requirement: Gatekeeper always runs after Crafter
The system SHALL summon Gatekeeper after all plan steps are completed, every time, without exception. Gatekeeper MUST check functional correctness (can the feature actually work) and report all findings to the orchestrator.

#### Scenario: Gatekeeper reports clean
- **WHEN** Gatekeeper runs tests and functional checks with no issues found
- **THEN** the orchestrator reports completion to the user and archives the plan

#### Scenario: Gatekeeper finds an in-scope issue
- **WHEN** Gatekeeper finds a bug introduced by this task's Crafter (e.g., a logic error in the newly written code)
- **THEN** the orchestrator dispatches Crafter to fix it without asking the user; then Gatekeeper re-runs

#### Scenario: Gatekeeper finds an out-of-scope issue
- **WHEN** Gatekeeper finds a pre-existing issue not caused by this task's agents (e.g., an unrelated broken test)
- **THEN** the orchestrator reports the finding to the user and asks what to do — never auto-fixes out-of-scope issues

### Requirement: Gatekeeper findings routing by provenance
The system SHALL route Gatekeeper findings based on provenance (who caused the issue), not severity. In-scope issues (caused by this task's agents) go back to Crafter without user approval. Out-of-scope issues (pre-existing) always require user decision.

#### Scenario: Unused scaffolding file
- **WHEN** Gatekeeper reports an unused file that Crafter created during this task but never ended up using
- **THEN** the orchestrator dispatches Crafter to remove it — in-scope, no user approval needed

#### Scenario: Pre-existing bug in unrelated module
- **WHEN** Gatekeeper reports a failing test in a module untouched by this task
- **THEN** the orchestrator asks the user "Should I fix this too or leave it?" — out-of-scope, user decides

### Requirement: Gatekeeper is strictly read-only
Gatekeeper MUST never delete, edit, or write any file. Even an obviously safe fix (like removing an unused file Gatekeeper itself flagged) MUST flow back through Crafter. This is enforced architecturally via tool restrictions.

#### Scenario: Gatekeeper identifies an unused file
- **WHEN** Gatekeeper reports a scaffolding file that should be deleted
- **THEN** it reports the finding to the orchestrator; the orchestrator dispatches Crafter to delete it — Gatekeeper itself never touches disk

### Requirement: Scout re-summon is judgment-based (Phase 3 deferred)
In Phase 1, the system SHALL execute a single linear pass without mid-task Scout re-summons. The infrastructure to support blast-radius judgment SHOULD be designed with re-summon capability in mind but not implemented.

#### Scenario: Phase 1 linear execution
- **WHEN** Crafter reports a change that has a wide blast radius
- **THEN** in Phase 1, the orchestrator continues with the current plan without re-summoning Scout (refinement deferred to Phase 3)
