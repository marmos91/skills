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
# File tools stay confined to the cwd and the --add-dir folders: an allow rule for Read would reach any path.
set -- "$@" --disallowedTools "Read(~/.ssh/**)" "Read(~/.config/**)" "Read(~/.aws/**)" "Read(~/.gnupg/**)"
# --restricted reads no settings files, so without this every piped or compound command waits for an
# approval that never comes. Shell seats run only for trusted authors: Bash can read any file the user can.
[ "$tools" = shell ] && set -- "$@" --allowedTools Bash
claude -p "$@" --model "$model" --effort "$thinking" --tools "$list" <"$prompt" >"$out"
