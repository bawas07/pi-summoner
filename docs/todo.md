# TODO — Implementation Checklist

Tracking doc for building the extension. Phased to match how the system itself thinks about work — no point pretending this gets built in one shot.

Reference: `prd.md` for what/why, `flow.md` for exact mechanics, `plan.md` for refined task-level detail.

> ⚠️ **Package pattern:** Standalone installable (pi-suite style) — not manual `.pi/` drop-in.
> Installed via `pi install git:…` or `pi install .`. See `plan.md` §Architecture Overview.

---

## Phase 0 — Foundations

- [ ] **Task 0.0: Package scaffold** — `package.json` (`pi.extensions: ["./extensions"]`), `tsconfig.json`, peerDeps, devDeps, scripts
- [ ] `npm install` succeeds; `npm run typecheck` passes; `pi install .` works; `pi list` shows orchestrator
- [ ] **Task 0.1: Extension scaffold** — `extensions/orchestrator/index.ts` with `session_start` handler
- [ ] `pi -e ./extensions/orchestrator/index.ts` starts without errors (dev mode)
- [ ] Define the **Agent Registration interface** — single shape used by built-in and user-defined agents alike
  - [ ] `name`, `description` (LLM-readable, used for routing/summoning)
  - [ ] `memory` flag (opt-in for user-defined; fixed per role for built-ins per `prd.md` §3)
  - [ ] `handler` signature — `(task: string, ctx) => Promise<{ content, details }>`
- [ ] Define the **Ledger** data structure (see `flow.md` §2.1, `plan.md` Task 0.2)
  - [ ] `FileEntry { status, phase, owner, summary? }`, `LedgerState { currentPhase, totalPhases, files }`
  - [ ] Functions: `getLedger`, `setFileStatus`, `getFilesByPhase`, `isPhaseComplete`, `allPhasesComplete`, `canStartPhase`
  - [ ] Persistence via `pi.appendEntry("ledger-update", …)`
  - [ ] Replay on `session_start`: iterate `getEntries()` in tree order, latest-wins per path
  - [ ] Survives `/reload`; correct phase gating via `canStartPhase(n)`

## Phase 1 — Scout

- [ ] File/symbol search: `node:fs` glob + line-by-line grep (zero deps), apply `truncateHead` (200 lines / 10KB)
- [ ] AST-level import/export parsing: regex-first for ESM, `@babel/parser` fallback for ambiguous cases
- [ ] Build dependency graph: `{ [file]: { exports: string[], importedBy: string[] } }`
- [ ] Session-scoped cache: `Map<path, { graph, mtime, confidence }>`, check `dirtyScoutCache` before return
- [ ] **Cache invalidation resolved:** proactive — Crafter calls `markDirty(path)` on write; also dirties all reverse-dependency files (transitive invalidation). See `plan.md` Key Technical Decisions.
- [ ] Graceful fallback: parse errors → regex extraction with `confidence: "low"`
- [ ] Circular dependency detection (flag, don't infinite-loop)

## Phase 2 — Main Agent Planning Logic

- [ ] Topological sort: dependency graph → ordered phases
- [ ] Detect parallel-safe batches within a phase (zero file overlap = safe)
- [ ] Plan presentation format (human-readable phase breakdown + risk notes, see `prd.md` §5.1)
- [ ] Trust-mode prompt (per-task, two options: 🙈 / 🔍)
- [ ] Plan revision loop (user rejects → replan → re-present)

## Phase 3 — Crafter

- [ ] File write/edit: read → apply change → write, all wrapped in `withFileMutationQueue` (non-negotiable)
- [ ] After write: `markDirty(path)`, update Ledger (`done` + summary), update `agentActivityLog`, refresh status widget
- [ ] Dependency install execution (Phase 0): run install, capture output; on failure → abort; on success → unblock Phase 1
- [ ] "Richer report" mechanism: discover unplanned file → read it → parse its imports (one-hop) → report to Main Agent
  - [ ] Main Agent checks Ledger: no conflict → add to phase, proceed; conflict → wait state (🟡)
- [ ] Wait-then-re-read: when blocking file → `done`, re-read fresh before proceeding; skip if already covered
- [ ] Crash/timeout detection: `runningAgents` Map with timestamps; default 5 min timeout → mark files `pending` → re-assign
- [ ] Concurrent Crafter instances: unique owner IDs, same-phase non-overlapping files → parallel

## Phase 4 — Gatekeeper

- [ ] Full test suite execution (always fresh, no memory/cache)
- [ ] Failure classification: in-scope (touched by this task) vs out-of-scope (untouched files)
- [ ] In-scope failure handling per trust mode (auto-fix+retest vs ask-first)
- [ ] Out-of-scope failure handling — always surfaces to user regardless of trust mode (`flow.md` §5)
- [ ] Decide whether a pre-task baseline test run is needed to distinguish "we broke it" from "already broken" (currently: ask the user instead of auto-detecting — confirm this stays the approach before building anything fancier)

## Phase 5 — Ledger-to-Report

- [ ] Walk completed Ledger → synthesize human-readable final report
- [ ] No separate reporting mechanism — confirm Ledger truly is sufficient as the only data source

## Phase 6 — UI/UX

- [ ] Persistent status widget via `ctx.ui.setWidget`: 🟢 active / 🟡 waiting / ✅ done / ❌ failed / ⏳ pending
- [ ] Widget auto-updates on every `setFileStatus`; auto-clears when no agents active/pending
- [ ] `/summon <agent-name> [task]` — autocomplete all registered agents (built-in + user-defined)
- [ ] `/watch <agent-name>` — `ctx.ui.custom()` full-takeover view, live feed from `agentActivityLog`
  - [ ] Renders with `@earendil-works/pi-tui` components (Text, Box)
  - [ ] Read-only by design: no input channel (intentional — chain-of-command constraint, not missing feature)
  - [ ] Esc or `/back` → `done()` returns to Main Agent; agent continues working unaffected
- [ ] `/watch` with no args → show list of watchable (active) agents

## Phase 7 — User-Defined Agents

- [ ] Config format for declaring a custom agent (e.g. `defineSubAgent({...})`)
- [ ] Confirm registration path treats user-defined and built-in agents identically (no special-casing)
- [ ] Document how `description` field affects whether Main Agent "knows" to summon it

## Phase 8 — Integration Testing (see `plan.md` for full acceptance criteria)

- [ ] Two Crafters, zero file overlap → concurrent, both complete, no data loss
- [ ] Two Crafters, planned overlap → sequential (different phases), no collision
- [ ] Unplanned discovery — no conflict: 🙈 auto-proceed / 🔍 ask; file in final report
- [ ] Unplanned discovery — conflict: wait → re-read → proceed; no data loss, correct sequencing
- [ ] Gatekeeper out-of-scope failure → always-ask in both modes; pre-existing vs new distinguished
- [ ] User rejects plan → clean replan loop, no half-applied state
- [ ] Crafter crash → timeout detected, files reset, re-assigned, no deadlock
- [ ] Full happy path: multi-file task → Scout → Plan → approve → execute → verify → report

---

## Open Questions / Notes (Resolved in refined plan)

- ~~Cache invalidation for Scout~~ → **Resolved:** proactive invalidation by Crafter on write, including transitive reverse-dependency dirtiness.
- ~~Naming for Main Agent~~ → Still intentionally undecided per `prd.md` §3. Make configurable, not hardcoded.
- ~~Watch mode read-only~~ → Confirmed: read-only by design. Chain-of-command constraint, not a v1 limitation.
- **Install method** → Resolved: standalone package (pi-suite pattern), not manual `.pi/` drop-in.
- **Testing framework** → Resolved: `node:test` + `node:assert` via `tsx` (zero deps).
- **Trust-mode param type** → Resolved: `StringEnum(["trust", "checkpoint"])`, not `Type.Union` (Google API gotcha).
- **Ledger replay** → Resolved: iterate `getEntries()` in tree order, latest-wins per file path.
- **Scout parser** → Resolved: regex-first for ESM, `@babel/parser` only for ambiguous cases (minimize deps).