---
name: pr-review
description: "Deep review of one GitHub PR by a council of different models (Opus, Mimir, any model you set per seat or per lens). Five lenses: adversarial, correctness, simplification, architecture, security. Seats vote on each other's findings; only agreed findings are posted, split ones are settled by jev or asked to you. Works in Claude Code and pi. Resumable. Use on 'review PR 42', 'review this PR', 'pr-review', 'council review'."
---

# pr-review: council review of one PR

The engine does all the work. This file only runs it, asks your questions,
and shows the result. `$SKILL_DIR` is the folder of this file. Full guide:
`docs/pr-review.md` in the skills repo.

## Run

```sh
sh "$SKILL_DIR/scripts/pr-review" review <n> [--repo owner/repo] \
  [--effort low|medium|high|max|auto] [--lens a,b] [--max-diff-lines N] \
  [--dry-run] [--until <stage>] [--restart]
```

- `<n>` is the PR number or URL. Without `--repo`, the engine uses the repo
  of the current directory.
- `--effort auto` picks the level from the changed paths.
- `--lens a,b` runs only these lenses. The review then never approves.
- `--max-diff-lines N` reviews a diff above `review.max_diff_lines` (exit
  `1` says when a diff is too large). A diff above `review.chunk_lines`
  splits into parts by folder, and round 1 reviews each part.
- `--dry-run` posts nothing. It prints the planned children and models, and
  writes the review to a file in the run folder.
- `--until <stage>` stops after `frame`, `round1`, `merge`, `round2`,
  `tally`, `decide`, `compose` or `post`.
- `--restart` starts a new run. Without it, a run for the same head SHA
  continues from the last finished child.
- The run can take many minutes. Run it in the foreground and wait. Do not
  start a second run on the same PR: the lock stops it. Runs on other PRs
  can go at the same time.

## Exit codes

| Exit | Meaning | What to do |
|---|---|---|
| `0` | Done | Show the review URL and the summary that the engine prints |
| `3` | Questions are open | Ask them (next section), then run the same command again |
| `4` | A stage or a GitHub call failed after retries | Show the error. Check the PR before running again; part of the review may be posted. A rerun does not post the same item twice |
| `1` | Usage or setup error, or the diff is too large | Show the error. Suggest `pr-review doctor`, or `--max-diff-lines N` for a large diff |

Exit `3` happens only in an interactive run. The loop never stops for
questions.

## Questions (exit 3)

1. Run `sh "$SKILL_DIR/scripts/pr-review" answer`. It prints the open
   questions as JSON. Each one has an `id`, the finding, the best argument to
   keep and to drop it, and the options `post`, `drop`, `ask-author`.
2. Ask the user. Show the file and line, the finding in one line, and both
   arguments. Do not add your own opinion.
   - Claude Code: `AskUserQuestion`, at most 4 questions per call.
   - pi: the `ask_user` tool.
3. For each answer, run
   `sh "$SKILL_DIR/scripts/pr-review" answer <id> <post|drop|ask-author>`.
4. Run the same `review` command again. It continues from the marker and
   does not start the finished children again.

`ask-author` posts the finding as a question to the PR author.

## Show the result

- On exit `0`: the review URL, the event (`APPROVE`, `COMMENT` or
  `REQUEST_CHANGES`), and the counts the engine prints. Do not rewrite the
  review text.
- On `--dry-run`: the path of the review file and the planned child count.

## Other commands

- `pr-review status [owner/repo]`: open questions, to-do items, unfinished
  runs and the lock holder.
- `pr-review doctor`: merged config, a probe of each seat, `gh` login, jev,
  gitleaks, and the planned child count per effort level. Run it first on a new
  machine.

## Rules

- Never post, approve or comment on the PR yourself. The engine posts.
- Never edit files in the PR or in the state folder.
- Config: `~/.config/pr-review/config.json` (see `config.example.json`).
