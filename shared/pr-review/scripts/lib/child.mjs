import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHarness } from "./config.mjs";
import { validate } from "./schema.mjs";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "harness");
export { ENV_OK } from "./env.mjs";
import { ENV_OK } from "./env.mjs";

// Live child process groups: seats must not outlive the engine.
const live = new Set();
const killAll = (sig) => { for (const pid of live) try { process.kill(-pid, sig); } catch {} };
let handlersInstalled = false;
/** True once a signal arrived: callers must not save results that a killed child produced. */
export let stopping = false;
// The engine's one signal path: stop the children, then exit once; the "exit" listeners (lock release) run then.
export function installSignalHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("exit", () => killAll("SIGKILL"));
  for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15]]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      killAll("SIGTERM");
      const start = Date.now();
      const iv = setInterval(() => {
        for (const pid of live) try { process.kill(-pid, 0); } catch { live.delete(pid); }
        if (!live.size || Date.now() - start > 5000) { clearInterval(iv); killAll("SIGKILL"); process.exit(128 + n); }
      }, 100);
    });
  }
}

/** Register a detached child's process group so an engine signal kills it. */
export function track(pid) { installSignalHandlers(); live.add(pid); }
export function untrack(pid) { live.delete(pid); }

export class ChildFailed extends Error {
  constructor(msg) { super(msg); this.name = "ChildFailed"; }
}

// Every top-level JSON value in the text: a model may quote a finding in its prose before the real output.
// With ok (the stage schema), the last value that passes wins; else, or when none passes, the largest one.
export function salvageJson(text, ok) {
  const s = String(text).replace(/```[a-zA-Z]*\n?/g, "");
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{" && s[i] !== "[") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        if (--depth === 0) {
          try { found.push({ v: JSON.parse(s.slice(i, j + 1)), size: j + 1 - i }); i = j; } catch {}
          break;
        }
      }
    }
  }
  if (ok) for (const x of found.toReversed()) if (ok(x.v)) return x.v;
  return found.reduce((a, b) => (b.size > a.size ? b : a), { v: null, size: -1 }).v;
}

let routerProbe;
const ROUTER_HEALTH = () => process.env.PR_REVIEW_ROUTER_HEALTH || "http://127.0.0.1:4000/router/health";
function probeRouter() {
  routerProbe ??= fetch(ROUTER_HEALTH(), {
    signal: AbortSignal.timeout(2000),
  }).then((r) => r.ok, () => false);
  return routerProbe;
}

function runOnce(script, args, env, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(script, args, { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    track(p.pid);
    let err = "", timedOut = false;
    p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid, "SIGKILL"); } catch {}
    }, timeoutMs);
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      untrack(p.pid);
      try { process.kill(-p.pid, "SIGKILL"); } catch {} // reap stragglers
      if (timedOut) reject(new Error(`timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`exit ${code}: ${err.trim().slice(-500)}`));
      else resolve();
    });
  });
}

// retries = extra attempts after the first.
// The pi harness has no turn limit: there the timeout is the only bound on a long tool loop.
export async function runChild({ seat, tools = "read", promptFile, outFile, worktree, ctxDir, schema, timeoutMs = (seat.timeout_minutes ?? 10) * 60000, retries = 2, routerUp }) {
  const fake = process.env.PR_REVIEW_FAKE;
  let harness = seat.harness;
  if (!fake && harness === "auto") harness = resolveHarness(seat, routerUp ?? (await probeRouter()));
  const script = join(HARNESS_DIR, `${fake ? "fake" : harness}.sh`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_OK.test(k)));
  if (worktree) env.SEAT_WORKTREE = worktree;
  if (ctxDir) env.SEAT_CTX = ctxDir; // the PR context: outside the child cwd, so it must be an --add-dir folder
  if (seat.max_turns) env.SEAT_MAX_TURNS = String(seat.max_turns);
  // an auto seat that resolved to claude is a router model: point claude at the router, as claude-mimir does
  if (seat.harness === "auto" && harness === "claude") {
    env.ANTHROPIC_BASE_URL = new URL(ROUTER_HEALTH()).origin;
    delete env.ANTHROPIC_CUSTOM_HEADERS;
  }
  const cwd = dirname(outFile); // neutral run folder: the PR checkout must not supply CLAUDE.md or .claude/
  let model = seat.model;
  if (harness === "pi") {
    const [prov, ...rest] = model.split("/");
    env.SEAT_PROVIDER = seat.provider ?? (rest.length ? prov : "");
    if (!seat.provider && rest.length) model = rest.join("/");
  }
  let last;
  for (let i = 0; i <= retries; i++) {
    if (stopping) throw new ChildFailed("engine is stopping on a signal"); // a killed child is not retried
    try {
      await runOnce(script, [model, seat.thinking, tools, promptFile, outFile], env, cwd, timeoutMs);
      const value = salvageJson(await readFile(outFile, "utf8"), schema && ((v) => validate(schema, v).length === 0));
      if (value === null) throw new Error("no JSON in output");
      const errs = schema ? validate(schema, value) : [];
      if (errs.length) throw new Error(`invalid ${schema}: ${errs.join("; ")}`);
      return value;
    } catch (e) {
      last = e;
      // claude prints this and exits 1 at --max-turns: a retry hits the same limit, so fail at once.
      const text = `${e.message}\n${await readFile(outFile, "utf8").catch(() => "")}`;
      if (/Reached max turns|error_max_turns/.test(text)) throw new ChildFailed(`${harness}:${seat.model} hit its max_turns (${seat.max_turns}); not retried`);
    }
  }
  throw new ChildFailed(`${fake ? "fake" : harness}:${seat.model} failed after ${retries + 1} attempts: ${last.message}`);
}
