#!/usr/bin/env node
// CLI: pr-review review|answer|tick. Exit codes: 0 done, 1 usage or setup error, 3 questions wait, 4 a stage failed.
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { installSignalHandlers } from "./lib/child.mjs";
import { LENSES } from "./lib/config.mjs";
import { review, SetupError, STAGES } from "./lib/review.mjs";
import { answer } from "./lib/questions.mjs";
import { Locked, stateRoot } from "./lib/state.mjs";

// The one signal path: stop the children, then exit; the lock is released on exit.
installSignalHandlers();

const USAGE = `usage: pr-review review [<n|url>] [--repo owner/repo] [--dry-run] [--lens a,b] [--until ${STAGES.join("|")}]
                 [--config <file>] [--effort low|medium|high|max|auto] [--restart] [--loop]
       pr-review answer <question-id> post|drop|ask-author [--repo owner/repo]
       pr-review tick [--repo owner/repo]`;

const GH_URL = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
const remotes = () => {
  try { return execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map((l) => GH_URL.exec(l.split(" ")[1] ?? "")?.[1]).filter(Boolean); } catch { return []; }
};

// No number: the PR of the current branch.
function currentPr() {
  try { return String(JSON.parse(execFileSync(process.env.GH_BIN || "gh", ["pr", "view", "--json", "number"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).number); }
  catch { throw new Usage("no PR number given and the current branch has no PR"); }
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

async function main(argv) {
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
    const repo = v.repo ?? remotes()[0];
    if (!id || !option || !repo) throw new Usage(USAGE);
    try { answer(stateRoot(repo), id, option); } catch (e) { throw new Usage(e.message); }
    console.log(`${id}: ${option}`);
    return 0;
  }
  if (cmd === "tick") {
    const { tick } = await import("./lib/tick.mjs"); // Task 13 module
    const r = await tick({ repo: v.repo ?? remotes()[0] });
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

main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
  console.error(`pr-review: ${e.message}`);
  // A bad flag, config or lock is a setup error (1); anything else broke a stage (4).
  process.exitCode = e instanceof Usage || e instanceof SetupError || e instanceof Locked || String(e?.code).startsWith("ERR_PARSE_ARGS") ? 1 : 4;
});
