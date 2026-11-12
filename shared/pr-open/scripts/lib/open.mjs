// Open the PR: checks first, then push and `gh pr create`. A stacked PR names its parent in a body marker for pr-land.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanOutbound } from "../../../pr-review/scripts/lib/secrets.mjs";
import { checkBranch } from "./check.mjs";
import { Blocked, readRecord } from "./counts.mjs";
import { readOverride } from "./detect.mjs";

/** The user must fix the input: exit 1. */
export class Usage extends Error {
  constructor(msg) { super(msg); this.name = "Usage"; }
}

export const PARENT_MARKER = "<!-- pr-open parent: ";
const MARKER_RE = /^<!-- pr-open parent: (\S+) -->$/m;

/** The parent branch a stacked PR body names, or null. pr-land (#40) reads this. */
export const parentOf = (body) => MARKER_RE.exec(body)?.[1] ?? null;

const TESTS_SECTION = /^## Tests[^\n]*\n[\s\S]*?(?=^## |(?![\s\S]))/m;

export function buildBody({ body, record, parent = null, parentPr = null }) {
  const c = record.counts;
  const line = `\`${record.command}\` at ${record.sha.slice(0, 7)}: ${c ? `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped.` : "counts not found in the output."}`;
  let out = body.replace(TESTS_SECTION, "").replace(new RegExp(MARKER_RE.source, "gm"), "").trimEnd();
  out = `${out}\n\n## Tests\n\n${line}\n`;
  return parent ? `Stacked on #${parentPr}.\n\n${out}\n${PARENT_MARKER}${parent} -->\n` : out;
}

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();

function gh(dir, args) {
  try { return execFileSync(process.env.GH_BIN || "gh", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${String(e.stderr || e.message).trim()}`); }
}
const openPrOf = (dir, branch) => JSON.parse(gh(dir, ["pr", "list", "--head", branch, "--state", "open", "--json", "number,url"]))[0] ?? null;

// secret-scan (#39) when installed, else the pr-review scan. Hits are masked by both.
function secretHits(text) {
  const r = spawnSync("secret-scan", [], { input: text, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error?.code === "ENOENT") return scanOutbound(text).hits;
  if (r.error) return [`secret-scan: ${r.error.message}`];
  return r.status === 0 ? [] : [String(r.stderr || "secret-scan: hit").trim()];
}

export async function openPr(dir, { title, bodyFile, base, draft = false }) {
  if (!title) throw new Usage("--title is required");
  const body = readFileSync(bodyFile, "utf8");
  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const def = JSON.parse(gh(dir, ["repo", "view", "--json", "defaultBranchRef"])).defaultBranchRef.name;
  base ??= def;
  if (branch === "HEAD" || branch === base) throw new Usage(`check out the branch to open (now on ${branch})`);
  const parent = base === def ? null : base;
  const parentPr = parent ? openPrOf(dir, parent) : null;
  if (parent && !parentPr) throw new Usage(`open a PR for ${parent} first`);

  const existing = openPrOf(dir, branch);
  if (existing) return { url: existing.url, number: existing.number, base, parent, warnings: ["a PR is already open"] };

  const sha = git(dir, "rev-parse", "HEAD");
  const record = readRecord(dir, sha);
  if (!record) throw new Blocked(`no test run for ${sha.slice(0, 7)}: run pr-open test`);
  if (record.exit !== 0 || record.counts?.failed > 0) throw new Blocked(`tests failed at ${sha.slice(0, 7)}`, record);
  const warnings = record.counts ? [] : ["counts not found in the test output"];

  git(dir, "fetch", "-q", "origin", base);
  const check = checkBranch(dir, `origin/${base}`, { title, body, allow: readOverride(dir).allow ?? [] });
  if (!check.ok) throw new Blocked("unsigned commits or AI mentions", check);

  const hits = secretHits(`${git(dir, "diff", `origin/${base}...HEAD`)}\n${title}\n${body}`);
  if (hits.length) throw new Blocked("the secret scan found a hit", { hits });

  if (!/#\d+/.test(body)) warnings.push("no linked issue");
  const final = buildBody({ body, record, parent, parentPr: parentPr?.number });
  const file = join(git(dir, "rev-parse", "--absolute-git-dir"), "pr-open", `body-${sha}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, final);

  // No PR is open (checked above), so a rewrite before the first PR may replace the pushed branch.
  git(dir, "push", "-q", "-u", "--force-with-lease", "origin", "HEAD");
  const url = gh(dir, ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", file, ...(draft ? ["--draft"] : [])]).trim().split("\n").at(-1);
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  return { url, number, base, parent, warnings };
}
