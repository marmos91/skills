# marmos91/skills

Personal AI-agent skills, shared across projects and machines. One repo, two
agent targets:

- `pi/` — skills for [pi](https://github.com/badlogic/pi-mono) (`~/.pi/agent/skills/`)
- `claude/` — skills for Claude Code (`~/.claude/skills/`)
- `shared/` — skills whose content works for both agents verbatim (installed to both)

Docs: [docs/README.md](docs/README.md) — install, quick start, how jev and the fix pipeline work.

## Install

```sh
git clone git@github.com:marmos91/skills.git
cd skills && ./install.sh          # symlinks everything into place
./install.sh --rm                   # remove this repo's symlinks
```

`install.sh` is idempotent — re-run after pulling. Existing non-symlink skill
dirs are moved aside to `<name>.pre-skills-repo` rather than deleted.

## Layout per skill

Each skill is a directory with `SKILL.md` (frontmatter: name, description)
plus whatever scripts/resources it needs. The agent harness discovers skills
by directory; the description drives automatic routing.
A shared skill's command-line tools go in `<skill>/bin/`; `install.sh` links
each one into `~/.local/bin` (`BIN_DIR`).

## Skills

| Skill | Agent | Purpose |
|---|---|---|
| repo-audit | both | Multi-lens whole-repo quality audit: cleanliness/design patterns, structure, over-engineering, dead code, tests, docs, UI coherence, security, AI-slop/hallucination, Postgres, API design, correctness. Adversarially-verified findings → epic roadmap → optional GH issues. Portable engine: headless `pi -p` children, resumable |
| repo-audit-fix | both | Executes audit epics: research → architect plan → plan review → implement → 3-lens gate → PR per epic; wave-parallel worktrees, resumable. Uses `jev` (when on PATH) as a second check for findings an approved plan drops |
| refute-root-cause | pi | Adversarial panel that tries to kill a claimed root cause before you fix on it |
| jev | both | Ask Mimir SystemOne (Jev) typed yes/no questions, get calibrated probabilities and clean exit codes (0 yes, 1 no, 2 no answer) — one bash-invokable CLI for pi and Claude Code workflows, installed as `~/.local/bin/jev` |
| pr-review | both | Council review of one GitHub PR: different models review with 5 lenses (adversarial, correctness, simplification, architecture, security), vote on each other's findings, and post only what they agree on; jev or you settle the splits. Models per seat and per lens, effort levels, resumable. See [docs/pr-review.md](docs/pr-review.md) |
| pr-respond | both | Works through the review findings on your own PR until a round adds nothing new: jev decides fix, decline or ask; the agent fixes with a test and pushes; `Fixed in <commit>` replies, resolved only when jev confirms the fix; a point-by-point answer comment; capped rounds (council or Copilot) |
| pr-review-loop | both | Runs `pr-review` and thread replies for one repo on an interval (`/loop 30m`, cron or launchd); queues disagreements as questions, never blocks, never changes code or merges; pause and resume |

(graphify and humanizer were removed from this repo — they exist upstream:
`graphify install --platform pi|claude` from [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify),
and [/plugin install humanizer@humanizer](https://github.com/blader/humanizer) for Claude Code.)

`shared/` engines are harness-agnostic: they drive headless `pi -p` children, so they
run under pi, Claude Code, or any agent with the `pi` CLI available.

`bench/` holds benchmarks and their data (for example `bench/jev/`). `install.sh` does not install it.

## Conventions

- Skill engines never fake success: a dead/empty child is a failed gate, never "no findings".
- `jev` only adds signal: engines act on jev's yes/no and keep their old behaviour when jev is missing, down (exit 2) or unsure. `JEV=off` disables it; `JEV_CONFIDENCE` (default 0, no gate; see `bench/jev/RESULTS.md`) sets a confidence bar. jev never relaxes a gate: it can only add a finding or a revise round.
- Resumable by on-disk markers; crash = retry, never silent skip.
- Project-specific tuning lives in env vars (REPO_CTX, model routes, paths) — engines default generically.
