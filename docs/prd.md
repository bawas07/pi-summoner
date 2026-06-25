# /summoner — PRD (v3)

> Supersedes v2. v2 replaced v1's rigid upfront-plan-then-approve with a looser, conversational summon loop — but still required explicit `/summoner <task>` invocation. v3's core change: **the trigger becomes ambient.** Main Agent watches the conversation itself and decides when to summon Scout or draft a plan, without being told to via a command. `/summoner` is kept as a manual override, not removed. Agent roles, the Gatekeeper scope/fix flow, model assignment, tmux mechanics, and the incantation are unchanged from v2 — see inline notes for what's new here specifically.

## Problem

v2 fixed the rigidity of v1's planning model, but still depended on the user remembering to type `/summoner` before Main Agent would engage its orchestration powers. That's an unnatural way to work — in practice, you talk to Main Agent the way you'd talk to a product owner: you raise something, they go check on it, you discuss, you ask for a plan, you say go. None of that involves a slash command at any point except the last one ("say go"), and even checking on things ("go look") happens constantly throughout, not just at the start. v3 makes that the actual default behavior, with `/summoner` kept around as an explicit force-trigger for the rare cases ambient detection doesn't cover.

## Goals

- Make Scout summonable **ambiently, with no restriction on timing** — any time Main Agent needs to look at the codebase to answer or proceed, it asks Scout, regardless of where in the conversation that need arises (start of a topic, mid-discussion, mid-task, after a prior task's already finished, or via an explicit side-question like `/btw`).
- Make the **heavier loop** (plan → approve → Crafter → Gatekeeper) trigger ambiently too, but on a narrower signal: the user indicating actual intent to implement (bug fix, feature), not just discussion or curiosity.
- **Never summon Crafter without a plan existing first** — this is a hard constraint carried through unchanged from v2, now applied to an ambient trigger instead of an explicit one.
- Make the plan a **persisted, file-based artifact** (a markdown checklist, not just something said in chat) — so plans survive across sessions and "does a plan already exist" becomes a real file check, not an inference.
- Keep `/summoner <task>` available as a manual override, for cases where the user wants to force the loop to start regardless of what Main Agent would have ambiently decided.
- Keep everything from v2 that isn't about triggering: agent roles, Gatekeeper's scope/fix flow, model assignment, tmux/RPC mechanics, the incantation.

## Non-goals

- **Parallel Crafters.** Still sequential-only, unchanged from v2. The Ledger's shape (`{file, agent, action, timestamp}`) still assumes one active Crafter at a time.
- **A dedicated documentation/writing sub-agent.** Main Agent writes its own plan/checklist files directly (lightweight, mechanical). It does not author PRDs, flow docs, or other substantial documentation — that stays entirely outside `/summoner`'s scope, unchanged whether ambient or manual. A "Scribe"-type role is explicitly deferred — it belongs to a future task-generation or knowledge extension, not this one (YAGNI: don't design the interface for a system that doesn't exist yet).
- **Direct user-to-subagent intervention.** Same as v2: `/watch` is observation only. Redirection always flows back through Main Agent.
- **Global/default trust-mode setting.** Trust mode is still decided per-plan, not configured once globally.
- **A general "engine" abstraction for other future extensions** (task-generation, knowledge base, a future `pi-party` uniting them). `/summoner`'s orchestration core is being built narrowly for itself right now; generalizing it into something other extensions can plug into is explicitly deferred until those extensions actually exist.

## Agent roles

Unchanged from v1 in nature; Gatekeeper's scope is expanded (see below). All agents are flat and equal — built-in and user-defined agents register through the same interface, no special-cased "core" agent.

| Agent | Role | Can write/edit files? |
|---|---|---|
| **Scout** | Finds files, symbols, code blocks. Builds dependency understanding. Returns minimal relevant slices, never full files. Can be dispatched directly by Main Agent — no approval gate (read-only, low risk). | No |
| **Crafter** | Implements the plan — writes/edits files, installs dependencies. The only agent that ever touches disk. | Yes |
| **Gatekeeper** | Verifies. Runs tests, exercises actual functionality (hits routes/APIs, checks real behavior — not just "did the test suite pass"), and reviews code quality, readability, maintainability, and over-engineering. **Strictly read-only** — reports findings to Main Agent, never fixes anything itself. | No |
| **User-defined** | Anything else the user wants (doc-writer, linter-fixer, etc.). Registered identically to built-ins. | Depends on definition |

The orchestrator ("Main Agent") is unnamed and never summoned, same as v1 — it's the thing running the show.

## Core features

### Ambient triggering (new in v3)

- **What**: Main Agent decides when to summon Scout or start the heavier plan-and-execute loop by watching the conversation itself, not by waiting for a command. Two separate trigger rules, at two different thresholds:

  **Scout — no restrictions on timing.** Any time Main Agent needs to look at the codebase to answer or proceed, it asks Scout. This applies identically whether it's the start of a fresh topic, a need that surfaces mid-discussion, mid-task (Crafter's already working and Main Agent realizes it needs more context), after a previous task has already finished and the user pivots to something new, or via an explicit side-question (e.g. a `/btw`-style interjection that shouldn't block or pollute whatever's currently in flight). Scout is read-only and low-risk, so there's no approval gate and no restriction on when it can fire — including running concurrently with an in-flight Crafter/Gatekeeper, since a side-question shouldn't have to wait in line.
  - **Boundary**: Scout only ever searches the **codebase**. Docs (README, PRD, etc.) are read by Main Agent directly, never via Scout.

  **The heavier loop (plan → approve → Crafter → Gatekeeper) — narrower signal.** This triggers when the user indicates actual intent to implement something — a bug fix or a feature, not just discussion, curiosity, or brainstorming. "Yeah let's do that," "go ahead," or an explicit "fix X" / "build X" all count; the bar is intent-to-implement in general, not a specific magic phrase.
  - **Hard constraint, unchanged from v2**: Main Agent never summons Crafter without a plan existing first. No exceptions, regardless of how small the task looks.
  - **Exception to drafting a new plan**: if the user is continuing from a plan that already exists — one they wrote themselves, or one from an earlier session — Main Agent adopts/loads that plan instead of drafting a new one. See "Plan files" below for how this is detected (a file check, not an inference).

- **Why**: matches how the work actually arrives in a normal conversation (raise something → get checked on → discuss → ask for a plan → say go) rather than requiring the user to remember a command at the one moment ambient detection would have been obvious anyway.
- **Key requirements**:
  - `/summoner <task>` remains available as a manual override — forces the loop to start regardless of what Main Agent would have ambiently decided. Same underlying orchestrator either way; only the trigger differs.
  - The two thresholds (Scout = anytime info is needed; heavy loop = on implement-intent) are evaluated independently — needing Scout does not imply the heavy loop is starting, and vice versa.

### Plan files (new in v3)

- **What**: every plan Main Agent drafts is written to disk as a markdown checklist file, not just presented in chat. Main Agent writes and maintains this file directly (see Non-goals — this is the one and only writing responsibility `/summoner` gives Main Agent; it does not extend to PRDs or other substantial documentation).
- **Why**: makes "does a plan already exist" a real file-existence check instead of a fuzzy inference, gives the user a persistent, human-readable, glanceable record of progress that survives the chat session ending, and matches the user's existing openspec-style workflow (a markdown checklist plan, not prose).
- **Key requirements**:
  - Location: `docs/tasks/` (or `.pi/tasks/` — see Architecture doc for the final call and the committed-vs-gitignored decision). Active plans live in this folder; on completion, the file moves to an `archived/` subfolder.
  - Filename: timestamp + short title (e.g. `2026-06-25-fix-login-redirect.md`), giving natural chronological sorting with no separate index needed.
  - Main Agent checks the active folder before drafting a new plan, to support the "continuing from an existing plan" exception above.
  - Main Agent checks off checklist items as steps complete — this is the mechanical, lightweight writing Main Agent is allowed to do directly (distinct from substantial doc authoring, which is out of scope).
  - The plan file is the checklist/step-tracking layer; the Ledger (below) remains the separate file-level conflict-avoidance layer. They serve different purposes and are not merged.

### The summon loop

- **What**: once triggered (ambiently or via `/summoner`), Main Agent works incrementally rather than producing one upfront plan disconnected from execution. It decides, per step, whether it needs more information (Scout) or is ready to act (Crafter/Gatekeeper).
- **Why**: understanding builds as you go; a single big plan presented once doesn't match that.
- **Key requirements**:
  - After Scout reports back (or directly, if Scout wasn't needed for this step), Main Agent drafts a **detailed action plan** (concrete steps + rationale, written to a plan file — see above).
  - The plan is presented to the user for approval. **Approving the plan also sets trust mode for that plan** — one decision point, not two separate questions.
  - Trust modes (unchanged from v2):
    | Mode | Icon | Behavior |
    |---|---|---|
    | Trust mode | 🙈 | Main Agent proceeds through the plan's steps without re-asking at each one. |
    | Checkpoint mode | 🔍 | Main Agent checks in with the user at each step before proceeding. |
  - Once approved, Main Agent summons the next agent for the next step, the agent reports back, Main Agent updates the plan file/Ledger and proceeds to the next step — looping until done.
  - **Mid-task re-investigation is judgment-based, not rule-based.** If a Crafter report reveals a change with wide blast radius (e.g. modifying a function used throughout the codebase), Main Agent can resummon Scout to re-map impact before continuing. If narrowly scoped, no re-check is needed. Not a fixed protocol — judgment on each report.

### The Ledger

- **What**: a single source of truth, owned by Main Agent, tracking what's been touched, by whom, in what order.
- **Why**: even with sequential-only execution, Main Agent needs a persistent record across a loop that might run for many summon cycles — without it, the only memory is Main Agent's own context window, which is exactly the bloat problem this system exists to avoid.
- **Key requirements**:
  - Minimum viable shape: array of `{file, agent, action, timestamp}` entries.
  - Updated after every agent report-back, consulted before every new summon.
  - No conflict-detection logic needed for v1 (sequential-only), but the shape is chosen so parallel support could be added later without restructuring it.

### Gatekeeper review & fix flow

- **What**: Gatekeeper always runs after Crafter's work, every time — not conditionally. It checks both functional correctness (does the feature actually work — can hit the API, page loads, data renders, no redirect loops) and code quality (readability, maintainability, no unnecessary complexity). It reports everything it finds to Main Agent; it never edits anything itself.
- **Why**: keeps the "verify" responsibility cleanly separated from "build" — Gatekeeper's read-only nature means it can't introduce new problems while checking for them, regardless of trust mode.
- **Key requirements**:
  - Gatekeeper reports **every** finding to Main Agent — nothing is silently skipped from reporting.
  - The deciding question for what happens next is **provenance, not severity**: did *this task's own agents* cause the issue, or did it pre-exist?
    - **Out of scope** (pre-existing, not caused by this task's agents) → Main Agent always asks the user what to do. No exceptions, regardless of trust mode.
    - **In scope** (caused by this task's own agents — e.g. a logic bug introduced this run, a scaffolding file Crafter created and never ended up using) → Main Agent dispatches Crafter to fix it. No need to ask first.
  - Gatekeeper itself never deletes, edits, or writes anything — even an in-scope, obviously-safe fix (like removing a file Gatekeeper itself flagged as unused) goes back through Crafter.
- **Open questions**: a separate severity-classification prompt (critical/non-critical) exists outside this system and will be fed in later — how it interacts with the provenance-based scope rule above (if at all) is still TBD once that prompt is available.

### Model assignment

- **What**: Main Agent picks the model and thinking effort for each sub-agent at summon time, with the ability to override per-call or live-swap mid-run.
- **Why**: different roles have different needs — Scout doing a quick grep-and-report doesn't need the same model (or thinking budget) as Crafter implementing a risky schema migration.
- **Key requirements**:
  - Main Agent queries available models via the RPC `get_available_models` command before assigning.
  - Model + thinking level are set at subprocess launch via `--model provider/id:thinking` (e.g. `--model anthropic/claude-opus-4-5:high`).
  - Can be overridden per individual summon call.
  - Can be live-swapped on an already-running subprocess via the `set_model` RPC command, for the rare case of upgrading a model mid-task without restarting the agent.

### Spawning & tmux integration

- **What**: every summoned sub-agent is a real `pi --mode rpc` subprocess, launched into its own tmux window. Main Agent owns the tmux session lifecycle.
- **Why**: gives the system a real, inspectable mechanical backing (not a simulated multi-agent fiction) and gets `/watch` essentially for free by leaning on tmux's own window switching instead of building custom live-tail UI.
- **Key requirements**:
  - One tmux window per summoned agent instance.
  - Window titles are plain and functional, describing *what* the agent is doing — e.g. `crafter-auth-api`, `scout-dashboard`, `gatekeeper-payments` — not flavor text.
  - If an agent is re-summoned for follow-up work on the same area (e.g. Crafter called back after a Gatekeeper-flagged in-scope fix), the window name increments: `crafter-auth-api`, then `crafter-auth-api-2`.
  - `/watch <agent-name>` maps to `tmux select-window` — a takeover, read-only view of that agent's live activity.
  - A persistent status widget lives in tmux window 0 alongside Main Agent's own conversation, showing all active/queued/done agents at a glance:
    ```
    🟢 crafter-1   dashboard.js   (working)
    🟡 crafter-2   waiting (phase gate)
    ✅ crafter-3   settings.js    (done)
    ```
  - **Main Agent actively monitors subprocess health** (e.g. timeout on `get_state`). This matters specifically because trust mode means the user may not be present to notice a stuck process. If a subprocess crashes or hangs, Main Agent kills it and resummons the same role itself — no user approval needed for this recovery action, since it's not a new decision, just retrying the same already-approved step.

### The incantation

- **What**: a short, theatrical line Main Agent says in its own chat right before spawning a sub-agent — distinct from (and not shown in) the tmux window title.
- **Why**: makes the act of summoning fun to read without adding any operational complexity — the "performance" lives entirely in chat, the tmux layer stays plain and scannable.
- **Key requirements**:
  - Fires **immediately before** the subprocess actually spawns (announcing, not confirming after the fact).
  - No fixed template — Main Agent varies the phrasing each time. At least 3 verb patterns to draw from, freely mixed:
    - **Summon-with**: "I will summon Scout with DeepSeek Flash because it doesn't need to think, just needs to be fast."
    - **Fuel-of**: "With the fuel of DeepSeek Flash, thinking off, I summon Scout — to search and report."
    - **Bestow**: "Crafter, I give you Kimi K2, thinking medium — go sort out the API layer."
  - Regardless of phrasing, every incantation must convey all four of: **which agent**, **which model**, **thinking effort**, and **the reason** for that pairing.
  - The reason's register is flexible — casual ("doesn't need to think, just needs speed") or technical ("schema migration cuts deep, mistakes here are costly"), Main Agent's call based on the task.
  - This is chat-only flavor. It never appears in tmux window titles, which stay plain and descriptive.

## Data entities (high level)

- **Plan file** — a markdown checklist on disk (`docs/tasks/{timestamp}-{short-title}.md`), the persisted form of the action plan. Checked off by Main Agent as steps complete; moved to `archived/` on completion.
- **Ledger entry** — `{file, agent, action, timestamp}`. The running, file-level record of what's been touched. Separate from the plan file — one tracks task steps, the other tracks file-level conflict-avoidance state.
- **Agent instance** — a single summoned subprocess: role (Scout/Crafter/Gatekeeper/user-defined), assigned model, thinking level, tmux window, current status.
- **Gatekeeper finding** — a single reported issue: description, in-scope or out-of-scope, functional or quality-related.

## Out-of-scope / future considerations

- Parallel Crafter execution (and the Ledger conflict-resolution logic that would require)
- A dedicated documentation/writing sub-agent ("Scribe") — deferred to a future task-generation or knowledge extension
- Direct user intervention into a watched sub-agent's session (redirection always routes back through Main Agent)
- Global default trust-mode setting (intentionally kept per-plan)
- Formal severity classification (critical/non-critical) for Gatekeeper findings — a separate prompt for this exists and will be integrated later; how it interacts with the provenance-based scope rule is still open
- A general, pluggable "engine" abstraction for other extensions (task-generation, knowledge base, future `pi-party`) to hook into `/summoner`'s orchestrator — deferred until those extensions exist and the actual interface needs are known