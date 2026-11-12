#!/bin/sh
# Install the real tarball on a clean HOME, then run each CLI it links. Run from the repo root.
# CI runs it on each PR; the release job runs it before npm publish.
set -eu
tgz="$PWD/$(npm pack --ignore-scripts --silent)"
trap 'rm -rf "$tgz" "$home"' EXIT
home="$(mktemp -d)"
export HOME="$home"
npx --yes --package "$tgz" -- skills install --claude
"$HOME/.local/bin/pr-review" --help
"$HOME/.local/bin/pr-review-loop" --help
"$HOME/.local/bin/jev" --help
"$HOME/.local/bin/repo-audit" status
npx --yes --package "$tgz" -- skills list
