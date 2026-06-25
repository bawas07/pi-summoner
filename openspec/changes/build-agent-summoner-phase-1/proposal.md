## Why

Main Agent needs the ability to summon specialized sub-agents (Scout for codebase search, Crafter for implementation, Gatekeeper for verification) without the user explicitly typing a command. The current `/summoner` v2 requires manual invocation — v3 makes triggering ambient, where Main Agent watches the conversation and decides when to dispatch Scout or kick off the plan→execute→verify loop. Phase 1 proves the two riskiest parts: ambient trigger accuracy and the actual RPC subprocess orchestration mechanic.

## What Changes

- **New extension module structure**: `types.ts`, `trigger.ts`, `rpc-client.ts`, `plan-file.ts`, `ledger.ts`, `agents.ts`, `orchestrator.ts`, `index.ts`
- **Ambient trigger evaluation**: `trigger.ts` runs on every conversation turn, evaluating two independent signals — `needsScout` (codebase info needed) and `implementIntent` (user wants to build/fix something)
- **Subprocess spawning via RPC**: `rpc-client.ts` wraps `pi --mode rpc` subprocess creation and JSONL communication
- **Plan file persistence**: `plan-file.ts` writes/reads/checks-off/archives markdown plans in `docs/tasks/`
- **Ledger tracking**: `ledger.ts` maintains in-memory `{file, agent, action, timestamp}` records of all file touches
- **Agent role definitions**: `agents.ts` registers Scout (read-only search), Crafter (write), Gatekeeper (read-only verify) through a flat, equal interface
- **Orchestrator loop**: `orchestrator.ts` decides→plans→summons→loops, enforcing the hard constraint that Crafter never runs without a plan
- **Entry point**: `index.ts` registers `/summoner` command (manual override) and the `turn_start` ambient trigger hook

**Explicitly deferred** to Phase 2/3: tmux window orchestration, incantation flavor text, model assignment per role, code-quality Gatekeeper review, mid-task Scout re-summon, subprocess crash recovery, concurrent Scout.

## Capabilities

### New Capabilities

- `ambient-trigger`: Per-turn evaluation of Scout-need and implement-intent signals from conversation context
- `rpc-subprocess`: Spawn and communicate with `pi --mode rpc` subprocesses over JSONL stdin/stdout
- `plan-persistence`: Write, read, update checklist items, and archive markdown plan files on disk
- `ledger-tracking`: In-memory record of all file touches by agent, action, and timestamp
- `agent-registry`: Flat, equal registration of built-in and user-defined agent roles with tool enforcement
- `orchestrator-loop`: Sequential plan→approve→summon→verify loop with trust/checkpoint modes

### Modified Capabilities

_None — this is a greenfield extension; no existing specs to modify._

## Impact

- Affected code: New extension directory `.pi/extensions/summoner/` with 8 TypeScript modules
- Dependencies: `@earendil-works/pi-coding-agent` (ExtensionAPI), Node built-ins (`child_process`, `fs/promises`), pi.dev tool registration APIs
- Systems: Integrates with pi session lifecycle (`session_start`, `turn_start` hooks), pi tool execution (tools registered as `summon_scout`, `summon_crafter`, `summon_gatekeeper`), session JSONL for Ledger persistence
- No external services, no database, no HTTP boundaries — purely a local extension within the user's pi session
