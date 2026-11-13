---
name: pr-review-loop
description: "Keep the PR queue of one GitHub repo moving: on an interval, review PRs that ask for your review (council review from pr-review), reply to reviewers on your own PRs, and answer mentions. Posts agreed findings, queues disagreements as questions for you, never blocks, never changes code or merges. Use on 'pr-review-loop', 'watch my PRs', 'keep my reviews moving', 'answer the pr-review questions'."
metadata:
  version: "0.2.0" # x-release-please-version
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
  cron, launchd, or `while :; do pr-review-loop; sleep 1800; done`. Run it in
  a clone of the repo: the tick fetches the PR heads there. cron and launchd
  start with a bare PATH and none of your exports, so the job must set them:
  `cd /path/to/clone && PATH=<dir of node>:$HOME/.local/bin:$PATH
  && . ~/.config/pr-review/env && pr-review-loop`, where the env file (mode
  600) exports `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN`.

Without `owner/repo`, the loop uses the GitHub remote of the current
directory, `origin` first. `pause`, `resume` and the tick use the same rule,
so in a fork clone they all act on the fork.
After each tick, show what the engine printed: open questions, to-do items,
and the PRs it reviewed or replied on. Do not repeat the posted text.

## Pause and resume

`pr-review-loop pause [owner/repo]` stops every tick for the repo until
`pr-review-loop resume [owner/repo]`. An interrupted tick finishes its old queue first on
the next run.

## Answer the questions (`/pr-review-loop answer`)

1. Run `sh "$SKILL_DIR/scripts/pr-review-loop" answer --repo owner/repo` (the
   repo the loop runs on; outside a clone of it the repo is required). It prints the open
   questions as JSON.
2. Ask the user. Claude Code: `AskUserQuestion`, at most 4 questions per
   call. pi: the `ask_user` tool. Show the finding and both arguments. Do not
   add your own opinion.
3. For each answer, run
   `sh "$SKILL_DIR/scripts/pr-review-loop" answer <id> <post|drop|ask-author> --repo owner/repo`.
4. Do not run a tick for this. The next tick applies the answers. It checks
   each finding against the current head first and drops it if the code
   moved.
5. A question with `"kind": "core-paths"` asks which paths of the repo are
   core (for `auto` depth). Ask the user for globs, and offer the candidates
   from the question. Save them with
   `sh "$SKILL_DIR/scripts/pr-review-loop" config core-paths <owner/repo> [glob...]`
   (no glob = none). That closes the question. `answer <id> drop` also
   saves none; the question offers no other option.

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
