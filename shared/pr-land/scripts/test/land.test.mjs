import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initRepo, commit, git } from "../../../pr-open/scripts/test/repo.mjs";
import { ghStub } from "../../../pr-open/scripts/test/gh.mjs";
import { land, notReady, repoOfUrl, squash, stackOrder, Blocked } from "../lib/land.mjs";
import { main } from "../main.mjs";
import { answer, appliedAnswer, queueQuestion } from "../../../pr-review/scripts/lib/questions.mjs";
import { stateRoot, summaryMarker } from "../../../pr-review/scripts/lib/state.mjs";

// Pin the scanner: a secret-scan on the developer's PATH must not replace the fallback under test.
process.env.PR_LAND_SECRET_SCAN = "pr-land-no-such-scanner";
process.env.PR_LAND_POLL_MS = "0";
process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "pr-land-state-")); // never the user's pr-review state
const TOKEN = "ghp_" + "A1b2C3d4".repeat(5); // built at runtime: no token literal in the repo

const HEAD = "a".repeat(40), ME = "me";
const OURS = { repository: { name: "r", owner: { login: "o" } } };
const mark = (sha, must = 0, questions = 0, gaps = 0) => summaryMarker("r1", sha, "0123", { must, questions, gaps });
const ready = (over = {}) => ({
  number: 27, title: "feat(x): a", body: "Adds a.\n\nCloses #40\n", state: "OPEN", isDraft: false,
  headRefName: "feat/a", headRefOid: HEAD, baseRefName: "main", mergeable: "MERGEABLE", reviewDecision: "",
  statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }],
  reviews: [{ state: "COMMENTED", author: { login: ME }, body: `No new findings.\n\n${mark(HEAD)}` }],
  closingIssuesReferences: [{ number: 40, ...OURS }], isCrossRepository: false, ...over,
});
const rv = (marker, login = ME, state = "COMMENTED") => ({ state, author: { login }, body: `Text.\n\n${marker}` });

test("notReady: a converged PR is ready", () => assert.deepEqual(notReady(ready(), 0, ME), []));

test("notReady: each gap is named", () => {
  const cases = [
    [{ isDraft: true }, 0, /draft/],
    [{ mergeable: "CONFLICTING" }, 0, /mergeable is CONFLICTING/],
    [{ mergeable: "UNKNOWN" }, 0, /mergeable is UNKNOWN/],
    [{ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: "" }] }, 0, /test is pending/],
    [{ statusCheckRollup: [{ __typename: "StatusContext", context: "ci", state: "PENDING" }] }, 0, /ci is pending/],
    [{ statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }] }, 0, /test is failure/],
    [{}, 2, /2 review threads are unresolved/],
    [{ reviews: [] }, 0, /no approval of the head and no full pr-review review by me/],
    [{ reviews: [rv(mark("b".repeat(40)))] }, 0, /review is on bbbbbbb, the head is aaaaaaa/],
    [{ reviews: [rv(mark(HEAD, 1))] }, 0, /1 open must/],
    [{ reviews: [rv(mark(HEAD, 0, 2))] }, 0, /2 pr-review questions not settled/],
    [{ reviews: [rv(mark(HEAD, 0, 0, 1))] }, 0, /incomplete: 1 lens or seat missing/],
    // a marker pasted by anyone else does not count
    [{ reviews: [rv(mark(HEAD, 1)), rv(mark(HEAD), "mallory")] }, 0, /1 open must/],
    // a follow-up (no must=/questions=) does not hide the full review before it
    [{ reviews: [rv(mark(HEAD, 1)), rv(`<!-- pr-review run=r1 sha=${HEAD} key=0123 -->`)] }, 0, /1 open must/],
    // a marker from an older pr-review without the fields is not a clean review
    [{ reviews: [rv(`<!-- pr-review run=r1 sha=${HEAD} key=0123 -->`)] }, 0, /no full pr-review review/],
    // a human request for changes blocks, whatever pr-review said
    [{ reviewDecision: "CHANGES_REQUESTED", reviews: [rv(mark(HEAD)), rv("", "alice", "CHANGES_REQUESTED")] }, 0, /changes requested by alice/],
    [{ reviewDecision: "CHANGES_REQUESTED" }, 0, /changes requested by a reviewer/],
    // pr-review's own request on the head stands while its newest full review has a must
    [{ reviewDecision: "CHANGES_REQUESTED", reviews: [rv(mark(HEAD, 1), ME, "CHANGES_REQUESTED")] }, 0, /1 open must/],
  ];
  for (const [over, unresolved, re] of cases) assert.match(notReady(ready(over), unresolved, ME).join("; "), re, JSON.stringify(over));
});

test("notReady: pr-review's own old request for changes is settled by its newest full review", () => {
  const old = rv(mark("b".repeat(40), 1), ME, "CHANGES_REQUESTED");
  assert.deepEqual(notReady(ready({ reviewDecision: "CHANGES_REQUESTED", reviews: [old, rv(mark(HEAD))] }), 0, ME), []);
});

test("notReady: local question state replaces the frozen marker count when the run is on this machine", () => {
  const pr = ready({ reviews: [rv(mark(HEAD, 0, 1))] });
  assert.deepEqual(notReady(pr, 0, ME, (runId) => (runId === "r1" ? 0 : null)), [], "answered since the review");
  assert.match(notReady(pr, 0, ME, () => null).join(), /1 pr-review question not settled/, "another machine: the marker decides");
  assert.match(notReady(ready(), 0, ME, () => 2).join(), /2 pr-review questions not settled/, "asked after the review");
});

const approval = (oid = HEAD) => ({ state: "APPROVED", author: { login: "bob" }, commit: { oid }, body: "" });

test("notReady: an approval of the head stands in for the pr-review review, not for CI or threads", () => {
  assert.deepEqual(notReady(ready({ reviews: [approval()], reviewDecision: "APPROVED" }), 0, ME), []);
  assert.match(notReady(ready({ reviews: [approval()], reviewDecision: "APPROVED", mergeable: "CONFLICTING" }), 1, ME).join("; "), /CONFLICTING.*1 review thread is unresolved/);
  // pr-review's older full review does not overrule an approval of the head
  assert.deepEqual(notReady(ready({ reviews: [rv(mark("b".repeat(40), 1)), approval()], reviewDecision: "APPROVED" }), 0, ME), []);
});

test("notReady: an approval does not overrule pr-review's full review on the head, nor count when it is stale", () => {
  for (const [m, re] of [[mark(HEAD, 1), /1 open must/], [mark(HEAD, 0, 1), /1 pr-review question not settled/], [mark(HEAD, 0, 0, 1), /incomplete/]]) {
    assert.match(notReady(ready({ reviews: [rv(m), approval()], reviewDecision: "APPROVED" }), 0, ME).join(), re);
  }
  assert.match(notReady(ready({ reviews: [approval("b".repeat(40))], reviewDecision: "APPROVED" }), 0, ME).join(), /no approval of the head/);
});

test("repoOfUrl: GitHub https, scp and ssh forms with a port; no other host, no local path", () => {
  for (const u of ["https://github.com/O/R.git", "https://github.com/o/r", "https://github.com/o/r/", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git",
    "ssh://git@github.com:22/o/r.git", "ssh://git@ssh.github.com:443/o/r.git", "https://user@github.com/o/r.git"]) assert.equal(repoOfUrl(u), "o/r", u);
  for (const u of ["/home/me/github.com/o/r.git", "https://mygithub.com/o/r.git", "https://gitlab.com/mirror/github.com/o/r.git", "https://github.com.evil.io/o/r.git",
    "file:///srv/github.com/o/r.git", "https://github.com/x/o/r.git", "../r.git"]) assert.equal(repoOfUrl(u), null, u);
});

test("squash: the title gets (#N) once; bad titles, AI mentions and secrets are blocked", () => {
  assert.deepEqual(squash(ready({ body: "Adds a.<!-- pr-open parent: x -->" })), { title: "feat(x): a (#27)", message: "Adds a." });
  assert.equal(squash(ready({ title: "feat(x): a (#27)" })).title, "feat(x): a (#27)");
  assert.throws(() => squash(ready({ title: "Add a" })), /conventional/);
  assert.throws(() => squash(ready({ title: `feat: ${"x".repeat(70)}` })), /conventional/);
  assert.throws(() => squash(ready({ body: "Written with Claude." })), (e) => e instanceof Blocked && e.detail.ai[0] === "claude");
  assert.throws(() => squash(ready({ body: `token ${TOKEN}` })), (e) => e instanceof Blocked && !JSON.stringify(e.detail).includes(TOKEN));
});

test("squash: the private-repos opt-out applies only when the PR's repo and the push target are listed", (t) => {
  const cfg = mkdtempSync(join(tmpdir(), "pr-land-ss-"));
  writeFileSync(join(cfg, "private.txt"), "example\\.internal\n");
  writeFileSync(join(cfg, "private-repos.txt"), "o/r\n");
  const old = process.env.SECRET_SCAN_CONFIG;
  process.env.SECRET_SCAN_CONFIG = cfg;
  t.after(() => (old === undefined ? delete process.env.SECRET_SCAN_CONFIG : (process.env.SECRET_SCAN_CONFIG = old)));
  const pr = ready({ body: "Moves the cache to db01.example.internal." });
  assert.equal(squash(pr, [], ["o/r", "o/r"]).title, "feat(x): a (#27)");
  assert.throws(() => squash(pr, [], ["o/r", null]), /secret scan/); // a push target off GitHub: strict
  assert.throws(() => squash(pr), /secret scan/);
});

test("stackOrder: parents first, whatever the order given", () => {
  const p = (number, headRefName, baseRefName) => ({ number, headRefName, baseRefName });
  assert.deepEqual(stackOrder([p(29, "c", "b"), p(28, "b", "a"), p(27, "a", "main")]), [27, 28, 29]);
  // a fork PR from contributor:main into main is not its own parent, nor the parent of a PR on main
  assert.deepEqual(stackOrder([{ ...p(70, "main", "main"), isCrossRepository: true }]), [70]);
  assert.deepEqual(stackOrder([p(27, "a", "main"), { ...p(70, "main", "main"), isCrossRepository: true }]), [27, 70]);
});

// main <- feat/a (#27, head A) <- feat/b (#29, head B). origin/main already holds the squash of #27, as GitHub would after the merge.
function stack({ conflict = false } = {}) {
  const dir = initRepo({ origin: true });
  git(dir, "checkout", "-q", "-b", "feat/a");
  const A = commit(dir, "a.txt", "a\n", "feat: a");
  git(dir, "push", "-q", "origin", "feat/a");
  git(dir, "checkout", "-q", "-b", "feat/b");
  const B = commit(dir, "a.txt", "b\n", "feat: b");
  git(dir, "push", "-q", "origin", "feat/b");
  git(dir, "checkout", "-q", "main");
  commit(dir, "a.txt", "a\n", "feat(x): a (#27)");
  if (conflict) commit(dir, "a.txt", "z\n", "fix: z");
  git(dir, "push", "-q", "origin", "main");
  // The PR's repo is the remote "upstream"; "origin" is a fork pr-land must not fetch from or push to.
  const bare = git(dir, "remote", "get-url", "origin");
  git(dir, "remote", "rename", "origin", "upstream");
  git(dir, "remote", "set-url", "upstream", "https://github.com/o/r.git");
  git(dir, "config", `url.${bare}.insteadOf`, "https://github.com/o/r.git");
  git(dir, "remote", "add", "origin", join(dir, "..", "no-such-fork.git"));
  const wt = join(dir, "..", `wt-${Date.now()}-${Math.random()}`);
  git(dir, "worktree", "add", "-q", wt, "feat/a");
  return { dir, A, B, wt };
}

const routes = ({ A, B }, extra = {}) => ({
  "repo view": { stdout: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } } },
  "api user": { stdout: { login: ME } },
  "pr view 27": { stdout: ready({ headRefOid: A, reviews: [rv(mark(A))] }) },
  "graphql Threads": { stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [{ isResolved: true, comments: { nodes: [] } }] } } } } } },
  // listed at the check, then (retargeted) gone before the delete
  "pr list --base feat/a": [{ stdout: [{ number: 29, headRefName: "feat/b", headRefOid: B, isCrossRepository: false, body: "Stacked on #27.\n\n<!-- pr-open parent: feat/a -->\n" }] }, { stdout: [] }],
  "api repos/o/r/git/ref/heads/feat/a": { stdout: { object: { sha: A } } },
  "pr edit 29": { stdout: "" },
  "api -X PUT repos/o/r/pulls/27/merge-async": { stdout: { status: "pending", details: { uuid: "u1" } } },
  "api repos/o/r/pulls/27/merge-async/u1": { stdout: { status: "merged", details: { message: "ok" } } },
  "api -X DELETE repos/o/r/git/refs/heads/feat/a": { stdout: "" },
  "api repos/o/r/issues/40": { stdout: { number: 40, state: "open", body: "Part of #12." } },
  "api repos/o/r/issues/12": { stdout: { number: 12, state: "open", body: "- [ ] #40 pr-land\n- [ ] #39 secret-scan\n" } },
  "api -X PATCH repos/o/r/issues/12": { stdout: "{}" },
  "api -X PATCH repos/o/r/issues/40": { stdout: "{}" },
  ...extra,
});

async function run(t, dir, args) {
  const out = [];
  t.mock.method(console, "log", (l) => out.push(l));
  t.mock.method(console, "error", () => {});
  const cwd = process.cwd(); process.chdir(dir); t.after(() => process.chdir(cwd));
  const code = await main(args);
  return { code, json: JSON.parse(out.join("\n")) };
}
const at = (gh, key) => gh.calls().findIndex((c) => c.key.startsWith(key));
const mutations = (gh) => (existsSync(join(gh.dir, "mutations.jsonl")) ? readFileSync(join(gh.dir, "mutations.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

test("land() passes the scanner --repo for the PR's repo and what a push to the PR's remote reaches", async (t) => {
  const s = stack();
  git(s.dir, "config", "--unset", git(s.dir, "config", "--get-regexp", "^url\\.").split(" ")[0]); // the push URL is on GitHub again
  ghStub(routes(s));
  const bin = join(mkdtempSync(join(tmpdir(), "pr-land-scan-")), "scan");
  writeFileSync(bin, '#!/bin/sh\necho "args: $*" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  const old = process.env.PR_LAND_SECRET_SCAN;
  process.env.PR_LAND_SECRET_SCAN = bin;
  t.after(() => { process.env.PR_LAND_SECRET_SCAN = old; });
  const args = async () => { try { await land(s.dir, 27, { dryRun: true }); } catch (e) { return e.detail?.hits?.[0]; } };
  // the PR's remote is "upstream" (o/r); "origin" is a local path and must not be what is checked
  assert.equal(await args(), "args: --repo o/r --repo o/r");
  git(s.dir, "config", "remote.upstream.pushurl", "https://gitlab.example.internal/o/r.git");
  assert.equal(await args(), "args: --repo o/r --repo"); // a push off GitHub: an empty --repo, strict
});

test("a stacked child: retargeted after the merge and before the delete, kept open, rebased on the new base; the tracking item ticked and the issue closed", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 0, JSON.stringify(json));
  const [r] = json.landed;
  assert.deepEqual([r.retargeted, r.rebased, r.ticked, r.closed], [[29], [29], [12], [40]]);

  // retarget, then merge, then delete: never a delete while #29 still points at feat/a
  // merge, then retarget, then delete: a failed merge leaves #29 alone, and the branch never goes while #29 points at it
  assert.ok(at(gh, "api -X PUT") >= 0 && at(gh, "api -X PUT") < at(gh, "pr edit 29 --base main") && at(gh, "pr edit 29") < at(gh, "api -X DELETE"));
  const put = gh.calls().find((c) => c.key.startsWith("api -X PUT")).argv;
  for (const f of ["merge_method=squash", `sha=${s.A}`, "commit_title=feat(x): a (#27)", "merge_action=direct_merge"]) assert.ok(put.includes(f), f);
  assert.ok(!gh.calls().some((c) => /\bclose\b/.test(c.key) && c.key.includes("29")), "#29 is never closed");

  // feat/b now sits on the new main with only its own commit, signed, pushed over the old head
  const b = git(s.dir, "ls-remote", "upstream", "refs/heads/feat/b").split("\t")[0];
  assert.notEqual(b, s.B);
  git(s.dir, "fetch", "-q", "upstream");
  assert.equal(git(s.dir, "rev-parse", `${b}^`), git(s.dir, "rev-parse", "upstream/main"));
  assert.equal(git(s.dir, "show", `${b}:a.txt`), "b");
  assert.match(git(s.dir, "cat-file", "commit", b), /^gpgsig/m);

  // local worktree and branch of #27 are gone; no temp worktree is left
  assert.ok(!existsSync(s.wt));
  assert.equal(git(s.dir, "branch", "--list", "feat/a"), "");
  assert.equal(git(s.dir, "worktree", "list").split("\n").length, 1);

  const patch = (k) => mutations(gh).find((m) => m.key.startsWith(`api -X PATCH repos/o/r/issues/${k}`)).argv;
  assert.ok(patch(12).includes("body=- [x] #40 pr-land (#27)\n- [ ] #39 secret-scan\n"));
  assert.ok(patch(40).includes("state=closed"));
});

test("a child GitHub manages as a stack: the edit is refused, GitHub's retarget is checked before the delete", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s, {
    "pr edit 29": { stderr: "Cannot change the base branch because the pull request is part of a stack", exit: 1 },
    "pr view 29": { stdout: { baseRefName: "main", state: "OPEN" } },
  }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.landed[0].githubRetargeted, [29]);
  assert.ok(at(gh, "api -X PUT") < at(gh, "pr view 29") && at(gh, "pr view 29") < at(gh, "api -X DELETE"));
  assert.deepEqual(json.landed[0].rebased, [29]);
});

test("a child left on the old base by GitHub: the branch is kept, the run stops after the merge", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s, {
    "pr edit 29": { stderr: "part of a stack", exit: 1 },
    "pr view 29": { stdout: { baseRefName: "feat/a", state: "CLOSED" } },
  }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 4);
  assert.deepEqual(json.done, ["check", "merge", "retarget children"]);
  assert.match(json.error, /#29 is closed on feat\/a.*feat\/a was kept/);
  assert.equal(at(gh, "api -X DELETE"), -1);
});

test("a child that conflicts: the rebase is aborted, its branch untouched, the run stops and says what is left", async (t) => {
  const s = stack({ conflict: true });
  ghStub(routes(s));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 2);
  assert.match(json.blocked, /#29 \(feat\/b\) conflicts with main/);
  assert.deepEqual(json.notDone, ["rebase children", "issues", "local cleanup"]);
  assert.equal(git(s.dir, "ls-remote", "upstream", "refs/heads/feat/b").split("\t")[0], s.B);
  assert.equal(git(s.dir, "worktree", "list").split("\n").length, 2); // the repo and the user's feat/a worktree: no temp one
});

test("a failed merge leaves the children where they were and deletes nothing", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s, { "api repos/o/r/pulls/27/merge-async/u1": { stdout: { status: "failed", details: { message: "head moved" } } } }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 4);
  assert.deepEqual([json.done, json.error], [["check"], "merge failed: head moved"]);
  assert.deepEqual(mutations(gh).map((m) => m.key.split(" ").slice(0, 4).join(" ")), ["api -X PUT repos/o/r/pulls/27/merge-async"]);
});

test("a PR still based on the head before the delete: the branch is kept and the run stops", async (t) => {
  const s = stack();
  const late = { number: 31, headRefName: "feat/c", headRefOid: s.B, isCrossRepository: false, body: "" };
  const gh = ghStub(routes(s, { "pr list --base feat/a": [{ stdout: [] }, { stdout: [late] }] }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 2);
  assert.match(json.blocked, /#31 still based on feat\/a: the branch was kept/);
  assert.equal(at(gh, "api -X DELETE"), -1);
});

test("more children than one list holds: blocked before the merge", async (t) => {
  const s = stack();
  const many = Array.from({ length: 1001 }, (_, i) => ({ number: 100 + i, headRefName: `x${i}`, headRefOid: s.B, isCrossRepository: false, body: "" }));
  const gh = ghStub(routes(s, { "pr list --base feat/a": { stdout: many } }));
  const { code, json } = await run(t, s.dir, ["27"]);

  assert.equal(code, 2, JSON.stringify(json).slice(0, 400));
  assert.match(json.blocked, /more than 1000 open PRs are based on feat\/a/);
  assert.ok(gh.calls().find((c) => c.key.startsWith("pr list --base")).argv.includes("1001"));
  assert.deepEqual(mutations(gh), []);
});

test("a PR on the head without pr-open's parent marker: retargeted so it stays open, never rebased or force-pushed", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s, { "pr list --base feat/a": [{ stdout: [{ number: 29, headRefName: "feat/b", headRefOid: s.B, isCrossRepository: false, body: "Unrelated work on feat/a." }] }, { stdout: [] }] }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual([json.landed[0].retargeted, json.landed[0].rebased], [[29], []]);
  assert.ok(json.landed[0].notes.includes("#29 has no pr-open parent marker for feat/a: retargeted, not rebased"));
  assert.equal(git(s.dir, "ls-remote", "upstream", "refs/heads/feat/b").split("\t")[0], s.B);
  assert.ok(at(gh, "pr edit 29") >= 0);
});

test("the delete: each path segment encoded, and only when the branch is still at the merged head", async (t) => {
  for (const [name, at0, deleted] of [["fix#12/a%2Fb", null, true], ["feat/a", "c".repeat(40), false]]) {
    const s = stack();
    const enc = name.split("/").map(encodeURIComponent).join("/");
    const gh = ghStub(routes(s, {
      "pr view 27": { stdout: ready({ headRefOid: s.A, headRefName: name, reviews: [rv(mark(s.A))] }) },
      [`pr list --base ${name}`]: { stdout: [] },
      [`api repos/o/r/git/ref/heads/${enc}`]: { stdout: { object: { sha: at0 ?? s.A } } },
      [`api -X DELETE repos/o/r/git/refs/heads/${enc}`]: { stdout: "" },
    }));
    const { code, json } = await run(t, s.dir, ["27"]);
    assert.equal(code, 0, JSON.stringify(json));
    assert.equal(mutations(gh).some((m) => m.key === `api -X DELETE repos/o/r/git/refs/heads/${enc}`), deleted, name);
    if (!deleted) assert.ok(json.landed[0].notes.includes("feat/a moved to ccccccc after the merge: kept"));
  }
});

test("the AI-mention check takes the allow list of .pr-open.json", async (t) => {
  const s = stack();
  writeFileSync(join(s.dir, ".pr-open.json"), JSON.stringify({ allow: ["copilot"] }));
  ghStub(routes(s, { "pr view 27": { stdout: ready({ headRefOid: s.A, reviews: [rv(mark(s.A))], body: "Asks Copilot for a review.\n\nCloses #40\n" }) } }));
  const { code, json } = await run(t, s.dir, ["27", "--dry-run"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.throws(() => squash(ready({ body: "Asks Copilot." })), /AI or tool mentions/);
});

test("a fork PR: no children, its head branch kept; a closing reference to another repo is left alone", async (t) => {
  const s = stack();
  const other = { number: 5, repository: { name: "lib", owner: { login: "other" } } };
  const gh = ghStub(routes(s, {
    "pr view 27": { stdout: ready({ headRefOid: s.A, isCrossRepository: true, reviews: [rv(mark(s.A))], body: "Adds a.\n\nCloses #40, fixes other/lib#5\n", closingIssuesReferences: [{ number: 40, ...OURS }, other] }) },
  }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual([json.landed[0].retargeted, json.landed[0].closed], [[], [40]]);
  assert.equal(at(gh, "pr list --base"), -1);
  assert.equal(at(gh, "pr edit"), -1);
  assert.equal(at(gh, "api -X DELETE"), -1);
  assert.ok(!gh.calls().some((c) => c.key.includes("issues/5")));
});

test("a PR that is not ready: nothing is merged, nothing is changed", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s, {
    "pr view 27": { stdout: ready({ headRefOid: s.A, statusCheckRollup: [{ __typename: "CheckRun", name: "test", status: "QUEUED" }] }) },
  }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 2);
  assert.deepEqual(json.why, ["check test is pending", `the newest pr-review review is on ${HEAD.slice(0, 7)}, the head is ${s.A.slice(0, 7)}`]);
  assert.deepEqual(json.done, []);
  assert.deepEqual(mutations(gh), []);
  assert.ok(existsSync(s.wt));
});

test("no git remote points at the PR's repo: nothing is merged", async (t) => {
  const s = stack();
  git(s.dir, "remote", "set-url", "upstream", "https://github.com/x/other.git");
  const gh = ghStub(routes(s));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 2);
  assert.match(json.blocked, /no git remote of this clone points at github\.com\/o\/r/);
  assert.deepEqual(mutations(gh), []);
});

test("a question in pr-review's local state blocks, though the marker says none, until a run applies the answer", async (t) => {
  const s = stack();
  const st = stateRoot("o/r");
  mkdirSync(join(st, "pr", "27", "runs", "r1"), { recursive: true });
  const id = queueQuestion(st, { pr: 27, sha: s.A, fingerprint: "f".repeat(40), file: "a.txt", line: 1, snippet: "a", finding: { title: "t", severity: "should" }, sides: { keep: "k", drop: "d" }, failure: "" });
  t.after(() => rmSync(st, { recursive: true, force: true }));
  const gh = ghStub(routes(s));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 2);
  assert.deepEqual(json.why, ["1 pr-review question not settled"]);
  // answered "post", not yet posted by a pr-review run: the finding is not on GitHub yet, so it still blocks
  answer(st, id, "post");
  const again = await run(t, s.dir, ["27"]);
  assert.deepEqual([again.code, again.json.why], [2, ["1 pr-review question not settled"]]);
  appliedAnswer(st, id);
  // a loop question (approve) is not about the code: it does not block
  queueQuestion(st, { pr: 27, sha: s.A, fingerprint: "e".repeat(40), file: "", line: 0, snippet: "", finding: { kind: "approve", title: "Approve?" }, sides: { keep: "k", drop: "d" }, failure: "" });
  const third = await run(t, s.dir, ["27", "--dry-run"]);
  assert.equal(third.code, 0, JSON.stringify(third.json));
  assert.deepEqual(mutations(gh), []);
});

test("a worktree that cannot be removed: the issues are still ticked and closed, the failure is reported", async (t) => {
  const s = stack();
  git(s.dir, "worktree", "lock", s.wt); // git worktree remove refuses a locked tree
  const gh = ghStub(routes(s));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 4);
  assert.deepEqual(json.notDone, ["local cleanup"]);
  assert.ok(mutations(gh).some((m) => m.key.startsWith("api -X PATCH repos/o/r/issues/12")));
  assert.ok(mutations(gh).some((m) => m.key.startsWith("api -X PATCH repos/o/r/issues/40")));
  assert.ok(existsSync(s.wt));
});

test("local cleanup keeps what is not the merged head: a fork's branch, a moved branch, a worktree with untracked or ignored files", async (t) => {
  const cases = {
    fork: (s) => ({ "pr view 27": { stdout: ready({ headRefOid: s.A, isCrossRepository: true, reviews: [rv(mark(s.A))] }) } }),
    moved: (s) => { commit(s.wt, "c.txt", "c", "wip"); return {}; },
    ignored: (s) => { writeFileSync(join(s.wt, ".gitignore"), ".env\n"); git(s.wt, "add", ".gitignore"); git(s.wt, "commit", "-q", "--amend", "--no-edit", "-S"); return { "pr view 27": { stdout: ready({ headRefOid: git(s.wt, "rev-parse", "HEAD"), reviews: [rv(mark(git(s.wt, "rev-parse", "HEAD")))] }) } }; },
  };
  for (const [name, setup] of Object.entries(cases)) {
    const s = stack();
    const extra = setup(s);
    if (name === "ignored") { git(s.wt, "push", "-q", "-f", "upstream", "feat/a"); writeFileSync(join(s.wt, ".env"), "SECRET=1\n"); }
    ghStub(routes(s, extra));
    const { code, json } = await run(t, s.dir, ["27"]);
    assert.equal(code, 0, `${name}: ${JSON.stringify(json)}`);
    assert.ok(existsSync(s.wt), `${name}: the worktree is kept`);
    assert.equal(git(s.dir, "branch", "--list", "feat/a").trim(), "+ feat/a", name);
  }
});

test("a #N in the body that is no issue is skipped with a note; the step goes on", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s, { "pr view 27": { stdout: ready({ headRefOid: s.A, reviews: [rv(mark(s.A))], body: "Colour is now #000000. Was #77 (deleted). Closes #40\n" }) } }));
  const { code, json } = await run(t, s.dir, ["27"]);
  assert.equal(code, 0, JSON.stringify(json));
  assert.deepEqual(json.landed[0].closed, [40]);
  assert.deepEqual([json.landed[0].ticked, json.landed[0].notes], [[12], ["#77 could not be read: skipped"]]);
  assert.ok(!gh.calls().some((c) => c.key === "api repos/o/r/issues/0"), "#000000 is no issue number");
});

test("--dry-run prints the plan and changes nothing", async (t) => {
  const s = stack();
  const gh = ghStub(routes(s));
  const { code, json } = await run(t, s.dir, ["27", "--dry-run"]);
  assert.equal(code, 0);
  assert.deepEqual([json.landed[0].title, json.landed[0].children], ["feat(x): a (#27)", [29]]);
  assert.deepEqual(mutations(gh), []);
});

test("usage: a PR number is required", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal(await main([]), 1);
  assert.equal(await main(["abc"]), 1);
});
