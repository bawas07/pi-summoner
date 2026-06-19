# Documentation Routing Policy (Context-Safe)

## Goal

Use project docs as source of truth without loading everything into context.

## Mandatory Workflow

1. Start with `docs/requirements.md` and read only relevant requirement sections/IDs.
2. Load only the most relevant domain doc next:
   - Backend: `docs/be.md`
   - Frontend/UI: `docs/fe.md`
   - User flow: `docs/flow.md`
   - Product intent and tie-breaker context: `docs/product.md`
   - Testing strategy: `docs/test.md`
3. Read by heading/section only. Do not read whole files unless strictly needed.

## Context Budget

1. Default budget: max 2 docs per task pass (`requirements` + 1 domain doc).
2. Expand to a 3rd doc only when blocked by ambiguity or conflict.
3. Avoid large quotes. Summarize and cite requirement IDs/section names.

## Source Precedence

1. `docs/requirements.md`
2. Relevant design doc (`docs/be.md`, `docs/fe.md`, `docs/flow.md`)
3. `docs/product.md`
4. Agent defaults/preferences

## Conflict Protocol

If sources conflict, stop implementation and report:

1. Exact file + section/heading references.
2. Proposed interpretation options.
3. Which choice needs boss confirmation.
