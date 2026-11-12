# marmos91/skills

Personal AI-agent skills, shared across projects and machines. One repo, two
agent targets:

- `pi/` — skills for [pi](https://github.com/badlogic/pi-mono) (`~/.pi/agent/skills/`)
- `claude/` — skills for Claude Code (`~/.claude/skills/`)
- `shared/` — skills whose content works for both agents verbatim (installed to both)

Docs: [docs/README.md](docs/README.md) — install, quick start, how jev and the fix pipeline work.

## Install

```sh
npx @marmos91/skills install [--claude] [--pi] [--link] [skill...]
npx @marmos91/skills list         # installed version per skill
npx @marmos91/skills uninstall
```

For a dev clone, `./install.sh` symlinks the working tree into place
(`./install.sh --rm` removes the links). Both are idempotent. Existing
non-symlink skill dirs are moved aside to `<name>.pre-skills-repo` rather
than deleted.

Releases: release-please reads the conventional commits on `main` and opens a
release PR with the CHANGELOG. Merging it tags `vX.Y.Z`, bumps
`metadata.version` in every `SKILL.md`, and publishes to npm with provenance
(trusted publishing, no token in the repo).

## Layout per skill

Each skill is a directory with `SKILL.md` (frontmatter: name, description)
plus whatever scripts/resources it needs. The agent harness discovers skills
by directory; the description drives automatic routing.
A shared skill's command-line tools go in `<skill>/bin/`; `install.sh` links
each one into `~/.local/bin` (`BIN_DIR`). Add a new CLI to `bin` in
`package.json` too, so npm and the installer ship it. Add a new `SKILL.md` to
`extra-files` in `release-please-config.json` and give it `metadata.version`.

## Skills

| Skill | Agent | Purpose |
|---|---|---|
| repo-audit | both | Multi-lens whole-repo quality audit: cleanliness/design patterns, structure, over-engineering, dead code, tests, docs, UI coherence, security, AI-slop/hallucination, Postgres, API design, correctness. Adversarially-verified findings → epic roadmap → optional GH issues. Portable engine: headless `pi -p` children, resumable |
| repo-audit-fix | both | Executes audit epics: research → architect plan → plan review → implement → 3-lens gate → PR per epic; wave-parallel worktrees, resumable. Uses `jev` (when on PATH) as a second check for findings an approved plan drops |
| refute-root-cause | pi | Adversarial panel that tries to kill a claimed root cause before you fix on it |
| jev | both | Ask Mimir SystemOne (Jev) typed yes/no questions, get calibrated probabilities and clean exit codes (0 yes, 1 no, 2 no answer) — one bash-invokable CLI for pi and Claude Code workflows, installed as `~/.local/bin/jev` |
| pr-review | both | Council review of one GitHub PR: different models review with 5 lenses (adversarial, correctness, simplification, architecture, security), vote on each other's findings, and post only what they agree on; jev or you settle the splits. Models per seat and per lens, effort levels, resumable. See [docs/pr-review.md](docs/pr-review.md) |
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

## Changelog

The CHANGELOG comes from the PR titles (squash merge). Write each title as a
conventional commit for a user to read, with the skill as the scope:
`fix(pr-review): keep the lock when a pid is reused`. `feat` and `fix` show
in the changelog; `chore`, `test`, `ci` and `refactor` do not. Mark a breaking
change with `!` (`feat(jev)!: …`). All skills share one version.

## License

MIT. See [LICENSE](LICENSE).
