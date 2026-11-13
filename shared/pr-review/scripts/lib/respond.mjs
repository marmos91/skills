// pr-respond: the steps of fixing review findings on your own PR. The agent edits the code; this module
// picks the threads, asks jev, posts the replies and resolves. Every function takes gh and jev for tests.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scanOutbound } from "./secrets.mjs";
import { prData } from "./prompts.mjs";
import { linkFix } from "./reply.mjs";
import { canDrive } from "./trust.mjs";
import { stateRoot, writeAtomic } from "./state.mjs";

export const Q = {
  correct: "This review finding is correct about the code at the PR head.",
  scope: "This review comment is about code that this PR adds or changes.",
  fixes: "The commit diff below fixes the case that the review comment describes.",
};

export class RoundCap extends Error {}
export class GitError extends Error {}

/**
 * The git reads of pr-respond. git(...args) -> { status, stdout, stderr } (spawnSync). A failed git throws
 * GitError: an empty diff would read as "the PR does not touch this file", a failed merge-base as "not pushed".
 */
export function gitReaders(git) {
  const ok = (o, what) => { if (o.status !== 0) throw new GitError(`${what}: ${String(o.stderr).trim()}`); return o.stdout; };
  const hasCommit = (sha) => git("cat-file", "-e", `${sha}^{commit}`).status === 0;
  return {
    show: (sha, path) => {
      if (!hasCommit(sha)) throw new GitError(`the PR head ${sha.slice(0, 7)} is not fetched; run git fetch`);
      const o = git("show", `${sha}:${path}`);
      return o.status === 0 ? o.stdout : null; // the head has no such file
    },
    diff: (sha) => ok(git("show", "--format=%H %s", sha), `cannot show ${sha.slice(0, 7)}`).slice(0, 40000),
    // base is the base sha GitHub reports, not a local ref that may be stale or named differently
    fileDiff: (base, head, path) => ok(git("diff", `${base}...${head}`, "--", path), `cannot diff against the PR base ${String(base).slice(0, 7)} (run git fetch)`),
    // merge-base exits 1 for "not an ancestor"; any other code is a git failure (an unfetched head), not an answer
    onHead: (sha, head) => {
      const o = git("merge-base", "--is-ancestor", sha, head);
      if (o.status === 1) return false;
      ok(o, `cannot check that ${sha.slice(0, 7)} is in the PR head (run git fetch)`);
      return true;
    },
  };
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const threadText = (t) => prData(JSON.stringify(t.comments.map((c) => ({ author: c.author, body: c.body })), null, 2), "the reviewers");

// Own file, not state.json: the loop and pr-review rewrite state.json whole, under a lock pr-respond does not take.
const file = (repo, n) => join(stateRoot(repo), "pr", String(n), "respond.json");
const load = (repo, n) => { const f = file(repo, n); return { heads: [], handled: {}, approved: {}, ...(existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {}) }; };
const save = (repo, n, s) => writeAtomic(file(repo, n), JSON.stringify(s, null, 2) + "\n");

// A page of 100 comments may miss the newest: such a thread is never "answered".
const whole = (t) => t.comments.length === (t.commentCount ?? t.comments.length);
// The comment we answered: the newest one by someone else (null on a council thread, which only we wrote).
const lastOther = (t, me) => t.comments.findLast((c) => c.author !== me)?.id ?? null;
// Open work: unresolved, and pr-respond did not handle its newest comment by someone else.
const handledNow = (t, me, handled) => whole(t) && t.id in handled && handled[t.id] === lastOther(t, me);
const open = (t, me, handled) => !t.isResolved && !handledNow(t, me, handled);
const markHandled = (repo, n, t, me) => { const s = load(repo, n); s.handled[t.id] = lastOther(t, me); save(repo, n, s); };

// The agent edits and runs code on what a thread says: every author must pass canDrive (trust.mjs), or be a
// review bot: a bot comment in a review thread is a finding on the diff (Copilot), not text relayed from others.
// An approval (`approve`) covers the comments up to the newest one when the user said yes, never later ones.
async function trusted(gh, repo, n, t, me) {
  const upTo = load(repo, n).approved[t.id] ?? -Infinity;
  const ok = canDrive(gh, repo, me);
  for (const a of new Set(t.comments.filter((c) => c.authorType !== "Bot" && !(c.id <= upTo)).map((c) => c.author))) {
    if (!(await ok(a))) return false;
  }
  return true;
}
const UNTRUSTED = "a comment in the thread is by an author without write access; ask the user, then run approve";

/** The user said yes to work on a thread with an untrusted author, as it reads now. -> { approved: true } */
export async function approve({ repo, n, threadId, gh }) {
  const t = await thread(gh, repo, n, threadId);
  const s = load(repo, n);
  s.approved[threadId] = Math.max(...t.comments.map((c) => c.id));
  save(repo, n, s);
  return { approved: true };
}

async function thread(gh, repo, n, id) {
  const t = (await gh.threads(repo, n)).find((x) => x.id === id);
  if (!t) throw new Error(`thread ${id} not found on ${repo}#${n}`);
  return t;
}

/**
 * The findings of one round. A round is one PR head: a call at a head not seen before counts a round,
 * and a round past config.respond.max_rounds throws RoundCap. -> { head, round, converged, findings }
 */
export async function findings({ repo, n, gh, config }) {
  const [me, pr, all] = [await gh.viewer(), await gh.pr(repo, n), await gh.threads(repo, n)];
  const st = load(repo, n);
  const list = [];
  for (const t of all.filter((x) => open(x, me, st.handled))) {
    list.push({
      id: t.id, path: t.path, line: t.line ?? t.originalLine, outdated: t.isOutdated, trusted: await trusted(gh, repo, n, t, me),
      comments: t.comments.map((c) => ({ id: c.id, author: c.author, body: c.body })),
    });
  }
  if (!st.heads.includes(pr.headSha)) {
    // a converged head is not a round: nothing is left to fix
    if (list.length && st.heads.length >= config.respond.max_rounds) throw new RoundCap(`round cap reached: ${st.heads.length} rounds on ${repo}#${n} and ${list.length} finding(s) still open`);
    if (list.length) save(repo, n, { ...st, heads: [...st.heads, pr.headSha] });
  }
  return { head: pr.headSha, round: load(repo, n).heads.length, converged: !list.length, findings: list };
}

// jev was measured on texts up to 6 KB (bench/jev/RESULTS.md): the file and its diff stay near that.
const FILE_CAP = 6000, DIFF_CAP = 4000;

// The file at the PR head from git (never the working tree, so a symlink is its target text and a dirty
// tree does not count), numbered, cut to FILE_CAP around the line. show(path) is null when the head has no such file.
function code(show, path, line) {
  const text = path ? show(path) : null;
  if (text == null) return "(the file is not in the PR head)";
  const lines = text.split("\n").map((l, i) => `${i + 1}: ${l}`);
  // an outdated thread can point past the end of the file at the head
  let lo = Math.min(Math.max(0, (line ?? 1) - 1), lines.length - 1), hi = lo + 1, size = lines[lo].length;
  // grow the window both ways from the line until the cap
  while ((lo > 0 || hi < lines.length) && size < FILE_CAP) {
    if (lo > 0) size += lines[--lo].length + 1;
    if (hi < lines.length) size += lines[hi++].length + 1;
  }
  return lines.slice(lo, hi).join("\n");
}

/**
 * What jev reads for one finding: the PR intent, the thread, the PR diff of the file, and the file at the head.
 * show(sha, path) reads a file at a commit; fileDiff(base, head, path) is the PR diff of one file.
 */
export function decideText(pr, t, { show, fileDiff }) {
  const d = t.path ? fileDiff(pr.baseSha, pr.headSha, t.path) : "";
  return [
    prData(`Title: ${pr.title}\n\n${pr.body ?? ""}`, "the PR author (the intent of the PR)"),
    threadText(t),
    prData(`${t.path}\n${d.length > DIFF_CAP ? `${d.slice(0, DIFF_CAP)}\n(diff cut)` : d}`, "the PR diff of this file"),
    prData(`${t.path}\n${code((p) => show(pr.headSha, p), t.path, t.line ?? t.originalLine)}`, "the file at the PR head"),
  ].join("\n");
}

/**
 * jev can confirm a finding, never decline one: on PR 44 it said no to 3 to 7 of 14 real findings, and one
 * changed line of context flips its answer (bench/jev/respond.mjs). A yes to both questions is "fix"; a no or
 * unsure is "ask" with the reason, and the agent checks the code (it declines only what it confirms is wrong).
 * An untrusted author is "ask" before jev reads anything. -> { decision: "fix"|"ask", reason }
 */
export async function decide({ repo, n, threadId, gh, jev, show, fileDiff }) {
  const [me, pr, t] = [await gh.viewer(), await gh.pr(repo, n), await thread(gh, repo, n, threadId)];
  if (!(await trusted(gh, repo, n, t, me))) return { decision: "ask", reason: UNTRUSTED };
  const text = decideText(pr, t, { show, fileDiff });
  const steps = [
    [Q.correct, "jev says the finding does not hold on the head"],
    [Q.scope, "jev says the comment is not about code this PR adds or changes"],
  ];
  for (const [q, why] of steps) {
    const a = await jev(q, text);
    if (a !== "yes") return { decision: "ask", reason: a === "no" ? `${why}; check the code` : `jev is not sure: "${q}"` };
  }
  return { decision: "fix", reason: "jev: correct, and about code this PR changes" };
}

/** A short reason on the thread; the thread stays open for the reviewer. -> { action: "replied"|"skipped" } */
export async function decline({ repo, n, threadId, reason, gh }) {
  const [me, t] = [await gh.viewer(), await thread(gh, repo, n, threadId)];
  if (handledNow(t, me, load(repo, n).handled)) return { action: "skipped" };
  const body = String(reason).trim();
  if (!body) throw new Error("decline needs a reason");
  if (!scanOutbound(body).ok) throw new Error("the secret scan holds the reason; write it again without the secret");
  // a crash after the post and before markHandled must not post twice: the marker is the record on GitHub
  const key = sha1(`respond-decline\0${threadId}\0${lastOther(t, me)}`);
  if (!(await gh.findMarker(repo, n, key))) await gh.reply(repo, n, t.comments[0].id, `${body}\n\n<!-- pr-review key=${key} -->`);
  markHandled(repo, n, t, me);
  return { action: "replied" };
}

/**
 * jev checks that the commit fixes the case first. Only on a yes: "Fixed in <sha>" on the thread (amend our
 * newest reply, never a second one) and resolve. On a no or unsure nothing is posted and the thread stays open.
 * onHead(sha, headSha) says the commit is in the PR head. -> { resolved, reason }
 */
export class NotOnHead extends Error {}
export async function fixed({ repo, n, threadId, sha, gh, jev, diff, onHead }) {
  const [me, pr, t] = [await gh.viewer(), await gh.pr(repo, n), await thread(gh, repo, n, threadId)];
  if (!onHead(sha, pr.headSha)) throw new NotOnHead(`commit ${sha.slice(0, 7)} is not in the PR head ${pr.headSha.slice(0, 7)}; push it first`);
  // the gate in decide is advice to the agent; this one stops the post and the resolve
  if (!(await trusted(gh, repo, n, t, me))) return { resolved: false, reason: UNTRUSTED };
  if (t.isResolved) return { resolved: true, reason: "already resolved" };
  const a = await jev(Q.fixes, `${threadText(t)}\n${prData(diff(sha), "the commit")}`);
  if (a !== "yes") return { resolved: false, reason: a === "no" ? `jev says commit ${sha.slice(0, 7)} does not fix the case` : "jev is not sure that the commit fixes the case" };
  // the marker is found on fully paged comments, so a long thread does not get a second reply
  const key = sha1(`respond-fixed\0${threadId}\0${sha}`);
  const posted = await gh.findMarker(repo, n, key);
  if (!(await linkFix(gh, repo, n, { t, commentId: t.comments[0].id, sha, me, posted, tail: `<!-- pr-review sha=${pr.headSha} key=${key} -->` }))) throw new Error("the secret scan holds the Fixed reply");
  markHandled(repo, n, t, me);
  if (!t.viewerCanResolve) return { resolved: false, reason: "you cannot resolve this thread" };
  await gh.resolve(threadId);
  return { resolved: true, reason: "jev confirms the fix" };
}

const listOf = (xs) => (xs.length === 1 ? `${xs[0]}` : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

/**
 * One PR comment that answers a review point by point, in its numbering.
 * points: [{ n, status: "done"|"open", sha?, text }]. Done points need the sha of the fixing commit.
 */
export function summaryText(repo, points) {
  if (!points.length) throw new Error("summary needs at least one point");
  for (const p of points) {
    if (!["done", "open"].includes(p.status)) throw new Error(`point ${p.n}: status must be done or open`);
    if (p.status === "done" && !/^[0-9a-f]{7,40}$/.test(p.sha ?? "")) throw new Error(`point ${p.n}: a done point needs the commit sha`);
    if (!String(p.text ?? "").trim()) throw new Error(`point ${p.n}: text is empty`);
  }
  const done = points.filter((p) => p.status === "done"), kept = points.filter((p) => p.status === "open").map((p) => p.n);
  const head = [
    done.length ? `${done.length} point${done.length === 1 ? " is" : "s are"} in` : "No point is in",
    kept.length ? `point${kept.length === 1 ? "" : "s"} ${listOf(kept)} ${kept.length === 1 ? "is" : "are"} kept open` : null,
  ].filter(Boolean).join("; ") + ".";
  const line = (p) => p.status === "done"
    ? `${p.n}. Done in [\`${p.sha.slice(0, 7)}\`](https://github.com/${repo}/commit/${p.sha}): ${p.text.trim()}`
    : `${p.n}. Kept open: ${p.text.trim()}`;
  return [head, "", ...points.map(line)].join("\n");
}

/** Posts the summary once per head (a marker key). -> { action: "posted"|"skipped" } */
export async function summary({ repo, n, points, gh }) {
  const { headSha } = await gh.pr(repo, n);
  const key = sha1(`respond-summary\0${headSha}`);
  const body = `${summaryText(repo, points)}\n\n<!-- pr-review sha=${headSha} key=${key} -->`;
  if (!scanOutbound(body).ok) throw new Error("the secret scan holds the summary");
  if (await gh.findMarker(repo, n, key)) return { action: "skipped" };
  await gh.comment(repo, n, body);
  return { action: "posted" };
}
