import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkArgs, checkCases, loadCases, markdown, scoreCase, summarize } from "../score.mjs";
import { isolatedClone } from "../clone.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sha = (d) => d.repeat(40);
const kase = (over = {}) => ({
  id: "x-1", repo: "o/r", pr: 1, base: sha("a"), head: sha("b"), fix: sha("c"),
  bugs: [{ file: "src/a.js", lines: [10, 12], what: "off by one" }, { file: "src/b.js", lines: [40, 40], what: "wrong key" }],
  ...over,
});
const f = (file, line, severity, status) => ({ file, line, severity, status });

test("the shipped cases load", () => {
  const cases = loadCases(join(here, "..", "cases.json"));
  assert.ok(cases.length >= 3);
  assert.ok(cases.every((c) => c.bugs.length));
});

test("checkCases rejects bad cases, naming the case", () => {
  assert.throws(() => checkCases([]), /non-empty/);
  assert.throws(() => checkCases([kase(), kase()]), /x-1: id: duplicate/);
  assert.throws(() => checkCases([kase({ repo: "o/../r" })]), /repo/);
  assert.throws(() => checkCases([kase({ repo: "https://example.com/o/r" })]), /repo/);
  assert.throws(() => checkCases([kase({ pr: 0 })]), /pr/);
  assert.throws(() => checkCases([kase({ head: "abc123" })]), /head: want a full/);
  assert.throws(() => checkCases([kase({ bugs: [] })]), /bugs/);
  assert.throws(() => checkCases([kase({ bugs: [{ file: "../etc/passwd", lines: [1, 1], what: "x" }] })]), /inside the repo/);
  assert.throws(() => checkCases([kase({ bugs: [{ file: "a.js", lines: [5, 4], what: "x" }] })]), /start <= end/);
  assert.throws(() => checkCases([kase({ bugs: [{ file: "a.js", lines: [5, 5], what: " " }] })]), /what is empty/);
});

test("scoreCase: an agreed finding in the range finds the bug; other must/should findings are false positives", () => {
  const s = scoreCase(kase(), [
    f("src/a.js", 11, "must", "agreed"), // bug 1
    f("src/c.js", 3, "should", "agreed"), // FP
    f("src/c.js", 9, "nit", "agreed"), // a nit is never an FP
    f("src/b.js", 40, "must", "rejected"), // bug 2, but the vote dropped it
    f("src/d.js", 1, "must", "split"),
  ]);
  assert.deepEqual(s.agreed, { found: 1, fp: 1 });
  assert.deepEqual(s.prevote, { found: 2, fp: 2 });
  assert.deepEqual(s.clusters, { total: 5, agreed: 3, split: 1, rejected: 1 });
  assert.deepEqual(s.missed, ["src/b.js:40-40"]);
});

test("scoreCase: slack around the range, the same line in another file never matches", () => {
  const c = kase();
  assert.equal(scoreCase(c, [f("src/a.js", 15, "should", "agreed")]).agreed.found, 1);
  assert.equal(scoreCase(c, [f("src/a.js", 16, "should", "agreed")]).agreed.found, 0);
  assert.equal(scoreCase(c, [f("src/a.js", 16, "should", "agreed")], { slack: 4 }).agreed.found, 1);
  assert.equal(scoreCase(c, [f("src/b.js", 11, "must", "agreed")]).agreed.found, 0);
  assert.equal(scoreCase(c, [f("src/a.js", 7, "must", "agreed")], { slack: 0 }).agreed.fp, 1);
});

test("scoreCase: two findings on one bug count it once", () => {
  const s = scoreCase(kase(), [f("src/a.js", 10, "must", "agreed"), f("src/a.js", 12, "should", "agreed")]);
  assert.deepEqual(s.agreed, { found: 1, fp: 0 });
});

test("summarize and markdown: recall over all bugs, a failed case left out of the totals", () => {
  const ok = { ...scoreCase(kase(), [f("src/a.js", 10, "must", "agreed"), f("x.js", 1, "must", "agreed")]), tokens: { input: 100, output: 20, cache_read: 50, cache_creation: null }, wallMs: 61000 };
  const rows = [ok, { id: "x-2", error: "PR head is a, the case says b", wallMs: 5 }];
  const t = summarize(rows);
  assert.equal(t.recall, 0.5);
  assert.equal(t.fp, 1);
  assert.equal(t.failed, 1);
  assert.equal(t.tokensIn, 150);
  const md = markdown("medium", rows);
  assert.match(md, /\| x-1 \| 1\/2 \| 1\/2 \| 1 \(1\) \| 2\/0\/0 \| 150\/20 \| 61 \|/);
  assert.match(md, /\| x-2 \| error: PR head is a/);
  assert.match(md, /\| case \| found by an agreed finding \|/);
  assert.match(md, /\*\*total\*\* \| 50%/);
  assert.match(md, /1 of 2 cases failed/);
});

const args = (over = {}) => ({ effort: "medium", until: "tally", depth: "light", slack: "3", ...over });

test("checkArgs: --slack must be a non-negative integer", () => {
  assert.equal(checkArgs(args({ slack: "0" }), [kase()]).slack, 0);
  for (const bad of ["3l", "-1", "1.5", ""]) assert.throws(() => checkArgs(args({ slack: bad }), [kase()]), /--slack/);
});

test("checkArgs: --only picks cases, and one that matches no case is a usage error", () => {
  const two = [kase(), kase({ id: "x-2" })];
  assert.deepEqual(checkArgs(args({ only: "x-2" }), two).cases.map((c) => c.id), ["x-2"]);
  assert.equal(checkArgs(args(), two).cases.length, 2);
  assert.throws(() => checkArgs(args({ only: "nope" }), two), /--only: no case nope/);
  assert.throws(() => checkArgs(args({ only: "x-2,nope" }), two), /no case nope/);
  assert.throws(() => checkArgs(args({ only: "," }), two), /--only/);
});

test("results stay out of git", () => {
  const repo = join(here, "..", "..", "..");
  assert.equal(execFileSync("git", ["-C", repo, "check-ignore", "bench/pr-review/results/medium.json"], { encoding: "utf8" }).trim(), "bench/pr-review/results/medium.json");
});

test("isolatedClone: only the case's commits; the fix is out of reach; a base off the head fails before any review", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-clone-")), src = join(tmp, "src");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const g = (...a) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", src]);
  g("commit", "-q", "--allow-empty", "-m", "base");
  const base = g("rev-parse", "HEAD");
  g("switch", "-q", "-c", "feat");
  g("commit", "-q", "--allow-empty", "-m", "bug");
  const head = g("rev-parse", "HEAD");
  g("switch", "-q", "main");
  g("merge", "-q", "--no-ff", "-m", "merge", "feat");
  g("commit", "-q", "--allow-empty", "-m", "fix");
  const fix = g("rev-parse", "HEAD");
  const c = { pr: 7, base, head };
  const dir = isolatedClone(src, join(tmp, "case"), c, "main");
  const in_ = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  assert.throws(() => in_("cat-file", "-e", `${fix}^{commit}`));
  // the 2 refs frame fetches from origin
  in_("fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main", "+refs/pull/7/head:refs/pr-review/7");
  assert.equal(in_("rev-parse", "origin/main"), base);
  assert.equal(in_("rev-parse", "refs/pr-review/7"), head);
  assert.throws(() => in_("cat-file", "-e", `${fix}^{commit}`));
  assert.throws(() => isolatedClone(src, join(tmp, "bad"), { pr: 7, base: fix, head }, "main"), /not an ancestor/);
});
