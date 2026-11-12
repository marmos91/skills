import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initRepo, commit, git } from "./repo.mjs";
import { ghStub } from "./gh.mjs";
import { Blocked, runTests } from "../lib/counts.mjs";
import { Usage, buildBody, openPr, parentOf } from "../lib/open.mjs";

// main <- feat/a (pushed, PR #7) <- feat/b (current, tested)
async function stack({ test = true } = {}) {
  const dir = initRepo({ origin: true });
  git(dir, "checkout", "-q", "-b", "feat/a");
  commit(dir, "a.txt", "a", "feat: a");
  git(dir, "push", "-q", "-u", "origin", "feat/a");
  git(dir, "checkout", "-q", "-b", "feat/b");
  commit(dir, "b.txt", "b", "feat: b");
  if (test) await runTests(dir, 'echo "ℹ pass 2"; echo "ℹ fail 0"', { quiet: true });
  const bodyFile = join(dir, "..", `body-${Date.now()}-${Math.random()}.md`);
  writeFileSync(bodyFile, "Adds b.\n\nCloses #3\n");
  return { dir, bodyFile };
}

const routes = (extra = {}) => ({
  "repo view": { stdout: { defaultBranchRef: { name: "main" } } },
  "pr list --head feat/a": { stdout: [{ number: 7, url: "https://github.com/o/r/pull/7" }] },
  "pr list --head feat/b": { stdout: [] },
  "pr create": { stdout: "https://github.com/o/r/pull/8\n" },
  ...extra,
});
const created = (gh) => gh.calls().find((c) => c.argv[0] === "pr" && c.argv[1] === "create");
const bodyOf = (call) => readFileSync(call.argv[call.argv.indexOf("--body-file") + 1], "utf8");
const remoteHas = (dir, branch) => git(dir, "ls-remote", "origin", branch) !== "";

test("parentOf reads the marker", () => {
  assert.equal(parentOf("x\n<!-- pr-open parent: feat/a -->"), "feat/a");
  assert.equal(parentOf("no marker"), null);
});

test("buildBody: the tests line comes from the record and replaces an agent-written section", () => {
  const record = { sha: "abcdef1234", command: "npm test", exit: 0, counts: { passed: 5, failed: 0, skipped: 1 } };
  const out = buildBody({ body: "Intro.\n\n## Tests\n\n99 passed.\n\n## Breaking changes\n\nNone.\n", record });
  assert.doesNotMatch(out, /99 passed/);
  assert.match(out, /## Breaking changes\n\nNone\./);
  assert.match(out, /## Tests\n\n`npm test` at abcdef1: 5 passed, 0 failed, 1 skipped\./);
  const none = buildBody({ body: "x", record: { ...record, counts: null } });
  assert.match(none, /`npm test` at abcdef1: counts not found in the output\./);
});

test("stacked PR: base is the parent, body names it, marker is last", async () => {
  const { dir, bodyFile } = await stack();
  const gh = ghStub(routes());
  const r = await openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" });
  assert.equal(r.base, "feat/a"); assert.equal(r.parent, "feat/a");
  assert.equal(r.number, 8); assert.equal(r.url, "https://github.com/o/r/pull/8");
  const call = created(gh);
  assert.equal(call.argv[call.argv.indexOf("--base") + 1], "feat/a");
  assert.ok(!call.argv.includes("--draft"));
  const body = bodyOf(call);
  assert.match(body, /^Stacked on #7\.\n/);
  assert.match(body, /<!-- pr-open parent: feat\/a -->\n?$/);
  assert.equal(parentOf(body), "feat/a");
  assert.match(body, /: 2 passed, 0 failed, 0 skipped\./);
  assert.ok(remoteHas(dir, "feat/b"));
});

test("base = default branch: no marker, parent null", async () => {
  const { dir, bodyFile } = await stack();
  const gh = ghStub(routes());
  const r = await openPr(dir, { title: "feat: b", bodyFile });
  assert.equal(r.base, "main"); assert.equal(r.parent, null);
  const body = bodyOf(created(gh));
  assert.equal(parentOf(body), null);
  assert.doesNotMatch(body, /Stacked on/);
});

test("parent without an open PR: Usage error, no push", async () => {
  const { dir, bodyFile } = await stack();
  const gh = ghStub(routes({ "pr list --head feat/a": { stdout: [] } }));
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Usage && /open a PR for feat\/a first/.test(e.message));
  assert.equal(created(gh), undefined);
  assert.equal(remoteHas(dir, "feat/b"), false);
});

test("no record for HEAD: blocked; a record for an older sha does not count", async () => {
  const { dir, bodyFile } = await stack();
  commit(dir, "c.txt", "c", "feat: c");
  ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && /no test run for/.test(e.message));
  assert.equal(remoteHas(dir, "feat/b"), false);
});

test("failed tests: blocked", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  await runTests(dir, 'echo "ℹ pass 1"; echo "ℹ fail 1"; exit 1', { quiet: true });
  ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && /tests failed/.test(e.message));
});

test("unsigned commit: blocked, nothing pushed", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  commit(dir, "u.txt", "u", "feat: u", { sign: false });
  await runTests(dir, 'echo "ℹ pass 1"', { quiet: true });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.unsigned.length === 1);
  assert.equal(created(gh), undefined);
});

test("secret in the diff: blocked, the hit is masked, nothing pushed", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  const token = "ghp_" + "A1b2C3d4".repeat(5); // built at runtime: no token literal in the repo
  commit(dir, "conf.txt", `token=${token}\n`, "feat: conf");
  await runTests(dir, 'echo "ℹ pass 1"', { quiet: true });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => {
    assert.ok(e instanceof Blocked);
    assert.ok(!JSON.stringify(e.detail).includes(token) && !e.message.includes(token));
    assert.ok(e.detail.hits.length > 0);
    return true;
  });
  assert.equal(created(gh), undefined);
  assert.equal(remoteHas(dir, "feat/b"), false);
});

test("a PR is already open: returned, no push, no create", async () => {
  const { dir, bodyFile } = await stack();
  const gh = ghStub(routes({ "pr list --head feat/b": { stdout: [{ number: 9, url: "https://github.com/o/r/pull/9" }] } }));
  const r = await openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" });
  assert.equal(r.number, 9); assert.deepEqual(r.warnings, ["a PR is already open"]);
  assert.equal(created(gh), undefined);
  assert.equal(remoteHas(dir, "feat/b"), false);
});

test("--draft passes --draft to gh; a body with no #N gets a warning", async () => {
  const { dir, bodyFile } = await stack();
  writeFileSync(bodyFile, "Adds b.\n");
  const gh = ghStub(routes());
  const r = await openPr(dir, { title: "feat: b", bodyFile, base: "feat/a", draft: true });
  assert.ok(created(gh).argv.includes("--draft"));
  assert.ok(r.warnings.includes("no linked issue"));
});

test("branch pushed, then amended, no PR yet: the push succeeds", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  git(dir, "push", "-q", "-u", "origin", "feat/b");
  git(dir, "commit", "-q", "-S", "--amend", "-m", "feat: b, reworded");
  await runTests(dir, 'echo "ℹ pass 1"', { quiet: true });
  ghStub(routes());
  await openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" });
  assert.equal(git(dir, "rev-parse", "origin/feat/b"), git(dir, "rev-parse", "HEAD"));
});
