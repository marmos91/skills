#!/usr/bin/env sh
# Tests lib/jev-gate.sh against a stub jev. Run: sh scripts/test/jev-gate.test.sh
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
STATE="$T/state"; JEV=auto; JEV_CONFIDENCE=0
log() { :; }
epic_dir() { echo "$STATE/$1"; }
. "$HERE/../lib/jev-gate.sh"

# stub jev: exit code per finding id from $T/fixture ("<id> <code>"), default 0;
# each call appends the id to $T/calls; exit 2 prints an outage error
mkdir -p "$T/bin"
cat >"$T/bin/jev" <<EOF
#!/usr/bin/env sh
id="\$(printf '%s' "\$2" | sed -n 's/.*marks finding \(.*\) as SKIP.*/\1/p')"
echo "\$id" >>"$T/calls"
rc="\$(awk -v id="\$id" '\$1==id {print \$2}' "$T/fixture")"
[ "\${rc:-0}" = 2 ] && echo "jev: API down" >&2
exit "\${rc:-0}"
EOF
chmod +x "$T/bin/jev"
PATH="$T/bin:$PATH"

fails=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: got [$2] want [$3]"; fails=$((fails+1)); fi; }
reset() {  # reset <fixture lines...>
    rm -rf "$STATE" "$T/calls"; mkdir -p "$STATE/E1"; : >"$T/calls"
    echo '{"findings":[{"id":"A","title":"ta"},{"id":"B","title":"tb"},{"id":"C","title":"tc"}]}' >"$STATE/E1/epic.json"
    echo plan >"$STATE/E1/plan.md"
    printf '%s\n' "$@" >"$T/fixture"
}
calls() { tr '\n' ' ' <"$T/calls"; }

# exit 0 = covered, exit 1 = gap
reset "B 1"
check "verdict exit 0 -> yes" "$(jev_verdict "marks finding A as SKIP" "$STATE/E1/plan.md")" yes
check "verdict exit 1 -> no" "$(jev_verdict "marks finding B as SKIP" "$STATE/E1/plan.md")" no
check "only the exit-1 finding is a gap" "$(plan_coverage_gaps E1)" "B: tb"

# exit 2 latches jev off: no more calls this run
reset "A 2" "B 1" "C 1"
check "outage gives no gaps" "$(plan_coverage_gaps E1)" ""
check "outage writes jev-down" "$(cat "$STATE/jev-down")" "jev: API down"
check "no call after the outage" "$(calls)" "A "
check "later verdicts are unsure" "$(jev_verdict "marks finding B as SKIP" "$STATE/E1/plan.md")" unsure

# a finding already in jev-flagged is not asked again
reset "A 1" "B 1" "C 1"
echo B >"$STATE/E1/jev-flagged"
check "flagged finding skipped" "$(plan_coverage_gaps E1 | tr '\n' ' ')" "A: ta C: tc "
check "flagged finding not asked" "$(calls)" "A C "

# crash before the save: gaps reported, nothing recorded, rerun asks again
reset "B 1"
check "gap reported" "$(plan_coverage_gaps E1)" "B: tb"
check "no id recorded before the save" "$(grep -cxF B "$STATE/E1/jev-flagged" || true)" 0
check "rerun reports it again" "$(plan_coverage_gaps E1)" "B: tb"
check "rerun asked B again" "$(grep -cxF B "$T/calls")" 2
# after the save: recorded once, never asked again
jev_flag E1 "B: tb"; jev_flag E1 "B: tb"
check "jev_flag is idempotent" "$(cat "$STATE/E1/jev-flagged")" B
: >"$T/calls"
check "saved gap not reported" "$(plan_coverage_gaps E1)" ""
check "saved gap not asked" "$(calls)" "A C "

# jev_save_revision: flag only after the plan is saved
reset
: >"$STATE/E1/jev-flagged"; echo new >"$STATE/E1/plan.tmp"
jev_save_revision E1 "B: tb" "$STATE/E1/plan.tmp" "$STATE/E1/plan.md"
check "save: plan saved and gap flagged" "$(cat "$STATE/E1/plan.md") $(cat "$STATE/E1/jev-flagged")" "new B"
reset
: >"$STATE/E1/jev-flagged"
jev_save_revision E1 "B: tb" "$STATE/E1/plan.tmp" "$STATE/E1/plan.md" 2>/dev/null || true
check "save fails: nothing flagged" "$(cat "$STATE/E1/jev-flagged")" ""

# fix.sh wiring: a revised plan goes through jev_save_revision, else a flagged gap is never recorded
FIX="$HERE/../fix.sh"
check "fix.sh saves the revised plan via jev_save_revision" "$(grep -c '^ *jev_save_revision "$_ep" "$_gaps" "$_dir/plan.tmp" "$_dir/plan.md"$' "$FIX")" 1
check "fix.sh moves plan.tmp directly only for the first draft" "$(grep -c 'mv "$_dir/plan.tmp" "$_dir/plan.md"' "$FIX")" 1

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
