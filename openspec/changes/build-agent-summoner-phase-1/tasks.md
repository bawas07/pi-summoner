## 1. Foundation — Types & Data Structures

- [x] 1.1 Create `types.ts` with all shared types: `LedgerEntry`, `AgentDefinition`, `AgentInstance`, `TriggerResult`, `PlanFile`, `GatekeeperFinding`, `TrustMode`, `ModelRef`, `ThinkingLevel`

## 2. Ledger — File Touch Tracking

- [x] 2.1 Create `ledger.ts` with in-memory store (`Map<string, LedgerEntry>`) and helpers: `recordTouch()`, `getTouchedFiles()`, `getEntriesByAgent()`
- [x] 2.2 Ensure only `orchestrator.ts` exports write access; consumers get a read-only view

## 3. Plan File Persistence

- [x] 3.1 Create `plan-file.ts` with `write()` — writes a new plan file to `docs/tasks/{timestamp}-{short-title}.md` with markdown checklist format
- [x] 3.2 Add `findExisting()` — scans `docs/tasks/` for plan files matching a task description
- [x] 3.3 Add `checkOffStep()` — marks a specific checklist item as `[x]` in the plan file
- [x] 3.4 Add `archive()` — moves completed plan file to `docs/tasks/archived/`
- [x] 3.5 Ensure `docs/tasks/` and `docs/tasks/archived/` directories are created automatically if missing

## 4. Agent Registry

- [x] 4.1 Create `agents.ts` with `registerAgent(pi, def: AgentDefinition)` function that registers a pi tool as `summon_<name>`
- [x] 4.2 Define and register built-in agents: Scout (`canDispatchWithoutApproval: true`, read-only tools), Crafter (write tools, `withFileMutationQueue` in execute), Gatekeeper (no write/edit tools, read-only enforcement)
- [x] 4.3 Add `getAgent(name)` and `listAgents()` lookup functions for the orchestrator

## 5. RPC Subprocess Client

- [x] 5.1 Create `rpc-client.ts` with `spawnSubprocess(agentDef, model, thinking)` that spawns `pi --mode rpc --model <provider/id:thinking>` via `child_process.spawn`
- [x] 5.2 Implement JSONL line reader on stdout: buffer accumulation, split on `\n`, parse each line as JSON — do NOT use Node's `readline`
- [x] 5.3 Implement `sendPrompt(client, prompt)` — writes JSONL command to stdin, returns a promise that resolves with the response (matched by `id`)
- [x] 5.4 Implement `terminate(client)` — cleanly kills subprocess and releases resources
- [x] 5.5 Handle spawn failures with descriptive errors (subprocess not found, model unavailable)
- [x] 5.6 Phase 1: hardcode a single default model; no `get_available_models` querying yet

## 6. Ambient Trigger

- [x] 6.1 Create `trigger.ts` with `evaluateTurn(turnContext)` returning `Promise<TriggerResult>`
- [x] 6.2 Implement `needsScout` detection — LLM classification prompt that evaluates "does Main Agent need codebase info right now" (excluding docs lookups)
- [x] 6.3 Implement `implementIntent` detection — narrower LLM classification prompt that evaluates "is the user indicating intent to implement a fix/feature"
- [x] 6.4 Ensure the two signals are evaluated independently; `needsScout` true never implies `implementIntent` true

## 7. Orchestrator — Main Agent Loop

- [x] 7.1 Create `orchestrator.ts` with the core loop: trigger received → check for existing plan → draft if needed → present for approval → execute steps sequentially
- [x] 7.2 Implement plan approval flow: present plan to user via `ctx.ui`; single interaction sets trust mode (🙈 trust / 🔍 checkpoint) and grants go-ahead
- [x] 7.3 Implement step execution loop: summon agent → wait for report → update Ledger + plan file → decide next step
- [x] 7.4 Enforce hard constraint: never summon Crafter without a confirmed plan (file must exist in `docs/tasks/`)
- [x] 7.5 Implement Gatekeeper routing: always run Gatekeeper after all steps → route findings by provenance (in-scope → auto-dispatch Crafter to fix; out-of-scope → ask user)
- [x] 7.6 Implement plan archiving on successful completion (all steps done, Gatekeeper reports clean)
- [x] 7.7 Handle the `/summoner <task>` manual override path: bypass ambient trigger, force `implementIntent = true`

## 8. Entry Point — Extension Registration

- [x] 8.1 Create `index.ts` as default export `function(pi: ExtensionAPI)`
- [x] 8.2 Register `/summoner <task>` command with argument completions for agent names (scout, crafter, gatekeeper)
- [x] 8.3 Hook `pi.on("turn_start", ...)` to run `trigger.ts` evaluation on every conversation turn
- [x] 8.4 On `session_start`: initialize agents, Ledger, and announce "Orchestrator loaded"
- [x] 8.5 Wire the two entry paths (ambient trigger + `/summoner` command) into `orchestrator.ts`

## 9. Integration & Verification

- [ ] 9.1 Verify the extension loads without errors (`pi -e ./index.ts` or `/reload`)
- [ ] 9.2 Test ambient Scout trigger: ask a codebase question and verify Scout is dispatched
- [ ] 9.3 Test manual `/summoner` trigger: type `/summoner fix something` and verify the loop starts
- [ ] 9.4 Test plan creation and check-off: verify plan files appear in `docs/tasks/` with correct format
- [ ] 9.5 Test Gatekeeper runs after Crafter: verify Gatekeeper reports findings to orchestrator
- [ ] 9.6 Test Gatekeeper in-scope routing: verify a Crafter-introduced issue triggers auto-fix without user prompt
- [ ] 9.7 Test Gatekeeper out-of-scope routing: verify a pre-existing issue prompts user decision
- [ ] 9.8 Test hard constraint: verify that attempting to summon Crafter without a plan is blocked
- [ ] 9.9 Test plan archiving: verify completed plans move to `docs/tasks/archived/`
- [ ] 9.10 Code review: run the full-reviews skill on the branch before considering Phase 1 done
