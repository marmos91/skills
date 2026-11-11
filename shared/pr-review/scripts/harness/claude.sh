#!/bin/sh
# run <model> <thinking> <tools: read|shell> <prompt-file> <out-file>; env SEAT_WORKTREE, SEAT_MAX_TURNS
set -eu
model=$1 thinking=$2 tools=$3 prompt=$4 out=$5
list="Read,Grep,Glob"
[ "$tools" = shell ] && list="$list,Bash"
# --bare drops the login unless a token is set; prompt goes on stdin because --tools swallows a trailing arg.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  set -- --bare --strict-mcp-config
else
  set -- --restricted --strict-mcp-config
fi
[ -n "${SEAT_WORKTREE:-}" ] && set -- "$@" --add-dir "$SEAT_WORKTREE"
[ -n "${SEAT_MAX_TURNS:-}" ] && set -- "$@" --max-turns "$SEAT_MAX_TURNS"
# --restricted reads no settings files, so no allow rule applies: without --allowedTools every
# compound or piped Bash command waits for an approval that never comes.
claude -p "$@" --model "$model" --effort "$thinking" --tools "$list" --allowedTools "$list" <"$prompt" >"$out"
