// pr-respond: the steps of fixing review findings on your own PR. The agent edits the code; this module
// picks the threads, asks jev, posts the replies and resolves. Every function takes gh and jev for tests.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { scanOutbound } from "./secrets.mjs";
import { prData } from "./prompts.mjs";
import { linkFix } from "./reply.mjs";
import { prState, savePrState, stateRoot } from "./state.mjs";

export const Q = {
  correct: "This review finding is correct about the code at the PR head.",
  scope: "Fixing this finding is in the scope of this PR.",
  clear: "This finding has one clear fix that needs no design decision.",
  fixes: "The commit diff below fixes the case that the review comment describes.",
};

export class RoundCap extends Error {}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const threadText = (t) => prData(JSON.stringify(t.comments.map((c) => ({ author: c.author, body: c.body })), null, 2), "the reviewers");

// Open work: unresolved, and either only its first comment (a council finding is posted as us) or a newest comment by someone else.
const open = (t, me) => !t.isResolved && (t.comments.length === 1 || t.comments.at(-1).author !== me);

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
  const list = all.filter((t) => open(t, me)).map((t) => ({
    id: t.id, path: t.path, line: t.line ?? t.originalLine, outdated: t.isOutdated,
    comments: t.comments.map((c) => ({ id: c.id, author: c.author, body: c.body })),
  }));
  const rs = stateRoot(repo), st = prState(rs, n);
  const heads = st.respondHeads ?? [];
  if (!heads.includes(pr.headSha)) {
    // a converged head is not a round: nothing is left to fix
    if (list.length && heads.length >= config.respond.max_rounds) throw new RoundCap(`round cap reached: ${heads.length} rounds on ${repo}#${n} and ${list.length} finding(s) still open`);
    if (list.length) savePrState(rs, n, { ...st, respondHeads: [...heads, pr.headSha] });
  }
  return { head: pr.headSha, round: (prState(rs, n).respondHeads ?? []).length, converged: !list.length, findings: list };
}

// The code around the line, from the checkout of the PR head (the agent works there).
function code(path, line, root = process.cwd()) {
  const f = `${root}/${path}`;
  if (!path || !existsSync(f)) return "(the file is not in the checkout of the head)";
  const lines = readFileSync(f, "utf8").split("\n"), at = Math.max(1, line ?? 1);
  return lines.slice(Math.max(0, at - 16), at + 15).map((l, i) => `${Math.max(1, at - 15) + i}: ${l}`).join("\n");
}

/**
 * jev decides one finding. Unsure at any step is a question for the user.
 * -> { decision: "fix"|"decline"|"ask", reason }
 */
export async function decide({ repo, n, threadId, gh, jev, root }) {
  const [pr, t] = [await gh.pr(repo, n), await thread(gh, repo, n, threadId)];
  const text = [
    prData(`Title: ${pr.title}\n\n${pr.body ?? ""}`, "the PR author (the intent of the PR)"),
    threadText(t),
    prData(`${t.path}\n${code(t.path, t.line ?? t.originalLine, root)}`, "the code at the PR head"),
  ].join("\n");
  const steps = [
    [Q.correct, "decline", "the finding does not hold on the head"],
    [Q.scope, "decline", "the fix is outside the scope of this PR; it fits a follow-up"],
    [Q.clear, "ask", "the fix needs a design decision"],
  ];
  for (const [q, onNo, why] of steps) {
    const a = await jev(q, text);
    if (a === "unsure") return { decision: "ask", reason: `jev is not sure: "${q}"` };
    if (a === "no") return { decision: onNo, reason: why };
  }
  return { decision: "fix", reason: "correct, in scope, one clear fix" };
}

/** A short reason on the thread; the thread stays open for the reviewer. -> { action: "replied"|"skipped" } */
export async function decline({ repo, n, threadId, reason, gh }) {
  const [me, t] = [await gh.viewer(), await thread(gh, repo, n, threadId)];
  if (t.comments.length > 1 && t.comments.at(-1).author === me) return { action: "skipped" };
  const body = String(reason).trim();
  if (!body) throw new Error("decline needs a reason");
  if (!scanOutbound(body).ok) throw new Error("the secret scan holds the reason; write it again without the secret");
  await gh.reply(repo, n, t.comments[0].id, body);
  return { action: "replied" };
}

/**
 * "Fixed in <sha>" on the thread (amend our newest reply, never a second one), then resolve only when
 * jev says yes that the commit fixes the case. -> { resolved, reason }
 */
export async function fixed({ repo, n, threadId, sha, gh, jev, diff }) {
  const [me, t] = [await gh.viewer(), await thread(gh, repo, n, threadId)];
  const posted = t.comments.some((c) => c.author === me && String(c.body).includes(`/commit/${sha}`));
  if (!(await linkFix(gh, repo, n, { t, commentId: t.comments[0].id, sha, me, posted }))) throw new Error("the secret scan holds the Fixed reply");
  if (t.isResolved) return { resolved: true, reason: "already resolved" };
  const a = await jev(Q.fixes, `${threadText(t)}\n${prData(diff(sha), "the commit")}`);
  if (a !== "yes") return { resolved: false, reason: a === "no" ? `jev says commit ${sha.slice(0, 7)} does not fix the case` : "jev is not sure that the commit fixes the case" };
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
