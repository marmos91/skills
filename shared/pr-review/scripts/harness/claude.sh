#!/bin/sh
# run <model> <thinking> <tools: read|shell> <prompt-file> <out-file>
set -eu
model=$1 thinking=$2 tools=$3 prompt=$4 out=$5
list="Read,Grep,Glob"
[ "$tools" = shell ] && list="$list,Bash"
# --bare drops the login unless a token is set; prompt goes on stdin because --tools swallows a trailing arg.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  set -- --bare
else
  set -- --restricted --strict-mcp-config
fi
claude -p "$@" --model "$model" --effort "$thinking" --tools "$list" <"$prompt" >"$out"
