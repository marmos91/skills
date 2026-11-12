#!/bin/sh
# run <model> <thinking> <tools: read|shell> <prompt-file> <out-file>; env SEAT_WORKTREE, SEAT_CTX, SEAT_MAX_TURNS
set -eu
model=$1 thinking=$2 tools=$3 prompt=$4 out=$5
list="Read,Grep,Glob"
[ "$tools" = shell ] && list="$list,Bash"
# Always --restricted: it keeps the file tools confined (--bare does not). A CLAUDE_CODE_OAUTH_TOKEN in the env
# still logs in. The prompt goes on stdin because --tools swallows a trailing arg.
set -- --restricted --strict-mcp-config
# --restricted confines the file tools to the cwd (the stage folder) and these folders.
[ -n "${SEAT_WORKTREE:-}" ] && set -- "$@" --add-dir "$SEAT_WORKTREE"
[ -n "${SEAT_CTX:-}" ] && set -- "$@" --add-dir "$SEAT_CTX"
[ -n "${SEAT_MAX_TURNS:-}" ] && set -- "$@" --max-turns "$SEAT_MAX_TURNS"
# File tools stay confined to the cwd and the --add-dir folders: an allow rule for Read would reach any path.
set -- "$@" --disallowedTools "Read(~/.ssh/**)" "Read(~/.config/**)" "Read(~/.aws/**)" "Read(~/.gnupg/**)"
# --restricted reads no settings files, so without this every piped or compound command waits for an
# approval that never comes. Shell seats run only for trusted authors: Bash can read any file the user can.
# The Bash sandbox (macOS seatbelt / Linux bubblewrap) keeps writes to the temp dirs: no write in $HOME, and none
# in the shared worktree, ctx or stage folder that other seats read. No unsandboxed escape hatch.
if [ "$tools" = shell ]; then
  sandbox=$(node -e 'console.log(JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    filesystem: { denyWrite: process.argv.slice(1).filter(Boolean) } } }))' "${SEAT_WORKTREE:-}" "${SEAT_CTX:-}" "$PWD")
  set -- "$@" --allowedTools Bash --settings "$sandbox"
  # The lens asks for 60 s; seats ignored it (a 420 s test run, twice). This is the hard cap.
  export BASH_DEFAULT_TIMEOUT_MS=60000 BASH_MAX_TIMEOUT_MS=120000
fi
claude -p "$@" --model "$model" --effort "$thinking" --tools "$list" <"$prompt" >"$out"
