# /summoner — Flow

> Adapted from the standard Flow template: `/summoner` has no pages or navigation in the usual sense — it's a CLI extension orchestrating subprocesses. "Page list" and "navigation structure" are replaced below with the equivalent for this kind of system: a surface list (what the user actually sees/interacts with) and the overall process flow. Each subsequent section is a Mermaid diagram of one significant flow, same as a normal Flow doc.

## Surfaces

What the user actually sees or touches, in place of a page list.

| Surface | Where | Purpose |
|---|---|---|
| Main Agent conversation | tmux window 0 | Primary interface — task input, plan presentation, approvals, incantations, status widget |
| Status widget | Top of window 0, alongside Main Agent | At-a-glance view of all active/queued/done agents |
| Sub-agent tmux window | `crafter-*`, `scout-*`, `gatekeeper-*` windows | Live, read-only view of one agent's actual work (via `/watch`) |
| Plan file | `docs/tasks/{timestamp}-{title}.md` | Persisted checklist, glanceable outside the chat entirely; moves to `archived/` on completion |

## Overall process flow (v3 — ambient triggering)

No single `Start` node anymore — Main Agent is continuously evaluating every conversation turn against two independent triggers. `/summoner <task>` still exists as a manual override that jumps straight to the "draft/load plan" step, bypassing the ambient check.

```mermaid
flowchart TD
    Turn([New message in conversation]) --> NeedScout{Need codebase info?}
    NeedScout -->|Yes, any time| Scout[Dispatch Scout - no approval, no timing restriction]
    NeedScout -->|No| Intent
    Scout --> Report1[Scout reports back]
    Report1 --> Intent{User indicating intent to implement?}
    Intent -->|No - just discussing| Continue([Continue conversation normally])
    Intent -->|Yes| ExistingPlan{Plan already exists for this?}
    ExistingPlan -->|Yes - user's own, or from earlier session| Load[Main Agent loads existing plan file]
    ExistingPlan -->|No| Draft[Main Agent drafts new plan, writes plan file]
    Load --> Approve
    Draft --> Approve{User approves plan?}
    Approve -->|Adjust| Draft
    Approve -->|Yes - sets trust mode too| Loop[Summon next agent for next step]
    Loop --> Work[Agent works in its own tmux window]
    Work --> Report2[Agent reports back to Main Agent]
    Report2 --> Ledger[Main Agent updates Ledger + checks off plan file step]
    Ledger --> More{More steps remaining?}
    More -->|Checkpoint mode| Confirm[Check in with user before continuing]
    Confirm --> Loop
    More -->|Trust mode| Loop
    More -->|No| Gatekeeper[Summon Gatekeeper - always runs]
    Gatekeeper --> Archive[Plan file moved to archived/]
    Archive --> Done([Task complete])
```

## Flow: Scout's ambient trigger

Scout's trigger has no timing restriction — this can fire at any point shown below, independent of whatever else is happening (including mid-Crafter-work).

```mermaid
flowchart TD
    A([Start of a fresh topic]) --> S[Dispatch Scout]
    B([Mid-discussion, new info need surfaces]) --> S
    C([Mid-task, Crafter/Gatekeeper already working]) --> S
    D([Task just finished, user pivots to something new]) --> S
    E(["/btw-style side question"]) --> S
    S --> Bound{Is it a docs lookup - README, PRD, etc?}
    Bound -->|Yes| Direct[Main Agent reads directly, no Scout]
    Bound -->|No - codebase| Dispatch[Scout searches codebase, reports minimal slice]
```

## Flow: Plan file existence check

Triggered whenever the heavy loop is about to start (ambiently or via `/summoner`), before Main Agent decides whether to draft a new plan.

```mermaid
flowchart TD
    Trigger([Heavy loop triggered]) --> Check[Main Agent checks docs/tasks/ active folder]
    Check --> Found{Matching plan file found?}
    Found -->|Yes| Load[Load existing plan - skip drafting]
    Found -->|No| Draft[Draft new plan, write new file: timestamp-short-title.md]
    Load --> Present[Present to user for approval]
    Draft --> Present
```

## Flow: Summoning a sub-agent (the incantation)

Triggered any time Main Agent decides to dispatch Scout, Crafter, or Gatekeeper.

```mermaid
flowchart TD
    Need([Main Agent needs an agent]) --> Models[Query get_available_models via RPC]
    Models --> Pick[Pick model + thinking level for this role/task]
    Pick --> Incant[Say incantation in chat: agent + model + thinking + reason]
    Incant --> Spawn[Spawn pi --mode rpc subprocess in new tmux window]
    Spawn --> Title[Set plain descriptive window title, e.g. crafter-auth-api]
    Title --> Active[Agent shown as working in status widget]
```

## Flow: Mid-task impact check (Scout re-summon)

Triggered when Crafter reports a change back to Main Agent.

```mermaid
flowchart TD
    Report([Crafter reports a completed change]) --> Impact{Main Agent: how wide is the blast radius?}
    Impact -->|Narrow - e.g. one module, nothing else depends on it| Continue[Continue with current plan]
    Impact -->|Wide - e.g. function used throughout codebase| Resummon[Resummon Scout to re-map impact]
    Resummon --> Update[Main Agent updates plan based on new findings]
    Update --> Continue
```

This is a judgment call made fresh each time, not a fixed rule — see PRD.

## Flow: Gatekeeper review and fix

Triggered after Crafter's work is reported as done, before the task is considered complete. Gatekeeper never edits files — every fix flows back through Crafter.

```mermaid
flowchart TD
    subgraph Gatekeeper
        Start([Gatekeeper runs - tests + functional check + code quality review]) --> Find{Finding?}
        Find -->|Nothing found| Pass([Reports clean])
        Find -->|Issue found| ReportFinding[Reports finding to Main Agent - always, never silent]
    end
    subgraph "Main Agent"
        ReportFinding --> Scope{Caused by this task's own agents?}
        Scope -->|No - pre-existing| Ask[Ask user what to do]
        Scope -->|Yes - in scope| Dispatch[Dispatch Crafter to fix it - no asking needed]
    end
    subgraph Crafter
        Dispatch --> Fix[Crafter implements the fix]
    end
    Fix --> Recheck([Gatekeeper runs again on the fix])
    Ask --> UserDecision{User decision}
    UserDecision -->|Fix it| Dispatch
    UserDecision -->|Leave it| Pass
```

## Flow: Subprocess crash recovery

Triggered any time during an active summon — relevant specifically because trust mode means the user may not be watching.

```mermaid
flowchart TD
    Monitor([Main Agent monitors subprocess health - get_state timeout]) --> Healthy{Subprocess responding?}
    Healthy -->|Yes| Monitor
    Healthy -->|No - crashed or hung| Kill[Main Agent kills the stuck process]
    Kill --> Resummon[Resummon same agent role - no user approval needed]
    Resummon --> Monitor
```

## Wireframe-level notes

- Status widget format (from PRD), always visible in window 0:
  ```
  🟢 crafter-1   dashboard.js   (working)
  🟡 crafter-2   waiting (phase gate)
  ✅ crafter-3   settings.js    (done)
  ```
- tmux window naming: `{role}-{short-description}`, incrementing on re-summon to the same area (`crafter-auth-api`, then `crafter-auth-api-2`).
- `/watch <agent-name>` = `tmux select-window` to that agent's window. `Esc` / `/back` returns to window 0. Watching is always read-only — no input channel to the sub-agent from the watch view.