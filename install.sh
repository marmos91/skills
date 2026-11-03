#!/usr/bin/env bash
# marmos91/skills install — symlink every skill into its agent's skills dir.
# Idempotent; re-run after pulling. --rm uninstalls (removes symlinks only).
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
PI_DIR="${PI_DIR:-$HOME/.pi/agent/skills}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude/skills}"

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
    echo "Removing $REPO symlinks from agent skill dirs:"
    unlink "$PI_DIR"; unlink "$CLAUDE_DIR"
    exit 0
fi

echo "Installing skills into:"
[ -d "$REPO/pi" ] && { echo "  pi: $PI_DIR"; mkdir -p "$PI_DIR"; for d in "$REPO"/pi/*/; do link "${d%/}" "$PI_DIR"; done; }
[ -d "$REPO/claude" ] && { echo "  claude: $CLAUDE_DIR"; mkdir -p "$CLAUDE_DIR"; for d in "$REPO"/claude/*/; do link "${d%/}" "$CLAUDE_DIR"; done; }

echo "Done. (Uninstall: ./install.sh --rm)"
