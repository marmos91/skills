---
name: pr-land
description: "Merge a converged GitHub PR and clean up after it: check the live state (CI green, the newest pr-review review clean or an approval, no unresolved thread, mergeable), retarget stacked PRs before anything is deleted, squash-merge with a concise title after a secret scan, delete the branch, rebase the stacked PRs on the new base, remove the local worktree and branch, tick the tracking issue and close the fixed issues. Several PRs land in stack order. Use on 'pr-land', 'land this PR', 'merge PR 42 and clean up', 'land the stack'."
metadata:
  version: "0.2.0" # x-release-please-version
---

# pr-land: merge a converged PR and clean up

The `pr-land` command does every step; you (the agent) read its JSON and
tell the user what happened. `$SKILL_DIR` is the folder of this file.

Run it in a clone of the repo. It prints JSON. Exit codes: `0` done, `1`
usage error, `2` blocked (not ready, a scan hit, a rebase conflict), `4` a
`git` or `gh` step failed.

```sh
sh $SKILL_DIR/scripts/pr-land <pr>... [--dry-run]
```

## Steps

1. **Plan.** Run with `--dry-run` first and show the user the squash title,
   the stacked PRs and the steps. Merge only after a yes.
2. **Land.** Run without `--dry-run`. For each PR, in stack order:
   - **check** the live state: open, not a draft, mergeable, every check
     green (a pending check is not ready), no unresolved review thread, no
     reviewer asking for changes, and either GitHub says approved or the
     newest full `pr-review` review posted by you (the `gh` user) is on the
     head with `must=0 questions=0` in its marker. A follow-up review or an
     older one without those fields does not count. The squash
     title is the PR title with ` (#N)`; it must be a concise conventional
     title. Title and message get the AI-mention check and the secret scan
     (`secret-scan` when installed, else the `pr-review` scan;
     `PR_LAND_SECRET_SCAN` names another scanner binary, mainly for tests).
   - **retarget children**: every open PR based on this branch moves to its
     base, before anything is deleted. When GitHub manages the stack and
     refuses, it retargets them itself after the merge; `pr-land` checks it
     did before the delete.
   - **merge** through `merge-async` (squash, pinned to the checked head SHA:
     a push after the check cancels it).
   - **delete branch**, **rebase children** (their own commits onto the new
     base, signed, pushed with `--force-with-lease`), **local cleanup**
     (worktree and branch, unless they hold other work), **issues** (tick
     the checklist line on the tracking issue with a link to the PR, close
     the issues the PR fixes if GitHub did not).
3. **Report.** On `0`, show `landed` and any `notes`. On `2` or `4`, show
   `blocked` or `error`, `why`, and `done` against `notDone`. A merge is
   never undone. Not ready: say why, merge nothing. A rebase conflict: the
   rebase is aborted and the child's branch is untouched; the user rebases
   it by hand.

## Rules

- Never merge a PR the check calls not ready; never work around a check.
- A rebased child has a new head: it needs a new review round before it
  lands. Land a stack one PR per review round.
- To fix a title, edit the PR title (`gh pr edit N --title`), then run again.
