#!/usr/bin/env sh
# repo-audit engine — resumable multi-lens whole-repo audit of an immutable
# detached worktree, driven by expert read-only `pi -p` children. Deliberately
# NOT a pi-subagents workflow: that path is broken in this environment (see
# AGENTS.md "Review gate"). Every step writes its outputs into $STATE and is
# skipped when they exist, so a crash or Ctrl-C resumes by re-running the same
# command. A dead child writes NO marker file, so re-running retries exactly
# the missing pieces — never "no findings".
#
# Steps: init recon research find verify aggregate roadmap report issues
#        status clean all
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB="$SCRIPT_DIR/lib"
REPO="$(cd "${REPO:-.}" && pwd)"
REPO_NAME="$(basename "$REPO")"
WORKTREE="${WORKTREE:-/tmp/audit-$REPO_NAME}"
BASE_REF="${BASE_REF:-origin/main}"
STATE="${STATE_DIR:-$WORKTREE/.audit}"
SCOUT_PROVIDER="${SCOUT_PROVIDER:-cubbit}";       SCOUT_MODEL="${SCOUT_MODEL:-cubbit/mimir-slim}";  SCOUT_THINKING="${SCOUT_THINKING:-medium}"
FINDER_PROVIDER="${FINDER_PROVIDER:-cubbit-headroom}"; FINDER_MODEL="${FINDER_MODEL:-cubbit/mimir}"; FINDER_THINKING="${FINDER_THINKING:-high}"
PRO_PROVIDER="${PRO_PROVIDER:-cubbit}";           PRO_MODEL="${PRO_MODEL:-cubbit/mimir-pro}";        PRO_THINKING="${PRO_THINKING:-high}"
AUDIT_LENSES="${AUDIT_LENSES:-simplify,structure,tests,docs,ui,sql,bugs,api-design,security,slop}"
RESEARCH_TOPICS="${RESEARCH_TOPICS:-}"
AREA_FILTER="${AREA_FILTER:-}"
CONCURRENCY="${CONCURRENCY:-4}"
FINDINGS_CAP="${FINDINGS_CAP:-12}"
TIMEOUT="${TIMEOUT:-2400}"
VERIFY_BATCH_N="${VERIFY_BATCH:-10}"
DRY_RUN="${DRY_RUN:-0}"
GH_REPO="${GH_REPO:-}"

TIMEOUT_BIN=""
T="$(command -v timeout || command -v gtimeout || true)"
[ -n "$T" ] && "$T" -k 1 1 true >/dev/null 2>&1 && TIMEOUT_BIN="$T -k 15 $TIMEOUT"

log()  { echo "audit: $*" >&2; }
die()  { echo "audit: ERROR: $*" >&2; exit 1; }

USAGE='steps: init recon research find verify aggregate roadmap report issues status clean all'
[ $# -ge 1 ] || die "$USAGE"
STEP="$1"

need_worktree() { [ -e "$WORKTREE/.git" ] || die "worktree $WORKTREE missing — run: audit.sh init"; }  # linked worktree .git is a FILE
need_state()    { need_worktree; mkdir -p "$STATE"; }

# run_pi <provider> <model> <thinking> <tools> <prompt-file> <out-file>
# Child cwd = $WORKTREE, so reads are anchored to the immutable tree. A failed/
# timed-out child just leaves a bad/empty out-file: the caller treats that as
# "not done" and a re-run retries it.
run_pi() {
    _p="$1"; _m="$2"; _th="$3"; _tools="$4"; _pf="$5"; _of="$6"
    mkdir -p "$(dirname "$_of")"
    set +e
    # shellcheck disable=SC2086
    ( cd "$WORKTREE" && $TIMEOUT_BIN pi -p \
        --provider "$_p" --model "$_m" --thinking "$_th" \
        --tools "$_tools" --no-session "$(cat "$_pf")" ) >"$_of" 2>"${_of%.txt}.err"
    set -e
}

# valid_json <file> [min-count] — extract + validate a child's JSON array reply
# (accepts stray prose/fences around it), rewrite the file with clean JSON,
# print element count. Exit 1 on garbage (child died / hallucinated format).
valid_json() {
    node "$LIB/parse.mjs" "$1" "${2:-1}" || return 1
}

# Project context for every child. Generic default; override per project:
#   export REPO_CTX="Context: <stack, layout, house rules in one line>"
REPO_CTX="${REPO_CTX:-Context: this repo documents its stack, layout and house rules in AGENTS.md (and README) — read it first and follow its conventions: branch/PR workflow, commit style, test commands, code style.}"

expert_brief() { # $1 = lens -> concatenation: expert persona + hunting grounds
    case "$1" in
    simplify)
        cat <<'EOF'
EXPERT PERSONA: You are a ruthlessly lazy senior engineer — a specialist in eliminating over-engineering (the "ponytail" discipline). Your famous one-liner: the best code is the code never written.

You hunt ONLY over-engineering and waste. Your question is "what can be deleted?" — not "what is wrong?" (other lenses own that).
Hunting grounds: dead code and unused exports (verify with grep before flagging — an "unused" symbol a caller references is not dead); speculative abstraction with one caller and none foreseen; needless indirection, wrappers, config knobs, options and "for later" scaffolding; reimplementation of stdlib or of a helper that already exists a few files over; duplicated logic a shared function absorbs; a dependency pulled in for a few lines that stdlib covers.
A finding without a concrete deletion (file:line) is not a finding. Where duplication exists, name the shared helper to consolidate on.
EOF
    ;;
    structure)
        cat <<'EOF'
EXPERT PERSONA: You are a principal software architect who reviews codebases for human navigability: design patterns, module boundaries, and folder structure. You believe code is read 10x more than written.

You hunt ONLY structure, design-pattern and idiomaticity problems — code that is hard for a human to traverse and read.
Hunting grounds: layer violations (fetching, validation and domain logic mixed in one place); god files that must be split (>~800 lines suspicious, >~1500 must split — name the split lines/module boundaries); flat directories hiding domain structure (e.g. 100+ loose handler files with no src/ layout); the same concept named differently in different modules; missing or abused canonical patterns of this stack — first read the repo's own conventions (AGENTS.md/CLAUDE.md) and respect its house pattern; circular or tangled imports; logic stranded in a component/handler that belongs in a pure module.
For every finding give the TARGET structure (the folder layout or module boundary to move to), not just the complaint.
EOF
    ;;
    tests)
        cat <<'EOF'
EXPERT PERSONA: You are a test architect — an expert in test pyramid economics: which tests earn their runtime, which are theater, and where the risk actually lives.

You hunt ONLY test waste and test gaps.
Hunting grounds: always-green tests — assertions on a mock against itself, tautologies, tests re-implementing the function under test, error paths asserted as success; test failure modes that cannot be observed (swallowed errors); duplicated fixtures vs the repo's existing test harness — find and respect it, don't fight it; heavy suites proving what a cheaper test already covers; MISSING tests around genuinely risky logic (permissions/access control, estimates/scores, date and timezone math, migration paths, external-file import parsing) — name the risky behavior and the level (unit/integration/e2e) that fits.
For every test to DELETE, say why its assertions are vacuous or redundant — a deletion without that reason is not a finding.
EOF
    ;;
    docs)
        cat <<'EOF'
EXPERT PERSONA: You are a technical documentation lead: reader-advocate, expert in doc information architecture (Diátaxis thinking: tutorials, how-to, reference, explanation — each page one job).

You hunt ONLY documentation defects. Hard product rule you enforce: product docs never cite tracker artifacts — no ADR numbers, epic/story ids, scenario ids, issue or PR numbers.
Hunting grounds: README/docs claims that no longer match the code (commands, env vars, setup steps, ports, URLs) — verify each claim against the actual scripts/configs/package.json before flagging; missing docs for real user journeys (deploy, first-run bootstrap, API auth, integrations); duplicated content that has drifted between pages/READMEs; developer docs confused with product docs (docs/ is user-facing; specs/ and AGENTS.md are internal); pages mixing tutorial and reference into neither.
A stale claim you verified against code is a finding; a style preference is not.
EOF
    ;;
    ui)
        cat <<'EOF'
EXPERT PERSONA: You are a senior UI engineer and design-system expert — a CSS specialist who audits design coherence: every surface of a product should look like the same team shipped it.

You hunt ONLY design-coherence and UI-quality problems across the website.
First read web/src/styles.css to learn the token vocabulary (CSS variables, utility classes) — that is the canonical design language.
Hunting grounds: drift from the design system — this repo has primitives in web/src/components/ (ui.tsx, DataTable, Avatar, EmptyState, dialogs) — inline one-off restyles, raw hex colors instead of existing CSS variables, components reinventing an existing primitive a few files over; inconsistent spacing scale, typography, border-radius, shadows, focus-visible treatments between similar surfaces; inconsistent empty/loading/error states across pages (skeleton vs spinner vs blank); accessibility failures: keyboard traps, missing focus rings, icon-only buttons without aria-label, contrast failures; compare patterns across several unrelated routes (dialogs, tables, forms, toasts) — coherence is cross-page, not within one file.
Mobile/desktop fit: you are ALSO the responsive-design and cross-browser specialist. Hunt: dense desktop-only layouts that break on small viewports (fixed widths, overflowing tables without a mobile strategy, hover-only affordances with no touch path, drawers/modals wider than the viewport); touch targets below ~44px; any mobile-specific surface drifting from the desktop design system; viewport/scroll bugs (missing `viewport-fit`, body scroll leaking behind modals on iOS, `100vh` on mobile Safari); input-zoom from font-size <16px; media queries that duplicate component logic instead of the token scale; missing dark-mode/`prefers-reduced-motion`/`prefers-color-scheme` where the rest of the app honors them; sticky elements without fallback for older Safari; features that silently rely on APIs newer browsers lack (check for polyfill/feature-detect patterns or a documented browserslist).
For every finding cite BOTH the drift site AND the canonical primitive/treatment it should reuse.
EOF
    ;;
    sql)
        cat <<'EOF'
EXPERT PERSONA: You are a PostgreSQL database expert — schema modeler and query-performance specialist: relational design, indexing strategy, query plans.

You hunt ONLY PostgreSQL schema and query problems.
Hunting grounds: entities/tables that are really one entity split (or one table doing two jobs); missing or wrong relations/foreign keys vs how the code actually joins; queries fighting the schema — missing indexes for hot WHERE/ORDER BY patterns, N+1 loops in handlers (a query inside a per-row map), repeated query fragments many files over that a shared helper or SQL view should own; unbounded queries (no LIMIT on list endpoints over growing tables); multi-write invariants without a transaction; migration hygiene (idempotency, destructive changes; respect any required impact marker this repo's migrations enforce); SELECT * where a narrow projection would do; jsonb blobs hiding relational data.
Cite file:line of both the query and (where relevant) the migration defining the schema.
EOF
    ;;
    api-design)
        cat <<'EOF'
EXPERT PERSONA: You are a REST API design authority — the reviewer who reads a routing table and sees through to resource modeling, semantics, and developer experience. You design APIs other engineers describe as "obvious".

You hunt ONLY RESTful-API and API-DX problems. Discover this repo's API surface first: the router/server entry module and its OpenAPI/documented contract (find them — e.g. grep for route registrations; if the repo has no HTTP API, reply [] immediately).
Hunting grounds:
- Resource modeling: URI nouns not matching the resource returned; verbs in paths (POST /features/:id/assign is fine for a state transition, /getFeature is not); singular/plural drift; resources that should be sub-resources for nesting instead of scattered flat routes; operations not expressable as resource state changes done as RPC-looking endpoints.
- Semantics: status-code misuse (200 for created, 200/2xx on failure paths, 404 vs 403 for hidden resources, 400 vs 422 for validation); PATCH vs PUT confusion; query params doing body's job; missing pagination on collection endpoints.
- CONSOLIDATION (a priority): overlapping/duplicate endpoints — two routes returning the same/overlapping resource shapes, near-identical shapes that merged resources would replace, endpoints with a single caller that a broader one absorbs; cli/ and mcp/ are consumers — check them too. Name the surviving endpoint and what it absorbs.
- Documentation: endpoints missing from the OpenAPI spec, spec drift (schema vs actual handler/zod contract), wrong error-code documentation, missing auth/side-effect notes on an endpoint.
- Consistency: authentication pattern drift between routes; error-body shape drift between handlers; naming that differs from the REST of the API.
Every finding gets a concrete target shape (route, status code, spec entry) and, for consolidations, the caller list to update.
EOF
    ;;
    security)
        cat <<'EOF'
EXPERT PERSONA: You are an application-security reviewer — OWASP-mindset, expert in injection, trust boundaries, and secrets hygiene. You review code as an attacker would.

You hunt ONLY security defects.
Hunting grounds: injection (SQL, command, path traversal, template); hardcoded secrets/keys/tokens; auth/authz gaps (endpoints trusting client input for identity, missing ownership checks, IDOR); unsafe deserialization; SSRF via user-supplied URLs; secrets leaked into logs; permissive CORS/cookie flags; vulnerable dependency versions pinned in manifests. Verify reachability before flagging config-only issues.
Every finding needs the concrete attack or misuse path: WHO supplies WHAT input, and WHAT breaks.
EOF
    ;;
    slop)
        cat <<'EOF'
EXPERT PERSONA: You are an AI-code auditor — a specialist in LLM-written code failure modes: hallucination dressed as implementation.

You hunt ONLY AI slop and hallucination, not general bugs (other lenses own those).
Hunting grounds: calls to APIs/functions/deps that don't exist (verify each import and call target actually resolves — an import of a non-export is a slop finding); fabricated or no-op test assertions that always pass; stubs, TODOs and placeholder handlers masquerading as finished behavior; plausible-but-wrong logic near a hyper-specific comment; copy-paste drift (a block duplicated with one stale variable); narration comments restating the code; error handling that logs and continues as if it succeeded. Control-group every suspicious symbol: grep for its definition and for exports before flagging.
EOF
    ;;
    bugs)
        cat <<'EOF'
EXPERT PERSONA: You are a staff-level correctness reviewer — the engineer others bring their scariest diff to. You review contracts and edge cases, not style.

You hunt ONLY correctness bugs that an improvement roadmap must fix BEFORE refactoring reorganizes them out of sight.
Hunting grounds: contract drift between API and consumers (zod schema vs actual handler vs web/src/api.ts caller); missing or incorrect error handling, silently swallowed failures; trust-boundary validation (auth, permissions, api keys, parsing of externally-supplied files and webhooks); race conditions (cron, scheduler, concurrent status changes on the same feature); timezone/date arithmetic; off-by-one and boundary conditions in lifecycle and status-transition logic.
Every finding needs the concrete trigger: WHAT input or state, and WHAT goes wrong. Mark severity honestly — this roadmap will be delivered in phases.
EOF
    ;;
    *) die "no expert brief for lens '$1'" ;;
    esac
}

PROJECT_LIMITS="Project limits: report AT MOST $FINDINGS_CAP findings — the worst ones. A finding below noise is not worth the roadmap's attention. If nothing rises above noise, reply exactly [ ] — an empty array is a valid, expert answer."
FINDING_SCHEMA='Reply with ONLY a JSON array, no markdown fences, no prose, no summary. Each element: {"file":"<path relative to repo root>","line":<number>,"severity":"high|med|low","title":"<short>","what":"<concrete problem>","why":"<impact>","fix":"<specific remediation>"}'
HARD_BOUND='HARD BOUND — obey exactly: read at most ~40 files, then STOP and report. Decisive beats exhaustive. Do not narrate, do not summarize what you read. Reply and stop.'

# ---------- steps ----------

step_init() {
    if [ -e "$WORKTREE/.git" ]; then
        log "worktree $WORKTREE exists — keeping it (resume)"
    else
        # NB: do NOT mkdir the state dir first — worktree add refuses a
        # pre-existing target path, and $STATE lives INSIDE the worktree.
        git -C "$REPO" fetch origin >/dev/null 2>&1 || log "fetch failed — proceeding with local $BASE_REF"
        git -C "$REPO" worktree add --detach "$WORKTREE" "$BASE_REF"
    fi
    mkdir -p "$STATE/tmp"
    log "worktree ready at $WORKTREE ($(git -C "$WORKTREE" rev-parse --short HEAD) of $BASE_REF)"
}

step_recon() {
    need_worktree
    mkdir -p "$STATE"
    if [ -f "$STATE/areas.json" ]; then
        log "areas.json exists — keeping it (resume). Delete it to re-partition."
    else
        git -C "$WORKTREE" ls-files | node "$LIB/partition.mjs" >"$STATE/partition.json"
        npart="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$STATE/partition.json")"
        log "deterministic partition: $npart areas"
        pf="$STATE/tmp/recon-prompt.txt"
        {
            echo "You are the recon scout of a whole-repo quality audit of $REPO_NAME, run by a cheap model to save the big models for real work. Your job: finalize the audit-area partition."
            echo "$REPO_CTX"
            echo "The deterministic partition (JSON array of {id,name,paths,loc,lenses}) is at: .audit/partition.json relative to repo root. Read that file."
            echo "Adjust boundaries ONLY where a split cuts a cohesive module apart or an area is oversized (>~30000 loc). Merge trivia. Keep 8..16 areas."
            echo "Lens rules: ui -> only web/src areas; sql -> only api areas; docs -> only the docs/README area; tests -> only areas containing test files; simplify,bugs,structure -> every code area (structure not on docs). Allowed lenses: $AUDIT_LENSES."
            echo "Reply ONLY with the final JSON array (exact same schema as partition.json). No fences, no prose."
            echo 'HARD BOUND: read at most ~15 files; this is boundary work, not an audit. Reply and stop.'
        } >"$pf"
        ok=0
        for attempt in 1 2 3; do
            log "scout pass $attempt ($SCOUT_PROVIDER/$SCOUT_MODEL)..."
            run_pi "$SCOUT_PROVIDER" "$SCOUT_MODEL" "$SCOUT_THINKING" read,grep,find,ls "$pf" "$STATE/tmp/recon-out.txt"
            if cp "$STATE/tmp/recon-out.txt" "$STATE/tmp/areas-candidate.json" 2>/dev/null \
               && valid_json "$STATE/tmp/areas-candidate.json" 1; then
                ok=1; break
            fi
            log "scout output invalid JSON — retrying"
        done
        if [ "$ok" = 1 ]; then
            mv "$STATE/tmp/areas-candidate.json" "$STATE/areas.json"
            log "scout partition accepted"
        else
            cp "$STATE/partition.json" "$STATE/areas.json"
            log "scout failed 3x — fell back to deterministic partition"
        fi
        node "$LIB/partition.mjs" validate "$STATE/areas.json" || die "areas.json failed validation"
    fi
    log "areas: $(node -e 'const a=require(process.argv[1]);console.log(a.map(x=>x.id+"("+x.loc+")").join(" "))' "$STATE/areas.json")"
}

run_pair() { # <lens> <area-file> -> on success $STATE/findings/<lens>__<area>.json
    _lens="$1"; _areaf="$2"
    _id="$(node -e 'const a=require(process.argv[1]);console.log(a.id)' "$_areaf")"
    _outf="$STATE/findings/${_lens}__${_id}.json"
    [ -s "$_outf" ] && return 0   # resume: already done
    _pf="$STATE/tmp/prompt-${_lens}__${_id}.txt"
    {
        expert_brief "$_lens"
        echo ""
        node -e '
const a=require(process.argv[1]);
console.log(`AREA "${a.name}" consists ONLY of these files (path; lens-relevant files only, listing capped):`);
const shown = a.paths.length > 120 ? a.paths.slice(0,120).concat([`... and ${a.paths.length-120} more (find them yourself)`]) : a.paths;
for (const p of shown) console.log(`  ${p}`);
' "$_areaf"
        echo ""
        echo "Work only inside those paths (plus module files they import, for context — but findings must land inside the area)."
        echo "$REPO_CTX"
        echo "$PROJECT_LIMITS"
        echo "$FINDING_SCHEMA"
        echo "$HARD_BOUND"
    } >"$_pf"
    _of="$STATE/tmp/raw-${_lens}__${_id}.txt"
    run_pi "$FINDER_PROVIDER" "$FINDER_MODEL" "$FINDER_THINKING" read,grep,find,ls "$_pf" "$_of"
    if valid_json "$_of" 0; then
        mv "$_of" "$_outf"                       # 0 findings is valid and kept
        echo "OK ${_lens} ${_id}: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$_outf") findings" >&2
        rm -f "${_of%.txt}.err"
    else
        echo "FAIL $_lens __${_id}" >&2
    fi
}

step_find() {
    need_state
    [ -f "$STATE/areas.json" ] || die "areas.json missing — run: audit.sh recon"
    mkdir -p "$STATE/findings" "$STATE/areas"
    node -e '
const fs=require("fs");
const areas=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
fs.rmSync(process.argv[2],{recursive:true,force:true});
fs.mkdirSync(process.argv[2],{recursive:true});
for(const a of areas) fs.writeFileSync(process.argv[2]+"/"+a.id+".json", JSON.stringify(a));
' "$STATE/areas.json" "$STATE/areas"
    AUDIT_LENSES="$AUDIT_LENSES" AREA_FILTER="$AREA_FILTER" node -e '
const fs=require("fs");
const lenses=process.env.AUDIT_LENSES.split(",").map(s=>s.trim()).filter(Boolean);
const areas=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const a of areas){
  if(process.env.AREA_FILTER && !(a.id+" "+a.name).includes(process.env.AREA_FILTER)) continue;
  for(const l of a.lenses) if(lenses.includes(l)) console.log(l+"\t"+a.id);
}
' "$STATE/areas.json" >"$STATE/tmp/pairs.txt"
    total="$(wc -l <"$STATE/tmp/pairs.txt" | tr -d ' ')"
    [ "$total" -ge 1 ] || die "no lens x area pairs matched (AREA_FILTER='$AREA_FILTER')"
    # ghost sweep: drop finding files from pairs no longer in this partition
    # (a re-partition must not let stale findings leak into the merge)
    node -e '
const fs=require("fs");
const keep=new Set(fs.readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(l=>l.split("\t").join("__")+".json"));
let dropped=0;
for(const n of fs.readdirSync(process.argv[2]).filter(n=>n.endsWith(".json"))){
  if(!keep.has(n)){ fs.rmSync(process.argv[2]+"/"+n); dropped++; }
}
if(dropped) console.log(`dropped ${dropped} finding files outside the current partition (ghost sweep)`);
' "$STATE/tmp/pairs.txt" "$STATE/findings" >&2
    done_n=0; while IFS='	' read -r lens area; do
        [ -s "$STATE/findings/${lens}__${area}.json" ] && done_n=$((done_n + 1))
    done <"$STATE/tmp/pairs.txt"
    n=1
    while [ "$n" -le "$total" ]; do
        end=$((n + CONCURRENCY - 1)); [ "$end" -gt "$total" ] && end=$total
        # NB: run the loop in THIS shell (no pipe) so `wait` actually waits for
        # the background children — piping into `while` would move the jobs into
        # a subshell and `wait` would return before any child finished.
        sed -n "${n},${end}p" "$STATE/tmp/pairs.txt" >"$STATE/tmp/slice.txt"
        while IFS='	' read -r lens area; do
            run_pair "$lens" "$STATE/areas/$area.json" &
        done <"$STATE/tmp/slice.txt"
        wait
        n=$((end + 1))
    done
    done_n=0; while IFS='	' read -r lens area; do
        [ -s "$STATE/findings/${lens}__${area}.json" ] && done_n=$((done_n + 1))
    done <"$STATE/tmp/pairs.txt"
    if [ "$done_n" -lt "$total" ]; then
        die "$((total - done_n)) of $total finders failed or produced no valid JSON. DONE children are kept; re-run 'audit.sh find' to retry the rest. Never read this as 'no findings'."
    fi
    log "all $total finders reported (results in $STATE/findings)"
}

run_verify_batch() { # <batch-id> -> on success $STATE/verified/<batch-id>.json (called with &)
    _batch="$1"
    _pf="$STATE/tmp/verify-$_batch-prompt.txt"
    {
        echo "EXPERT PERSONA: You are an adversarial verification board of senior specialists (architect, DB expert, test economist, security reviewer). For a repo-audit finding list, your job is to KILL findings, not to bless them: a claimed problem only survives if you cannot refute it. A finding you confirm without checking is worse than one you wrongly refute."
        echo "$REPO_CTX"
        echo "For EACH finding below, actively try to REFUTE it by reading the source (cwd = repo root), in order:"
        echo "1. source-confirmed — does the code actually show the described problem? If the line moved, grep for the symbol before refuting on a stale line number."
        echo "2. reachable — does a production (non-test) caller path exist? Test-only or dead code is refuted as out-of-scope (the dead-code sweep owns it)."
        echo "3. intentional — AGENTS.md, specs/ or an adjacent comment may document it as a deliberate convention; then refute or downgrade."
        echo "4. severity — re-rate honestly (scale: high|med|low — 'med' exactly, nothing else): high = ships wrong behavior, corrupts data, or blocks real users; med = real drag, wrong but tolerable; low = polish."
        echo "A finding may also be confirmed-but-downgraded; keep both parts."
        echo ""
        echo 'Reply with ONLY a JSON array, no fences, no prose: [{"id":<the given id>,"verdict":"confirmed|refuted|downgraded","severity":"<re-rated>","evidence":"<what you checked, 1-2 sentences>"}]'
        echo "HARD BOUND: ~4 file reads per finding at most; do not explore beyond refutation. Reply and stop."
        echo ""
        printf 'Findings to verify:\n%s\n' "$(cat "$STATE/verify-input/$_batch.json")"
    } >"$_pf"
    _of="$STATE/tmp/verify-$_batch.txt"
    run_pi "$PRO_PROVIDER" "$PRO_MODEL" "$PRO_THINKING" read,grep,find,ls "$_pf" "$_of"
    # valid_json alone cannot tell a VERDICT array from a findings array a
    # confused child echoed — require every element to carry id+verdict.
    if valid_json "$_of" 1 \
       && node -e 'const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(a.every(v=>v&&typeof v.id==="string"&&typeof v.verdict==="string")?0:1)' "$_of"; then
        mv "$_of" "$STATE/verified/$_batch.json"
        echo "OK verify $_batch" >&2
        rm -f "${_of%.txt}.err"
    else
        echo "FAIL verify $_batch (invalid JSON)" >&2
    fi
}

step_verify() {
    need_state
    [ -n "$(ls "$STATE/findings" 2>/dev/null)" ] || die "no findings — run: audit.sh find first"
    mkdir -p "$STATE/verified" "$STATE/verify-input" "$STATE/tmp"
    # If the findings set changed since last verify, stale verdicts may be
    # misaligned with (reassigned) finding ids — discard them and redo.
    fp="$( cd "$STATE/findings" 2>/dev/null && cat ./*.json | shasum | shasum | cut -d' ' -f1 )"; fp="${fp:-none}"
    stored=""; [ -f "$STATE/findings.fp" ] && stored="$(cat "$STATE/findings.fp")"
    if [ "$fp" != "$stored" ]; then
        if [ -n "$(ls "$STATE/verified" 2>/dev/null)" ]; then
            log "findings changed since last verify — discarding stale verdicts"
            rm -rf "$STATE/verified"; mkdir -p "$STATE/verified"
        fi
        echo "$fp" >"$STATE/findings.fp"
    fi
    VERIFY_BATCH="$VERIFY_BATCH_N" node "$LIB/aggregate.mjs" prep "$STATE" >"$STATE/tmp/batches.txt"
    total="$(wc -l <"$STATE/tmp/batches.txt" | tr -d ' ')"
    if [ "$total" -lt 1 ]; then
        log "nothing left to verify — all batches have verdicts"
    else
        log "verifying $total open batches on $PRO_MODEL (batch size $VERIFY_BATCH_N)"
        n=1
        while [ "$n" -le "$total" ]; do
            end=$((n + CONCURRENCY - 1)); [ "$end" -gt "$total" ] && end=$total
            # NB: loop in THIS shell (no pipe) so `wait` reaps the background
            # verify children; `sed | while` would orphan them into a subshell.
            sed -n "${n},${end}p" "$STATE/tmp/batches.txt" >"$STATE/tmp/vslice.txt"
            # shellcheck disable=SC2034  # tsv second col is batch count metadata
            		    while IFS='	' read -r batch _count; do
                run_verify_batch "$batch" &
            done <"$STATE/tmp/vslice.txt"
            wait
            n=$((end + 1))
        done
    fi
    # every finding must be covered by a verdict before merge proceeds
    node "$LIB/aggregate.mjs" check "$STATE" || die "some findings lack verdicts — re-run 'audit.sh verify' to retry the failed batches"
    log "verification complete: findings all covered by verdicts ($STATE/verified)"
}

step_aggregate() {
    need_state
    node "$LIB/aggregate.mjs" merge "$STATE" >"$STATE/tmp/aggregate.log" || die "merge failed — see $STATE/tmp/aggregate.log"
    node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync(process.argv[1]+"/findings.json","utf8"));
const by={}; for(const f of r) by[f.severity]=(by[f.severity]||0)+1;
console.log(`audit: findings.json — kept: ${r.length} by severity: ${JSON.stringify(by)} (refuted list in findings-refuted.json)`);
' "$STATE"
}

step_research() {
    need_state
    if [ -s "$STATE/research.md" ]; then
        log "research.md exists — keeping it (resume)"
        return 0
    fi
    topics_extra=""; [ -n "$RESEARCH_TOPICS" ] && topics_extra=" Also specifically investigate: $RESEARCH_TOPICS"
    pf="$STATE/tmp/research-prompt.txt"
    {
        echo "EXPERT PERSONA: You are a competitive-analysis and state-of-the-art researcher for developer-product tooling. You ground EVERY claim in a URL you actually fetched — no URL, no claim."
        echo "$REPO_CTX"
        echo "Task: first understand WHAT this product is (read README.md and the docs/ index — a delivery/roadmap management tool for product teams). Then research ONLINE:"
        echo "1. State of the art: what do the best tools in this class ship in 2024-2025 — roadmap planning, feature/OKR tracking, delivery dashboards, DORA metrics, proposal workflows? (Linear, Jira/Product Discovery, Shortcut, Productboard, Aha! are the obvious comparison set — go beyond it if you find better references.)"
        echo "2. Competing implementation patterns: REST API design of similar tools, MCP-server exposure of product data, iCal/CSV/import-export conventions people expect."
        echo "3. Concrete GAP LIST: capabilities or UX conventions that are now table stakes in this product class but that this repo appears to lack — CHECK the repo (you have read/grep tools) before declaring a gap; a gap we already cover is not a gap."
        echo "$topics_extra"
        echo "OUTPUT: write a markdown report titled 'State of the Art & Competitive Landscape'. Structure: (a) 5-8 sentence landscape summary; (b) table: capability | state of the art (with source URL) | our repo (evidence: file path) | gap verdict; (c) prioritized list of the 3-8 gaps that would most improve this product's competitiveness, each with the source URL that sets the bar. You are writing facts for engineers to act on, not marketing copy."
        echo "HARD BOUND: at most ~12 web searches/fetches and ~15 repo file reads. Cite only URLs you fetched or searched in this session. Reply and stop."
    } >"$pf"
    ok=0
    for attempt in 1 2 3; do
        log "research pass $attempt ($PRO_MODEL, web tools)..."
        run_pi "$PRO_PROVIDER" "$PRO_MODEL" "$PRO_THINKING" read,grep,find,ls,web_search,fetch_content "$pf" "$STATE/tmp/research-out.md"
        if [ -s "$STATE/tmp/research-out.md" ] && ! grep -qiE "^(sorry|i can('|no)t|i'm unable)" "$STATE/tmp/research-out.md"; then
            head -c 1 "$STATE/tmp/research-out.md" | grep -q '[^[:space:]]' && ok=1
        fi
        [ "$ok" = 1 ] && break
        log "research pass $attempt produced nothing usable — retrying"
    done
    [ "$ok" = 1 ] || die "research failed 3x — inspect $STATE/tmp/research-out.md and $STATE/tmp/research-out.md.err"
    cp "$STATE/tmp/research-out.md" "$STATE/research.md"
    log "research written: $STATE/research.md"
}

step_roadmap() {
    need_state
    if [ -s "$STATE/epics.json" ]; then
        log "epics.json exists — keeping it (resume)"
        return 0
    fi
    [ -s "$STATE/findings.json" ] || die "findings.json missing — run: audit.sh aggregate"
    # Two-stage clustering. One pass over the whole corpus underclusters: a
    # pro run mapped only ~110 of 653 findings into epics. Stage 1 clusters
    # EACH LENS separately (small prompt, every id must be mapped); stage 2
    # deterministically assembles the per-lens epics with a coverage check.
    mkdir -p "$STATE/epic-pass"
    for lens in $(echo "$AUDIT_LENSES" | tr ',' ' '); do
        [ -s "$STATE/epic-pass/$lens.json" ] && continue      # resume per lens
        node -e '
const fs=require("fs");
const all=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const perLens=all.filter(f=>f.lens===process.argv[2]);
fs.writeFileSync(process.argv[3], JSON.stringify(perLens));
' "$STATE/findings.json" "$lens" "$STATE/tmp/findings-$lens.json"
        count="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$STATE/tmp/findings-$lens.json")"
        if [ "${count:-0}" -lt 1 ]; then
            printf '[]' >"$STATE/epic-pass/$lens.json"
            continue
        fi
        pf="$STATE/tmp/roadmap-prompt-$lens.txt"
        {
            echo "EXPERT PERSONA: You are a principal engineer + delivery manager converting one expert lens's findings into improvement epics. You balance impact against merge pain."
            echo "$REPO_CTX"
            echo "The findings for lens '$lens' (JSON array, each with id) are in: .audit/tmp/findings-$lens.json — read that file."
            echo "Cluster ALL of them into 1..4 EPICS for this lens, one concern each. EVERY finding id must appear in EXACTLY ONE epic — an unassigned or duplicated id fails the run. Merge related findings aggressively; do NOT create one epic per finding."
            echo "Order ids inside each epic's findings array most-dangerous-first for $lens so the report renders priority first."
            echo "Each epic: {\"epic\":\"$lens-<kebab>\",\"title\":\"<human title>\",\"goal\":\"<one paragraph, the WHY>\",\"findings\":[<ids>],\"acceptance\":[\"<verifiable criterion>\"],\"parallelizable\":<bool>,\"depends_on\":[]} — epic names MUST be prefixed '$lens-' so the global assembly can order without collisions. depends_on may reference epics from other lenses (e.g. structure-* before tests-*). parallelizable=true only for disjoint-territory work."
            echo "Reply with ONLY the JSON array. No fences, no prose. HARD BOUND: read the one findings file, then reply and stop."
        } >"$pf"
        ok=0
        for attempt in 1 2 3; do
            log "roadmap ($lens) pass $attempt on $PRO_MODEL ($count findings)..."
            run_pi "$PRO_PROVIDER" "$PRO_MODEL" "$PRO_THINKING" read,grep,find,ls "$pf" "$STATE/tmp/roadmap-$lens-out.txt"
            if cp "$STATE/tmp/roadmap-$lens-out.txt" "$STATE/tmp/epics-$lens-candidate.json" 2>/dev/null \
               && node -e '
const fs=require("fs");
const ep=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const want=new Set(JSON.parse(fs.readFileSync(process.argv[2],"utf8")).map(f=>f.id));
const seen=new Set(); let bad=0;
for(const e of ep){ if(!Array.isArray(e.findings)) bad++; for(const id of e.findings||[]){ if(seen.has(id)) bad++; seen.add(id); } }
const missing=[...want].filter(i=>!seen.has(i));
if(bad||missing.length){ console.error("unmapped:"+missing.length+" dup/bad:"+bad); process.exit(1); }
' "$STATE/tmp/epics-$lens-candidate.json" "$STATE/tmp/findings-$lens.json" 2>/dev/null; then
                ok=1; break
            fi
            log "roadmap ($lens) output invalid or ids unmapped — retrying"
        done
        if [ "$ok" = 1 ]; then
            mv "$STATE/tmp/epics-$lens-candidate.json" "$STATE/epic-pass/$lens.json"
        else
            # 3 failures: fallback bucket epic instead of dying — resume can
            # retry just this lens by deleting epic-pass/<lens>.json
            log "roadmap ($lens) failed 3x — using fallback bucket epic"
            node -e '
const fs=require("fs");
const fl=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
fs.writeFileSync(process.argv[2], JSON.stringify([{epic:process.argv[3]+"-triage",title:process.argv[3]+" triage",goal:"Fallback bucket: per-lens clustering failed 3x; triage these findings by hand.",findings:fl.map(f=>f.id),acceptance:["every finding triaged to an epic or closed"],parallelizable:true,depends_on:[]}]));' "$STATE/tmp/findings-$lens.json" "$STATE/epic-pass/$lens.json" "$lens"
        fi
    done
    # stage 2: deterministic assembly with a coverage check
    node "$LIB/assemble-epics.mjs" "$STATE" >"$STATE/epics.json" || die "epic assembly failed"
    log "roadmap: $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).length)' "$STATE/epics.json") epics assembled"
}

step_report() {
    need_state
    [ -s "$STATE/findings.json" ] || die "findings.json missing — run: audit.sh aggregate"
    [ -s "$STATE/epics.json" ] || die "epics.json missing — run: audit.sh roadmap"
    node "$LIB/report.mjs" report "$STATE" "$REPO_NAME" "$(git -C "$WORKTREE" rev-parse --short HEAD)" "$BASE_REF" >"$STATE/report.md"
    log "report written: $STATE/report.md ($(wc -l <"$STATE/report.md" | tr -d ' ') lines)"
}

step_issues() {
    need_state
    [ -s "$STATE/epics.json" ] || die "epics.json missing — run: audit.sh roadmap"
    node "$LIB/report.mjs" issues "$STATE" || die "issue rendering failed"
    repo="${GH_REPO:-$(git -C "$REPO" remote get-url origin | sed -E 's#.*[:/]([^/:]+)/([^/.]+)(\.git)?$#\1/\2#')}"
    log "target repo: $repo"
    # shellcheck disable=SC2034  # slug/body_file kept for readability of the tsv contract
    while IFS='	' read -r _slug title _body_file abs_path; do
        [ -s "$abs_path" ] || continue
        if [ "$DRY_RUN" = 1 ]; then
            log "DRY_RUN — would create: $title ($abs_path)"
            continue
        fi
        if gh issue list -R "$repo" --state open --limit 500 --json title -q '.[].title' 2>/dev/null | grep -qxF "$title"; then
            log "open issue exists, skipping: $title"
            continue
        fi
        # label must exist before it can be attached
        gh label create -R "$repo" audit --description "Repo audit finding" >/dev/null 2>&1 || true
        gh issue create -R "$repo" --title "$title" --body-file "$abs_path" --label audit \
            || gh issue create -R "$repo" --title "$title" --body-file "$abs_path"
        log "created issue: $title"
    done <"$STATE/issues.tsv"
}

step_status() {
    echo "== repo-audit state =="
    echo "REPO=$REPO  WORKTREE=$WORKTREE  BASE_REF=$BASE_REF  STATE=$STATE"
    if [ -e "$WORKTREE/.git" ]; then
        echo "worktree: OK ($(git -C "$WORKTREE" rev-parse --short HEAD))"
    else
        echo "worktree: MISSING (run: audit.sh init)"
    fi
    for f in areas.json findings.fp findings.json findings-refuted.json epics.json research.md report.md issues.tsv; do
        if [ -s "$STATE/$f" ]; then echo "have:   $f"; else echo "MISSING: $f"; fi
    done
    d="$STATE/findings"; [ -d "$d" ] && echo "findings/: $(ls "$d" | grep -c json) files"
    d="$STATE/verified"; [ -d "$d" ] && echo "verified/: $(ls "$d" | grep -c json) files"
    d="$STATE/issues";  [ -d "$d" ] && echo "issues/:   $(ls "$d" 2>/dev/null | grep -c md) bodies"
}

step_clean() {
    if [ -e "$WORKTREE/.git" ]; then git -C "$REPO" worktree remove --force "$WORKTREE"; fi
    log "cleaned worktree (state lived inside it)"
}

case "$STEP" in
init)      step_init ;;
recon)     step_recon ;;
research)  step_research ;;
find)      step_find ;;
verify)    step_verify ;;
aggregate) step_aggregate ;;
roadmap)   step_roadmap ;;
report)    step_report ;;
issues)    step_issues ;;
status)    step_status ;;
clean)     step_clean ;;
all)
    # Ordered so every expensive step lands before the ones that consume it.
    # A failed step aborts `all`; re-running resumes at the gap, keeping all
    # completed work — that is the crash/pause contract of this engine.
    for s in init recon research find verify aggregate roadmap report; do
        log "=== step: $s"
        "step_$s"
    done
    log "audit complete — report: $STATE/report.md (then: audit.sh issues)"
    ;;
*) die "$USAGE" ;;
esac
