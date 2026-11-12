---
name: repo-audit-fix
description: 'Use after repo-audit produced findings/epics and the user wants them FIXED. Triggers on "fix the findings", "implement the audit issues", "remediate the epics", "work through the roadmap". For each epic: research → architect plan → plan review → implement → 3-lens gate → PR. Fans out waves in parallel, runs dependencies sequentially, fully resumable.'
metadata:
  version: "0.1.0" # x-release-please-version
---

# repo-audit-fix

## Overview

Companion to `repo-audit`. Consumes the audit's `epics.json` + `findings.json`
(+ GH issues by exact-title match) and executes the remediation:

```
research (mimir-slim, read-only)   → ground truth per finding; flags wrong findings; classifies test-vs-mechanical
        ↓
architect plan (mimir-pro)         → code-architect implementation plan: files, design, minimal tests, sequencing
        ↓
plan review (mimir)                → adversarial gate on the plan; revise loop (max 3 rounds)
        ↓
implement (mimir, full tools)      → code in an isolated epic worktree; runs the plan's verification commands
        ↓
3-lens gate (review-lens.sh)       → adversarial + correctness + simplification vs BASE_REF
        ↓ (BLOCKING → revise, max GATE_ROUNDS, then PARKED; NIT-only = pass)
PR per epic (gh, Fixes #N)         → never auto-merged; the user merges
```

Waves come from the audit's `depends_on` graph: waves run sequentially,
parallelizable epics inside a wave run in batches of `CONCURRENCY`, **each in
its own git worktree** so two agents never touch the same checkout.

## Hard rules

- **Resumable by markers, never by absence.** Every stage writes a 1-byte
  marker (`research.md`, `plan.md`, `plan-approved`, `implemented`,
  `gate-passed`, `pr-url`) under `$FIXROOT/.fix/<epic>/`. A re-run skips
  completed stages. A crashed child leaves no marker → retried. `(Marker files
  must be NON-empty: the engine tests them with [ -s ]; a 0-byte marker is
  invisible and re-triggers the stage — write `echo ok > marker`, never
  `: > marker`.)`
- **Every stage resumable at every intra-step crash point.** The durable map
  is `$FIXROOT/.fix/RESUME.md`, rewritten at run start, on every stage
  transition and gate round, on `status`, and at run end: per-epic stage markers, last review verdicts, FATAL/blocked
  list, and the exact resume command. After a crash, read it first. Specific
  crash windows that are actively healed on relaunch: implementer summary
  written but commit missing → falls through to diff-check+commit (never
  re-runs the child on a dirty tree); gate revise edits sitting uncommitted →
  committed as a checkpoint before gate rounds (lenses diff three-dot
  ranges, so uncommitted edits would be invisible and the gate would loop
  on stale findings); PR created but pr-url unwritten → the open PR on the
  epic branch is adopted instead of duplicated.
- **Two-tier gate.** Lenses tag findings `- BLOCKING ...` or `- NIT ...`; the
  gate passes on zero BLOCKING findings. NITs never trigger a revise round —
  they go into the PR body (`gate-nits.md`). The simplification lens reports
  only dead code or a real bug as BLOCKING; taste is NIT. A failed/timeout
  lens is a FAILED GATE.
- **Rounds >= 2 review the delta.** After each round the gated HEAD is stored
  in `gate-sha`; the next round passes each lens `LENS_PRIOR` (its previous
  BLOCKING findings) and `LENS_DELTA` (`<gate-sha>..<branch>`), so it first
  verifies the prior findings, then raises new BLOCKING ones only inside the
  delta — no fresh full-diff hunt every round.
- **Round count is on disk** (`revise-r*.md` count + 1), so restarts never
  reset the budget. When it is spent the epic is **parked**: open findings go
  to `<epic>/blocked.md`, the lane frees, re-runs stay parked without
  re-gating. Raise `GATE_ROUNDS` to give it more rounds.
- Implementers never commit/push; the orchestrator commits after verifying a
  real diff exists (empty diff = FATAL).
- PRs are opened, never merged. The user merges.
- Findings needing product decisions surface as `deferred`, never guessed.
- Epic branches all base on `BASE_REF`; `depends_on` orders execution, not PR stacking. Stacked PRs are out of scope — Wave 2+ prs are normal PRs.
- No AI attribution in commits/PRs (repo rule).

## Environment

| Var | Default | Role |
|---|---|---|
| `AUDIT_STATE` | (required) | dir with `epics.json` + `findings.json` |
| `REPO_DIR` | git toplevel | main checkout (worktree registry, review-lens, gh) |
| `FIXROOT` | `/tmp/audit-fix-<repo>` | epic worktrees + state under `.fix/` |
| `BASE_REF` | `origin/main` | branch base + gate diff range |
| `SLIM_MODEL` | `cubbit/mimir-slim` | research scout (read-only) |
| `PLAN_MODEL` | `cubbit/mimir-pro` | architect (read-only) |
| `REVIEW_MODEL` | `cubbit/mimir` | plan review + 3-lens gate |
| `IMPL_MODEL` | `cubbit-headroom/mimir` | implement + revise (full tools) |
| `CONCURRENCY` | 3 | parallel epics per wave |
| `GATE_ROUNDS` | 2 | max revise rounds after failed gates (counted from disk), then park |
| `EPIC_FILTER` | — | comma list of epics (testing/partial runs) |
| `DRY_RUN` | 0 | 1 = skip actual `gh pr create` |
| `JEV` | auto | `auto` = use the `jev` CLI when on PATH: flags findings an approved plan drops (once per finding, never on the last plan round); the first jev outage turns it off for the rest of the run; `off` = never |
| `JEV_CONFIDENCE` | 0 | minimum jev confidence to act on its answer; 0 = no gate, because confidence does not predict correctness (`bench/jev/RESULTS.md`) |
| `REPO_CTX` | generic | one-line project context for every child |
| `LENS` | `$REPO_DIR/scripts/review-lens.sh` | the 3-lens gate script — see *Lens contract*. REQUIRED: set `LENS` if the repo has no such script (e.g. `LENS=<skill>/scripts/review-lens.sh`, the shipped template) — the engine dies rather than fakes a passed review |

## Commands

```sh
sh .agents/skills/repo-audit-fix/scripts/fix.sh plan    # build plan.json (waves + issue links)
sh .agents/skills/repo-audit-fix/scripts/fix.sh run     # run everything (resume-safe)
sh .agents/skills/repo-audit-fix/scripts/fix.sh status  # per-epic stage markers
sh .agents/skills/repo-audit-fix/scripts/fix.sh clean    # remove worktrees + local branches
```

Typical full run:

```sh
AUDIT_STATE=/path/to/audit/.audit \
  sh .agents/skills/repo-audit-fix/scripts/fix.sh run
```

## Lens contract

`$LENS <lens> <range>` with lens in `adversarial|correctness|simplification`
and range `BASE_REF...branch`; runs from `REPO_DIR` with `REVIEW_PROVIDER`,
`REVIEW_MODEL`, `REVIEW_THINKING` set.

- Exit 0 = pass (zero BLOCKING findings — **NIT-only output must exit 0**);
  non-zero = fail.
- stdout: findings as bullets `- BLOCKING file:line — problem — fix` /
  `- NIT ...` (continuation lines until the next bullet or blank line are
  kept). BLOCKING bullets feed the revise round and `blocked.md`; NIT
  bullets feed the PR body. Untagged output from a failing lens is passed to
  the revise round raw (legacy lenses keep working, they just converge slower).
- Optional env on rounds >= 2: `LENS_PRIOR` (file, this lens's previous
  BLOCKING findings) and `LENS_DELTA` (git range since the last gated sha).
  Ignoring them is compatible.

`scripts/review-lens.sh` is the reference implementation.

## Design notes (why, so you don't undo it)

- **Small epics skip research:** <= 3 findings → `research.md` is a stub and
  the architect verifies the findings itself (saves a lane-slot + ~2 min).
- **Test minimalism:** the research stage classifies each finding as
  logic-changed (needs a test) vs mechanical (delete/move → no test). The
  architect names ONLY non-obvious tests; the implementer adds only the
  named ones. No vacuous tests; test quality is enforced by the plan-review
  step and the correctness lens.
- **Worktree isolation:** parallel epics never share a checkout; worktrees
  register under FIXROOT (discarded state), the main checkout is only used
  for registry ops, review-lens, and gh.
- **Crash residue handling:** the engine survives prunable worktree
  registrations, leftover non-worktree dirs, and existing branches — reuse
  instead of die (`git worktree prune` + targeted rm + branch reuse).
- **Architect discipline:** plans must name the exact files, reuse existing
  helpers, choose the smallest complete diff, and follow the repo's pure-module
  pattern. The plan review rejects plans that drop findings, add speculative
  flexibility, or test the obvious.
- **Danger shift:** the whole per-epic pipeline runs as plain `pi -p` children
  with explicit tool allowlists (read-only models get `read,grep,find,ls`;
  only the implementer gets writes + bash, inside its worktree). No pi-subagents
  workflows, which are broken in this environment (see AGENTS.md).
- **Fail loud, never fake a pass:** empty child outputs, invalid plan-review
  JSON, and empty implementation diffs are all FATALs, retried on the next
  `run`, not silently misread as "done".

## Testing

The engine was validated end-to-end before first real use, with a mock `pi`
on PATH dispatching by prompt persona: full pipeline, exact resume (all
markers honored), plan-review revise loop, gate-fail → revise rounds →
PARKED after GATE_ROUNDS (no PR; restart stays parked, raised budget resumes
at the on-disk round), NIT-only lens output passes with nits collected, crash-residue worktree recovery, and
wave-batch parallelism. Re-validate after changes with the same technique:
`EPIC_FILTER=<one small epic> DRY_RUN=1 LENS=<stub>` is cheap and asserts
the state machine, not the models.

The jev plan-coverage gate (`scripts/lib/jev-gate.sh`) has its own test with
a stub `jev` on PATH: `sh scripts/test/jev-gate.test.sh` (exit-code mapping,
outage latch, once-per-finding guard, crash before the revised plan is saved).

## Relation to the audit

Input contract: `epics.json` (id, epic, title, goal, findings, acceptance,
depends_on, parallelizable) + `findings.json` (id, lens, file, line, severity,
title, what, why, fix). GH issues attach by **exact title match** — run
`repo-audit`'s `issues` step before this skill, or pass issues.tsv manually,
so PRs carry `Fixes #N`.
