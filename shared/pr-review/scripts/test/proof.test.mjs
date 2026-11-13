import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { applyProof, insideLines, checkFix, directionOnly, mutantBrief, mutantFindings, mutateLine, planMutants, runMutants } from "../lib/proof.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" });

// m.js is new in the head; its test checks big() only, so a break in LIMIT or big() is caught, and one in inc() is not.
const TEST = 'import { big } from "./m.js";\nif (big(10) !== false || big(11) !== true) process.exit(1);\n';
const M = "export const LIMIT = 10;\nexport const big = (x) => x > LIMIT;\nexport const inc = (x) => x + 1;\n";
function wt({ test = TEST, count, check = {}, m = M } = {}) {
  const root = mkdtempSync(join(tmpdir(), "prr-proof-"));
  const w = join(root, "wt"), ctx = join(root, "ctx");
  mkdirSync(w); mkdirSync(ctx);
  git(w, "init", "-q");
  writeFileSync(join(w, "m.test.mjs"), test);
  writeFileSync(join(w, "package.json"), '{"type":"module"}\n');
  git(w, "add", "-A"); git(w, "commit", "-qm", "base");
  writeFileSync(join(w, "m.js"), m);
  git(w, "add", "-A"); git(w, "commit", "-qm", "head");
  writeFileSync(join(ctx, "diff.patch"), git(w, "diff", "HEAD~1", "HEAD"));
  const config = loadConfig({});
  config.review.checks = [{ name: "node test", run: `${count ? `echo x >> '${count}'; ` : ""}node m.test.mjs`, paths: ["**/*.js"], mutate: true, ...check }];
  return { root, runDir: root, config, f: { worktree: w, ctxDir: ctx, shellOk: true, changedPaths: ["m.js"], headSha: git(w, "rev-parse", "HEAD").trim() } };
}
const clean = (w) => assert.equal(git(w, "status", "--porcelain"), "");

test("mutateLine: the first operator that changes the line; comments and imports are skipped", () => {
  assert.deepEqual(mutateLine("  if (a === b) {", "x.js"), { op: "flip comparison", after: "  if (a !== b) {" });
  assert.deepEqual(mutateLine("for i := 0; i < n; i++ {", "x.go"), { op: "boundary", after: "for i := 0; i <= n; i++ {" });
  assert.deepEqual(mutateLine("ok = a && b", "x.js"), { op: "flip logic", after: "ok = a || b" });
  assert.deepEqual(mutateLine("if (ready) {", "x.js"), { op: "negate condition", after: "if (!(ready)) {" });
  assert.deepEqual(mutateLine("x = 3;", "x.js"), { op: "number +1", after: "x = 4;" });
  assert.deepEqual(mutateLine("  return total;", "x.js"), { op: "drop return value", after: "  return;" });
  assert.deepEqual(mutateLine("  save(x);", "x.js"), { op: "drop statement", after: "  " });
  assert.equal(mutateLine("// if (a === b)", "x.js"), null);
  assert.equal(mutateLine('import x from "y";', "x.js"), null);
  assert.equal(mutateLine("const f = (x) => x;", "x.js"), null); // an arrow is not a comparison
});

test("mutateLine: string literals and comments never change; open literals and unknown languages get no mutant", () => {
  assert.equal(mutateLine('x := "a == b"', "x.go"), null);
  assert.equal(mutateLine('export const note = "retry after 3 seconds";', "x.js"), null);
  assert.equal(mutateLine("const x = a; // a == b", "x.js"), null);
  assert.equal(mutateLine("const x = a; /* 3 */", "x.js"), null);
  assert.equal(mutateLine('log.Printf("retry %d < %d", n, max)', "x.go"), null, "a log call is not dropped");
  assert.equal(mutateLine("  console.log(x);", "x.js"), null);
  assert.deepEqual(mutateLine("  save(x);", "x.js"), { op: "drop statement", after: "  " });
  assert.deepEqual(mutateLine("  return total; // limit 10", "x.js"), { op: "drop return value", after: "  return; // limit 10" });
  assert.deepEqual(mutateLine('if (s === "a == b") {', "x.js"), { op: "flip comparison", after: 'if (s !== "a == b") {' });
  assert.deepEqual(mutateLine("x = 3  # was 2", "x.py"), { op: "number +1", after: "x = 4  # was 2" });
  assert.equal(mutateLine('s = """a == b', "x.py"), null);
  assert.equal(mutateLine("const s = `a == b", "x.js"), null, "a literal left open: no mutant");
  assert.equal(mutateLine("x = 3", "x.yaml"), null);
});

test("a surviving mutant becomes a finding, a killed one does not; the worktree is restored; resume runs nothing again", async () => {
  const { f, config, runDir } = wt({ count: join(mkdtempSync(join(tmpdir(), "prr-count-")), "n") });
  const count = config.review.checks[0].run.match(/'(.+?)'/)[1];
  const r = await runMutants(f, config, runDir);
  assert.equal(r.ran, true);
  assert.deepEqual(r.mutants.map((m) => [m.line, m.op, m.status]), [[1, "number +1", "killed"], [2, "boundary", "killed"], [3, "number +1", "survived"]]);
  clean(f.worktree);
  assert.equal(readFileSync(join(f.worktree, "m.js"), "utf8"), M);
  const found = mutantFindings(r);
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 3);
  assert.equal(found[0].proven, true);
  assert.equal(found[0].symbol, "line 3", "2 equal lines give 2 findings");
  assert.match(found[0].case, /x \+ 1.*x \+ 2.*node m\.test\.mjs/);
  assert.match(mutantBrief(r, f.ctxDir), /3 changed lines.*2 caught, 1 not caught/);
  const runs = readFileSync(count, "utf8").split("\n").filter(Boolean).length;
  assert.equal(runs, 4, "1 baseline and 3 mutants");
  // a resume after a signal left a mutant in the worktree: the head comes back, and nothing runs again
  writeFileSync(join(f.worktree, "m.js"), "broken");
  assert.deepEqual(await runMutants(f, config, runDir), r);
  clean(f.worktree);
  assert.equal(readFileSync(count, "utf8").split("\n").filter(Boolean).length, runs);
});

test("mutants: the worktree is reset between runs; each run keeps the check's repeat; a survivor passes every run", async () => {
  // a run that finds the file of the run before fails: without a reset between runs, every mutant is "caught"
  const { f, config, runDir } = wt({ check: { run: "test ! -e stray && touch stray && echo //x >> m.test.mjs && node m.test.mjs" } });
  const r = await runMutants(f, config, runDir);
  assert.deepEqual(r.mutants.map((m) => m.status), ["killed", "killed", "survived"]);
  clean(f.worktree);
  const rep = wt({ check: { repeat: 3 } });
  const r3 = await runMutants(rep.f, rep.config, rep.runDir);
  assert.deepEqual(r3.mutants.map((m) => [m.status, m.runs]), [["killed", 1], ["killed", 1], ["survived", 3]]);
});

test("mutants: an untrusted author runs nothing; a failing baseline runs no mutant; a file with no test is not mutated", async () => {
  const a = wt();
  a.f.shellOk = false;
  assert.deepEqual(await runMutants(a.f, a.config, a.runDir), { ran: false, reason: "an author is not trusted", mutants: [] });
  const b = wt({ test: "process.exit(1);\n" });
  const r = await runMutants(b.f, b.config, b.runDir);
  assert.deepEqual(r.mutants.map((m) => m.status), ["skipped", "skipped", "skipped"]);
  assert.deepEqual(mutantFindings(r), []);
  assert.equal(mutantBrief(r, b.f.ctxDir), "Mutants did not run: the tests fail with no mutant.");
  const t = wt({ check: { run: "sleep 5", timeout_s: 1 } });
  const rt = await runMutants(t.f, t.config, t.runDir);
  assert.deepEqual([...new Set(rt.mutants.map((m) => m.reason))], ["the tests time out with no mutant"]);
  const c = wt();
  git(c.f.worktree, "mv", "m.test.mjs", "notes.txt");
  git(c.f.worktree, "commit", "-qm", "no test");
  assert.deepEqual(planMutants(c.f, c.config), []);
  c.config.review.mutants.max = 1;
  git(c.f.worktree, "mv", "notes.txt", "m.test.mjs");
  assert.equal(planMutants(c.f, c.config).length, 1, "review.mutants.max caps the plan");
});

test("checked fix: a suggestion that fails the tests or lets a caught mutant pass fails; a good one passes; the worktree is restored", async () => {
  const { f, config, runDir } = wt();
  const { mutants } = await runMutants(f, config, runDir);
  const s = (code, line = 2, fp = "fp") => ({ fp, file: "m.js", line, body: `**should:** x\n\nFix:\n\n\`\`\`suggestion\n${code}\n\`\`\`` });
  const far = Date.now() + 60_000;
  const bad = await checkFix(f, config, runDir, s("export const big = (x) => x > 11;", 2, "a"), mutants, far);
  assert.equal(bad.ok, false);
  assert.match(bad.why, /node test failed \(exit 1\)/);
  // inc() has no test: the fix passes, and the caught mutants of lines 1 and 2 stay caught
  assert.deepEqual(await checkFix(f, config, runDir, s("export const inc = (x) => x + 2;", 3, "b"), mutants, far), { ok: true });
  // big() no longer reads LIMIT: the tests pass, but a break in LIMIT (line 1) is no longer caught
  assert.deepEqual(await checkFix(f, config, runDir, s("export const big = (x) => x > 10;", 2, "c"), mutants, far), { ok: false, why: "the tests no longer catch a break at line 1 with it" });
  assert.equal(await checkFix(f, config, runDir, { fp: "d", file: "m.js", line: 2, body: "no code" }, mutants, far), null);
  // a suggestion of 2 lines above a caught mutant moves it down: the check follows it to its new line, where
  // LIMIT = 10.5 lets the boundary mutant (x >= LIMIT) pass
  assert.deepEqual(await checkFix(f, config, runDir, s("export const LIMIT = 10.5;\n// half", 1, "e"), mutants, far), { ok: false, why: "the tests no longer catch a break at line 2 with it" });
  // a 4-backtick fence holds ``` in its code: the whole block is checked
  const four = { fp: "g", file: "m.js", line: 3, body: "x\n\n````suggestion\nexport const inc = (x) => x + 1 + '```'.length * 0;\n````" };
  assert.deepEqual(await checkFix(f, config, runDir, four, mutants, far), { ok: true });
  assert.equal(await checkFix({ ...f, shellOk: false }, config, runDir, s("x", 3, "h"), mutants, far), null, "untrusted: nothing runs");
  assert.deepEqual(await checkFix(f, config, runDir, s("x", 3, "i"), mutants, Date.now() - 1), { unchecked: "the time cap ran out" }, "no time: nothing runs");
  assert.equal(await checkFix(f, config, runDir, s("x", 99, "j"), mutants, far), null, "a line past the file is not checked");
  clean(f.worktree);
  assert.equal(readFileSync(join(f.worktree, "m.js"), "utf8"), M);
  const out = directionOnly("**should:** x\n\nUse this:\n\n````suggestion\ny ```\n````\n\nThanks.", "go test failed (exit 1) with it");
  assert.doesNotMatch(out, /```|y /);
  assert.match(out, /Use this:\n\nThanks\.\n\nEngine note: the suggested code was left out, because go test failed \(exit 1\) with it\.$/);
});

test("checked fix: a check that fails at the head blames no fix", async () => {
  const { f, config, runDir } = wt({ test: "process.exit(1);\n" });
  const body = "x\n\n```suggestion\nexport const inc = (x) => x + 2;\n```";
  assert.equal(await checkFix(f, config, runDir, { fp: "a", file: "m.js", line: 3, body }, [], Date.now() + 60_000), null);
});

test("applyProof: evidence of the cluster's own members and of counted votes only; an unproven must is held unless agreed", () => {
  const fids = new Map([["f1", { seat: "s0", lens: "correctness", evidence_run: true }], ["f2", { seat: "s0", lens: "correctness" }], ["f3", { seat: "s9", lens: "correctness", evidence_run: true }], ["f4", { seat: "s0", lens: "security", evidence_run: true }]]);
  const cl = (id, over = {}) => ({ id, fp: id, lens: "correctness", severity: "must", found: ["s0"], seats: ["s0", "s1", "s2"], ...over });
  const t = (c, votes, status = "split") => ({ cluster: c, votes, status });
  const keepRun = (seat) => ({ seat, vote: "keep", counter_case: "", evidence_run: true });
  const drop1 = { seat: "s1", vote: "drop", counter_case: "no" };
  const a = cl("a", { members: ["f1"] }), b = cl("b", { members: ["f2"] }), c = cl("c", { members: ["f3"] });
  const d = cl("d"), e = cl("e"), g = cl("g"), h = cl("h", { answered: "post" });
  applyProof([a, b, c, d, e, g, h], [
    t(a, []), t(b, [drop1]), t(c, []), t(d, [drop1, keepRun("s1")]), t(e, [keepRun("s9")]), t(g, [keepRun("s2")], "agreed"), t(h, [drop1]),
  ], fids);
  assert.deepEqual([a, b, c, d, e, g, h].map((x) => [x.id, x.proven, x.severity]), [
    ["a", true, "must"], // its member ran
    ["b", false, "should"], // another finding of the same seat ran, not this one
    ["c", false, "should"], // a member from a seat outside `found`
    ["d", false, "should"], // the keep came after the seat's counted drop
    ["e", false, "should"], // a vote from a seat that cannot vote
    ["g", true, "must"],
    ["h", false, "must"], // Marco answered
  ]);
  const other = cl("l", { members: ["f4", "nope"] });
  applyProof([other], [t(other, [])], fids);
  assert.deepEqual([other.proven, other.severity], [false, "should"], "a member of another lens, or an unknown id, proves nothing");
  const agreedNoDrop = cl("k");
  applyProof([agreedNoDrop], [t(agreedNoDrop, [], "agreed")], fids);
  assert.deepEqual([agreedNoDrop.proven, agreedNoDrop.severity], [false, "must"]);
});

test("mutants: lines inside a multi-line string or block comment get none", async () => {
  assert.deepEqual([...insideLines("const u = `Usage:\n  -n int  retries (default 3)\n`;\nx = 1;\n", "x.go")], [2, 3]);
  assert.deepEqual([...insideLines('def f():\n    """Doc.\n    retries 3\n    """\n    return 1\n', "x.py")], [3, 4]);
  assert.deepEqual([...insideLines("/* a\n b 3 */\nx = 'a`b';\ny = 2;\n", "x.js")], [2]);
  const m = "export const LIMIT = 10;\nexport const big = (x) => x > LIMIT;\nexport const u = `a\n  n (default 3)\n`;\n";
  const { f, config } = wt({ m });
  assert.deepEqual(planMutants(f, config).map((x) => x.line), [1, 2]);
});

test("mutants: a test in another folder counts only when the command runs it", () => {
  const root = mkdtempSync(join(tmpdir(), "prr-proof-"));
  const w = join(root, "wt"), ctx = join(root, "ctx");
  mkdirSync(join(w, "lib"), { recursive: true }); mkdirSync(join(w, "test")); mkdirSync(ctx);
  git(w, "init", "-q");
  writeFileSync(join(w, "test", "x.test.mjs"), "\n");
  git(w, "add", "-A"); git(w, "commit", "-qm", "base");
  writeFileSync(join(w, "lib", "x.mjs"), "export const n = 1;\n");
  git(w, "add", "-A"); git(w, "commit", "-qm", "head");
  writeFileSync(join(ctx, "diff.patch"), git(w, "diff", "HEAD~1", "HEAD"));
  const f = { worktree: w, ctxDir: ctx, shellOk: true, changedPaths: ["lib/x.mjs"], headSha: git(w, "rev-parse", "HEAD").trim() };
  const plan = (check) => { const c = loadConfig({}); c.review.checks = [{ name: "t", mutate: true, ...check }]; return planMutants(f, c).map((x) => x.command); };
  assert.deepEqual(plan({ run: "node --test {dirs}", paths: ["**/*.mjs"] }), ["node --test './lib' './test'"]);
  assert.deepEqual(plan({ run: "node --test {dirs}", paths: ["lib/**"] }), [], "the command never gets ./test");
  assert.deepEqual(plan({ run: "npm test", paths: ["lib/**"] }), ["npm test"], "a command without {dirs} runs every test");
});

test("mutants: the plan follows the delta of a later review", () => {
  const { f, config } = wt();
  writeFileSync(join(f.ctxDir, "delta.patch"), "diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -3 +3 @@\n-x\n+export const inc = (x) => x + 1;\n");
  assert.deepEqual(planMutants(f, config).map((x) => x.line), [3]);
});

test("mutants: results are keyed by the mutant, so a config edited before a resume runs the new one", async () => {
  const { f, config, runDir } = wt();
  await runMutants(f, config, runDir);
  rmSync(join(runDir, "mutants.done")); // the stage did not finish
  config.review.checks[0].repeat = 2;
  const r = await runMutants(f, config, runDir);
  assert.deepEqual(r.mutants.map((m) => m.runs), [1, 1, 2]);
});

test("mutants: a failed worktree reset runs nothing and says why", async () => {
  const { f, config, runDir } = wt();
  const r = await runMutants({ ...f, headSha: "0".repeat(40) }, config, runDir, () => {});
  assert.deepEqual(r, { ran: false, reason: "the worktree reset failed", mutants: [] });
  assert.equal(mutantBrief(r, f.ctxDir), "Mutants did not run: the worktree reset failed.");
});

test("mutants: when the baseline uses up the time cap, the mutants are skipped, not run with no time", async () => {
  const flag = join(mkdtempSync(join(tmpdir(), "prr-flag-")), "flag");
  const { f, config, runDir } = wt({ check: { run: `touch '${flag}'; node m.test.mjs` } });
  const now = Date.now;
  Date.now = () => now() + (existsSync(flag) ? 10_000_000 : 0);
  try {
    const r = await runMutants(f, config, runDir);
    assert.deepEqual(r.mutants.map((m) => m.reason), ["time cap", "time cap", "time cap"]);
  } finally { Date.now = now; }
});

test("checked fix: a run cut short by the total cap is unchecked, not failed", async () => {
  const { f, config, runDir } = wt({ check: { run: "grep -q SLOW m.js && sleep 5; node m.test.mjs" } });
  const body = "x\n\n```suggestion\nexport const inc = (x) => x + 1; // SLOW\n```";
  const r = await checkFix(f, config, runDir, { fp: "a", file: "m.js", line: 3, body }, [], Date.now() + 1500);
  assert.deepEqual(r, { unchecked: "the time cap ran out" });
  assert.equal(existsSync(join(runDir, "fixes")), false, "not cached: a resume tries again");
  clean(f.worktree);
});

test("applyProof: a member from a seat dropped in the vote proves nothing", () => {
  const fids = new Map([["f1", { seat: "s0", lens: "correctness", evidence_run: true }]]);
  const c = { id: "a", fp: "a", lens: "correctness", severity: "must", found: ["s0"], seats: ["s0", "s1"], members: ["f1"] };
  applyProof([c], [{ cluster: { ...c, found: [], seats: ["s1"] }, votes: [], status: "split" }], fids);
  assert.deepEqual([c.proven, c.severity], [false, "should"]);
});

test("mutants: a baseline the total cap starves is no result: skipped for the time cap, not cached", async () => {
  const { f, config, runDir } = wt({ check: { run: "sleep 3", timeout_s: 60 } });
  config.review.mutants.total_s = 1;
  const r = await runMutants(f, config, runDir);
  assert.deepEqual([...new Set(r.mutants.map((m) => m.reason))], ["time cap"]);
  const b = wt({ check: { run: "sleep 3", timeout_s: 60 } });
  const body = "x\n\n```suggestion\nexport const inc = (x) => x + 2;\n```";
  assert.deepEqual(await checkFix(b.f, b.config, b.runDir, { fp: "a", file: "m.js", line: 3, body }, [], Date.now() + 1000), { unchecked: "the time cap ran out" });
  assert.equal(existsSync(join(b.runDir, "mutants")), false, "nothing cached: a resume runs the baseline again");
});

test("mutants: only lines the PR adds, also when delta.patch holds lines a rebase brought in", () => {
  const { f, config } = wt();
  writeFileSync(join(f.ctxDir, "delta.patch"), readFileSync(join(f.ctxDir, "diff.patch"), "utf8"));
  writeFileSync(join(f.ctxDir, "diff.patch"), "diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -1,1 +1,3 @@\n+export const LIMIT = 10;\n+export const big = (x) => x > LIMIT;\n export const inc = (x) => x + 1;\n");
  assert.deepEqual(planMutants(f, config).map((x) => x.line), [1, 2]);
});

test("checked fix: the verdict is per line and command, not per fingerprint", async () => {
  const { f, config, runDir } = wt();
  const s = (line) => ({ fp: "same", file: "m.js", line, body: "x\n\n```suggestion\nexport const inc = (x) => x + 2;\n```" });
  const far = Date.now() + 60_000;
  assert.deepEqual(await checkFix(f, config, runDir, s(3), [], far), { ok: true });
  assert.equal((await checkFix(f, config, runDir, s(2), [], far)).ok, false, "at line 2 it removes big()");
  config.review.checks[0].run = "exit 0";
  assert.deepEqual(await checkFix(f, config, runDir, s(2), [], far), { ok: true }, "another command checks again");
});
