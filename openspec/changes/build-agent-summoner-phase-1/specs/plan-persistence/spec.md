## ADDED Requirements

### Requirement: Write plan files to disk
The system SHALL persist every action plan as a markdown file in `docs/tasks/` with the filename format `{ISO-date}-{kebab-case-short-title}.md`. The file MUST contain a checklist of steps with `[ ]` (unchecked) markers.

#### Scenario: New plan created
- **WHEN** the orchestrator drafts a plan for "fix login redirect"
- **THEN** a file like `docs/tasks/2026-06-25-fix-login-redirect.md` is written with checklist items

#### Scenario: Plan file format
- **WHEN** a plan file is written
- **THEN** it contains markdown headings, a list of steps using `- [ ] Step description` format, and metadata (title, date, trust mode)

### Requirement: Check off completed steps
The system SHALL update the plan file's checklist as the orchestrator completes each step, changing `- [ ]` to `- [x]` for the corresponding step index.

#### Scenario: Step completed in trust mode
- **WHEN** Crafter reports a completed step and trust mode is active
- **THEN** the plan file's corresponding checklist item is marked `[x]` and the orchestrator proceeds to the next step

#### Scenario: Step completed in checkpoint mode
- **WHEN** Crafter reports a completed step and checkpoint mode is active
- **THEN** the plan file's corresponding checklist item is marked `[x]` and the orchestrator checks in with the user before continuing

### Requirement: Find existing plans
The system SHALL scan `docs/tasks/` for plan files that match the current task description before drafting a new plan. If a matching plan exists (from a prior session or user-authored file), it MUST be loaded instead of drafting a new one.

#### Scenario: Continuing from an existing plan
- **WHEN** the heavy loop triggers for a task and a plan file already exists in `docs/tasks/` matching the description
- **THEN** the existing plan is loaded and presented for approval; no new plan file is created

#### Scenario: No matching plan exists
- **WHEN** the heavy loop triggers and `findExisting()` returns null
- **THEN** a new plan is drafted and written to a new file

### Requirement: Archive completed plans
The system SHALL move completed plan files from `docs/tasks/` to `docs/tasks/archived/` when the orchestrator loop finishes all steps and Gatekeeper reports clean.

#### Scenario: Plan successfully completed
- **WHEN** all steps are done and Gatekeeper's final check reports no issues
- **THEN** the plan file is moved to `docs/tasks/archived/` and the user is notified of completion

#### Scenario: Plan completed with out-of-scope Gatekeeper findings
- **WHEN** all steps are done but Gatekeeper finds pre-existing issues
- **THEN** the plan is still archived; out-of-scope findings are reported to the user separately
