---
name: secret-scan
description: "One check before any push or post: scan a diff, commits, a PR body, a review comment or an issue for secrets (gitleaks when installed, built-in patterns without it), private infrastructure names from a local untracked list, and values from your sops-rendered files. Prints only masked hits; a hit blocks; a local allow list with reasons lets a false hit through. pr-review, pr-respond and pr-open use it. Use on 'secret-scan', 'scan for secrets', 'is this safe to push', 'check this before I post'."
metadata:
  version: "0.2.0" # x-release-please-version
---

# secret-scan: one check before any push or post

`secret-scan` reads text on stdin (or the files you name) and exits:
`0` clean, `1` a hit, `2` usage error. Each hit is one line on stderr:

```
github-token: ghp_… (src/config.js:12, fp 3fa9c0d21b7e)
```

the rule, the first 4 characters of the match, where it is (`file:line` in a
unified diff or a named file, else `line N`), and a fingerprint. It never
prints a full match, and never prints the private list or the sops values.

```sh
d=$(mktemp) && git log -p origin/main..HEAD > "$d" && secret-scan "$d"   # the commits you are about to push
git diff --cached | secret-scan                   # what you are about to commit
secret-scan < body.md                             # a PR body, a comment, an issue
secret-scan --repo owner/repo < body.md           # name the repo (else the origin of cwd)
```

Scan the diff or the text, not the whole history, unless the user asks.
Write a `git` range to a file first, as above: in a plain pipe a range that
does not resolve gives empty input, and the scan passes.

## What it finds

1. **Secrets:** gitleaks when it is on `PATH`; the built-in patterns
   (cloud keys, GitHub, Slack, Stripe and model API tokens, JWTs, private
   keys, age keys, bearer tokens) always. A gitleaks error fails closed.
2. **Private infrastructure:** internal hostnames, endpoints, IP ranges,
   bucket and account names, from `private.txt`.
3. **Values from sops:** every value of the files listed in
   `sops-files.txt`.

## Config

All in `~/.config/secret-scan/` (`SECRET_SCAN_CONFIG` overrides the
folder). Every file is optional, one entry per line. `#` at the start of a
line or after a space starts a comment; write `\#` for a `#` in a pattern.
A missing file is skipped; a file that is there but cannot be read (for
example root-owned) is a hit, `secret-scan: config unreadable`, so the scan
never passes without its lists. Keep the folder out of every repo.

| File | Line |
|---|---|
| `private.txt` | a regex, case-insensitive (a line that is not a valid regex is a literal). It can be rendered there by sops-nix, so the list lives encrypted in your dotfiles. |
| `sops-files.txt` | the path of a file sops-nix renders (for example a kubeconfig or `~/.aws/credentials`). JSON leaves, the value of `key = value` / `key: value` lines and bare lines count; keys, values under 12 characters and values with spaces do not. A missing file is skipped. |
| `allow.txt` | `<fp> <reason>`: the hit with that fingerprint does not block. A line without a reason allows nothing. gitleaks hits have no fingerprint (its report is redacted, so the value never touches the disk): allow one with a `gitleaks:allow` comment on the line, or an allowlist in the gitleaks config (`GITLEAKS_CONFIG`). |
| `private-repos.txt` | `owner/repo`: a private repo where the `private.txt` set is skipped. Secrets and sops values are still checked. Remove the line if the repo goes public. The CLI takes the repo from `--repo`, else the `origin` of the current folder; pr-review, pr-respond and pr-open pass the PR's repo. Text sent to jev has no repo and gets the strict set. |

## Steps

1. Run the scan on the text that is about to leave the machine.
2. Exit `0`: go on. Exit `1`: do not push or post. Show the user the hit
   lines; they hold no secret.
3. A real hit: remove it from the text (or from the commit: amend before
   the push). A false hit: ask the user; with a yes, add
   `<fp> <reason>` to `allow.txt`. Then scan again.

## Callers

- `pr-review` and `pr-respond` scan every comment, reply and summary before
  they post it with the same code (`pr-review/scripts/lib/secrets.mjs`).
- `pr-respond` runs `secret-scan` on the commits before each push.
- `pr-open` pipes the pushed commits, the title and the body into
  `secret-scan` (`PR_OPEN_SECRET_SCAN` overrides the path).

## Rules

- Never print, quote or paste a hit in full, and never print the lists.
- Never add an allow line without the user's yes and a reason.
- Never work around a hit (splitting or encoding the value); remove it.
