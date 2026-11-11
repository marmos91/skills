import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateRoot, acquireLock, Locked, runDir, done, markDone, prState, savePrState } from "../lib/state.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "prr-state-"));

test("stateRoot follows XDG_STATE_HOME and rejects odd repo names", () => {
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "/x/state";
  try {
    assert.equal(stateRoot("o/r"), "/x/state/pr-review/o__r");
    assert.throws(() => stateRoot("../r"), /owner\/repo/);
  } finally {
    if (old === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = old;
  }
});

test("second lock holder gets Locked; stale pid lock is taken", () => {
  const s = tmp();
  const release = acquireLock(s);
  assert.throws(() => acquireLock(s), Locked);
  release();
  assert.equal(existsSync(join(s, "lock")), false);

  const dead = spawnSync("true").pid; // exited: its pid is not alive
  mkdirSync(join(s, "lock"));
  writeFileSync(join(s, "lock", "pid"), String(dead));
  const r2 = acquireLock(s);
  assert.throws(() => acquireLock(s), Locked);
  r2();
});

test("runDir returns the unfinished run for the same sha, a new one for a new sha or with restart", () => {
  const s = tmp();
  const a = runDir(s, 5, "aaa");
  assert.equal(runDir(s, 5, "aaa"), a);
  const b = runDir(s, 5, "bbb");
  assert.notEqual(b, a);
  const c = runDir(s, 5, "aaa", { restart: true });
  assert.notEqual(c, a);
  assert.equal(runDir(s, 5, "aaa"), c); // newest unfinished
  markDone(c, "post");
  markDone(a, "post");
  const d = runDir(s, 5, "aaa");
  assert.ok(![a, c].includes(d));
  assert.equal(readdirSync(join(s, "pr", "5", "runs")).length, 4); // old runs are kept
});

test("child markers: markDone(dir, \"round1\", \"opus:security\") then done() is true; other keys false", () => {
  const d = tmp();
  assert.equal(done(d, "round1", "opus:security"), false);
  markDone(d, "round1", "opus:security");
  markDone(d, "round1", "auto:cubbit/mimir:security"); // slash in key stays one file
  assert.equal(done(d, "round1", "opus:security"), true);
  assert.equal(done(d, "round1", "auto:cubbit/mimir:security"), true);
  assert.equal(done(d, "round1", "opus:correctness"), false);
  assert.equal(done(d, "round1"), false);
  markDone(d, "round1");
  assert.equal(done(d, "round1"), true);
  assert.deepEqual(readdirSync(join(d, "round1")).filter((f) => f.includes("tmp")), []);
});

test("prState defaults, then round-trips", () => {
  const s = tmp();
  assert.deepEqual(prState(s, 5), { reviews: 0, settled: [], replies: {}, lastReviewedSha: null, cache: {} });
  savePrState(s, 5, { reviews: 1, settled: ["f1"], replies: { T1: 1 }, lastReviewedSha: "abc", cache: { head: "abc" } });
  assert.deepEqual(prState(s, 5), { reviews: 1, settled: ["f1"], replies: { T1: 1 }, lastReviewedSha: "abc", cache: { head: "abc" } });
  assert.ok(existsSync(join(s, "pr", "5", "state.json")));
});

const stateUrl = new URL("../lib/state.mjs", import.meta.url).href;
const child = (code, s) => spawn(process.execPath, ["--input-type=module", "-e", code, s], { stdio: ["ignore", "pipe", "inherit"] });
const output = (p) => new Promise((res) => { let out = ""; p.stdout.on("data", (d) => (out += d)); p.on("close", (code) => res({ out, code })); });

test("racers on a stale lock: at most one wins", async () => {
  const code = `import { acquireLock } from ${JSON.stringify(stateUrl)};
    try { acquireLock(process.argv[1]); console.log("WIN"); setTimeout(() => {}, 1500); }
    catch (e) { console.log(e.name); }`;
  for (let round = 0; round < 5; round++) {
    const s = tmp();
    mkdirSync(join(s, "lock"));
    writeFileSync(join(s, "lock", "pid"), String(spawnSync("true").pid));
    const results = await Promise.all(Array.from({ length: 8 }, () => output(child(code, s))));
    const outs = results.map((r) => r.out.trim());
    assert.equal(outs.filter((o) => o === "WIN").length, 1, outs.join(","));
    assert.ok(outs.every((o) => o === "WIN" || o === "Locked"), outs.join(","));
    assert.deepEqual(readdirSync(s), []); // winner released on exit; no stale or mutex dirs left
  }
});

test("SIGTERM releases the lock", async () => {
  const s = tmp();
  const p = child(`import { acquireLock } from ${JSON.stringify(stateUrl)};
    acquireLock(process.argv[1]); console.log("HELD"); setInterval(() => {}, 1000);`, s);
  await new Promise((res) => p.stdout.once("data", res));
  assert.ok(existsSync(join(s, "lock", "pid")));
  const closed = new Promise((res) => p.on("close", res));
  p.kill("SIGTERM");
  assert.equal(await closed, 143);
  assert.equal(existsSync(join(s, "lock")), false);
});
