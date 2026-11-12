#!/bin/sh
# review-lens.sh <lens> <range> — 3-lens gate template for repo-audit-fix.
# Use as LENS=<this file> or copy into the repo as scripts/review-lens.sh.
#
# Contract (what fix.sh relies on):
#   exit 0       = pass: zero BLOCKING findings (NIT-only output still exits 0)
#   exit non-0   = fail: >=1 BLOCKING finding, malformed reply, or child failure
#   stdout       = the review; findings as lines "- BLOCKING ..." / "- NIT ...".
#                  fix.sh sends BLOCKING lines to the revise round and NIT lines
#                  to the PR body.
# Optional env (set by fix.sh on gate rounds >= 2; ignore them and you are still
# compatible, just slower to converge):
#   LENS_PRIOR   file with this lens's BLOCKING findings from the last gated round
#   LENS_DELTA   git range <last-gated-sha>..<branch>: what changed since then
set -u
LENS_NAME="${1:?lens}"
RANGE="${2:?range e.g. origin/main...branch}"
REPO_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
OUT="$(mktemp)"; ERR="$(mktemp)"; PROMPT="$(mktemp)"
trap 'rm -f "$OUT" "$ERR" "$PROMPT"' EXIT

case "$LENS_NAME" in
adversarial)
    BRIEF='EXPERT PERSONA: You are a hostile senior reviewer whose job is to KILL this change. Try hard to find: unhandled failure modes, broken edge cases, security holes the author glazed over, regressions to callers, and requirements silently dropped from the fix plan. A finding without file:line evidence in the diff or touched files is not a finding.'
    ;;
correctness)
    BRIEF='EXPERT PERSONA: You are a meticulous correctness reviewer. Verify each change does exactly what its commit/plan claims: guards on the real condition, error handling present where the code can actually fail, no off-by-one/inverted logic, callers consistent with the change. Check syntax correctness for the touched files.'
    ;;
simplification)
    BRIEF='EXPERT PERSONA: You are a ruthlessly lazy senior engineer. Hunt ONLY unnecessary additions in the diff: dead code, speculated flexibility, reimplementation of existing helpers, over-verbose implementation of a one-liner. Severity for THIS lens: BLOCKING only for dead code (unreachable/unused/inert, e.g. a test that cannot fail) or a real bug; everything else (naming, comments, could-be-shorter, style taste) is NIT.'
    ;;
*) echo "unknown lens: $LENS_NAME" >&2; exit 2 ;;
esac

{
    echo "$BRIEF"
    echo ""
    echo "Repo: $REPO_DIR (work here; read full files for context — review the CHANGE, not the repo)."
    if [ -n "${LENS_DELTA:-}" ]; then
        echo "This is a RE-REVIEW. The full change is $RANGE; since your last review only $LENS_DELTA changed."
        if [ -s "${LENS_PRIOR:-}" ]; then
            echo "Step 1: your prior BLOCKING findings are below. For EACH, verify against the current code whether it is resolved (or credibly refuted in a code comment/commit). Unresolved ones are re-raised as BLOCKING, citing current file:line."
            echo "--- prior BLOCKING findings ---"
            cat "$LENS_PRIOR"
            echo "--- end prior ---"
        fi
        echo "Step 2: run  git diff $LENS_DELTA  and raise NEW BLOCKING findings ONLY for problems the delta introduces. Code outside the delta was already reviewed: do not raise new findings on it."
    else
        echo "Run: git diff $RANGE --stat  then  git diff $RANGE"
        echo "Also inspect any files the diff touches (read them fully) and grep for callers affected."
    fi
    cat <<'RULES'

Severity:
- BLOCKING: the change is wrong or unsafe to merge (bug, regression, security hole, dropped requirement, dead code).
- NIT: worth mentioning, not worth another review round (style, naming, comments, minor taste). NITs never fail the gate.
- A lens finding may be wrong: if you are not confident, do not report it.
Reply with:
VERDICT: PASS     (zero BLOCKING findings; NITs allowed)
or
VERDICT: FAIL
then
FINDINGS:
- BLOCKING file:line — problem — fix
- NIT file:line — problem — fix
RULES
} >"$PROMPT"

if ( cd "$REPO_DIR" && pi -p --provider "${REVIEW_PROVIDER:-cubbit}" --model "${REVIEW_MODEL:-cubbit/mimir}" \
      --thinking "${REVIEW_THINKING:-high}" --tools read,bash,grep,find --no-session "$(cat "$PROMPT")" ) </dev/null >"$OUT" 2>"$ERR"; then
    :
else
    echo "review-lens: child failed" >&2; sed -n 1,10p "$ERR" >&2; exit 1
fi
cat "$OUT"
grep -q "VERDICT:" "$OUT" || { echo "review-lens: no VERDICT line" >&2; exit 1; }
grep -Eq '^[[:space:]]*[-*][[:space:]]*\**BLOCKING' "$OUT" && exit 1
grep -q "VERDICT: PASS" "$OUT" && exit 0
# FAIL with only NIT findings is a pass; FAIL with untagged findings is not
grep -Eq '^[[:space:]]*[-*][[:space:]]*\**NIT' "$OUT" && exit 0
exit 1
