import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync } from "node:fs";
import { main, realDeps } from "../main.mjs";
import { loadState } from "../lib/converge.mjs";
import { answer, queueQuestion } from "../../../pr-review/scripts/lib/questions.mjs";
import { prState, savePrState, stateRoot } from "../../../pr-review/scripts/lib/state.mjs";

const REPO = "example/app";
const sha = (c) => c.repeat(40);
const finding = (fp, severity = "should") => ({ fp, severity, title: `finding ${fp}` });

// Fresh state and config folders; quiet output. Returns the parsed JSON of the last run.
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "pr-converge-"));
  for (const k of ["XDG_STATE_HOME", "XDG_CONFIG_HOME", "PR_CONVERGE_SECRET_SCAN"]) {
    const old = process.env[k];
    t.after(() => { if (old === undefined) delete process.env[k]; else process.env[k] = old; });
  }
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
  const out = [];
  t.mock.method(console, "log", (l) => out.push(l));
  t.mock.method(console, "error", () => {});
  return { dir, last: () => JSON.parse(out.at(-1)) };
}

// Fake steps. reviews: one entry per review call, { findings, questions }; the head follows our pushes.
function fakes(reviews, { landResult = { merged: true, commit: sha("f") } } = {}) {
  const calls = { review: 0, respond: 0, land: 0, posts: [] };
  let head = sha("a"), pushes = 0;
  const deps = {
    head: async () => head,
    review: async () => { const r = reviews[calls.review++]; return { sha: head, findings: r.findings ?? [], questions: r.questions ?? 0 }; },
    // fixes every finding of the round: one done point per fingerprint, on a new commit
    respond: async (s) => {
      calls.respond++;
      head = sha("bcde"[pushes++]);
      return { sha: head, points: s.rounds.at(-1).findings.map((f, i) => ({ n: i + 1, status: "done", sha: head, fp: f.fp, text: `fixed ${f.fp}.` })) };
    },
    checks: async () => "green",
    land: async () => { calls.land++; return landResult; },
    post: async (body) => { calls.posts.push(body); },
  };
  return { deps, calls, moveHead: (s) => { head = s; } };
}

const run = (deps, ...flags) => main(["run", "7", "--repo", REPO, ...flags], { deps });

test("converges in 2 rounds, then calls pr-land and posts one summary", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("a1", "must")] }, { findings: [] }]);
  assert.equal(await run(f.deps, "--merge"), 0);
  assert.equal(last().status, "merged");
  assert.deepEqual([f.calls.review, f.calls.respond, f.calls.land], [2, 1, 1]);
  assert.equal(f.calls.posts.length, 1);
  assert.match(f.calls.posts[0], /Rounds: 1 \(1 finding/);
  assert.match(f.calls.posts[0], /Merge commit: \[`fffffff`\]/);
  // a rerun after the end does nothing and posts nothing more
  assert.equal(await run(f.deps, "--merge"), 0);
  assert.deepEqual([f.calls.review, f.calls.land, f.calls.posts.length], [2, 1, 1]);
});

test("the round cap stops after converge.max_rounds and never merges", async (t) => {
  setup(t);
  const f = fakes(["a", "b", "c", "d", "e"].map((x) => ({ findings: [finding(x)] })));
  assert.equal(await run(f.deps, "--merge"), 5);
  assert.deepEqual([f.calls.review, f.calls.respond, f.calls.land], [4, 3, 0]);
  assert.equal(loadState(REPO, 7).result, "capped");
  assert.match(f.calls.posts[0], /Still open:\n- should: finding d/);
});

test("the cap comes from the config", async (t) => {
  const { dir } = setup(t);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ converge: { max_rounds: 2 } }));
  const f = fakes(["a", "b", "c"].map((x) => ({ findings: [finding(x)] })));
  assert.equal(await run(f.deps, "--config", join(dir, "config.json")), 5);
  assert.equal(f.calls.review, 2);
});

test("no progress: the same fingerprints two rounds in a row stop the loop", async (t) => {
  setup(t);
  const f = fakes([{ findings: [finding("a1")] }, { findings: [finding("a1")] }, { findings: [] }]);
  assert.equal(await run(f.deps, "--merge"), 5);
  assert.equal(loadState(REPO, 7).result, "stalled");
  assert.deepEqual([f.calls.review, f.calls.respond, f.calls.land], [2, 1, 0]);
});

test("a user question pauses the loop; --resume reviews the same round again and keeps its findings", async (t) => {
  const { last } = setup(t);
  // the rerun after the answer adds nothing: round 1's finding still needs a respond step
  const f = fakes([{ findings: [finding("a1")], questions: 1 }, { findings: [] }, { findings: [] }]);
  assert.equal(await run(f.deps, "--merge"), 3);
  assert.equal(last().pause.kind, "question");
  // without --resume the pause holds and nothing runs
  assert.equal(await run(f.deps), 3);
  assert.equal(f.calls.review, 1);
  assert.equal(await run(f.deps, "--resume"), 0);
  assert.equal(last().status, "merged");
  assert.deepEqual(last().rounds.map((r) => r.fps), [["a1"], []]);
  assert.deepEqual([f.calls.review, f.calls.respond, f.calls.land], [3, 1, 1]);
});

test("a round pr-review skips is not a clean round: it pauses, and --resume reviews again with restart", async (t) => {
  const { last } = setup(t);
  const f = fakes([]);
  delete f.deps.review; // the real step, around a fake pr-review engine
  const asked = [];
  const review = async (o) => { asked.push(!!o.restart); return asked.length === 1 ? { exit: 0, skipped: true, summary: "already reviewed it" } : { exit: 0, summary: "posted" }; };
  assert.equal(await main(["run", "7", "--repo", REPO, "--merge"], { deps: f.deps, review }), 3);
  assert.equal(last().pause.kind, "review-skipped");
  assert.equal(f.calls.land, 0);
  assert.equal(await main(["run", "7", "--repo", REPO, "--resume"], { deps: f.deps, review }), 0);
  assert.deepEqual(asked, [false, true]);
  assert.equal(f.calls.land, 1);
});

test("red checks pause before land; a pushed fix is reviewed as a new round, then lands", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [] }, { findings: [] }]);
  f.deps.checks = async (s) => (s === sha("c") ? "green" : "red");
  assert.equal(await run(f.deps, "--merge"), 3);
  assert.equal(last().pause.kind, "checks");
  assert.equal(f.calls.land, 0);
  f.moveHead(sha("c")); // the agent pushes a fix for CI
  assert.equal(await run(f.deps, "--resume"), 0);
  assert.deepEqual([f.calls.review, f.calls.land, last().head], [2, 1, sha("c")]);
});

test("--merge after a converged run lands it", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [] }]);
  assert.equal(await run(f.deps), 0);
  assert.equal(last().status, "converged");
  assert.equal(await run(f.deps, "--merge"), 0);
  assert.equal(last().status, "merged");
  assert.deepEqual([f.calls.review, f.calls.land], [1, 1]);
});

test("--points that is not a list of points is refused and not saved", async (t) => {
  const { dir } = setup(t);
  const f = fakes([{ findings: [finding("a1")] }, { findings: [] }]);
  delete f.deps.respond;
  assert.equal(await run(f.deps), 2);
  const bad = join(dir, "bad.json");
  for (const v of [{ n: 1 }, [{ n: 1, status: "done", text: "x" }], [{ n: 1, status: "maybe", text: "x" }]]) {
    writeFileSync(bad, JSON.stringify(v));
    assert.equal(await run(f.deps, "--pushed", sha("b"), "--points", bad), 1);
  }
  assert.equal(loadState(REPO, 7).phase, "respond");
  assert.equal(loadState(REPO, 7).pushed, undefined);
});

test("a push not from the loop pauses it; --resume reviews the new head", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("a1")] }, { findings: [] }]);
  f.deps.respond = async () => { f.moveHead(sha("9")); return { sha: sha("b"), points: [] }; }; // someone else pushed after us
  assert.equal(await run(f.deps, "--merge"), 3);
  assert.equal(last().pause.kind, "foreign-push");
  assert.equal(f.calls.review, 1);
  assert.equal(await run(f.deps, "--resume"), 0);
  assert.deepEqual([f.calls.review, f.calls.land], [2, 1]);
});

test("without --merge a converged PR is reported and not merged", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [] }]);
  assert.equal(await run(f.deps), 0);
  assert.equal(last().status, "converged");
  assert.equal(f.calls.land, 0);
  assert.match(f.calls.posts[0], /not merged/);
});

test("the respond step hands over to the agent; --pushed counts for one step only", async (t) => {
  const { dir, last } = setup(t);
  const f = fakes([{ findings: [finding("a1")] }, { findings: [finding("c1")] }, { findings: [] }]);
  delete f.deps.respond; // the real step: the agent runs pr-respond
  assert.equal(await run(f.deps), 2);
  assert.equal(last().status, "respond");
  const points = join(dir, "points.json");
  writeFileSync(points, JSON.stringify([{ n: 1, status: "open", text: "out of scope: the caller checks it." }]));
  f.moveHead(sha("b"));
  // round 2 raises a new finding: the agent's turn again, not the round-1 push replayed
  assert.equal(await run(f.deps, "--pushed", sha("b"), "--points", points), 2);
  assert.equal(last().round, 2);
  f.moveHead(sha("c"));
  assert.equal(await run(f.deps, "--pushed", sha("c")), 0);
  assert.match(f.calls.posts[0], /Declined:\n- out of scope/);
});

test("a land that is not ready pauses; --rebased after a conflict lands without a new round", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [] }], { landResult: { blocked: "mergeable is CONFLICTING" } });
  assert.equal(await run(f.deps, "--merge"), 3);
  assert.equal(last().pause.kind, "land");
  f.deps.land = async () => ({ merged: true, commit: sha("f") });
  f.moveHead(sha("c")); // the conflict-only rebase, pushed
  assert.equal(await run(f.deps, "--rebased", sha("c")), 0);
  assert.deepEqual([f.calls.review, last().head], [1, sha("c")]);
});

// A fake pr-review engine: each call runs the next step, which may record a review the way review() does.
function engine(steps) {
  const asked = [];
  const review = async (o) => { asked.push(o); return steps[asked.length - 1](); };
  const post = (sha, agreed = []) => { const st = prState(stateRoot(REPO), 7); savePrState(stateRoot(REPO), 7, { ...st, lastReviewedSha: sha, agreed: [...(st.agreed ?? []), ...agreed] }); };
  return { review, asked, post };
}

test("a pr-review stop with no question (core paths unset) is not a clean round", async (t) => {
  const { last } = setup(t);
  const f = fakes([]);
  delete f.deps.review;
  // a pr-review-loop question on the same PR is open: it must not hide the skip
  queueQuestion(stateRoot(REPO), { pr: 7, sha: sha("a"), fingerprint: "e".repeat(40), file: "(whole PR)", line: 0, snippet: "", finding: { kind: "approve", title: "Approve?", case: "c" }, sides: { keep: "k", drop: "d" }, failure: "" });
  const e = engine([() => ({ exit: 3, corePaths: { repo: REPO, candidates: [] }, summary: "core paths not set" })]);
  assert.equal(await main(["run", "7", "--repo", REPO, "--merge"], { deps: f.deps, review: e.review }), 3);
  assert.equal(last().pause.kind, "review-skipped");
  assert.equal(f.calls.land, 0);
});

test("a round that stops at a question keeps the head it was called on", async (t) => {
  const { last } = setup(t);
  const f = fakes([]);
  delete f.deps.review;
  const rs = () => stateRoot(REPO);
  const e = engine([
    () => { e.post(sha("a"), [{ id: "a1", severity: "should", title: "a1" }]); return { exit: 0, summary: "posted" }; },
    // round 2 on b: a split question stops it before lastReviewedSha is saved
    () => { queueQuestion(rs(), { pr: 7, sha: sha("b"), fingerprint: "f".repeat(40), file: "x.js", line: 1, snippet: "", finding: { title: "t", case: "c" }, sides: { keep: "k", drop: "d" }, failure: "" }); return { exit: 3, questions: ["7-ffffffff.md"], summary: "a question waits" }; },
    () => { e.post(sha("b")); return { exit: 0, summary: "posted" }; },
  ]);
  assert.equal(await main(["run", "7", "--repo", REPO, "--merge"], { deps: f.deps, review: e.review }), 3);
  assert.equal(last().pause.kind, "question");
  assert.equal(last().head, sha("b"));
  answer(rs(), "7-ffffffff", "drop");
  assert.equal(await main(["run", "7", "--repo", REPO, "--resume"], { deps: f.deps, review: e.review }), 0);
  assert.equal(last().status, "merged");
});

test("pr-land gets --repo: it lands the PR the loop reviewed, not the clone's default repo", async (t) => {
  const { dir } = setup(t);
  const args = join(dir, "args"), land = join(dir, "pr-land"), gh = join(dir, "gh");
  writeFileSync(land, `#!/bin/sh\necho "$@" > '${args}'\n`);
  writeFileSync(gh, `#!/bin/sh\necho '{"mergeCommit":{"oid":"${sha("f")}"}}'\n`);
  chmodSync(land, 0o755); chmodSync(gh, 0o755);
  const old = process.env.GH_BIN; process.env.GH_BIN = gh;
  t.after(() => { if (old === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = old; });
  assert.deepEqual(await realDeps(REPO, 7, { landBin: land }).land(), { merged: true, commit: sha("f") });
  assert.equal(readFileSync(args, "utf8").trim(), `7 --repo ${REPO}`);
});

test("the end summary has one comment per PR: a rerun with another body edits it", async (t) => {
  setup(t);
  const posted = [], edited = [];
  const gh = {
    viewer: async () => "me",
    comments: async () => posted.map((body, i) => ({ id: i + 1, user: { login: "me" }, body: edited.at(-1)?.body ?? body })),
    comment: async (_r, _n, body) => { posted.push(body); },
    edit: async (_r, id, body) => { edited.push({ id, body }); },
  };
  const d = realDeps(REPO, 7, { gh });
  await d.post("Converged. Nothing is merged.");
  await d.post("The PR converged and is merged.");
  await d.post("The PR converged and is merged.");
  assert.equal(posted.length, 1);
  assert.deepEqual(edited.map((e) => [e.id, e.body.split("\n")[0]]), [[1, "The PR converged and is merged."]]);
});

test("--config and --effort reach every pr-review round", async (t) => {
  const { dir } = setup(t);
  const f = fakes([]);
  delete f.deps.review;
  const e = engine([() => { e.post(sha("a")); return { exit: 0, summary: "posted" }; }]);
  const cfg = join(dir, "config.json");
  writeFileSync(cfg, "{}");
  assert.equal(await main(["run", "7", "--repo", REPO, "--config", cfg, "--effort", "low"], { deps: f.deps, review: e.review }), 0);
  assert.deepEqual([e.asked[0].configPath, e.asked[0].effort], [cfg, "low"]);
  assert.equal(await main(["run", "7", "--repo", REPO, "--effort", "huge"], { deps: f.deps, review: e.review }), 1);
});

test("--pushed takes the points pr-respond summary recorded at that head, with their fingerprints", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("m1", "must")] }, { findings: [] }]);
  delete f.deps.respond;
  assert.equal(await run(f.deps, "--merge"), 2);
  f.moveHead(sha("b"));
  // what pr-respond summary records: the fps come from the thread's marker, not from the agent
  const file = join(stateRoot(REPO), "pr", "7", "respond.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ points: { [sha("b")]: [{ n: 1, status: "done", sha: sha("b"), thread: "T1", fps: ["m1"], text: "fixed." }] } }));
  assert.equal(await run(f.deps, "--pushed", sha("b")), 0);
  assert.equal(last().status, "merged");
});

test("--resume after a declined stop: the push that fixes the must is a new round, then it lands", async (t) => {
  const { dir, last } = setup(t);
  const f = fakes([{ findings: [finding("m1", "must")] }, { findings: [] }]);
  f.deps.respond = async (s) => ({ sha: s.head, points: [{ n: 1, status: "open", text: "declined." }] });
  assert.equal(await run(f.deps, "--merge"), 5);
  assert.equal(last().status, "declined");
  delete f.deps.respond; // the user changed their mind: the agent fixes and pushes
  f.moveHead(sha("b"));
  const points = join(dir, "points.json");
  writeFileSync(points, JSON.stringify([{ n: 1, status: "done", sha: sha("b"), fp: "m1", text: "fixed after all." }]));
  assert.equal(await run(f.deps, "--resume", "--pushed", sha("b"), "--points", points), 0);
  assert.equal(last().status, "merged");
  assert.deepEqual([f.calls.review, f.calls.land, f.calls.posts.length], [2, 1, 2]);
});

test("a respond step that pushed nothing goes to land, not to a round pr-review would skip", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("a1")] }]);
  f.deps.respond = async (s) => ({ sha: s.head, points: [{ n: 1, status: "open", text: "out of scope." }] });
  assert.equal(await run(f.deps, "--merge"), 0);
  assert.equal(last().status, "merged");
  assert.deepEqual([f.calls.review, f.calls.land], [1, 1]);
});

test("a declined must stays open: the loop stops and never lands", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("m1", "must")] }, { findings: [] }]);
  f.deps.respond = async () => { f.moveHead(sha("b")); return { sha: sha("b"), points: [{ n: 1, status: "open", text: "declined: out of scope." }] }; };
  assert.equal(await run(f.deps, "--merge"), 5);
  assert.equal(last().status, "declined");
  assert.equal(f.calls.land, 0);
  assert.match(f.calls.posts[0], /Still open:\n- must: finding m1/);
});

test("a skipped rerun of a round that found nothing pauses, not lands", async (t) => {
  const { last } = setup(t);
  const f = fakes([]);
  delete f.deps.review;
  const e = engine([
    () => ({ exit: 3, questions: ["7-x.md"], summary: "a question waits" }),
    () => ({ exit: 0, skipped: true, summary: "already reviewed it" }),
  ]);
  assert.equal(await main(["run", "7", "--repo", REPO, "--merge"], { deps: f.deps, review: e.review }), 3);
  assert.equal(last().pause.kind, "question");
  assert.equal(await main(["run", "7", "--repo", REPO, "--resume"], { deps: f.deps, review: e.review }), 3);
  assert.equal(last().pause.kind, "review-skipped");
  assert.equal(f.calls.land, 0);
});

test("a fixed must and a declined should land: an open point blocks only its own finding", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("m1", "must"), finding("s1")] }, { findings: [] }]);
  f.deps.respond = async () => { f.moveHead(sha("b")); return { sha: sha("b"), points: [
    { n: 1, status: "done", sha: sha("b"), fp: "m1", text: "fixed m1." }, { n: 2, status: "open", fp: "s1", text: "declined s1." }] }; };
  assert.equal(await run(f.deps, "--merge"), 0);
  assert.equal(last().status, "merged");
});

test("a must with no point, or a done point but no new commit, is not fixed", async (t) => {
  for (const [label, respond] of [
    ["--pushed <head> and no points", async (s) => ({ sha: s.head, points: [] })],
    ["a done point that names another finding", async () => ({ sha: sha("b"), points: [{ n: 1, status: "done", sha: sha("b"), fp: "zz", text: "x." }] })],
    ["a done point on the round's own head", async (s) => ({ sha: s.head, points: [{ n: 1, status: "done", sha: s.head, fp: "m1", text: "x." }] })],
    ["a push, but the done point's commit is the round's head", async (s) => ({ sha: sha("b"), points: [{ n: 1, status: "done", sha: s.head, fp: "m1", text: "x." }] })],
    ["a done point but nothing pushed", async (s) => ({ sha: s.head, points: [{ n: 1, status: "done", sha: sha("d"), fp: "m1", text: "x." }] })],
  ]) {
    await t.test(label, async (t2) => {
      const { last } = setup(t2);
      const f = fakes([{ findings: [finding("m1", "must")] }, { findings: [] }]);
      f.deps.respond = async (s) => { const r = await respond(s); f.moveHead(r.sha); return r; };
      assert.equal(await run(f.deps, "--merge"), 5);
      assert.equal(last().status, "declined");
      assert.equal(f.calls.land, 0);
    });
  }
});

test("an exit 3 with no question and no core paths fails closed: it pauses, never a clean round", async (t) => {
  const { last } = setup(t);
  const f = fakes([]);
  delete f.deps.review;
  const e = engine([() => ({ exit: 3, summary: "held again" })]);
  assert.equal(await main(["run", "7", "--repo", REPO, "--merge"], { deps: f.deps, review: e.review }), 3);
  assert.equal(last().pause.kind, "review-skipped");
  assert.equal(f.calls.land, 0);
});
