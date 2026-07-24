# Plan: Plan-mode guard fix + Nudge craft orchestration + Gate-only Gatekeeper

**Status:** Implemented (this branch)  
**Date:** 2026-03-24  
**Scope:** Medium  

See implementation in:

- `src/plan-mode-guard.ts`
- `src/craft-orchestration.ts`
- `src/personas.ts` (`MAIN_ORCHESTRATOR_PERSONA`)
- `src/agents/default-agents.ts` (Gatekeeper gate-only)
- `src/settings.ts` (`orchestrationMode`)
- `test/plan-mode-guard.test.ts`

## Decisions locked

| Decision | Choice |
|---|---|
| Craft orchestration | **Nudge** (implemented) |
| Future | **Hybrid** hooks only (`orchestrationMode`, `shouldBlockMainWrite`) |
| Gatekeeper | **Gate only** (read-only) |
| Tests | Crafter/main for now |

## Regression

Plan mode must allow writing `docs/plan-nudge-orchestration.md` (inverted `!md \|\| !json` bug fixed).
