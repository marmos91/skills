#!/usr/bin/env node
// CLI: pr-review review|answer|tick|status|doctor. Exit codes: 0 done, 1 usage or setup error, 3 questions wait, 4 a stage failed.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installSignalHandlers, runChild as realRunChild } from "./lib/child.mjs";
import { DEFAULTS, EFFORTS, LENSES, applyEffort, loadConfig, plannedChildren, seatId } from "./lib/config.mjs";
import { redact } from "./lib/secrets.mjs";
import { askJev as realAskJev, findJev as realFindJev } from "./lib/decider.mjs";
import { review, SetupError, STAGES } from "./lib/review.mjs";
import { answer, markAsked, openQuestions, questionWarnings } from "./lib/questions.mjs";
import { FINAL_STAGE, Locked, done, prState, stateRoot } from "./lib/state.mjs";

// The one signal path: stop the children, then exit; the lock is released on exit.
installSignalHandlers();

const USAGE = `usage: pr-review review [<n|url>] [--repo owner/repo] [--dry-run] [--lens a,b] [--until ${STAGES.join("|")}]
                 [--config <file>] [--effort low|medium|high|max|auto] [--restart] [--loop]
       pr-review answer [<question-id> post|drop|ask-author] [--repo owner/repo]
       pr-review status [owner/repo]
       pr-review doctor [--config <file>]
       pr-review tick [--repo owner/repo]`;

const SKILL_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const USER_CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pr-review", "config.json");

const GH_URL = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const remotes = () => {
  let lines;
  try { lines = execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n"); } catch { return []; }
  lines.sort((a, b) => b.startsWith("remote.origin.url ") - a.startsWith("remote.origin.url ")); // origin first
  return lines.map((l) => GH_URL.exec(l.split(" ")[1] ?? "")?.[1]).filter(Boolean);
};

// --repo, else the GitHub remote of this folder (origin first).
function repoOf(flag) {
  const repo = flag ?? remotes()[0];
  if (!repo) throw new Usage("cannot tell the repo: pass --repo owner/repo or run in a clone of it");
  try { stateRoot(repo); } catch (e) { throw new Usage(e.message); }
  return repo;
}

// No number: the PR of the current branch.
function currentPr() {
  try { return String(JSON.parse(execFileSync(process.env.GH_BIN || "gh", ["pr", "view", "--json", "number"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).number); }
  catch (e) {
    // Only "no PR for this branch" is the user's to fix; auth or network errors are a failed stage (4).
    if (/no (?:pull requests|open pull requests) found/i.test(String(e.stderr))) throw new Usage("no PR number given and the current branch has no PR");
    throw new Error(`gh pr view failed: ${String(e.stderr || e.message).trim()}`);
  }
}

function target(arg, repoFlag) {
  arg ??= currentPr();
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(arg ?? "");
  const repo = url?.[1] ?? repoFlag ?? remotes()[0];
  const n = url ? Number(url[2]) : Number(arg);
  if (!repo) throw new Usage("cannot tell the repo: pass a PR URL or --repo owner/repo");
  if (!Number.isInteger(n) || n <= 0) throw new Usage(`not a PR number or URL: ${arg}`);
  // The worktree and the base-branch config come from this folder, so it must be a clone of the repo.
  if (!remotes().includes(repo)) throw new Usage(`this folder is not a clone of ${repo}; cd into one`);
  return { repo, n };
}

class Usage extends Error {}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const ls = (d) => { try { return readdirSync(d); } catch { return []; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

// Engine fields and file paths only: the PR's code stays in the fenced .md file; finding and sides are redacted there.
function listQuestions(rs) {
  const open = openQuestions(rs);
  markAsked(rs, open.map((q) => q.id));
  return open.map((q) => ({
    id: q.id, pr: q.pr, sha: q.sha, options: q.options, createdAt: q.createdAt,
    finding: q.finding, sides: q.sides, file: join(rs, "questions", `${q.id}.md`),
  }));
}

function status(repo) {
  const rs = stateRoot(repo);
  const raw = readJson(join(rs, "lock", "pid")) ?? (existsSync(join(rs, "lock")) ? null : undefined);
  // a lock dir with no pid is stale only after 60 s, as acquireLock treats it
  const young = () => { try { return Date.now() - statSync(join(rs, "lock")).mtimeMs < 60000; } catch { return false; } };
  const lock = raw === undefined ? null : { pid: raw, stale: raw === null ? !young() : !alive(raw) };
  const questions = openQuestions(rs).map((q) => ({ id: q.id, pr: q.pr, file: join(rs, "questions", `${q.id}.md`) }));
  const todo = existsSync(join(rs, "todo.md")) ? readFileSync(join(rs, "todo.md"), "utf8") : "";
  const t = readJson(join(rs, "tick.json"));
  let cfg = null;
  try { cfg = loadConfig({ userPath: USER_CONFIG }); } catch {}
  const prs = ls(join(rs, "pr")).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b).map((n) => {
    let st;
    try { st = prState(rs, n); } catch (e) { return { pr: n, error: `state.json unreadable: ${e.message}` }; }
    const runsDir = join(rs, "pr", String(n), "runs");
    const runs = ls(runsDir).filter((d) => !done(join(runsDir, d), FINAL_STAGE)).map((d) => {
      const dir = join(runsDir, d), run = readJson(join(dir, "run.json"));
      const childDone = ls(dir).reduce((k, s) => k + ls(join(dir, s)).filter((f) => f.endsWith(".done")).length, 0);
      // shortcut: total uses the user config, not the repo config the run loaded; store it in run.json if they drift.
      let total = null;
      try { if (cfg && run) total = plannedChildren(applyEffort(cfg, run.effort), run.lenses); } catch {}
      return { sha: d.slice(0, d.lastIndexOf("-")), stage: STAGES.find((s) => !done(dir, s)), children: { done: childDone, total } };
    });
    const replies = Object.values(st.replies ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
    return { pr: n, reviews: st.reviews, replies, lastReviewedSha: st.lastReviewedSha, questions: questions.filter((q) => q.pr === n).length, runs };
  });
  return {
    repo, paused: existsSync(join(rs, "paused")), lock, questions, warnings: questionWarnings(rs),
    todos: (todo.match(/^- \[ \]/gm) ?? []).length,
    tick: t && { startedAt: t.startedAt, current: t.current, left: (t.queue ?? []).map((r) => r.number).filter((x) => !(t.done ?? []).includes(x)) },
    prs,
  };
}

async function doctor(v, { runChild = realRunChild, askJev = realAskJev, findJev = realFindJev } = {}) {
  let repoText;
  try { repoText = execFileSync("git", ["show", "origin/HEAD:.pr-review.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  let config;
  try { config = loadConfig({ userPath: USER_CONFIG, cliPath: v.config, repoText }); } catch (e) { throw new Usage(e.message); }
  // only known keys: unknown keys in a user file may hold secrets
  console.log(JSON.stringify(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, config[k]])), null, 2));
  let fail = false;
  const line = (lvl, msg) => { if (lvl === "FAIL") fail = true; console.log(`${lvl.padEnd(4)} ${msg}`); };

  const seats = new Map();
  for (const s of [...config.seats, config.judge, ...Object.values(config.lenses).flatMap((l) => l.seats ?? [])]) if (!seats.has(seatId(s))) seats.set(seatId(s), s);
  const dir = mkdtempSync(join(tmpdir(), "pr-review-doctor-"));
  try {
    const results = await Promise.allSettled([...seats.values()].map((seat, i) => {
      const promptFile = join(dir, `${i}.prompt`);
      writeFileSync(promptFile, 'Reply with exactly this JSON and nothing else: {"ok": true}\n');
      return runChild({ seat, promptFile, outFile: join(dir, `${i}.json`), timeoutMs: 60000, retries: 0 });
    }));
    [...seats.keys()].forEach((id, i) => results[i].status === "fulfilled" ? line("ok", `seat ${id}`) : line("FAIL", `seat ${id}: ${redact(String(results[i].reason?.message))}`));
  } finally { rmSync(dir, { recursive: true, force: true }); }

  try { execFileSync(process.env.GH_BIN || "gh", ["auth", "status"], { stdio: "ignore" }); line("ok", "gh auth status"); }
  catch { line("FAIL", "gh auth status: not logged in (run gh auth login, or export GH_TOKEN)"); }

  // jev missing is a warning: the decider then queues questions.
  const bin = findJev(SKILL_DIR, process.env);
  if (!bin) line("WARN", "jev: not found; split findings become questions");
  else {
    const { answer: a } = await askJev("The text says the sky is blue.", "The sky is blue.", { decider: { kind: "jev", confidence: 0 } }, { timeoutMs: 20000, skillDir: SKILL_DIR });
    line(a === "unsure" ? "WARN" : "ok", `jev: found at ${bin}, ${a === "unsure" ? "not answering" : "answering"}`);
  }
  console.log(`claude mode: ${process.env.CLAUDE_CODE_OAUTH_TOKEN ? "--bare" : "--restricted"}`);
  const lenses = LENSES.filter((l) => config.lenses[l].enabled);
  for (const e of EFFORTS) console.log(`effort ${e}: ${plannedChildren(applyEffort(config, e), lenses)} children per PR`);
  return fail ? 1 : 0;
}

/** deps (tests): runChild, askJev, findJev for doctor. */
export async function main(argv, deps = {}) {
  const { values: v, positionals: [cmd, ...rest] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      repo: { type: "string" }, "dry-run": { type: "boolean" }, lens: { type: "string" }, until: { type: "string" },
      config: { type: "string" }, effort: { type: "string" }, restart: { type: "boolean" }, loop: { type: "boolean" }, help: { type: "boolean", short: "h" },
    },
  });
  if (v.help || !cmd) { console.log(USAGE); return v.help ? 0 : 1; }
  if (cmd === "answer") {
    const [id, option] = rest;
    if (rest.length > 2 || (id && !option)) throw new Usage(USAGE);
    const rs = stateRoot(repoOf(v.repo));
    if (!id) { console.log(JSON.stringify(listQuestions(rs), null, 2)); return 0; }
    try { answer(rs, id, option); } catch (e) { throw new Usage(e.message); }
    console.log(`${id}: ${option}`);
    return 0;
  }
  if (cmd === "status") {
    if (rest.length > 1) throw new Usage(USAGE);
    console.log(JSON.stringify(status(repoOf(rest[0] ?? v.repo)), null, 2));
    return 0;
  }
  if (cmd === "doctor") return doctor(v, deps);
  if (cmd === "tick") {
    const { tick } = await import("./lib/tick.mjs"); // Task 13 module
    const r = await tick({ repo: repoOf(v.repo) });
    return r?.exit ?? 0;
  }
  if (cmd !== "review" || rest.length > 1) throw new Usage(USAGE);
  if (v.effort && !["low", "medium", "high", "max", "auto"].includes(v.effort)) throw new Usage(`--effort must be low|medium|high|max|auto`);
  if (v.until && !STAGES.includes(v.until)) throw new Usage(`--until must be one of ${STAGES.join("|")}`);
  const lenses = v.lens?.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = lenses?.filter((l) => !LENSES.includes(l));
  if (bad?.length) throw new Usage(`unknown lens ${bad.join(", ")}; lenses: ${LENSES.join(", ")}`);
  const r = await review({
    ...target(rest[0], v.repo), mode: v.loop ? "loop" : "interactive", effort: v.effort, dryRun: v["dry-run"], until: v.until,
    restart: v.restart, lenses, configPath: v.config, log: (l) => console.error(l),
  });
  console.log(r.summary);
  for (const q of r.questions ?? []) console.log(q);
  return r.exit;
}

// Run only as the entry point: tests import main().
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`pr-review: ${e.message}`);
    // A bad flag, config or lock is a setup error (1); anything else broke a stage (4).
    process.exitCode = e instanceof Usage || e instanceof SetupError || e instanceof Locked || String(e?.code).startsWith("ERR_PARSE_ARGS") ? 1 : 4;
  });
}
