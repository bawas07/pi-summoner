---
name: full-reviews
description: Review a completed branch against its base using 1-3 specialist reviewers (code-reviewer, security-auditor, architect-reviewer) scaled to the diff's actual risk surface. Consolidates findings into must-fix and should-fix buckets. Use before PR/merge.
argument-hint: "[branch-name] [base-branch]"
---

# Task Reviewer

## Overview

Five-step workflow: (0) clarify missing or ambiguous inputs with the user, (1) diff the target branch against its base **and size the review**, (2) fan out to the chosen 1–3 reviewers in parallel with task context, (3) merge their findings into exactly two buckets — **must-fix** and **should-fix**, (4) validate every finding against the real diff before delivering, to minimize hallucinated claims.

**Scaling principle: just enough + one step ahead.** Not every branch needs three reviewers. Pick the smallest set of reviewers that covers the diff's actual risk surface, plus at most one "next-concern" reviewer. Default is the full 3; step down when the diff is narrow in scope **and** lacks the signals that justify the extra reviewer. Scaling down trades marginal coverage for faster, higher-signal output.

## Step 0 — Clarify inputs and ambiguity

Before running any git or agent command, make sure the review has a solid foundation. Do not proceed to Phase 1 until this step is complete.

### 0.1 — Check what the user gave you

Detect defaults first, then list what is **missing** or **ambiguous**:

| Input | Default to try | Ask if… |
|---|---|---|
| Target branch | current branch (`git rev-parse --abbrev-ref HEAD`) | user mentions a different branch, or current branch is base itself |
| Base branch | origin HEAD → `main` → `master` → `develop` | repo has multiple long-lived branches, or user's branch was cut from a feature branch |
| Acceptance criteria | user-provided text/path → linked issue/PR body → repo task file (`.tasks/`, `docs/tasks/`, `TASK.md`) | none of the above found, or criteria read as vague ("improve X", "refactor Y" with no success condition) |
| Scope bounds | full diff | diff >2k lines or >30 files (ask whether to exclude lockfiles, generated code, vendored deps) |

### 0.2 — Ask one consolidated question

Batch every missing/ambiguous item into a **single message** to the user. Do not drip-feed one question at a time. Example:

```
Before I start the review, a few things to confirm:

1. Target branch: I see you're on `feat/payments-v2` — review that one? (y/n)
2. Base branch: repo has both `main` and `develop`. Which is the merge target?
3. Acceptance criteria: I didn't find a task file or linked issue. Can you paste
   the criteria, or point me at an issue/PR?
4. The diff is ~3,200 lines across 47 files. Want me to exclude `pnpm-lock.yaml`
   and `src/generated/*` from the reviewers' scope?
```

### 0.3 — Watch for these ambiguity signals

Even if the user provides criteria, ask a follow-up when you see:

- **Vague verbs with no success condition** — "clean up", "improve", "optimize" without a metric or target state.
- **Conflicting criteria** — e.g. "must not change the API" but diff clearly changes the API.
- **Implicit scope** — "fix the bug" without saying which bug, or "add tests" without saying for what.
- **Undefined terms** — feature names, system names, or thresholds the skill cannot resolve from the repo.
- **Partially-satisfied criteria** — one of N bullet points looks unaddressed in the diff; confirm whether it was descoped or missed.

For each signal, ask a targeted question. **Never guess and silently proceed** — a wrong assumption here flows into must-fix classification and invalidates the whole review.

### 0.4 — Record the resolved inputs

Once answered, echo back a short confirmation block so the user can catch misinterpretation before reviewers run:

```
Proceeding with:
- Target: feat/payments-v2
- Base:   develop  (merge-base abc1234)
- Criteria: <1-line summary of each bullet>
- Excluded from review: pnpm-lock.yaml, src/generated/**
```

Do **not** proceed without acceptance criteria. Must-fix classification depends on them.

## Phase 1 — Explore the diff

Collect — do not truncate — the material the reviewers need:

```bash
git fetch origin --quiet
git merge-base <base> <target>                    # record as BASE_SHA
git log --oneline <base>..<target>                # commits on the branch
git diff --stat <base>...<target>                 # file-level scope
git diff <base>...<target>                        # full diff
```

Use `<base>...<target>` (three dots) so the diff is relative to the merge-base, not the current tip of base.

Produce a short **Change Summary** (for your own use and to feed reviewers):

- Branch: `<target>` → base `<base>` (merge-base `<BASE_SHA>`)
- Commits: N
- Files touched: list by area (e.g. `src/auth/*`, `tests/*`, `migrations/*`)
- High-level intent in 1–2 sentences

If the diff is huge (>2k lines or >30 files), warn the user and ask whether to proceed or narrow scope (e.g. exclude lockfiles, generated code).

## Phase 1.5 — Size the review (pick 1–3 reviewers)

Before fanning out, decide how many reviewers the diff actually warrants. Match the smallest set that covers the signals, then add one "next-concern" reviewer if the diff plausibly holds issues in that next-most-likely area. Do **not** run all three by reflex.

### Signal scan

From the diff + change summary, tag which apply:

- **Risk surface** — auth/permissions, crypto, secrets, input parsing, external calls, new deps, migrations, PII, SSRF surface
- **Structural** — new module/boundary, pattern change, cross-cutting refactor, public-API shape change, data flow reshape
- **Stack** — language/framework concentration (informs focus prompt, not count)
- **Magnitude** — lines changed, files touched, number of commits

### Reviewer selection matrix

| Scope signals | Count | Reviewers |
|---|---|---|
| ≤100 lines, single concern, no risk surface, no structural change | **1** | `code-reviewer` |
| ≤300 lines with **one** risk surface OR **one** structural signal | **2** | `code-reviewer` + `security-auditor` (if risk) **or** `code-reviewer` + `architect-reviewer` (if structural) |
| >300 lines, OR **two+** risk surfaces, OR risk + structural, OR migrations + auth, OR explicit user request for full review | **3** | all three |

**Always include `code-reviewer`.** It's the acceptance-criterion and correctness anchor — dropping it risks missing "unmet criterion" findings.

**"One step ahead" upgrades**: if you're at count 1 and a risk surface exists even if minor (e.g. touches `auth/` or a dep bump), upgrade to 2 with `security-auditor`. If you're at count 2 (code + security) and the diff also changes a module boundary or introduces a cross-cutting pattern, upgrade to 3. Do not upgrade for taste or "just in case."

**When to downgrade further**: if this skill was invoked but the diff is so narrow it fits `review-simple-task` criteria (tiny, single-concern, single-file), say so in one line and suggest the user escalate down to `review-simple-task`, which now runs a lightweight 1–2 reviewer pipeline.

### Announce the chosen set

After Step 0's confirmation block, show the user (one line) what you'll run and why:

```
Running: code-reviewer + security-auditor (2 reviewers). Diff touches auth/ but is
structurally isolated — architect pass would be low-signal. Override? (y to add
architect-reviewer)
```

If the user overrides, adjust. Default proceeds if they don't object.

## Phase 2 — Run the chosen reviewers in parallel

Launch the **1–3 reviewers chosen in Phase 1.5** in a **single message with parallel Agent tool calls** so they run concurrently. Each gets the same context block plus its own focus prompt.

### Shared context block (include in every agent prompt)

```
TASK / ACCEPTANCE CRITERIA:
<paste verbatim>

BRANCH UNDER REVIEW: <target>
BASE BRANCH: <base> (merge-base <BASE_SHA>)

CHANGE SUMMARY:
<the summary from Phase 1>

DIFF COMMAND TO REPRODUCE:
git diff <base>...<target>

Review only the changes in this diff. Cite findings by `path:line` from the post-change file.
Return findings as a list. Each finding: severity (critical/high/medium/low), location, problem, suggested fix.
Write every finding in English, regardless of the language used in the code, comments, or task description. Keep identifiers, file paths, and error/log strings verbatim from the source; do not translate those.

You MAY consult external sources when the diff touches anything where your training data may be stale: library/framework APIs, deprecation status, CVE advisories, recent RFC/spec changes, new language features, breaking-change notes. Use in priority order:
  1. `context7` MCP — resolve library name → fetch current docs. Prefer for framework/library API questions (React, Next.js, Prisma, Laravel, Django, etc.), even well-known ones.
  2. `exa` MCP (`web_search_exa`, `web_fetch_exa`) — for CVEs, security advisories, migration guides, recent changelogs.
  3. `WebSearch` / `WebFetch` — general fallback when context7/exa don't fit.
Skip external lookups for business logic, style, or things derivable from the current codebase. Cite the source in the finding (`per <lib>@<version> docs` / `per CVE-YYYY-NNNNN` / URL). If lookup fails or is inconclusive, say so — do not invent a citation.

You MAY disagree with the task's chosen approach or with a specific technical decision in the diff — even if it meets the acceptance criteria. But only raise dissent if you have a STRONG reason: a concrete failure mode, a measurable cost (perf, maintenance, security), an industry convention being violated, or a simpler design that demonstrably covers the same cases. Mark dissent findings with the tag `[dissent]` and include:
  - what you'd do differently (one sentence)
  - the strong reason (one sentence, with evidence — not preference or taste)
  - estimated cost of changing now vs. leaving it
Do not raise dissent for style preferences, "I would have named it X", or unverified hypotheticals. If you cannot state a concrete failure mode or measurable cost, omit the finding.

ANTI-OVERENGINEERING: Do not flag missing abstractions, helpers, or factoring for hypothetical future requirements. Do not flag missing error handling / validation / fallbacks for scenarios that cannot happen — trust internal code and framework guarantees; only demand validation at system boundaries (user input, external APIs). Do not recommend splitting ≤3 similar lines into a shared util. Do not recommend feature flags, back-compat shims, or deprecation paths unless the diff changes a public/external API. Do not flag "this test could cover more cases" without naming the concrete untested behavior. If a finding reduces to "this could be more reusable / defensive / configurable / extensible someday" without a concrete failure mode present in the diff today, omit it.
```

### Per-agent focus prompt

- **code-reviewer** — "Focus: correctness bugs, logic errors, error handling, tests, readability, dead code, violations of the repo's conventions. Check that the diff actually satisfies each acceptance criterion; flag any unmet criterion as critical."
- **security-auditor** — "Focus: authz/authn, injection, SSRF, secret handling, input validation at boundaries, dependency risks, unsafe defaults. Rate severity by exploitability and blast radius."
- **architect-reviewer** — "Focus: module boundaries, coupling, data flow, scalability, consistency with existing patterns, migration/rollout risk. Flag architectural drift even if the code works."

Do **not** have agents run tests or make edits — reviews only. If an agent asks to modify code, ignore the edits and keep the findings.

## Phase 3 — Consolidate into two buckets

Merge the reports from the reviewers that actually ran (1–3). Deduplicate overlapping findings (same `path:line` + same root cause → one entry, note which reviewers raised it). Classify every finding into exactly one of:

### Must-fix — block merge

Any of:

- Acceptance criterion not met, or silently changed
- Critical/high security issue (exploitable, auth bypass, secret leak, injection)
- Correctness bug that breaks the happy path or a documented edge case
- Data loss, irreversible migration, or destructive default
- Inconsistency that will break callers or existing contracts
- Missing test for new behavior that has a non-obvious failure mode

### Should-fix — recommend before / soon after merge

- Formatting, naming, minor readability (only if impact is real, not cosmetic)
- DX improvements (better errors, logs, types) not required by criteria
- Near-term refactors that pay off within the next ~1–2 sprints
- Nice-to-have tests, docs, or observability
- Style drift from repo conventions with functional impact (even if small)

**Ambiguous?** If a finding could be either, ask: *"Does this block correctness/security/acceptance right now?"* Yes → must-fix. No → should-fix.

### Caps + signal floor

- **Max 8 must-fix, max 8 should-fix.** Below cap fine — ship fewer if fewer exist. Don't pad.
- **Drop nitpicks**: single-char style, variable name taste, "could be more idiomatic" without functional cost, whitespace, comment wording.
- **Drop far-future scalability**: "won't scale past 10×", "bad at 100k users/day" when current load is nowhere near. Keep only if load is plausible within 1–2 sprints.
- **Over cap?** Rank by impact: acceptance-blocking > security > correctness > contract break > test gap > perf/arch > DX. Keep top 8. Drop the rest — don't dump them into should-fix instead.
- **Under-signal over-padding**: 2 strong findings > 8 weak ones. Reviewer trust dies on padding.

### Handling `[dissent]` findings

Reviewers are allowed to disagree with the task's approach or a technical decision, but only with a strong, evidence-backed reason (see Phase 2 prompt). Route each `[dissent]` finding as follows:

- **Strong reason + concrete failure mode or measurable cost** → classify by impact:
  - Blocks correctness/security/acceptance *now* → **must-fix**, keep the `[dissent]` tag and preserve the "what I'd do differently" line in the entry.
  - Creates real but non-blocking future cost (maintenance, perf headroom, scalability) → **should-fix**, same tagging.
- **Weak reason — preference, taste, "I would have done it differently", or unverified hypothetical** → **drop**. Do not surface it to the user. Padding the report with unbacked dissent damages trust.
- **One reviewer dissents, others don't object** → keep the finding but note `Raised by: <reviewer> (dissent, not echoed)`. Single-voice dissent is fine when the reason is strong.

Do **not** create a separate "dissent" section in the output — dissent findings live inside must-fix or should-fix with the `[dissent]` tag visible in the title.

## Phase 4 — Validate findings (anti-hallucination pass)

Agents can fabricate: wrong line numbers, non-existent functions, drifted file paths, misquoted code, or claims that the diff "doesn't handle X" when it actually does. Before returning the report, verify **every finding** survives the checks below. Drop or rewrite anything that fails.

Run this pass **after** consolidation but **before** showing the output to the user.

### 4.1 — Evidence checks (run per finding)

For each entry in must-fix and should-fix, confirm:

| Check | How |
|---|---|
| **File exists on target branch** | `git cat-file -e <target>:<path>` — if fail, drop finding |
| **Cited line(s) exist and are in the diff** | Read the file at the cited line range; confirm the range overlaps the `+`/`-` hunks in `git diff <base>...<target> -- <path>` |
| **Quoted code is verbatim** | String-match the quoted snippet against the file at the cited line. If the reviewer paraphrased, either fix to verbatim or drop the quote |
| **Claimed symbol exists** | For any function/class/variable named in the finding, `grep` the codebase (not just the diff). Missing → drop or rewrite |
| **"Missing X" claims are really missing** | If a reviewer says "no validation", "no error handling", "no test" — grep the post-change code and tests to confirm. Many false positives live here |
| **Acceptance-criterion claims** | For every "criterion not met" entry, point at the specific file+line from the diff that proves it. No proof → downgrade or drop |
| **Severity is justified** | Critical/high claims need a concrete exploit path or failure mode described in the finding. Vague severity → downgrade |
| **External citations check out** | For findings citing a library version, CVE, RFC, or URL, verify via `context7` / `exa` / `WebFetch`. Fabricated citation → drop finding. Stale but real citation → keep, note the date |

### 4.2 — Cross-reviewer sanity

- **Contradictions** — if two reviewers disagree on the same location, re-read the code yourself. Keep the correct one; drop the wrong one; if still unclear, keep both and mark `disputed` in the entry.
- **Out-of-scope findings** — drop anything pointing at files **not in the diff** (reviewers sometimes wander). Exception: a finding that says "this change should have also touched X but didn't" is in-scope — keep it and cite the relevant diff location that made X necessary.
- **Duplicate concerns, different wording** — merge into one entry with combined `Raised by:` list.

### 4.3 — Self-check log

After validation, append a short internal tally (do **not** include in the user-facing output):

```
Validation: N findings in → M findings out
Dropped: <count> (reasons: <fabricated line / file not in diff / false-positive claim / …>)
Rewritten: <count> (reasons: <paraphrase → verbatim quote / severity downgraded / …>)
Disputed: <count>
```

Use this tally to decide whether to re-run any reviewer. If **>30%** of findings from a single reviewer were dropped as fabricated, call that reviewer once more with a stricter prompt: *"Previous pass produced hallucinations. Cite only `path:line` you can quote verbatim from the diff. If uncertain, omit the finding."*

### 4.4 — Final guardrail

Only findings that pass 4.1 and 4.2 reach the user-facing output. When in doubt, **drop rather than deliver** — a missed finding is recoverable; a confidently-wrong one damages trust in the whole review.

## Output format

Use exactly this structure. Keep each finding to 1–3 lines.

```markdown
# Task Review: <target> → <base>

**Acceptance criteria coverage:** <met | partial | not met> — <1 line>
**Reviewers:** <actual set — 1, 2, or 3 — with 1-line rationale for the count>
**Diff:** N files, +X/-Y lines, M commits

## Must-fix

1. **<short title>** — `path/to/file.ts:123`
   Problem: <what and why it blocks>
   Fix: <concrete change>
   Raised by: code-reviewer, security-auditor

2. ...

(If none: "None — acceptance criteria met, no blockers.")

## Should-fix

1. **<short title>** — `path/to/file.ts:45`
   <problem + suggested fix in one line>
   Raised by: architect-reviewer

2. ...

(If none: "None.")
```

Do **not** add other sections (no "summary", "next steps", "praise"). The two buckets are the deliverable.

**Hard cap:** ≤8 per bucket. Fewer is fine. If truncation applied, add one line at the end: `Truncated: N more lower-priority findings dropped.`

## Guardrails

- Never edit code in this skill. Review only.
- If a reviewer's finding contradicts another's, keep both and note the disagreement in the entry — let the user decide.
- If acceptance criteria are vague, list the assumptions you used to judge "met" so the user can correct them.
- Quote error/log strings exactly; never paraphrase them.
- **Output language: always English.** Regardless of the codebase language (comments, identifiers, commit messages, task descriptions, or agent-returned findings in other languages), write the consolidated report — headings, "Problem", "Fix", severity labels, rationales, and all user-facing text — in English. Instruct each sub-agent in its focus prompt to also reply in English. Keep code snippets, file paths, identifiers, and quoted error/log strings verbatim from the source; do not translate those.
