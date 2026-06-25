# /summoner — Milestones

> Reflects planning-time assumptions as of this brainstorm. Revisit after Phase 1 ships — the riskiest unknowns here (ambient trigger accuracy and cost, RPC framing edge cases, tmux orchestration under real use) are exactly the kind of thing that should reshape later phases once there's real usage to learn from.

## Phase 1 — Core loop + ambient triggering, single agent at a time, no fancy bits

**Goal**: prove the two riskiest things at once, since they're entangled — that ambient trigger detection (`trigger.ts`) is accurate and cheap enough to run on every turn, and that the actual orchestration mechanic works (spawn a real sub-agent subprocess, talk to it over RPC, get a result back, loop) — before layering on tmux visuals, model-choice ceremony, or Gatekeeper's expanded scope.

**Includes**:
- `/summoner <task>` command registration — kept as the manual override and, practically, the **fallback while ambient detection is unproven**: if `trigger.ts` is misfiring or feels unreliable in practice, `/summoner` still works exactly like v2's explicit-trigger model
- `trigger.ts` — the `turn_start` hook, evaluating `needsScout` and `implementIntent` on every turn. Scoped cheaply in Phase 1 (see Explicitly deferred) but real and load-bearing, not a stub
- `rpc-client.ts` — spawn a `pi --mode rpc` subprocess, send a prompt, receive the result (no tmux yet — just a background subprocess)
- `plan-file.ts` — write/read/check-off/archive, against `docs/tasks/`. This is genuinely Phase 1, not deferred, since "never summon Crafter without a plan" depends on it existing from day one
- The summon loop itself: Scout dispatched whenever `needsScout` fires (any timing) → on `implementIntent`, check for an existing plan file first, draft one if not found → user approves (sets trust mode) → summons Crafter for each step → loop until done
- Basic Ledger (`{file, agent, action, timestamp}`, in-memory only, no persistence)
- Gatekeeper runs at the end, **tests/functional checks only** — no code-quality review yet, since that needs the severity-classification prompt that doesn't exist yet
- Gatekeeper's read-only enforcement (no write/edit tool) from day one — this is cheap to do early and risky to retrofit later
- Out-of-scope vs in-scope routing for Gatekeeper findings (ask user / dispatch Crafter)

**Explicitly deferred**:
- tmux window spawning/`/watch` — Phase 1 sub-agents run as invisible background subprocesses; you see their result, not their live work
- The incantation (flavor text) — fun, but adds nothing to proving the mechanic works
- Model assignment per role — Phase 1 can hardcode one model for everything, including `trigger.ts`'s own evaluation model
- Gatekeeper's code-quality/readability review pass — needs the severity-classification prompt first
- Mid-task Scout re-summon (blast-radius judgment) — Phase 1 can do a single linear pass without this refinement
- Subprocess crash detection/auto-recovery — Phase 1 can let it fail loudly rather than self-heal
- Concurrent Scout (running alongside an in-flight Crafter) — Phase 1's Scout can be sequential-only too; the "no restriction on timing" *rule* still holds (Scout can fire any time a need arises), but actually overlapping it with a running Crafter is a refinement, not load-bearing for proving the core loop

**A note specific to this phase**: because `trigger.ts` runs on every message, Phase 1 is also where you'll get real signal on whether `implementIntent` detection is too eager (firing on casual mentions), too conservative (missing clear asks), or about right — and whether the per-turn cost is tolerable. Expect this phase to involve more prompt iteration on `trigger.ts` than the other modules combined, and don't be surprised if it takes longer than the RPC/orchestrator plumbing.

## Phase 2 — Visibility & ceremony

**Goal**: make the system watchable and fun, on top of a loop that's already proven to work.
**Includes**:
- `tmux.ts` — real window-per-agent spawning, `/watch` command, window naming + increment-on-resummon
- Status widget (`🟢/🟡/✅`) in window 0
- The incantation — varied phrasing, fires right before spawn
- Model assignment — `get_available_models` query, per-role model + thinking level at spawn, override + live-swap via `set_model`
**Depends on**: Phase 1's `rpc-client.ts` needs to be stable first — swapping a working background subprocess into a tmux-hosted one is a much smaller change than building both at once.

## Phase 3 — Smarter Gatekeeper & resilience

**Goal**: round out Gatekeeper into what the PRD actually describes, and make trust mode safe to leave unattended.
**Includes**:
- Gatekeeper's code-quality/readability/maintainability review pass (once the severity-classification prompt is ready to integrate)
- Mid-task Scout re-summon based on blast-radius judgment
- Subprocess health monitoring (`get_state` timeout) + auto-kill-and-resummon on crash/hang — specifically needed before trust mode is something you'd actually leave running unattended
**Depends on**: the external severity-classification prompt mentioned in the PRD's open questions — this phase can't fully start until that's been fed in and reconciled with the scope-based (not severity-based) routing rule already decided.

## Sequencing notes

- Ledger's shape is decided in Phase 1 and deliberately not revisited until parallel Crafters are ever in scope (still a non-goal as of this doc) — don't let Phase 2/3 work sneak in conflict-detection logic prematurely.
- tmux (Phase 2) is purely a presentation layer on top of the RPC subprocess management built in Phase 1 — if Phase 1's `rpc-client.ts` ends up needing a redesign once tmux is added, that's a sign Phase 1 was built too coupled to "headless" assumptions, worth watching for.
- Phase 3's Gatekeeper work is the one most likely to slip, since it's blocked on an external input (the severity-classification prompt) rather than purely on this codebase — fine to start Phase 2 in parallel rather than waiting.

## Out of scope (long-term)

Restated from the PRD — not part of any phase above:
- Parallel Crafter execution
- A dedicated documentation/writing sub-agent ("Scribe")
- Direct user intervention into a watched sub-agent's session
- Global/default trust-mode setting
- A general, pluggable "engine" abstraction for other future extensions to hook into