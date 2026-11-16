# pr-review benchmark

Past PRs with a known bug, one that a later commit fixed. The benchmark runs the
real pr-review engine on each PR and checks whether the council finds the bug.
It gives recall and false positives per effort level and per seat mix, so the
defaults can rest on data.

Nothing is posted. The engine stops after the vote tally (`until: "tally"`), so
no decide, compose or post stage runs, and jev is never asked. The engine
keeps its state in a temporary `XDG_STATE_HOME`, not in your own pr-review
state. Old review threads are hidden from the seats, so they cannot read an
earlier finding on the same bug.

The benchmark is not part of the npm package (`bench/` is not in `files`) and
CI does not run it. CI runs only the scorer tests (`test/score.test.mjs`).

## A case

`cases.json` is a JSON array. One case is one PR:

```json
{
  "id": "skills-44-respond-config",
  "repo": "marmos91/skills",
  "pr": 44,
  "base": "<40-char sha: merge-base of the base branch and the head>",
  "head": "<40-char sha: the PR head that holds the bug>",
  "fix": "<40-char sha: the later commit that fixed it>",
  "bugs": [{ "file": "shared/pr-review/scripts/main.mjs", "lines": [179, 179], "what": "one sentence" }]
}
```

`lines` are line numbers in the file at `head`. A PR can hold more than one bug.

## Add a case

1. Find a fix commit, and the PR that brought the bug in: `git blame <fix>^ -L a,b -- <file>`.
   Use only a public GitHub repo. The runner refuses any repo that is not public.
2. Take the PR head and base: `gh pr view <n> -R owner/repo --json headRefOid`, then
   `git merge-base origin/main <head>`. A PR merged with a merge commit has an empty diff
   against the base branch today, so use squash- or rebase-merged PRs.
3. Find the buggy lines at the head: `git show <head>:<file> | grep -n ...`. The lines must
   be in the PR diff, or next to it: the seats review the diff.
4. Write one plain sentence per bug in `what`, and run `npm test`, which checks the file.

## Run

```sh
node bench/pr-review/run.mjs --until frame --effort medium   # no model call: children planned per case
node bench/pr-review/run.mjs --effort medium                  # the real run
node bench/pr-review/run.mjs --effort high --only skills-48-proof
node bench/pr-review/run.mjs --effort medium --config mix-opus-only.json --label medium-opus-only
```

- `--effort low|medium|high|max` sets the effort, as in `pr-review review --effort`.
- `--config <file>` is a pr-review config file (see `shared/pr-review/config.example.json`).
  Put the seat mix to test in its `seats`, `judge` and `lenses`. Without it, your own
  pr-review config applies.
- `--depth full` runs the setup checks too. The default is `light`.
- `--slack N` (default 3): a finding up to N lines outside a bug's range still finds it.
- `--clones <dir>` keeps the clones of the case repos (default `~/.cache/pr-review-bench`).

Each run writes `results/<label>.json` (every cluster, with its file, line, severity and
vote status) and `results/<label>.md`, and prints the table.

## The numbers

- **bugs found (agreed)**: bugs that an agreed finding overlaps (same file, line in the
  range plus the slack, any severity). This is what a review would post.
- **found before the vote**: the same over every merged cluster. The gap between the two
  is what the vote filters out.
- **FP must/should**: agreed `must` and `should` findings that overlap no known bug. A case
  has only its known bugs, so a real but unknown bug counts as a false positive too. Read
  the findings in the JSON before you trust this number.
- **tokens in/out** and **wall s** per case. Tokens in counts cache reads and writes.

## Cost

At the defaults, `--until frame` plans 12 children per case at `low`, 17 at
`medium` and 44 at `high` and `max`. Recent real `medium` reviews of this
repo used 1 to 6 M input tokens (mostly cache reads) and 40 to 240 k output
tokens each, so one `medium` run of the 3 cases is about 10 to 25 M input
and 0.5 M output tokens. `high` costs about 2.5 times that.

## Limits

- The seats still see the PR's review summaries and comments (`reviews.json`,
  `comments.json`); only the inline threads are hidden.
- 3 cases, all from this repo. More cases from other public repos make the numbers
  worth more than the noise of one run.
