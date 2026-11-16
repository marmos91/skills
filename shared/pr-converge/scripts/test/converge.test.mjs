import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../main.mjs";
import { loadState } from "../lib/converge.mjs";

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
    respond: async () => {
      calls.respond++;
      head = sha("bcde"[pushes++]);
      return { sha: head, points: [{ n: 1, status: "done", sha: head, text: "fixed it." }] };
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

test("a user question pauses the loop; --resume reviews the same round again", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [finding("a1")], questions: 1 }, { findings: [] }]);
  assert.equal(await run(f.deps, "--merge"), 3);
  assert.equal(last().pause.kind, "question");
  // without --resume the pause holds and nothing runs
  assert.equal(await run(f.deps), 3);
  assert.equal(f.calls.review, 1);
  assert.equal(await run(f.deps, "--resume"), 0);
  assert.equal(last().status, "merged");
  assert.deepEqual([f.calls.review, f.calls.respond, last().round], [2, 0, 1]);
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

test("the respond step hands over to the agent; --pushed continues the loop", async (t) => {
  const { dir, last } = setup(t);
  const f = fakes([{ findings: [finding("a1")] }, { findings: [] }]);
  delete f.deps.respond; // the real step: the agent runs pr-respond
  assert.equal(await run(f.deps), 2);
  assert.equal(last().status, "respond");
  const points = join(dir, "points.json");
  writeFileSync(points, JSON.stringify([{ n: 1, status: "open", text: "out of scope: the caller checks it." }]));
  f.moveHead(sha("b"));
  assert.equal(await run(f.deps, "--pushed", sha("b"), "--points", points), 0);
  assert.match(f.calls.posts[0], /Declined:\n- out of scope/);
});

test("a land that is not ready pauses; --rebased after a conflict lands without a new round", async (t) => {
  const { last } = setup(t);
  const f = fakes([{ findings: [] }], { landResult: { blocked: "mergeable is CONFLICTING" } });
  assert.equal(await run(f.deps, "--merge"), 3);
  assert.equal(last().pause.kind, "land");
  f.deps.land = async () => ({ merged: true, commit: sha("f") });
  assert.equal(await run(f.deps, "--rebased", sha("c")), 0);
  assert.deepEqual([f.calls.review, last().head], [1, sha("c")]);
});
