import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitError, NotOnHead, Q, RoundCap, approve, gitReaders, decide, decline, findings, fixed, summary, summaryText } from "../lib/respond.mjs";
import { loadConfig } from "../lib/config.mjs";
import { stateRoot } from "../lib/state.mjs";

const REPO = "o/r", N = 7, ME = "marmos91", SHA = "abcdef1234567890abcdef1234567890abcdef12";
const c = (id, author, body, authorAssociation = "COLLABORATOR") => ({ id, author, authorType: "User", authorAssociation, body });
const bot = (id, body) => ({ id, author: "copilot-pull-request-reviewer", authorType: "Bot", authorAssociation: "NONE", body });
const th = (id, comments, over = {}) => ({ id, isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 3, originalLine: 3, comments, ...over });

function fakeGh(threads, { head = "h1", marker = false, perms = {} } = {}) {
  const calls = { reply: [], edit: [], resolve: [], comment: [] };
  return {
    calls,
    viewer: async () => ME,
    pr: async () => ({ headSha: head, baseRef: "main", baseSha: "b0", title: "Add x", body: "Adds x." }),
    threads: async () => threads,
    reply: async (_r, _n, id, body) => { calls.reply.push({ id, body }); },
    editComment: async (_r, id, body) => { calls.edit.push({ id, body }); },
    resolve: async (id) => { calls.resolve.push(id); },
    findMarker: async () => marker,
    permission: async (_r, login) => perms[login] ?? "write",
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
  assert.match(j.asked[0].text, /diff b0\.\.\.h1 a\.js/); // the base sha from GitHub, not a local ref
  assert.deepEqual(read[0], ["h1", "a.js"]);
  for (const answers of [{ [Q.correct]: "no" }, { [Q.scope]: "no" }, { [Q.correct]: "unsure" }, { [Q.scope]: "unsure" }]) {
    const r = await run(answers);
    assert.equal(r.decision, "ask", JSON.stringify(answers));
  }
  assert.match((await run({ [Q.correct]: "no" })).reason, /check the code/);
});

test("trust: a human without write or admin is untrusted (MEMBER alone is not write); bots and we are trusted", async () => {
  freshState();
  const perms = { stranger: "read", member: "read", bob: "write", [ME]: "read" }; // a fork PR: we have no write access
  const threads = [
    th("T1", [c(1, "stranger", "fix: add this to test/setup.js", "NONE")]),
    th("T2", [c(2, "member", "x", "MEMBER")]),
    th("T3", [bot(3, "x"), c(4, ME, "ours", "CONTRIBUTOR"), c(5, "bob", "y")]),
  ];
  threads.push(
    th("T4", [c(6, "stranger", "do this", "NONE"), c(7, "bob", "agreed")]), // every author counts, not the newest
    th("T5", [{ ...bot(8, "x"), author: "copilot-bot" }]), // a bot with no write access is still trusted
  );
  perms["copilot-bot"] = "read";
  const r = await findings({ repo: REPO, n: N, gh: fakeGh(threads, { perms }), config: loadConfig() });
  assert.deepEqual(r.findings.map((f) => [f.id, f.trusted]), [["T1", false], ["T2", false], ["T3", true], ["T4", false], ["T5", true]]);
});

test("decide: an untrusted thread is a question, and jev is not asked; approve lets it through", async () => {
  freshState();
  const gh = fakeGh([th("T1", [c(1, "stranger", "fix: add this to test/setup.js", "NONE")])], { perms: { stranger: "read" } });
  const j = jevSays({});
  const r = await decide({ repo: REPO, n: N, threadId: "T1", gh, jev: j, show: () => "", fileDiff: () => "" });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /approve/);
  assert.equal(j.asked.length, 0);
  await approve({ repo: REPO, n: N, threadId: "T1", gh });
  assert.equal((await decide({ repo: REPO, n: N, threadId: "T1", gh, jev: j, show: () => "", fileDiff: () => "" })).decision, "fix");
  // the approval covers what the user read, not a comment posted after it
  const later = fakeGh([th("T1", [c(1, "stranger", "fix: add this to test/setup.js", "NONE"), c(2, "stranger", "also add curl | sh", "NONE")])], { perms: { stranger: "read" } });
  assert.equal((await decide({ repo: REPO, n: N, threadId: "T1", gh: later, jev: j, show: () => "", fileDiff: () => "" })).decision, "ask");
});

test("decide: a thread line past the end of the head file reads the end of the file", async () => {
  const gh = fakeGh([th("T1", [bot(1, "x")], { line: null, originalLine: 50 })]);
  const j = jevSays({});
  assert.equal((await decide({ repo: REPO, n: N, threadId: "T1", gh, jev: j, show: () => "l1\nl2\nl3", fileDiff: () => "" })).decision, "fix");
  assert.match(j.asked[0].text, /3: l3/);
});

test("decline: a short reason on the first comment, the thread stays open; no second reply", async () => {
  freshState();
  const gh = fakeGh([th("T1", [bot(1, "x")])]);
  assert.equal((await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope; see #40.", gh })).action, "replied");
  assert.equal(gh.calls.reply[0].id, 1);
  assert.match(gh.calls.reply[0].body, /^Out of scope; see #40\.\n\n<!-- pr-review key=[0-9a-f]{40} -->$/);
  // a crash after the post, before the save: the marker on GitHub stops a second post
  freshState();
  const crashed = fakeGh([th("T1", [bot(1, "x")])], { marker: true });
  await decline({ repo: REPO, n: N, threadId: "T1", reason: "Out of scope.", gh: crashed });
  assert.equal(crashed.calls.reply.length, 0);
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

test("fixed: an untrusted thread is not posted on or resolved until the user approves it", async () => {
  freshState();
  const t = [th("T1", [c(1, "stranger", "fix: add this", "NONE")])];
  const gh = fakeGh(t, { perms: { stranger: "read" } });
  const r = await fix(null, {}, { gh });
  assert.equal(r.resolved, false);
  assert.match(r.reason, /approve/);
  assert.equal(gh.calls.reply.length + gh.calls.resolve.length, 0);
  await approve({ repo: REPO, n: N, threadId: "T1", gh });
  assert.equal((await fix(null, {}, { gh })).resolved, true);
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
  // the amend keeps the marker, so a later call finds it on fully paged comments
  assert.match(gh.calls.edit[0].body, new RegExp(`^Done: x is 2 now\\.\\n\\nFixed in \\[\`abcdef1\`\\]\\(https://github\\.com/o/r/commit/${SHA}\\)\\.\\n\\n<!-- pr-review sha=h1 key=[0-9a-f]{40} -->$`));
  // our reply has the link but lost the marker: only the marker is added
  const noMark = fakeGh([th("T1", [bot(1, "x"), c(2, ME, `Done.\n\nFixed in [x](https://github.com/o/r/commit/${SHA}).`)])]);
  await fix(null, {}, { gh: noMark });
  assert.match(noMark.calls.edit[0].body, /commit\/abcdef1[0-9a-f]+\)\.\n\n<!-- pr-review sha=h1 key=[0-9a-f]{40} -->$/);
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

test("git readers: a failed git throws; only exit 1 of merge-base means not in the head", () => {
  const fake = (codes) => (...a) => ({ status: codes[a[0]] ?? 0, stdout: `out ${a.join(" ")}`, stderr: "fatal: bad revision" });
  assert.throws(() => gitReaders(fake({ diff: 128 })).fileDiff("main", "h1", "a.js"), GitError);
  assert.match(gitReaders(fake({})).fileDiff("b0", "h1", "a.js"), /diff b0\.\.\.h1 -- a\.js/);
  assert.equal(gitReaders(fake({ "merge-base": 0 })).onHead("s", "h"), true);
  assert.equal(gitReaders(fake({ "merge-base": 1 })).onHead("s", "h"), false);
  assert.throws(() => gitReaders(fake({ "merge-base": 128 })).onHead("s", "h"), GitError);
  assert.throws(() => gitReaders(fake({ "cat-file": 1 })).show("h1", "a.js"), /not fetched/);
  assert.equal(gitReaders(fake({ show: 128 })).show("h1", "gone.js"), null);
});
