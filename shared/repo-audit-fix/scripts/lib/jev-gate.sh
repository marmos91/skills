# Sourced by fix.sh (needs log, epic_dir, STATE, JEV, JEV_CONFIDENCE).
# Tested by test/jev-gate.test.sh.

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
# never an endless loop. Read-only: the caller records the ids with jev_flag
# once the revise round they caused is on disk, so a crash re-asks.
plan_coverage_gaps() {
    _dir="$(epic_dir "$1")"
    touch "$_dir/jev-flagged"
    node -e '
const e=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
for (const f of e.findings) console.log([f.id, f.title, f.what].map(x=>String(x||"").replace(/[\t\n]/g," ")).join("\t"));' "$_dir/epic.json" |
    while IFS="$(printf '\t')" read -r _id _title _what; do
        grep -qxF "$_id" "$_dir/jev-flagged" && continue
        # wording picked by bench/jev: the old "...or states explicitly why that
        # finding is skipped" read 6 of 7 explicit skips as gaps
        _v="$(jev_verdict "The plan has a step that fixes this problem: $_title ($_what); or it marks finding $_id as SKIP and says why." "$_dir/plan.md")"
        if [ "$_v" = no ]; then echo "$_id: $_title"; fi
    done
}

# jev_flag <epic> <gaps> -> appends each gap's id to jev-flagged, idempotently.
jev_flag() {
    _fdir="$(epic_dir "$1")"
    printf '%s\n' "$2" | while IFS= read -r _fg; do
        [ -n "$_fg" ] || continue
        _fid="${_fg%%: *}"
        grep -qxF "$_fid" "$_fdir/jev-flagged" 2>/dev/null || echo "$_fid" >>"$_fdir/jev-flagged"
    done
}

# jev_save_revision <epic> <gaps> <tmp> <dest> -> saves the revised plan, then
# records the gaps: only once the revise round is on disk, so a crash before
# the save re-asks jev on resume instead of skipping the finding.
jev_save_revision() { mv "$3" "$4" && jev_flag "$1" "$2"; }
