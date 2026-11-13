#!/bin/sh
# run <model> <thinking> <tools: read|shell> <prompt-file> <out-file>; env SEAT_PROVIDER
set -eu
model=$1 thinking=$2 tools=$3 prompt=$4 out=$5
list="read,grep,find,ls"
[ "$tools" = shell ] && list="$list,bash"
# Prompt travels as an attached file: no argv size limit, no leading-dash trouble.
# pi -p reads stdin when piped and hangs: always </dev/null.
[ -n "${SEAT_PROVIDER:-}" ] && set -- --provider "$SEAT_PROVIDER" || set --
# json: one event per line; the last agent_end has the answer and the token usage. child.mjs unwraps it.
pi -p --mode json --no-session --no-context-files --no-extensions --no-skills --no-mcp \
  "$@" --model "$model" --thinking "$thinking" --tools "$list" \
  @"$prompt" "Do the task described in the attached file." </dev/null >"$out"
