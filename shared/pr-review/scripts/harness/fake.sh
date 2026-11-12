#!/bin/sh
# Test adapter. PR_REVIEW_FAKE is a file whose content becomes the output, or a folder:
# then the output is <folder>/<out-file name>, each start is logged to <folder>/starts.log,
# and <folder>/<out-file name>.hang makes the child hang (for signal tests).
# PR_REVIEW_FAKE_ENV, if set, receives the child environment.
set -eu
[ -n "${PR_REVIEW_FAKE_ENV:-}" ] && env >"$PR_REVIEW_FAKE_ENV"
if [ -d "$PR_REVIEW_FAKE" ]; then
  name=$(basename "$5")
  echo "$name" >>"$PR_REVIEW_FAKE/starts.log"
  [ -e "$PR_REVIEW_FAKE/$name.hang" ] && sleep 60
  cat "$PR_REVIEW_FAKE/$name" >"$5"
else
  cat "$PR_REVIEW_FAKE" >"$5"
fi
