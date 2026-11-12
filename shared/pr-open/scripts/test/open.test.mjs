import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, commit, git } from "./repo.mjs";
import { ghStub } from "./gh.mjs";
import { Blocked, Usage, runTests } from "../lib/counts.mjs";
import { buildBody, openPr, parentOf } from "../lib/open.mjs";

// Pin the scanner: a secret-scan on the developer's PATH must not replace the fallback under test.
process.env.PR_OPEN_SECRET_SCAN = "pr-open-no-such-scanner";
const TOKEN = "ghp_" + "A1b2C3d4".repeat(5); // built at runtime: no token literal in the repo

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
  const fenced = buildBody({ body: "Template:\n\n```md\n## Tests\n\nEdit me.\n```\n\n## Why\n\nBecause.\n", record });
  assert.match(fenced, /```md\n## Tests\n\nEdit me\.\n```\n\n## Why\n\nBecause\./);
  const tilde = buildBody({ body: "Intro.\n\n~~~md\n## Tests\n\nEdit me.\n~~~\n\n   ```md\n## Tests\n   ```\n\n## Why\n\nBecause.\n", record });
  assert.match(tilde, /~~~md\n## Tests\n\nEdit me\.\n~~~\n\n   ```md\n## Tests\n   ```\n\n## Why/);
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

test("a base with no open PR is a plain base: no marker, no stack line", async () => {
  const { dir, bodyFile } = await stack();
  const gh = ghStub(routes({ "pr list --head feat/a": { stdout: [] } }));
  const r = await openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" });
  assert.equal(r.base, "feat/a"); assert.equal(r.parent, null);
  assert.ok(r.warnings.includes("feat/a has no open PR: opened as a plain base, no parent marker"));
  const body = bodyOf(created(gh));
  assert.equal(parentOf(body), null);
  assert.doesNotMatch(body, /Stacked on/);
});

test("a secret added while resolving a merge: blocked", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  git(dir, "checkout", "-q", "-b", "side");
  commit(dir, "s.txt", "s", "feat: side");
  git(dir, "checkout", "-q", "feat/b");
  commit(dir, "t.txt", "t", "feat: t");
  git(dir, "merge", "-q", "--no-ff", "--no-commit", "side");
  writeFileSync(join(dir, "evil.txt"), `token=${"ghp_" + "A1b2C3d4".repeat(5)}\n`);
  git(dir, "add", "evil.txt");
  git(dir, "commit", "-q", "-S", "-m", "Merge side");
  await runTests(dir, 'echo "ℹ pass 1"', { quiet: true });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.hits.length > 0);
  assert.equal(created(gh), undefined);
});

test("a collaborator pushed to the branch: the push fails, their commit stays", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  git(dir, "push", "-q", "-u", "origin", "feat/b");
  const other = join(dir, "..", `clone-${Date.now()}`);
  git(dir, "clone", "-q", "-b", "feat/b", git(dir, "remote", "get-url", "origin"), other);
  git(other, "config", "user.name", "C"); git(other, "config", "user.email", "c@example.com");
  writeFileSync(join(other, "c.txt"), "c"); git(other, "add", "c.txt"); git(other, "commit", "-q", "--no-gpg-sign", "-m", "feat: c");
  git(other, "push", "-q", "origin", "feat/b");
  const theirs = git(other, "rev-parse", "HEAD");
  git(dir, "fetch", "-q", "origin");
  git(dir, "commit", "-q", "-S", "--amend", "-m", "feat: b, reworded");
  await runTests(dir, 'echo "ℹ pass 1"', { quiet: true });
  ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }));
  assert.equal(git(dir, "ls-remote", "origin", "feat/b").split("\t")[0], theirs);
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

test("a secret added in one commit and removed in the next: blocked", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  commit(dir, "conf.txt", `token=${"ghp_" + "A1b2C3d4".repeat(5)}\n`, "feat: conf");
  commit(dir, "conf.txt", "token=\n", "fix: drop token");
  await runTests(dir, 'echo "ℹ pass 1"', { quiet: true });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.hits.length > 0);
  assert.equal(created(gh), undefined);
});

test("a secret in the test command would reach the body: blocked", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  await runTests(dir, `echo "ℹ pass 1" # ${"ghp_" + "A1b2C3d4".repeat(5)}`, { quiet: true });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.hits.length > 0);
  assert.equal(created(gh), undefined);
});

test("a secret in the title: blocked, no PR", async () => {
  const { dir, bodyFile } = await stack();
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: `feat: use ${TOKEN}`, bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.hits.length > 0);
  assert.equal(created(gh), undefined);
});

test("secret-scan on PATH is used, and its hit blocks", async (t) => {
  const { dir, bodyFile } = await stack();
  const bin = mkdtempSync(join(tmpdir(), "pr-open-scan-"));
  writeFileSync(join(bin, "secret-scan"), "#!/bin/sh\ncat >/dev/null\necho 'rule-x: abcd…' >&2\nexit 1\n");
  chmodSync(join(bin, "secret-scan"), 0o755);
  process.env.PR_OPEN_SECRET_SCAN = join(bin, "secret-scan"); t.after(() => { process.env.PR_OPEN_SECRET_SCAN = "pr-open-no-such-scanner"; });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.hits[0] === "rule-x: abcd…");
  assert.equal(created(gh), undefined);
});

test("a base that exists only on origin is fetched", async () => {
  const { dir, bodyFile } = await stack();
  const other = join(dir, "..", `clone-rel-${Date.now()}`);
  git(dir, "clone", "-q", git(dir, "remote", "get-url", "origin"), other);
  git(other, "push", "-q", "origin", "main:release/x");
  const gh = ghStub(routes({ "pr list --head release/x": { stdout: [] } }));
  const r = await openPr(dir, { title: "feat: b", bodyFile, base: "release/x" });
  assert.equal(r.base, "release/x");
  assert.ok(created(gh));
});

test("the branch moves while open runs: blocked, nothing pushed", async (t) => {
  const { dir, bodyFile } = await stack();
  const bin = mkdtempSync(join(tmpdir(), "pr-open-scan-"));
  writeFileSync(join(bin, "secret-scan"), `#!/bin/sh\ncat >/dev/null\ngit -C '${dir}' commit -q --allow-empty --no-gpg-sign -m sneaky\nexit 0\n`);
  chmodSync(join(bin, "secret-scan"), 0o755);
  process.env.PR_OPEN_SECRET_SCAN = join(bin, "secret-scan"); t.after(() => { process.env.PR_OPEN_SECRET_SCAN = "pr-open-no-such-scanner"; });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && /moved/.test(e.message));
  assert.equal(created(gh), undefined);
  assert.equal(remoteHas(dir, "feat/b"), false);
});

test("an AI word that the test command adds to the body: blocked", async () => {
  const { dir, bodyFile } = await stack({ test: false });
  await runTests(dir, 'echo "ℹ pass 1" # not llm', { quiet: true });
  const gh = ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => e instanceof Blocked && e.detail.ai?.some((x) => x.where === "body"));
  assert.equal(created(gh), undefined);
});

test("a base origin does not have is a Usage error; a broken remote is not", async () => {
  const { dir, bodyFile } = await stack();
  ghStub(routes());
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "nope" }), (e) => e instanceof Usage && /origin has no branch nope/.test(e.message));
  git(dir, "remote", "set-url", "origin", join(dir, "..", "no-such-origin"));
  await assert.rejects(openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" }), (e) => !(e instanceof Usage) && /git fetch origin feat\/a failed/.test(e.message));
});

test("a single-branch clone fetches the base into origin/<base>", async () => {
  const { dir, bodyFile } = await stack();
  git(dir, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  git(dir, "update-ref", "-d", "refs/remotes/origin/feat/a");
  ghStub(routes());
  const r = await openPr(dir, { title: "feat: b", bodyFile, base: "feat/a" });
  assert.equal(r.parent, "feat/a");
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
