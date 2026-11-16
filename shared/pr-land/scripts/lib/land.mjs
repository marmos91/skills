// Land one converged PR: check the live state, squash-merge through merge-async, retarget the stacked children,
// delete the branch, rebase the children, tick the tracking issue, close fixed issues and clean up locally.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoArgs, scanOutbound } from "../../../pr-review/scripts/lib/secrets.mjs";
import { threads } from "../../../pr-review/scripts/lib/github.mjs";
import { waitingQuestions } from "../../../pr-review/scripts/lib/questions.mjs";
import { readSummaryMarker, stateRoot, writeAtomic } from "../../../pr-review/scripts/lib/state.mjs";
import { aiMentions } from "../../../pr-open/scripts/lib/check.mjs";
import { Blocked, Usage } from "../../../pr-open/scripts/lib/counts.mjs";
import { readOverride } from "../../../pr-open/scripts/lib/detect.mjs";
import { parentOf, pushRepos } from "../../../pr-open/scripts/lib/open.mjs";

export { Blocked, Usage };
export const STEPS = ["check", "merge", "retarget children", "delete branch", "rebase children", "issues", "local cleanup"];
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

const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i; // https://host[:port]/path, ssh://git@host[:port]/path
const SCP_FORM = /^(?:[^@/]*@)?([^/:]+):(.+)$/; // git@host:path
const GITHUB_HOSTS = ["github.com", "ssh.github.com"]; // ssh.github.com: SSH over port 443
/** owner/repo (lower case) of a remote URL on host (github.com, or the Enterprise host gh uses), or null for any other host, a local path or a longer path. */
export function repoOfUrl(url, host = "github.com") {
  const m = URL_FORM.exec(url) ?? (url.includes("://") ? null : SCP_FORM.exec(url));
  const hosts = host.toLowerCase() === "github.com" ? GITHUB_HOSTS : [host.toLowerCase()];
  if (!m || !hosts.includes(m[1].toLowerCase())) return null;
  const path = m[2].replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return /^[\w.-]+\/[\w.-]+$/.test(path) ? path.toLowerCase() : null;
}
/** The git remote whose URL is repo on host: fetches and pushes go where gh merges. */
function remoteOf(dir, repo, host) {
  let lines = [];
  try { lines = git(dir, "config", "--get-regexp", "^remote\\..*\\.url$").split("\n"); } catch { /* no remotes */ }
  const hit = lines.map((l) => l.split(" ")).find(([, url]) => repoOfUrl(url ?? "", host) === repo.toLowerCase());
  if (!hit) throw new Blocked(`no git remote of this clone points at ${host}/${repo}`);
  return hit[0].slice("remote.".length, -".url".length);
}

// secret-scan (#39) when installed, else the pr-review scan; the same contract as pr-open.
// repos: the PR's repo and what a push to its remote reaches; the private-repos opt-out needs every one listed.
function secretHits(text, repos = [null]) {
  const r = spawnSync(process.env.PR_LAND_SECRET_SCAN || "secret-scan", repoArgs(repos), { input: text, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error?.code === "ENOENT") return scanOutbound(text, { repo: repos }).hits;
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
  for (const r of pr.reviews ?? []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.author?.login, r);
  const others = [...latest].filter(([who, r]) => r.state === "CHANGES_REQUESTED" && who !== me).map(([who]) => who);
  if (others.length || (pr.reviewDecision === "CHANGES_REQUESTED" && latest.get(me)?.state !== "CHANGES_REQUESTED")) {
    why.push(`changes requested by ${others.join(", ") || "a reviewer"}`);
    return why;
  }
  // An approval of the head stands in for pr-review, unless pr-review's newest full review is on the head: then its counts decide.
  const approved = pr.reviewDecision === "APPROVED" && [...latest.values()].some((r) => r.state === "APPROVED" && r.commit?.oid === pr.headRefOid);
  if (!approved || newestFull(pr, me)?.sha === pr.headRefOid) why.push(...reviewGaps(pr, me, localQuestions));
  return why;
}

// The newest full pr-review review, posted by me (anyone can paste a marker), must be on the head with no open must,
// no question waiting and no lens or seat missing. Follow-ups and reviews of older pr-review versions carry no counts.
const newestFull = (pr, me) => readSummaryMarker((pr.reviews ?? []).filter((r) => r.author?.login === me && readSummaryMarker(r.body)).at(-1)?.body);
function reviewGaps(pr, me, localQuestions) {
  const last = newestFull(pr, me);
  if (!last) return [`no approval of the head and no full pr-review review by ${me}`];
  const { runId, sha, must, questions, gaps } = last;
  if (sha !== pr.headRefOid) return [`the newest pr-review review is on ${sha.slice(0, 7)}, the head is ${pr.headRefOid.slice(0, 7)}`];
  // The marker count is frozen at posting; the local queue knows what the maintainer answered since. Both count questions waiting for an answer.
  const q = localQuestions(runId) ?? questions;
  const out = [];
  if (must) out.push(`the newest pr-review review has ${must} open must`);
  if (q) out.push(`${q} pr-review question${q === 1 ? "" : "s"} not settled`);
  if (gaps) out.push(`the newest pr-review review is incomplete: ${gaps} lens${gaps === 1 ? "" : "es"} or seat${gaps === 1 ? "" : "s"} missing (a follow-up on a review without saved counts, or a failed seat): run a full pr-review on the head`);
  return out;
}

const LIMIT = 1000;
/** Open PRs whose base is this branch (a base is always a branch of this repo). More than LIMIT: blocked, never a partial list. */
function prsOn(dir, branch) {
  const prs = ghJson(dir, ["pr", "list", "--base", branch, "--state", "open", "--limit", String(LIMIT + 1), "--json", "number,headRefName,headRefOid,isCrossRepository,body"]);
  if (prs.length > LIMIT) throw new Blocked(`more than ${LIMIT} open PRs are based on ${branch}: retarget them by hand`);
  return prs;
}

// The children of a merge, kept until they are rebased: a resume touches only these, never other PRs on the base.
const recordFile = (repo, n) => join(stateRoot(repo), "land", `${n}.json`);
function readRecord(repo, n) {
  try { return JSON.parse(readFileSync(recordFile(repo, n), "utf8")); } catch { return null; }
}
function saveRecord(repo, n, rec) {
  mkdirSync(join(stateRoot(repo), "land"), { recursive: true });
  writeAtomic(recordFile(repo, n), JSON.stringify(rec));
}

/** Squash title and message: the PR title with (#N), the body without HTML comments. Blocked on a bad title, an AI mention or a secret. */
export function squash(pr, allow = [], repos = [null]) {
  const title = `${pr.title.replace(/\s*\(#\d+\)\s*$/, "")} (#${pr.number})`;
  const message = (pr.body ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!/^[a-z]+(\([\w./-]+\))?!?: \S/.test(title) || title.length > 72) throw new Blocked(`retitle the PR as a concise conventional title (72 chars max): ${title}`);
  const ai = aiMentions(`${title}\n${message}`, allow); // the allow list of .pr-open.json, as pr-open checks
  if (ai.length) throw new Blocked("AI or tool mentions in the squash title or message", { ai });
  const hits = secretHits(`${title}\n${message}`, repos);
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
  const done = [], notes = [], retargeted = [], managed = [], rebased = [], skipped = [];
  let pr, children = [], msg, remote, merged = false;
  const step = async (name, fn) => {
    try { const r = await fn(); done.push(name); return r; } catch (e) {
      e.done = done; e.notes = notes;
      // Past the merge: say where each child is, so the user can fix it or rerun pr-land on this PR to resume.
      if (done.includes("merge") && children.length) {
        const pending = children.filter((c) => !rebased.includes(c.number) && !skipped.includes(c.number)).map((c) => c.number);
        e.detail = { ...(e.detail ?? {}), retargeted, githubRetargeted: managed, rebased, rebasePending: pending };
        notes.push(`#${n} is merged: run pr-land ${n} again to resume with the children`);
      }
      throw e;
    }
  };
  const { nameWithOwner: repo, url, defaultBranchRef: { name: def } } = ghJson(dir, ["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef"]);
  const host = new URL(url).hostname;
  if (host !== "github.com") process.env.GH_HOST = host; // gh api defaults to github.com; pr commands follow the remote
  await step("check", async () => {
    pr = ghJson(dir, ["pr", "view", String(n), "--json", PR_FIELDS]);
    remote = remoteOf(dir, repo, host);
    // A rerun after a stop past the merge resumes: the children still on the head, and the ones this merge recorded and
    // did not rebase yet. Nothing else: a PR on the base is someone else's work.
    if (pr.state === "MERGED") {
      merged = true; msg = { title: `${pr.title.replace(/\s*\(#\d+\)\s*$/, "")} (#${n})` };
      if (pr.isCrossRepository) return;
      const rec = readRecord(repo, n), onHead = prsOn(dir, pr.headRefName);
      const left = (rec?.children ?? []).filter((k) => !rec.rebased.includes(k) && !onHead.some((c) => c.number === k));
      const now = left.map((k) => ghJson(dir, ["pr", "view", String(k), "--json", "number,state,baseRefName,headRefName,headRefOid,isCrossRepository,body"]));
      for (const c of now.filter((c) => c.state !== "OPEN" || c.baseRefName !== pr.baseRefName)) notes.push(`#${c.number} is ${c.state.toLowerCase()} on ${c.baseRefName}: left alone`);
      children = [...onHead, ...now.filter((c) => c.state === "OPEN" && c.baseRefName === pr.baseRefName).map((c) => ({ ...c, onBase: true }))];
      return;
    }
    const st = stateRoot(repo);
    // The same set the marker counts: questions waiting on a person or on a run to apply the answer.
    const localQuestions = (runId) => (existsSync(join(st, "pr", String(n), "runs", runId)) ? waitingQuestions(st, n).length : null);
    const why = notReady(pr, (await threads(repo, n)).filter((t) => !t.isResolved).length, ghJson(dir, ["api", "user"]).login, localQuestions);
    if (why.length) throw new Blocked(`#${n} is not ready`, { why });
    msg = squash(pr, readOverride(dir).allow ?? [], [repo, ...pushRepos(dir, remote)]);
    // A base is always a branch of this repo, so a fork PR's head is nobody's base.
    children = pr.isCrossRepository ? [] : prsOn(dir, pr.headRefName);
  });
  const { headRefName: head, baseRefName: base, headRefOid: sha } = pr;
  if (dryRun) return { pr: n, dryRun: true, ...msg, base, children: children.map((c) => c.number), plan: STEPS.slice(merged ? 2 : 1) };

  // Merge first: a failed merge leaves every child where it was. The branch is deleted only after the retarget below.
  await step("merge", async () => {
    if (merged) {
      notes.push(`#${n} was already merged: resumed after the merge`);
      // a resume in another clone: the merged head is still at refs/pull/N/head
      if (children.length && !gitOk(dir, "cat-file", "-e", `${sha}^{commit}`)) git(dir, "fetch", "-q", remote, `+refs/pull/${n}/head:refs/pr-land/${n}`);
    } else if (children.length) git(dir, "fetch", "-q", remote, `+refs/heads/${head}:refs/pr-land/${n}`); // the rebase below needs it after the branch is gone
    if (children.length) {
      const rec = (merged && readRecord(repo, n)) || { children: [], rebased: [] };
      saveRecord(repo, n, { ...rec, children: [...new Set([...rec.children, ...children.map((c) => c.number)])] });
    }
    if (!merged) await mergeAsync(dir, repo, pr, msg);
  });

  await step("retarget children", () => {
    for (const c of children) {
      if (c.onBase) { retargeted.push(c.number); continue; }
      const r = ghRaw(dir, ["pr", "edit", String(c.number), "--base", base]);
      if (r.status === 0) { retargeted.push(c.number); continue; }
      if (/part of a stack/i.test(r.stderr)) managed.push(c.number); // GitHub retargets these itself after the merge
      else throw new Error(`gh pr edit ${c.number} --base ${base} failed: ${String(r.stderr).trim()}`);
    }
  });

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
    // Deleting a base closes the PRs on it: confirm none is left (a PR opened since the check, or one the list missed).
    const left = prsOn(dir, head);
    if (left.length) throw new Blocked(`${left.map((c) => `#${c.number}`).join(" ")} still based on ${head}: the branch was kept`);
    const ref = `repos/${repo}/git/refs/heads/${head.split("/").map(encodeURIComponent).join("/")}`;
    const now = ghRaw(dir, ["api", ref.replace("/git/refs/", "/git/ref/")]);
    if (now.status !== 0) {
      if (/Not Found|HTTP 404/i.test(now.stdout + now.stderr)) return notes.push(`${head} is already gone`); // the repo deletes merged branches itself
      throw new Error(`reading ${head} failed: ${String(now.stderr).trim()}`);
    }
    const at = JSON.parse(now.stdout).object?.sha;
    if (at !== sha) return notes.push(`${head} moved to ${String(at).slice(0, 7)} after the merge: kept`);
    const r = ghRaw(dir, ["api", "-X", "DELETE", ref]);
    if (r.status !== 0 && !/Reference does not exist/i.test(r.stdout + r.stderr)) throw new Error(`deleting ${head} failed: ${String(r.stderr).trim()}`);
  });

  await step("rebase children", () => {
    if (!children.length) return;
    git(dir, "fetch", "-q", remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`);
    // Merged by a merge commit or a fast-forward: the children already sit on the base, and a rebase would rewrite them.
    if (gitOk(dir, "merge-base", "--is-ancestor", sha, `refs/remotes/${remote}/${base}`)) {
      notes.push(`${base} already holds ${sha.slice(0, 7)}: no child rebased`);
      children.forEach((c) => skipped.push(c.number));
    } else for (const c of children) {
      if (c.isCrossRepository) { skipped.push(c.number); notes.push(`#${c.number} is on a fork: not rebased`); continue; }
      git(dir, "fetch", "-q", remote, `+refs/heads/${c.headRefName}:refs/remotes/${remote}/${c.headRefName}`);
      // A force-push rewrites someone's branch: only for a PR that pr-open opened as stacked on this head, or one whose history holds it.
      if (parentOf(c.body ?? "") !== head && !gitOk(dir, "merge-base", "--is-ancestor", sha, `refs/remotes/${remote}/${c.headRefName}`)) {
        skipped.push(c.number); notes.push(`#${c.number} is not stacked on ${head} (no pr-open parent marker, ${sha.slice(0, 7)} not in its history): retargeted, not rebased`); continue;
      }
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
        const rec = readRecord(repo, n);
        if (rec) saveRecord(repo, n, { ...rec, rebased: [...rec.rebased, c.number] });
      } finally {
        gitOk(dir, "worktree", "remove", "--force", wt);
        rmSync(wt, { recursive: true, force: true });
      }
    }
    gitOk(dir, "update-ref", "-d", `refs/pr-land/${n}`);
    rmSync(recordFile(repo, n), { force: true });
  });

  // Issues first: a worktree that cannot be removed must not keep the tracking issue unticked.
  const ticked = [], closed = [];
  await step("issues", () => {
    // Only issues of this repo: "Fixes other/repo#5" must not close our #5.
    const fixes = (pr.closingIssuesReferences ?? []).filter((i) => `${i.repository?.owner?.login}/${i.repository?.name}`.toLowerCase() === repo.toLowerCase()).map((i) => i.number);
    // A #N that is no issue (a colour, a deleted issue) is noted and skipped: it must not stop the step.
    const issue = (k) => {
      const r = ghRaw(dir, ["api", `repos/${repo}/issues/${k}`]);
      if (r.status === 0) return JSON.parse(r.stdout);
      notes.push(`#${k} could not be read: skipped`);
      return null;
    };
    const fixed = fixes.map(issue).filter(Boolean);
    // Tracking issues: the ones the PR body or a fixed issue links to.
    const refs = new Set([pr.body ?? "", ...fixed.map((i) => i.body ?? "")].flatMap((t) => [...t.matchAll(/(?<![\w/.-])#(\d+)\b/g)].map((m) => Number(m[1]))));
    const mine = new RegExp(`(?<![\\w/.-])#(?:${[n, ...fixes].join("|")})(?!\\d)`); // other/repo#N is not ours
    for (const k of refs) {
      if (k === n || fixes.includes(k)) continue;
      const t = k > 0 ? issue(k) : null;
      if (!t || t.pull_request || t.state !== "open") continue;
      const body = (t.body ?? "").replace(/^(\s*[-*] )\[ \](.*)$/gm, (line, pre, rest) => (mine.test(rest) ? `${pre}[x]${rest}${new RegExp(`#${n}(?!\\d)`).test(rest) ? "" : ` (#${n})`}` : line));
      if (body === (t.body ?? "")) continue;
      gh(dir, ["api", "-X", "PATCH", `repos/${repo}/issues/${k}`, "-f", `body=${body}`]);
      ticked.push(k);
    }
    // GitHub closes them only on a merge into the default branch.
    if (base !== def && fixes.length) return notes.push(`merged into ${base}, not ${def}: issues ${fixes.map((f) => `#${f}`).join(" ")} left open`);
    for (const i of fixed.filter((i) => i.state === "open")) {
      if (issue(i.number)?.state !== "open") continue; // GitHub closed it after our first read
      gh(dir, ["api", "-X", "PATCH", `repos/${repo}/issues/${i.number}`, "-f", "state=closed", "-f", "state_reason=completed"]);
      closed.push(i.number);
    }
  });
  // Only this repo's head branch, and only at the merged head: anything else is someone's other work, reported and kept.
  await step("local cleanup", () => {
    if (pr.isCrossRepository) return; // a local branch of the same name is not the fork's
    if (!gitOk(dir, "show-ref", "-q", "--verify", `refs/heads/${head}`)) return;
    if (git(dir, "rev-parse", `refs/heads/${head}`) !== sha) return notes.push(`local ${head} differs from the merged head: kept`);
    const top = git(dir, "rev-parse", "--show-toplevel");
    const trees = git(dir, "worktree", "list", "--porcelain").split("\n\n").map((b) => ({ path: /^worktree (.+)$/m.exec(b)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(b)?.[1] }));
    const wt = trees.find((t) => t.branch === head);
    if (wt && wt.path === top) return notes.push(`${head} is checked out here: switch away, then delete it`);
    if (wt) {
      // Untracked and ignored files (.env, local notes) would go with the worktree: keep it.
      if (git(wt.path, "status", "--porcelain", "--ignored")) return notes.push(`the worktree ${wt.path} has changed, untracked or ignored files: kept`);
      git(dir, "worktree", "remove", wt.path);
    }
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
