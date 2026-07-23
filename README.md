# agent-summoner

A [pi](https://pi.dev) extension with two modes — **Plan** for analysis and design, **Craft** for implementation — powered by a cast of specialized agents: Scout, Crafter, and Gatekeeper.

## Two Modes

| Mode | What it does | Default |
|---|---|---|
| 🔮 **Plan** | Analysis, exploration, architecture design. Writes only `.md` files. Hazard scanning catches security issues, inconsistencies, and ambiguities. Calls `plan_checkpoint` to get approval before switching modes. | Yes |
| ⚡ **Craft** | Full code editing. Delegates implementation to **Crafter** (unless change is trivial), searches via **Scout**, and **Gatekeeper** reviews every Crafter output. |

Toggle with `/mode`.

## Agent Cast

| Agent | Role | When it triggers |
|---|---|---|
| 🔍 **Scout** | Read-only codebase search | Every codebase exploration — never grep/find manually |
| 🛠️ **Crafter** | Focused implementation | Any task beyond a trivial one-liner |
| 🚧 **Gatekeeper** | Code review, test verification, quality gate | Mandatory after every Crafter task — non-negotiable |

The main agent acts as **tech lead**: coordinates, verifies, synthesizes. It does not search codebases itself (that's Scout) and does not write non-trivial code itself (that's Crafter).

## Workflow

```
Your request
    │
    ▼
🔮 PLAN MODE (default)
    │
    ├── Scout searches codebase
    ├── Main agent analyzes, hazards-scan
    ├── Summary checkpoint (confirm direction)
    ├── Full plan → plan_checkpoint
    │
    ▼  [user approves]
    │
⚡ CRAFT MODE
    │
    ├── Scout searches codebase (every time)
    ├── Crafter implements each task
    ├── Gatekeeper reviews Crafter's output
    ├── Fix cycle via Crafter (if needed)
    └── Done when Gatekeeper approves
```

## Commands

| Command | What it does |
|---|---|
| `/mode` | Toggle between Plan and Craft mode |
| `/agents` | Interactive agent management menu (settings, agent types) |
| `/party:start` | Configure per-agent model overrides |
| `plan_checkpoint` | Called by the LLM in Plan mode to request approval |

## Tools

The extension registers three LLM-callable tools:

| Tool | What it does |
|---|---|
| `Agent` | Spawn a specialized agent (Scout / Crafter / Gatekeeper) in foreground or background |
| `get_subagent_result` | Check status/result of a background agent |
| `steer_subagent` | Send a mid-run steering message to a running agent |

## Installation

```bash
# Clone into your pi extensions directory
git clone https://github.com/bawas07/agent-summoner.git
```

Add `agent-summoner` to your pi extensions config, or symlink it into your project's `.pi/extensions/`.

## Configuration

| File | Purpose |
|---|---|
| `<cwd>/.pi/summoner.json` | Per-project settings (max concurrent agents, default turns, etc.) |
| `~/.pi/agent/summoner.json` | Global defaults (hand-edited) |
| `<cwd>/.pi/agents/*.md` | Custom agent definitions (frontmatter: tools, model, system prompt) |
| `<cwd>/party.rules.json` | Per-agent model overrides for Scout / Crafter / Gatekeeper |

Settings are managed via `/agents → Settings`.

## License

MIT — based on original work by [tintinweb](https://github.com/tintinweb).

