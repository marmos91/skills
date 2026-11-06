# Campaign improvement ledger

Running list of measured/observed improvement opportunities for the
repo-audit + repo-audit-fix engines and this campaign. Append new findings
with date + evidence; strike (~~...~~) when applied and verified.

## Applied during this campaign

- 2026-11-03 — Plan review didn't converge: two-tier verdicts + surgical
  revisions (#2). Evidence: 3 epics FATALed at 3-round ceiling; after the
  fix, approval in round 2 with nit passthrough.
- 2026-11-03 — Off-by-one: budget counted reviews, not revises, so the final
  revise never got reviewed (#4). Evidence: FATAL epics had plan.md newer
  than the last review and contained every demanded fix.
- 2026-11-03 — Implementers ran the repo's 3-lens gate on themselves
  mid-stage (20+ min wasted per epic) (#5). Fix: prompt restricts
  verification to lint/typecheck/tests.
- 2026-11-03 — Gate lenses were sequential (3 x 900s worst case per round);
  now parallel subshells (#6).
- 2026-11-03 — CONCURRENCY 3 -> 5 (v5).
- 2026-11-03 — RESUME.md durable status doc + every-crash-point resume
  healing (#3).
- 2026-11-06 — Code gate never converged (dotfiles run: 16 epics, ~4h,
  ZERO gate passes; slop-install-stow-truth FAILed all 3 lenses after 4
  revise rounds). Fixes, all verified with a mock `pi` (converge, park,
  restart, budget raise):
  - Two-tier gate verdicts: lenses tag `BLOCKING` vs `NIT`, pass = zero
    BLOCKING; NIT-only exits 0; NITs go to the PR body, never a revise round.
    Simplification lens: BLOCKING only for dead code / real bug. Evidence:
    gate-simplification.txt raised 3-7 fresh taste nits per round (e.g.
    "comment leaks audit jargon"), so the binary gate could never pass.
    Shipped `scripts/review-lens.sh` template + SKILL.md lens contract.
  - Rounds >= 2 review the delta: `gate-sha` marker; lenses get
    `LENS_PRIOR` (their prior BLOCKING findings) + `LENS_DELTA`
    (`<gate-sha>..branch`), verify the prior ones, raise new BLOCKING only
    inside the delta. Evidence: each round re-reviewed the full diff and
    found new things instead of checking fixes. Revise prompt now carries
    BLOCKING findings only.
  - Gate round derived from `revise-r*.md` on disk. Evidence: a
    crash/restart reset the in-memory counter to 0, granting extra rounds.
    A failed revise child no longer silently consumes a round.
  - RESUME.md rewritten on every stage transition, every failed gate round,
    and on `status` (atomic tmp+rename, epics write it concurrently).
    Evidence: RESUME.md stale 2+h while the run was live.
  - Park instead of hold: budget spent → `<epic>/blocked.md` with open
    BLOCKING findings, lane freed, not counted as failed; re-runs stay
    parked without re-gating. Evidence: 7 wave-1 epics never started in 4h
    because 6 lane slots were held by non-converging gate loops.
  - Epics with <= 3 findings skip research (architect verifies itself).

## Open opportunities (candidates, with trigger conditions)

1. **CONCURRENCY 5 -> 7-8**: trigger when monitor shows children pinned at 5
   (queue saturated) AND per-lane latency stable (no provider throttling).
   Watch token spend; implementers are isolated worktrees so blast radius is
   per-epic.
2. **lane starvation at wave boundaries**: wave 1 has 25 epics but later
   waves fewer; a later wave can start when its deps' PRs are opened (not
   merged) if we accept restacking — currently strictly sequential across
   waves. Trigger: monitor shows idle lanes while wave-2 deps sit merged.
3. **plan-review round latency**: each round is a full mimir call on a
   4-20k-token plan; consider passing only the plan DELTA + reviewer's prior
   verdict for rounds >= 2 instead of the full epic.json. Trigger: rounds
   > 2 becoming common again.
4. **research on small epics is thin value**: slim scouts cost ~2 min; fine.
   But for single-file epics the research could be skipped (plan reads the
   file itself). Trigger: if research artifacts show copy-paste of finding
   text.
5. **cache reviewer verdicts across epics with shared titles/findings**:
   sub-epics of the same parent share findings; reviewers re-derive the
   same repo facts. A shared facts file could seed reviewer prompts.
   Trigger: identical blocking comments appearing in multiple epic
   reviews (already observed once: cross-epic duplicate-finding dispute).
6. **lens gate timeout tuning**: REVIEW_TIMEOUT=900s per lens; adversarial
   on 600-line diffs historically fits, but god-epic diffs (3000+ lines)
   may need 1200s to avoid false FAILED GATE. Trigger: any lens exit 124.
7. **PR creation could parallelize with next wave** (stage_pr after
   gate-pass; push+gh are seconds) — negligible, skip.
8. **merge ordering for stacked deps**: stage_pr bases wave-2 PRs on dep
   branches; if a dep gets BLOCKED, dependents still open PRs against a
   dead branch. Trigger: first BLOCKED epic with dependents.
9. **pi child startup**: each pi -p cold-starts (~30-60s incl. graphify
   hook post-commit noise in the parent repo). Could batch sibling
   children via one pi --mode json invocation — high effort, low value;
   only if children count dominates (unlikely).

## Measurement sources

- monitor (events/hour, lane count): .pi task "campaign speed monitor"
- per-stage durations: grep timestamps in campaign log + RESUME.md
- FAILED GATE / FATAL patterns: campaign log + $STATE/blocked

## Decisions

- 2026-11-03 (v6 wave 1): 5 epics exhausted a genuine 5-revise plan-review
  budget (ui-a11y-state-feedback, structure-api-domain-layers,
  bugs-api-write-paths, bugs-web-ux-state, tests-race-and-lease-integrity).
  Decision: let the campaign finish the other ~34 epics first (zero
  disruption), then one focused resume pass with PLAN_ROUNDS=8 and
  EPIC_FILTER=<those five> so the hard plans get a bigger budget without
  re-running anything else. If those still don't converge at 8, the final
  plans + last objections go to human review rather than another loop.

- 2026-11-04 (v8 end): ledger item 6 TRIGGERED — adversarial lens exit 124
  (timeout) on 6 gate-blocked epics (diffs up to 2,197 lines). Gate retries
  run with REVIEW_TIMEOUT=1500. Monitor curve: overnight tail slower
  (approved 14->22 over 10h, PRs 7->11); convoy fix verified children=5-7
  during peak.
