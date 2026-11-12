import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { addUsage, installSignalHandlers } from "./child.mjs";

// A run is finished once its last stage has a marker.
export const FINAL_STAGE = "post";

export function stateRoot(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((p) => /^\.+$/.test(p))) throw new Error(`repo must be owner/repo, got ${repo}`);
  // GitHub names are case-insensitive: one folder per repo however it is typed.
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pr-review", repo.toLowerCase().replace("/", "__"));
}

export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

// what: "" for the repo lock, " of PR #5" for a PR lock.
export class Locked extends Error {
  constructor(pid, what = "") { super(`another pr-review run holds the lock${what} (pid ${pid})`); this.name = "Locked"; this.pid = pid; }
}

export function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Start time of pid, "" when unknown; with the pid it names one process even after the pid is reused.
// Linux: start ticks since boot (/proc/<pid>/stat field 22), immune to clock steps; elsewhere ps lstart, pinned to UTC
// so holder and checker agree across TZ and DST.
export function startOf(pid) {
  if (existsSync("/proc/self/stat")) {
    try { const s = readFileSync(`/proc/${pid}/stat`, "utf8"); return s.slice(s.lastIndexOf(")") + 2).split(" ")[19] ?? ""; } catch { return ""; } // comm may hold ") ": fields restart after the last one
  }
  const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } });
  return r.status === 0 ? r.stdout.trim() : "";
}
let myStart;

// A holder is live when its pid is, and that pid still has the start time the holder recorded (none recorded or unknown: trust the pid).
export function holderAlive(dir, pid) {
  if (!alive(pid)) return false;
  let rec;
  try { rec = readFileSync(join(dir, "start"), "utf8"); } catch { return true; }
  const now = rec && startOf(pid);
  return !rec || !now || now === rec;
}

const held = new Set(); // lock dirs this process owns
const releaseAll = () => { for (const d of held) release(d); };

function release(dir) {
  held.delete(dir);
  try { if (Number(readFileSync(join(dir, "pid"), "utf8")) !== process.pid) return; } catch { return; }
  // Rename first: removing in place leaves an empty dir for a moment, and a racer's claim can land on it.
  const gone = `${dir}.stale.${process.pid}.${rand()}`;
  try { renameSync(dir, gone); } catch { return; }
  rmSync(gone, { recursive: true, force: true });
}

let exitHook = false;
// Signals go through child.mjs (one path: stop children, then exit); the lock is released on "exit".
function releaseOnExit() {
  if (!exitHook) { exitHook = true; process.on("exit", releaseAll); }
  installSignalHandlers();
}
export { installSignalHandlers };

const rawPid = (dir) => { try { return readFileSync(join(dir, "pid"), "utf8"); } catch { return ""; } };
const rand = () => randomBytes(4).toString("hex");

// Creates `dir` with our pid already inside: renaming a temp dir onto a non-empty dir fails, so there is never a lock without a pid.
function claim(dir) {
  const tmp = `${dir}.tmp.${process.pid}.${rand()}`;
  mkdirSync(tmp);
  writeFileSync(join(tmp, "pid"), String(process.pid));
  writeFileSync(join(tmp, "start"), (myStart ??= startOf(process.pid)));
  try { renameSync(tmp, dir); return true; } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    if (["EEXIST", "ENOTEMPTY"].includes(e.code)) return false;
    throw e;
  }
}

// Renames a dead holder's dir aside and deletes it; puts it back when it is no longer the dead holder's.
function moveAside(dir, deadRaw) {
  const stale = `${dir}.stale.${process.pid}.${rand()}`;
  try { renameSync(dir, stale); } catch { return false; }
  if (rawPid(stale) === deadRaw) { rmSync(stale, { recursive: true, force: true }); return true; }
  try { renameSync(stale, dir); } catch (e) { process.stderr.write(`pr-review: could not put back ${dir} (moved to ${stale}): ${e.message}\n`); }
  return false;
}

// Best effort: temp and moved-aside dirs whose named pid is dead, and a takeover mutex whose holder died.
function sweep(parent) {
  const mutex = join(parent, "lock.takeover"), m = rawPid(mutex);
  if (m && !holderAlive(mutex, Number(m))) moveAside(mutex, m);
  try {
    for (const f of readdirSync(parent)) {
      const pid = Number(/^lock(?:\.takeover)?\.(?:tmp|stale)\.(\d+)\./.exec(f)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) rmSync(join(parent, f), { recursive: true, force: true });
    }
  } catch {}
}

// A takeover holds a mutex (claimed the same way), so only one process at a time moves a stale lock aside.
// shortcut: if a process crashes inside this short critical section and a racer clears its dead mutex while another
// racer takes over, two holders are possible; the second guard is that every post first checks GitHub for its marker (spec 6.10 step 6).
function takeOver(parent, dir, deadRaw) {
  const mutex = join(parent, "lock.takeover");
  if (!claim(mutex)) {
    const m = rawPid(mutex);
    if (!m || holderAlive(mutex, Number(m)) || !moveAside(mutex, m) || !claim(mutex)) return false;
  }
  try {
    return rawPid(dir) === deadRaw && moveAside(dir, deadRaw) && claim(dir);
  } finally {
    release(mutex);
  }
}

// The lock is `<parent>/lock`: the repo state folder (tick), a PR folder pr/<n> (review), or a git clone (git writes).
export function acquireLock(parent, what = "") {
  const dir = join(parent, "lock");
  mkdirSync(parent, { recursive: true });
  sweep(parent);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existsSync(dir) && claim(dir)) return own(dir);
    const raw = rawPid(dir);
    let age;
    try { age = Date.now() - statSync(dir).mtimeMs; } catch (e) { if (e.code === "ENOENT") continue; throw e; } // released meanwhile: retry once
    // Stale = its holder is dead (pid gone, or reused by another process). A lock dir with no pid file only comes from an older version or a manual mkdir:
    // the one time-based rule treats it as stale after 60 s.
    if (raw ? holderAlive(dir, Number(raw)) : age < 60000) throw new Locked(raw ? Number(raw) : null, what);
    if (takeOver(parent, dir, raw)) return own(dir);
    throw new Locked(null, what);
  }
  throw new Locked(null, what);
}

// acquireLock, retried for up to `ms`. It sleeps synchronously: it guards short synchronous git commands only.
export function waitLock(parent, what, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    try { return acquireLock(parent, what); } catch (e) {
      if (!(e instanceof Locked) || Date.now() >= end) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}

function own(dir) {
  held.add(dir);
  releaseOnExit();
  return () => release(dir);
}

const marker = (dir, stage, key) => (key === undefined ? join(dir, `${stage}.done`) : join(dir, stage, `${encodeURIComponent(key)}.done`));
export const done = (dir, stage, key) => existsSync(marker(dir, stage, key));
export const markDone = (dir, stage, key) => writeAtomic(marker(dir, stage, key), new Date().toISOString() + "\n");

export function runDir(repoState, n, sha, { restart = false } = {}) {
  const runs = join(repoState, "pr", String(n), "runs");
  mkdirSync(runs, { recursive: true });
  const ts = (d) => Number(d.slice(sha.length + 1));
  const mine = readdirSync(runs).filter((d) => d.startsWith(`${sha}-`)).sort((a, b) => ts(a) - ts(b));
  const open = mine.filter((d) => !done(join(runs, d), FINAL_STAGE)).at(-1);
  if (open && !restart) return join(runs, open);
  const dir = join(runs, `${sha}-${Math.max(Date.now(), ts(mine.at(-1) ?? `${sha}-0`) + 1)}`);
  mkdirSync(dir);
  return dir;
}

const prFile = (repoState, n) => join(repoState, "pr", String(n), "state.json");

export function prState(repoState, n) {
  const empty = { reviews: 0, settled: [], replies: {}, lastReviewedSha: null, cache: {} };
  const f = prFile(repoState, n);
  return existsSync(f) ? { ...empty, ...JSON.parse(readFileSync(f, "utf8")) } : empty;
}

export function savePrState(repoState, n, s) {
  writeAtomic(prFile(repoState, n), JSON.stringify(s, null, 2) + "\n");
}

/** Token usage of a run, summed per stage folder (hygiene at the top level), plus total; {} when none is recorded. */
export function usageByStage(dir) {
  const out = {};
  const add = (stage, file) => { try { out[stage] = addUsage(out[stage], JSON.parse(readFileSync(file, "utf8"))); } catch {} };
  let ls = [];
  try { ls = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ls) {
    if (e.isFile() && e.name.endsWith(".usage.json")) add(e.name.slice(0, -".usage.json".length), join(dir, e.name));
    else if (e.isDirectory() && e.name !== "wt" && e.name !== "ctx") try { for (const f of readdirSync(join(dir, e.name)).filter((x) => x.endsWith(".usage.json"))) add(e.name, join(dir, e.name, f)); } catch {}
  }
  if (Object.keys(out).length) out.total = Object.values(out).reduce((a, b) => addUsage(a, b));
  return out;
}
