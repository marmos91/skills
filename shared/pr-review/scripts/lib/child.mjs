import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHarness } from "./config.mjs";
import { validate } from "./schema.mjs";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "harness");
const ENV_OK = /^(PATH|HOME|USER|LOGNAME|SHELL|LANG|LC_.*|TMPDIR|TERM|XDG_.*|ANTHROPIC_BASE_URL|ANTHROPIC_CUSTOM_HEADERS|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR|CLAUDE_CODE_MAX_CONTEXT_TOKENS|(?:HTTP|HTTPS|NO)_PROXY|(?:http|https|no)_proxy|SSL_CERT_FILE|NODE_EXTRA_CA_CERTS|SEAT_PROVIDER|SEAT_WORKTREE|PR_REVIEW_.*)$/;

// Live child process groups: seats must not outlive the engine.
const live = new Set();
const killAll = (sig) => { for (const pid of live) try { process.kill(-pid, sig); } catch {} };
process.on("exit", () => killAll("SIGKILL"));
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15]]) {
  process.on(sig, () => {
    killAll("SIGTERM");
    const start = Date.now();
    const iv = setInterval(() => {
      for (const pid of live) try { process.kill(-pid, 0); } catch { live.delete(pid); }
      if (!live.size || Date.now() - start > 5000) { killAll("SIGKILL"); process.exit(128 + n); }
    }, 100);
  });
}

export class ChildFailed extends Error {
  constructor(msg) { super(msg); this.name = "ChildFailed"; }
}

export function salvageJson(text) {
  const s = String(text).replace(/```[a-zA-Z]*\n?/g, "");
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
          try { return JSON.parse(s.slice(i, j + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

let routerProbe;
function probeRouter() {
  routerProbe ??= fetch(process.env.PR_REVIEW_ROUTER_HEALTH || "http://127.0.0.1:4000/router/health", {
    signal: AbortSignal.timeout(2000),
  }).then((r) => r.ok, () => false);
  return routerProbe;
}

function runOnce(script, args, env, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(script, args, { cwd, env, detached: true, stdio: ["ignore", "ignore", "pipe"] });
    live.add(p.pid);
    let err = "", timedOut = false;
    p.stderr.on("data", (d) => { err += d; });
    const t = setTimeout(() => {
      timedOut = true;
      try { process.kill(-p.pid, "SIGKILL"); } catch {}
    }, timeoutMs);
    p.on("error", reject);
    p.on("close", (code) => {
      clearTimeout(t);
      live.delete(p.pid);
      try { process.kill(-p.pid, "SIGKILL"); } catch {} // reap stragglers
      if (timedOut) reject(new Error(`timed out after ${timeoutMs}ms`));
      else if (code !== 0) reject(new Error(`exit ${code}: ${err.trim().slice(-500)}`));
      else resolve();
    });
  });
}

// retries = extra attempts after the first.
export async function runChild({ seat, tools = "read", promptFile, outFile, worktree, schema, timeoutMs = 600000, retries = 2, routerUp }) {
  const fake = process.env.PR_REVIEW_FAKE;
  let harness = seat.harness;
  if (!fake && harness === "auto") harness = resolveHarness(seat, routerUp ?? (await probeRouter()));
  const script = join(HARNESS_DIR, `${fake ? "fake" : harness}.sh`);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_OK.test(k)));
  if (worktree) env.SEAT_WORKTREE = worktree;
  const cwd = dirname(outFile); // neutral run folder: the PR checkout must not supply CLAUDE.md or .claude/
  let model = seat.model;
  if (harness === "pi") {
    const [prov, ...rest] = model.split("/");
    env.SEAT_PROVIDER = seat.provider ?? (rest.length ? prov : "");
    if (!seat.provider && rest.length) model = rest.join("/");
  }
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      await runOnce(script, [model, seat.thinking, tools, promptFile, outFile], env, cwd, timeoutMs);
      const value = salvageJson(await readFile(outFile, "utf8"));
      if (value === null) throw new Error("no JSON in output");
      const errs = schema ? validate(schema, value) : [];
      if (errs.length) throw new Error(`invalid ${schema}: ${errs.join("; ")}`);
      return value;
    } catch (e) { last = e; }
  }
  throw new ChildFailed(`${fake ? "fake" : harness}:${seat.model} failed after ${retries + 1} attempts: ${last.message}`);
}
