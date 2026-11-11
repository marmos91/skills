# marmos91/skills

Personal AI-agent skills, shared across projects and machines. One repo, two
agent targets:

- `pi/` — skills for [pi](https://github.com/badlogic/pi-mono) (`~/.pi/agent/skills/`)
- `claude/` — skills for Claude Code (`~/.claude/skills/`)
- `shared/` — skills whose content works for both agents verbatim (installed to both)

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

## Skills

| Skill | Agent | Purpose |
|---|---|---|
| repo-audit | both | Multi-lens whole-repo quality audit: cleanliness/design patterns, structure, over-engineering, dead code, tests, docs, UI coherence, security, AI-slop/hallucination, Postgres, API design, correctness. Adversarially-verified findings → epic roadmap → optional GH issues. Portable engine: headless `pi -p` children, resumable |
| repo-audit-fix | both | Executes audit epics: research → architect plan → plan review → implement → 3-lens gate → PR per epic; wave-parallel worktrees, resumable. Uses `jev` (when on PATH) as a second check for findings a plan drops and for untagged gate findings |
| refute-root-cause | pi | Adversarial panel that tries to kill a claimed root cause before you fix on it |
| jev | both | Ask Mimir SystemOne (Jev) typed yes/no questions, get calibrated probabilities and clean exit codes (0 yes, 1 no, 2 no answer) — one bash-invokable CLI for pi and Claude Code workflows; `install.sh` links it into `~/.local/bin` |

(graphify and humanizer were removed from this repo — they exist upstream:
`graphify install --platform pi|claude` from [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify),
and [/plugin install humanizer@humanizer](https://github.com/blader/humanizer) for Claude Code.)

`shared/` engines are harness-agnostic: they drive headless `pi -p` children, so they
run under pi, Claude Code, or any agent with the `pi` CLI available.

## Conventions

- Skill engines never fake success: a dead/empty child is a failed gate, never "no findings".
- `jev` only adds signal: engines act on a confident yes/no and keep their old behaviour when jev is missing, down (exit 2) or unsure. `JEV=off` disables it; `JEV_CONFIDENCE` (default 0.8) sets the bar.
- Resumable by on-disk markers; crash = retry, never silent skip.
- Project-specific tuning lives in env vars (REPO_CTX, model routes, paths) — engines default generically.
