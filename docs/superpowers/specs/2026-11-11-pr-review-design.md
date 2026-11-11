# pr-review and pr-review-loop: design

Date: 2026-11-11. Status: draft for approval. Revision 2: this revision adds
the results of a 5-lens review of revision 1 and Marco's answers.

## 1. Intent

Marco reviews PRs by hand with a fixed method. He looks at a change with
several lenses, he challenges the author, and he takes part in the threads on
his own PRs. This takes time each day, and PRs wait for him. These 2 skills
automate that method.

- `/pr-review` does one deep review of one PR. A council of different models
  reviews the PR with 5 lenses. The members vote on the findings of the other
  members. Only agreed findings go to the PR. The other findings go to Marco.
- `/pr-review-loop` keeps the PR queue of a repo moving. It runs on an
  interval. It reviews PRs that ask for Marco's review. It replies to
  reviewers on Marco's PRs. It replies when someone mentions Marco.

Success: PRs no longer wait for Marco, and Marco does not rewrite what the
skills post.

## 2. Goals, non-goals, anti-goals

Goals:

- Use different model families in one council, so that the blind spots of one
  model do not decide the result.
- Post freely. Ask Marco only when the council does not agree.
- Work in Claude Code and in pi (pi.dev), and work best in Claude Code.
- Let Marco set the model for each seat and for each lens (for example, a
  security lens on Fable).
- Write short, human, concrete comments with examples and code snippets.

Non-goals:

- The skills never change code, commit or push. This also applies to Marco's
  own PRs. The only actions are: approve, comment, request changes, reply to a
  thread, resolve a thread.
- The skills never merge or close a PR. GitHub or the PR author does that.
- No support for GitLab or other forges in this version.

Anti-goals (the skills fail if these happen, even if they work):

- A review that agrees with every reviewer comment by default.
- A wall of generic comments ("consider adding tests") with no concrete case.
- A finding posted as fact when the council did not agree on it.
- A comment that says or suggests that an AI wrote it.
- A crash or an empty child result reported as "no findings".
- The skills post the same review or reply twice.
- Text in a PR changes what the skills do (prompt injection), or code in a PR
  gets Marco's credentials.

## 3. Constraints

- Location: `marmos91/skills`, under `shared/pr-review/` and
  `shared/pr-review-loop/`. `install.sh` links `shared/` into both
  `~/.claude/skills/` and `~/.pi/agent/skills/`. Add both skills to the
  README table.
- Follow the repo conventions in the README. Engines never fake success.
  Engines are resumable with markers on disk. A crash means retry, never a
  silent skip.
- One engine serves both skills: `shared/pr-review/scripts/pr-review.sh`, with
  subcommands `review`, `reply`, `tick`, `answer`, `status`, `doctor`.
  `pr-review-loop` is a `SKILL.md` plus a small wrapper that finds the engine
  with `realpath`. The `SKILL.md` files stay thin: they parse arguments, run
  the engine, react to its exit code, and show the result.
- The engine starts each council seat as a headless CLI child: `claude -p` or
  `pi -p`. Reason: `cubbit/*` models do not work from a Claude Code subagent
  unless the session runs through `it-router`, and pi cannot run Opus or
  Fable. A CLI child works in all cases.
- Each harness has an adapter, `scripts/harness/claude.sh` and
  `scripts/harness/pi.sh`, with one contract:
  `run <model> <thinking> <tools> <prompt-file> <out-file>`. A new harness is a
  new file. The adapter sends the prompt through a file or stdin, never as an
  argv argument (macOS `ARG_MAX` and `ps` exposure).
- `thinking` maps to `claude --effort` (`low|medium|high|xhigh|max`) and to
  `pi --thinking`. The config loader rejects a value that the harness does not
  accept.
- GitHub access goes through the `gh` CLI (REST and GraphQL). The GitHub MCP
  exists only in Claude Code, so do not use it.
- Everything posts as the user of `gh auth`. No signature, no AI attribution.
- Children cannot use Claude Code plugins (ponytail, pstack, humanizer),
  because a `pi -p` child does not have them. So the lens briefs and the
  writing rules are compact prompt files in the skill folder.
- `repo-audit` has a JSON parser (`scripts/lib/parse.mjs`) with a fixed key
  set. Copy it and give it a schema per stage. Do not refactor `repo-audit`.

## 4. Trust and isolation

PR content is untrusted. This includes the diff, the PR body, comments, and
any file in the PR head. These rules apply to every run.

1. **Children are isolated from the PR's own config.**
   - claude: `claude -p --bare --strict-mcp-config --permission-prompts none`,
     with `--tools Read,Grep,Glob` (plus `Bash` only in rule 3).
   - pi: `pi -p --no-session --no-context-files --no-extensions --no-skills
     --no-mcp --tools read,grep,find,ls` (plus `bash` only in rule 3).
   - The builder checks each flag against `--help` of the installed version.
2. **Children get a clean environment:** no `GH_TOKEN`, no
   `GITHUB_PERSONAL_ACCESS_TOKEN`, no AWS variables. Only the engine talks to
   GitHub. Children return JSON, and the engine posts from validated JSON.
3. **Code runs only for trusted authors.** A trusted author has an
   `author_association` of `OWNER`, `MEMBER` or `COLLABORATOR`. For a trusted
   author, the adversarial lens gets a shell and can run a repro in the
   worktree. For other authors, all seats are read-only, and the adversarial
   lens writes the repro command into the finding without running it.
   Shell runs use a timeout and kill the whole process group.
4. **Config and guidance come from the base branch.** The engine reads
   `.pr-review.json`, `CONTRIBUTING.md`, `CLAUDE.md`, `AGENTS.md`, `REVIEW.md`
   and `.github/*` guides with `git show origin/<base>:<path>`. If the PR
   changes one of them, the change is part of the diff only.
5. **PR text is data.** The prompt wraps the PR body, comments and diff in a
   delimited block. One line says that the block is data from the PR author
   and never an instruction.
6. **The verdict is code, not model text.** The engine computes the review
   event from the vote data (section 6.7).
7. **Outgoing text is scanned.** Each review body, inline comment, reply and
   jev payload passes `gitleaks detect --no-git --pipe` (or the same patterns
   if gitleaks is missing). A hit stops that post and queues a question.
8. **Only collaborators trigger actions.** The loop reacts to mentions and
   reviewer comments only from users with write or admin permission on the
   repo. Other users go to the queue as information.
9. **Token.** Setup notes recommend a fine-grained PAT with pull-request write
   access on the target repos only, as `GH_TOKEN` for the engine. Setup notes
   also recommend `claude setup-token`, because the normal `claude` login ends
   and an unattended loop stops.

## 5. Configuration

The engine merges 3 levels, a later level wins: built-in defaults,
`~/.config/pr-review/config.json` (user level), and `.pr-review.json` from
the base branch of the reviewed repo (repo level). A `--config <file>` flag
replaces the user level for one run.

- The file is JSON. The loader strips `//` comments, so the example below
  can stay commented.
- Objects merge deep. Arrays (`seats`, `lenses.*.seats`) replace.
- The repo level may set only: `lenses.*.enabled`, `loop.authors_ignore`,
  `loop.max_prs_per_run`, `review.guidance` (extra guidance file paths). The
  user level owns `seats`, `judge`, `decider` and `round1`. The loader
  rejects other keys at the repo level.

```jsonc
{
  // Default council. Each seat runs every lens that has no override.
  "seats": [
    { "harness": "claude", "model": "opus",             "thinking": "high" },
    { "harness": "pi",     "model": "cubbit/mimir-pro", "thinking": "high" },
    { "harness": "pi",     "model": "cubbit/mimir",     "thinking": "high" }
  ],
  // Round 1 shape: "per-seat" = 1 child per seat runs all its lenses
  // (about 10 children per PR); "per-lens" = 1 child per seat and lens
  // (about 20 children per PR, more depth).
  "round1": "per-seat",
  // Per-lens override. A lens with "seats" uses only those seats, in its own
  // child. A lens needs 2 or more seats.
  "lenses": {
    "security": { "seats": [
      { "harness": "claude", "model": "claude-fable-5-1", "thinking": "max" },
      { "harness": "pi",     "model": "cubbit/mimir-pro", "thinking": "high" }
    ]}
  },
  // Clusters findings and writes the final review text.
  "judge": { "harness": "claude", "model": "opus", "thinking": "high" },
  // Settles split votes. "auto" = use jev when the jev CLI is on PATH.
  "decider": { "kind": "auto", "confidence": 0.8 },
  "loop": {
    "authors_ignore": ["dependabot[bot]", "renovate[bot]"],
    "max_prs_per_run": 10
  }
}
```

- The `model` string goes to the harness with no change. So any model that
  the harness accepts works.
- A seat can set `provider` for pi. If it is not set, pi uses its default.
- `pr-review.sh doctor` prints the merged config, sends a 1-token probe to
  each distinct seat, checks `gh auth status` and `jev`, and prints the
  planned child count per PR.

## 6. `/pr-review` pipeline

Input: a PR number or URL. With no input, the PR of the current branch.
Flags: `--dry-run` (write the review to a file, post nothing, print the
planned child count and models first), `--lens a,b` (run only some lenses),
`--until <stage>` (stop after a stage).

```
 frame ─▶ round 1 ─▶ merge ─▶ round 2 ─▶ tally ─┬─ agreed ───────────────────▶ compose ─▶ post
 (base    (seats ×   (judge:   (1 vote      (code) ├─ split ─▶ jev ─┬─ confident ─▶ compose
 config,   lenses)    cluster)  child per          │                └─ unsure ─▶ question
 diff,                          seat)              └─ rejected ─▶ dropped (kept in run state)
 threads)
```

### 6.1 Frame

The engine writes one context folder. All seats read the same folder.

- PR metadata, the diff, the commits, and the head SHA (pinned for the run).
- The issue or plan that the PR implements: closing issues (GraphQL
  `closingIssuesReferences`), issues named in the PR body, and plan or spec
  files that the PR body or the branch name refers to. If none exists, the
  correctness lens says "no tracking issue or plan" in the summary and checks
  the PR against its own description.
- Review guidance from the base branch (section 4, rule 4).
- All earlier reviews, threads (open and resolved) and comments.
- Marco's own earlier findings on this PR that are still open, with their
  thread IDs, for the delta check (section 6.9).
- A git worktree at the pinned head SHA. Seats read files there (callers,
  tests). The full files are not copied into the prompt.

The engine stops with a clear error when the diff is above a size cap. The
builder sets the cap. There is no diff splitter in v1.

### 6.2 Round 1: independent review

Each seat reviews with no view of the other seats. The `round1` key sets the
shape: 1 child per seat for all its lenses (default), or 1 child per seat and
lens. A lens with a model override always runs in its own children. Each
finding has this shape:

```json
{ "lens": "security", "severity": "must|should|nit", "file": "src/a.ts",
  "line": 42, "title": "...", "case": "input or situation -> wrong result",
  "evidence": "trace through the code, or a command and its output",
  "fix": "smallest fix, with a snippet" }
```

Rule for all lenses (from `ponytail-review`): no concrete case, no finding.
No style taste, no "consider".

### 6.3 The 5 lenses

Each lens is one prompt file in `shared/pr-review/lenses/`. Each file is a
compact rewrite of the rules of its sources, not a copy of their prose. A
user can add a lens in `~/.config/pr-review/lenses/<name>.md`.

| Lens | What it looks for | Sources |
|---|---|---|
| adversarial | Break the change. Edge cases, wrong assumptions of the author, inputs the author did not expect. Each finding needs a repro: run (trusted author) or traced and written down (other authors). Suggest an alternative when the approach itself is weak. | pstack `interrogate`, pstack `principle-attack-the-premise` |
| correctness | Bugs, logic errors, broken callers, missing tests for risky code, language and framework practice. Does the PR do what its issue or plan says, all of it and nothing else? | `ponytail-review` (bug, risk, missing test), superpowers `requesting-code-review` (plan alignment), Claude Code `/code-review` |
| simplification | Code that should not exist or should be smaller: dead code, a helper that already exists, a stdlib feature, an abstraction with one use, near-copies. | `ponytail-review` (lean), pstack `principle-subtract-before-you-add`, `principle-minimize-reader-load` |
| architecture | Module boundaries, coupling, data flow, fit with the existing patterns, scale. DX of the API and UX of the user-facing behavior. | `feature-dev:code-architect`, pstack `architect`, pstack `principle-boundary-discipline`, `principle-experience-first` |
| security | Input validation at trust boundaries, authn and authz, secrets, injection, data exposure, unsafe defaults, dependency risk. | Claude Code `/security-review`, `security-guidance` plugin, `ponytail-review` (risk) |

### 6.4 Merge

The judge clusters findings that share a root cause. A cluster never crosses
lenses. The judge keeps the best evidence and fix, and it records which seats
found it. The engine (code, not the judge) links each cluster to an existing
thread by file, line and text. A finding that repeats a thread is dropped
only if that thread is resolved or a reviewer gave evidence against it. An
author's "won't fix" alone does not drop it.

### 6.5 Round 2: vote

Each seat runs 1 vote child. It gets the merged findings of the lenses that
it ran in round 1, and it votes `keep` or `drop` on each, with a reason. A
`drop` needs a counter-case. The seat that found a finding does not vote on
it.

### 6.6 Tally

`scripts/lib/tally.mjs` is a pure function with unit tests (`node --test`).
For each finding:

- A `drop` with no counter-case counts as an abstain.
- **agreed**: 2 or more keep votes from seats other than the finder, and no
  drop with a counter-case. For a lens with 2 seats: the other seat keeps.
- **split**: votes disagree with a counter-case on each side; or a keep with
  run evidence stands against a majority drop.
- **rejected**: the other cases with a majority drop.

### 6.7 Decider (jev) and questions

Only split findings reach this step.

1. The engine finds jev at `../jev/jev` next to its own skill folder
   (`shared/jev` in the same repo), or else on PATH. If it finds jev and
   `decider.kind` is not `off`, the engine runs:
   `jev ask "This finding describes a real defect that this PR introduces." -t <finding, votes, code hunk> --json`.
   A result with confidence at or above `decider.confidence` settles the
   finding: yes = agreed, no = rejected. The run state records the jev result,
   and the review summary does not mention it.
2. Otherwise the finding becomes a question. Each question has a readable
   `.md` file and a `.json` sidecar with: the code snippet, the finding, the
   best argument of each side, a concrete failure example, and the options
   (`post`, `drop`, `ask-author`).
   - Interactive `/pr-review`: the engine exits with code 3 after this
     stage. `SKILL.md` asks the questions (Claude Code: `AskUserQuestion`,
     4 per call; pi: the `ask_user` tool). It records each answer with
     `pr-review.sh answer <id> <option>`, then runs the engine again. The
     run continues from the marker.
   - From the loop: the engine queues the question and posts the review
     without that finding.

### 6.8 Compose and verdict

The judge writes the review from the agreed findings, with the rules in
`shared/pr-review/writing.md`. That file is a compact copy of the
`humanizer` rules, so the text reads the same in both harnesses.

- Follow the review guidance of the repo, if it has one (format, tone,
  labels such as `nit:` or Conventional Comments).
- Inline comments: one finding per comment. Layout: severity label, the case
  in one line, then a code snippet or a GitHub `suggestion` block.
- Summary body: what the PR does in 2 sentences, then the `must` items. When
  something is held for Marco: "1 point is still open with the reviewer."
- A finding from a single seat, or one that the author must clarify, is
  phrased as a question to the author.

The engine computes the event:

| Condition | Event |
|---|---|
| 1 or more agreed `must`, or an earlier `must` of Marco still open | `REQUEST_CHANGES` |
| an open question, a split, a failed lens, or only `should`/`nit` | `COMMENT` |
| no findings, no open question, no earlier `must` open | `APPROVE` |

Limits on `APPROVE`:

- In the loop, `APPROVE` is allowed only for a trusted author (section 4,
  rule 3) and when every seat agreed on zero findings. Otherwise the loop
  posts `COMMENT` and queues "approve?" for Marco.
- On Marco's own PRs the event is always `COMMENT` (GitHub rule).

### 6.9 Delta review

When Marco already reviewed the PR:

- If the last reviewed SHA is an ancestor of the head
  (`git merge-base --is-ancestor`), the council reviews only the new
  commits. It also checks each of Marco's open earlier findings against the
  new head: fixed or still open.
- If it is not an ancestor (force-push or rebase), the engine runs a full
  review.
- For each earlier finding that is now fixed, the engine replies "Fixed in
  `<sha>`." and resolves the thread.

### 6.10 Post

1. Take the lock of the repo (section 8).
2. Check the head again. If it moved since the frame, drop the run and frame
   again.
3. Check each inline comment against the diff hunks of the pinned SHA. A
   suggestion goes only on a RIGHT-side added or context line. A finding
   outside the hunks moves into the summary body with a permalink.
4. Check that Marco has no pending review on the PR. If one exists and the
   run state does not own it, skip the PR and queue a note.
5. Post with 1 mutation (`addPullRequestReview` with `commitOID`, `threads`
   and `event`), so that nothing stays pending.
6. Each posted body carries a hidden marker:
   `<!-- pr-review run=<id> sha=<sha> key=<finding-hash> -->`. Before each
   post, the engine searches Marco's recent comments for the marker. A hit
   means the post already happened.
7. Reply and resolve: see the thread rules in section 7.3.

## 7. `/pr-review-loop`

Input: `owner/repo`. With no input, the repo of the current directory.

- Claude Code: `/loop 30m /pr-review-loop [owner/repo]`.
- pi and any other place: `pr-review.sh tick` is 1 run. A cron or launchd
  entry, or `while :; do pr-review.sh tick; sleep 1800; done`, repeats it.
  There is no scheduler of its own.

### 7.1 One run (`tick`)

1. Take the lock. If another run holds it, exit.
2. Print the open questions and the to-do items. Apply the answers that Marco
   gave since the last run. Do not ask during a run.
3. List open PRs where Marco is the author, a requested reviewer (Marco or one
   of his teams), a past reviewer (`reviewed-by:@me`), or mentioned. Skip draft
   PRs and authors in `authors_ignore`.
4. Skip a PR when nothing changed since the last run. The engine reads this
   from GitHub (head SHA, newest comment) and compares it with a small cache.
5. Process at most `max_prs_per_run` PRs, oldest activity first.
6. First run: the engine sets a baseline time. It reacts only to activity
   after the baseline, plus review requests that are still open.

### 7.2 Actions

**Marco's PR, with new review comments.** The engine runs `reply` for each
new thread or comment:

- One seat drafts a position on the comment: accept, push back, or ask. It
  uses the rules of superpowers `receiving-code-review`. It accepts only when
  the code shows that the reviewer is right. It pushes back with a reason and
  an example when the reviewer is wrong or the cost is higher than the value.
- A second seat from a different family challenges the draft.
- If the 2 seats disagree, the engine asks jev
  (`jev ask "The reviewer's comment is correct about this code."`). If jev is
  unsure or missing, the engine queues a question and does not reply yet.
- The judge writes the reply with `writing.md`.

**PR that requests Marco's review, or that Marco reviewed before.** Run
`review` (section 6), which does a delta review when possible.

**Mention of Marco by a collaborator.** Reply in the same thread with the
`reply` flow. Run `review` only if the mention asks for a review.

### 7.3 Thread rules

- Ignore comments by Marco's own login and by bots (`user.type == "Bot"` or
  `authors_ignore`). Reply at most once per new human comment.
- Resolve a thread only when `viewerCanResolve` is true and the thread is
  closed:
  - a pushback that the reviewer has not answered is not closed;
  - an earlier finding that the new head fixes is closed;
  - an accepted point on Marco's PR stays open until the fix is in the head.
- Never resolve again a thread that a human reopened.
- On Marco's PRs, an accepted point gets a short reply ("Agreed, I will
  change this.") and goes into `todo.md` in the state folder. The loop prints
  `todo.md` at the start of each run.

### 7.4 Question queue

- Location: `${XDG_STATE_HOME:-~/.local/state}/pr-review/<owner>__<repo>/questions/`.
- Marco answers with `/pr-review-loop answer` (the skill asks the open
  questions, 4 per call) or with `pr-review.sh answer <id> <option>`.
- The next run applies each answer. It checks the finding against the
  current head first. If the code moved, it drops the finding with a note.

## 8. State, lock and resume

- State root: `${XDG_STATE_HOME:-~/.local/state}/pr-review/<owner>__<repo>/`.
- `lock/`: made with `mkdir`, holds the PID. A lock with a dead PID is stale
  and is removed. `/pr-review` and the loop use the same lock.
- Per PR: `pr/<n>/cache.json` (head SHA and newest comment ID, used only to
  skip unchanged PRs) and `pr/<n>/runs/<sha>-<ts>/` with a folder per stage
  and a `.done` marker per stage. GitHub is the source of truth for what was
  posted (section 6.10, step 6).
- A rerun continues from the first stage without a marker.
- A child that exits non-zero, times out, or returns output that fails the
  stage schema is a failed stage. The engine retries it. After the retry
  limit it stops that PR and reports the failure. It never posts a review
  with a missing lens.

## 9. Tests

- `tally.mjs`, the config loader and the diff-hunk check have unit tests
  (`node --test`).
- `PR_REVIEW_FAKE=<dir>`: the harness adapters replay recorded child outputs,
  and `GH_BIN` points to a stub that serves recorded JSON and logs each
  mutation. A full run then needs no model and no real PR.
- Before release: run `--dry-run` on 3 real PRs and compare `round1:
  per-seat` with `per-lens`.

## 10. Left to the builder

- The engine language (bash plus Node `.mjs`, like `repo-audit`, is the
  default) and the file layout inside each skill folder.
- Parallel limits, timeouts, retry counts and the diff size cap.
- The exact wording of the lens prompts and `writing.md`, within section 6.3.
- The GraphQL queries.

## 11. Calls made by Claude (not decided by Marco)

- Per-lens vote with no vote from the finder; tally rules in section 6.6.
- Lens briefs and writing rules bundled as prompt files, not loaded from
  installed skills.
- `gh` CLI instead of the GitHub MCP; one engine for both skills.
- JSON config with user and repo levels; the repo level is limited to an
  allowlist of keys and is read from the base branch.
- Verdict table in section 6.8; an open earlier `must` blocks `APPROVE`.
- The `reply` flow with 2 seats and jev, instead of the full council.
- Accepted points stay open and go to `todo.md`.
- The loop never asks during a run; answers come through `answer`.
- First run reacts only to new activity and open review requests.
- Draft PRs, bot authors and bot comments are skipped.
- jev settles split findings only with confidence at or above 0.8.

## 12. Decided by Marco

- Post freely; ask only when the council does not agree.
- Cross-harness: Claude Code and pi.
- Models configurable per seat and per lens.
- Disagreements in the loop go to a queue; the loop does not block.
- The loop only approves, comments, requests changes, replies and resolves.
  It never changes code and never merges.
- The loop approves only trusted authors with zero agreed findings.
- Code runs (repro) only for trusted authors.
- Round 1 shape is configurable, default 1 child per seat.
- jev (`jev ask`) is the decider when available.
