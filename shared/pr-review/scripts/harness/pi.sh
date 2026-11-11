#!/bin/sh
# run <model> <thinking> <tools: read|shell> <prompt-file> <out-file>; env SEAT_PROVIDER
set -eu
model=$1 thinking=$2 tools=$3 prompt=$4 out=$5
list="read,grep,find,ls"
[ "$tools" = shell ] && list="$list,bash"
# pi -p reads stdin when it is a pipe and hangs: always /dev/null.
pi -p --no-session --no-context-files --no-extensions --no-skills --no-mcp \
  --provider "${SEAT_PROVIDER:-}" --model "$model" --thinking "$thinking" --tools "$list" \
  "$(cat "$prompt")" </dev/null >"$out"
