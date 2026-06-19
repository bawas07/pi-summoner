# PRD — Multi-Agent Orchestration Extension for Pi

## 1. Overview

Pi ships without native sub-agents or plan mode by design — it's a minimal harness meant to be extended. This extension adds a **multi-agent orchestration layer** on top of Pi: a Main Agent that plans work, and a set of summonable sub-agents that execute it, with strict conflict-avoidance and a human approval gate before anything touches disk.

The core motivation isn't "more agents for the sake of it" — it's **context minimization**. A single agent reading every file it might need quickly fills its context window with irrelevant content. By splitting "finding things" from "building things" from "verifying things," each agent only ever holds the minimal slice of information it needs, and the Main Agent's context stays clean enough to actually reason well about the overall plan.

## 2. Problem Statement

When one agent does everything — searching, planning, editing, testing — three things go wrong:

- **Context bloat.** Every file read for "context" stays in the conversation forever, crowding out the actual reasoning.
- **No parallelism.** Independent changes (e.g. two unrelated dashboard files) get done serially because there's only one thread of execution.
- **No safety net for conflicting edits.** If you DO try to parallelize naively, two workers can stomp on the same file with no coordination.

This system solves all three with a dedicated agent per concern, a deterministic dependency-aware execution plan, and a single source of truth (the **Ledger**) for what's been touched, by whom, and in what order.

## 3. Agent Roles

All agents are **flat and equal** — built-in agents and user-defined agents are registered through the exact same interface. There is no special-cased "core" agent; "built-in" just means we ship the definition file alongside the extension.

| Agent | Role | Memory | Can be summoned in parallel? |
|---|---|---|---|
| **Scout** | Finds files, symbols, and code blocks. Builds AST-level dependency graphs. Returns minimal relevant slices, never full files. | Session-scoped cache (avoids re-scanning the same paths) | Yes, for independent scoping tasks |
| **Crafter** | Implements the plan — writes/edits files, installs dependencies. | None persistent — relies on the Ledger for cross-instance awareness | Yes — this is the primary parallel worker |
| **Gatekeeper** | Runs tests, verifies the final result. Always operates on the full picture, never just the touched files. | None — always runs fresh | Generally one instance per verification pass |
| **User-defined** | Anything the user wants (e.g. a doc-writer, a linter-fixer). Registered identically to built-ins. | Opt-in via config | Same rules as any other agent |

Naming note: agents are **summoned**, not dispatched — `summon` was chosen deliberately over more aggressive verbs like "unleash" because these agents are called forth deliberately as part of an approved plan, not let loose autonomously.

The orchestrator itself (referred to here as "Main Agent") is intentionally **unnamed** in this spec. It's never summoned — it's just the thing running the show — so it doesn't need guild-style naming. Users can give it a name via their own `agent.md`/config if they want.

## 4. Core Design Principles

1. **Context minimization first.** Every agent's return value should be the smallest useful slice, not raw dumps.
2. **Single source of truth.** The Ledger (owned by Main Agent) is the only place file status lives. No agent maintains its own conflicting view of "what's done."
3. **Plan before you touch anything.** Scout builds a real dependency graph before Main Agent commits to a phase plan — slower upfront, much safer downstream ("better safe than sorry, slower is faster").
4. **Trust the agent on the ground.** Once an agent is mid-task and discovers something unplanned, it reports back with enough context (file + its imports) for Main Agent to make a fast decision — no automatic re-scan required. See `flow.md` for the full mechanism and reasoning (the "surveyor vs. builder" model).
5. **Human approval gates where it matters.** Every task starts with a plan + trust-mode approval. Out-of-scope test failures always require a decision from the user, regardless of trust mode.
6. **Chain of command stays intact.** Users can watch a summoned agent's live activity, but cannot give it instructions directly — redirection always flows back through Main Agent, which is the only thing allowed to update the Ledger.

## 5. UX Behavior

### 5.1 Plan Presentation & Trust Mode (per task)

Before any execution starts, Main Agent presents:
- The dependency graph summary (what Scout found)
- The phase breakdown (who does what, in what order)
- Any risk notes / uncertainty flagged by Scout
- A trust-mode question, asked **per task** (not a global setting), because risk tolerance is situational — a typo fix and a breaking schema change warrant different levels of oversight from the same person.

Trust modes:

| Mode | Icon | Behavior |
|---|---|---|
| Trust mode ("I trust you") | 🙈 | Only interrupts for plan approval and the final report. Unplanned-file discoveries auto-proceed (logged, not asked). In-scope test failures are auto-fixed and re-tested. |
| Checkpoint mode ("keep me in the loop") | 🔍 | Interrupts at phase boundaries, on unplanned file discovery, and before fixing in-scope test failures. |

**Exception in both modes:** if Gatekeeper finds a failure in a file that was never part of the task's original scope, Main Agent always asks the user what to do — auto-fixing scope creep without permission isn't safe even in full trust mode.

### 5.2 Watching a Summoned Agent (`/watch`)

Users can switch their view from the Main Agent conversation to a **live, read-only feed** of a specific summoned agent's activity.

- `/watch <agent-name>` — full takeover view, live-tails that agent's current work
- `Esc` / `/back` — returns to Main Agent view
- The watched agent keeps working regardless of whether anyone is watching — watching is purely observational, it never pauses execution
- **No input channel to the sub-agent.** If the user wants to redirect or intervene, they return to Main Agent and say so there. Main Agent decides whether/how to relay that to the running agent. This preserves the chain of command and keeps the Ledger as the only place state changes happen.

A persistent status widget (visible in the default Main Agent view) shows all currently active/queued/done agents at a glance, so users know who's watchable without having to ask.

```
🟢 crafter-1   dashboard.js   (working)
🟡 crafter-2   waiting (phase gate)
✅ crafter-3   settings.js    (done)
```

## 6. Naming Rationale

A lightweight fantasy-guild theme was chosen over generic role names (Implementor/Tester) to give the system personality without leaning so hard into existing IP (e.g. Tolkien-specific terms) that it becomes derivative or trademark-adjacent.

- **Scout** — sent ahead, reports back; intuitive even outside the theme
- **Crafter** — takes a plan and builds it; works equally well solo or "summon 3 Crafters" as a group
- **Gatekeeper** — verifies and guards what passes through to the user as "done"

## 7. Out of Scope (for now)

- Direct user-to-subagent intervention (watch mode is read-only by design — see §5.2)
- Global/default trust-mode setting (intentionally per-task only)
- Automatic re-scanning by Scout on every unplanned discovery (see `flow.md` §4 for why this was rejected in favor of trusting the agent's field report)