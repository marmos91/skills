#!/usr/bin/env node
// CLI: pr-review review|answer|tick|status|doctor|respond. Exit codes: 0 done, 1 usage or setup error, 3 questions wait, 4 a stage failed, 5 respond round cap.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installSignalHandlers, runChild as realRunChild } from "./lib/child.mjs";
import { DEFAULTS, EFFORTS, LENSES, applyEffort, loadConfig, plannedChildren, seatId, userConfigPath } from "./lib/config.mjs";
import { redact } from "./lib/secrets.mjs";
import { askJev as realAskJev, findJev as realFindJev } from "./lib/decider.mjs";
import { review, SetupError, STAGES } from "./lib/review.mjs";
import { answer, markAsked, openQuestions, questionWarnings } from "./lib/questions.mjs";
import { FINAL_STAGE, Locked, done, holderAlive, prState, stateRoot } from "./lib/state.mjs";
import { remoteRepos } from "./lib/github.mjs";

// The one signal path: stop the children, then exit; the lock is released on exit.
installSignalHandlers();

const USAGE = `usage: pr-review review [<n|url>] [--repo owner/repo] [--dry-run] [--lens a,b] [--until ${STAGES.join("|")}]
                 [--config <file>] [--effort low|medium|high|max|auto] [--max-diff-lines N] [--restart] [--loop]
       pr-review answer [<question-id> post|drop|ask-author] [--repo owner/repo]
       pr-review status [owner/repo]
       pr-review doctor [--config <file>]
       pr-review tick [owner/repo]
       pr-review pause|resume [owner/repo]
       pr-review respond findings|decide <thread>|approve <thread>|decline <thread> <reason>|fixed <thread> <sha>|summary <points.json> [--pr <n|url>]`;

const SKILL_DIR = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));

// GitHub names fold case, like stateRoot does.
const isClone = (repo) => remoteRepos().some((r) => r.toLowerCase() === repo.toLowerCase());

// --repo or the positional, else the GitHub remote of this folder (origin first). pr-review-loop uses the same rule.
function repoOf(flag) {
  const repo = flag ?? remoteRepos()[0];
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
  const repo = url?.[1] ?? repoFlag ?? remoteRepos()[0];
  const n = url ? Number(url[2]) : Number(arg);
  if (!repo) throw new Usage("cannot tell the repo: pass a PR URL or --repo owner/repo");
  if (!Number.isInteger(n) || n <= 0) throw new Usage(`not a PR number or URL: ${arg}`);
  // The worktree and the base-branch config come from this folder, so it must be a clone of the repo.
  if (!isClone(repo)) throw new Usage(`this folder is not a clone of ${repo}; cd into one`);
  return { repo, n };
}

class Usage extends Error {}

const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const ls = (d) => { try { return readdirSync(d); } catch { return []; } };

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
  const lock = raw === undefined ? null : { pid: raw, stale: raw === null ? !young() : !holderAlive(join(rs, "lock"), raw) };
  const questions = openQuestions(rs).map((q) => ({ id: q.id, pr: q.pr, file: join(rs, "questions", `${q.id}.md`) }));
  const todo = existsSync(join(rs, "todo.md")) ? readFileSync(join(rs, "todo.md"), "utf8") : "";
  const t = readJson(join(rs, "tick.json"));
  const prs = ls(join(rs, "pr")).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b).map((n) => {
    let st;
    try { st = prState(rs, n); } catch (e) { return { pr: n, error: `state.json unreadable: ${e.message}` }; }
    const runsDir = join(rs, "pr", String(n), "runs");
    const runs = ls(runsDir).filter((d) => !done(join(runsDir, d), FINAL_STAGE)).map((d) => {
      const dir = join(runsDir, d), run = readJson(join(dir, "run.json"));
      const childDone = ls(dir).reduce((k, s) => k + ls(join(dir, s)).filter((f) => f.endsWith(".done")).length, 0);
      return { sha: d.slice(0, d.lastIndexOf("-")), stage: STAGES.find((s) => !done(dir, s)), children: { done: childDone, total: run?.planned ?? null } };
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

// The outbound scan runs `gitleaks stdin` when gitleaks is installed; an old gitleaks without it blocks every post.
function gitleaksProbe(bin) {
  const v = spawnSync(bin, ["version"], { encoding: "utf8" });
  if (v.error || v.status !== 0) return ["WARN", "gitleaks: not found; the built-in secret patterns still apply"];
  const version = v.stdout.trim();
  const help = spawnSync(bin, ["--help"], { encoding: "utf8" });
  if (!/^\s+stdin\s/m.test(`${help.stdout}${help.stderr}`)) return ["FAIL", `gitleaks ${version}: no "stdin" subcommand, so every post is held; upgrade gitleaks or remove it from PATH`];
  return ["ok", `gitleaks ${version}`];
}

async function doctor(v, { runChild = realRunChild, askJev = realAskJev, findJev = realFindJev, gitleaks = "gitleaks" } = {}) {
  let repoText;
  try { repoText = execFileSync("git", ["show", "origin/HEAD:.pr-review.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  let config;
  try { config = loadConfig({ userPath: userConfigPath(), cliPath: v.config, repoText }); } catch (e) { throw new Usage(e.message); }
  // only known keys: unknown keys in a user file may hold secrets
  console.log(JSON.stringify(Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, config[k]])), null, 2));
  let fail = false;
  const line = (lvl, msg) => { if (lvl === "FAIL") fail = true; console.log(`${lvl.padEnd(4)} ${msg}`); };

  const seats = new Map();
  // One probe per distinct model, not per seat.
  for (const s of [...config.seats, config.judge, ...Object.values(config.lenses).flatMap((l) => l.seats ?? [])]) { const m = `${s.harness}:${s.model}`; if (!seats.has(m)) seats.set(m, s); }
  const dir = mkdtempSync(join(tmpdir(), "pr-review-doctor-"));
  try {
    const results = await Promise.allSettled([...seats.values()].map((seat, i) => {
      const promptFile = join(dir, `${i}.prompt`);
      writeFileSync(promptFile, 'Reply with exactly this JSON and nothing else: {"ok": true}\n');
      return runChild({ seat, trusted: true, promptFile, outFile: join(dir, `${i}.json`), timeoutMs: 60000, retries: 0 }); // a probe reads no PR
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
  line(...gitleaksProbe(gitleaks));
  console.log(`claude mode: --restricted (${process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "login"})`);
  const lenses = LENSES.filter((l) => config.lenses[l].enabled);
  for (const e of EFFORTS) console.log(`effort ${e}: ${plannedChildren(applyEffort(config, e), lenses)} children per PR (a diff above review.chunk_lines adds round 1 for each part)`);
  return fail ? 1 : 0;
}

const RESPOND_ARGS = { findings: 0, decide: 1, approve: 1, decline: 2, fixed: 2, summary: 1 };

// pr-respond: JSON on stdout; exit 5 when the round cap stops the loop. deps.gh and deps.askJev for tests.
async function respondCmd([action, ...args], v, deps) {
  if (!(action in RESPOND_ARGS) || args.length !== RESPOND_ARGS[action]) throw new Usage(USAGE);
  const { repo, n } = target(v.pr, v.repo);
  let config;
  try { config = loadConfig({ userPath: userConfigPath(), cliPath: v.config }); } catch (e) { throw new Usage(e.message); }
  const r = await import("./lib/respond.mjs");
  const gh = deps.gh ?? (await import("./lib/github.mjs"));
  const ask = deps.askJev ?? realAskJev;
  const jev = async (q, text) => (await ask(q, text, config)).answer;
  // git at the repo root, whatever subfolder the agent runs in
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new Usage("run pr-respond in a clone of the repo");
  const inRepo = (...g) => spawnSync("git", ["-C", top.stdout.trim(), ...g], { encoding: "utf8", maxBuffer: 64 << 20 });
  const { show, diff, fileDiff, onHead } = r.gitReaders(inRepo);
  const [a, b] = args;
  let out;
  try {
    if (action === "findings") out = await r.findings({ repo, n, gh, config });
    else if (action === "decide") out = await r.decide({ repo, n, threadId: a, gh, jev, show, fileDiff });
    else if (action === "approve") out = await r.approve({ repo, n, threadId: a, gh });
    else if (action === "decline") out = await r.decline({ repo, n, threadId: a, reason: b, gh });
    else if (action === "fixed") {
      const full = inRepo("rev-parse", "--verify", "--quiet", `${b}^{commit}`);
      if (!/^[0-9a-f]{7,40}$/.test(b) || full.status !== 0) throw new Usage(`not a commit sha in this clone: ${b}`);
      out = await r.fixed({ repo, n, threadId: a, sha: full.stdout.trim(), gh, jev, diff, onHead });
    } else {
      const points = readJson(a);
      if (!Array.isArray(points)) throw new Usage(`${a} must hold a JSON array of points`);
      try { r.summaryText(repo, points); } catch (e) { throw new Usage(e.message); }
      out = await r.summary({ repo, n, points, gh });
    }
  } catch (e) {
    if (e instanceof r.RoundCap) { console.error(`pr-respond: ${e.message}`); return 5; }
    if (e instanceof r.NotOnHead || e instanceof r.GitError) throw new Usage(e.message);
    throw e;
  }
  console.log(JSON.stringify(out, null, 2));
  return 0;
}

/** deps (tests): runChild, askJev, findJev, gitleaks (binary) for doctor. */
export async function main(argv, deps = {}) {
  const { values: v, positionals: [cmd, ...rest] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      repo: { type: "string" }, "dry-run": { type: "boolean" }, lens: { type: "string" }, until: { type: "string" },
      config: { type: "string" }, effort: { type: "string" }, "max-diff-lines": { type: "string" }, restart: { type: "boolean" }, loop: { type: "boolean" }, pr: { type: "string" }, help: { type: "boolean", short: "h" },
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
  if (cmd === "pause" || cmd === "resume") {
    if (rest.length > 1) throw new Usage(USAGE);
    const repo = repoOf(rest[0] ?? v.repo), dir = stateRoot(repo);
    if (cmd === "pause") { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "paused"), ""); } else rmSync(join(dir, "paused"), { force: true });
    console.log(`${cmd}d: ${repo}`);
    return 0;
  }
  if (cmd === "tick") {
    if (rest.length > 1) throw new Usage(USAGE);
    const { tick } = await import("./lib/tick.mjs");
    const repo = repoOf(rest[0] ?? v.repo);
    if (!isClone(repo)) throw new Usage(`this folder is not a clone of ${repo}; cd into one: a tick fetches PR heads here`);
    const r = await tick({ repo });
    return r?.exit ?? 0;
  }
  if (cmd === "respond") return respondCmd(rest, v, deps);
  if (cmd !== "review" || rest.length > 1) throw new Usage(USAGE);
  if (v.effort && !["low", "medium", "high", "max", "auto"].includes(v.effort)) throw new Usage(`--effort must be low|medium|high|max|auto`);
  if (v.until && !STAGES.includes(v.until)) throw new Usage(`--until must be one of ${STAGES.join("|")}`);
  const maxDiffLines = v["max-diff-lines"] === undefined ? undefined : Number(v["max-diff-lines"]);
  if (maxDiffLines !== undefined && !(/^\d+$/.test(v["max-diff-lines"]) && maxDiffLines > 0)) throw new Usage("--max-diff-lines must be a positive integer");
  const lenses = v.lens?.split(",").map((s) => s.trim()).filter(Boolean);
  if (lenses && !lenses.length) throw new Usage("--lens needs at least one lens name");
  const bad = lenses?.filter((l) => !LENSES.includes(l));
  if (bad?.length) throw new Usage(`unknown lens ${bad.join(", ")}; lenses: ${LENSES.join(", ")}`);
  const r = await review({
    ...target(rest[0], v.repo), mode: v.loop ? "loop" : "interactive", effort: v.effort, dryRun: v["dry-run"], until: v.until,
    restart: v.restart, lenses, maxDiffLines, configPath: v.config, log: (l) => console.error(l),
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
