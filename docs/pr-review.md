# pr-review and pr-review-loop

`pr-review` reviews one GitHub PR with a council of different models.
`pr-review-loop` runs that review, and replies on threads, for a whole repo on
an interval. One engine serves both skills. Source:
`shared/pr-review/scripts/` (entry point `scripts/pr-review`, a shim for
`main.mjs`).

The two skills only approve, comment, request changes, reply to a thread and
resolve a thread. They never change code, commit, push, merge or close a PR.
Everything posts as the user of `gh auth`, with no signature and no AI
attribution.

![One pr-review run](img/pr-review-flow.svg)

## Commands

| Command | What it does |
|---|---|
| `pr-review review <n> [--repo o/r] [--effort low\|medium\|high\|max\|auto] [--depth light\|full\|auto] [--lens a,b] [--max-diff-lines N] [--dry-run] [--until stage] [--restart]` | Review one PR. `<n>` is a number or a PR URL. Without `--repo`, the repo of the current directory |
| `pr-review answer` | Print the open questions as JSON |
| `pr-review answer <id> <post\|drop\|ask-author>` | Record your answer to one question |
| `pr-review status [owner/repo]` | Questions, to-do items, review and reply counts per PR, lock holder, unfinished runs, tokens per stage, paused flag |
| `pr-review doctor` | Merged config, the loaded lenses, a 1-token probe per seat, `gh auth status`, jev, gitleaks, claude login mode, planned child count per effort level |
| `pr-review config core-paths <owner/repo> [glob...]` | Save the core paths of a repo for `auto` depth. No glob saves "none" |
| `pr-review tick [owner/repo]` | One loop run (a tick); `pr-review-loop` calls it |
| `pr-review-loop [owner/repo]` | One loop run (a tick) |
| `pr-review-loop pause` / `resume [owner/repo]` | Stop or restart every tick for the repo |
| `pr-review-loop answer [<id> <option>]` | Same as `pr-review answer` |
| `pr-respond <action> [--pr <n\|url>]` | The steps of the pr-respond skill (`pr-review respond`); see [pr-respond](#pr-respond) |

Review flags:

- `--effort auto` picks the level from the changed paths (see [Effort](#effort)).
- `--depth light|full|auto` sets the review depth (see [Depth and setup checks](#depth-and-setup-checks)).
- `--lens a,b` runs only these lenses. The other lenses count as failed, so
  the review never approves.
- `--max-diff-lines N` raises `review.max_diff_lines` for this run.

Without `owner/repo` or `--repo`, every command uses the GitHub remote of the
current directory, `origin` first. `pr-review-loop pause` and `resume` use the
same rule.

Exit codes of the engine:

| Exit | Meaning |
|---|---|
| `0` | Done |
| `3` | Questions wait for you. Only an interactive `review` exits `3`. The loop queues questions and continues |
| `4` | A stage or a GitHub call failed after its retries. Check the PR before running again; part of the review may be posted. A rerun never posts the same item twice |
| `1` | Usage or setup error, a diff above `review.max_diff_lines`, or a run above `review.max_children` |

The skills (`shared/pr-review/SKILL.md`, `shared/pr-review-loop/SKILL.md`)
are thin. They run the engine, ask your questions on exit `3`, and show the
result.

## One review, step by step

The engine runs 9 stages in order: `frame`, `setup`, `round1`, `merge`, `round2`,
`tally`, `decide`, `compose`, `post`. Each stage, and each child inside a
stage, writes a `.done` marker after its output passes the stage schema.
`--until <stage>` stops after that stage.

### 1. Frame

The engine pins the head SHA for the run and writes one context folder that
every seat reads:

- PR metadata, the diff, the commits, and the author's questions from the PR body.
- The issues that the PR closes. If there is none, the summary says "No
  tracking issue or plan." and the correctness lens checks the PR against its
  own description.
- Review guidance from the **base** branch: `.pr-review.json`,
  `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`, `.github/*`
  guides, and the paths in `review.guidance`.
- All earlier reviews, threads (open and resolved) and comments.
- Your own open findings from earlier reviews, with their threads.
- CI state for the head SHA (see [CI](#ci)).
- A git worktree at the pinned SHA. Seats read callers and tests there. Full
  files are not copied into the prompt. The next review or tick removes the worktree of a
  finished run, and of a run at an older head; `ctx` stays, and a resumed run
  makes the worktree again.
- One patch per diff part (`ctx/chunks/<i>.patch`), made with `git diff -W`:
  each change comes with its whole function. Round 1 puts the patch into the
  prompt when it has 2500 lines or fewer, so seats need fewer reads.

A diff above `review.max_diff_lines` (default 6000) stops the run with exit
`1` before any child runs. `--max-diff-lines N` reviews it anyway.

A diff above `review.chunk_lines` (default 500) splits into parts. A folder
(a Go package, with its tests) stays in one part when it fits. Folders are
packed in path order. A folder that does not fit splits into units, and a
file stays in one unit with its test (`x.go` and `x_test.go`). Each round-1
job runs once per part and reports findings only in the files of its part.
Every part prompt holds a map of the PR: the files of each part and the
functions that its hunks change. A seat reads the new version of a function
that another part changes when its own code uses it. The architecture lens
is about design across parts, so it reviews the whole PR once per seat.
Merge then removes the duplicates across parts. Votes and the judge see the
whole PR. A seat that hits its turn limit or its timeout in one part loses that
part only: it keeps its other parts and its vote. The summary names the
missed parts, and a missed part blocks APPROVE, as a dropped seat does.

Each part adds a full set of round-1 children. When the run needs more than
`review.max_children` (default 60), an effort that the config chose steps
down until the run fits. An explicit `--effort` stops the run with exit `1`
instead. `review.max_parallel` (default 9) sets how many round-1 children run
at the same time.

### 1b. Setup

At `full` depth the engine runs the setup checks once in the worktree, and
gives a short result to the round-1 and vote seats (not the judge or the
hygiene check). At `light` depth this stage does nothing.
See [Depth and setup checks](#depth-and-setup-checks).

### 2. Round 1: independent review

Each seat reviews with no view of the other seats. `round1` sets the shape:

- `per-seat`: 1 child per seat runs all its lenses.
- `per-lens`: 1 child per seat and lens. More depth, about twice the
  children.

The effort level sets this shape (`low` and `medium` = `per-seat`, `high`
and `max` = `per-lens`), so it overrides `round1` from your config. See
[Effort](#effort).

A lens with its own seats (for example a security panel) always runs in its
own children.

| Lens | Looks for |
|---|---|
| adversarial | Inputs and states the author did not expect. Each finding has a repro: run for a trusted author, traced and written down for others |
| correctness | Bugs, broken callers, missing tests for risky code. Does the PR do what its issue says, all of it and nothing else? |
| simplification | Dead code, a helper that already exists, a stdlib feature, an abstraction with one use, near-copies |
| architecture | Module boundaries, coupling, data flow, fit with existing patterns, API and UX shape |
| security | Validation at trust boundaries, authn and authz, secrets, injection, data exposure, unsafe defaults |

### Your own lenses

Put a lens file in `~/.config/pr-review/lenses/<name>.md` (or under
`$XDG_CONFIG_HOME`). The name is the file stem. It uses only `a-z`, `0-9` and
`-`. It cannot be a built-in lens name or a reserved name (`hygiene`, `all`,
`v`, `merge`, `compose`, `constructor`, `prototype`). The loader skips dot files
and files that are not `.md`. The file has the same shape as a
built-in lens and the same limit: 40 lines and 4000 characters. A user lens is
on by default. Set `lenses.<name>` like a built-in lens (`enabled`, `seats`,
`max_turns`, `thinking_by_stage`), and select it with `--lens <name>`. A bad
file of a lens that is on stops the run before any child starts, and the error
names the file. The run does not read a lens that is off, so its file does not
stop the run. `pr-review doctor` lists the loaded lenses and warns about a bad
file of a lens that is off.

Only your config folder can add a lens. A repo config cannot, because a lens is
prompt text. A repo can only turn a lens off with `lenses.<name>.enabled: false`.
The loader ignores `enabled: true` from a repo, so a lens that you turned off
stays off. When the repo names a lens that you do not have, that entry does
nothing.

The lens prompts are in `shared/pr-review/lenses/`. Every finding needs a
concrete case: an input or situation and the wrong result. No case, no
finding. A finding has `lens`, `severity` (`must`, `should`, `nit`), `file`,
`line`, `title`, `case`, `evidence` and `fix`.

### 3. Merge

The judge clusters findings that share a root cause. A cluster never crosses
lenses. The judge keeps the best evidence and fix, and records which seats
found it. Then the engine, in code:

- Links each cluster to an existing thread by file, line and text. A cluster
  that repeats a thread is dropped only when the thread is resolved or a
  reviewer gave evidence against it. An author's "won't fix" alone does not
  drop it.
- Drops a cluster that reverses an earlier agreed finding, and records the
  drop in the run state.
- Drops settled findings and findings outside the delta (see
  [Convergence](#convergence)).

### 4. Round 2: vote

Each seat that found a cluster on its own already counts as one `keep`.
Round 2 runs only for clusters that some seats did not find, and only those
seats vote. Each voting seat runs 1 child and votes `keep` or `drop` with a
reason. A `drop` needs a counter-case. A vote child gets 10 turns plus 3 per
finding it checks, and never more than its `max_turns`.

### 5. Tally

`scripts/lib/tally.mjs` is a pure function:

- A `drop` with no counter-case is an abstain.
- **rejected**: the drops with a counter-case are a majority, and no `keep`
  has run evidence.
- **split**: at least 1 drop with a counter-case, but not rejected. Also a
  single `keep` with only abstains.
- **agreed**: 2 or more keeps and no drop with a counter-case.

Rejected findings are kept in the run state, never posted.

### 6. Decide: jev, then questions

Only split findings reach this stage.

1. The engine looks for jev at `../jev/bin/jev` next to its own skill folder,
   then on `PATH`. If it finds jev and `decider.kind` is not `off`, it asks:
   `This finding describes a real defect that this PR introduces.`
   with the finding, the votes and the code hunk as text.
2. jev settles the finding only when it exits `0` (agreed) or `1` (rejected)
   with a parsed verdict that matches the exit, at or above
   `decider.confidence`. The review does not mention jev.
3. Otherwise the finding becomes a question in `questions/<id>.md`, with a
   `.json` sidecar: the code snippet, the finding, the best argument on each
   side, a failure example, and the options `post`, `drop`, `ask-author`.
4. Interactive `review`: the engine exits `3`. The skill asks you, records
   each answer with `pr-review answer <id> <option>`, and runs the same
   command again. The run continues from the marker.
5. Loop: the question stays in the queue. The review is posted without that
   finding.

Text sent to jev passes the secret scan first. jev sends it to an external
API.

### 7. Compose

The judge writes the review from the agreed findings, with the rules in
`shared/pr-review/writing.md` (short sentences, the case first, a code
snippet or a GitHub `suggestion` block, no filler, praise only when earned
and specific, no dashes).
Compose gets only the repo's review guidance: `REVIEW.md` and the files in
`review.guidance`. `REVIEW.md` is always whole. The other files are cut at
8000 characters. The seats read the whole guidance folder.

- Findings stay inline. One finding per inline comment: severity label and a
  title that states the conclusion with a verb, the case in one line with the
  source of each claim ("(ran ...)", "(read file:line)", "I think"), then a
  paste-ready fix. Findings with one root cause and one fix on the same line
  (often from 2 lenses) share one comment.
- The body is a short index of the threads, in this order: the verdict line
  (what blocks and why, or "Nothing blocks."), the answers to the author's
  questions, the inline threads grouped by theme with a `Critical` group
  first (each line ends "(thread on `file` L<n>)"), and 1 or 2 lines of
  specific praise when earned. Then the hygiene list and the engine lines.
  The engine writes each index line with the real line of its thread, and
  leaves out a finding that did not post inline.
- The author's questions are the lines of the PR body that end with "?", and
  the lines under a heading that names questions (code blocks skipped, 10 at
  most). Frame writes them to `pr.json`, and compose answers them first.
- A later review opens with "Second pass, on `<sha>`." It does not describe
  the PR again, and says if the author's replies check out. An earlier
  finding of ours that 2 seats now judge wrong (none open) is retracted first,
  as "Correction: ...". Its thread is resolved and recorded, so it no longer
  blocks and a later pass does not judge it again. An earlier `must` of ours
  that is still open goes to compose, and the verdict names it; the engine
  never lets the verdict say "Nothing blocks." while it blocks. Otherwise the body says "No new
  findings." Fixed earlier findings get their link in the thread.
- A finding off the diff lines is listed once, under "Outside the diff".
- A finding from a single seat, or one the author must clarify, is written
  as a question to the author.
- The effort level caps the severities and the count (see
  [Effort](#effort)). The summary says how many findings were left out.

### 8. Verdict

The event is computed in code from the vote data, never taken from model
text (`scripts/lib/verdict.mjs`). The first row that matches wins.

| Condition | Event |
|---|---|
| Your own PR | `COMMENT` (GitHub does not allow more) |
| 1 or more agreed `must`, or an earlier `must` of yours still open | `REQUEST_CHANGES` |
| An open question, a split, a failed lens, a dropped seat, any agreed finding, or red or pending CI | `COMMENT` |
| Loop run, and the shell rule (Trust and isolation, item 3) does not hold or not every seat found zero | `COMMENT`, and an "approve?" question for you |
| None of the above | `APPROVE` |

### 9. Post

1. Hold the lock of the PR (section Resume and pause).
2. Read the CI state again, then check the head again. If it moved, drop
   this run and frame again.
3. Place each inline comment on the diff hunks of the pinned SHA. A
   suggestion goes only on an added or context line on the right side. A
   finding outside the hunks moves into the summary with a permalink.
4. Scan every outgoing body with `gitleaks stdin` (or the same patterns when
   gitleaks is missing). A hit stops that post and queues a question.
5. If you have a pending review on the PR that this run does not own, skip
   the PR. Submit or delete that review, then run again.
6. Search your recent comments for the run marker. A hit means the post
   already happened.
7. Post with 1 `addPullRequestReview` mutation (`commitOID`, threads, event),
   so nothing stays pending.
8. For each earlier finding that the new head fixes: reply "Fixed in
   <commit link>." and resolve the thread. When the newest comment of the
   thread is already yours, add the link to that comment instead of a reply.

Each posted body ends with a hidden marker:
`<!-- pr-review run=<id> sha=<sha> key=<hash> -->`. An inline comment adds
`fp=<fingerprint>`, one for each finding it covers, separated by commas. A
later run links a repeat of any of these findings to the thread.

With `--dry-run` the engine writes the review to a file in the run folder,
prints the planned children and models, prints the tokens that each stage
used, and posts nothing.

### Token usage

Each child writes `<key>.usage.json` next to its output in the run folder:
`input`, `output`, `cache_read` and `cache_creation` tokens, summed over its
attempts. `claude -p --output-format json` and `pi --mode json` report these
counts. A count that the harness does not report is `null`. A missing count
never fails a run. Reply children count under the `reply` stage.
`pr-review status` shows the totals per stage of each unfinished run, and of
the newest run of each PR (`lastRunTokens`), also a dry run or a run with
`--until`.

The prompts help the prompt cache. Each prompt starts with the parts that all
children of a run share: the context, the small context files (`pr.json`,
`threads.json`, up to 6000 characters each), and in round 1 the diff. The
parts that differ come last: the task, the lens, the budget and the findings.
The data blocks of a run use one nonce, so these parts are the same text in
each child. Merge gets `evidence` of each finding cut to 1500 characters.
`fix` stays whole, because compose posts it.

## Delta review

When you already reviewed the PR:

- If your last reviewed SHA is an ancestor of the head, the council reviews
  only the new commits, and checks each of your open earlier findings against
  the new head.
- After a force-push or rebase, it runs a full review. Settled findings stay
  settled: the engine diffs the new head against the reviewed commit, so only
  lines that really changed can bring one back. If GitHub no longer serves
  that commit, every line of the diff counts as changed.
- Each earlier finding that the new head fixes gets "Fixed in <commit
  link>." and its thread is resolved. When the newest comment is already
  yours, the link goes into that comment, not a new reply.

## Convergence

Reviews of one PR must end. Each rule makes the work smaller with each round.
They apply to a manual `review` and to the loop.

1. **Scope shrinks.** A re-review raises new findings only on the delta.
   Code that the council already reviewed gets no new findings, unless a new
   commit changes its behaviour.
2. **Severity rises.** Review 1 can raise `must`, `should`, `nit`. Review 2
   only `must` and `should`. Review 3 and later only `must`.
3. **Settled stays settled.** Each finding has a fingerprint: lens, file,
   symbol, normalized title (no line number, so a moved line keeps its
   fingerprint). A fingerprint that was dropped by the vote, answered by you,
   or resolved is not raised again unless the code at that place changed.
4. **No contradiction.** The merge step drops a finding that asks for the
   opposite of an earlier agreed finding, and records the drop.
5. **Review budget.** `loop.max_review_rounds` (default 3) automatic reviews
   per PR. After that, no more automatic reviews of that PR: one question
   with the open `must` items goes to you, and a review runs again only on a
   new request from you or the author.
6. **Answers are monotonic.** An `APPROVE` is withdrawn only when a new
   commit adds an agreed `must`.

`pr-review status` shows the review count of each PR.

## Effort

`--effort` (config `effort`, default `medium`) limits token use. It sets the
council size and depth. It never removes a lens or the vote.

| | low | medium | high | max |
|---|---|---|---|---|
| Seats (first N of `seats`) | 2 | 3 | 3 | all |
| Round 1 shape | per-seat | per-seat | per-lens | per-lens |
| Thinking cap | low | medium | high | none |
| Severities posted | must, should | all | all | all |
| Findings posted | 5 | 10 | 20 | no limit |

- The effort overrides `round1`. It lowers a seat's `thinking` to the cap; a
  lower value stays.
- Lens model overrides stay at every effort. Their thinking is capped too.
- The hygiene model check does not run at `low`.

`auto` picks the level from the changed paths. The first match wins:

1. Any path matches `effort_auto.high_paths` (auth, crypto, security,
   permissions, secrets, migrations, `*.sql`, `.github/workflows/**`,
   `Dockerfile*`, Terraform, k8s, helm, infra): `high`.
2. Every path matches `effort_auto.low_paths` (`*.md`, `docs/**`, `*.txt`,
   lockfiles, images): `low`.
3. Otherwise: `medium`.

Patterns match the whole path and ignore case (`Dockerfile*` matches
`dockerfile`, `*.png` matches `.PNG`).

`loop.effort` defaults to `auto`. The loop runs a delta review one level
below that, never below `low`. A repo can add patterns to `high_paths` only,
so a PR cannot lower its own review.

## Depth and setup checks

`--depth` (config `review.depth`, default `light`) sets how much the engine
runs before the seats start.

- `light`: the seats read and vote. The engine runs nothing.
- `full`: the engine runs the setup checks first (below).
- `auto`: `full` or `light`, from the PR. The first match wins:
  1. No path changed (the head is already in the base), or every changed path is docs (`*.md`, `docs/**`, `*.txt`, `*.rst`,
     images) or tests (`*_test.go`, `*.test.*`, `*.spec.*`, `test/`,
     `tests/`, `__tests__/`, `testdata/`): `light`.
  2. Every commit of the PR has the `(cherry picked from commit ...)` line:
     `light`.
  3. A changed path matches `review.core_paths`: `full`.
  4. The diff adds a line that declares an exported name, outside docs and
     test files. The pattern follows the file type: Go (`.go`) `func Name` or
     `type Name`; JS/TS (`.js`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.jsx`, ...)
     `export`; Rust (`.rs`) `pub fn`, `pub struct`, `pub static`, and the
     like. Other files never count: `export X=1` in a shell script is not an
     API. `full`.
  5. Otherwise: `light`.

A run keeps its depth when it resumes.

### Core paths

`review.core_paths` is a list of globs. There is no default. The engine
reads it from the repo's `.pr-review.json` first, then from the answer saved
for the repo (`core-paths.json` in the repo's state folder). It is a per-repo
value: the loader rejects it in the user config.

When the depth is `auto`, the repo has no core paths yet, and the answer can
change the depth of this PR (rules 1, 2 and 4 do not decide it):

- An interactive review stops with exit `3` before round 1, and closes the
  run (nothing ran). The summary
  starts with `core paths not set` and lists candidates: the top folders that
  changed most often on the base branch. Save the answer with
  `pr-review config core-paths <owner/repo> [glob...]`, then run the review
  again. No glob saves "none", so the engine never asks again.
- The loop does not stop. It queues one question for the repo (once), and
  reviews with no core paths until you answer. Answer with
  `pr-review config core-paths`, or `drop` the question to save "none".
  The question offers only `drop`. `config core-paths`
  also closes the question, and a `drop` never replaces saved paths.

### Setup checks

Each check runs once per run, before round 1, in the run's worktree.
`review.checks` is a list:

```jsonc
"checks": [
  // {dirs}: the folders of the changed paths that match "paths", quoted.
  { "name": "go vet", "run": "go vet {dirs}", "paths": ["**/*.go"] },
  // "mutate": true: the test command for mutants and checked fixes (full depth).
  { "name": "go test", "run": "go test -race -count=1 {dirs}", "paths": ["**/*.go"], "repeat": 3, "timeout_s": 900, "mutate": true },
  { "name": "docs", "run": "sh scripts/check-docs.sh", "paths": ["docs/**"] }
]
```

- A check runs only when a changed path matches its `paths`. With no
  `paths`, it always runs. Use this for the repo's own checkers.
- `repeat` (default 1) runs the command up to N times, to find a flaky
  test. The first failed run stops it.
- `timeout_s` (default 300) caps the whole check, all repeats included.
- Without `review.checks`, a repo with `go.mod` at its root gets
  `go build ./...`, `go vet {dirs}` and `go test -race -count=1 {dirs}`
  (3 runs). `-race` needs cgo. Set `"checks": []` to run no check.
- The results (command, exit code, number of runs, the last 4000 characters
  of the output, redacted) go to `ctx/setup.json`. The round-1 and vote
  seats get a short summary in their brief, in its own section outside the
  PR-data block: it is engine data. It names each check and its result; the
  commands, which hold PR paths, stay in `ctx/setup.json`. The judge and the hygiene check
  do not. A failed check is a fact for the review, never a
  failure of the run.
- The review summary says what was checked, in an engine line after the
  verdict, for example `What was checked: full depth; go build ok, go test failed (exit 1, run 2 of 3: flaky).`
  At light depth: `What was checked: light depth, no checks run.`
- Each check has a `.done` marker, keyed by its name, command, `repeat` and
  `timeout_s`. A run that stopped during setup does not run a finished check
  again, and runs a check that you edited. A run whose setup finished keeps
  its results on resume, also when you edit `review.checks`: the seats of
  that run already read them. Use `--restart` to run the checks again.
- `{dirs}` keeps only the folders that still hold a file that matches
  `paths`. A folder whose last `.go` file the PR deletes is left out.

Checks run code from the PR. So:

- They run only when every author is trusted (the shell rule of
  [Trust and isolation](#trust-and-isolation), item 3). Otherwise the
  summary says that the checks did not run.
- `review.checks` and `review.depth` are user-level keys. A repo or a PR
  cannot add a command.
- The working folder is the worktree. The environment is the child
  allowlist (item 2 of Trust and isolation) without the login and engine
  variables (`ANTHROPIC_*`, `CLAUDE_*`), plus the Go build variables
  (`GOPROXY`, `GOFLAGS`, `GOCACHE`, ...). Proxy and TLS variables stay. No
  token reaches a check.
- Each check runs in its own process group. At the time cap the engine sends
  SIGTERM to the group, then SIGKILL after 3 s. When the command exits, the
  rest of its group is killed too.
- Before each check, and after the last one, the engine resets the worktree
  to the PR head (`git reset --hard <head>`, `git clean -fd`), also when a
  check made a commit. So a check never sees what an earlier check wrote, and
  the seats read the PR head as it is. If the reset fails, the engine logs it and the seats' brief says
  so. The worktree is removed with the run.
- A check runs as you, with no file sandbox: it can read files in your
  home folder. That is why it needs trusted authors.

### Proven findings

At `full` depth the engine also tries to prove the findings. It uses the
setup runner, so the same rules apply: trusted authors only, the short
environment, the process-group kill, and the `repeat` and `timeout_s` of
the check. Before and after each run the engine resets the worktree to the
PR head (`git reset --hard`, `git clean -fd`). At `light` depth none of this
runs.

**Mutants.** A check with `"mutate": true` is the test command. The Go
default `go test` has it. A custom `review.checks` list needs it on its test
command, or no mutant and no fix check runs.

- Mutants run only when a surviving one can be posted: the correctness lens
  runs, and the review can post `should` (reviews 1 and 2).
- The engine picks the changed files that are not tests, match the check's
  `paths`, and have a test that the command runs. The tests of a file are
  the tracked test files in its folder, and the test files whose name starts
  with the file's name (`a.go`: `a_test.go`; `lib/x.mjs`:
  `test/x.test.mjs`). A command without `{dirs}` runs every test. With
  `{dirs}`, the command gets the folder of the file and the folder of each of
  its tests that the check's `paths` match. A test in a folder that the
  command does not get does not count.
- It mutates the added lines of the diff, or of the delta in a later review.
  On each line it makes one small break, with the first of these that
  applies: flip `==`/`!=`, move a boundary (`<` and `<=`, `>` and `>=`),
  flip `&&`/`||`, negate `if (...)`, flip `true`/`false`, add 1 to a
  number, drop a return value, drop a call statement (not a log or print
  call).
- String literals and comments never change. Only files with a known line
  comment get mutants (`//`: JS, TS, Go, Rust, Java, C and similar; `#`:
  Python, Ruby, shell). A line with an open string or comment gets none, and
  neither does a line inside a backtick string, a block comment or a
  triple-quoted string.
- The engine runs the test command once with no break. When that fails or
  times out, it runs no mutant for that command, and the brief says why.
  Then it runs each mutant alone. A mutant survives only when every run
  (`repeat`) passes.
- A surviving mutant becomes a `should` finding of the correctness lens:
  "No test catches a break in ...", with the mutant and the command. A caught
  or timed-out mutant is not a finding.
- `review.mutants` (user level): `max` (default 20) mutants and `total_s`
  (default 900) for all runs. The results go to `ctx/mutants.json`, and each
  seat gets a short summary. Each run has a `.done` marker, so a resumed run
  does not run it again. A resume resets the worktree first. When a reset
  fails, no mutant runs, and the brief says why.

**Proof.** Run evidence is one of these:

- a round-1 finding with `evidence_run` from a seat with a shell, that the
  merge put in the cluster (`members`);
- a keep vote with `evidence_run` that the tally counts (an eligible seat,
  its first vote);
- a surviving mutant.

A finding with no run evidence gets the engine line "Unproven: no run in
this review shows this case." in its comment. It is never dropped. Findings
with and without run evidence are never put in one comment. An unproven
`must` stays `must` only when the tally agreed with no drop, or when you
answered it. Otherwise it is posted as `should`. The summary gets an engine
line, for example `Proof: 2 proven, 1 unproven.`

**Checked fixes.** Before the post, the engine applies the first
`suggestion` block of each comment at its line and runs the file's test
command. Then it runs the caught mutants of that file on the fixed code.
When the tests fail, or a caught mutant is no longer caught, the comment
keeps its text but loses its code blocks, and gets a short engine note.
When the tests already fail at the PR head, the fix is not checked. The
check is best effort, capped by `review.mutants.total_s`. When the cap stops
a check, the comment keeps its code and gets the engine note "this fix was
not checked". A plain code snippet, and a comment outside the diff (only its
first line is posted), are not checked. An answered question keeps the
proof status of its finding.

## CI

The engine reads the checks of the head SHA (`statusCheckRollup`).

- **Context**: `ctx/ci.json` lists each check (name, state, URL). For a
  failed check it adds the last 80 lines of the failed job log, with secrets
  redacted. The correctness and adversarial lenses use it as evidence.
- **Verdict**: red or pending CI never gives `APPROVE`. Red CI with no agreed
  `must` gives `COMMENT`, and the summary names the failed checks. The engine
  reads CI again just before it posts; a stale or failed read counts as
  unknown and blocks `APPROVE`.
- **Loop**: a PR with pending checks waits for the next tick, unless the
  checks are pending for more than `loop.ci_wait_minutes` (default 30).
- `review.ci: "ignore"` turns all of this off. The default is `"use"`.
  With `"ignore"`, CI never blocks `APPROVE`.

## Hygiene

A cheap check next to the lenses. It is not a council lens.
`hygiene.enabled: false` turns it off.

- **In code, no model**: the title follows the commit style of the base
  branch (Conventional Commits when 60% or more of the last 50 base commits
  use it); the body is not empty; a linked issue exists when the guidance asks
  for one; `CHANGELOG.md` changed when the repo has one and the PR changes
  code; commit subjects follow the same style.
- **1 child** (judge model, thinking `low`, skipped at effort `low`): does
  the description match the diff, and are docs missing for a changed public
  interface?

Hygiene findings are `should` or `nit`, never `must`. They go into the
summary as one short list, never as inline comments. A model finding is
written as a question. The findings never quote PR text; commits are named by
SHA.

## Trust and isolation

PR content is untrusted: the diff, the body, comments, and every file in the
PR head.

1. **Children are isolated.** A claude seat runs
   `claude -p --restricted --strict-mcp-config --tools Read,Grep,Glob`, with
   your login or a `CLAUDE_CODE_OAUTH_TOKEN` from the environment.
   The file tools have no allow rule, so they read only the child's folder and
   the `--add-dir` folders: the worktree and the run's `ctx` folder. Deny rules block `~/.ssh`, `~/.config`, `~/.aws`
   and `~/.gnupg` on top.
   A pi seat runs
   `pi -p --no-session --no-context-files --no-extensions --no-skills --no-mcp --tools read,grep,find,ls < /dev/null`.
   pi has no file sandbox, so a pi seat (and an `auto` seat that falls back to
   pi) runs only when the shell rule of item 3 holds. Otherwise such a seat fails,
   and the review stops with exit 4 rather than risk a local file in a post.
   The prompt goes on stdin, never on the command line.
2. **Children get a clean environment.** The environment is an allowlist.
   `GH_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` and `AWS_*` never reach a child.
   Only the engine talks to GitHub, and it posts from validated JSON.
3. **Code runs only when every author is trusted.** A trusted author has
   `write` or `admin` permission on the repo (`lib/trust.mjs`, the same rule
   as the replies, the loop and pr-respond). The org association `MEMBER`
   alone does not count. Bots do not count either, and a failed
   permission call counts as untrusted. A shell needs a trusted
   PR author, and every author of text in the run's `ctx` folder (review
   threads and their comments, PR comments, reviews and linked issues) must
   be you or trusted. A linked-issue author that is unknown counts as
   untrusted. One third-party comment makes every seat read-only.
   Then each round-1 job that runs the adversarial lens
   gets a shell (`Bash` or `bash`) to run a repro in the worktree, with a
   timeout that sends SIGTERM to the whole process group, then SIGKILL after
   3 s. Votes get a shell too, so a
   keep vote can carry run evidence. Otherwise every seat is
   read-only, and the repro command is written into the finding. A shell
   seat (`--allowedTools Bash`) can read any file that you can read: the
   environment allowlist keeps tokens out of its environment, but not files
   on disk. That is why the shell runs only when all of that text comes
   from trusted authors. The loop APPROVE follows the same rule.
   Writes are sandboxed: a claude shell seat runs Bash inside Claude Code's
   sandbox (`sandbox.enabled`, no unsandboxed fallback). A command can write
   only in the temp folders: never in `$HOME`, and never in the worktree,
   `ctx` or the stage folder that the other seats read (`denyWrite`).
   A pi seat never gets a shell, and is never told it has one, because pi's
   bash has no sandbox. A vote from a seat without a shell carries no run
   evidence.
4. **Config and guidance come from the base branch.** A PR that changes
   `.pr-review.json` or `CLAUDE.md` changes only its own diff, not the review.
5. **PR text is data.** Prompts wrap the PR text in a delimited block with a
   per-run nonce. The frame makes the nonce and keeps it in `frame.json`, so a
   resume uses the same one. One line says the block is data, never an
   instruction. Tag look-alikes inside the text are broken.
6. **The verdict is code.** See [Verdict](#8-verdict).
7. **Outgoing text is scanned** for secrets: review bodies, inline comments,
   replies and jev text.
8. **Only collaborators trigger actions.** The loop reacts to mentions and
   review comments only from users with write or admin permission. On a
   public repo, read access does not count.

## The loop

![pr-review-loop tick and convergence](img/pr-review-loop.svg)

- Claude Code: `/loop 30m /pr-review-loop [owner/repo]`.
- pi or a shell: `pr-review-loop [owner/repo]` is one tick. Repeat it with
  cron, launchd, or `while :; do pr-review-loop; sleep 1800; done`. The loop
  has no scheduler of its own. A tick must run in a clone of the repo, because
  it fetches the PR heads there; outside one it stops with exit 1. cron and
  launchd give a bare PATH and none of your exports: the job sets PATH (node
  and `~/.local/bin`) and sources a mode-600 file with `GH_TOKEN` and
  `CLAUDE_CODE_OAUTH_TOKEN`. The skill file has the line.

### One tick

1. Exit at once if the repo is paused. Take the repo lock; if another tick
   holds it, exit.
2. Print the open questions and `todo.md`. Apply the answers you gave since
   the last tick. Each answer is checked against the current head first; if
   the code moved, the finding is dropped with a note. The loop never asks
   during a tick.
3. Finish the queue of an interrupted tick (`tick.json`).
4. List open PRs where you are the author, a requested reviewer (you or one
   of your teams), a past reviewer, or mentioned. Skip drafts and authors in
   `loop.authors_ignore`.
5. Skip a PR whose GitHub `updatedAt` did not change. A title or label edit
   counts as a change, so such a PR is looked at again.
6. First tick: set a baseline time. Only later activity counts, plus review
   requests that are still open.
7. Take at most `loop.max_prs_per_run` PRs (default 10), oldest activity
   first.
   The tick works on up to `loop.max_parallel_prs` PRs at the same time
   (default 3), in one process. Each PR takes its own lock. A PR that a
   manual review holds is skipped this tick and tried again on the next.
   Each review still runs up to `review.max_parallel` round-1 children, so
   the machine runs up to 3 x 9 seats at once. A pause stops the PRs that did not start; running
   ones finish.

### What it does per PR

| PR | Action |
|---|---|
| Your PR, with new review comments | `reply` for each new comment (below) |
| Asks for your review, or you reviewed it before | `review`, as a delta review when possible |
| A collaborator mentions you | `reply` in that thread; `review` only if the mention asks for one |

The `reply` flow: one seat drafts a position (accept, push back, or ask),
following the rules of `receiving-code-review`. It accepts only when the
code shows that the reviewer is right. A seat of a different model family
challenges the draft. When both seats agree, the judge writes the reply. When
they disagree, jev decides (`The last comment in this thread, by the other
party, is correct about this code.`); when jev is unsure or missing, the
thread becomes a question and gets no reply yet.

Thread rules:

- Ignore your own comments and bot comments. Reply at most once per new
  human comment.
- Resolve only threads that you started and that are closed: a fixed earlier
  finding is closed; an unanswered pushback is not; an accepted point on your
  PR stays open until the fix is in the head.
- Never resolve again a thread that a human reopened.
- An accepted point on your PR gets a short reply ("Agreed, I will change
  this.") and an entry in `todo.md`.

### Thread convergence

These rules apply to the replies of the loop. The review rules are in
[Convergence](#convergence).

1. **Thread budget.** `loop.max_replies_per_thread` (default 2) automatic
   replies per thread. A reply that only repeats an earlier argument is not
   sent (jev checks `This reply adds a new argument or new evidence.` when
   available). When the budget ends and the thread is still open, the thread
   goes to you with both positions.
2. **Pushbacks are judged once per argument.** A pushback that the reviewer
   answers with new evidence is judged again. A pushback answered with the
   same argument goes to you and is not repeated.

## Resume and pause

State root: `${XDG_STATE_HOME:-~/.local/state}/pr-review/<owner>__<repo>/`.

| Path | Content |
|---|---|
| `lock/` | PID of the tick that holds the repo. A lock with a dead PID is taken over. Only ticks take it |
| `pr/<n>/lock/` | PID of the run that holds PR `n`: a review, or the tick while it handles the PR. Reviews of different PRs run at the same time |
| `pr/<n>/state.json` | Review and reply counts, settled fingerprints, last reviewed SHA, and the cache (`updatedAt`) used to skip unchanged PRs |
| `pr/<n>/runs/<sha>-<ts>/` | One folder per run: a folder per stage, one output file and `.done` marker per child |
| `questions/<id>.md`, `.json` | Open and answered questions |
| `todo.md` | Points you accepted on your own PRs |
| `tick.json` | Queue of the current tick: PRs done, PRs in progress |
| `paused` | Present while the loop is paused |

Fetches and worktree changes write the clone's `.git`. They take a short
lock in the clone (`.git/pr-review/lock`) and wait up to 60 s for it.

- **A review resumes.** `pr-review review <n>` on a PR with an unfinished run
  for the same head SHA continues it. Only children without a `.done` marker
  start again, so an interrupted run never pays twice. If the head moved, the
  old folder stays for the record and a new run starts. `--restart` forces a
  new run.
- **A tick resumes.** The next tick finishes the old queue before it lists
  new work. Posts are idempotent through the markers on GitHub, so a PR that
  stopped halfway through its post is safe to retry.
- **Pause.** `pr-review-loop pause` writes `paused`; every tick exits at once
  while it exists. `pr-review-loop resume` removes it. In Claude Code a new
  `/loop` session continues from the state on disk.
- **Interrupt.** On SIGINT or SIGTERM the engine stops its children, writes
  no marker for unfinished work, releases the lock and exits.
- **Failures.** A child that exits non-zero, times out, or returns output
  that fails the schema is retried. After the retries the run stops with exit
  `4`. A missing harness binary (ENOENT, or exit `127` from the adapter
  script) fails at once, with no retry. A review with a missing lens is never posted. An empty or crashed
  child, or a round-1 seat that sets `error` (for example because it could
  not read the context), is never read as "no findings": it is a failed
  child.
- **Dropped seats.** A council seat whose child reaches its `max_turns` or
  its timeout, in round 1 or the vote, is not retried. It drops out of that
  stage and every later stage of the run, and `run.json` records it under
  `dropped` (a resumed run keeps it out). The tally runs over the seats
  that remain, and agreed still needs 2 keeps. The summary says "Seat
  `<model>` was dropped (turn limit)." or "(timeout)", and the review never
  approves, in the loop too. When a lens has fewer than 2 seats left, the
  run stops with exit `4`. The judge (merge, compose) cannot drop: its turn
  limit or timeout fails the run.

## Configuration

The engine merges 3 levels; a later level wins:

1. Built-in defaults.
2. User level: `~/.config/pr-review/config.json`, or `--config <file>` for one
   run.
3. Repo level: `.pr-review.json`, read from the base branch.

The file is JSON with `//` comments allowed. Objects merge deep; arrays
(`seats`, `lenses.*.seats`) replace. The repo level may set only
`lenses.*.enabled` (only `false` has an effect), `loop.authors_ignore`, `loop.max_prs_per_run`,
`review.guidance`, `review.core_paths`, `hygiene.enabled`, and additions to
`effort_auto.high_paths`. The loader rejects any other repo key. Seats, judge,
decider and `round1` belong to you.

```jsonc
{
  // Default council. Each seat runs every lens that has no override.
  "seats": [
    { "harness": "claude", "model": "opus",             "thinking": "high",   "max_turns": 40, "timeout_minutes": 15 },
    { "harness": "auto",   "model": "cubbit/mimir",     "thinking": "medium", "max_turns": 40, "timeout_minutes": 15 },
    { "harness": "auto",   "model": "cubbit/mimir-pro", "thinking": "medium", "max_turns": 40, "timeout_minutes": 15 }
  ],
  "round1": "per-seat",
  // Per-lens override: this lens uses only these seats, in its own children.
  // A lens needs 2 or more seats.
  "lenses": {
    "security": { "seats": [
      { "harness": "claude", "model": "opus",             "thinking": "max" },
      { "harness": "pi",     "model": "cubbit/mimir-pro", "thinking": "high" }
    ]},
    "architecture": { "enabled": false }
  },
  "judge": { "harness": "claude", "model": "opus", "thinking": "high" },
  "decider": { "kind": "auto", "confidence": 0 },
  "effort": "medium",
  "loop": {
    "authors_ignore": ["dependabot[bot]", "renovate[bot]"],
    "max_prs_per_run": 10,
    "max_parallel_prs": 3,
    "max_review_rounds": 3,
    "max_replies_per_thread": 2,
    "effort": "auto"
  },
  "review": { "guidance": [], "ci": "use", "max_diff_lines": 6000, "chunk_lines": 500, "max_children": 60, "max_parallel": 9, "max_turns": 40, "timeout_minutes": 10, "depth": "light" },
  "hygiene": { "enabled": true }
}
```

A commented copy is in `shared/pr-review/config.example.json`.

### Seats and models

- A seat is `harness`, `model`, `thinking`, and for pi an optional
  `provider`. The `model` string goes to the harness unchanged, so any model
  the harness accepts works: `opus`, `claude-fable-5-1`, Mimir models
  (`cubbit/*`), or a model behind your own provider.
- `thinking` maps to `claude --effort` (`low`, `medium`, `high`, `xhigh`,
  `max`) and to `pi --thinking` (also `off`, `minimal`). The loader rejects a
  value the harness does not accept.
- `harness: "auto"` picks `claude` when an OpenAI-compatible router (for
  example it-router) answers on its health URL, else `pi`. The router is
  probed once per run; `PR_REVIEW_ROUTER_HEALTH` sets the URL. In Claude Code,
  a session that routes `cubbit/*` through the router runs every seat as
  `claude -p`. pi cannot run Opus or Fable, so those seats always use claude.
- `thinking_by_stage` (`{ "round1": ..., "vote": ..., "merge": ... }`) sets
  the thinking per stage on a seat. A lens may set `round1` only (vote and
  merge children do not belong to one lens). The engine takes the seat's
  value, then the lens's, then the default. The lens value applies only when
  a round 1 child runs that one lens: the run covers only that lens
  (`--lens`), the lens is the only one without its own `seats`, the lens has
  its own `seats`, or the effort is `high` or `max` (round 1 per lens). By default a `cubbit/*` seat (harness `auto` or `pi`) thinks at its
  `thinking` in round 1 and at `off` in vote and merge: in a blind judge of
  13 runs, Mimir at `medium` found about 3 times the real defects of `off` in
  round 1, while thinking in vote and merge only cost time. Claude seats keep
  one level for every stage. The effort cap applies on top, the loader checks
  each level against the harness, and a Mimir seat routed through claude
  gets `low` for `off` (claude has no `off`). Compose and hygiene use
  `thinking`.
- `max_turns` and `timeout_minutes` limit one child. A seat may set its
  own; a lens may set `max_turns` for its children; else `review.max_turns`
  (default 40) and `review.timeout_minutes` (default 10) apply. Only claude
  seats get `--max-turns`: pi has no such flag, so there the timeout is the
  only limit on a long tool loop. A claude seat that reaches its
  `max_turns` fails at once, with no retry. The round 1, vote and merge
  prompts ask each seat to stay within `max_turns` minus 5 tool calls (at
  least 5) and never to repeat a command.
- Use different model families in the council. The point of the vote is
  that one model's blind spots do not decide the result.
- **Per-lens models.** Put the strongest model on the lens where a miss
  costs most. The example gives security its own panel (Opus with
  `thinking: "max"` and a Mimir seat); a comment shows Fable as an option.
- `decider.kind`: `auto` (jev when found), `jev` (always), `off`.
  `decider.confidence` defaults to `0`: the jev benchmark shows confidence
  does not predict correctness (AUC 0.53).

`pr-review doctor` prints the route (`claude` or `pi`) of each seat.

## How to

### Set up a machine

1. Run `npx @marmos91/skills install` (or `./install.sh` in a dev clone).
   It puts `pr-review` and `pr-review-loop` into `~/.claude/skills/` and
   `~/.pi/agent/skills/`, and their CLIs into `~/.local/bin`.
2. Install `gh` and log in. Install `node`. Optional: `gitleaks`, and `jev`
   (installed with this repo).
3. For an unattended loop: run `claude setup-token`, and export a
   fine-grained PAT with pull-request write access on the target repos only
   as `GH_TOKEN`.
4. Copy `config.example.json` to `~/.config/pr-review/config.json` and set
   your seats.
5. Run `pr-review doctor`. Every seat probe must pass.

### Review one PR

```sh
pr-review review 42 --dry-run          # see the plan and the text, post nothing
pr-review review 42                    # post
pr-review review 42 --effort high      # more depth on a risky PR
```

In Claude Code or pi, ask for it: "review PR 42". On exit `3` the skill asks
you the open questions, then runs again.

### Answer questions from the loop

Run `/pr-review-loop answer`, `pr-review-loop answer`, or by hand:

```sh
pr-review answer                       # list as JSON
pr-review answer 42-1a2b3c4d post      # post | drop | ask-author
```

The next tick applies the answers.

### Stop the loop for a while

```sh
pr-review-loop pause
pr-review-loop resume
```

### See what is going on

`pr-review status` shows the questions, the to-do items, the review and reply
counts per PR, the lock holder, unfinished runs (PR, SHA, stage, children done
of total, tokens per stage), the tokens of the last run of each PR, an
interrupted tick queue, and the paused flag.

## Live dry runs

Measured on 2026-11-11 with `--dry-run` (nothing posted), on marmos91/skills.

| PR | Seats | Effort | Children | Run time | Result | Notes |
|---|---|---|---|---|---|---|
| #10 (264 lines) | opus, mimir, mimir-pro (default council) | medium | 8 | 11 min 21 s | COMMENT: 3 must, 2 body questions | Round 1: opus 1 min 31 s, mimir-pro 6 min 44 s, mimir 9 min 21 s. Votes 17–32 s. No seat dropped |
| #10 | opus, mimir and mimir-pro through pi | medium | 8 | 12 min 18 s | COMMENT: 1 must, 2 should, 2 body questions | Round 1 took 74% of the run |
| #11 (3,722 lines) | default | medium | – | – | exit 1 | Above `review.max_diff_lines` (3000); run again with `--max-diff-lines 4000` |

### Mimir thinking level

A blind Opus judge checked every finding from 13 single-seat runs of round 1
on #10 (5 real defects, 1 of them a must):

| mimir thinking | Mean time | Real defects per run | Found the must | False findings |
|---|---|---|---|---|
| medium | 503 s | 1.67 | 2 of 3 | 30% |
| low | 336 s | 0.67 | 0 of 3 | 25% |
| off | 54 s | 0.50 | 0 of 4 | 56% |

So Mimir seats think at their own level in round 1 and at `off` in the vote
and merge stages (`thinking_by_stage`). mimir-pro reasons even at `off`, and
at `medium` one round 1 took 21 minutes; the default council therefore caps
it with `max_turns: 40` and `timeout_minutes: 15`, and a seat that hits a cap
is dropped (the review then never approves).

## pr-respond

The `pr-respond` skill fixes the review findings on your own PR. The agent
edits, tests, commits and pushes; these commands do the GitHub and jev steps.
Each prints JSON. Without `--pr`, they act on the PR of the current branch.

| Command | What it does |
|---|---|
| `pr-respond findings` | Lists the unresolved threads that pr-respond did not handle at their newest comment by someone else (a council thread with only its first comment counts; a thread longer than one page always counts). Rounds and handled threads live in `pr/<n>/respond.json`, apart from `state.json`. A head not seen before counts one round; past `respond.max_rounds` (default 5) with findings left, it exits `5` |
| `pr-respond decide <thread>` | Reads the PR diff of the file and the file at the PR head with `git` (not the working tree). A comment by a person without write or admin access (bots and you aside) gives `ask` at once, unless the thread is approved. Else jev answers "correct on the head?" and "about code this PR adds or changes?": 2 yeses give `fix`, a no or unsure gives `ask` and the agent checks the code. jev never declines: `bench/jev/respond.mjs` replays PR 44's threads |
| `pr-respond approve <thread>` | Records the user's yes for a thread with a comment by a person without write access (by `lib/trust.mjs`, as the loop checks it). Until then `decide` gives `ask` and `fixed` posts nothing |
| `pr-respond decline <thread> "<reason>"` | Replies with the reason; the thread stays open. Skips when our reply is already the newest comment |
| `pr-respond fixed <thread> <sha>` | Refuses a sha that is not in the PR head. jev checks the commit first; only on a yes: `Fixed in <commit link>.`, or the link added to our newest reply (never a second reply), then resolve. On a no or unsure it posts nothing |
| `pr-respond summary <points.json>` | One PR comment that answers the review point by point and opens with the count. Once per head |
