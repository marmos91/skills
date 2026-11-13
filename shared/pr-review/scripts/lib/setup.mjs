// Review depth and setup checks (issue #38). light = read and vote only. full = the engine runs the checks of
// review.checks once in the worktree before round 1, and every seat gets the result in its brief.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { globMatch } from "./config.mjs";
import { ChildFailed, stopping, track, untrack } from "./child.mjs";
import { git } from "./frame.mjs";
import { CHECK_ENV_OK } from "./env.mjs";
import { appliedAnswer, closeQuestion, openQuestions, pendingAnswers, queueQuestion } from "./questions.mjs";
import { redact } from "./secrets.mjs";
import { done, markDone, writeAtomic } from "./state.mjs";

export const DEPTHS = ["light", "full", "auto"];

// Used when review.checks is not set and go.mod is at the worktree root. {dirs} = the folders of the changed
// paths that match the check's globs. No Node default: npm test needs an install first (network, install scripts).
export const GO_CHECKS = [
  { name: "go build", run: "go build ./...", paths: ["**/*.go", "**/go.mod", "**/go.sum"] },
  { name: "go vet", run: "go vet {dirs}", paths: ["**/*.go"] },
  { name: "go test", run: "go test -race -count=1 {dirs}", paths: ["**/*.go"], repeat: 3, timeout_s: 900, mutate: true },
];

const DOC_PATHS = ["**/*.md", "docs/**", "**/*.txt", "**/*.rst", "**/*.png", "**/*.jpg", "**/*.svg"];
export const TEST_PATHS = ["**/*_test.go", "**/*.test.*", "**/*.spec.*", "**/test/**", "**/tests/**", "**/__tests__/**", "**/testdata/**"];
// An added line that declares an exported name, by file type: Go (capital name), JS/TS (export), Rust (pub).
const EXPORTED = [
  [/\.go$/, /^\+(?:func (?:\([^)]*\) )?[A-Z]|type [A-Z])/],
  [/\.(?:js|mjs|cjs|ts|mts|cts|tsx|jsx)$/, /^\+\s*export /],
  [/\.rs$/, /^\+\s*pub (?:(?:async|unsafe|const) )*(?:fn|struct|enum|trait|mod|const|type|static) /],
];
const any = (globs, p) => globs.some((g) => globMatch(g, p));

/** True when the diff adds a line that declares an exported name, outside docs and test files. */
export function addsExportedApi(diff) {
  let re = null;
  for (const l of String(diff).split("\n")) {
    if (l.startsWith("+++ ")) {
      const file = l.startsWith("+++ b/") ? l.slice(6).replace(/\t$/, "") : null;
      re = file && !any([...DOC_PATHS, ...TEST_PATHS], file) ? EXPORTED.find(([ext]) => ext.test(file))?.[1] : null;
    } else if (re?.test(l)) return true;
  }
  return false;
}

/**
 * auto depth, first match wins: no changed path, every path is docs or tests, or every commit is a cherry-pick: light. A new exported
 * name: full. Then core paths: "needs-core" when they are not set (undefined), full for a match, else light.
 * The rules that need no core paths come first, so the caller asks for them only when the answer can change the depth.
 */
export function pickDepth({ paths, diff = "", cherryPick = false }, corePaths) {
  if (cherryPick || !paths.length || paths.every((p) => any(DOC_PATHS, p) || any(TEST_PATHS, p))) return "light";
  if (addsExportedApi(diff)) return "full";
  if (corePaths === undefined) return "needs-core";
  return paths.some((p) => any(corePaths, p)) ? "full" : "light";
}

// Every commit carries the line that `git cherry-pick -x` adds.
export function cherryPicked(f) {
  try {
    const bodies = git(f.worktree, ["log", "--format=%B%x00", `origin/${f.baseRef}..${f.headSha}`]).split("\0").map((s) => s.trim()).filter(Boolean);
    return bodies.length > 0 && bodies.every((b) => /\(cherry picked from commit [0-9a-f]{7,}\)/.test(b));
  } catch { return false; }
}

// core_paths per repo: the repo's .pr-review.json wins, then the answer saved in the repo's state folder.
// undefined = never asked; [] = the user said none.
const coreFile = (repoState) => join(repoState, "core-paths.json");
export function readCorePaths(repoState) {
  try { const v = JSON.parse(readFileSync(coreFile(repoState), "utf8")).core_paths; return Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined; } catch { return undefined; }
}
export const saveCorePaths = (repoState, globs) => writeAtomic(coreFile(repoState), JSON.stringify({ core_paths: globs, savedAt: new Date().toISOString() }, null, 2) + "\n");

/** Top folders of the base branch, most changed in its last 300 commits first: candidates for core_paths. */
export function coreCandidates(f) {
  const count = new Map();
  try {
    for (const p of git(f.worktree, ["log", "-n", "300", "--format=", "--name-only", `origin/${f.baseRef}`]).split("\n")) {
      if (p.includes("/") && !any([...DOC_PATHS, ...TEST_PATHS], p)) count.set(p.split("/")[0], (count.get(p.split("/")[0]) ?? 0) + 1);
    }
  } catch {}
  return [...count].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([d]) => `${d}/**`);
}

/**
 * The one place that applies core-paths answers (review, tick, `config core-paths`). The question's only option
 * is drop ("none"); it never replaces a saved value.
 */
export function settleCoreQuestions(repoState) {
  for (const q of pendingAnswers(repoState).filter((x) => x.finding?.kind === "core-paths")) {
    if (readCorePaths(repoState) === undefined) saveCorePaths(repoState, []);
    appliedAnswer(repoState, q.id);
  }
}

/** `config core-paths`: save, then close every core-paths question of the repo with no answer recorded. */
export function setCorePaths(repoState, globs) {
  saveCorePaths(repoState, globs);
  for (const q of openQuestions(repoState).filter((x) => x.finding?.kind === "core-paths")) closeQuestion(repoState, q.id);
  settleCoreQuestions(repoState);
}

/** The loop never blocks: one question per repo (pr 0, one fingerprint), so it is asked once. */
export function queueCoreQuestion(repoState, repo, candidates) {
  return queueQuestion(repoState, {
    pr: 0, sha: "", fingerprint: createHash("sha1").update(`core-paths\0${repo.toLowerCase()}`).digest("hex"), file: "(repo config)", line: 0, snippet: "",
    options: ["drop"], // globs cannot be an option: they are saved with `pr-review config core-paths`
    finding: { kind: "core-paths", title: "Which paths are core?", case: `review.depth is auto and ${repo} has no core paths. A PR that changes a core path gets a full review (setup checks). Until you answer, only a new exported API makes a review full. Candidates: ${candidates.join(", ") || "none"}.` },
    sides: { keep: `Run: pr-review config core-paths ${repo} <glob>...`, drop: "drop: no core paths (saved, never asked again)." },
    failure: "Code PRs get a light review.",
  });
}

const OUT_MAX = 4000;
const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/** The checks to run: config review.checks, else the Go defaults when go.mod is at the root; only those whose globs match a changed path. */
export function checksFor(config, f) {
  const list = config.review.checks ?? (existsSync(join(f.worktree, "go.mod")) ? GO_CHECKS : []);
  const out = [];
  for (const c of list) {
    const hit = c.paths ? f.changedPaths.filter((p) => any(c.paths, p)) : f.changedPaths;
    if (c.paths && !hit.length) continue;
    let run = c.run, dirs;
    if (run.includes("{dirs}")) {
      // Paths come from the PR: quoted, and only folders of the head that still hold a matching file
      // (go vet fails on a folder whose last .go file the PR deletes).
      const holds = (d) => { try { return readdirSync(join(f.worktree, d)).some((n) => any(c.paths ?? ["**"], d === "." ? n : `${d.slice(2)}/${n}`)); } catch { return false; } };
      dirs = [...new Set(hit.map((p) => (p.includes("/") ? `./${dirname(p)}` : ".")))].filter(holds);
      if (!dirs.length) continue;
      run = run.replaceAll("{dirs}", dirs.map(quote).join(" "));
    }
    out.push({ name: c.name, run, repeat: c.repeat ?? 1, timeout_s: c.timeout_s ?? 300, ...(c.mutate && { mutate: true, ...(dirs && { dirs }) }) });
  }
  return out;
}

const KILL_GRACE_MS = 3000;
/** One command in its own process group: cwd the worktree, a minimal env, killed at the time cap. Never throws on a failed command. */
export function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => CHECK_ENV_OK(k)));
    const p = spawn("/bin/sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    if (p.pid) track(p.pid);
    let out = "", timedOut = false, exit = null, drain;
    const add = (d) => { out = (out + d).slice(-64 * 1024); };
    p.stdout.on("data", add);
    p.stderr.on("data", add);
    const kill = (sig) => { try { process.kill(-p.pid, sig); } catch {} };
    const t = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref(); }, timeoutMs);
    const settle = () => { clearTimeout(drain); resolve({ exit, timedOut, output: out }); };
    p.on("exit", (code, sig) => {
      exit = code ?? sig;
      clearTimeout(t);
      kill("SIGKILL"); // a test server or a child left behind dies with the group
      if (p.pid) untrack(p.pid);
      drain = setTimeout(() => { p.stdout.destroy(); p.stderr.destroy(); settle(); }, 1000);
    });
    p.on("close", () => { if (exit !== null) settle(); });
    p.on("error", (e) => { clearTimeout(t); if (p.pid) untrack(p.pid); exit = 127; out += String(e.message); settle(); });
  });
}

/** One check: up to c.repeat runs, the first failure stops it, all within timeoutMs (> 0). Never throws on a failed run. */
export async function runCheck(c, wt, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let r, runs = 0;
  while (runs < c.repeat && Date.now() < deadline) {
    runs++;
    r = await runCommand(c.run, wt, deadline - Date.now());
    if (stopping) throw new ChildFailed("engine is stopping on a signal"); // a killed check is not a result
    if (r.exit !== 0) break;
  }
  return { ...r, runs };
}

/** Back to the PR head: tracked edits, commits and new files go. Throws when git fails. */
export function resetWorktree(wt, sha) {
  git(wt, ["reset", "-q", "--hard", sha]);
  git(wt, ["clean", "-fdxq"]); // -x: ignored build output from one check must not reach the next
}

/**
 * Runs each check once (repeat: up to N runs, the first failure stops it), resumable by a marker per check.
 * A failed or timed-out check is a result, never an error. Results go to ctx/setup.json, where seats read them.
 */
export async function runSetup(f, config, runDir, log = () => {}) {
  const file = join(f.ctxDir, "setup.json");
  if (done(runDir, "setup")) return JSON.parse(readFileSync(file, "utf8"));
  let result;
  if (!f.shellOk) result = { ran: false, reason: "an author is not trusted", checks: [] };
  else {
    const checks = [];
    let resetFailed = null;
    // Each check, and then the seats, start from the PR head: a check may write or commit in the worktree.
    const reset = () => {
      try { resetWorktree(f.worktree, f.headSha); } catch (e) {
        log(`setup: worktree reset failed: ${e.message}`);
        resetFailed = String(e.stderr || e.message).trim().slice(0, 200);
      }
    };
    reset(); // a resumed run may find a dirty worktree: {dirs} is read from it
    for (const c of checksFor(config, f)) {
      // keyed by the check itself: a config edited before a resume never reuses another check's result
      const key = createHash("sha1").update(`${c.name}\0${c.run}\0${c.repeat}\0${c.timeout_s}`).digest("hex").slice(0, 16);
      const one = join(runDir, "setup", `${key}.json`);
      if (done(runDir, "setup", key)) { checks.push(JSON.parse(readFileSync(one, "utf8"))); continue; }
      log(`setup: ${c.name}: ${c.run}`);
      const r = await runCheck(c, f.worktree, c.timeout_s * 1000);
      const v = { name: c.name, command: c.run, exit: r.exit, timed_out: r.timedOut, runs: r.runs, repeat: c.repeat, ok: r.exit === 0, output: redact(r.output.slice(-OUT_MAX)) };
      writeAtomic(one, JSON.stringify(v, null, 2) + "\n");
      markDone(runDir, "setup", key);
      checks.push(v);
      reset();
    }
    result = { ran: true, checks, ...(resetFailed && { reset_failed: resetFailed }) };
  }
  writeAtomic(file, JSON.stringify(result, null, 2) + "\n");
  markDone(runDir, "setup");
  return result;
}

const status = (c) => (c.ok ? `ok${c.runs > 1 ? ` (${c.runs} runs)` : ""}`
  : c.timed_out ? `timed out${c.runs > 1 ? ` on run ${c.runs} of ${c.repeat}` : ""}`
    : `failed (exit ${c.exit}${c.runs > 1 ? `, run ${c.runs} of ${c.repeat}: flaky` : ""})`);

/** The brief line every seat gets at full depth. */
export function setupBrief(s, ctxDir) {
  if (!s.ran) return `Setup checks did not run: ${s.reason}.`;
  if (!s.checks.length) return "Setup checks: no check matched the changed paths.";
  return [
    `Setup checks: the engine ran these once in the worktree before the review. Output: ${join(ctxDir, "setup.json")}. A failed check is a fact for your review: connect it to a line of the diff when you can.`,
    ...s.checks.map((c) => `- ${c.name}: ${status(c)}`), // the command holds PR paths ({dirs}): it stays in setup.json
    ...(s.reset_failed ? [`A worktree reset around the checks failed (the git error is in the engine log): a check or the worktree may not match the PR head. Check with git -C <worktree> status.`] : []),
  ].join("\n");
}

/** What was checked (the engine line of the posted summary, #46): the depth and the checks run. */
export function depthLine(depth, s, safe) {
  if (depth !== "full") return `${depth} depth, no checks run.`;
  if (!s?.ran) return `full depth; checks did not run: ${s?.reason ?? "no result"}.`;
  if (!s.checks.length) return "full depth; no check matched the changed paths.";
  return `full depth; ${s.checks.map((c) => `${safe(c.name)} ${status(c)}`).join(", ")}.`;
}
