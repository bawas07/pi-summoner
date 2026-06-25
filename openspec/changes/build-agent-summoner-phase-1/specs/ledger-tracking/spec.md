## ADDED Requirements

### Requirement: Record every file touch
The system SHALL record an entry in the Ledger for every file operation performed by any agent: `{file: string, agent: string, action: "read" | "write" | "delete", timestamp: number}`. The orchestrator MUST update the Ledger after every agent report-back.

#### Scenario: Crafter writes a file
- **WHEN** Crafter reports that it modified `src/auth/login.ts`
- **THEN** the Ledger appends `{file: "src/auth/login.ts", agent: "crafter-1", action: "write", timestamp: <now>}`

#### Scenario: Scout reads multiple files
- **WHEN** Scout reports findings from `src/auth/` and `src/middleware/`
- **THEN** the Ledger appends a read entry for each file Scout touched

### Requirement: Consult Ledger before new summons
The system SHALL consult the Ledger before summoning any agent to provide context about what has been touched already.

#### Scenario: Second Crafter step
- **WHEN** the orchestrator is about to summon Crafter for the second step of a plan
- **THEN** it reads the Ledger to see what files were modified in the first step, providing that context to the new Crafter instance

### Requirement: Ledger is orchestrator-owned
Only `orchestrator.ts` SHALL have write access to the Ledger. No sub-agent or Gatekeeper instance MUST be able to modify Ledger state directly.

#### Scenario: Agent reports back
- **WHEN** any agent returns results to the orchestrator
- **THEN** the orchestrator (not the agent) is responsible for updating the Ledger with what was touched

### Requirement: In-memory persistence (Phase 1)
The Ledger SHALL exist as an in-memory data structure (array or Map) within the extension's module scope. It persists for the duration of the pi session and resets on session restart.

#### Scenario: Ledger survives across multiple orchestrator loops
- **WHEN** the user completes one task and starts a new one in the same session
- **THEN** the Ledger retains entries from both tasks for reference

#### Scenario: Session restart
- **WHEN** pi is restarted (`/reload` or process restart)
- **THEN** the Ledger is fresh/empty; no historical entries are preserved (Phase 1 limitation)
