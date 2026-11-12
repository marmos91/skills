// Test helper: a temp git repo with its own config and an SSH signing key. Never reads the user's git config.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

export const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

let key;
function signingKey() {
  if (key) return key;
  const d = mkdtempSync(join(tmpdir(), "pr-open-key-"));
  key = join(d, "id");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  return key;
}

/** New repo on branch main with one signed commit. With origin: true, also a bare origin with main pushed. */
export function initRepo({ origin = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pr-open-repo-"));
  git(dir, "init", "-q", "-b", "main");
  for (const [k, v] of [["user.name", "T"], ["user.email", "t@example.com"], ["gpg.format", "ssh"], ["user.signingkey", signingKey()], ["commit.gpgsign", "false"]]) git(dir, "config", k, v);
  commit(dir, "README.md", "x\n", "init", { sign: true });
  if (origin) {
    const bare = mkdtempSync(join(tmpdir(), "pr-open-origin-"));
    git(bare, "init", "-q", "--bare", "-b", "main");
    git(dir, "remote", "add", "origin", bare);
    git(dir, "push", "-q", "-u", "origin", "main");
  }
  return dir;
}

export function commit(dir, file, content, msg, { sign = true } = {}) {
  writeFileSync(join(dir, file), content);
  git(dir, "add", file);
  git(dir, "commit", "-q", sign ? "-S" : "--no-gpg-sign", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}
