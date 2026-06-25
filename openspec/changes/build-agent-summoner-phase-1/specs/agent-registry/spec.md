## ADDED Requirements

### Requirement: Flat agent registration interface
The system SHALL register all agents (built-in and user-defined) through the same flat interface. There MUST be no special-cased "core" agent — Scout, Crafter, and Gatekeeper use the same `AgentDefinition` shape as any user-defined agent.

#### Scenario: Registering a built-in agent
- **WHEN** `agents.ts` registers Scout with `{name: "scout", systemPrompt: "...", tools: ["read", "search"], canDispatchWithoutApproval: true}`
- **THEN** a `summon_scout` tool is registered with pi, callable by Main Agent

#### Scenario: Registering a user-defined agent
- **WHEN** a user adds a `docs-writer` agent definition with the same `AgentDefinition` shape
- **THEN** it is registered as `summon_docs_writer` with no different treatment than built-ins

### Requirement: Tool-based enforcement of agent capabilities
The system SHALL enforce agent capabilities through tool availability, not just prompt instructions. Gatekeeper's tool list MUST exclude all file-mutation tools (`write`, `edit`, `delete`). This is an architectural guarantee, not a behavioral one.

#### Scenario: Gatekeeper cannot write files
- **WHEN** Gatekeeper is summoned with `tools: ["read", "bash", "web_search"]` (no write/edit/delete)
- **THEN** the subprocess has no path to modify files, regardless of what the prompt instructs

#### Scenario: Crafter has write access
- **WHEN** Crafter is summoned with `tools` including file write/edit capabilities
- **THEN** it can modify files on disk, with all writes wrapped in `withFileMutationQueue`

### Requirement: Scout is read-only and dispatchable without approval
Scout SHALL have `canDispatchWithoutApproval: true` — Main Agent can summon Scout at any time without asking the user. Scout's tool list MUST contain only read/search operations.

#### Scenario: Ambient Scout dispatch
- **WHEN** `trigger.ts` sets `needsScout` to `true` mid-conversation
- **THEN** the orchestrator dispatches Scout immediately without user approval

#### Scenario: Scout tools are read-only
- **WHEN** Scout's `AgentDefinition` is examined
- **THEN** its `tools` array contains only read/search tools (e.g., `read`, `grep`, `find`, `bash` for read-only commands), never `write`, `edit`, or `delete`

### Requirement: Agent definitions include model defaults
Each agent definition SHALL specify a `defaultModel` and `defaultThinking` level. In Phase 1, these are hardcoded; Phase 2 will add `get_available_models` querying.

#### Scenario: Phase 1 model assignment
- **WHEN** the orchestrator summons Crafter in Phase 1
- **THEN** it uses the hardcoded `defaultModel` from Crafter's `AgentDefinition` rather than querying available models
