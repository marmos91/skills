#!/bin/sh
# Test adapter: PR_REVIEW_FAKE is a file whose content becomes the output.
# PR_REVIEW_FAKE_ENV, if set, receives the child environment.
set -eu
[ -n "${PR_REVIEW_FAKE_ENV:-}" ] && env >"$PR_REVIEW_FAKE_ENV"
cat "$PR_REVIEW_FAKE" >"$5"
