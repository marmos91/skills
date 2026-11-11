#!/usr/bin/env sh
# repo-audit-fix — companion to repo-audit: executes the audit's fix plan.
#
# Per-epic pipeline (model roles):
#   research   → SLIM model (mimir-slim)   read-only scout: ground truth per finding
#   plan       → PLAN model (mimir-pro)    code-architect implementation plan
#   planreview → REVIEW model (mimir)     adversarial plan gate; revise loop
#   implement  → IMPL model (mimir)       writes code + minimal tests in an epic worktree
#   gate       → scripts/review-lens.sh   3 lenses (adversarial, correctness, simplification)
#   revise     → IMPL model              addresses gate findings (max GATE_ROUNDS times)
#   pr         → gh pr create            one PR per epic (Fixes #<issue>), never auto-merged
#
# Epic waves come from epics.json depends_on (computed in lib/fix-plan.mjs);
# waves run one after another, parallelizable epics inside a wave run in
# batches of CONCURRENCY, each in its OWN worktree (two agents never share a
# checkout). All epic branches base on BASE_REF; depends_on orders execution,
# not PR stacking.
#
# Resumability: every stage writes a marker under $STATE/<epic>/; a re-run
# skips completed stages. A crashed child leaves no marker and is retried.
# Nothing in-flight is ever read as "done".
set -eu

REPO="${REPO:-$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")}"
REPO_DIR="${REPO_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || echo "$PWD")}"
AUDIT_STATE="${AUDIT_STATE:-}"   # dir with epics.json + findings.json (audit worktree state)
FIXROOT="${FIXROOT:-/tmp/audit-fix-$REPO}"
STATE="$FIXROOT/.fix"
BASE_REF="${BASE_REF:-origin/main}"
SLIM_PROVIDER="${SLIM_PROVIDER:-cubbit}";         SLIM_MODEL="${SLIM_MODEL:-cubbit/mimir-slim}";  SLIM_THINKING="${SLIM_THINKING:-medium}"
PLAN_PROVIDER="${PLAN_PROVIDER:-cubbit}";         PLAN_MODEL="${PLAN_MODEL:-cubbit/mimir-pro}";   PLAN_THINKING="${PLAN_THINKING:-high}"
REVIEW_PROVIDER="${REVIEW_PROVIDER:-cubbit}";     REVIEW_MODEL="${REVIEW_MODEL:-cubbit/mimir}";   REVIEW_THINKING="${REVIEW_THINKING:-high}"
IMPL_PROVIDER="${IMPL_PROVIDER:-cubbit-headroom}"; IMPL_MODEL="${IMPL_MODEL:-cubbit/mimir}";     IMPL_THINKING="${IMPL_THINKING:-high}"
CONCURRENCY="${CONCURRENCY:-3}"
GATE_ROUNDS="${GATE_ROUNDS:-2}"
# Plan-review revise budget. Small epics approve in 1-2 rounds; large refactor
# epics legitimately need more -> default 5.
PLAN_ROUNDS="${PLAN_ROUNDS:-5}"
TIMEOUT="${TIMEOUT:-3600}"
EPIC_FILTER="${EPIC_FILTER:-}"
ISSUE_LABEL="${ISSUE_LABEL:-audit}"
DRY_RUN="${DRY_RUN:-0}"
# jev (shared/jev): cheap calibrated yes/no checks. auto = use it when on PATH; off = never.
JEV="${JEV:-auto}"
# Live SystemOne confidence is low even on obvious answers (~0.26 for "the sky
# is blue"), so the bar is 0.5. shortcut: not measured on real plans; tune it
# once there is data on how often jev's "no" matches a real dropped finding.
JEV_CONFIDENCE="${JEV_CONFIDENCE:-0.5}"
# Project context for every child. Generic default; override per project.
REPO_CTX="${REPO_CTX:-Context: this repo documents its stack, layout and house rules in AGENTS.md (and README) — read it first and follow its conventions: branch/PR workflow, commit style, test and lint commands, code style. Prefer the smallest complete diff; small pure modules; no speculative flexibility.}"

SCRIPTS="${SCRIPTS:-$REPO_DIR/.agents/skills/repo-audit-fix/scripts}"
LIB="$SCRIPTS/lib"
# 3-lens gate: the repo's own review-lens.sh if present (the house gate);
# otherwise LENS must point at an equivalent gate script (see SKILL.md). If
# neither, the engine dies loudly rather than faking a passed review.
LENS="${LENS:-}"
[ -n "$LENS" ] || LENS="$REPO_DIR/scripts/review-lens.sh"
[ -e "$LENS" ] || { printf 'fix: FATAL: no review gate at %s — set LENS=<script with review-lens.sh semantics: lens, range args; exit 0 = pass, non-zero = fail), e.g. LENS=%s/review-lens.sh (shipped template)\n' "$LENS" "$SCRIPTS" >&2; exit 1; }

# timeout probe (coreutils vs gtimeout; may be absent on macOS)
TIMEOUT_BIN=""
T="$(command -v timeout || command -v gtimeout || true)"
if [ -n "$T" ] && "$T" -k 1 1 true >/dev/null 2>&1; then
    TIMEOUT_BIN="$T -k 15 $TIMEOUT"
fi

log()  { echo "fix: $*" >&2; }
die()  { echo "fix: FATAL: $*" >&2; exit 1; }

# jev_verdict <question> <text-file> -> prints yes | no | unsure.
# unsure = jev off/missing, below JEV_CONFIDENCE, or no answer (exit 2);
# callers keep their old behaviour on unsure, so jev only ever adds signal.
# The first outage (exit 2 with an error on stderr) writes $STATE/jev-down and
# turns jev off for the rest of the run, so a hung API costs one timeout.
jev_verdict() {
    if [ "$JEV" = off ] || [ -e "$STATE/jev-down" ] || ! command -v jev >/dev/null 2>&1; then
        echo unsure; return 0
    fi
    _jrc=0
    _jerr="$(jev ask "$1" --confidence "$JEV_CONFIDENCE" <"$2" 2>&1 >/dev/null)" || _jrc=$?
    case "$_jrc" in
        0) echo yes ;;
        1) echo no ;;
        *) if [ -n "$_jerr" ]; then
               echo "$_jerr" >"$STATE/jev-down"
               log "jev unavailable, off for the rest of this run: $_jerr"
           fi
           echo unsure ;;
    esac
}

# plan_coverage_gaps <epic> -> one "<id>: <title>" line per finding jev is
# confident the plan neither fixes nor explicitly skips. Each id is flagged at
# most once per epic (jev-flagged), so a wrong "no" costs one revise round,
# never an endless loop.
plan_coverage_gaps() {
    _dir="$(epic_dir "$1")"
    touch "$_dir/jev-flagged"
    node -e '
const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
for (const f of e.findings) console.log([f.id, f.title, f.what].map(x=>String(x||"").replace(/[\t\n]/g," ")).join("\t"));' "$_dir/epic.json" |
    while IFS="$(printf '\t')" read -r _id _title _what; do
        grep -qxF "$_id" "$_dir/jev-flagged" && continue
        _v="$(jev_verdict "This plan fixes finding $_id ($_title: $_what), or states explicitly why that finding is skipped." "$_dir/plan.md")"
        if [ "$_v" = no ]; then
            echo "$_id" >>"$_dir/jev-flagged"
            echo "$_id: $_title"
        fi
    done
}

# run_pi <provider> <model> <thinking> <tools> <prompt-file> <out-file> [cwd]
run_pi() {
    _p="$1"; _m="$2"; _th="$3"; _tools="$4"; _pf="$5"; _of="$6"
    _cwd="${7:-$REPO_DIR}"
    mkdir -p "$(dirname "$_of")"
    set +e
    # shellcheck disable=SC2086
    ( cd "$_cwd" && $TIMEOUT_BIN pi -p \
        --provider "$_p" --model "$_m" --thinking "$_th" \
        --tools "$_tools" --no-session "$(cat "$_pf")" ) </dev/null >"$_of" 2>"${_of%.txt}.err"
    _rc=$?
    set -e
    # dead/timed-out child = FATAL: discard partial output, stage retries
    [ "$_rc" -eq 0 ] || { rm -f "$_of"; echo "fix: child ($_m) exited $_rc — output discarded" >&2; return 1; }
}

run_read() { run_pi "$1" "$2" "$3" read,grep,find,ls "$4" "$5" "${6:-$REPO_DIR}"; }
run_code() { run_pi "$1" "$2" "$3" read,write,edit,bash,grep,find,ls "$4" "$5" "${6:-$REPO_DIR}"; }

epic_dir()      { echo "$STATE/$1"; }
epic_worktree() { echo "$FIXROOT/$1"; }

plan_field() { # plan_field <epic> <field> — extracts one field from plan.json for that epic
    [ "${2:-}" ] || { echo "plan_field: missing field arg" >&2; return 2; }
    node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).epics
  .find((e) => e.epic === process.argv[2]);
if (!p) process.exit(1);
console.log(p[process.argv[3]] ?? "");' "$STATE/plan.json" "$1" "$2"
}

ensure_worktree() {
    _ep="$1"; _wt="$(epic_worktree "$_ep")"; _dir="$(epic_dir "$_ep")"
    [ -e "$_wt/.git" ] && { [ -s "$_dir/branch" ] || echo "fix/audit-$_ep" >"$_dir/branch"; return 0; }
    mkdir -p "$_dir"
    # resume-tolerant: survive every crash residue — prunable registrations,
    # leftover non-worktree dirs, and existing branches. Reuse, don't die.
    ( cd "$REPO_DIR" && git worktree prune )
    # leftover dir that is NOT a worktree (crash mid-add): untracked junk — remove
    if [ -e "$_wt" ] && [ ! -e "$_wt/.git" ]; then
        rm -rf "$_wt" || die "cannot remove leftover non-worktree dir $_wt"
    fi
    if ( cd "$REPO_DIR" && git show-ref --verify --quiet "refs/heads/fix/audit-$_ep" ); then
        ( cd "$REPO_DIR" && git worktree add "$_wt" "fix/audit-$_ep" ) >/dev/null \
          || die "worktree add (existing branch) failed for $_ep"
    else
        # stack on the first dependency's branch: plan and gate see the dep's
        # fix (wave order = merge order); GitHub auto-retargets the PR to main
        # when its base merges
        _stack_base="$BASE_REF"
        for _d in $(plan_field "$_ep" depends_on 2>/dev/null); do
            if ( cd "$REPO_DIR" && git show-ref --verify --quiet "refs/heads/fix/audit-$_d" ); then
                _stack_base="fix/audit-$_d"
                break
            fi
        done
        ( cd "$REPO_DIR" && git worktree add -b "fix/audit-$_ep" "$_wt" "$_stack_base" ) >/dev/null \
          || die "worktree add failed for $_ep (base $_stack_base)"
    fi
    echo "fix/audit-$_ep" >"$_dir/branch"
}

step_plan() {
    mkdir -p "$STATE/tmp"
    if [ ! -s "$STATE/plan.json" ]; then
        [ -n "$AUDIT_STATE" ] || die "AUDIT_STATE not set — point it at the audit state dir (holds epics.json + findings.json)"
        [ -s "$AUDIT_STATE/epics.json" ] || die "no epics.json in $AUDIT_STATE"
        if ! gh issue list -R "$GH_REPO" --label "$ISSUE_LABEL" --limit 100 \
             --json number,title --jq '.[] | [.number, .title]' >"$STATE/gh-issues.tsv" 2>/dev/null; then
            : >"$STATE/gh-issues.tsv"
        fi
        node "$LIB/fix-plan.mjs" "$AUDIT_STATE" "$STATE/plan.json" "$STATE/gh-issues.tsv"
    fi
    [ -s "$STATE/gh-issues.tsv" ] || log "WARNING: empty GH issue map — PRs will lack Fixes refs"
}

# ---- per-epic stages; every stage: [ -s marker ] && return 0 (resume) ----

stage_research() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"
    [ -s "$_dir/research.md" ] && return 0
    mkdir -p "$_dir"
    _existing="$(plan_field "$_ep" epic || true)"
    [ "$_existing" = "$_ep" ] || die "epic '$_ep' not in plan.json"
    node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")).epics.find(e=>e.epic===process.argv[2]);
console.log(JSON.stringify(p,null,2));' "$STATE/plan.json" "$_ep" >"$_dir/epic.json"
    # ponytail: small epics skip the scout (~2 min + a lane); the architect reads
    # the few files itself. Threshold 3 is a guess — raise if plans get sloppy.
    _nf="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).findings.length)' "$_dir/epic.json")"
    if [ "$_nf" -le 3 ]; then
        echo "Research skipped: small epic ($_nf findings). Architect: confirm each finding in epic.json against source yourself, mark wrong ones SKIP, and classify logic (needs a test) vs mechanical (no test)." >"$_dir/research.md"
        log "research skipped ($_nf findings): $_ep"
        return 0
    fi
    _pf="$_dir/research-prompt.txt"
    {
        echo "EXPERT PERSONA: You are a quick, surgical code scout. You research EXACTLY what a fix needs before anyone writes it — nothing more."
        echo "$REPO_CTX"
        echo "The epic spec (title, goal, findings with file:line and suggested fixes) is at: $_dir/epic.json — read it. Work read-only in the repo at your cwd."
        echo "For each finding: open the file, read enough surrounding code to confirm the claim from source. Then note what a fix really touches — exact functions/imports/callers, any existing helper that already solves part of it (never reinvent), existing tests covering the area, and any finding that looks WRONG on inspection (wrong line, already fixed, misread code) — flag it SKIP for the architect."
        echo "Also classify: which findings involve real logic (branch/parser/money/security — needs a test) vs mechanical changes (delete/move/rename — needs no new test)."
        echo "HARD BOUND: read epic.json, then at most ~25 files, then reply and stop. Markdown, terse, one section per finding id."
    } >"$_pf"
    log "research ($SLIM_MODEL): $_ep"
    run_read "$SLIM_PROVIDER" "$SLIM_MODEL" "$SLIM_THINKING" "$_pf" "$_dir/research.tmp" "$(epic_worktree "$_ep")"
    [ -s "$_dir/research.tmp" ] || die "research child empty for $_ep"
    mv "$_dir/research.tmp" "$_dir/research.md"
    rm -f "$_dir/research.tmp.err"
}

stage_plan() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"
    [ -s "$_dir/plan.md" ] && return 0
    _pf="$_dir/plan-prompt.txt"
    {
        echo "EXPERT PERSONA: You are a code architect — design patterns, clean code, single-responsibility modules, coherent folder structure, zero speculative abstraction. You write IMPLEMENTATION PLANS, not code."
        echo "$REPO_CTX"
        echo "Inputs (read in order): $_dir/epic.json (spec: findings, acceptance criteria); $_dir/research.md (scout ground truth: real code shape, SKIP flags, reuse opportunities, which findings need tests). Work read-only in the repo at your cwd."
        echo "Write the implementation plan for this ONE epic as markdown:"
        echo "1. Files touched (exact paths) and per-file changes — the smallest complete diff fixing every confirmed finding."
        echo "2. Per finding id: the fix approach; SKIP with reason where research flagged it wrong."
        echo "3. Design: which EXISTING module/helper/pattern absorbs each piece of logic (house style: small pure modules, thin components/handlers). Name the target file for every piece."
        echo "4. Tests: ONLY for non-trivial logic a fix changes (per research classification). For each named test: what it asserts and why that could plausibly fail. No tests for mechanical deletes/moves. Never test the obvious."
        echo "5. Ordered steps that each keep the tree green; name the merge-commit-ready conventional commit title per step."
        echo "6. Verification: this repo's real commands per touched package, as documented in AGENTS.md/README (lint, typecheck, tests, build) — only what the epic touches."
        echo "Design rules: no new dependency where code exists; no wrapper with one caller; deletion over addition; keep repo layers. No speculative flexibility."
        echo "HARD BOUND: read the two inputs + at most ~20 source files, write the plan, stop."
    } >"$_pf"
    log "architect ($PLAN_MODEL): $_ep"
    run_read "$PLAN_PROVIDER" "$PLAN_MODEL" "$PLAN_THINKING" "$_pf" "$_dir/plan.tmp" "$(epic_worktree "$_ep")"
    [ -s "$_dir/plan.tmp" ] || die "architect child empty for $_ep"
    mv "$_dir/plan.tmp" "$_dir/plan.md"
    rm -f "$_dir/plan.tmp.err" "$_dir/plan-approved" "$_dir/plan-review.json"
}

review_plan_once() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"
    _pf="$_dir/preview-prompt.txt"
    {
        echo "EXPERT PERSONA: You are a principal engineer reviewing an implementation plan against its spec and the repo. Be decisive."
        echo "$REPO_CTX"
        echo "Inputs: $_dir/epic.json (spec); $_dir/research.md (ground truth); $_dir/plan.md (plan under review). Work read-only in the repo at your cwd."
        echo "Check: does the plan fix EVERY confirmed finding (a silently dropped finding is a defect)? Is each fix actually correct given the source the scout read? Is the design minimal (no speculative abstraction, reuses existing helpers, right layer)? Are the chosen tests only the non-obvious ones? Do the steps keep the tree green?"
        echo "Reply with ONLY this JSON object, no fences: {\"verdict\":\"approved\"|\"revise\"|\"revise_minor\",\"blocking\":[\"...\"],\"nits\":[\"...\"]}"
        echo "Verdict rules: 'approved' = ready to implement, zero blocking defects. 'revise' = a blocking defect exists (wrong fact about the repo, dropped finding, design that fails a check above) — list ONLY blocking defects, not style. 'revise_minor' = no blocking defect, only small improvements — implementer will be told the nits; DO NOT block convergence on them. If you approved an aspect in a previous round, do not re-open it unless a later round broke it."
        echo "If the plan is sound, approve — do not invent issues. Every blocking comment must be actionable and cite the repo fact it corrects."
        echo "HARD BOUND: read the three files + at most ~10 source files, reply, stop."
    } >"$_pf"
    run_read "$REVIEW_PROVIDER" "$REVIEW_MODEL" "$REVIEW_THINKING" "$_pf" "$_dir/plan-review.tmp" "$(epic_worktree "$_ep")"
    node -e '
const fs=require("fs");
let t=fs.readFileSync(process.argv[1],"utf8").trim();
try { t = JSON.parse(t); } catch { t = null; }
const okV = ["approved","revise","revise_minor"];
if (!t || !okV.includes(t.verdict) || !Array.isArray(t.blocking) || !Array.isArray(t.nits)) process.exit(1);
fs.writeFileSync(process.argv[1], JSON.stringify(t));' "$_dir/plan-review.tmp"
}

stage_planreview() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"
    _rounds=0
    while [ ! -s "$_dir/plan-approved" ]; do
        # Budget counts REVISES, not reviews: PLAN_ROUNDS revises allow
        # PLAN_ROUNDS+1 reviews, so the final revise always gets reviewed.
        # (Old shape — counting reviews — died one round early, FATALing epics
        # whose final revise had addressed everything.)
        [ "$_rounds" -lt "$PLAN_ROUNDS" ] || die "plan review loop exhausted for $_ep"
        _rounds=$((_rounds+1))
        log "plan review ($REVIEW_MODEL, round $_rounds): $_ep"
        # retry invalid child output within the same round budget
        _ok=0
        _tries=0
        while [ "$_tries" -lt 2 ]; do
            _tries=$((_tries+1))
            rm -f "$_dir/plan-review.tmp"
            if review_plan_once "$_ep" && [ -s "$_dir/plan-review.tmp" ]; then _ok=1; break; fi
            log "plan review child invalid for $_ep (try $_tries) — retrying"
        done
        [ "$_ok" = 1 ] || die "plan review child failed for $_ep"
        _verdict="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).verdict)' "$_dir/plan-review.tmp")"
        # second opinion on the reviewer's coverage check: a dropped finding is a defect
        # only with a round left to act on it: on the last round a wrong "no"
        # would turn an approved plan into "plan review loop exhausted"
        if [ "$_verdict" != revise ] && [ "$_rounds" -lt "$PLAN_ROUNDS" ]; then
            _gaps="$(plan_coverage_gaps "$_ep")"
            if [ -n "$_gaps" ]; then
                printf '%s\n' "$_gaps" | node -e '
const fs=require("fs"); const f=process.argv[1];
const r=JSON.parse(fs.readFileSync(f,"utf8"));
const gaps=fs.readFileSync(0,"utf8").split("\n").filter(Boolean);
r.verdict="revise";
r.blocking=r.blocking.concat(gaps.map(g=>`Plan does not address finding ${g} (fix it or state why it is skipped).`));
fs.writeFileSync(f, JSON.stringify(r));' "$_dir/plan-review.tmp"
                _verdict=revise
                log "plan review: jev flagged unaddressed findings in $_ep: $(printf '%s' "$_gaps" | tr '\n' ' ')"
            fi
        fi
        if [ "$_verdict" = "approved" ]; then
            mv "$_dir/plan-review.tmp" "$_dir/plan-review.json"
            echo ok >"$_dir/plan-approved"
            break
        fi
        if [ "$_verdict" = "revise_minor" ]; then
            # no blocking defect: accept, hand nits to the implementer
            mv "$_dir/plan-review.tmp" "$_dir/plan-review.json"
            echo ok >"$_dir/plan-approved"
            log "plan review: $_ep accepted with minor nits — passed to implementer"
            break
        fi
        mv "$_dir/plan-review.tmp" "$_dir/plan-review.json"
        {
            cat "$_dir/plan-prompt.txt"
            echo ""
            echo "REVISION: the plan reviewer rejected the current plan with BLOCKING comments (their nits are advisory, ignore them here):"
            cat "$_dir/plan-review.json"
            echo "Surgical edit rules: produce the FULL plan, but change ONLY what the blocking comments require — every other section must be copied through verbatim, character for character. Do not rewrite, reformat, or 'improve' untouched sections; a pristine carry-over is strictly better than a fresh paraphrase. Address every blocking comment. Reply with the complete new plan only."
        } >"$_dir/plan-prompt-r$_rounds.txt"
        run_read "$PLAN_PROVIDER" "$PLAN_MODEL" "$PLAN_THINKING" "$_dir/plan-prompt-r$_rounds.txt" "$_dir/plan.tmp" "$(epic_worktree "$_ep")"
        [ -s "$_dir/plan.tmp" ] || die "plan revision child empty for $_ep"
        mv "$_dir/plan.tmp" "$_dir/plan.md"
    done
    rm -f "$_dir/preview-prompt.txt" "$_dir/plan-review.tmp.err"
}

stage_implement() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"; _wt="$(epic_worktree "$_ep")"
    [ -s "$_dir/implemented" ] && return 0
    _pf="$_dir/impl-prompt.txt"
    # CRASH RESUME: summary written but crash before commit -> skip the child,
    # fall through to diff-check + commit on the existing dirty tree.
    if [ -s "$_dir/impl-summary.md" ]; then
        log "implement: $_ep resuming from impl-summary (pre-commit crash)"
    else
    {
        echo "EXPERT PERSONA: You are a senior implementing engineer. Follow the approved plan EXACTLY; deviate only when source proves the plan wrong, and record the deviation."
        echo "$REPO_CTX"
        echo "Inputs: $_dir/plan.md (approved implementation plan — follow it); $_dir/epic.json (spec); $_dir/research.md (ground truth)."
        if [ -s "$_dir/plan-review.json" ]; then
            _nits="$(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write((r.nits||[]).join("\n"))' "$_dir/plan-review.json" 2>/dev/null)"
            if [ -n "$_nits" ]; then printf 'Advisory nits from plan review (address if cheap, never at the cost of plan fidelity):\n%s\n' "$_nits"; fi
        fi
        echo "You work in a dedicated git worktree at your cwd. Other agents work in OTHER worktrees: NEVER run git worktree add/remove/prune, gc, rebase, or anything outside your cwd. NEVER commit or push — leave the tree dirty; the orchestrator commits. Do not use git stash."
        echo "Implement every plan step. House rules: minimal complete diff, no speculative flexibility, reuse existing helpers, follow the repo code style (read AGENTS.md); run the repo formatter on files you touched."
        echo "Tests: add ONLY the tests the plan names (non-trivial logic). Do not test the obvious; do not add tests for deletes/moves."
        echo "Then VERIFY with the plan's commands from your worktree (the repo's own lint/typecheck/test commands per AGENTS.md). Fix what they report until green, or say explicitly which command could not run — never claim green you did not see."
        echo "Do NOT run scripts/review-lens.sh or any multi-lens review gate — the orchestrator runs the review gate for you after you finish; your verification is lint/typecheck/tests only."
        echo "Reply markdown: per finding id what you implemented, deviations + reasons, verification results (verbatim tail), anything incomplete."
        echo "HARD BOUND: implement, verify, report, stop. No refactors beyond the plan."
    } >"$_pf"
    log "implement ($IMPL_MODEL): $_ep"
    run_code "$IMPL_PROVIDER" "$IMPL_MODEL" "$IMPL_THINKING" "$_pf" "$_dir/impl.tmp" "$_wt"
    # crashed child = half-edited tree: no summary -> reset tree, die (no marker)
    if [ ! -s "$_dir/impl.tmp" ]; then
        ( cd "$_wt" && git checkout --quiet -- . ) 2>/dev/null || true
        die "implementer child produced no summary for $_ep — tree reset, no marker"
    fi
    mv "$_dir/impl.tmp" "$_dir/impl-summary.md"
    fi   # end fresh-implement branch (crash-resume path joins here)
    ( cd "$_wt" && [ -n "$(git status --porcelain)" ] ) || die "implementer produced NO diff for $_ep"
    _title="$(plan_field "$_ep" title | head -c 60)"
    _issue="$(plan_field "$_ep" issue)"
    ( cd "$_wt" && git add -A \
      && git -c commit.gpgsign=false commit -q \
         -m "fix(audit): $_title" ${_issue:+-m "Fixes #$_issue"} </dev/null ) || die "commit failed for $_ep"
    rm -f "$_dir/gate-sha"   # fresh implementation: first gate round reviews the full diff
    echo ok >"$_dir/implemented"
}

# findings_of <BLOCKING|NIT> <lens-output>: each tagged bullet plus its
# continuation lines (up to the next bullet or a blank line)
findings_of() {
    awk -v tag="$1" '
      /^[[:space:]]*[-*][[:space:]]/ { on = ($0 ~ ("^[[:space:]]*[-*][[:space:]]*[*]*" tag)) }
      /^[[:space:]]*$/ { on = 0 }
      on' "$2" 2>/dev/null || true
}

GATE_LENSES="adversarial correctness simplification"

# park_epic <epic>: gate budget spent. Record the open BLOCKING findings and
# free the lane — a non-converging epic must not starve the queue.
park_epic() {
    _pd="$(epic_dir "$1")"
    {
        echo "# $1 parked: gate still failing after $GATE_ROUNDS revise rounds"
        echo "Fix by hand, or raise GATE_ROUNDS and re-run. Open BLOCKING findings:"
        for _lens in $GATE_LENSES; do
            echo ""; echo "## $_lens"
            _b="$(findings_of BLOCKING "$_pd/gate-$_lens.txt")"
            if [ -n "$_b" ]; then echo "$_b"; else sed -n '1,40p' "$_pd/gate-$_lens.txt" 2>/dev/null || true; fi
        done
    } >"$_pd/blocked.md"
    grep -qx "$1" "$STATE/blocked" 2>/dev/null || echo "$1" >>"$STATE/blocked"
    log "gate: $1 PARKED after $GATE_ROUNDS revise rounds — see $_pd/blocked.md"
}

stage_gate() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"; _wt="$(epic_worktree "$_ep")"
    [ -s "$_dir/gate-passed" ] && return 0
    # CRASH RESUME: revise child edited but died before its commit -> unchecked
    # edits are invisible to the three-dot range the lenses diff. Commit them as
    # a checkpoint so gate rounds and lens diffs see the real tree.
    if ( cd "$_wt" && [ -n "$(git status --porcelain)" ] ) 2>/dev/null; then
        ( cd "$_wt" && git add -A && git -c commit.gpgsign=false commit -q -m "fix(audit): resume checkpoint (pre-gate)" </dev/null ) \
          || die "gate: cannot commit dirty resume state for $_ep"
        log "gate: $_ep committed dirty pre-crash state as checkpoint"
    fi
    _branch="$(cat "$_dir/branch")"
    while [ ! -s "$_dir/gate-passed" ]; do
        # round = revise rounds on disk + 1, so a restart never resets the budget
        set -- "$_dir"/revise-r*.md
        [ -e "$1" ] || set --
        _round=$(($# + 1))
        # parked on an earlier run with the same budget: don't re-gate, stay parked
        if [ "$_round" -gt "$((GATE_ROUNDS+1))" ] || { [ -s "$_dir/blocked.md" ] && [ "$_round" -gt "$GATE_ROUNDS" ]; }; then
            park_epic "$_ep"; return 0
        fi
        rm -f "$_dir/blocked.md" "$_dir/gate-failed.txt"
        log "gate round $_round/$((GATE_ROUNDS+1)): $_ep"
        _head="$(cd "$_wt" && git rev-parse HEAD)"
        # rounds >= 2: lenses verify their prior BLOCKING findings and review
        # only the delta since the last gated sha, instead of the full diff
        _delta=""
        [ -s "$_dir/gate-sha" ] && _delta="$(cat "$_dir/gate-sha")..$_branch"
        for _lens in $GATE_LENSES; do
            if [ -n "$_delta" ]; then findings_of BLOCKING "$_dir/gate-$_lens.txt" >"$_dir/gate-$_lens.prior"; else : >"$_dir/gate-$_lens.prior"; fi
            # lenses in parallel: 3 sequential 900s reviews become one ~900s round
            (
              if ( cd "$REPO_DIR" && REVIEW_PROVIDER="$REVIEW_PROVIDER" REVIEW_MODEL="$REVIEW_MODEL" REVIEW_THINKING="$REVIEW_THINKING" \
                   LENS_PRIOR="$_dir/gate-$_lens.prior" LENS_DELTA="$_delta" \
                   sh "$LENS" "$_lens" "$BASE_REF...$_branch" ) \
                 >"$_dir/gate-$_lens.tmp" 2>&1; then
                :
              else
                echo "round $_round lens $_lens exit $?" >>"$_dir/gate-failed.txt"
              fi
              mv "$_dir/gate-$_lens.tmp" "$_dir/gate-$_lens.txt"
            ) &
            echo "$!" >>"$_dir/gate-lens.pids"
        done
        # shellcheck disable=SC2046
        wait $(tr '\n' ' ' <"$_dir/gate-lens.pids") 2>/dev/null; rm -f "$_dir/gate-lens.pids"
        echo "$_head" >"$_dir/gate-sha"
        if [ ! -s "$_dir/gate-failed.txt" ]; then
            # zero BLOCKING findings: NITs ride along in the PR body, no revise
            for _lens in $GATE_LENSES; do
                _n="$(findings_of NIT "$_dir/gate-$_lens.txt")"
                [ -z "$_n" ] || printf '### %s\n\n%s\n\n' "$_lens" "$_n"
            done >"$_dir/gate-nits.md"
            echo ok >"$_dir/gate-passed"
            break
        fi
        write_resume_doc
        [ "$_round" -le "$GATE_ROUNDS" ] || { park_epic "$_ep"; return 0; }
        log "revise ($IMPL_MODEL): $_ep (gate findings)"
        {
            echo "EXPERT PERSONA: You are the implementing engineer fixing review findings on your own change."
            echo "$REPO_CTX Your worktree is your cwd, branch $_branch. NEVER commit/push/stash; the orchestrator commits. Fix only what the reviews found; do not expand scope."
            echo "Your change (diff vs $BASE_REF) failed the three-lens review gate. The BLOCKING findings of the failing lenses:"
            for _lens in $GATE_LENSES; do
                grep -q " lens $_lens exit" "$_dir/gate-failed.txt" || continue
                echo "--- lens: $_lens ---"
                _b="$(findings_of BLOCKING "$_dir/gate-$_lens.txt")"
                # untagged (legacy) lens output: hand over the raw report
                if [ -n "$_b" ]; then echo "$_b"; else sed -n '1,80p' "$_dir/gate-$_lens.txt"; fi
                echo ""
            done
            echo "NIT findings are deliberately left out (they go to the PR body) — do not act on them."
            echo "Fix every real finding. A lens finding may be wrong: if source proves one wrong, record the refutation in a short code comment or your reply instead of 'fixing' it. Keep the diff minimal."
            echo "Re-run the plan's touched-package checks until green. Then reply with what you changed per finding (or why refuted) and stop."
        } >"$_dir/revise-prompt-r$_round.txt"
        # a failed revise child must not consume a round (no revise-r file) nor loop
        run_code "$IMPL_PROVIDER" "$IMPL_MODEL" "$IMPL_THINKING" "$_dir/revise-prompt-r$_round.txt" "$_dir/revise-r$_round.md" "$_wt" \
          || { log "revise child failed for $_ep (round $_round) — retry on next run"; return 1; }
        if ( cd "$_wt" && [ -n "$(git status --porcelain)" ] ); then
            ( cd "$_wt" && git add -A && git -c commit.gpgsign=false commit -q -m "fix(audit): review revisions round $_round" </dev/null )
        fi
    done
    rm -f "$_dir/blocked.md"
}

stage_pr() {
    _ep="$1"; _dir="$(epic_dir "$_ep")"; _wt="$(epic_worktree "$_ep")"
    [ -s "$_dir/pr-url" ] && return 0
    [ -s "$_dir/gate-passed" ] || { log "pr: skip $_ep (gate not passed)"; return 0; }
    _title="$(plan_field "$_ep" title)"
    _goal="$(plan_field "$_ep" goal)"
    _issue="$(plan_field "$_ep" issue)"
    if [ "$DRY_RUN" = 1 ]; then log "pr DRY_RUN: would create for $_ep (#$_issue)"; echo "DRY https://example.com/PR/$_ep" >"$_dir/pr-url.dry-run"; return 0; fi
    _branch="$(cat "$_dir/branch")"
    _url="$( cd "$_wt" && (gh pr list --head "$_branch" --state open --json url --jq '.[0].url // empty' 2>/dev/null) )"
    if [ -n "$_url" ]; then
        # CRASH RESUME: PR was created but pr-url never wrote (crash between
        # gh create and the marker). Reuse the existing PR instead of duping.
        echo "$_url" >"$_dir/pr-url"
        log "pr: $_ep adopted existing open PR $_url (resume)"
        return 0
    fi
    ( cd "$_wt" && git push -q -u origin "$_branch" ) || die "push failed for $_ep"
    _pr_base="${BASE_REF#origin/}"
    for _d in $(plan_field "$_ep" depends_on 2>/dev/null); do
        if ( cd "$REPO_DIR" && git show-ref --verify --quiet "refs/heads/fix/audit-$_d" ); then
            _pr_base="fix/audit-$_d"
            break
        fi
    done
    _body="$(printf '## Epic\n\n%s\n\n## Goal\n\n%s\n' "$_ep" "$_goal")"
    if [ -n "$_issue" ]; then
        _body="$(printf '%s\nFixes #%s\n' "$_body" "$_issue")"
    fi
    if [ -s "$_dir/gate-nits.md" ]; then
        _body="$(printf '%s\n## Review nits (non-blocking)\n\n%s\n' "$_body" "$(cat "$_dir/gate-nits.md")")"
    fi
    _body="$(printf '%s\n## Process\n\nResearch -> code-architect plan (adversarial plan review) -> implementation in an isolated worktree -> three-lens review gate (adversarial, correctness, simplification) against %s with revise rounds.\n' "$_body" "$BASE_REF")"
    _url="$( cd "$_wt" && gh pr create --base "$_pr_base" --title "$_title" --body "$_body" 2>&1 | tail -1 )"
    case "$_url" in
        http*) echo "$_url" >"$_dir/pr-url"; log "pr created for $_ep: $_url" ;;
        *) die "gh pr create failed for $_ep: $_url" ;;
    esac
}

write_resume_doc() {
    # Durable human+machine status doc. Markers are the truth; this is the
    # navigation aid. Rewritten at run start, on every stage transition and gate
    # round, on `status`, and at run end. Parallel epics call this concurrently:
    # write-to-tmp + rename keeps the file whole.
    node - "$STATE" "$FIXROOT" "${EPIC_FILTER:-}" "$BASE_REF" "$SCRIPTS" <<'JS'
const fs = require("fs");
const [state, root, filter, baseRef, scriptsDir] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(`${state}/plan.json`, "utf8"));
const out = [];
out.push(`# repo-audit-fix run state`);
out.push(``);
out.push(`Updated: ${new Date().toISOString()}`);
out.push(`BASE_REF: ${baseRef}  FIXROOT: ${root}`);
out.push(``);
out.push(`Stage order per epic: research -> plan -> plan-review -> implement -> gate -> pr.`);
out.push(`A stage is DONE only when its marker exists (research.md, plan.md,`);
out.push(`plan-approved, implemented, gate-passed, pr-url). Mid-flight stages`);
out.push(`restart on relaunch; every stage is idempotent, half-writes are safe.`);
out.push(``);
out.push(`## Epic pipeline state`);
out.push(``);
out.push(`| epic | wave | issue | res | plan | appr | impl | gate | pr | failed-at |`);
out.push(`|---|---|---|---|---|---|---|---|---|---|`);
for (const e of p.epics) {
  if (filter && !filter.split(",").includes(e.epic)) continue;
  const d = `${state}/${e.epic}`;
  const has = (f) => fs.existsSync(`${d}/${f}`) ? "yes" : "-";
  const pr = fs.existsSync(`${d}/pr-url`) ? fs.readFileSync(`${d}/pr-url`, "utf8").trim().slice(0, 60) : "-";
  let failedAt = "-";
  const revs = fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /^revise-r\d+\.md$/.test(f)).length : 0;
  if (fs.existsSync(`${d}/blocked.md`)) failedAt = `parked (gate, ${revs} revises; see blocked.md)`;
  else if (fs.existsSync(`${d}/gate-failed.txt`)) failedAt = `gate round ${revs + 1} (blocking findings)`;
  else if (has("implemented") === "yes" && has("gate-passed") !== "yes") failedAt = `gate round ${revs + 1} (pending)`;
  else if (fs.existsSync(`${d}/plan-review.json`) && has("plan-approved") !== "yes") {
    try { failedAt = "plan review (" + JSON.parse(fs.readFileSync(`${d}/plan-review.json`, "utf8")).verdict + ")"; } catch { failedAt = "plan review"; }
  }
  out.push(`| ${e.epic} | w${e.wave} | #${e.issue || "-"} | ${has("research.md")} | ${has("plan.md")} | ${has("plan-approved")} | ${has("implemented")} | ${has("gate-passed")} | ${pr} | ${failedAt} |`);
}
out.push(``);
out.push(`## FATAL / blocked epics`);
out.push(``);
if (fs.existsSync(`${state}/blocked`) || fs.existsSync(`${state}/failed-epics`)) {
  for (const f of ["failed-epics", "blocked"]) {
    if (fs.existsSync(`${state}/${f}`)) {
      const t = fs.readFileSync(`${state}/${f}`, "utf8").trim();
      if (t) out.push(`- ${f}: ${t.split("\n").join(", ")}`);
    }
  }
} else out.push(`(none)`);
out.push(``);
out.push(`## To resume`);
out.push(``);
out.push(`    REPO_DIR=<repo> SCRIPTS=${scriptsDir} AUDIT_STATE=<audit-state> FIXROOT=${root} sh ${scriptsDir}/fix.sh run`);
out.push(``);
out.push(`Finished epics skip via their pr-url marker; done stages skip via theirs.`);
fs.writeFileSync(`${state}/RESUME.md.${process.pid}`, out.join("\n") + "\n");
fs.renameSync(`${state}/RESUME.md.${process.pid}`, `${state}/RESUME.md`);
JS
}

run_epic() {
    _ep="$1"
    # done-marker is a REAL pr only; a DRY_RUN marker never blocks a real run
    _d="$(epic_dir "$_ep")"
    if [ -s "$_d/pr-url" ]; then log "$_ep: PR exists — skipping (resume)"; return 0; fi
    if [ -s "$_d/pr-url.dry-run" ] && [ "$DRY_RUN" = 1 ]; then log "$_ep: DRY_PR done — skipping (resume)"; return 0; fi
    rm -f "$_d/pr-url.dry-run"
    ensure_worktree "$_ep"
    for _stage in research plan planreview implement gate pr; do
        "stage_$_stage" "$_ep" || { write_resume_doc; return 1; }
        write_resume_doc
    done
}

step_run() {
    step_plan
    write_resume_doc
    # waves file: "WAVE\t<num>" header lines + "<epic>\t<par|seq>\t<issue>" rows
    node -e '
const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).epics;
const w=new Map(); p.forEach((e)=>{ if(!w.has(e.wave)) w.set(e.wave,[]); w.get(e.wave).push(e); });
for(const [wave,epics] of [...w].sort((a,b)=>a[0]-b[0])){
  console.log(`WAVE\t${wave}`);
  for(const e of epics) console.log([e.epic, e.parallelizable?"par":"seq", e.issue||"-"].join("\t"));
}' "$STATE/plan.json" >"$STATE/waves.txt"
    _wave_no=0
    while IFS="$(printf '\t')" read -r kind par _issue_col; do
        case "$kind" in "#"*) continue ;; esac
        if [ "$kind" = "WAVE" ]; then
            _wave_no="$par"
            # collect this wave's epics (filtered), then run in batches
            node -e '
const fs=require("fs");
const filter=process.argv[1] ? process.argv[1].split(",").filter(Boolean) : null;
const lines=fs.readFileSync(process.argv[2],"utf8").split("\n");
const out=[]; let inWave=false;
for(const l of lines){
  if(l.startsWith("WAVE\t")) { inWave = l.trim()==="WAVE\t"+process.argv[3]; continue; }
  if(!inWave || !l.trim()) continue;
  const [ep, par] = l.split("\t");
  if(filter && !filter.includes(ep)) continue;
  out.push(ep + "\t" + par);
}
fs.writeFileSync(process.argv[4], out.join("\n")+(out.length?"\n":""));' "${EPIC_FILTER:-}" "$STATE/waves.txt" "$_wave_no" "$STATE/tmp/wave-epics.txt"
            _total="$(wc -l <"$STATE/tmp/wave-epics.txt" | tr -d ' ')"
            if [ "$_total" = "0" ]; then continue; fi
            log "wave $_wave_no: $_total epic(s)"
            # Lane-slot pool instead of batch-of-CONCURRENCY waves: dispatch an
            # epic as soon as a lane frees up (batching made the whole flight wait
            # for its slowest member — a 40-min implementer idled 3 lanes).
            : >"$STATE/tmp/running.pids"
            _pn=0
            _gin=0
            while IFS="$(printf '\t')" read -r _ep _par; do
                [ -n "$_ep" ] || continue
                while [ "$_pn" -ge "$CONCURRENCY" ]; do
                    # reap one: remove any finished pid from running.pids
                    _freed="0"
                    : >"$STATE/tmp/.reap"
                    while read -r _p; do
                        [ -n "$_p" ] || continue
                        if kill -0 "$_p" 2>/dev/null; then echo "$_p" >>"$STATE/tmp/.reap"; else _freed=1; fi
                    done <"$STATE/tmp/running.pids"
                    mv "$STATE/tmp/.reap" "$STATE/tmp/running.pids"
                    [ "$_freed" = "1" ] || sleep 10
                    _pn=$(wc -l <"$STATE/tmp/running.pids" | tr -d ' ')
                done
                # </dev/null: backgrounded children must NOT inherit the
                # wave-epics.txt fd as stdin — any child reading stdin advances
                # the shared offset and the dispatcher skips the remaining epics.
                { run_epic "$_ep" || echo "$_ep" >>"$STATE/failed-epics"; } </dev/null &
                echo "$!" >>"$STATE/tmp/running.pids"
                _pn=$((_pn+1))
                _gin=$((_gin+1))
            done <"$STATE/tmp/wave-epics.txt"
            while read -r _p; do [ -n "$_p" ] && wait "$_p" || true; done <"$STATE/tmp/running.pids"
            rm -f "$STATE/tmp/.reap"
            continue
        fi
    done <"$STATE/waves.txt"
    write_resume_doc
    step_status
}

step_status() {
    echo "=== repo-audit-fix: $REPO (state $STATE) ===" >&2
    if [ ! -s "$STATE/plan.json" ]; then
        echo "no plan yet — run: (fix.sh plan) after setting AUDIT_STATE" >&2
        return 0
    fi
    write_resume_doc
    node -e '
const fs=require("fs");
const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const e of p.epics){
  if (process.argv[3] && !process.argv[3].split(",").includes(e.epic)) continue;
  const d=`${process.argv[2]}/${e.epic}`;
  const has=(f)=>fs.existsSync(`${d}/${f}`)?"+":"-";
  const pr=fs.existsSync(`${d}/pr-url`)?fs.readFileSync(`${d}/pr-url`,"utf8").trim():"";
  console.log([e.epic.padEnd(38), `w${e.wave}`, `#${e.issue||"-"}`, `res${has("research.md")}`, `plan${has("plan-approved")}`, `impl${has("implemented")}`, `gate${has("gate-passed")}`, pr.slice(0,50)].join(" "));
}' "$STATE/plan.json" "$STATE" "${EPIC_FILTER:-}" >&2
    if [ -s "$STATE/blocked" ]; then echo "PARKED (gate budget spent; findings in <epic>/blocked.md):" >&2; cat "$STATE/blocked" >&2; fi
    if [ -s "$STATE/failed-epics" ]; then echo "FAILED (crashed stage, will retry on next run):" >&2; cat "$STATE/failed-epics" >&2; fi
    return 0
}

step_clean() {
    if [ -d "$FIXROOT" ]; then
        for _wt in "$FIXROOT"/*/; do
            [ -e "$_wt/.git" ] || continue
            ( cd "$REPO_DIR" && git worktree remove --force "$_wt" ) 2>/dev/null || true
        done
    fi
    ( cd "$REPO_DIR" && git branch -D $(git branch --list 'fix/audit-*' | sed 's/^[* ]*//' | tr '\n' ' ') ) 2>/dev/null || true
    rm -rf "$FIXROOT"
    log "removed $FIXROOT (worktrees + state) and fix/audit-* branches (kept remote branches)"
    return 0
}

mkdir -p "$STATE/tmp"
GH_REPO="${GH_REPO:-$( ( cd "$REPO_DIR" && git remote get-url origin 2>/dev/null | sed -E 's#(git@|https?://)?([^:/]+)[:/]##; s#\.git$##' ) )}"
# derived vars are read inside backgrounded stage functions — export them so
# subshells always inherit the same values even if the caller forgot export
export STATE FIXROOT REPO_DIR AUDIT_STATE BASE_REF LENS SCRIPTS LIB GH_REPO
export CONCURRENCY GATE_ROUNDS PLAN_ROUNDS EPIC_FILTER DRY_RUN ISSUE_LABEL JEV JEV_CONFIDENCE

case "${1:-help}" in
    plan)   step_plan ;;
    run)    rm -f "$STATE/jev-down"   # a new run tries jev again
            if [ "$JEV" != off ] && command -v jev >/dev/null 2>&1; then
                log "jev on: plan text and finding titles go to Mimir SystemOne for coverage checks (JEV=off to disable)"
            fi
            step_run ;;
    status) step_status ;;
    clean)  step_clean ;;
    *) grep '^#' "$0" | sed 's/^# \{0,1\}//' ;;
esac
