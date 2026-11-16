// A clone of one case that holds only the case's commits: the fix, and every commit after the PR head, are out of
// reach of the seats (their shell can run git log). Checked before any model call.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { NAME } from "./score.mjs";

const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * src: the repo URL (or a local path in tests); root: the absolute folder of the clones, <root>/<id>. The clone's origin is a local bare repo with 2 refs:
 * refs/heads/<baseRef> at the case base and refs/pull/<pr>/head at the head, the 2 refs frame fetches.
 * So the engine diffs exactly base...head. Throws when the base is not an ancestor of the head.
 */
export function isolatedClone(src, root, c, baseRef) {
  // both folders are removed first: they must be this case's, under root
  if (!isAbsolute(root)) throw new Error(`clone root must be an absolute path, got ${root}`);
  if (!NAME.test(c.id)) throw new Error(`case id ${c.id} is not a safe folder name`);
  const dir = join(root, c.id), origin = join(root, `${c.id}.origin`);
  // shortcut: a fresh fetch of the whole head history per case and run; cache the origin when big repos join the cases
  for (const d of [dir, origin]) rmSync(d, { recursive: true, force: true });
  git("init", "-q", "--bare", origin);
  git("-C", origin, "fetch", "-q", "--no-tags", src, c.head);
  try { git("-C", origin, "merge-base", "--is-ancestor", c.base, c.head); } catch {
    throw new Error(`base ${c.base} is not an ancestor of head ${c.head}`);
  }
  git("-C", origin, "update-ref", `refs/heads/${baseRef}`, c.base);
  git("-C", origin, "update-ref", `refs/pull/${c.pr}/head`, c.head);
  git("-C", origin, "symbolic-ref", "HEAD", `refs/heads/${baseRef}`);
  git("clone", "-q", "--no-local", origin, dir);
  return dir;
}
