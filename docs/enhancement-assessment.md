# Enhancement Assessment: agent-summoner

**Goal:** Review current agent-summoner code and recommend high-value updates, using Grok CLI and Claude Code as reference systems.

**Scope:** Analysis only. Written for review — not an implementation commit unless you choose to act on it.

**Date:** 2026-07-24

---

## Current state (what is already strong)

agent-summoner is a mature pi extension with a real orchestration stack, not a thin wrapper:

| Area | Status |
|---|---|
| Subagent lifecycle | spawn / queue / resume / steer / abort / cleanup |
| Isolation | git worktree + branch handoff |
| UI | fleet list, agent widget, conversation viewer, mode indicator |
| Join modes | async / group / smart batch completion |
| Config | `.pi/summoner.json`, custom `.md` agents, party model rules |
| Tool surface | `Agent`, `get_subagent_result`, `steer_subagent`, `plan_checkpoint` |
| Modes | Plan vs Craft personas + hard `tool_call` guard |
| Cross-ext | RPC + global manager registry + lifecycle events |

Built-in cast is broader than the README advertises:

- Core cast: `Scout`, `Crafter`, `Gatekeeper`, `general-purpose`
- Review cast: `code-reviewer`, `architect-reviewer`, `security-auditor`

Compared to upstream pi-subagents heritage, this fork already owns a distinctive Plan/Craft workflow and a strong main-orchestrator persona.

---

## Critical bugs (fix before features)

### 1. Plan-mode write guard is inverted / always blocks path writes

In `src/index.ts` (~line 378):

```ts
if (path && (!path.endsWith(".md") || !path.endsWith(".json"))) {
```

A path cannot end with both `.md` and `.json`, so `!A || !B` is **always true**. Result:

- Any write/edit with a path is blocked, including legitimate `.md` plan files
- Message claims only `.md` is allowed, but logic never allows it

**Fix:** allow only the intended extensions, e.g.

```ts
const allowed = path.endsWith(".md"); // or also .json if intentional
if (path && !allowed) { block... }
```

Add unit tests for `.md` allow / `.ts` deny / missing path.

### 2. Plan mode blocks the `Agent` tool (Scout is unusable)

After bash/write handling, plan mode falls through to:

```ts
// Custom/unknown tools — block in plan mode
return { block: true, reason: ... }
```

That blocks `Agent`, `get_subagent_result`, and `steer_subagent`.

But `PLAN_MODE_PERSONA` says: use **Scout aggressively** for all exploration. Hard guard contradicts soft prompt.

**Fix:** allowlist subagent tools in plan mode, and only permit read-only agent types (`Scout`, explore-like custom agents). Reject `Crafter` / write-capable types while plan mode is on.

### 3. Plan-mode bash allowlist is too loose

Destructive command regex misses many write vectors:

- `sed -i`, `tee`, `python -c 'open(...).write'`, `npm install`, `git commit`, `echo foo > file` edge cases
- Comment claims tests are allowed, but running tests is fine; package install / codegen is not

Grok’s approach is cleaner: **block edit tools**, don’t pretend to fully police bash. Either:

- treat bash as blocked in plan mode (strict), or
- allow only an explicit read-only command prefix list

### 4. Docs / registry drift

- README lists only Scout / Crafter / Gatekeeper
- `DEFAULT_AGENT_NAMES` omits review agents that ship in `default-agents.ts`
- Gatekeeper description promises “mandatory review”, but Gatekeeper itself asks the user whether to skip

---

## Gaps vs Grok CLI

| Grok feature | agent-summoner today | Recommendation |
|---|---|---|
| `capability_mode`: read-only / read-write / execute / all | Per-agent tool allowlists only | Add optional `capability_mode` on `Agent` that maps to tool sets |
| First-class plan file + `exit_plan_mode` approval UI (scroll, line comments) | `plan_checkpoint` binary select + freeform feedback | Persist plan to session plan file; richer approve / request-changes flow |
| `wait` multi-task (`wait_any` / `wait_all` + `timeout_ms`) | `get_subagent_result({ wait })` single agent, unbounded | Add `wait_subagents` with ids, mode, timeout |
| LLM-facing kill | Manager abort via menu / session shutdown | Add `kill_subagent` tool |
| Nested spawn depth fail-fast | Child excludes parent spawn tools (good) | Keep exclusion; surface clearer depth-limit error if reintroduced |
| Persona overlay separate from agent type | Personas only as main-session prompt append | Optional persona layer for subagents (tone / report format) without forking full agent defs |
| Worktree apply/merge | Leaves branch + merge instructions | Optional `apply_worktree` / merge helper after approval |
| Still-running status line for bg work | Fleet + notifications | Good enough; optionally mirror status-line counts |

Highest ROI from Grok: **capability modes**, **multi-wait + timeout**, **kill tool**, **plan file lifecycle**.

---

## Gaps vs Claude Code

| Claude pattern | agent-summoner today | Recommendation |
|---|---|---|
| Lean specialist agents (finder / implementation / tester) | Long embedded prompts (~800 lines in `default-agents.ts`) | Slim system prompts; move philosophy into skills |
| Finder = fast haiku explore | Scout already close (haiku + read-only tools) | Keep; tighten bash further for Scout |
| Implementation agent executes task files | Crafter is free-form | Optional task-file contract (path + acceptance criteria schema) |
| Tester separate from reviewer | Gatekeeper mixes test writing + quality gate + optional full-review | Split: **Tester** (writes tests) + **Gatekeeper/Reviewer** (read-only gate) |
| Plan mode is a real mode with hard edit gate | Mode exists, but guard bugs + no plan artifact | Fix guard; store plan.md; approval presents file |
| Soft orchestration via prompt only | Same | Add lightweight **post-Crafter hook** option: auto-spawn Gatekeeper (setting, default off or on) |

Claude’s biggest lesson here: **narrow roles + short prompts + hard tool constraints**, not multi-page persona essays.

---

## Product / architecture enhancements (prioritized)

### P0 — Correctness (1–2 days)

1. Fix `.md` write allow condition
2. Allowlist `Agent` / result / steer in plan mode; restrict spawn types to read-only
3. Add plan-mode guard unit tests (currently under-covered)
4. Align README + `DEFAULT_AGENT_NAMES` with shipped agents

### P1 — Orchestration parity with Grok (3–5 days)

1. **`capability_mode`** on Agent tool  
   Map:
   - `read-only` → read/grep/find/ls (+ optional read-only bash)
   - `read-write` → + write/edit
   - `execute` → read + bash, no write
   - `all` → full
2. **`wait_subagents`** with `mode: wait_any|wait_all` and `timeout_ms`
3. **`kill_subagent`** tool
4. Bounded wait on `get_subagent_result` (`timeout_ms`) so the parent can’t hang forever

### P2 — Plan mode upgrade (3–5 days)

1. Write plan to a session-scoped `plan.md` (or project `.pi/plans/`)
2. `plan_checkpoint` reads that file and shows summary + approve / revise / quit
3. On approve: switch to craft and inject plan path into next turn context
4. When parent is in plan mode, force child isolation for any non-Scout spawn (or reject write-capable types)
5. Optional: summary checkpoint tool (Phase 1 “direction OK?”) as first-class UI, not only prompt text

### P3 — Cast clarity & prompt cost (2–4 days)

1. Split Gatekeeper:
   - **Tester** — writes tests
   - **Gatekeeper** — read-only review / approve / request-changes
2. Slim default prompts; move long philosophy into `skills/`
3. Preload `coding-standards` for Crafter at spawn (don’t rely on model remembering to load skill)
4. Make mandatory Gatekeeper a **setting** (`requireReviewAfterCrafter`), implemented as orchestrator guidance + optional auto-spawn, not only persona prose

### P4 — Isolation & apply workflow (2–3 days)

1. Worktree **apply** helper (cherry-pick / merge branch into parent worktree with confirmation)
2. Expose `cwd` on Agent tool for monorepo packages (RPC already has it; LLM surface does not)
3. Better worktree failure messages already exist — keep strict behavior

### P5 — Structure / maintainability

1. `index.ts` is still ~1166 lines (tools extracted, but mode/settings/commands remain). Extract:
   - `plan-mode-guard.ts`
   - `mode-state.ts`
   - tool registrations module
2. Reduce prompt duplication between `MAIN_CRAFTER_PERSONA`, Crafter, and Gatekeeper
3. Version package (`0.0.0` private) if publishing/fork identity matters

---

## What I would *not* chase soon

- Full Grok scheduler / `/loop` / monitor tooling — belongs in host (pi), not this extension
- Nested multi-level agent trees — Grok correctly caps depth at 1; keep flat
- Replacing fleet UI — already strong and Claude-like
- Expanding review agent count further — three specialists + Gatekeeper is enough; focus on routing quality

---

## Suggested north-star workflow (after fixes)

```
User request
  → Plan mode (hard edit gate + Scout only)
      → write plan.md
      → plan_checkpoint (approve / revise)
  → Craft mode
      → Scout (research)
      → Crafter (implement, optional worktree)
      → Gatekeeper (read-only review)  [optional Tester for tests]
      → wait_subagents / kill as needed
  → Done
```

This keeps agent-summoner’s identity (Scout / Crafter / Gatekeeper cast) while adopting Grok’s hard capability model and Claude’s lean specialist discipline.

---

## Recommended first implementation slice

If implementing next, do **only P0 + smallest P1**:

1. Fix plan-mode `.md` allow bug
2. Allow Scout-family agents in plan mode; block write agents
3. Add `kill_subagent` + `timeout_ms` on get result
4. Tests for plan-mode guard matrix

That unblocks the advertised Plan→Craft story without a large redesign.

---

## Open questions for you

1. Should plan mode allow **only** Scout, or any agent with a read-only toolset?
2. Is Gatekeeper meant to **write tests**, or only gate/review? (Current dual role is the biggest cast confusion.)
3. Do you want mandatory post-Crafter review enforced in code, or keep it prompt-only?
4. Target: stay close to Claude Code fleet UX, or push toward Grok capability/plan-file model?
