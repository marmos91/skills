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
| repo-audit | both | Multi-lens, multi-agent repo quality audit → adversarially-verified findings → epics → GH issues; resumable. Portable engine: headless `pi -p` children, works under any harness with `pi` installed |
| repo-audit-fix | both | Executes audit epics: research → architect plan → plan review → implement → 3-lens gate → PR per epic; wave-parallel worktrees, resumable |
| refute-root-cause | pi | Adversarial panel that tries to kill a claimed root cause before you fix on it |

(graphify and humanizer were removed from this repo — they exist upstream:
`graphify install --platform pi|claude` from [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify),
and [/plugin install humanizer@humanizer](https://github.com/blader/humanizer) for Claude Code.)

## Conventions

- Skill engines never fake success: a dead/empty child is a failed gate, never "no findings".
- Resumable by on-disk markers; crash = retry, never silent skip.
- Project-specific tuning lives in env vars (REPO_CTX, model routes, paths) — engines default generically.
