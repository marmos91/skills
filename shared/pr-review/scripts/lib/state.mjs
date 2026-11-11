import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// A run is finished once its last stage has a marker.
export const FINAL_STAGE = "post";

export function stateRoot(repo) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((p) => /^\.+$/.test(p))) throw new Error(`repo must be owner/repo, got ${repo}`);
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "pr-review", repo.replace("/", "__"));
}

function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export class Locked extends Error {
  constructor(pid) { super(`another pr-review run holds the lock (pid ${pid})`); this.name = "Locked"; this.pid = pid; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

const held = new Set(); // lock dirs this process owns
const releaseAll = () => { for (const d of held) release(d); };

function release(dir) {
  held.delete(dir);
  try { if (Number(readFileSync(join(dir, "pid"), "utf8")) !== process.pid) return; } catch { return; }
  rmSync(dir, { recursive: true, force: true });
}

let installed = false;
// Releases held locks on exit, SIGINT and SIGTERM. Exits on a signal only when no other handler (child.mjs) will.
export function installSignalHandlers() {
  if (installed) return;
  installed = true;
  process.on("exit", releaseAll);
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15]]) {
    process.on(sig, function onSig() {
      releaseAll();
      if (process.listeners(sig).every((l) => l === onSig)) process.exit(128 + n);
    });
  }
}

export function acquireLock(repoState) {
  const dir = join(repoState, "lock");
  mkdirSync(repoState, { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let pid = NaN;
    try { pid = Number(readFileSync(join(dir, "pid"), "utf8")); } catch {}
    // No pid file yet: a fresh lock is still being written; treat it as live for a few seconds.
    const live = Number.isInteger(pid) && pid > 0 ? alive(pid) : Date.now() - statSync(dir).mtimeMs < 5000;
    if (live) throw new Locked(pid);
    rmSync(dir, { recursive: true, force: true });
    try { mkdirSync(dir); } catch (e2) { throw e2.code === "EEXIST" ? new Locked(null) : e2; } // lost the takeover race
  }
  writeFileSync(join(dir, "pid"), String(process.pid));
  held.add(dir);
  installSignalHandlers();
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
