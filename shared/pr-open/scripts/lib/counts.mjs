// Run the project's tests at HEAD and keep the counts per commit, so the PR body never quotes counts from memory.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A check stops the run: exit 2. */
export class Blocked extends Error {
  constructor(msg, detail) { super(msg); this.name = "Blocked"; this.detail = detail; }
}

const n = (s, word) => Number(new RegExp(`(\\d+) ${word}`).exec(s)?.[1] ?? 0);
const words = (s) => ({ passed: n(s, "passed"), failed: n(s, "failed") + n(s, "errors?"), skipped: n(s, "skipped") });
const last = (re, s) => [...s.matchAll(re)].at(-1)?.[1];

/** { passed, failed, skipped } from a test run's output, or null when no known summary is in it. */
export function parseCounts(out) {
  const pass = last(/^[ℹ#] pass (\d+)$/gm, out);
  if (pass !== undefined) return { passed: Number(pass), failed: Number(last(/^[ℹ#] fail (\d+)$/gm, out) ?? 0), skipped: Number(last(/^[ℹ#] skipped (\d+)$/gm, out) ?? 0) };
  const jest = last(/^Tests:\s+(.*\d+ total)\s*$/gm, out);
  if (jest) return words(jest);
  const vitest = last(/^\s*Tests\s+(.*\d+ \w+.*)\(\d+\)\s*$/gm, out);
  if (vitest) return words(vitest);
  const pytest = last(/^=+ (.*\d+ (?:passed|failed|skipped|errors?).*) in [\d.]+s.*=+\s*$/gm, out);
  if (pytest) return words(pytest);
  const cargo = [...out.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) return cargo.reduce((a, m) => ({ passed: a.passed + +m[1], failed: a.failed + +m[2], skipped: a.skipped + +m[3] }), { passed: 0, failed: 0, skipped: 0 });
  const go = [...out.matchAll(/^\s*--- (PASS|FAIL|SKIP):/gm)].map((m) => m[1]);
  if (go.length) return { passed: go.filter((x) => x === "PASS").length, failed: go.filter((x) => x === "FAIL").length, skipped: go.filter((x) => x === "SKIP").length };
  return null;
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
  const record = { sha, command, exit, counts: parseCounts(out), at: new Date().toISOString() };
  const f = recordPath(dir, sha);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(record, null, 2) + "\n");
  return record;
}
