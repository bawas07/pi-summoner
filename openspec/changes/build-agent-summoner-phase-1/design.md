## Context

The agent-summoner is a pi.dev extension that orchestrates specialized sub-agents (Scout, Crafter, Gatekeeper) within the user's existing pi session. It runs as a single process tree — no HTTP boundaries, no database, no separate frontend. The extension hooks pi's lifecycle events (`turn_start`, `session_start`) and registers tools that Main Agent (pi's own LLM) invokes.

Phase 1 is the minimum viable orchestration loop: detect intent, plan, execute sequentially, verify. It runs sub-agents as invisible background subprocesses (tmux integration comes in Phase 2).

Current state: zero code. Docs are complete (PRD, milestones, architecture, flows, pi extension API reference).

## Goals / Non-Goals

**Goals:**
- Prove ambient trigger detection is accurate and cheap enough to run on every conversation turn
- Prove the RPC subprocess orchestration mechanic works end-to-end (spawn → communicate → receive result → loop)
- Establish the module structure that Phase 2/3 will extend
- Enforce hard constraints: no Crafter without a plan, Gatekeeper never writes files, Scout never reads docs

**Non-Goals:**
- tmux window orchestration, `/watch` command, status widget (Phase 2)
- Incantation flavor text (Phase 2)
- Per-role model assignment with `get_available_models` (Phase 2)
- Code-quality/readability review in Gatekeeper (Phase 3 — blocked on external prompt)
- Mid-task Scout re-summon based on blast-radius judgment (Phase 3)
- Subprocess crash detection and auto-recovery (Phase 3)
- Concurrent Scout alongside in-flight Crafter (Phase 3)
- User-defined agent registration from config files (infrastructure exists, no config yet)

## Decisions

### 1. Extension model: pi extension with registered tools (not a standalone service)

**Choice:** Register each agent as a pi tool (`summon_scout`, `summon_crafter`, `summon_gatekeeper`) that Main Agent calls like any other tool.

**Why:** Pi has no native sub-agent concept. The natural pattern, used by other multi-agent pi extensions, is tool-per-agent. Main Agent's LLM decides when to call these tools through the normal tool-use loop — no custom orchestration protocol needed.

**Alternatives considered:**
- Standalone HTTP service: Over-engineered for Phase 1. Adds network boundary, serialization, deployment complexity. Pi extensions run in-process with full access to the session API.
- Custom RPC-only protocol bypassing tool registration: Loses pi's built-in tool execution (parallelism, cancellation, `onUpdate` streaming). Tools are the idiomatic path.

### 2. Agent dispatch: `rpc-client.ts` wraps `child_process.spawn` with JSONL framing

**Choice:** Each summoned agent is a `pi --mode rpc` subprocess spawned via Node's `child_process.spawn`. Communication uses JSONL (one JSON object per line) on stdin/stdout.

**Why:** The RPC mode gives a clean, well-defined protocol for prompt→response and state queries. JSONL is trivial to parse (split on `\n`) and correlates requests/responses by `id`. No framing ambiguity, no binary protocol needed.

**Key constraint:** Must NOT use Node's `readline` module — it's not protocol-compatible with pi's RPC framing. Use a custom line splitter (buffer accumulation + `\n` delimit).

**Alternatives considered:**
- `fork()` with IPC: Binds to the same Node process, meaning a Crafter crash could take down Main Agent. Separate processes give isolation.
- tmux pane with `send-keys`: Phase 2 addition, not the communication layer. RPC is the protocol; tmux is the presentation/view layer.

### 3. Plan files: `docs/tasks/` (committed to git), not `.pi/tasks/` (gitignored)

**Choice:** Plan files live in `docs/tasks/{timestamp}-{title}.md` and are committed to version control. Archived plans move to `docs/tasks/archived/`.

**Why:** Plan history is genuinely useful project history — it shows what was considered, what was built, and in what order. Committing it matches the user's existing openspec-style workflow. The architecture doc considered `.pi/tasks/` but rejected it for this reason.

**Filename format:** `{ISO-date}-{kebab-case-short-title}.md` gives natural chronological sorting with `ls` — no separate index needed.

### 4. Ledger: in-memory only for Phase 1

**Choice:** Simple `Map<string, LedgerEntry>` in module scope. No `pi.appendEntry()` persistence yet.

**Why:** Phase 1 is single-session, sequential-only. The Ledger exists to prevent Main Agent's context window from being the sole record of what's been touched. In-memory is sufficient — session-resume scenarios (needing `pi.appendEntry`) are a Phase 1 stretch goal, not a blocker.

**Shape:** `{file: string, agent: string, action: "read" | "write" | "delete", timestamp: number}` — chosen to support future parallel Crafters without restructuring.

### 5. Crafter safety: mandatory `withFileMutationQueue`

**Choice:** Every Crafter write operation wraps read-modify-write in `withFileMutationQueue(absolutePath, ...)`.

**Why:** Even though Phase 1 is sequential-only (no parallel Crafters), this is the safety net underneath the safety net. A single missed serialization point in Phase 1 becomes a silent data-loss bug when parallel Crafters arrive later. Adding it now costs nothing and prevents a class of bugs that are hard to reproduce.

### 6. Gatekeeper tool enforcement: architectural, not just prompt-based

**Choice:** Gatekeeper's `AgentDefinition.tools` array deliberately excludes `write`, `edit`, `delete`, or any file-mutating tools. It is not a behavioral rule in the prompt — the subprocess physically cannot write files.

**Why:** Trust mode means the user may not be present. "Never writes files" must be a guarantee, not a hope. Tool-level enforcement is the only way to guarantee it. This is cheap to do early and risky to retrofit later.

### 7. Ambient trigger: separate `trigger.ts` module with LLM-classification, run on `turn_start`

**Choice:** `trigger.ts` hooks `pi.on("turn_start", ...)` and evaluates two independent boolean signals per turn: `needsScout` and `implementIntent`. Both use a cheap, fast model (separate from the user's primary model) to classify the conversation context.

**Why:** The architecture doc flags this as the highest-risk module — both for accuracy (false positives/negatives) and cost (runs on every message). Isolating it in its own module makes prompt iteration straightforward without touching orchestration logic. The two signals are independent by design: needing Scout never implies implement-intent.

**Fallback:** `/summoner <task>` remains as manual override. If `trigger.ts` proves unreliable, the v2 explicit-trigger model still works.

## Risks / Trade-offs

- **[Risk] trigger.ts false positives flood the user with plan proposals** → Mitigation: `implementIntent` uses a narrow threshold. The `/summoner` fallback means the system degrades gracefully — at worst, it acts like v2 (command-triggered only).
- **[Risk] Per-turn trigger cost becomes noticeable** → Mitigation: Use a cheap/lightweight model for `trigger.ts` classification, not the user's primary model. If even that is too expensive, the hook can be made opt-in or rate-limited without architectural changes.
- **[Risk] RPC subprocess hangs silently, blocking the loop** → Mitigation: Phase 1 accepts this risk (crash recovery is Phase 3). The user is present in Phase 1 (no trust mode without Phase 3 resilience), so a hung process is visible and killable.
- **[Trade-off] Sequential-only execution is slower than parallel** → Acceptable. The PRD explicitly defers parallel Crafters. Sequential execution is simpler to debug and the Ledger shape was chosen to support parallelism later without restructuring.
- **[Trade-off] In-memory Ledger loses state on session crash** → Acceptable for Phase 1. `pi.appendEntry()` persistence is documented in the architecture and trivial to add when needed.

## Open Questions

- Exact lifecycle event name: `turn_start` is the best candidate from pi docs, but must be confirmed against the live `ExtensionAPI` event list before implementation.
- trigger.ts model selection: which cheap model to run classification on? Needs benchmarking against real conversation data.
- `get_state` polling interval (for Phase 3 crash detection): not yet specified. Sensible default TBD.
