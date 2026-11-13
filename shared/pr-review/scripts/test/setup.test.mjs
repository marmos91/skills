import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.mjs";
import { addsExportedApi, checksFor, cherryPicked, depthLine, pickDepth, readCorePaths, runCommand, runSetup, saveCorePaths, setCorePaths, setupBrief, queueCoreQuestion } from "../lib/setup.mjs";
import { answer, openQuestions, pendingAnswers } from "../lib/questions.mjs";
import { CHECK_ENV_OK } from "../lib/env.mjs";

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { cwd, encoding: "utf8" });

// A worktree-like repo with one commit, and the frame fields runSetup reads.
function wt(files = { "a.txt": "a\n" }) {
  const root = mkdtempSync(join(tmpdir(), "prr-setup-"));
  const w = join(root, "wt"), ctx = join(root, "ctx");
  mkdirSync(w); mkdirSync(ctx);
  git(w, "init", "-q");
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(w, p, ".."), { recursive: true }); writeFileSync(join(w, p), t); }
  git(w, "add", "-A"); git(w, "commit", "-qm", "x");
  return { root, runDir: root, f: { worktree: w, ctxDir: ctx, shellOk: true, changedPaths: Object.keys(files), headSha: git(w, "rev-parse", "HEAD").trim() } };
}
const cfg = (checks) => { const c = loadConfig({}); c.review.checks = checks; return c; };

test("auto depth: a core path is full; docs-only, test-only and cherry-picks are light", () => {
  const core = ["pkg/store/**"];
  assert.equal(pickDepth({ paths: ["pkg/store/db.go"] }, core), "full");
  assert.equal(pickDepth({ paths: ["README.md", "docs/a.md"] }, core), "light");
  // a test in a core folder is still a test-only PR
  assert.equal(pickDepth({ paths: ["pkg/store/db_test.go", "web/x.test.ts"] }, core), "light");
  assert.equal(pickDepth({ paths: ["pkg/store/db.go"], cherryPick: true }, core), "light");
  assert.equal(pickDepth({ paths: ["cmd/main.go"] }, core), "light");
  assert.equal(pickDepth({ paths: ["cmd/main.go"] }, []), "light");
  // no core paths set: only a PR whose depth they would decide needs them
  assert.equal(pickDepth({ paths: ["cmd/main.go"] }, undefined), "needs-core");
  assert.equal(pickDepth({ paths: ["docs/a.md"] }, undefined), "light");
  // a PR with no changed path (its head is already in base): nothing for core paths to match
  assert.equal(pickDepth({ paths: [] }, undefined), "light");
  assert.equal(pickDepth({ paths: ["cmd/main.go"], cherryPick: true }, undefined), "light");
});

test("auto depth: a new exported name is full, also with no core paths; one in a test file is not", () => {
  const d = (file, line) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n x\n${line}\n`;
  assert.equal(pickDepth({ paths: ["x.go"], diff: d("x.go", "+func Open(p string) error {") }), "full");
  assert.equal(pickDepth({ paths: ["x.go"], diff: d("x.go", "+func (s *S) Close() error {") }), "full");
  assert.equal(pickDepth({ paths: ["x.ts"], diff: d("x.ts", "+export function f() {}") }), "full");
  assert.equal(addsExportedApi(d("x.go", "+func open() {")), false);
  assert.equal(addsExportedApi(d("x_test.go", "+func TestOpen(t *testing.T) {")), false);
  // the pattern follows the file type; docs never count
  assert.equal(addsExportedApi(d("scripts/build.sh", "+export GOFLAGS=-mod=mod")), false);
  assert.equal(addsExportedApi(d("README.md", "+export PATH=x")), false);
  assert.equal(addsExportedApi(d("docs/api.go", "+func ExampleFoo() {")), false);
  assert.equal(addsExportedApi(d("src/lib.rs", "+    pub async fn fetch() {}")), true);
  assert.equal(addsExportedApi(d("src/lib.rs", "+pub static X: u8 = 1;")), true);
  assert.equal(addsExportedApi(d("src/a.ts", "+  export function f() {}")), true);
});

test("cherryPicked: true for git cherry-pick -x, false for plain history", () => {
  const root = mkdtempSync(join(tmpdir(), "prr-cp-"));
  const origin = join(root, "o.git"), seed = join(root, "seed"), w = join(root, "w");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  const put = (p, t, msg) => { writeFileSync(join(seed, p), t); git(seed, "add", "-A"); git(seed, "commit", "-qm", msg); return git(seed, "rev-parse", "HEAD").trim(); };
  put("a", "1\n", "base");
  git(seed, "push", "-q", origin, "main");
  git(seed, "checkout", "-qb", "dev");
  const fix = put("b", "2\n", "fix");
  git(seed, "checkout", "-q", "main");
  git(seed, "checkout", "-qb", "pick");
  git(seed, "cherry-pick", "-x", fix);
  const picked = git(seed, "rev-parse", "HEAD").trim();
  git(root, "clone", "-q", origin, w);
  git(seed, "push", "-q", origin, "dev", "pick");
  git(w, "fetch", "-q", "origin", "dev", "pick");
  const f = { worktree: w, baseRef: "main" };
  assert.equal(cherryPicked({ ...f, headSha: picked }), true);
  assert.equal(cherryPicked({ ...f, headSha: fix }), false);
});

test("checksFor: globs pick the checks; {dirs} is quoted and lists only folders of the head", () => {
  const { f } = wt({ "go.mod": "module x\n", "p q/a.go": "package p\n", "z.md": "" });
  f.changedPaths = ["p q/a.go", "gone/b.go", "z.md"];
  const got = checksFor(cfg([{ name: "vet", run: "go vet {dirs}", paths: ["**/*.go"] }, { name: "docs", run: "true", paths: ["docs/**"] }]), f);
  assert.deepEqual(got, [{ name: "vet", run: "go vet './p q'", repeat: 1, timeout_s: 300 }]);
  // no review.checks: the Go defaults, because go.mod is at the root
  assert.deepEqual(checksFor(cfg(null), f).map((c) => c.name), ["go build", "go vet", "go test"]);
  f.changedPaths = ["z.md"];
  assert.deepEqual(checksFor(cfg(null), f), []);
});

test("checksFor: {dirs} leaves out a folder whose last matching file the PR deleted", () => {
  const { f } = wt({ "old/README.md": "", "new/a.go": "package n\n" });
  f.changedPaths = ["old/gone.go", "new/a.go"];
  assert.deepEqual(checksFor(cfg([{ name: "vet", run: "go vet {dirs}", paths: ["**/*.go"] }]), f).map((c) => c.run), ["go vet './new'"]);
  f.changedPaths = ["old/gone.go"];
  assert.deepEqual(checksFor(cfg([{ name: "vet", run: "go vet {dirs}", paths: ["**/*.go"] }]), f), []);
});

test("check env: the child allowlist minus login variables, plus proxy, TLS and Go variables", () => {
  for (const k of ["PATH", "HOME", "HTTPS_PROXY", "no_proxy", "SSL_CERT_FILE", "GOPROXY", "GOFLAGS"]) assert.equal(CHECK_ENV_OK(k), true, k);
  for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "PR_REVIEW_FAKE", "GOAUTH"]) assert.equal(CHECK_ENV_OK(k), false, k);
});

test("a failing check is data, not a crash; secrets stay out of its env; the worktree is reset", async () => {
  const { f, runDir } = wt();
  process.env.GH_TOKEN = "ghp_should_not_leak";
  const checks = [
    { name: "fail", run: "echo boom; echo dirty > a.txt; touch new.txt; exit 3" },
    { name: "env", run: 'echo "token=${GH_TOKEN:-none}"' },
  ];
  const s = await runSetup(f, cfg(checks), runDir);
  delete process.env.GH_TOKEN;
  assert.equal(s.ran, true);
  assert.equal(s.checks[0].ok, false);
  assert.equal(s.checks[0].exit, 3);
  assert.match(s.checks[0].output, /boom/);
  assert.match(s.checks[1].output, /token=none/);
  assert.equal(readFileSync(join(f.worktree, "a.txt"), "utf8"), "a\n");
  assert.equal(existsSync(join(f.worktree, "new.txt")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(f.ctxDir, "setup.json"), "utf8")), s);
  assert.match(setupBrief(s, f.ctxDir), /- fail: failed \(exit 3\)/);
});

test("setup resumes: a finished check does not run again; an edited check runs", async () => {
  const { f, runDir, root } = wt();
  const count = join(root, "count");
  const checks = [{ name: "count", run: `echo x >> '${count}'` }];
  await runSetup(f, cfg(checks), runDir);
  await runSetup(f, cfg(checks), runDir);
  assert.equal(readFileSync(count, "utf8"), "x\n");
  // a crash before setup.done, then a config edit: the new check runs, the old result is not reused
  rmSync(join(runDir, "setup.done"));
  const s = await runSetup(f, cfg([{ name: "count", run: `echo y >> '${count}'` }]), runDir);
  assert.equal(readFileSync(count, "utf8"), "x\ny\n");
  assert.equal(s.checks[0].command, `echo y >> '${count}'`);
  // a new time cap is a new check too
  rmSync(join(runDir, "setup.done"));
  await runSetup(f, cfg([{ name: "count", run: `echo y >> '${count}'`, timeout_s: 60 }]), runDir);
  assert.equal(readFileSync(count, "utf8"), "x\ny\ny\n");
});

test("setup resets the worktree to the PR head, also after a check commits; a failed reset is in the brief", async () => {
  let { f, runDir } = wt();
  const commitRun = "echo z > a.txt && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qam moved";
  await runSetup(f, cfg([{ name: "commit", run: commitRun }]), runDir);
  assert.equal(git(f.worktree, "rev-parse", "HEAD").trim(), f.headSha);
  assert.equal(readFileSync(join(f.worktree, "a.txt"), "utf8"), "a\n");
  ({ f, runDir } = wt());
  const logs = [];
  const s = await runSetup(f, cfg([{ name: "lock", run: "echo z > a.txt; touch .git/index.lock" }]), runDir, (l) => logs.push(l));
  assert.ok(s.reset_failed, "reset must fail on index.lock");
  assert.ok(logs.some((l) => /worktree reset failed/.test(l)));
  assert.match(setupBrief(s, f.ctxDir), /worktree reset around the checks failed/);
});

test("a check at its time cap is reported as timed out", async () => {
  const { f, runDir } = wt();
  const s = await runSetup(f, cfg([{ name: "slow", run: "sleep 5", timeout_s: 1 }]), runDir);
  assert.equal(s.checks[0].timed_out, true);
  assert.equal(depthLine("full", s, (x) => x), "full depth; slow timed out.");
});

test("repeat finds a flaky check: the first failed run stops it", async () => {
  const { f, runDir, root } = wt();
  const n = join(root, "n");
  const run = `c=$(cat '${n}' 2>/dev/null || echo 0); c=$((c+1)); echo $c > '${n}'; [ $c -lt 2 ]`;
  const s = await runSetup(f, cfg([{ name: "flaky", run, repeat: 5 }]), runDir);
  assert.deepEqual([s.checks[0].ok, s.checks[0].runs], [false, 2]);
  assert.match(depthLine("full", s, (x) => x), /flaky failed \(exit 1, run 2 of 5: flaky\)/);
});

test("an untrusted author: no check runs", async () => {
  const { f, runDir, root } = wt();
  f.shellOk = false;
  const s = await runSetup(f, cfg([{ name: "x", run: `touch '${join(root, "ran")}'` }]), runDir);
  assert.equal(s.ran, false);
  assert.equal(existsSync(join(root, "ran")), false);
  assert.equal(depthLine("full", s, (x) => x), "full depth; checks did not run: an author is not trusted.");
});

test("timeout kills the whole process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prr-kill-"));
  const pidFile = join(dir, "pid");
  const t0 = Date.now();
  const r = await runCommand(`sleep 30 & echo $! > '${pidFile}'; sleep 30`, dir, 300);
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
  const pid = Number(readFileSync(pidFile, "utf8"));
  await new Promise((res) => setTimeout(res, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, "the background child must be gone");
});

test("summary line names the depth and the checks", () => {
  assert.equal(depthLine("light", null), "light depth, no checks run.");
  const s = { ran: true, checks: [{ name: "go build", ok: true, runs: 1 }, { name: "go test", ok: true, runs: 3 }] };
  assert.equal(depthLine("full", s, (x) => x), "full depth; go build ok, go test ok (3 runs).");
  assert.equal(depthLine("full", { ran: true, checks: [] }), "full depth; no check matched the changed paths.");
});

test("core paths: saved per repo, empty means none; the question is queued once", () => {
  const rs = mkdtempSync(join(tmpdir(), "prr-core-"));
  assert.equal(readCorePaths(rs), undefined);
  saveCorePaths(rs, []);
  assert.deepEqual(readCorePaths(rs), []);
  const a = queueCoreQuestion(rs, "o/r", ["pkg/**"]), b = queueCoreQuestion(rs, "O/R", ["cmd/**"]);
  assert.equal(a, b);
  assert.equal(openQuestions(rs).length, 1);
});

test("setCorePaths saves and closes open and pending core-paths questions; a pending drop never overwrites it", () => {
  const rs = mkdtempSync(join(tmpdir(), "prr-core-"));
  const id = queueCoreQuestion(rs, "o/r", []);
  answer(rs, id, "drop");
  setCorePaths(rs, ["pkg/**"]);
  assert.deepEqual(readCorePaths(rs), ["pkg/**"]);
  assert.equal(pendingAnswers(rs).length + openQuestions(rs).length, 0);
  // an open question is closed with no answer: the record never says "none" next to saved paths
  const rs2 = mkdtempSync(join(tmpdir(), "prr-core-"));
  const id2 = queueCoreQuestion(rs2, "o/r", []);
  assert.match(readFileSync(join(rs2, "questions", `${id2}.md`), "utf8"), /## Options\n- drop\n$/);
  setCorePaths(rs2, ["pkg/**"]);
  const rec = JSON.parse(readFileSync(join(rs2, "questions", `${id2}.json`), "utf8"));
  assert.deepEqual([rec.answer, rec.options, !!rec.appliedAt], [null, ["drop"], true]);
  assert.equal(openQuestions(rs2).length, 0);
});

test("config: review.checks and review.depth are validated; a repo may set core_paths but not checks", () => {
  const p = join(mkdtempSync(join(tmpdir(), "prr-")), "c.json");
  writeFileSync(p, JSON.stringify({ review: { depth: "deep" } }));
  assert.throws(() => loadConfig({ userPath: p }), /review.depth/);
  writeFileSync(p, JSON.stringify({ review: { checks: [{ name: "x" }] } }));
  assert.throws(() => loadConfig({ userPath: p }), /review.checks\[0\].run/);
  assert.deepEqual(loadConfig({ repoText: '{"review": {"core_paths": ["src/**"]}}' }).review.core_paths, ["src/**"]);
  assert.throws(() => loadConfig({ repoText: '{"review": {"checks": []}}' }), /not allowed at repo level: review.checks/);
  // per repo only: a user-level list would hide every saved answer
  writeFileSync(p, JSON.stringify({ review: { core_paths: ["src/**"] } }));
  assert.throws(() => loadConfig({ userPath: p }), /review.core_paths is per repo/);
});

test("each check starts from the PR head: a file one check writes is not seen by the next", async () => {
  const { f, runDir } = wt();
  const s = await runSetup(f, cfg([
    { name: "write", run: "echo changed > a.txt; echo new > extra.txt" },
    { name: "read", run: "grep -qx a a.txt && [ ! -e extra.txt ]" },
  ]), runDir);
  assert.deepEqual(s.checks.map((c) => [c.name, c.ok]), [["write", true], ["read", true]]);
});

test("ignored build output from one check is not seen by the next", async () => {
  const { f, runDir } = wt({ "a.txt": "a\n", ".gitignore": "out/\n" });
  const s = await runSetup(f, cfg([
    { name: "build", run: "mkdir -p out && echo x > out/bin" },
    { name: "read", run: "[ ! -e out/bin ]" },
  ]), runDir);
  assert.deepEqual(s.checks.map((c) => [c.name, c.ok]), [["build", true], ["read", true]]);
});

test("a resumed run resets a dirty worktree before it reads {dirs}", async () => {
  const { f, runDir } = wt({ "pkg/a.go": "a\n" });
  writeFileSync(join(f.worktree, "pkg", "stray.txt"), "x");
  mkdirSync(join(f.worktree, "evil"));
  writeFileSync(join(f.worktree, "evil", "b.go"), "x");
  f.changedPaths = ["pkg/a.go", "evil/b.go"];
  const s = await runSetup(f, cfg([{ name: "vet", run: "echo {dirs}", paths: ["**/*.go"] }]), runDir);
  assert.doesNotMatch(s.checks[0].command, /evil/);
});

test("a failed reset keeps git's error text out of the brief", async () => {
  const { f, runDir } = wt({ "secret-name.txt": "a\n" });
  const s = await runSetup(f, cfg([{ name: "lock", run: "echo z > secret-name.txt; touch .git/index.lock" }]), runDir);
  assert.ok(s.reset_failed);
  assert.doesNotMatch(setupBrief(s, f.ctxDir), /index\.lock|secret-name/);
});
