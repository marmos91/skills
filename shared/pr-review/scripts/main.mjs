#!/usr/bin/env node
// CLI: pr-review review|answer|tick|digest|status|doctor|respond. Exit codes: 0 done, 1 usage or setup error, 3 questions wait, 4 a stage failed, 5 respond round cap.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { installSignalHandlers, runChild as realRunChild } from "./lib/child.mjs";
import { DEFAULTS, EFFORTS, LENSES, applyEffort, lensFileProblem, loadUserConfig, plannedChildren, seatId, userLensDir } from "./lib/config.mjs";
import { redact } from "./lib/secrets.mjs";
import { askJev as realAskJev, findJev as realFindJev } from "./lib/decider.mjs";
import { review, SetupError, STAGES } from "./lib/review.mjs";
import { answer, markAsked, openQuestions, questionWarnings } from "./lib/questions.mjs";
import { LEARNINGS, forget, suggestion } from "./lib/learnings.mjs";
import { FINAL_STAGE, Locked, VERSION, done, holderAlive, prState, prUsage, stateRoot, usageByStage } from "./lib/state.mjs";
import { remoteRepos } from "./lib/github.mjs";
import { digestText } from "./lib/digest.mjs";
import { DEPTHS, setCorePaths } from "./lib/setup.mjs";

// The one signal path: stop the children, then exit; the lock is released on exit.
installSignalHandlers();

const USAGE = `usage: pr-review review [<n|url>] [--repo owner/repo] [--dry-run] [--lens a,b] [--until ${STAGES.join("|")}]
                 [--config <file>] [--effort low|medium|high|max|auto] [--depth light|full|auto] [--max-diff-lines N] [--restart] [--loop]
       pr-review answer [<question-id> post|drop|ask-author] [--repo owner/repo]
       pr-review status [owner/repo...] [--org <owner>]
       pr-review doctor [--config <file>]
       pr-review config core-paths <owner/repo> ['glob'...]
       pr-review tick [owner/repo...] [--org <owner>]
       pr-review digest [owner/repo]
       pr-review pause|resume [owner/repo]
       pr-review learnings forget <key> [--repo owner/repo]
       pr-review respond findings|decide <thread>|approve <thread>|decline <thread> <reason> [--wrong]|fixed <thread> <sha>|summary <points.json> [--pr <n|url>]`;

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

// tick and status: the repos named, else --org <owner>'s repos that are not archived (only those in loop.repos when it is set).
function reposOf(rest, v) {
  if (!v.org) return rest.length ? rest.map(repoOf) : [repoOf(v.repo)];
  if (rest.length || v.repo) throw new Usage("--org takes no repo");
  let config;
  try { config = loadUserConfig({}); } catch (e) { throw new Usage(e.message); }
  let list;
  try { list = JSON.parse(execFileSync(process.env.GH_BIN || "gh", ["repo", "list", v.org, "--no-archived", "--limit", "1000", "--json", "nameWithOwner"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })); }
  catch (e) { throw new Error(`gh repo list ${v.org} failed: ${String(e.stderr || e.message).trim()}`); }
  const only = new Set(config.loop.repos.map((r) => r.toLowerCase()));
  const repos = list.map((r) => r.nameWithOwner).filter((r) => !only.size || only.has(r.toLowerCase())).map(repoOf);
  if (!repos.length) throw new Usage(`--org ${v.org}: no repos${only.size ? " in loop.repos" : ""}`);
  return repos;
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

// The lock in `parent` (the repo folder: the tick; a PR folder: a review of that PR), or null.
function lockOf(parent) {
  const dir = join(parent, "lock"), raw = readJson(join(dir, "pid")) ?? (existsSync(dir) ? null : undefined);
  // a lock dir with no pid is stale only after 60 s, as acquireLock treats it
  const young = () => { try { return Date.now() - statSync(dir).mtimeMs < 60000; } catch { return false; } };
  return raw === undefined ? null : { pid: raw, stale: raw === null ? !young() : !holderAlive(dir, raw) };
}

function status(repo, prices = {}) {
  const rs = stateRoot(repo);
  const lock = lockOf(rs);
  const questions = openQuestions(rs).map((q) => ({ id: q.id, pr: q.pr, file: join(rs, "questions", `${q.id}.md`) }));
  const todo = existsSync(join(rs, "todo.md")) ? readFileSync(join(rs, "todo.md"), "utf8") : "";
  const t = readJson(join(rs, "tick.json"));
  const prs = ls(join(rs, "pr")).filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => a - b).map((n) => {
    let st;
    try { st = prState(rs, n); } catch (e) { return { pr: n, error: `state.json unreadable: ${e.message}` }; }
    const runsDir = join(rs, "pr", String(n), "runs");
    // newest run by its <sha>-<ms> name, posted or not (dry run, --until): lastRunId tracks only posted reviews
    const latestRun = ls(runsDir).sort((a, b) => Number(a.slice(a.lastIndexOf("-") + 1)) - Number(b.slice(b.lastIndexOf("-") + 1))).at(-1);
    const runs = ls(runsDir).filter((d) => !done(join(runsDir, d), FINAL_STAGE)).map((d) => {
      const dir = join(runsDir, d), run = readJson(join(dir, "run.json"));
      // setup/ holds check markers, not children
      const childDone = ls(dir).filter((s) => s !== "setup").reduce((k, s) => k + ls(join(dir, s)).filter((f) => f.endsWith(".done")).length, 0);
      return { sha: d.slice(0, d.lastIndexOf("-")), stage: STAGES.find((s) => !done(dir, s)), children: { done: childDone, total: run?.planned ?? null }, tokens: usageByStage(dir, prices) };
    });
    const replies = Object.values(st.replies ?? {}).reduce((a, b) => a + (Number(b) || 0), 0);
    return { pr: n, lock: lockOf(join(rs, "pr", String(n))), reviews: st.reviews, replies, lastReviewedSha: st.lastReviewedSha, lastRunTokens: latestRun ? usageByStage(join(runsDir, latestRun), prices) : {}, prTokens: prUsage(runsDir, prices), questions: questions.filter((q) => q.pr === n).length, runs };
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
  console.log(`pr-review ${VERSION} (${SKILL_DIR})`);
  let repoText;
  try { repoText = execFileSync("git", ["show", "origin/HEAD:.pr-review.json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch {}
  let config;
  try { config = loadUserConfig({ cliPath: v.config, repoText }); } catch (e) { throw new Usage(e.message); }
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

  // A token without status write fails the pr-review status with only a log line. The probe posts to a sha that does
  // not exist: GitHub checks the permission first (404/403), then the sha (422), so nothing is written.
  const repo = remoteRepos()[0];
  if (repo) {
    const r = spawnSync(process.env.GH_BIN || "gh", ["api", "-X", "POST", `repos/${repo}/statuses/${"0".repeat(40)}`, "-f", "state=pending", "-f", "context=pr-review"], { encoding: "utf8" });
    if (r.status === 0 || /HTTP 422/.test(r.stderr)) line("ok", `commit status: the token can set pr-review on ${repo}`);
    else line("WARN", `commit status: the token cannot set pr-review on ${repo} (${redact((r.stderr || "").trim().split("\n").at(-1))}); give it the repo:status scope or Commit statuses: write`);
  }

  // jev missing is a warning: the decider then queues questions.
  const bin = findJev(SKILL_DIR, process.env);
  if (!bin) line("WARN", "jev: not found; split findings become questions");
  else {
    const { answer: a } = await askJev("The text says the sky is blue.", "The sky is blue.", { decider: { kind: "jev", confidence: 0 } }, { timeoutMs: 20000, skillDir: SKILL_DIR });
    line(a === "unsure" ? "WARN" : "ok", `jev: found at ${bin}, ${a === "unsure" ? "not answering" : "answering"}`);
  }
  line(...gitleaksProbe(gitleaks));
  console.log(`claude mode: --restricted (${process.env.CLAUDE_CODE_OAUTH_TOKEN ? "CLAUDE_CODE_OAUTH_TOKEN" : "login"})`);
  const lenses = Object.keys(config.lenses).filter((l) => config.lenses[l].enabled);
  for (const l of Object.keys(config.lenses).filter((x) => !LENSES.includes(x) && !config.lenses[x].enabled)) {
    const p = lensFileProblem(userLensDir(), l);
    if (p) line("WARN", `${p} (the lens is off)`);
  }
  console.log(`lenses: ${Object.keys(config.lenses).map((l) => `${l}${LENSES.includes(l) ? "" : " (user)"}${config.lenses[l].enabled ? "" : " (off)"}`).join(", ")}`);
  for (const e of EFFORTS) console.log(`effort ${e}: ${plannedChildren(applyEffort(config, e), lenses)} children per PR (a diff above review.chunk_lines adds round 1 for each part)`);
  return fail ? 1 : 0;
}

const RESPOND_ARGS = { findings: 0, decide: 1, approve: 1, decline: 2, fixed: 2, summary: 1 };

// pr-respond: JSON on stdout; exit 5 when the round cap stops the loop. deps.gh and deps.askJev for tests.
async function respondCmd([action, ...args], v, deps) {
  if (!(action in RESPOND_ARGS) || args.length !== RESPOND_ARGS[action]) throw new Usage(USAGE);
  const { repo, n } = target(v.pr, v.repo);
  let config;
  try { config = loadUserConfig({ cliPath: v.config }); } catch (e) { throw new Usage(e.message); }
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
    else if (action === "decline") out = await r.decline({ repo, n, threadId: a, reason: b, wrong: !!v.wrong, gh });
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
  if (out.learned?.length) console.error(suggestion(out.learned));
  return 0;
}

/** deps (tests): runChild, askJev, findJev, gitleaks (binary) for doctor. */
export async function main(argv, deps = {}) {
  const { values: v, positionals: [cmd, ...rest] } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      repo: { type: "string" }, "dry-run": { type: "boolean" }, lens: { type: "string" }, until: { type: "string" },
      config: { type: "string" }, effort: { type: "string" }, depth: { type: "string" }, "max-diff-lines": { type: "string" }, restart: { type: "boolean" }, org: { type: "string" }, loop: { type: "boolean" }, wrong: { type: "boolean" }, pr: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (v.help || !cmd) { console.log(USAGE); return v.help ? 0 : 1; }
  if (v.org && cmd !== "tick" && cmd !== "status") throw new Usage("--org works only with tick and status");
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
    const repos = reposOf(rest, v);
    // prices only: a config error never hides the status, it leaves tokens without a cost
    let prices = {};
    try { prices = loadUserConfig({ cliPath: v.config }).prices; } catch (e) { console.error(`warning: config not loaded, tokens shown without cost: ${e.message}`); }
    console.log(JSON.stringify(repos.length === 1 && !v.org ? status(repos[0], prices) : repos.map((r) => status(r, prices)), null, 2));
    return 0;
  }
  if (cmd === "digest") {
    if (rest.length > 1) throw new Usage(USAGE);
    const repo = repoOf(rest[0] ?? v.repo);
    console.log(digestText(repo, stateRoot(repo)) || `${repo}: no open questions or to-do items`);
    return 0;
  }
  if (cmd === "doctor") return doctor(v, deps);
  if (cmd === "config") {
    // The answer to "which paths are core?": saved per repo, also when empty (none), so auto depth never asks again.
    const [what, repo, ...globs] = rest;
    if (what !== "core-paths" || !repo) throw new Usage(USAGE);
    let rs;
    try { rs = stateRoot(repo); } catch (e) { throw new Usage(e.message); }
    // An unquoted glob reaches us already expanded by the shell, but argv looks the same as a quoted literal
    // path (go.mod is a valid core path), so warn and save as given; never refuse.
    const expanded = globs.filter((g) => !/[*?[{]/.test(g) && existsSync(g));
    if (expanded.length) console.error(`warning: ${expanded.join(" ")} ${expanded.length > 1 ? "exist" : "exists"} here: if the shell expanded a glob, quote it (for example 'pkg/**') and run again. Saved as given.`);
    setCorePaths(rs, globs);
    console.log(`core paths of ${repo}: ${globs.join(" ") || "none"}`);
    return 0;
  }
  if (cmd === "pause" || cmd === "resume") {
    if (rest.length > 1) throw new Usage(USAGE);
    const repo = repoOf(rest[0] ?? v.repo), dir = stateRoot(repo);
    if (cmd === "pause") { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, "paused"), ""); } else rmSync(join(dir, "paused"), { force: true });
    console.log(`${cmd}d: ${repo}`);
    return 0;
  }
  if (cmd === "learnings") {
    const [what, key] = rest;
    if (what !== "forget" || !/^[0-9a-f]{40}$/.test(key ?? "") || rest.length > 2) throw new Usage(USAGE);
    const ok = forget(stateRoot(repoOf(v.repo)), key);
    console.log(ok ? `forgot ${key}` : `${key} is not in the local learnings`);
    console.error(`if ${LEARNINGS} on the base branch has it, remove the line there too`);
    return ok ? 0 : 1;
  }
  if (cmd === "tick") {
    const { tick } = await import("./lib/tick.mjs");
    const repos = reposOf(rest, v);
    // The clone of owner/name is this folder or ./name; tick and review work in the current folder, so chdir there.
    const home = process.cwd(), name = (repo) => repo.split("/")[1];
    const cloneOf = (repo) => [home, join(home, name(repo))].find((d) => { try { process.chdir(d); return isClone(repo); } catch { return false; } });
    if (repos.length === 1 && !v.org) {
      try {
        if (!cloneOf(repos[0])) throw new Usage(`this folder is not a clone of ${repos[0]}, nor is ./${name(repos[0])}; cd into one: a tick fetches PR heads there`);
        await tick({ repo: repos[0] });
        return 0;
      } finally { process.chdir(home); }
    }
    // Several repos: one tick each, one after another, each with its own lock and queue. A failed repo does not stop
    // the rest; with --org a repo without a clone is only skipped, as an org lists repos you may not work on.
    let code = 0;
    for (const repo of repos) {
      console.error(`pr-review-loop: ${repo}`);
      try {
        if (!cloneOf(repo)) {
          console.error(`pr-review-loop: ${repo}: no clone here or in ./${name(repo)}; skipped`);
          if (!v.org) code = 4;
          continue;
        }
        await tick({ repo });
      } catch (e) { console.error(`pr-review-loop: ${repo}: ${e.message}`); code = 4; }
      finally { process.chdir(home); }
    }
    return code;
  }
  if (cmd === "respond") return respondCmd(rest, v, deps);
  if (cmd !== "review" || rest.length > 1) throw new Usage(USAGE);
  if (v.effort && !["low", "medium", "high", "max", "auto"].includes(v.effort)) throw new Usage(`--effort must be low|medium|high|max|auto`);
  if (v.depth && !DEPTHS.includes(v.depth)) throw new Usage(`--depth must be ${DEPTHS.join("|")}`);
  if (v.until && !STAGES.includes(v.until)) throw new Usage(`--until must be one of ${STAGES.join("|")}`);
  const maxDiffLines = v["max-diff-lines"] === undefined ? undefined : Number(v["max-diff-lines"]);
  if (maxDiffLines !== undefined && !(/^\d+$/.test(v["max-diff-lines"]) && maxDiffLines > 0)) throw new Usage("--max-diff-lines must be a positive integer");
  const lenses = v.lens?.split(",").map((s) => s.trim()).filter(Boolean);
  if (lenses && !lenses.length) throw new Usage("--lens needs at least one lens name");
  const r = await (deps.review ?? review)({
    ...target(rest[0], v.repo), mode: v.loop ? "loop" : "interactive", effort: v.effort, depth: v.depth, dryRun: v["dry-run"], until: v.until,
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
