#!/usr/bin/env bash
# marmos91/skills install — symlink every skill into its agent's skills dir.
# Idempotent; re-run after pulling. --rm uninstalls (removes symlinks only).
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_DIR:-$HOME/.pi/agent/skills}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude/skills}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

link() { # link <src-dir> <dest-dir>
    local src="$1" dest="$2"
    local name
    name="$(basename "$src")"
    if [ -L "$dest/$name" ]; then
        if [ "$(readlink "$dest/$name")" = "$src" ]; then
            echo "  $name: already linked"
        else
            echo "  $name: re-linking (was -> $(readlink "$dest/$name"))"
            ln -sfn "$src" "$dest/$name"
        fi
    elif [ -e "$dest/$name" ]; then
        # real dir/file: replace with symlink, keeping a one-time backup
        echo "  $name: WARNING replacing local copy with symlink (backup at $name.pre-skills-repo)"
        mv "$dest/$name" "$dest/$name.pre-skills-repo"
        ln -s "$src" "$dest/$name"
    else
        ln -s "$src" "$dest/$name"
        echo "  $name: linked"
    fi
}

unlink() { # unlink <dest-dir>
    local dest="$1"
    for l in "$dest"/*; do
        [ -L "$l" ] || continue
        case "$(readlink "$l")" in
            "$REPO"/*) rm "$l"; echo "  removed $(basename "$l")" ;;
        esac
    done
}

if [ "${1:-}" = "--rm" ]; then
    echo "Removing $REPO symlinks from agent skill dirs and $BIN_DIR:"
    unlink "$PI_DIR"; unlink "$CLAUDE_DIR"; unlink "$BIN_DIR"
    exit 0
fi

install_group() { # install_group <src-root> <dest-dir>
    local src="$1" dest="$2"
    [ -d "$src" ] || return 0
    mkdir -p "$dest"
    for d in "$src"/*/; do link "${d%/}" "$dest"; done
}

echo "Installing skills into:"
echo "  pi: $PI_DIR";      install_group "$REPO/pi" "$PI_DIR"
echo "  claude: $CLAUDE_DIR"; install_group "$REPO/claude" "$CLAUDE_DIR"
echo "  shared -> both";     install_group "$REPO/shared" "$PI_DIR"; install_group "$REPO/shared" "$CLAUDE_DIR"

echo "  tools: $BIN_DIR"; mkdir -p "$BIN_DIR"
for b in "$REPO"/shared/*/bin/*; do [ -e "$b" ] && link "$b" "$BIN_DIR"; done

echo "Done. (Uninstall: ./install.sh --rm)"
