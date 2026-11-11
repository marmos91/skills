---
name: pr-review-loop
description: "Keep the PR queue of one GitHub repo moving: on an interval, review PRs that ask for your review (council review from pr-review), reply to reviewers on your own PRs, and answer mentions. Posts agreed findings, queues disagreements as questions for you, never blocks, never changes code or merges. Use on 'pr-review-loop', 'watch my PRs', 'keep my reviews moving', 'answer the pr-review questions'."
---

# pr-review-loop: keep the PR queue moving

One run (a tick) checks the open PRs of one repo and does the work that is
due. It never asks during a run: disagreements go to a question queue.
`$SKILL_DIR` is the folder of this file. Full guide: `docs/pr-review.md` in
the skills repo, section "The loop".

## Start

- Claude Code: `/loop 30m /pr-review-loop [owner/repo]`. Each interval runs
  `sh "$SKILL_DIR/scripts/pr-review-loop" [owner/repo]` once.
- pi or any shell: one tick is `pr-review-loop [owner/repo]`. Repeat it with
  cron, launchd, or `while :; do pr-review-loop; sleep 1800; done`.

Without `owner/repo`, the loop uses the repo of the current directory.
After each tick, show what the engine printed: open questions, to-do items,
and the PRs it reviewed or replied on. Do not repeat the posted text.

## Pause and resume

`pr-review-loop pause` stops every tick for the repo until
`pr-review-loop resume`. An interrupted tick finishes its old queue first on
the next run.

## Answer the questions (`/pr-review-loop answer`)

1. Run `sh "$SKILL_DIR/../pr-review/scripts/pr-review" answer`. It prints the
   open questions as JSON.
2. Ask the user. Claude Code: `AskUserQuestion`, at most 4 questions per
   call. pi: the `ask_user` tool. Show the finding and both arguments. Do not
   add your own opinion.
3. For each answer, run `pr-review answer <id> <post|drop|ask-author>`.
4. Do not run a tick for this. The next tick applies the answers. It checks
   each finding against the current head first and drops it if the code
   moved.

## Setup (once per machine)

1. Run `claude setup-token`. The normal `claude` login expires, and an
   unattended loop then stops.
2. Make a fine-grained GitHub PAT with pull-request write access on the
   target repos only. Export it as `GH_TOKEN` for the loop.
3. Run `pr-review doctor`. It must show a working probe for each seat.

## Rules

- Never post, approve, resolve or commit yourself. The engine does each
  action.
- `pr-review status [owner/repo]` shows the queue, the budgets and the lock.
