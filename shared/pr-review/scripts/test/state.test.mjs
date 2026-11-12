import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateRoot, acquireLock, Locked, startOf, runDir, done, markDone, prState, savePrState } from "../lib/state.mjs";

const deadPid = () => spawnSync("true").pid;
const tmp = () => mkdtempSync(join(tmpdir(), "prr-state-"));

test("stateRoot follows XDG_STATE_HOME and rejects odd repo names", () => {
  const old = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = "/x/state";
  try {
    assert.equal(stateRoot("o/r"), "/x/state/pr-review/o__r");
    assert.equal(stateRoot("Marmos91/Skills"), "/x/state/pr-review/marmos91__skills", "one folder however the repo is typed");
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

  const dead = deadPid(); // exited: its pid is not alive
  mkdirSync(join(s, "lock"));
  writeFileSync(join(s, "lock", "pid"), String(dead));
  const r2 = acquireLock(s);
  assert.throws(() => acquireLock(s), Locked);
  r2();
});

test("a lock whose pid was reused by another live process is stale; one with a matching start time is held", () => {
  const s = tmp();
  const other = spawn("sleep", ["30"]); // live, unrelated: stands in for a reused pid
  try {
    mkdirSync(join(s, "lock"));
    writeFileSync(join(s, "lock", "pid"), String(other.pid));
    writeFileSync(join(s, "lock", "start"), "Mon Jan  1 00:00:00 2001");
    acquireLock(s)();

    let start = "";
    for (let i = 0; i < 50 && !start; i++) start = startOf(other.pid); // ps sees the child once it has started
    assert.ok(start, "ps reports a start time");
    mkdirSync(join(s, "lock"));
    writeFileSync(join(s, "lock", "pid"), String(other.pid));
    writeFileSync(join(s, "lock", "start"), start);
    assert.throws(() => acquireLock(s), Locked);
  } finally { other.kill(); }
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

const RACER = `import { acquireLock } from ${JSON.stringify(stateUrl)};
  try { acquireLock(process.argv[1]); console.log("WIN"); setTimeout(() => {}, 1500); }
  catch (e) { console.log(e.name); }`;

test("racers on a stale lock: exactly one wins (dead pid, or a legacy lock with no pid file older than 60 s)", async () => {
  const seeds = {
    deadPid: (s) => { mkdirSync(join(s, "lock")); writeFileSync(join(s, "lock", "pid"), String(deadPid())); },
    legacyEmpty: (s) => { mkdirSync(join(s, "lock")); const t = new Date(Date.now() - 120000); utimesSync(join(s, "lock"), t, t); },
    deadMutex: (s) => { // a takeover that crashed: stale lock and a dead mutex
      seeds.deadPid(s);
      mkdirSync(join(s, "lock.takeover"));
      writeFileSync(join(s, "lock.takeover", "pid"), String(deadPid()));
    },
  };
  for (const [name, seed] of Object.entries(seeds)) {
    for (let round = 0; round < 5; round++) {
      const s = tmp();
      seed(s);
      const outs = (await Promise.all(Array.from({ length: 8 }, () => output(child(RACER, s))))).map((r) => r.out.trim());
      const wins = outs.filter((o) => o === "WIN").length;
      // deadMutex: a racer may strand the mutex (R19), so none may win; never two.
      assert.ok(name === "deadMutex" ? wins <= 1 : wins === 1, `${name}: ${outs.join(",")}`);
      assert.ok(outs.every((o) => o === "WIN" || o === "Locked"), `${name}: ${outs.join(",")}`);
      acquireLock(s)(); // the next run sweeps any leftovers of dead racers
      assert.deepEqual(readdirSync(s), [], name);
    }
  }
});

test("200 acquire/release cycles across 4 processes: no errors, no empty lock left", async () => {
  const s = tmp();
  const cycler = `import { acquireLock } from ${JSON.stringify(stateUrl)};
    let n = 0, errs = [];
    while (n < 50) {
      try { const rel = acquireLock(process.argv[1]); n++; rel(); }
      catch (e) { if (e.name !== "Locked") { errs.push(e.code || e.message); break; } }
    }
    console.log(errs.length ? "ERR " + errs.join(",") : "OK " + n);`;
  const outs = (await Promise.all(Array.from({ length: 4 }, () => output(child(cycler, s))))).map((r) => r.out.trim());
  assert.deepEqual(outs, ["OK 50", "OK 50", "OK 50", "OK 50"]);
  assert.deepEqual(readdirSync(s), []);
});

test("a young lock with no pid file is held; dead temp and stale leftovers are swept", () => {
  const s = tmp();
  mkdirSync(join(s, "lock"));
  assert.throws(() => acquireLock(s), Locked);
  const dead = deadPid();
  for (const f of [`lock.tmp.${dead}.aa`, `lock.stale.${dead}.bb`, `lock.takeover.tmp.${dead}.cc`]) mkdirSync(join(s, f));
  mkdirSync(join(s, `lock.tmp.${process.pid}.dd`)); // ours: kept
  rmSync(join(s, "lock"), { recursive: true });
  acquireLock(s)();
  assert.deepEqual(readdirSync(s), [`lock.tmp.${process.pid}.dd`]);
});

test("a stalled holder (SIGSTOP) keeps the lock and the takeover mutex; no time-based expiry", async () => {
  const s = tmp();
  const holder = child(`import { acquireLock } from ${JSON.stringify(stateUrl)};
    acquireLock(process.argv[1]); console.log("HELD"); setInterval(() => {}, 1000);`, s);
  await new Promise((res) => holder.stdout.once("data", res));
  // A second stopped process owns an old-looking takeover mutex.
  const sleeper = spawn("sleep", ["60"]);
  mkdirSync(join(s, "lock.takeover"));
  writeFileSync(join(s, "lock.takeover", "pid"), String(sleeper.pid));
  const old = new Date(Date.now() - 3600000);
  utimesSync(join(s, "lock"), old, old);
  utimesSync(join(s, "lock.takeover"), old, old);
  holder.kill("SIGSTOP");
  sleeper.kill("SIGSTOP");
  try {
    const retry = `import { acquireLock } from ${JSON.stringify(stateUrl)};
      const end = Date.now() + 12000; let won = 0;
      while (Date.now() < end) { try { acquireLock(process.argv[1]); won++; break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
      console.log(won ? "WIN" : "Locked");`;
    const outs = (await Promise.all(Array.from({ length: 4 }, () => output(child(retry, s))))).map((r) => r.out.trim());
    assert.deepEqual(outs, ["Locked", "Locked", "Locked", "Locked"]);
    holder.kill("SIGCONT");
    assert.equal(readFileSync(join(s, "lock", "pid"), "utf8"), String(holder.pid)); // still the holder
    assert.equal(readFileSync(join(s, "lock.takeover", "pid"), "utf8"), String(sleeper.pid));
  } finally {
    holder.kill("SIGKILL");
    sleeper.kill("SIGKILL");
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
