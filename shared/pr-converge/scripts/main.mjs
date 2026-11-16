#!/usr/bin/env node
// CLI: pr-converge run|status <n>. JSON on stdout. Exit codes: 0 converged or merged, 1 usage or lock,
// 2 the agent's turn (pr-respond), 3 paused for the user, 4 a step failed, 5 stopped (round cap or no progress).
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadUserConfig } from "../../pr-review/scripts/lib/config.mjs";
import * as github from "../../pr-review/scripts/lib/github.mjs";
import { openQuestions } from "../../pr-review/scripts/lib/questions.mjs";
import { scanOutbound } from "../../pr-review/scripts/lib/secrets.mjs";
import { Locked, acquireLock, prState, stateRoot } from "../../pr-review/scripts/lib/state.mjs";
import { converge, convergeDir, loadState, saveState, summaryText } from "./lib/converge.mjs";

const USAGE = `usage: pr-converge run <n> [--repo owner/repo] [--merge] [--resume] [--pushed <sha> [--points <file>]] [--rebased <sha>]
       pr-converge status <n> [--repo owner/repo]`;
const OPTIONS = {
  repo: { type: "string" }, merge: { type: "boolean" }, resume: { type: "boolean" }, pushed: { type: "string" },
  points: { type: "string" }, rebased: { type: "string" }, config: { type: "string" }, help: { type: "boolean", short: "h" },
};
const EXIT = { converged: 0, merged: 0, respond: 2, paused: 3, capped: 5, stalled: 5 };
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

/** The real steps: pr-review and pr-land as child processes, GitHub through pr-review's gh helpers. */
export function realDeps(repo, n, v) {
  const rs = stateRoot(repo);
  // the child's stdout goes to our stderr: our stdout is the JSON
  const child = (bin, args) => spawnSync(bin, args, { stdio: ["ignore", 2, 2] });
  return {
    head: async () => (await github.pr(repo, n)).headSha,
    review: async () => {
      const before = (prState(rs, n).agreed ?? []).length;
      const r = child(sibling("pr-review", "pr-review"), ["review", String(n), "--repo", repo]);
      if (r.status !== 0 && r.status !== 3) throw new Error(`pr-review review exited ${r.status ?? r.signal}`);
      const st = prState(rs, n);
      return {
        sha: st.lastReviewedSha,
        findings: (st.agreed ?? []).slice(before).map((f) => ({ fp: f.id, severity: f.severity, title: f.title })),
        questions: openQuestions(rs).filter((q) => q.pr === n).length,
      };
    },
    respond: async () => {
      if (!v.pushed) return { handoff: true };
      let points = [];
      if (v.points) try { points = JSON.parse(readFileSync(v.points, "utf8")); } catch (e) { throw new Usage(`cannot read --points: ${e.message}`); }
      return { sha: v.pushed, points };
    },
    checks: async (sha) => { const s = (await github.checks(repo, n, sha)).state; return s === "none" ? "green" : s; },
    land: async () => {
      const bin = sibling("pr-land", "pr-land");
      if (!existsSync(bin)) return { blocked: "pr-land is not installed next to pr-converge" };
      const r = spawnSync(bin, [String(n)], { encoding: "utf8", stdio: ["ignore", "pipe", 2] });
      if (r.status === 2) { let j = {}; try { j = JSON.parse(r.stdout); } catch {} return { blocked: [j.blocked, ...(j.why ?? [])].filter(Boolean).join("; ") || "not ready" }; }
      if (r.status !== 0) throw new Error(`pr-land exited ${r.status ?? r.signal}: ${r.stdout.trim()}`);
      const commit = JSON.parse(execFileSync(process.env.GH_BIN || "gh", ["pr", "view", String(n), "-R", repo, "--json", "mergeCommit"], { encoding: "utf8" })).mergeCommit?.oid ?? null;
      return { merged: true, commit };
    },
    post: async (body) => {
      const key = createHash("sha1").update(`converge-summary\0${n}\0${body}`).digest("hex");
      const hits = secretHits(body);
      if (hits.length) throw new Error(`the secret scan holds the summary: ${hits.join(", ")}`);
      if (!(await github.findMarker(repo, n, key))) await github.comment(repo, n, `${body}\n\n<!-- pr-review key=${key} -->`);
    },
  };
}

/** Applies the flags of a rerun to the saved state. */
export function applyFlags(s, v) {
  if (v.merge) s.merge = true; // the opt-in holds for every rerun
  for (const k of ["pushed", "rebased"]) if (v[k] !== undefined && !SHA.test(v[k])) throw new Usage(`--${k} needs the full 40-character sha`);
  if (v.pushed && s.phase !== "respond") throw new Usage(`--pushed is for the end of a respond step; the loop is at ${s.phase}`);
  if (v.points && !v.pushed) throw new Usage("--points goes with --pushed");
  if (v.rebased) { s.head = v.rebased; s.pause = null; } // a rebase that only resolves conflicts: same round, no review
  if (v.resume && s.pause) {
    if (s.pause.kind === "foreign-push") s.head = null; // the user took the push: the next round reviews it
    s.pause = null;
  }
  return s;
}

export async function main(argv, { deps } = {}) {
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
    // its own lock beside the review lock: the pr-review child takes that one, and a manual review waits for it
    const release = acquireLock(convergeDir(repo, n), ` (pr-converge) of PR #${n}`);
    try {
      const d = { ...realDeps(repo, n, v), ...deps }; // tests replace any step
      const state = applyFlags(loadState(repo, n), v);
      saveState(repo, n, state);
      const { status, state: s } = await converge(state, { deps: d, save: (x) => saveState(repo, n, x), maxRounds: config.converge.max_rounds });
      if (status in { converged: 1, merged: 1, capped: 1, stalled: 1 } && !s.summaryPosted) {
        await d.post(summaryText(repo, s));
        s.summaryPosted = true;
        saveState(repo, n, s);
      }
      print({ status, round: s.round, head: s.head, pause: s.pause, rounds: s.rounds.map(({ findings, ...r }) => r), mergeCommit: s.mergeCommit ?? null });
      return EXIT[status];
    } finally { release(); }
  } catch (e) {
    if (e instanceof Usage || e instanceof Locked || e.code?.startsWith?.("ERR_PARSE_ARGS")) { console.error(`pr-converge: ${e.message}`); return 1; }
    console.error(`pr-converge: ${e.message}`);
    return 4;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
