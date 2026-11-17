---
name: pr-land
description: "Merge a converged GitHub PR and clean up after it: check the live state (CI green, the newest pr-review review clean or an approval, no unresolved thread, mergeable), retarget stacked PRs before anything is deleted, squash-merge with a concise title after a secret scan, delete the branch, rebase the stacked PRs on the new base, remove the local worktree and branch, tick the tracking issue and close the fixed issues. Several PRs land in stack order. Use on 'pr-land', 'land this PR', 'merge PR 42 and clean up', 'land the stack'."
metadata:
  version: "0.8.0" # x-release-please-version
---

# pr-land: merge a converged PR and clean up

The `pr-land` command does every step; you (the agent) read its JSON and
tell the user what happened. `$SKILL_DIR` is the folder of this file.

Run it in a clone of the repo. `--repo owner/repo` names the repo when the
clone has several remotes (a fork); the clone needs a remote for it. It prints JSON. Exit codes: `0` done, `1`
usage error, `2` blocked (not ready, a scan hit, a rebase conflict), `4` a
`git` or `gh` step failed.

```sh
sh $SKILL_DIR/scripts/pr-land <pr>... [--repo owner/repo] [--dry-run]
```

## Steps

1. **Plan.** Run with `--dry-run` first and show the user the squash title,
   the stacked PRs and the steps. Merge only after a yes.
2. **Land.** Run without `--dry-run`. For each PR, in stack order:
   - **check** the live state: open, not a draft, mergeable, every check
     green (a pending check is not ready), no unresolved review thread, no
     other reviewer asking for changes, and the review rule:
     - the newest full `pr-review` review posted by you (the `gh` user) is
       on the head with `must=0 questions=0 gaps=0` in its marker (the
       last line of the body); or
     - GitHub says approved, with an approval of the head, and no full
       `pr-review` review on the head says otherwise. When `pr-review` has
       a full review on the head, its counts decide even over an approval.

     A follow-up review or an older one without those fields does not
     count; a follow-up that posts findings writes the head's new counts.
     Questions are the finding questions that wait on a person or on a
     `pr-review` run to apply the answer: the marker counts them when it is
     posted, and when that review ran on this machine the live queue
     replaces the count. A follow-up takes the full review's counts from
     local state, else from the newest marker at the head on GitHub; with
     neither (a review from before the counts) it writes `gaps=1`, and
     `pr-land` asks for a full review. Fetches and pushes go to the git remote whose URL is the
     PR's repo on the host `gh repo view` reports (github.com, or a GitHub
     Enterprise host: https, `git@host:`, or `ssh://` with a port); with
     none, nothing is merged. Every `gh` call, the first one included, goes
     to the host of the clone's remote (upstream, github, origin, then the
     rest): `GH_HOST` is set to it before any `gh` call, over any exported
     value. The squash
     title is the PR title with ` (#N)`; it must be a concise conventional
     title. Title and message get the AI-mention check (with the `allow`
     list of `.pr-open.json`, as `pr-open` uses it) and the secret scan
     (`secret-scan` when installed, else the `pr-review` scan;
     `PR_LAND_SECRET_SCAN` names another scanner binary, mainly for tests),
     with `--repo` for the PR's repo and for each repo a push to its remote
     reaches (as `pr-open`), so the private-repos opt-out can apply.
   - **merge** through `merge-async` (squash, pinned to the checked head SHA:
     a push after the check cancels it). A failed merge changes nothing else.
   - **retarget children**: every open PR based on this branch (up to 1000;
     more blocks the check) moves to the base. When GitHub manages the stack
     and refuses, it retargets them itself; `pr-land` checks it did.
   - **delete branch**, only when no open PR is based on it any more and it
     is still at the merged head; otherwise it is kept and reported.
   - **rebase children** that `pr-open` opened as stacked on this branch
     (its parent marker), or same-repo children whose history holds the
     merged head: their own commits onto the new base, signed, pushed with
     `--force-with-lease`. Any other child is retargeted only, with a note.
   - **issues**: tick the checklist line on the tracking issue with a link
     to the PR, close the issues the PR fixes if GitHub did not; a `#N`
     that cannot be read is noted and skipped.
   - **local cleanup**: the worktree and branch of
     a same-repo PR, only when the branch is at the merged head and the
     worktree has no changed, untracked or ignored files; anything else is
     kept with a note. It runs last, so a worktree that cannot be removed
     leaves the issues done.
3. **Report.** On `0`, show `landed` and any `notes`. On `2` or `4`, show
   `blocked` or `error`, `why`, and `done` against `notDone`. A merge is
   never undone. Not ready: say why, merge nothing. A stop after the
   merge also lists `retargeted`, `rebased` and `rebasePending` (children
   not yet rebased). A rebase conflict: the rebase is aborted and the
   child's branch is untouched; the user rebases it by hand, or fixes the
   cause and runs `pr-land` on the merged PR again. The merge records its
   children in pr-land's state (per host and PR); a merged PR resumes after
   the merge with only the children still on its branch and the recorded
   ones not yet rebased, never other PRs on the base. A child that already
   holds the merge commit (rebased by hand) counts as done. When the base
   already holds the merged head (a merge commit or a fast-forward), no
   child is rebased. The record goes when no child is left.

## Rules

- Never merge a PR the check calls not ready; never work around a check.
- A rebased child has a new head: it needs a new review round before it
  lands. Land a stack one PR per review round.
- To fix a title, edit the PR title (`gh pr edit N --title`), then run again.
