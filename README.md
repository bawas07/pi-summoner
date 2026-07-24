# agent-summoner

A [pi](https://pi.dev) extension with two modes — **Plan** for analysis and design, **Craft** for implementation — powered by a cast of specialized agents: Scout, Crafter, and Gatekeeper.

## Two Modes

| Mode | What it does | Default |
|---|---|---|
| 🔮 **Plan** | Analysis, exploration, architecture design. Writes only `.md` files. Can use Scout, `ask_user_question`, and other read-only tools. Write-capable agents (Crafter/Gatekeeper) are blocked. Calls `plan_checkpoint` to get approval before switching modes. | Yes |
| ⚡ **Craft** | Full code editing. Main session acts as **Tech Lead** and **nudges** toward specialists: **Scout** explores, **Crafter** implements non-trivial work, **Gatekeeper** reviews (read-only). |

Toggle with `/mode` or Shift+Tab.

## Agent Cast

| Agent | Role | When to use |
|---|---|---|
| 🔍 **Scout** | Read-only codebase search | Codebase exploration |
| 🛠️ **Crafter** | Focused implementation | Default for non-trivial code changes |
| 🚧 **Gatekeeper** | Read-only quality gate | After implementation — approve / request-changes / escalate |
| 🔎 **code-reviewer** / **architect-reviewer** / **security-auditor** | Specialist read-only reviewers | Via Gatekeeper full-reviews or direct spawn |

The main agent is **Tech Lead**: coordinates, verifies, synthesizes. Prefer specialists over solo IC work. Solo main edits are for true one-liners or when you explicitly ask.

### Orchestration policy

Today: **`nudge`** (default). Main keeps write tools; prompts push Crafter/Gatekeeper usage.

Reserved setting in `.pi/summoner.json`:

```json
{ "orchestrationMode": "hybrid" }
```

`hybrid` will eventually block main write/edit unless a solo escape is active. **Not implemented yet** — if set, runtime still behaves as nudge.

## Workflow

```
Your request
    │
    ▼
🔮 PLAN MODE (default)
    │
    ├── Scout searches codebase
    ├── ask_user_question for clarifications
    ├── Main agent analyzes, hazards-scan
    ├── Summary checkpoint (confirm direction)
    ├── Full plan → .md + plan_checkpoint
    │
    ▼  [user approves]
    │
⚡ CRAFT MODE (nudge)
    │
    ├── Scout searches codebase (as needed)
    ├── Crafter implements each task (default)
    ├── Gatekeeper reviews (read-only)
    ├── Fix cycle via Crafter (if needed)
    └── Done when Gatekeeper approves (unless you skip review)
```

## Commands

| Command | What it does |
|---|---|
| `/mode` | Toggle between Plan and Craft mode |
| `/agents` | Interactive agent management menu (settings, agent types) |
| `/party:start` | Configure per-agent model overrides |
| `plan_checkpoint` | Called by the LLM in Plan mode to request approval |

## Tools

| Tool | What it does |
|---|---|
| `Agent` | Spawn a specialized agent (Scout / Crafter / Gatekeeper / …) |
| `get_subagent_result` | Check status/result of a background agent |
| `steer_subagent` | Send a mid-run steering message to a running agent |
| `plan_checkpoint` | Structured plan approval UI |

## Installation

```bash
# Clone into your pi extensions directory
git clone https://github.com/bawas07/agent-summoner.git
```

Add `agent-summoner` to your pi extensions config, or symlink it into your project's `.pi/extensions/`.

## Configuration

| File | Purpose |
|---|---|
| `<cwd>/.pi/summoner.json` | Per-project settings (max concurrent, `orchestrationMode`, etc.) |
| `~/.pi/agent/summoner.json` | Global defaults (hand-edited) |
| `<cwd>/.pi/agents/*.md` | Custom agent definitions (frontmatter: tools, model, system prompt) |
| `<cwd>/party.rules.json` | Per-agent model overrides for Scout / Crafter / Gatekeeper |

Settings are managed via `/agents → Settings`.

## License

MIT — based on original work by [tintinweb](https://github.com/tintinweb).
