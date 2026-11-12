import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Q, RoundCap, decide, decline, findings, fixed, summary, summaryText } from "../lib/respond.mjs";
import { loadConfig } from "../lib/config.mjs";

const REPO = "o/r", N = 7, ME = "marmos91", SHA = "abcdef1234567890abcdef1234567890abcdef12";
const c = (id, author, body) => ({ id, author, authorType: "User", body });
const th = (id, comments, over = {}) => ({ id, isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 3, originalLine: 3, comments, ...over });

function fakeGh(threads, { head = "h1", marker = false } = {}) {
  const calls = { reply: [], edit: [], resolve: [], comment: [] };
  return {
    calls,
    viewer: async () => ME,
    pr: async () => ({ headSha: head, title: "Add x", body: "Adds x." }),
    threads: async () => threads,
    reply: async (_r, _n, id, body) => { calls.reply.push({ id, body }); },
    editComment: async (_r, id, body) => { calls.edit.push({ id, body }); },
    resolve: async (id) => { calls.resolve.push(id); },
    findMarker: async () => marker,
    comment: async (_r, _n, body) => { calls.comment.push(body); },
  };
}

const freshState = () => { process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), "respond-")); };
const jevSays = (answers) => { const asked = []; const f = async (q) => { asked.push(q); return answers[q] ?? "yes"; }; f.asked = asked; return f; };

test("findings: open threads not answered by us; a council thread (our first comment only) counts", async () => {
  freshState();
  const gh = fakeGh([
    th("T1", [c(1, ME, "**must:** council finding")]),
    th("T2", [c(2, "copilot", "x"), c(3, ME, "Fixed in ...")]),
    th("T3", [c(4, "copilot", "y")]),
    th("T4", [c(5, "bob", "z")], { isResolved: true }),
    th("T5", [c(6, "bob", "z"), c(7, ME, "no"), c(8, "bob", "yes it is")]),
  ]);
  const r = await findings({ repo: REPO, n: N, gh, config: loadConfig() });
  assert.deepEqual(r.findings.map((f) => f.id), ["T1", "T3", "T5"]);
  assert.equal(r.round, 1);
  assert.equal(r.converged, false);
});

test("findings: the round cap stops a PR that does not converge; the same head is not a new round", async () => {
  freshState();
  const config = { ...loadConfig(), respond: { max_rounds: 2 } };
  const threads = [th("T1", [c(1, "copilot", "x")])];
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h1" }), config })).round, 1);
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h1" }), config })).round, 1);
  assert.equal((await findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h2" }), config })).round, 2);
  await assert.rejects(findings({ repo: REPO, n: N, gh: fakeGh(threads, { head: "h3" }), config }), RoundCap);
  // no findings at a new head: converged, not a cap
  const done = await findings({ repo: REPO, n: N, gh: fakeGh([], { head: "h3" }), config });
  assert.equal(done.converged, true);
});

test("decide: jev's three outcomes", async () => {
  const gh = fakeGh([th("T1", [c(1, "copilot", "x is wrong")])]);
  const run = (answers) => decide({ repo: REPO, n: N, threadId: "T1", gh, jev: jevSays(answers) });
  assert.equal((await run({})).decision, "fix");
  assert.equal((await run({ [Q.correct]: "no" })).decision, "decline");
  assert.match((await run({ [Q.scope]: "no" })).reason, /scope/);
  assert.equal((await run({ [Q.scope]: "no" })).decision, "decline");
  assert.equal((await run({ [Q.clear]: "no" })).decision, "ask");
  assert.equal((await run({ [Q.correct]: "unsure" })).decision, "ask");
});

test("decline: a short reason on the first comment, the thread stays open; no second reply", async () => {
  const gh = fakeGh([th("T1", [c(1, "copilot", "x")])]);
  assert.equal((await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope; see #40.", gh })).action, "replied");
  assert.deepEqual(gh.calls.reply, [{ id: 1, body: "Out of scope; see #40." }]);
  assert.equal(gh.calls.resolve.length, 0);
  const again = fakeGh([th("T1", [c(1, "copilot", "x"), c(2, ME, "Out of scope; see #40.")])]);
  assert.equal((await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope.", gh: again })).action, "skipped");
  assert.equal(again.calls.reply.length, 0);
});

test("fixed: resolves only on a jev yes; no or unsure leaves the thread open", async () => {
  for (const [answer, resolved] of [["yes", true], ["no", false], ["unsure", false]]) {
    const gh = fakeGh([th("T1", [c(1, "copilot", "x")])]);
    const r = await fixed({ repo: REPO, n: N, threadId: "T1", sha: SHA, gh, jev: jevSays({ [Q.fixes]: answer }), diff: () => "diff" });
    assert.equal(r.resolved, resolved, answer);
    assert.deepEqual(gh.calls.resolve, resolved ? ["T1"] : []);
    assert.match(gh.calls.reply[0].body, new RegExp(`^Fixed in \\[\`abcdef1\`\\]\\(https://github\\.com/o/r/commit/${SHA}\\)\\.$`));
  }
});

test("fixed: our newest reply gets the link; a rerun never repeats it", async () => {
  const gh = fakeGh([th("T1", [c(1, "copilot", "x"), c(2, ME, "Done: x is 2 now.")])]);
  await fixed({ repo: REPO, n: N, threadId: "T1", sha: SHA, gh, jev: jevSays({}), diff: () => "" });
  assert.equal(gh.calls.reply.length, 0);
  assert.equal(gh.calls.edit[0].body, `Done: x is 2 now.\n\nFixed in [\`abcdef1\`](https://github.com/o/r/commit/${SHA}).`);
  const again = fakeGh([th("T1", [c(1, "copilot", "x"), c(2, ME, gh.calls.edit[0].body)])]);
  await fixed({ repo: REPO, n: N, threadId: "T1", sha: SHA, gh: again, jev: jevSays({}), diff: () => "" });
  assert.equal(again.calls.reply.length + again.calls.edit.length, 0);
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
