#!/usr/bin/env node
// CLI: pr-converge run|status <n>. JSON on stdout. Exit codes: 0 converged or merged, 1 usage or lock,
// 2 the agent's turn (pr-respond), 3 paused for the user, 4 a step failed, 5 stopped (round cap, no progress, a declined must).
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { EFFORTS, loadUserConfig } from "../../pr-review/scripts/lib/config.mjs";
import * as github from "../../pr-review/scripts/lib/github.mjs";
import { summaryText as checkPoints, recordedPoints } from "../../pr-review/scripts/lib/respond.mjs";
import { review as realReview } from "../../pr-review/scripts/lib/review.mjs";
import { scanOutbound } from "../../pr-review/scripts/lib/secrets.mjs";
import { Locked, acquireLock, prState, stateRoot } from "../../pr-review/scripts/lib/state.mjs";
import { converge, convergeDir, loadState, saveState, summaryText } from "./lib/converge.mjs";

const USAGE = `usage: pr-converge run <n> [--repo owner/repo] [--merge] [--resume] [--pushed <sha> [--points <file>]] [--rebased <sha>]
                       [--config <file>] [--effort low|medium|high|max|auto]
       pr-converge status <n> [--repo owner/repo]`;
const OPTIONS = {
  repo: { type: "string" }, merge: { type: "boolean" }, resume: { type: "boolean" }, pushed: { type: "string" },
  points: { type: "string" }, rebased: { type: "string" }, config: { type: "string" }, effort: { type: "string" }, help: { type: "boolean", short: "h" },
};
const EXIT = { converged: 0, merged: 0, respond: 2, paused: 3, capped: 5, stalled: 5, declined: 5 };
const HERE = dirname(realpathSync(fileURLToPath(import.meta.url)));
const sibling = (skill, cli) => join(HERE, "..", "..", skill, "scripts", cli);
const SHA = /^[0-9a-f]{40}$/;

class Usage extends Error {}
const print = (v) => console.log(JSON.stringify(v, null, 2));

// secret-scan (#39) when installed, else the pr-review scan; the same rule as pr-open and pr-land.
function secretHits(text) {
  const r = spawnSync(process.env.PR_CONVERGE_SECRET_SCAN || "secret-scan", [], { input: text, encoding: "utf8" });
  if (r.error?.code === "ENOENT") return scanOutbound(text).hits;
  if (r.error) return [`secret-scan: ${r.error.message}`];
  return r.status === 0 ? [] : [String(r.stderr || "secret-scan: hit").trim()];
}

const ghIssues = { viewer: github.viewer, comment: github.comment, comments: github.issueComments, edit: github.editIssueComment };

/**
 * The real steps: pr-review's engine in process (its result says when it skipped), pr-land as a child, GitHub through
 * pr-review's gh helpers. reviewOpts (configPath, effort) go to every review round.
 */
export function realDeps(repo, n, { review = realReview, reviewOpts = {}, landBin = sibling("pr-land", "pr-land"), gh = ghIssues } = {}) {
  const rs = stateRoot(repo);
  return {
    head: async () => (await github.pr(repo, n)).headSha,
    review: async ({ restart } = {}) => {
      const before = (prState(rs, n).agreed ?? []).length;
      const r = await review({ ...reviewOpts, repo, n, restart, log: (l) => console.error(l) });
      if (r.exit !== 0 && r.exit !== 3) throw new Error(`pr-review: ${r.summary}`);
      // pr-review's own result: the questions this run queued (not the loop's reply or approve questions), and a stop for
      // unset core paths (depth auto) that reviewed nothing
      const st = prState(rs, n), questions = (r.questions ?? []).length;
      // fail closed: an exit 3 with no question of its own reviewed nothing we can count
      const skipped = r.skipped || r.corePaths || (r.exit === 3 && !questions) ? r.summary : null;
      return {
        // only a call that posted recorded its sha; else the loop keeps the head it called on
        sha: r.exit === 0 && !skipped ? st.lastReviewedSha : null, skipped,
        findings: skipped ? [] : (st.agreed ?? []).slice(before).map((f) => ({ fp: f.id, severity: f.severity, title: f.title })),
        questions,
      };
    },
    // the agent's push, recorded by --pushed for one respond step; without it, the agent's turn
    respond: async (s) => { const p = s.pushed; delete s.pushed; return p ?? { handoff: true }; },
    checks: async (sha) => { const s = (await github.checks(repo, n, sha)).state; return s === "none" ? "green" : s; },
    land: async () => {
      if (!existsSync(landBin)) return { blocked: "pr-land is not installed next to pr-converge" };
      // --repo: pr-land merges the PR the loop reviewed, and blocks when this clone has no remote for it
      const r = spawnSync(landBin, [String(n), "--repo", repo], { encoding: "utf8", stdio: ["ignore", "pipe", 2] });
      // pr-land exits 0 landed, 1 usage, 2 blocked (not ready, a scan hit, a conflict), 4 a step failed
      if (r.status === 2) { let j = {}; try { j = JSON.parse(r.stdout); } catch {} return { blocked: [j.blocked, ...(j.why ?? [])].filter(Boolean).join("; ") || "not ready" }; }
      if (r.status !== 0) throw new Error(`pr-land exited ${r.status ?? r.signal}: ${r.stdout.trim()}`);
      const commit = JSON.parse(execFileSync(process.env.GH_BIN || "gh", ["pr", "view", String(n), "-R", repo, "--json", "mergeCommit"], { encoding: "utf8" })).mergeCommit?.oid ?? null;
      return { merged: true, commit };
    },
    // one summary per PR: the key names the PR, not the body, so a rerun edits the same comment
    post: async (body) => {
      const key = createHash("sha1").update(`converge-summary\0${n}`).digest("hex");
      const hits = secretHits(body);
      if (hits.length) throw new Error(`the secret scan holds the summary: ${hits.join(", ")}`);
      const full = `${body}\n\n<!-- pr-review key=${key} -->`, me = await gh.viewer();
      const old = (await gh.comments(repo, n)).find((c) => c.user?.login === me && String(c.body).includes(`key=${key} -->`));
      if (!old) await gh.comment(repo, n, full);
      else if (old.body !== full) await gh.edit(repo, old.id, full);
    },
  };
}

/** --points as pr-respond summary takes it: an array of { n, status: done|open, text, sha for done }. */
function readPoints(file) {
  let points;
  try { points = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Usage(`cannot read --points: ${e.message}`); }
  if (!Array.isArray(points)) throw new Usage("--points must hold a JSON array of points");
  if (points.length) try { checkPoints("o/r", points); } catch (e) { throw new Usage(`--points: ${e.message}`); }
  for (const p of points) if (p.fp !== undefined && (typeof p.fp !== "string" || !p.fp)) throw new Usage(`--points: point ${p.n}: fp must be the finding's fingerprint`);
  return points;
}

/**
 * Applies the flags of a rerun to the saved state. recorded(sha, reviewed): the points pr-respond summary recorded at
 * that head in answer to the review of reviewed (the round's head).
 */
export function applyFlags(s, v, recorded = () => null) {
  if (v.merge) s.merge = true; // the opt-in holds for every rerun
  // a declined stop resumes at the respond step: the push that fixes the must comes with --pushed
  if (v.resume && s.phase === "done" && s.result === "declined") { s.phase = "respond"; s.result = null; s.summaryPosted = false; }
  // a run that converged without the opt-in lands on a rerun with it
  if (v.merge && s.phase === "done" && s.result === "converged") { s.phase = "land"; s.result = null; s.summaryPosted = false; }
  for (const k of ["pushed", "rebased"]) if (v[k] !== undefined && !SHA.test(v[k])) throw new Usage(`--${k} needs the full 40-character sha`);
  if (v.pushed && s.phase !== "respond") throw new Usage(`--pushed is for the end of a respond step; the loop is at ${s.phase}`);
  if (v.points && !v.pushed) throw new Usage("--points goes with --pushed");
  const saved = v.pushed && !v.points ? recorded(v.pushed, s.rounds.at(-1)?.sha) : null;
  if (v.pushed && !v.points && !saved) console.error(`pr-converge: no pr-respond summary was recorded at ${v.pushed.slice(0, 7)} for this round's review, so no point counts and a must stays open: run pr-respond summary at that head, or pass --points`);
  if (v.pushed) s.pushed = { sha: v.pushed, points: v.points ? readPoints(v.points) : saved ?? [] };
  if (v.rebased) { s.head = v.rebased; s.pause = null; } // a rebase that only resolves conflicts: same round, no review
  if (v.resume && s.pause) {
    if (s.pause.kind === "foreign-push") s.head = null; // the user took the push: the next round reviews it
    if (s.pause.kind === "review-skipped") s.restart = true; // the user asked for the head to be reviewed again
    s.pause = null;
  }
  return s;
}

export async function main(argv, { deps, review } = {}) {
  try {
    const { values: v, positionals: [cmd, num, ...extra] } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    if (v.help) { console.log(USAGE); return 0; }
    if (!["run", "status"].includes(cmd) || !/^\d+$/.test(num ?? "") || extra.length) throw new Usage(USAGE);
    const n = Number(num);
    const repo = v.repo ?? github.remoteRepos()[0];
    if (!repo) throw new Usage("cannot tell the repo: pass --repo owner/repo or run in a clone of it");
    try { stateRoot(repo); } catch (e) { throw new Usage(e.message); }
    if (cmd === "status") { print(loadState(repo, n)); return 0; }

    let config;
    try { config = loadUserConfig({ cliPath: v.config }); } catch (e) { throw new Usage(e.message); }
    if (v.effort && ![...EFFORTS, "auto"].includes(v.effort)) throw new Usage(`--effort must be ${[...EFFORTS, "auto"].join("|")}`);
    // its own lock beside the review lock: the pr-review child takes that one, and a manual review waits for it
    const release = acquireLock(convergeDir(repo, n), ` (pr-converge) of PR #${n}`);
    try {
      const d = { ...realDeps(repo, n, { review, reviewOpts: { configPath: v.config, effort: v.effort } }), ...deps }; // tests replace any step
      const state = applyFlags(loadState(repo, n), v, (sha, reviewed) => recordedPoints(repo, n, sha, reviewed));
      saveState(repo, n, state);
      const { status, state: s } = await converge(state, { deps: d, save: (x) => saveState(repo, n, x), maxRounds: config.converge.max_rounds });
      if (status in { converged: 1, merged: 1, capped: 1, stalled: 1, declined: 1 } && !s.summaryPosted) {
        await d.post(summaryText(repo, s));
        s.summaryPosted = true;
        saveState(repo, n, s);
      }
      print({ status, round: s.round, head: s.head, pause: s.pause, rounds: s.rounds, mergeCommit: s.mergeCommit ?? null });
      return EXIT[status];
    } finally { release(); }
  } catch (e) {
    if (e instanceof Usage || e instanceof Locked || e.code?.startsWith?.("ERR_PARSE_ARGS")) { console.error(`pr-converge: ${e.message}`); return 1; }
    console.error(`pr-converge: ${e.message}`);
    return 4;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
