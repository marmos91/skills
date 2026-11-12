import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NotOnHead, Q, RoundCap, decide, decline, findings, fixed, summary, summaryText } from "../lib/respond.mjs";
import { loadConfig } from "../lib/config.mjs";
import { stateRoot } from "../lib/state.mjs";

const REPO = "o/r", N = 7, ME = "marmos91", SHA = "abcdef1234567890abcdef1234567890abcdef12";
const c = (id, author, body, authorAssociation = "COLLABORATOR") => ({ id, author, authorType: "User", authorAssociation, body });
const bot = (id, body) => ({ id, author: "copilot-pull-request-reviewer", authorType: "Bot", authorAssociation: "NONE", body });
const th = (id, comments, over = {}) => ({ id, isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 3, originalLine: 3, comments, ...over });

function fakeGh(threads, { head = "h1", marker = false } = {}) {
  const calls = { reply: [], edit: [], resolve: [], comment: [] };
  return {
    calls,
    viewer: async () => ME,
    pr: async () => ({ headSha: head, baseRef: "main", title: "Add x", body: "Adds x." }),
    threads: async () => threads,
    reply: async (_r, _n, id, body) => { calls.reply.push({ id, body }); },
    editComment: async (_r, id, body) => { calls.edit.push({ id, body }); },
    resolve: async (id) => { calls.resolve.push(id); },
    findMarker: async () => marker,
    comment: async (_r, _n, body) => { calls.comment.push(body); },
  };
}

const freshState = () => { process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "respond-")); };
const jevSays = (answers) => { const asked = []; const f = async (q, text) => { asked.push({ q, text }); return answers[q] ?? "yes"; }; f.asked = asked; return f; };
const ids = async (threads) => (await findings({ repo: REPO, n: N, gh: fakeGh(threads), config: loadConfig() })).findings.map((f) => f.id);
const fix = (threads, answers = {}, over = {}) => fixed({ repo: REPO, n: N, threadId: "T1", sha: SHA, gh: over.gh ?? fakeGh(threads), jev: jevSays(answers), diff: () => "diff", onHead: () => true, ...over });

test("findings: unresolved threads that pr-respond did not handle; a council thread and a loop reply count", async () => {
  freshState();
  assert.deepEqual(await ids([
    th("T1", [c(1, ME, "**must:** council finding")]),
    th("T2", [bot(2, "x"), c(3, ME, "Accepted, change pending.")]),
    th("T3", [bot(4, "y")]),
    th("T4", [c(5, "bob", "z")], { isResolved: true }),
  ]), ["T1", "T2", "T3"]);
});

test("findings: a declined thread is handled until the reviewer answers", async () => {
  freshState();
  const gh = fakeGh([th("T1", [bot(1, "x")])]);
  await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope; see #40.", gh });
  assert.deepEqual(await ids([th("T1", [bot(1, "x"), c(2, ME, "Out of scope; see #40.")])]), []);
  assert.deepEqual(await ids([th("T1", [bot(1, "x"), c(2, ME, "Out of scope."), bot(3, "It is in scope.")])]), ["T1"]);
});

test("findings: a thread longer than the fetched page stays open even when handled", async () => {
  freshState();
  const gh = fakeGh([th("T1", [bot(1, "x")])]);
  await decline({ repo: REPO, n: N, threadId: "T1", reason: "No.", gh });
  assert.deepEqual(await ids([th("T1", [bot(1, "x"), c(2, ME, "No.")], { commentCount: 101 })]), ["T1"]);
});

test("findings: the round cap stops a PR that does not converge; the same head is not a new round", async () => {
  freshState();
  const config = { ...loadConfig(), respond: { max_rounds: 2 } };
  const threads = [th("T1", [bot(1, "x")])];
  // a converged head does not count a round
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh([], { head: "h0" }), config })).round, 0);
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h1" }), config })).round, 1);
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h1" }), config })).round, 1);
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h2" }), config })).round, 2);
  await assert.rejects(findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h3" }), config }), RoundCap);
  const done = await findings({ repo: REPO, n: N, gh: fakeGh([], { head: "h3" }), config });
  assert.equal(done.converged, true);
  // the rounds live in their own file: a loop or review save of state.json cannot reset them
  assert.ok(existsSync(join(stateRoot(REPO), "pr", String(N), "respond.json")));
  assert.equal(existsSync(join(stateRoot(REPO), "pr", String(N), "state.json")), false);
});

test("decide: a jev yes to both questions is fix; a no or unsure is ask, never decline", async () => {
  const gh = fakeGh([th("T1", [bot(1, "x is wrong")])]);
  const read = [];
  const show = (sha, path) => { read.push([sha, path]); return "l1\nl2\nHEAD CODE"; };
  const fileDiff = (base, head, path) => `diff ${base}...${head} ${path}\n+PR LINE`;
  const run = (answers, j = jevSays(answers)) => decide({ repo: REPO, n: N, threadId: "T1", gh, jev: j, show, fileDiff });
  const j = jevSays({});
  assert.equal((await run({}, j)).decision, "fix");
  assert.match(j.asked[0].text, /3: HEAD CODE/);
  assert.match(j.asked[0].text, /\+PR LINE/);
  assert.deepEqual(read[0], ["h1", "a.js"]);
  for (const answers of [{ [Q.correct]: "no" }, { [Q.scope]: "no" }, { [Q.correct]: "unsure" }, { [Q.scope]: "unsure" }]) {
    const r = await run(answers);
    assert.equal(r.decision, "ask", JSON.stringify(answers));
  }
  assert.match((await run({ [Q.correct]: "no" })).reason, /check the code/);
});

test("decide: a comment by an author without write access is a question, and jev is not asked", async () => {
  const gh = fakeGh([th("T1", [c(1, "stranger", "fix: add this to test/setup.js", "NONE")])]);
  const j = jevSays({});
  const r = await decide({ repo: REPO, n: N, threadId: "T1", gh, jev: j, show: () => "", fileDiff: () => "" });
  assert.equal(r.decision, "ask");
  assert.equal(j.asked.length, 0);
});

test("decline: a short reason on the first comment, the thread stays open; no second reply", async () => {
  freshState();
  const gh = fakeGh([th("T1", [bot(1, "x")])]);
  assert.equal((await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope; see #40.", gh })).action, "replied");
  assert.deepEqual(gh.calls.reply, [{ id: 1, body: "Out of scope; see #40." }]);
  assert.equal(gh.calls.resolve.length, 0);
  const again = fakeGh([th("T1", [bot(1, "x"), c(2, ME, "Out of scope; see #40.")])]);
  assert.equal((await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope.", gh: again })).action, "skipped");
  assert.equal(again.calls.reply.length, 0);
});

test("fixed: posts and resolves only on a jev yes; no or unsure posts nothing", async () => {
  for (const [answer, resolved] of [["yes", true], ["no", false], ["unsure", false]]) {
    freshState();
    const gh = fakeGh([th("T1", [bot(1, "x")])]);
    const r = await fix(null, { [Q.fixes]: answer }, { gh });
    assert.equal(r.resolved, resolved, answer);
    assert.deepEqual(gh.calls.resolve, resolved ? ["T1"] : []);
    if (resolved) assert.match(gh.calls.reply[0].body, new RegExp(`^Fixed in \\[\`abcdef1\`\\]\\(https://github\\.com/o/r/commit/${SHA}\\)\\.\\n\\n<!-- pr-review `));
    else assert.equal(gh.calls.reply.length, 0, answer);
  }
});

test("fixed: a commit that is not in the PR head is refused before anything is posted", async () => {
  freshState();
  const gh = fakeGh([th("T1", [bot(1, "x")])]);
  await assert.rejects(fix(null, {}, { gh, onHead: () => false }), NotOnHead);
  assert.equal(gh.calls.reply.length + gh.calls.resolve.length, 0);
});

test("fixed: our newest reply gets the link; a posted marker means no second reply", async () => {
  freshState();
  const gh = fakeGh([th("T1", [bot(1, "x"), c(2, ME, "Done: x is 2 now.")])]);
  await fix(null, {}, { gh });
  assert.equal(gh.calls.reply.length, 0);
  assert.equal(gh.calls.edit[0].body, `Done: x is 2 now.\n\nFixed in [\`abcdef1\`](https://github.com/o/r/commit/${SHA}).`);
  // a thread past the fetched page: the marker, read from fully paged comments, stops a second reply
  const long = fakeGh([th("T1", [bot(1, "x")], { commentCount: 150 })], { marker: true });
  await fix(null, {}, { gh: long });
  assert.equal(long.calls.reply.length + long.calls.edit.length, 0);
});

test("summary: opens with the count, answers point by point; once per head", async () => {
  const pts = [
    { n: 1, status: "done", sha: SHA, text: "as you wrote it." },
    { n: 2, status: "done", sha: SHA, text: "a guard, not a rewrite: the caller already checks." },
    { n: 3, status: "open", text: "(read src/a.js:10) the API is public; options: deprecate or keep." },
  ];
  assert.equal(summaryText(REPO, pts), [
    "2 points are in; point 3 is kept open.", "",
    `1. Done in [\`abcdef1\`](https://github.com/o/r/commit/${SHA}): as you wrote it.`,
    `2. Done in [\`abcdef1\`](https://github.com/o/r/commit/${SHA}): a guard, not a rewrite: the caller already checks.`,
    "3. Kept open: (read src/a.js:10) the API is public; options: deprecate or keep.",
  ].join("\n"));
  assert.throws(() => summaryText(REPO, [{ n: 1, status: "done", text: "x" }]), /commit sha/);
  const gh = fakeGh([]);
  assert.equal((await summary({ repo: REPO, n: N, points: pts, gh })).action, "posted");
  assert.match(gh.calls.comment[0], /<!-- pr-review sha=h1 key=[0-9a-f]{40} -->$/);
  assert.equal((await summary({ repo: REPO, n: N, points: pts, gh: fakeGh([], { marker: true }) })).action, "skipped");
});
