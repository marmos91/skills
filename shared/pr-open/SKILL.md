---
name: pr-open
description: "Take a finished branch to an open, review-ready GitHub PR: format and lint with the project's own commands, clean the history (signed commits, no AI mentions, after the user approves the plan), run the tests and put the real counts in the body, scan for secrets, link the issue, and stack on a parent branch when asked. Then offer a pr-review round or pr-respond. Use on 'pr-open', 'open a PR', 'ship this branch', 'prepare a PR', 'make this review-ready'."
---

# pr-open: take a branch to a review-ready PR

You (the agent) do the steps that need judgment: lint fixes, the history
plan, the PR body. The `pr-open` commands do the steps a script can check:
they find the commands, run the tests, check the commits, scan for secrets,
push and open the PR. `$SKILL_DIR` is the folder of this file.

Run every command in a clone of the repo, on the branch to open. Each
command prints JSON. Exit codes: `0` done, `1` usage error, `2` blocked by a
check (fix it, then run the command again), `4` `git` or `gh` failed.

```sh
P="sh $SKILL_DIR/scripts/pr-open"
```

## Steps

1. **Base.** The PR goes to the default branch. For a stack, the base is the
   parent branch. A base with an open PR of its own is a stack; any other
   base (for example `develop`) is a plain base, and `open` warns that it
   has no parent marker. For a stack, open the parent's PR first; a plain
   base such as `develop` needs no PR of its own.
   When the branch does not start from the default branch and the user did
   not say, ask.
2. **Format and lint.** Run `$P detect`. It finds the commands in env
   (`PR_OPEN_FORMAT`, `PR_OPEN_LINT`, `PR_OPEN_TEST`), `.pr-open.json`,
   `package.json`, `Makefile`, `justfile`, `Cargo.toml` or `go.mod`. A `null`
   command: look in `CLAUDE.md`, `AGENTS.md` and `CONTRIBUTING.md`; still
   none, ask the user. Run the format command, then the lint command. Fix
   what lint reports.
3. **History.** Write a plan for the commits: each group of changes and its
   concise message, in the repo's commit style, with no AI or tool name and
   no AI trailer. Show the plan to the user and wait for a yes. The user can
   say "keep the history". Then save a backup,
   `git update-ref refs/pr-open/backup/<branch> HEAD`, rewrite, and sign
   every commit (`git commit -S`).
4. **Tests.** Run `$P test` (or `$P test --command "<cmd>"`). It needs a
   clean tree and records the counts for the HEAD commit. Fix any failure.
   A new commit needs a new run: `open` accepts only a run of HEAD.
5. **Body.** Write it from `git diff origin/<base>...HEAD`: what changed,
   why, how it was tested, breaking changes, and `Closes #N` (or the
   checklist item of #N it covers). Do not write test counts: `open` adds
   a `## Tests` line from the recorded run. Follow
   `../pr-review/writing.md`. Save it to
   `$(git rev-parse --absolute-git-dir)/pr-open/body.md`, not in the work
   tree: `pr-open test` needs a clean tree.
6. **Open.** Run `$P check --base <base> --title "<title>" --body-file <file>`,
   fix what it reports, then
   `$P open --title "<title>" --body-file <file> [--base <parent>] [--draft]`.
   `open` checks again, scans the diff, title and body for secrets
   (`secret-scan` when installed, else the `pr-review` scan), pushes and
   opens the PR. A stacked PR starts with `Stacked on #N.` and ends with
   `<!-- pr-open parent: <branch> -->`, which `pr-land` reads.
7. **Handoff.** Show the PR URL and any `warnings`. Ask the user: start a
   `pr-review` round, start `pr-respond`, or stop.

## Rules

- Never write test counts by hand. Never quote a run of an older commit.
- Fix a hit from `check` or the secret scan; do not work around it. When an
  AI-tool name is the subject of the repo (for example a skill that talks
  to Copilot), ask the user, then add the word to `allow` in
  `.pr-open.json`.
- Never force-push a branch that has an open PR. `open` pushes with
  `--force-with-lease` only when no PR is open yet.
- Never merge.
