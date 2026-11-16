---
name: secret-scan
description: "One check before any push or post: scan a diff, commits, a PR body, a review comment or an issue for secrets (gitleaks when installed, built-in patterns without it), private infrastructure names from a local untracked list, and values from your sops-rendered files. Prints only masked hits; a hit blocks; a local allow list with reasons lets a false hit through. pr-review, pr-respond and pr-open use it. Use on 'secret-scan', 'scan for secrets', 'is this safe to push', 'check this before I post'."
metadata:
  version: "0.5.0" # x-release-please-version
---

# secret-scan: one check before any push or post

`secret-scan` reads text on stdin, the files you name, or the commits of
`--range <a..b>`, and exits: `0` clean, `1` a hit, `2` a usage or read
error (a bad range too; the hits found so far print first). Each hit is
one line on stderr:

```
github-token: ghp_… (src/config.js:12, fp 3fa9c0d21b7e)
```

the rule, the first characters of the match (at most 4, never all of a
short one), where it is (`file:line` in a
unified diff or a named file, else `line N`), and a fingerprint. It never
prints a full match, and never prints the private list or the sops values.

```sh
secret-scan --range origin/main..HEAD             # the commits you are about to push
d=$(mktemp) && git diff --cached --text --no-ext-diff --no-textconv > "$d" && secret-scan "$d"   # what you are about to commit
secret-scan < body.md                             # a PR body, a comment, an issue
secret-scan --repo owner/repo < body.md           # name the repo the text goes to
```

Scan the diff or the text, not the whole history, unless the user asks.
`--range` (never empty) runs `git log -p --cc --text --no-ext-diff --no-textconv --no-relative`: merge
commits and files marked `-diff` show their patch, and no textconv (which
could decrypt sops files) runs. pr-open uses the same command. Do not pipe
`git` into the scan: a git error gives empty input, and the scan passes;
write to a file with `&&`, as above.

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
| `sops-files.txt` | the path of a file sops-nix renders (for example a kubeconfig or `~/.aws/credentials`). A relative path is in the config folder. JSON leaves, and per line the whole line and the value of `key = value`, `key: value`, `export KEY=value` or `- item` (an inline ` #` or ` ;` comment and quotes removed) count; keys, values under 12 characters and values with spaces do not. A missing file is skipped. |
| `allow.txt` | `<fp> <reason>`: the hit with that fingerprint does not block. A line without a reason allows nothing. gitleaks hits have no fingerprint (its report is redacted, so the value never touches the disk): allow one with a `gitleaks:allow` comment on the line, or an allowlist in the gitleaks config (`GITLEAKS_CONFIG`). |
| `private-repos.txt` | `owner/repo`: a private repo where the `private.txt` set is skipped. Secrets and sops values are still checked. Remove the line if the repo goes public. The CLI opts out only with `--repo`; without it the scan is strict (the folder's origin can be a private fork of a public repo). `--repo` can be given more than once (the PR target and the push remote): the opt-out needs every one listed. pr-review and pr-respond pass the PR's repo; pr-open passes the repo `gh` opens the PR in and the origin it pushes to (`--repo` twice). Text sent to jev has no repo and gets the strict set. |

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
  `secret-scan --repo <target>` (`PR_OPEN_SECRET_SCAN` overrides the path).
- When pr-review holds a comment and you answer "post", the built-in
  patterns are redacted; a private name or a sops value still hits, so the
  comment stays out and the run log says which rules.

## Rules

- Never print, quote or paste a hit in full, and never print the lists.
- Never add an allow line without the user's yes and a reason.
- Never work around a hit (splitting or encoding the value); remove it.
