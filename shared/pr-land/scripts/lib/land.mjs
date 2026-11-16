// Land one converged PR: check the live state, retarget stacked children, squash-merge through merge-async,
// delete the branch, rebase the children, clean up locally, tick the tracking issue and close fixed issues.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOutbound } from "../../../pr-review/scripts/lib/secrets.mjs";
import { threads } from "../../../pr-review/scripts/lib/github.mjs";
import { openQuestions, pendingAnswers } from "../../../pr-review/scripts/lib/questions.mjs";
import { readSummaryMarker, stateRoot } from "../../../pr-review/scripts/lib/state.mjs";
import { aiMentions } from "../../../pr-open/scripts/lib/check.mjs";
import { Blocked, Usage } from "../../../pr-open/scripts/lib/counts.mjs";

export { Blocked, Usage };
export const STEPS = ["check", "retarget children", "merge", "delete branch", "rebase children", "issues", "local cleanup"];
const PR_FIELDS = "number,title,body,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,reviewDecision,statusCheckRollup,reviews,closingIssuesReferences,isCrossRepository";
const POLL_MS = () => Number(process.env.PR_LAND_POLL_MS ?? 2000);
const POLLS = 150; // about 5 minutes at the default interval
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (dir, ...args) => spawnSync("git", args, { cwd: dir, stdio: "ignore" }).status === 0;
function ghRaw(dir, args, input) {
  const r = spawnSync(process.env.GH_BIN || "gh", args, { cwd: dir, encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`gh failed to start: ${r.error.message}`);
  return r;
}
function gh(dir, args, input) {
  const r = ghRaw(dir, args, input);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${String(r.stderr).trim()}`);
  return r.stdout;
}
const ghJson = (dir, args) => JSON.parse(gh(dir, args) || "null");

const GH_URL = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
/** The git remote whose URL is repo on GitHub: fetches and pushes go where gh merges. */
function remoteOf(dir, repo) {
  let lines = [];
  try { lines = git(dir, "config", "--get-regexp", "^remote\\..*\\.url$").split("\n"); } catch { /* no remotes */ }
  const hit = lines.map((l) => l.split(" ")).find(([, url]) => GH_URL.exec(url ?? "")?.[1]?.toLowerCase() === repo.toLowerCase());
  if (!hit) throw new Blocked(`no git remote of this clone points at github.com/${repo}`);
  return hit[0].slice("remote.".length, -".url".length);
}

// secret-scan (#39) when installed, else the pr-review scan; the same contract as pr-open.
function secretHits(text) {
  const r = spawnSync(process.env.PR_LAND_SECRET_SCAN || "secret-scan", [], { input: text, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error?.code === "ENOENT") return scanOutbound(text).hits;
  if (r.error) return [`secret-scan: ${r.error.message}`];
  return r.status === 0 ? [] : [String(r.stderr || "secret-scan: hit").trim()];
}

const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/**
 * Why a PR (gh pr view JSON) is not ready to merge; [] when ready. unresolved: count of unresolved review threads;
 * me: the login pr-review posts as; localQuestions(runId): unsettled questions in pr-review's local state, or null when that run is not on this machine.
 */
export function notReady(pr, unresolved, me, localQuestions = () => null) {
  const why = [];
  if (pr.state !== "OPEN") why.push(`the PR is ${pr.state.toLowerCase()}`);
  if (pr.isDraft) why.push("the PR is a draft");
  if (pr.mergeable !== "MERGEABLE") why.push(`mergeable is ${pr.mergeable}`);
  for (const c of pr.statusCheckRollup ?? []) {
    const name = c.name ?? c.context, done = c.__typename === "StatusContext" ? c.state !== "PENDING" && c.state !== "EXPECTED" : c.status === "COMPLETED";
    if (!done) why.push(`check ${name} is pending`);
    else if (!GREEN.has(c.conclusion ?? c.state)) why.push(`check ${name} is ${String(c.conclusion ?? c.state).toLowerCase()}`);
  }
  if (unresolved) why.push(`${unresolved} review thread${unresolved === 1 ? " is" : "s are"} unresolved`);
  // Each reviewer's newest approve, request or dismissal is what GitHub counts. pr-review's own request is judged by its marker below.
  const latest = new Map();
  for (const r of pr.reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.author?.login, r.state);
  const others = [...latest].filter(([who, st]) => st === "CHANGES_REQUESTED" && who !== me).map(([who]) => who);
  if (others.length || (pr.reviewDecision === "CHANGES_REQUESTED" && latest.get(me) !== "CHANGES_REQUESTED")) why.push(`changes requested by ${others.join(", ") || "a reviewer"}`);
  else if (pr.reviewDecision !== "APPROVED") why.push(...reviewGaps(pr, me, localQuestions));
  return why;
}

// The newest full pr-review review, posted by me (anyone can paste a marker), must be on the head with no open must,
// no question waiting and no lens or seat missing. Follow-ups and reviews of older pr-review versions carry no counts.
function reviewGaps(pr, me, localQuestions) {
  const last = (pr.reviews ?? []).filter((r) => r.author?.login === me && readSummaryMarker(r.body)).at(-1);
  if (!last) return [`no approval and no full pr-review review by ${me}`];
  const { runId, sha, must, questions, gaps } = readSummaryMarker(last.body);
  if (sha !== pr.headRefOid) return [`the newest pr-review review is on ${sha.slice(0, 7)}, the head is ${pr.headRefOid.slice(0, 7)}`];
  // The marker count is frozen at posting; the local queue knows what the maintainer answered since.
  const q = localQuestions(runId) ?? questions;
  const out = [];
  if (must) out.push(`the newest pr-review review has ${must} open must`);
  if (q) out.push(`${q} pr-review question${q === 1 ? "" : "s"} not settled`);
  if (gaps) out.push(`the newest pr-review review is incomplete: ${gaps} lens${gaps === 1 ? "" : "es"} or seat${gaps === 1 ? "" : "s"} missing`);
  return out;
}

/** Squash title and message: the PR title with (#N), the body without HTML comments. Blocked on a bad title, an AI mention or a secret. */
export function squash(pr) {
  const title = `${pr.title.replace(/\s*\(#\d+\)\s*$/, "")} (#${pr.number})`;
  const message = (pr.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!/^[a-z]+(\([\w./-]+\))?!?: \S/.test(title) || title.length > 72) throw new Blocked(`retitle the PR as a concise conventional title (72 chars max): ${title}`);
  const ai = aiMentions(`${title}\n${message}`);
  if (ai.length) throw new Blocked("AI or tool mentions in the squash title or message", { ai });
  const hits = secretHits(`${title}\n${message}`);
  if (hits.length) throw new Blocked("the secret scan found a hit in the squash title or message", { hits });
  return { title, message };
}

async function mergeAsync(dir, repo, pr, { title, message }) {
  const path = `repos/${repo}/pulls/${pr.number}/merge-async`;
  // sha pins the head checked above: a push after the check cancels the merge.
  const r = ghRaw(dir, ["api", "-X", "PUT", path, "-f", "merge_method=squash", "-f", `sha=${pr.headRefOid}`, "-f", `commit_title=${title}`, "-f", `commit_message=${message}`, "-f", "merge_action=direct_merge"]);
  let res;
  try { res = JSON.parse(r.stdout); } catch { throw new Error(`merge-async failed: ${String(r.stderr).trim()}`); }
  // 409 means a merge is already pending: its uuid is in the details, so poll it like ours.
  if (r.status !== 0 && !(res?.status === "pending" && res.details?.uuid)) throw new Error(`merge-async failed: ${res?.message ?? res?.details?.message ?? String(r.stderr).trim()}`);
  for (let i = 0; res.status === "pending"; i++) {
    if (i >= POLLS) throw new Error(`the merge is still pending (uuid ${res.details.uuid}): check the PR before running again`);
    await sleep(POLL_MS());
    res = ghJson(dir, ["api", `${path}/${res.details.uuid}`]);
  }
  if (res.status !== "merged") throw new Error(`merge ${res.status}: ${res.details?.message ?? "no message"}`);
}

/** Land PR n. Returns what was done; throws with err.done (step names) when a step fails. dryRun stops after the checks. */
export async function land(dir, n, { dryRun = false } = {}) {
  const done = [], notes = [];
  const step = async (name, fn) => {
    try { const r = await fn(); done.push(name); return r; } catch (e) { e.done = done; e.notes = notes; throw e; }
  };
  const { nameWithOwner: repo, defaultBranchRef: { name: def } } = ghJson(dir, ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
  let pr, children, msg, remote;
  await step("check", async () => {
    pr = ghJson(dir, ["pr", "view", String(n), "--json", PR_FIELDS]);
    remote = remoteOf(dir, repo);
    const st = stateRoot(repo);
    const localQuestions = (runId) => (existsSync(join(st, "pr", String(n), "runs", runId))
      ? [...openQuestions(st), ...pendingAnswers(st)].filter((q) => Number(q.pr) === n).length : null);
    const why = notReady(pr, (await threads(repo, n)).filter((t) => !t.isResolved).length, ghJson(dir, ["api", "user"]).login, localQuestions);
    if (why.length) throw new Blocked(`#${n} is not ready`, { why });
    msg = squash(pr);
    // A base is always a branch of this repo, so a fork PR's head is nobody's base.
    children = pr.isCrossRepository ? [] : ghJson(dir, ["pr", "list", "--base", pr.headRefName, "--state", "open", "--json", "number,headRefName,headRefOid,isCrossRepository"]);
  });
  const { headRefName: head, baseRefName: base, headRefOid: sha } = pr;
  if (dryRun) return { pr: n, dryRun: true, ...msg, base, children: children.map((c) => c.number), plan: STEPS.slice(1) };

  // Retarget before anything is deleted: deleting a base closes the PRs stacked on it.
  const managed = [];
  await step("retarget children", () => {
    // Keep the merged head locally: the rebase below needs it after the branch is gone.
    if (children.length) git(dir, "fetch", "-q", remote, `+refs/heads/${head}:refs/pr-land/${n}`);
    for (const c of children) {
      const r = ghRaw(dir, ["pr", "edit", String(c.number), "--base", base]);
      if (r.status === 0) continue;
      if (/part of a stack/i.test(r.stderr)) managed.push(c.number); // GitHub retargets these itself after the merge
      else throw new Error(`gh pr edit ${c.number} --base ${base} failed: ${String(r.stderr).trim()}`);
    }
  });
  await step("merge", () => mergeAsync(dir, repo, pr, msg));

  await step("delete branch", async () => {
    for (const c of managed) {
      for (let i = 0; ; i++) {
        const v = ghJson(dir, ["pr", "view", String(c), "--json", "baseRefName,state"]);
        if (v.state === "OPEN" && v.baseRefName === base) break;
        if (i >= POLLS || v.state !== "OPEN") throw new Error(`#${c} is ${v.state.toLowerCase()} on ${v.baseRefName}, not open on ${base}: the branch ${head} was kept`);
        await sleep(POLL_MS());
      }
    }
    if (pr.isCrossRepository) return notes.push(`${head} is on a fork: not deleted`);
    const r = ghRaw(dir, ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${head}`]);
    if (r.status !== 0 && !/Reference does not exist/i.test(r.stdout + r.stderr)) throw new Error(`deleting ${head} failed: ${String(r.stderr).trim()}`);
  });

  const rebased = [];
  await step("rebase children", () => {
    if (!children.length) return;
    git(dir, "fetch", "-q", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`);
    for (const c of children) {
      if (c.isCrossRepository) { notes.push(`#${c.number} is on a fork: not rebased`); continue; }
      git(dir, "fetch", "-q", remote, `+refs/heads/${c.headRefName}:refs/remotes/${remote}/${c.headRefName}`);
      const wt = mkdtempSync(join(tmpdir(), "pr-land-"));
      try {
        git(dir, "worktree", "add", "-q", "--detach", wt, `refs/remotes/${remote}/${c.headRefName}`);
        // Only the child's own commits move: those after the merged head.
        if (!gitOk(wt, "rebase", "-q", "-S", "--onto", `refs/remotes/${remote}/${base}`, sha)) {
          gitOk(wt, "rebase", "--abort");
          throw new Blocked(`#${c.number} (${c.headRefName}) conflicts with ${base}: rebase it by hand`);
        }
        git(wt, "push", "-q", `--force-with-lease=refs/heads/${c.headRefName}:${c.headRefOid}`, remote, `HEAD:refs/heads/${c.headRefName}`);
        rebased.push(c.number);
      } finally {
        gitOk(dir, "worktree", "remove", "--force", wt);
        rmSync(wt, { recursive: true, force: true });
      }
    }
    gitOk(dir, "update-ref", "-d", `refs/pr-land/${n}`);
  });

  // Issues first: a worktree that cannot be removed must not keep the tracking issue unticked.
  const ticked = [], closed = [];
  await step("issues", () => {
    // Only issues of this repo: "Fixes other/repo#5" must not close our #5.
    const fixes = (pr.closingIssuesReferences ?? []).filter((i) => `${i.repository?.owner?.login}/${i.repository?.name}`.toLowerCase() === repo.toLowerCase()).map((i) => i.number);
    const issue = (k) => ghJson(dir, ["api", `repos/${repo}/issues/${k}`]);
    const fixed = fixes.map(issue);
    // Tracking issues: the ones the PR body or a fixed issue links to.
    const refs = new Set([pr.body ?? "", ...fixed.map((i) => i.body ?? "")].flatMap((t) => [...t.matchAll(/(?<![\w/.-])#(\d+)\b/g)].map((m) => Number(m[1]))));
    const mine = new RegExp(`(?<![\\w/.-])#(?:${[n, ...fixes].join("|")})(?!\\d)`); // other/repo#N is not ours
    for (const k of refs) {
      if (k === n || fixes.includes(k)) continue;
      const t = issue(k);
      if (t.pull_request || t.state !== "open") continue;
      const body = (t.body ?? "").replace(/^(\s*[-*] )\[ \](.*)$/gm, (line, pre, rest) => (mine.test(rest) ? `${pre}[x]${rest}${new RegExp(`#${n}(?!\\d)`).test(rest) ? "" : ` (#${n})`}` : line));
      if (body === (t.body ?? "")) continue;
      gh(dir, ["api", "-X", "PATCH", `repos/${repo}/issues/${k}`, "-f", `body=${body}`]);
      ticked.push(k);
    }
    // GitHub closes them only on a merge into the default branch.
    if (base !== def && fixes.length) return notes.push(`merged into ${base}, not ${def}: issues ${fixes.map((f) => `#${f}`).join(" ")} left open`);
    for (const i of fixed.filter((i) => i.state === "open")) {
      if (issue(i.number).state !== "open") continue; // GitHub closed it after our first read
      gh(dir, ["api", "-X", "PATCH", `repos/${repo}/issues/${i.number}`, "-f", "state=closed", "-f", "state_reason=completed"]);
      closed.push(i.number);
    }
  });
  await step("local cleanup", () => {
    const top = git(dir, "rev-parse", "--show-toplevel");
    const trees = git(dir, "worktree", "list", "--porcelain").split("\n\n").map((b) => ({ path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] }));
    const wt = trees.find((t) => t.branch === head);
    if (wt && wt.path === top) return notes.push(`${head} is checked out here: switch away, then delete it`);
    if (wt) git(dir, "worktree", "remove", wt.path); // no --force: a dirty worktree stops here
    if (!gitOk(dir, "show-ref", "-q", "--verify", `refs/heads/${head}`)) return;
    // A local branch with commits the PR never had is kept: deleting it would lose them.
    if (git(dir, "rev-parse", `refs/heads/${head}`) !== sha) return notes.push(`local ${head} differs from the merged head: kept`);
    git(dir, "branch", "-q", "-D", head);
  });

  return { pr: n, title: msg.title, base, retargeted: children.map((c) => c.number), githubRetargeted: managed, rebased, ticked, closed, notes };
}

/** PR numbers in stack order: a PR whose base is the head of another listed same-repo PR comes after it. */
export function stackOrder(prs) {
  const left = [...prs], out = [];
  while (left.length) {
    const i = left.findIndex((p) => !left.some((q) => q !== p && !q.isCrossRepository && q.headRefName === p.baseRefName));
    if (i < 0) throw new Usage("the PRs form a cycle");
    out.push(left.splice(i, 1)[0].number);
  }
  return out;
}

/** Land several PRs in stack order, one at a time; the first failure stops the rest. */
export async function landAll(dir, numbers, opts) {
  const prs = numbers.map((n) => ghJson(dir, ["pr", "view", String(n), "--json", "number,headRefName,baseRefName,isCrossRepository"]));
  const landed = [];
  for (const n of stackOrder(prs)) {
    try { landed.push(await land(dir, n, opts)); } catch (e) { e.landed = landed; e.pr = n; throw e; }
  }
  return landed;
}
