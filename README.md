# Agent Summoner

Multi-agent orchestration extension for [Pi](https://pi.dev) — Scout (find), Crafter (build), Gatekeeper (verify), coordinated by a Main Agent with a Ledger.

## Install

```bash
pi install git:github.com/bawas07/pi-summoner
```

## Agents

| Agent | Role | Tool |
|---|---|---|
| **Scout** | Finds files, symbols, builds AST dependency graphs | `summon_scout` |
| **Crafter** | Implements planned file changes, installs dependencies | `summon_crafter` |
| **Gatekeeper** | Runs tests, classifies failures, enforces trust mode | `summon_gatekeeper` |

## Quick start

```
/summoner "Update the API response format"
```

This launches the full workflow:
1. **Scout** maps dependencies
2. **Plan** presents phases → you approve → you pick trust mode (🙈/🔍)
3. **Crafters** execute in parallel-safe phases
4. **Gatekeeper** captures baseline, verifies, classifies failures
5. **Report** from the Ledger

Plans are written to `.pi/bulletin/<slug>_<timestamp>.md` and updated live.

## Commands

| Command | Description |
|---|---|
| `/summoner <task>` | Full orchestrator workflow |
| `/summon <agent>` | Trigger a single agent |
| `/watch <agent>` | Read-only live feed of an agent |
| `/back` | Return from watch mode |

## User-defined agents

Add your own agents — they work identically to built-ins.

See [docs/user-agents.md](docs/user-agents.md) for the full guide.

**Quick config** (`.pi/agents.json`):
```json
[
  {
    "name": "docs-writer",
    "description": "Writes documentation. Summon after API changes.",
    "handlerPath": "./agents/docs-writer.ts"
  }
]
```

## Develop

```bash
npm install
npm run typecheck
npm test
```

91 tests, strict TypeScript.

## Docs

| Doc | What |
|---|---|
| [PRD](docs/prd.md) | Product requirements, agent roles, UX |
| [Flow](docs/flow.md) | System mechanics, Ledger state machine |
| [Plan](docs/plan.md) | Implementation plan, architecture |
| [User Agents](docs/user-agents.md) | How to define your own agents |
## License

MIT
