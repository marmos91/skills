// Open the PR: checks first, then push and `gh pr create`. A stacked PR names its parent in a body marker for pr-land.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanOutbound } from "../../../pr-review/scripts/lib/secrets.mjs";
import { checkBranch } from "./check.mjs";
import { Blocked, Usage, readRecord } from "./counts.mjs";
import { readOverride } from "./detect.mjs";

export { Usage };

export const PARENT_MARKER = "<!-- pr-open parent: ";
const MARKER_RE = /^<!-- pr-open parent: (\S+) -->$/m;

/** The parent branch a stacked PR body names, or null. pr-land (#40) reads this. */
export const parentOf = (body) => MARKER_RE.exec(body)?.[1] ?? null;

// Drop the `## Tests` section, up to the next `## ` heading; headings inside a ``` or ~~~ fence do not count.
function dropTests(body) {
  let fence = false, skip = false;
  return body.split("\n").filter((l) => {
    if (/^ {0,3}(?:`{3,}|~{3,})/.test(l)) fence = !fence;
    else if (!fence && /^## /.test(l)) skip = /^## Tests\b/.test(l);
    return !skip;
  }).join("\n");
}

export function buildBody({ body, record, parent = null, parentPr = null }) {
  const c = record.counts;
  const line = `\`${record.command}\` at ${record.sha.slice(0, 7)}: ${c ? `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped.` : "counts not found in the output."}`;
  let out = dropTests(body).replace(new RegExp(MARKER_RE.source, "gm"), "").trimEnd();
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
  const r = spawnSync(process.env.PR_OPEN_SECRET_SCAN || "secret-scan", [], { input: text, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error?.code === "ENOENT") return scanOutbound(text).hits;
  if (r.error) return [`secret-scan: ${r.error.message}`];
  return r.status === 0 ? [] : [String(r.stderr || "secret-scan: hit").trim()];
}

/** The base and its fresh remote ref; no base means the default branch from gh. check and open share it. */
export function resolveBase(dir, base) {
  const def = JSON.parse(gh(dir, ["repo", "view", "--json", "defaultBranchRef"])).defaultBranchRef.name;
  base ??= def;
  if (base.startsWith("-")) throw new Usage(`bad base: ${base}`);
  // An explicit refspec: a single-branch clone would only fill FETCH_HEAD.
  try { git(dir, "fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`); } catch (e) {
    const msg = String(e.stderr || e.message).trim();
    if (/couldn't find remote ref/i.test(msg)) throw new Usage(`origin has no branch ${base}`);
    throw new Error(`git fetch origin ${base} failed: ${msg}`);
  }
  return { base, def, ref: `origin/${base}` };
}

export async function openPr(dir, { title, bodyFile, base: wanted, draft = false }) {
  if (!title) throw new Usage("--title is required");
  let body;
  try { body = readFileSync(bodyFile, "utf8"); } catch (e) { throw new Usage(`cannot read the body file: ${e.message}`); }
  const branch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  const { base, def, ref } = resolveBase(dir, wanted);
  if (branch === "HEAD" || branch === base) throw new Usage(`check out the branch to open (now on ${branch})`);
  // A stack is a base with an open PR of its own; any other base (develop, release/x) is a plain base.
  const parentPr = base === def ? null : openPrOf(dir, base);
  const parent = parentPr ? base : null;
  const warnings = base !== def && !parentPr ? [`${base} has no open PR: opened as a plain base, no parent marker`] : [];

  const existing = openPrOf(dir, branch);
  if (existing) return { url: existing.url, number: existing.number, base, parent, warnings: ["a PR is already open"] };

  const sha = git(dir, "rev-parse", "HEAD");
  const record = readRecord(dir, sha);
  if (!record) throw new Blocked(`no test run for ${sha.slice(0, 7)}: run pr-open test`);
  if (record.exit !== 0 || record.counts?.failed > 0) throw new Blocked(`tests failed at ${sha.slice(0, 7)}`, record);
  if (!record.counts) warnings.push("counts not found in the test output");

  // Checks and scans see the body as it will be posted, and the commits up to the tested sha.
  const final = buildBody({ body, record, parent, parentPr: parentPr?.number });
  const check = checkBranch(dir, ref, { title, body: final, allow: readOverride(dir).allow ?? [], head: sha });
  if (!check.ok) throw new Blocked("unsigned commits or AI mentions", check);

  // Every commit's patch and message is pushed, not only the net diff.
  const hits = secretHits(`${git(dir, "log", "-p", "--cc", "--no-ext-diff", "--no-textconv", "--format=%B", `${ref}..${sha}`)}\n${title}\n${final}`);
  if (hits.length) throw new Blocked("the secret scan found a hit", { hits });

  if (!/#\d+/.test(body)) warnings.push("no linked issue");
  const file = join(git(dir, "rev-parse", "--absolute-git-dir"), "pr-open", `body-${sha}.md`);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, final);

  if (git(dir, "rev-parse", "HEAD") !== sha) throw new Blocked(`the branch moved from ${sha.slice(0, 7)} while pr-open ran: run pr-open test again`);
  // No PR is open (checked above), so a rewrite before the first PR may replace the pushed branch.
  git(dir, "push", "-q", "-u", "--force-with-lease", "--force-if-includes", "origin", "HEAD");
  const url = gh(dir, ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body-file", file, ...(draft ? ["--draft"] : [])]).trim().split("\n").at(-1);
  const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  return { url, number, base, parent, warnings };
}
