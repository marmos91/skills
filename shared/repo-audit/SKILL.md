---
name: repo-audit
description: Whole-repo quality audit — cleanliness/design patterns, structure & folders, over-engineering (ponytail), dead code, duplication, useless tests, docs, UI coherence, security, AI-slop/hallucination, Postgres entities & queries. Produces a severity-ranked audit report plus an epic roadmap (optionally GH issues). Multi-agent over headless read-only `pi -p` children; fully resumable. Use on "audit this repo", "full codebase review", "build an improvement roadmap".
---

# Repo Audit (resumable multi-lens)

Runs the multi-lens AI-audit *method* (recon → rotate lens per area → adversarial verify → roadmap)
through a portable engine: plain headless `pi -p` read-only children (`read,grep,find,ls`),
driven by the state machine in `scripts/audit.sh`. Works under any harness with `pi` installed
(pi, Claude Code, ...). Do NOT drive it through pi-subagents workflows — that path is broken
here (see AGENTS.md "Review gate").

## Lens catalog (one per concern; add/trim via `AUDIT_LENSES`)

| lens | hunts |
|------|-------|
| `simplify` | ponytail: over-engineering, dead code, unnecessary abstraction/indirection, duplication, unused exports |
| `structure` | design patterns & idioms, folder layout, file size, naming, layering, module boundaries |
| `tests` | always-green/vacuous tests, useless tests, coverage gaps on risky logic, test placement & cost |
| `docs` | README, docs site, in-app docs accuracy and stale copy |
| `ui` | design coherence across the website, look & feel, industry best practices, component drift, mobile/desktop responsiveness & cross-browser fit |
| `sql` | Postgres entities, relations, constraints, index-vs-query fit, repeated query fragments, N+1 |
| `api-design` | RESTful resource modeling, status-code semantics, overlapping/duplicate endpoint consolidation, OpenAPI drift, error-shape and auth consistency |
| `bugs` | quick correctness pass (contract drift, missing error handling) — feeds the roadmap |
| `security` | injection, hardcoded secrets, auth/authz gaps, unsafe deserialization, SSRF, dependency vulns |
| `slop` | AI-slop & hallucinated code: non-existent APIs/imports, no-op test assertions, stubs as done, copy-paste drift |

Each lens is run by a dedicated **expert persona** (lazy-senior/ponytail specialist, principal architect, test economist, docs lead, design-system + responsive CSS expert, Postgres expert, REST authority, staff correctness reviewer, appsec reviewer, AI-code auditor). Briefs live in the `expert_brief` case in `scripts/audit.sh`; edit them there to tune a lens.

`sql` runs on API/DB areas, `ui` on web areas (the recon scout picks lens×area pairs).

## Run it

```sh
# from the repo root (config via env, defaults for this machine)
REPO=/path/to/repo WORKTREE=/tmp/repo-audit scripts/audit.sh all    # init recon research find verify aggregate roadmap report; resumable; safe to Ctrl-C and re-run

# step by step
scripts/audit.sh init        # detached worktree of $BASE_REF (default origin/main)
scripts/audit.sh recon       # mimir-slim scout -> .audit/areas.json (lens x area matrix)
scripts/audit.sh research    # mimir-pro web-research agent -> .audit/research.md (state of the art, competitors)
scripts/audit.sh find       # parallel finders, one per (lens, area); skips completed ones
scripts/audit.sh verify     # mimir-pro adversarial gate, batched
scripts/audit.sh aggregate  # dedupe -> .audit/findings.json
scripts/audit.sh roadmap    # mimir-pro clusters epics -> .audit/epics.json (seq/parallel deps)
scripts/audit.sh report     # assembles the audit document
scripts/audit.sh issues     # creates one GH issue per epic (run AFTER human review of epics.json)
scripts/audit.sh status     # what is done / missing / failed
```

Config: `REPO`, `WORKTREE`, `BASE_REF`, `SCOUT_MODEL`, `FINDER_PROVIDER`, `FINDER_MODEL`,
`PRO_MODEL`, `AUDIT_LENSES`, `CONCURRENCY`, `FINDINGS_CAP`, `TIMEOUT`, `VERIFY_BATCH`.
Models default to the mimir family (scout=slim, finder=headroom, verify/roadmap=pro).

## Resumability (the contract)

- State lives in `$WORKTREE/.audit/`: step outputs are files; a step that has all its outputs is skipped.
- A finder/verify child that dies or emits unparsable output leaves NO marker → re-running `find`
  / `verify` retries exactly the missing pieces. Never treat a dead run as "no findings".
- Completed findings survive in `findings/`; you can hand-edit/trim them mid-run.
- Partial recon: if `areas.json` exists it wins. Delete it to re-partition.

## Project-agnostic use

The engine is repo-agnostic. Sensible defaults are built in; per-project
overrides live in env:

- `REPO_CTX` — one-line context given to every child model (stack, layout,
  house rules). Default tells children to read AGENTS.md/README.
- `BASE_REF` — the ref to audit (default `origin/main`).
- model routes, lenses, concurrency — see the env table above.

## Hard rules

- Audit an immutable detached worktree, never the live tree.
- Children get only `read,grep,find,ls` — a lens cannot mutate what it reviews.
- Every finding passes the verify gate (source-confirmed, production-reachable, not spec-correct
  behavior) before it reaches the report. Unverified findings are listed, clearly marked, never merged in.
- Verify a lens that returns nothing says "no findings" explicitly; a crashed lens is a FAILED step.

## Output

- `report.md` — the audit document: summary tables by severity/lens/area + verified findings.
- `epics.json` / roadmap section — epic per concern, each with findings, acceptance criteria, and a
  `parallelizable: true/false` + `depends_on` so work can be sequenced.
- `issues` step renders one GH issue per epic, body = goal + findings + acceptance + deps.

## Iterate

Add a lens: add a brief in `audit.sh` `expert_brief`, optionally add it to `AUDIT_LENSES`, delete
`.audit/findings/*` for it (nothing else) and re-run `find`. New commits: delete `$WORKTREE` and start over.
