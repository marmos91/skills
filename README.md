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
| repo-audit | pi | Multi-lens, multi-agent repo quality audit → findings → epics → GH issues; resumable, adversarially verified |
| repo-audit-fix | pi | Executes audit epics: research → architect plan → plan review → implement → 3-lens gate → PR per epic; wave-parallel worktrees, resumable |
| graphify | pi | Codebase → knowledge graph; query/path/explain |
| audit-ai-codebases / auditing-ai-codebases | pi / claude | Deep multi-pass audit of AI-written repos (tracker: report.md + findings) |
| refute-root-cause | pi | Adversarial panel that tries to kill a claimed root cause before you fix on it |
| fixing-audit-findings | claude | Workflow-based remediation of an audit report |
| humanizer | claude | Detect/rewrite AI tells in prose |

(repo-audit + repo-audit-fix supersede audit-ai-codebases/fixing-audit-findings
on pi, but the older pair is kept for Claude until the engines are ported.)

## Conventions

- Skill engines never fake success: a dead/empty child is a failed gate, never "no findings".
- Resumable by on-disk markers; crash = retry, never silent skip.
- Project-specific tuning lives in env vars (REPO_CTX, model routes, paths) — engines default generically.
