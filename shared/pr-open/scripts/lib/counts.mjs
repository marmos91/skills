// Run the project's tests at HEAD and keep the counts per commit, so the PR body never quotes counts from memory.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The user must fix the input or the setup: exit 1. */
export class Usage extends Error {
  constructor(msg) { super(msg); this.name = "Usage"; }
}

/** A check stops the run: exit 2. */
export class Blocked extends Error {
  constructor(msg, detail) { super(msg); this.name = "Blocked"; this.detail = detail; }
}

const n = (s, word) => Number(new RegExp(`(\\d+) ${word}`).exec(s)?.[1] ?? 0);
const words = (s) => ({ passed: n(s, "passed"), failed: n(s, "failed") + n(s, "errors?"), skipped: n(s, "skipped") });
const all = (re, s) => [...s.matchAll(re)].map((m) => m[1]);
const zero = { passed: 0, failed: 0, skipped: 0 };
const add = (a, b) => ({ passed: a.passed + b.passed, failed: a.failed + b.failed, skipped: a.skipped + b.skipped });
// A monorepo run prints one summary per package: sum them.
const sum = (lines) => (lines.length ? lines.map(words).reduce(add, zero) : null);
const sumOf = (re, s) => all(re, s).reduce((a, x) => a + Number(x), 0);

/** { passed, failed, skipped } from a test run's output, summed over every runner in it, or null when no known summary is in it. */
export function parseCounts(out) {
  const node = /^[ℹ#] pass \d+$/m.test(out) ? { passed: sumOf(/^[ℹ#] pass (\d+)$/gm, out), failed: sumOf(/^[ℹ#] fail (\d+)$/gm, out), skipped: sumOf(/^[ℹ#] skipped (\d+)$/gm, out) } : null;
  const cargo = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)].map((m) => ({ passed: +m[1], failed: +m[2], skipped: +m[3] }));
  const go = [...out.matchAll(/^\s*--- (PASS|FAIL|SKIP):/gm)].map((m) => m[1]);
  const goCounts = go.length ? { passed: go.filter((x) => x === "PASS").length, failed: go.filter((x) => x === "FAIL").length, skipped: go.filter((x) => x === "SKIP").length } : null;
  const found = [
    node,
    sum(all(/^Tests:\s+(.*\d+ total)\s*$/gm, out)),
    sum(all(/^\s*Tests\s+(.*\d+ \w+.*)\(\d+\)\s*$/gm, out)),
    sum(all(/^=+ (.*\d+ (?:passed|failed|skipped|errors?).*) in [\d.]+s.*=+\s*$/gm, out)),
    cargo.length ? cargo.reduce(add, zero) : null,
    goCounts,
  ].filter(Boolean);
  return found.length ? found.reduce(add, zero) : null;
}

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const recordPath = (dir, sha) => join(git(dir, "rev-parse", "--absolute-git-dir"), "pr-open", `tests-${sha}.json`);

export function readRecord(dir, sha) {
  const f = recordPath(dir, sha);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
}

/** Run `command` at HEAD on a clean tree; record and return { sha, command, exit, counts, at }. */
export async function runTests(dir, command, { quiet = false } = {}) {
  if (git(dir, "status", "--porcelain")) throw new Blocked("the tree has changes: commit or stash, then run the tests");
  const sha = git(dir, "rev-parse", "HEAD");
  let out = "";
  const exit = await new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", command], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const tee = (d) => { out += d; if (!quiet) process.stderr.write(d); };
    p.stdout.on("data", tee);
    p.stderr.on("data", tee);
    p.on("error", reject);
    p.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  // The record must describe the tree that ran: a run that commits or edits tracked files gets none.
  if (git(dir, "rev-parse", "HEAD") !== sha || git(dir, "status", "--porcelain")) throw new Blocked("the test run changed HEAD or the tree: commit the changes, then run the tests again");
  const record = { sha, command, exit, counts: parseCounts(out), at: new Date().toISOString() };
  const f = recordPath(dir, sha);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(record, null, 2) + "\n");
  return record;
}
