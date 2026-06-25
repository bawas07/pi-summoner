# Fix Phase 1 — make the summon loop actually run

> **Created:** 2026-06-25
> **Trust mode:** 🔍 checkpoint
> **Status:** active

## Why

Phase 1 modules all exist and unit tests pass, but the orchestration loop is
non-functional. Root causes found in review:

1. **Two disconnected execution paths.** `agents.ts` registers `summon_*` as
   in-process tools whose logic is trivial (`crafterExecute` just returns the
   string `"Crafter: implement this — …"`). `orchestrator.ts` separately spawns
   `pi --mode rpc` child processes via `rpc-client.ts`. Neither calls the other.
2. **The loop can't run.** The whole blocking loop runs inside the `turn_start`
   hook; the approval promise only resolves on a *future* turn_start while the
   first is still awaited → deadlock. Plan is printed via `console.log`, invisible
   in the TUI, so approval can never be given.
3. **Build is broken + a crash bug.** `typebox` import not found; `err` catch-param
   shadows the `err()` log helper (TypeError on failure path); tool result missing
   `details`.

## Decisions (locked)

- **Agent = isolated in-process session via `createAgentSession()`** — the
  mechanism `tintinweb/pi-subagents` uses. Verified exported by the installed SDK
  (`createAgentSession`, `createReadOnlyTools`, `createCodingTools`, `defineTool`,
  `getAgentDir`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`).
  Replaces `rpc-client.ts`'s `child_process.spawn("pi --mode rpc")`.
- **Loop is LLM-driven via tools + `ctx.ui`**, not driven from `turn_start`.
  Matches pi-subagents; removes the deadlock.

## Steps

### Phase 0 — Build & crash fixes
- [x] Resolve `typebox` import (declared as direct dep; v1 `Type` API confirmed)
- [x] Fix `orchestrator.ts:367` `catch (err)` shadowing the `err()` log helper
- [x] Add required `details` to the tool result/`onUpdate` in `agents.ts`
- [x] Add `tsconfig.json` and a `typecheck` npm script; wire into `test`

### Phase 1 — Replace transport (rpc-client.ts → agent-session.ts)
- [x] New `agent-session.ts` wrapping `createAgentSession()`; result from final `session.messages` after `prompt()` resolves
- [x] Per-role tool allowlists: Scout `[read,grep,find,ls]`, Gatekeeper `[+bash]` (no write/edit), Crafter full set. Gatekeeper physically cannot write
- [x] `summon_*` tools + orchestrator both run agents via `runAgent()` (single path)
- [x] Delete `rpc-client.ts` child-process spawn path (and its references)

### Phase 2 — Rewire loop to be LLM-driven
- [ ] `summon_*` tools call `agent-session.ts` (remove trivial stub logic)
- [ ] Remove blocking orchestrator call from the `turn_start` hook
- [ ] Downgrade `trigger.ts` to a non-blocking nudge; keep `/summoner` + LLM tool-calls as drivers
- [ ] Move plan presentation + approval + trust-mode selection to `ctx.ui` (visible, awaitable)

### Phase 3 — Orchestration correctness
- [ ] Ledger records the actual files Crafter changed (reported back), not `plan.path`
- [ ] Checkpoint mode `await`s a confirmation between steps (currently never pauses)
- [ ] Enforce "no Crafter without an active plan file" at the tool boundary
- [ ] Remove hardcoded `claude-sonnet-4-5`; resolve model from session/`modelRegistry`

### Phase 4 — Verify & reconcile docs
- [ ] Extension loads via `pi -e ./src` with no errors (tasks 9.1)
- [ ] Run end-to-end checks tasks.md 9.2–9.9
- [ ] Run `full-reviews` skill on the branch (task 9.10)
- [ ] Update `architecture.md` (rpc-client section) + `guide.md §3` to describe `createAgentSession()` instead of `pi --mode rpc`
