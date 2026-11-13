#!/bin/sh
# Install the real tarball on a clean HOME, then run each CLI it links. Run from the repo root.
# CI runs it on each PR; the release job runs it before npm publish.
set -eu
tgz="$PWD/$(npm pack --ignore-scripts --silent)"
trap 'rm -rf "$tgz" "$home"' EXIT
home="$(mktemp -d)"
export HOME="$home"
unset CLAUDE_DIR PI_DIR BIN_DIR # overrides beat HOME: they would point the installer at the real install
npx --yes --package "$tgz" -- skills install --claude
"$HOME/.local/bin/pr-review" --help
"$HOME/.local/bin/pr-review-loop" --help
"$HOME/.local/bin/pr-respond" --help
"$HOME/.local/bin/jev" --help
"$HOME/.local/bin/repo-audit" status
npx --yes --package "$tgz" -- skills list

# the dev clone: ./install.sh links the same CLIs to the working tree
if [ -d .git ] || [ -f .git ]; then
  rm -rf "$home" && mkdir -p "$home"
  ./install.sh
  for cli in pr-review pr-review-loop pr-respond jev; do "$HOME/.local/bin/$cli" --help >/dev/null; done
  "$HOME/.local/bin/repo-audit" status >/dev/null
  ./install.sh --rm
fi
