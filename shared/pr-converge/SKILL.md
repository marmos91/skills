---
name: pr-converge
description: "Drive one GitHub PR from open to merged without a person driving each round: a pr-review council round, then pr-respond on its findings (fix with a test, decline with a reason, push, reply, resolve), then review again, until a round adds nothing new; then pr-land merges, only when the user opted in with --merge. Stops at the round cap or when two rounds raise the same findings; pauses on a user question, a push by someone else, red checks or a land that is not ready. Resumable. Use on 'pr-converge', 'converge PR 42', 'drive this PR to merged', 'review and fix until clean, then land'."
metadata:
  version: "0.8.0" # x-release-please-version
---

# pr-converge: review, respond and land one PR until it converges

This skill adds a loop and its stop rules around three skills: `pr-review`
(one council round), `pr-respond` (you fix or decline the findings) and
`pr-land` (merge and clean up). The `pr-converge` command runs the review
rounds, keeps the state, and tells you when it is your turn. `$SKILL_DIR`
is the folder of this file.

Run it in a clone of the repo, on the PR branch. It prints JSON. It passes
`--repo` to `pr-land`, which blocks when the clone has no remote for it.
`--config <file>` and `--effort <level>` go to every `pr-review` round.

```sh
sh $SKILL_DIR/scripts/pr-converge run <n> [--merge] [--config <file>] [--effort low|medium|high|max|auto]
```

| Exit | Status | What you do |
|---|---|---|
| `0` | `converged` or `merged` | Report to the user (below). |
| `2` | `respond` | Your turn: run `pr-respond` on this round's findings (below). |
| `3` | `paused` | Read `pause.why`; see "Pauses". |
| `5` | `capped`, `stalled` or `declined` | Report what is still open. Nothing is merged. |
| `1` / `4` | | A usage error or a lock, or a step failed: tell the user. |

## The loop

1. **Merge gate.** Merge only when the user said so (`--merge`, or a yes
   when you start). Ask at the start when they did not say. Without it,
   the loop stops at `converged`. The opt-in is kept for every rerun, and
   `run <n> --merge` after a `converged` stop lands the PR.
2. **Run** `pr-converge run <n> [--merge]`. It runs a `pr-review` round on
   the PR head. A round with no new agreed finding and no `must` goes to
   the checks and, with `--merge`, to `pr-land`.
3. **Respond** (exit `2`). Follow the `pr-respond` skill for one round:
   decide, fix with a test, run the full suite, commit signed, push, reply
   `fixed`, and post the point-by-point summary, each point with its
   `thread`. Then run `pr-converge run <n> --pushed <sha>` with the full
   sha of the head you pushed (`git rev-parse HEAD`). The loop reads the
   points `pr-respond summary` recorded at that head, with the
   fingerprints of each thread's findings (`fps`); you copy none by hand.
   (`--points <file>` still takes a hand-written file, with `"fp"` per
   point.) A `must` counts as fixed only when a `done` point names its
   fingerprint and its commit is new since the round. The
   push counts for this one step; the next round's findings are your turn
   again. Every finding declined and nothing pushed: pass the current head;
   the loop then goes to the checks without another round.
4. The loop starts the next round. Go to step 2.

## Stop rules

- **Converged:** a round has no new findings, no `must`, no open question,
  and the checks are green. With `--merge`, `pr-land` merges.
- **Round cap:** `converge.max_rounds` in the pr-review config (default 4).
  At the cap the loop stops and reports what is still open. It never
  merges.
- **No progress:** a round that raises only the findings of the round
  before (same fingerprints) stops the loop (`stalled`).
- **Open must:** a `must` that no `done` point with a new commit names
  (declined, left out, or nothing pushed) stops the loop before land
  (`declined`). It never merges; the user decides. A declined `should`
  does not block. To fix the must after all, push the fix, run
  `pr-respond fixed` and `summary`, then
  `pr-converge run <n> --resume --pushed <sha>`: the push is a new round.

## Pauses

A pause holds until you run again with `--resume`. Tell the user why.

- `question`: a split finding or a comment held by the secret scan waits
  for the user. They answer with `pr-review answer`; then `--resume`
  reviews the same round again. The round keeps the findings it raised.
- `review-skipped`: `pr-review` did not review (the head was reviewed
  before, you have a pending review on GitHub, or the repo has no core
  paths set for `review.depth` auto: set them with
  `pr-review config core-paths`). Submit or delete the
  pending review, or confirm a new review of the same head; then
  `--resume` reviews it again (`--restart`).
- `foreign-push`: someone else pushed to the PR. Show the user the new
  commits. On a yes, `--resume` reviews the new head as a new round.
- `checks`: CI is pending or red. Wait, or push a fix; then `--resume`.
  A pushed fix is reviewed as a new round before it lands.
- `land`: `pr-land` says the PR is not ready. When it is a conflict,
  rebase on the base so that only the conflicts are resolved, run the full
  test suite, push, and run `pr-converge run <n> --rebased <sha>`. That
  rebase needs no new council round. A rebase that changes code does: push
  it, then `--resume` after a `foreign-push` pause.

`pr-converge status <n>` prints the saved state. The state lives in the
PR's `pr-review` state folder (`pr/<n>/converge/state.json`), so a run that
stopped resumes where it was. A lock per PR lets several PRs converge at
the same time; the review child takes the review lock of the PR, so a
manual review of the same PR waits.

## Done

At the end the loop posts one PR comment (a rerun edits it): the rounds, the findings fixed,
those declined with the reason, those still open, and the merge commit.
It passes the secret scan first (`secret-scan` when installed). Report the
same to the user with the PR URL.

## Rules

- Signed commits (`git commit -S`), no AI or tool name in commits, replies
  or the PR. `pr-respond` and `pr-land` scan for secrets before they post
  or push.
- Never merge without the user's opt-in. Never merge at the cap or after a
  `stalled` stop.
- Never force-push a PR branch except to push a conflict-only rebase.
