import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

/** A seat at its turn limit or timeout: not retried; a review leaves it out of the rest of the run. */
export class SeatDropped extends ChildFailed {
  constructor(seat, reason, detail = "") { super(`${seat.harness}:${seat.model} dropped (${reason})${detail ? `: ${detail}` : ""}`); this.name = "SeatDropped"; this.seat = seat; this.reason = reason; }
}

// Every top-level JSON value in the text: a model may quote a finding in its prose before the real output.
// With ok (a schema is set) the LAST value counts, never an earlier one that passes: an earlier value may be a
// quote that would hide the seat's real (invalid or error) output. A trailing list of numbers, a citation such as
// "[1]", is not an output and is skipped. Without ok: the largest value.
export function salvageJson(text, ok) {
  // No fence stripping: the scan skips all but { and [, and a fence inside a JSON string (a comment body) must stay.
  const s = String(text);
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
          const raw = s.slice(i, j + 1);
          // Models write \` and the like; drop the backslash of an invalid escape, keep the valid ones.
          for (const t of [raw, raw.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})|\\/g, (m, k) => k ? m : "")]) {
            try { found.push({ v: JSON.parse(t), size: j + 1 - i }); i = j; break; } catch {}
          }
          break;
        }
      }
    }
  }
  // With a schema: only the LAST value counts. Falling back to an earlier one could pick a value the
  // seat quoted (from the PR or its own prose) and hide its real, invalid or error output; fail and retry.
  const footnote = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number");
  if (ok) return found.findLast((x) => !footnote(x.v))?.v ?? null; // the caller validates it and retries on failure
  return found.reduce((a, b) => (b.size > a.size ? b : a), { v: null, size: -1 }).v;
}

const TOKENS = ["input", "output", "cache_read", "cache_creation"];
/** Sum of two usage records; a count stays null only when both sides lack it. */
export const addUsage = (a, b) => Object.fromEntries(TOKENS.map((k) => [k, a?.[k] == null && b?.[k] == null ? null : (a?.[k] ?? 0) + (b?.[k] ?? 0)]));

/**
 * claude --output-format json and pi --mode json wrap the answer with its token usage; the fake harness prints
 * plain text. -> { text, usage (null when unknown), maxTurns }
 */
export function unwrapOutput(raw) {
  const s = String(raw).trim();
  if (s.startsWith("{")) {
    try {
      const j = JSON.parse(s);
      if (j?.type === "result") {
        const u = j.usage;
        return {
          text: String(j.result ?? ""), maxTurns: j.subtype === "error_max_turns",
          usage: u ? { input: u.input_tokens ?? null, output: u.output_tokens ?? null, cache_read: u.cache_read_input_tokens ?? null, cache_creation: u.cache_creation_input_tokens ?? null } : null,
        };
      }
    } catch {}
    // pi: one event per line; the last agent_end holds every message of the run.
    let end = null;
    for (const l of s.split("\n")) { try { const e = JSON.parse(l); if (e?.type === "agent_end") end = e; } catch {} }
    if (end) {
      const said = (end.messages ?? []).filter((m) => m?.role === "assistant");
      const usage = said.reduce((a, m) => addUsage(a, m.usage && { input: m.usage.input, output: m.usage.output, cache_read: m.usage.cacheRead, cache_creation: m.usage.cacheWrite }), null);
      const last = said.at(-1)?.content;
      const text = Array.isArray(last) ? last.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : String(last ?? "");
      return { text, usage: Object.values(usage ?? {}).some((v) => v != null) ? usage : null, maxTurns: false };
    }
  }
  return { text: String(raw), usage: null, maxTurns: false };
}

let routerProbe;
/** The harness a seat will really use (auto resolves through the router probe), before its prompt is written. */
export async function harnessFor(seat, routerUp) {
  return seat.harness === "auto" ? resolveHarness(seat, routerUp ?? (await probeRouter())) : seat.harness;
}
const ROUTER_HEALTH = () => process.env.PR_REVIEW_ROUTER_HEALTH || "http://127.0.0.1:4000/router/health";
function probeRouter() {
  routerProbe ??= fetch(ROUTER_HEALTH(), {
    signal: AbortSignal.timeout(2000),
  }).then((r) => r.ok, () => false);
  return routerProbe;
}

const KILL_GRACE_MS = 3000;
function runOnce(script, args, env, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(script, args, { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    if (p.pid) track(p.pid);
    let err = "", timedOut = false, exited = null, grace, drain;
    const kill = (sig) => { try { process.kill(-p.pid, sig); } catch {} };
    p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      // never cancelled: a descendant that ignores TERM and holds no stderr outlives an early close
      grace = setTimeout(() => { kill("SIGKILL"); untrack(p.pid); }, KILL_GRACE_MS);
    }, timeoutMs);
    const settle = () => {
      clearTimeout(drain);
      if (timedOut) reject(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { timedOut: true }));
      // sh exits 127 when the harness binary (claude, pi) is not on PATH
      else if (exited === 127) reject(Object.assign(new Error(`exit 127 (command not found): ${err.trim().slice(-500)}`), { missing: true }));
      else if (exited !== 0) reject(new Error(`exit ${exited}: ${err.trim().slice(-500)}`));
      else resolve();
    };
    // The outcome is fixed at exit. Settle at close (stderr fully read), or 1 s after exit: a re-grouped grandchild can hold stderr forever.
    p.on("exit", (code, sig) => {
      exited = code ?? sig;
      clearTimeout(t);
      // the leader is the harness wrapper: after a timeout the real binary keeps its grace; the grace timer kills it
      if (!timedOut) { kill("SIGKILL"); untrack(p.pid); } // reap stragglers, which also closes stderr
      drain = setTimeout(() => { p.stderr.destroy(); settle(); }, 1000);
    });
    p.on("error", (e) => {
      clearTimeout(t);
      if (p.pid) untrack(p.pid);
      reject(e.code === "ENOENT" ? Object.assign(new Error(`${script}: not found (ENOENT)`), { missing: true }) : e);
    });
    p.on("close", () => { if (exited !== null) settle(); });
  });
}

// retries = extra attempts after the first.
// The pi harness has no turn limit: there the timeout is the only bound on a long tool loop.
export async function runChild({ seat, tools = "read", promptFile, outFile, worktree, ctxDir, schema, timeoutMs = (seat.timeout_minutes ?? 10) * 60000, retries = 2, routerUp, droppable = false, trusted = false }) {
  const fake = process.env.PR_REVIEW_FAKE;
  let harness = seat.harness;
  if (!fake && harness === "auto") harness = resolveHarness(seat, routerUp ?? (await probeRouter()));
  // pi has no file sandbox (no add-dir confinement or deny rules): a prompt injection in an untrusted PR could
  // read any local file into a finding, so pi seats run only for trusted authors; fail closed otherwise.
  if (!fake && harness === "pi" && !trusted) throw new ChildFailed(`${seat.harness}:${seat.model}: the pi harness has no file sandbox and runs only for trusted authors`);
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
  // pi's bash has no sandbox (writes anywhere the user can): a pi seat never gets a shell
  if (harness === "pi") tools = "read";
  if (harness === "pi") {
    const [prov, ...rest] = model.split("/");
    env.SEAT_PROVIDER = seat.provider ?? (rest.length ? prov : "");
    if (!seat.provider && rest.length) model = rest.join("/");
  }
  // claude --effort has no off or minimal: a Mimir seat routed through claude thinks at low.
  const thinking = harness === "claude" && ["off", "minimal"].includes(seat.thinking) ? "low" : seat.thinking;
  let last, usage = addUsage();
  // <key>.usage.json beside the output: every attempt counts, also a failed one and one of an earlier run (resume).
  const usageFile = outFile.replace(/(\.json)?$/, ".usage.json");
  try { usage = addUsage(usage, JSON.parse(readFileSync(usageFile, "utf8"))); } catch {}
  const output = async () => {
    const o = unwrapOutput(await readFile(outFile, "utf8").catch(() => ""));
    usage = addUsage(usage, o.usage);
    try { writeFileSync(usageFile, JSON.stringify(usage) + "\n"); } catch {} // usage is a record only: it never fails a child
    return o;
  };
  for (let i = 0; i <= retries; i++) {
    if (stopping) throw new ChildFailed("engine is stopping on a signal"); // a killed child is not retried
    let o = null;
    try {
      await runOnce(script, [model, thinking, tools, promptFile, outFile], env, cwd, timeoutMs);
      o = await output();
      const value = salvageJson(o.text, schema && ((v) => validate(schema, v).length === 0));
      if (value === null) throw new Error("no JSON in output");
      const errs = schema ? validate(schema, value) : [];
      if (errs.length) throw new Error(`invalid ${schema}: ${errs.join("; ")}`);
      return value;
    } catch (e) {
      last = e;
      o ??= await output();
      // A retry hits the same limit: the seat drops at once. claude prints this and exits 1 at --max-turns.
      // only council seats drop; judge, compose and reply children keep their retries
      if (droppable && e.timedOut) throw new SeatDropped(seat, "timeout", e.message);
      // a missing binary never succeeds on retry
      if (e.missing) throw new ChildFailed(`${fake ? "fake" : harness}:${seat.model}: harness binary missing: ${e.message}`);
      // claude -p prints only this line at --max-turns; a seat that merely quotes it in longer output is not matched
      if (harness === "claude" && (o.maxTurns || /error_max_turns/.test(e.message) || /^Error: Reached max turns \(\d+\)$/.test(o.text.trim()))) {
        // a retry hits the same limit: never retried; only council seats drop, other children fail
        if (droppable) throw new SeatDropped(seat, "turn limit", `max_turns (${seat.max_turns})`);
        throw new ChildFailed(`${harness}:${seat.model} hit max_turns (${seat.max_turns})`);
      }
    }
  }
  throw new ChildFailed(`${fake ? "fake" : harness}:${seat.model} failed after ${retries + 1} attempts: ${last.message}`);
}
