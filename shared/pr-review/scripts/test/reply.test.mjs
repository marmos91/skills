import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { reply, askJev } from "../lib/reply.mjs";
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
  assert.deepEqual(d.seat, config.seats[0]);
  assert.ok(c.seat.harness !== d.seat.harness || c.seat.model.split("/")[0] !== d.seat.model.split("/")[0]);
  assert.deepEqual(j.seat, config.judge);
  assert.ok(run.calls.every((x) => x.routerUp === true && x.schema === "reply" && x.worktree));
});

test("own comment last -> skipped, no seat runs", async () => {
  const t = thread([human(112), human(113, ME)]);
  const { out, run, gh } = await go({ t, answers: {} });
  assert.deepEqual(out, { action: "skipped", resolved: false, queued: [] });
  assert.equal(run.calls.length + gh.calls.reply.length, 0);
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
  assert.equal(asked[0].q, "The reviewer's comment is correct about this code.");
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
  assert.match(todo, /^- \[ \] PR #5 src\/a\.js:10 \(thread T1\): Agreed, I will change this\.$/m);
  assert.ok(!todo.includes("leaks the handle"), "reviewer text stays out of engine text");
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
  assert.equal(await askJev("Q?", "text ghp_" + "a".repeat(36), config, { env, skillDir }), "yes");
  assert.ok(!readFileSync(join(dir, "in"), "utf8").includes("ghp_"), "payload is redacted");
  assert.match(readFileSync(join(dir, "argv"), "utf8"), /^ask Q\? --json --confidence 0\.5$/m);
  make("no", 1);
  assert.equal(await askJev("Q?", "t", config, { env, skillDir }), "no");
  make("error", 1);
  assert.equal(await askJev("Q?", "t", config, { env, skillDir }), "unsure");
  make("unsure", 2);
  assert.equal(await askJev("Q?", "t", config, { env, skillDir }), "unsure");
  assert.equal(await askJev("Q?", "t", config, { env: { PATH: "/nonexistent" }, skillDir }), "unsure");
  assert.equal(await askJev("Q?", "t", { ...config, decider: { kind: "off", confidence: 0.5 } }, { env, skillDir }), "unsure");
});
