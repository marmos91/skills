import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { reply } from "../lib/reply.mjs";
import { askJev } from "../lib/decider.mjs";
import { loadConfig } from "../lib/config.mjs";
import { stateRoot, prState, savePrState } from "../lib/state.mjs";
import { replyPrompt } from "../lib/prompts.mjs";

const REPO = "o/r", N = 5, ME = "marmos91";
const config = loadConfig();

function setup() {
  const root = mkdtempSync(join(tmpdir(), "reply-"));
  process.env.XDG_STATE_HOME = join(root, "state");
  const runDir = join(root, "run-abc123-1");
  mkdirSync(join(runDir, "ctx"), { recursive: true });
  mkdirSync(join(root, "wt"));
  const frame = { headSha: "abc123", baseRef: "main", trusted: true, ownPr: false, ctxDir: join(runDir, "ctx"), worktree: join(root, "wt") };
  return { runDir, frame };
}

const human = (id, author = "bob", body = "This leaks the handle.") => ({ id, author, authorType: "User", body, createdAt: "2026-11-11T00:00:00Z" });
const thread = (comments, over = {}) => ({ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "src/a.js", line: 10, originalLine: 10, comments, ...over });

function fakeGh(t, { perm = "write", marker = false } = {}) {
  const calls = { reply: [], resolve: [], permission: [] };
  return {
    calls,
    viewer: async () => ME,
    threads: async () => [t],
    permission: async (_r, login) => { calls.permission.push(login); return perm; },
    findMarker: async () => marker,
    reply: async (_r, _n, id, body) => { calls.reply.push({ id, body }); return {}; },
    resolve: async (id) => { calls.resolve.push(id); },
  };
}

// Answers by role (the prompt file name); records each call.
function fakeRun(answers) {
  const calls = [];
  const run = async (opts) => {
    const role = basename(opts.promptFile).replace(/\.prompt$/, "");
    calls.push({ role, ...opts, prompt: readFileSync(opts.promptFile, "utf8") });
    return answers[role];
  };
  run.calls = calls;
  return run;
}

const pos = (position, body = `${position} because of x`) => ({ position, body });

async function go({ t, answers, gh = fakeGh(t), jev = async () => "unsure", frame: over = {}, ...rest }) {
  const { runDir, frame } = setup();
  const run = fakeRun(answers);
  const queued = [];
  const out = await reply({ repo: REPO, n: N, threadId: t.id, mode: "loop", frame: { ...frame, ...over }, config, runDir, gh, runChild: run, jev, queue: (q) => queued.push(q), routerUp: true, ...rest });
  return { out, gh, run, queued, runDir };
}

test("draft and challenge agree on push back -> reply posted, thread open", async () => {
  const t = thread([human(111, ME, "**must:** leak"), human(112)]);
  const { out, gh, run, queued } = await go({ t, answers: { draft: pos("push_back"), challenge: pos("push_back"), compose: pos("push_back", "The handle is closed in finally at a.js:20.") } });
  assert.deepEqual([out.action, out.resolved], ["replied", false]);
  assert.equal(gh.calls.reply.length, 1);
  assert.equal(gh.calls.reply[0].id, 111, "reply goes to the thread's first comment");
  assert.match(gh.calls.reply[0].body, /^The handle is closed in finally at a\.js:20\.\n\n<!-- pr-review run=run-abc123-1 sha=abc123 key=[0-9a-f]{40} -->$/);
  assert.deepEqual(gh.calls.resolve, []);
  assert.deepEqual(queued, []);
  assert.deepEqual(run.calls.map((c) => c.role), ["draft", "challenge", "compose"]);
  assert.equal(prState(stateRoot(REPO), N).replies.T1, 1);
});

test("challenger is a seat of another family; routerUp reaches runChild", async () => {
  const t = thread([human(112)]);
  const { run } = await go({ t, answers: { draft: pos("push_back"), challenge: pos("push_back"), compose: pos("push_back") } });
  const [d, c, j] = run.calls;
  assert.deepEqual(d.seat, { max_turns: 40, timeout_minutes: 10, ...config.seats[0] }, "the seat carries its child limits");
  assert.ok(c.seat.harness !== d.seat.harness || c.seat.model.split("/")[0] !== d.seat.model.split("/")[0]);
  assert.deepEqual(j.seat, { ...config.judge, max_turns: 40, timeout_minutes: 10 });
  assert.ok(run.calls.every((x) => x.routerUp === true && x.schema === "reply" && x.worktree));
});

test("own comment last -> skipped, no seat runs", async () => {
  const t = thread([human(112), human(113, ME)]);
  const { out, run, gh } = await go({ t, answers: {} });
  assert.deepEqual(out, { action: "skipped", resolved: false, queued: [] });
  assert.equal(run.calls.length + gh.calls.reply.length, 0);
});

test("a bot comment after a person's comment: the person still gets an answer", async () => {
  const t = thread([human(111, "bob"), { ...human(112, "ci-bot"), authorType: "Bot" }]);
  const { out, gh } = await go({ t, answers: { draft: pos("ask"), challenge: pos("ask"), compose: pos("ask", "Which caller?") } });
  assert.equal(out.action, "replied");
});

test("bot comment or authors_ignore -> skipped", async () => {
  const bot = thread([{ ...human(112, "ci-bot"), authorType: "Bot" }]);
  assert.equal((await go({ t: bot, answers: {} })).out.action, "skipped");
  const ign = thread([human(112, "noisy")]);
  const cfg = { ...config, loop: { ...config.loop, authors_ignore: ["noisy"] } };
  assert.equal((await go({ t: ign, answers: {}, config: cfg })).out.action, "skipped");
});

test("at most one reply per new human comment: marker on GitHub -> no second post", async () => {
  const t = thread([human(112)]);
  const gh = fakeGh(t, { marker: true });
  const { out } = await go({ t, gh, answers: { draft: pos("ask"), challenge: pos("ask"), compose: pos("ask", "Which caller passes null?") } });
  assert.equal(out.action, "replied");
  assert.equal(gh.calls.reply.length, 0);
});

test("only write/admin count as collaborator; others are queued as information", async () => {
  const t = thread([human(112, "stranger")]);
  const gh = fakeGh(t, { perm: "read" });
  const { out, run, queued } = await go({ t, gh, answers: {} });
  assert.equal(out.action, "queued");
  assert.equal(run.calls.length, 0);
  assert.equal(queued[0].reason, "not-collaborator");
});

test("max_replies_per_thread reached -> queued, no seat runs", async () => {
  const { runDir, frame } = setup();
  const s = prState(stateRoot(REPO), N);
  savePrState(stateRoot(REPO), N, { ...s, replies: { T1: config.loop.max_replies_per_thread } });
  const t = thread([human(112)]);
  const run = fakeRun({}), queued = [], gh = fakeGh(t);
  const out = await reply({ repo: REPO, n: N, threadId: "T1", mode: "loop", frame, config, runDir, gh, runChild: run, jev: async () => "yes", queue: (q) => queued.push(q) });
  assert.equal(out.action, "queued");
  assert.equal(run.calls.length, 0);
  assert.equal(queued[0].reason, "budget");
});

test("disagreement -> jev settles: yes means accept", async () => {
  const t = thread([human(112)]);
  const asked = [];
  const jev = async (q, text) => { asked.push({ q, text }); return "yes"; };
  const { out, run } = await go({ t, jev, answers: { draft: pos("push_back"), challenge: pos("accept"), compose: pos("accept", "Agreed, the handle leaks.") } });
  assert.equal(out.action, "replied");
  assert.equal(asked[0].q, "The last comment in this thread, by the other party, is correct about this code.");
  assert.match(asked[0].text, /^The other party is bob, the PR author\. We are marmos91\./);
  assert.match(asked[0].text, /<<<PR-DATA-[0-9a-f]{8}\n/, "thread goes in the nonce wrapper");
  assert.doesNotMatch(asked[0].text, /<thread>/);
  assert.match(run.calls[2].prompt, /"position": "accept"/);
});

test("disagreement + jev unsure -> queued, nothing posted", async () => {
  const t = thread([human(112)]);
  const { out, gh, queued } = await go({ t, answers: { draft: pos("push_back"), challenge: pos("accept") } });
  assert.equal(out.action, "queued");
  assert.equal(gh.calls.reply.length, 0);
  assert.equal(queued[0].reason, "unsure");
  assert.deepEqual(queued[0].positions.map((p) => p.position), ["push_back", "accept"]);
});

test("own PR: draft accepts, challenger pushes back, jev unsure -> queued, never conceded", async () => {
  const t = thread([human(112, "alice")]);
  const { out, gh, run } = await go({ t, frame: { ownPr: true }, answers: { draft: pos("accept"), challenge: pos("push_back") } });
  assert.equal(out.action, "queued");
  assert.equal(gh.calls.reply.length, 0);
  assert.match(run.calls[1].prompt, /Do not accept by default/);
});

test("repeat check: earlier reply of ours and jev says no new argument -> skipped and queued", async () => {
  const t = thread([human(111, ME, "**must:** leak"), human(112), human(113, ME, "Closed in finally."), human(114)]);
  const asked = [];
  const jev = async (q) => { asked.push(q); return "no"; };
  const { out, gh, queued } = await go({ t, jev, answers: { draft: pos("push_back"), challenge: pos("push_back"), compose: pos("push_back", "Closed in finally.") } });
  assert.equal(out.action, "skipped");
  assert.deepEqual(asked, ["This reply adds a new argument or new evidence."]);
  assert.equal(gh.calls.reply.length, 0);
  assert.equal(queued[0].reason, "repeat");
});

test("compose SKIP is never posted", async () => {
  const t = thread([human(112)]);
  const { out, gh } = await go({ t, answers: { draft: pos("push_back"), challenge: pos("push_back"), compose: pos("push_back", "SKIP") } });
  assert.equal(out.action, "skipped");
  assert.equal(gh.calls.reply.length, 0);
});

test("secret in the reply -> queued, not posted", async () => {
  const t = thread([human(112)]);
  const { out, gh, queued } = await go({ t, answers: { draft: pos("ask"), challenge: pos("ask"), compose: pos("ask", "Is AKIAABCDEFGHIJKLMNOP the key?") } });
  assert.equal(out.action, "queued");
  assert.equal(gh.calls.reply.length, 0);
  assert.equal(queued[0].reason, "secret");
  assert.ok(!JSON.stringify(queued).includes("AKIAABCDEFGHIJKLMNOP"));
});

test("resolve only when viewerCanResolve and closed", async () => {
  const agree = { draft: pos("accept"), challenge: pos("accept"), compose: pos("accept", "Right, the guard at a.js:4 covers it.") };
  let r = await go({ t: thread([human(111, ME), human(112)]), answers: agree });
  assert.deepEqual([r.out.resolved, r.gh.calls.resolve], [true, ["T1"]]);
  r = await go({ t: thread([human(111, ME), human(112)], { viewerCanResolve: false }), answers: agree });
  assert.deepEqual([r.out.resolved, r.gh.calls.resolve], [false, []]);
  r = await go({ t: thread([human(112)]), answers: { draft: pos("ask"), challenge: pos("ask"), compose: pos("ask", "Which caller?") } });
  assert.deepEqual([r.out.resolved, r.gh.calls.resolve], [false, []]);
});

test("never resolve again a thread a human reopened", async () => {
  const { runDir, frame } = setup();
  const s = prState(stateRoot(REPO), N);
  const t = thread([human(111, ME), human(112)]);
  savePrState(stateRoot(REPO), N, { ...s, resolved: ["T1"] });
  const gh = fakeGh(t);
  const out = await reply({ repo: REPO, n: N, threadId: "T1", mode: "loop", frame, config, runDir, gh, runChild: fakeRun({ draft: pos("accept"), challenge: pos("accept"), compose: pos("accept", "Right.") }), jev: async () => "yes" });
  assert.deepEqual([out.action, out.resolved, gh.calls.resolve], ["replied", false, []]);
});

test("accepted point on own PR -> reply + todo.md, stays open", async () => {
  const t = thread([human(112, "alice")]);
  const { out, gh } = await go({ t, frame: { ownPr: true }, answers: { draft: pos("accept"), challenge: pos("accept"), compose: pos("accept", "Agreed, I will change this.") } });
  assert.deepEqual([out.action, out.resolved, gh.calls.resolve], ["replied", false, []]);
  const todo = readFileSync(join(stateRoot(REPO), "todo.md"), "utf8");
  assert.equal(todo, "- [ ] PR #5 src/a.js:10: accepted review point, change pending. https://github.com/o/r/pull/5#discussion_r112\n");
});

test("default queue records to the returned object", async () => {
  const { runDir, frame } = setup();
  const t = thread([human(112, "stranger")]);
  const out = await reply({ repo: REPO, n: N, threadId: "T1", mode: "loop", frame, config, runDir, gh: fakeGh(t, { perm: "none" }), runChild: fakeRun({}) });
  assert.equal(out.action, "queued");
  assert.equal(out.queued[0].reason, "not-collaborator");
  assert.equal(out.queued[0].threadId, "T1");
});

test("reply prompts: own PR is defensive in draft and challenge", () => {
  const { frame } = setup();
  const t = thread([human(112)]);
  for (const role of ["draft", "challenge"]) {
    assert.match(replyPrompt({ ...frame, ownPr: true }, t, role, pos("accept")), /Do not accept by default/);
    assert.doesNotMatch(replyPrompt(frame, t, role, pos("accept")), /Do not accept by default/);
  }
});

test("askJev: settles only when the verdict matches the exit code; missing jev -> unsure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-")), bin = join(dir, "bin");
  mkdirSync(bin);
  const make = (verdict, code) => { writeFileSync(join(bin, "jev"), `#!/bin/sh\ncat >"${dir}/in"\necho "$@" >"${dir}/argv"\nprintf '{"verdict":"${verdict}"}'\nexit ${code}\n`); chmodSync(join(bin, "jev"), 0o755); };
  const env = { PATH: `${bin}:/usr/bin:/bin`, GH_TOKEN: "x" };
  const skillDir = join(dir, "skill");
  make("yes", 0);
  assert.equal((await askJev("Q?", "text ghp_" + "a".repeat(36), config, { env, skillDir })).answer, "yes");
  assert.ok(!readFileSync(join(dir, "in"), "utf8").includes("ghp_"), "payload is redacted");
  assert.equal((await askJev("Q?", "key sk-ant-api03-" + "Z".repeat(30), config, { env, skillDir })).answer, "yes");
  assert.ok(!readFileSync(join(dir, "in"), "utf8").includes("sk-ant-"), "an Anthropic key never reaches jev");
  assert.match(readFileSync(join(dir, "argv"), "utf8"), /^ask Q\? --json$/m);
  make("no", 1);
  assert.equal((await askJev("Q?", "t", config, { env, skillDir })).answer, "no");
  make("error", 1);
  assert.equal((await askJev("Q?", "t", config, { env, skillDir })).answer, "unsure");
  make("unsure", 2);
  assert.equal((await askJev("Q?", "t", config, { env, skillDir })).answer, "unsure");
  assert.equal((await askJev("Q?", "t", config, { env: { PATH: "/nonexistent" }, skillDir })).answer, "unsure");
  assert.equal((await askJev("Q?", "t", { ...config, decider: { kind: "off", confidence: 0.5 } }, { env, skillDir })).answer, "unsure");
});

test("jev roles: own PR names the reviewer; others' PR: Marco's finding stands unless jev says the author is right", async () => {
  const split = { draft: pos("push_back"), challenge: pos("accept"), compose: pos("x", "Reply.") };
  let asked = [];
  const jevSays = (v) => async (q, text) => { asked.push(text); return v; };
  let r = await go({ t: thread([human(112, "rev")]), frame: { ownPr: true }, jev: jevSays("no"), answers: split });
  assert.match(asked[0], /^The other party is rev, the reviewer\./);
  assert.match(r.run.calls[2].prompt, /"position": "push_back"/);
  const finding = () => thread([human(111, ME, "**must:** leak"), human(112, "alice", "Not a leak.")]);
  r = await go({ t: finding(), jev: jevSays("no"), answers: split });
  assert.match(asked[1], /^The other party is alice, the PR author\./);
  assert.match(r.run.calls[2].prompt, /"position": "push_back"/);
  assert.deepEqual([r.out.resolved, r.gh.calls.resolve], [false, []], "Marco's finding is not conceded");
  r = await go({ t: finding(), jev: jevSays("yes"), answers: split });
  assert.match(r.run.calls[2].prompt, /"position": "accept"/);
  assert.deepEqual([r.out.resolved, r.gh.calls.resolve], [true, ["T1"]]);
});

test("jev picks a side no seat drafted -> queued as unsure", async () => {
  const { out, gh, queued } = await go({ t: thread([human(112)]), jev: async () => "yes", answers: { draft: pos("push_back"), challenge: pos("ask") } });
  assert.equal(out.action, "queued");
  assert.equal(gh.calls.reply.length, 0);
  assert.equal(queued[0].reason, "unsure");
});

test("never resolve a mention thread between other people", async () => {
  const agree = { draft: pos("accept"), challenge: pos("accept"), compose: pos("accept", "Right.") };
  const r = await go({ t: thread([human(111, "bob"), human(112, "carol")]), answers: agree });
  assert.deepEqual([r.out.action, r.out.resolved, r.gh.calls.resolve], ["replied", false, []]);
});

test("SKIP is normalised before the check", async () => {
  for (const b of ["`SKIP`", "skip.", " Skip! "]) {
    const { out, gh } = await go({ t: thread([human(112)]), answers: { draft: pos("ask"), challenge: pos("ask"), compose: pos("ask", b) } });
    assert.deepEqual([out.action, gh.calls.reply.length], ["skipped", 0], b);
  }
});

test("budget queue item carries the last comment of each side", async () => {
  const { runDir, frame } = setup();
  savePrState(stateRoot(REPO), N, { ...prState(stateRoot(REPO), N), replies: { T1: 2 } });
  const t = thread([human(111, ME, "**must:** leak"), human(112, "bob", "no"), human(113, ME, "yes it is"), human(114, "bob", "still no")]);
  const out = await reply({ repo: REPO, n: N, threadId: "T1", mode: "loop", frame, config, runDir, gh: fakeGh(t), runChild: fakeRun({}) });
  assert.deepEqual(out.queued[0].positions, [
    { side: "ours", commentId: 113, body: "yes it is" },
    { side: "theirs", author: "bob", commentId: 114, body: "still no" },
  ]);
});

test("resolved thread: a new comment counts only after our reply", async () => {
  const agree = { draft: pos("ask"), challenge: pos("ask"), compose: pos("ask", "Which caller?") };
  let r = await go({ t: thread([human(111, "bob"), human(112, "carol")], { isResolved: true }), answers: agree });
  assert.equal(r.out.action, "skipped");
  r = await go({ t: thread([human(111, ME), human(112, "bob")], { isResolved: true }), answers: agree });
  assert.equal(r.out.action, "replied");
});

test("crash after the post: the next run finishes the bookkeeping without posting again", async () => {
  const { runDir, frame } = setup();
  const t = thread([human(111, ME, "**must:** leak"), human(112)]);
  const gh = fakeGh(t);
  gh.reply = async () => { throw new Error("crash after the post landed"); };
  const answers = { draft: pos("accept"), challenge: pos("accept"), compose: pos("accept", "Right, a.js:4 guards it.") };
  const args = { repo: REPO, n: N, threadId: "T1", mode: "loop", frame, config, runDir, runChild: fakeRun(answers), jev: async () => "unsure" };
  await assert.rejects(reply({ ...args, gh }), /crash/);
  assert.ok(prState(stateRoot(REPO), N).pending.T1, "pending record written before the post");
  const after = thread([...t.comments, human(113, ME, "Right, a.js:4 guards it.")]);
  const gh2 = fakeGh(after, { marker: true });
  const run2 = fakeRun({});
  const out = await reply({ ...args, gh: gh2, runChild: run2 });
  assert.deepEqual([out.action, out.resolved, gh2.calls.reply.length, run2.calls.length, gh2.calls.resolve], ["replied", true, 0, 0, ["T1"]]);
  const s = prState(stateRoot(REPO), N);
  assert.deepEqual([s.replies.T1, s.pending.T1], [1, undefined]);
});

test("crash during bookkeeping: finishing twice keeps one todo line", async () => {
  const { runDir, frame } = setup();
  const own = { ...frame, ownPr: true };
  const answers = { draft: pos("accept"), challenge: pos("accept"), compose: pos("accept", "Agreed.") };
  const args = { repo: REPO, n: N, threadId: "T1", mode: "loop", frame: own, config, runDir, jev: async () => "unsure" };
  await reply({ ...args, gh: fakeGh(thread([human(112, "alice")])), runChild: fakeRun(answers) });
  const file = join(stateRoot(REPO), "todo.md");
  const line = readFileSync(file, "utf8");
  assert.ok(line.includes("discussion_r112"));
  // crash after the todo append, before the state save: the pending record survives
  const s = prState(stateRoot(REPO), N);
  savePrState(stateRoot(REPO), N, { ...s, pending: { T1: { key: "k", position: "accept", todo: line, resolve: false } } });
  const after = thread([human(112, "alice"), human(113, ME, "Agreed.")]);
  const out = await reply({ ...args, gh: fakeGh(after, { marker: true }), runChild: fakeRun({}) });
  assert.equal(out.action, "replied");
  assert.equal(readFileSync(file, "utf8"), line);
});

test("a signal during jev queues nothing: its unsure is not an answer", async () => {
  const t = thread([human(111, ME, "**must:** leak"), human(112)]);
  let stop = false;
  const jev = async () => { stop = true; return "unsure"; };
  await assert.rejects(go({ t, jev, stopping: () => stop, answers: { draft: pos("push_back"), challenge: pos("accept") } }), /stopping/);
  // and on the repeat check after compose
  const t2 = thread([human(111, ME, "**must:** leak"), human(113, "bob", "x"), human(114, ME, "y"), human(115)]);
  stop = false;
  const r = go({ t: t2, jev, stopping: () => stop, answers: { draft: pos("push_back"), challenge: pos("push_back"), compose: pos("push_back", "Same as before.") } });
  await assert.rejects(r, /stopping/);
});
