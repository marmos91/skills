// One loop run (spec 7.1-7.5, 8): lock, answers, list, act per PR. Never asks; it only queues.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as github from "./github.mjs";
import { COLLABORATOR, reply as realReply } from "./reply.mjs";
import { frame as realFrame, SEVERITY } from "./frame.mjs";
import { loadConfig, pickEffort, lowerEffort, userConfigPath } from "./config.mjs";
import { budgetLeft } from "./convergence.mjs";
import { FINAL_STAGE, acquireLock, Locked, markDone, prState, savePrState, runDir, stateRoot, writeAtomic } from "./state.mjs";
import { appliedAnswer, openQuestions, pendingAnswers, queueQuestion, questionWarnings } from "./questions.mjs";

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
// A corrupt journal or baseline file counts as missing, so one bad write cannot stop every later tick.
const readJson = (f) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };

const REPLY_REASONS = {
  "not-collaborator": "The last comment is by a user without write access. The loop does not answer it.",
  budget: "The thread used its reply budget (loop.max_replies_per_thread) and is still open.",
  "no-challenger": "The config has no second seat of another family to challenge the draft reply.",
  unsure: "The two seats disagree and jev did not settle it.",
  repeat: "The new reply only repeats an earlier argument.",
  secret: "The reply text matched the outbound secret scan.",
};

export const commentUrl = (repo, n, id) => `https://github.com/${repo}/pull/${n}#discussion_r${id}`;

/** Adapts a reply() queue item to a queueQuestion record. No PR text: comments appear only as author login and URL. */
export function replyQuestion(item, t, me, repo) {
  const ours = t?.comments.findLast((c) => c.author === me);
  const theirs = t?.comments.findLast((c) => c.author !== me);
  const ref = (c) => `${c.author}: ${commentUrl(repo, item.pr, c.id)}`;
  return {
    pr: item.pr, sha: item.sha, fingerprint: sha1(`reply:${item.threadId}:${item.commentId}`), file: commentUrl(repo, item.pr, item.commentId), line: item.line ?? 0, snippet: "",
    finding: { kind: "reply", title: `Review thread needs your answer (${item.reason})`, case: REPLY_REASONS[item.reason] ?? "The loop did not reply.", threadId: item.threadId, commentId: item.commentId },
    sides: { keep: ours ? ref(ours) : "(no comment by you)", drop: theirs ? ref(theirs) : "(no comment)" },
    failure: `The loop posts no reply in thread ${item.threadId} for this comment.`,
  };
}

// An explicit request only. A clause after a negation ("don't", "can't", "no need to") or an offer ("want me to", "shall I") does not count.
const ASKS_REVIEW = /\b(?:(?:please|can you|could you|would you)\s+(?:re-?)?review|(?:re-?)?review\s+(?:this|it|again)|ptal)\b/i;
export const asksReview = (body) => ASKS_REVIEW.test(String(body ?? "").replace(/\b(?:don['’]?t|do\s+not|can['’]?t|cannot|can\s+not|no\s+need\s+to|want\s+me\s+to|shall\s+i|should\s+i)\b[^.!?\n]*/gi, ""));

function baseConfigText(repoDir) {
  try { return execFileSync("git", ["show", "origin/HEAD:.pr-review.json"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}

/**
 * Injectable: gh, review (default: lazy review.mjs), reply, frame, loadCfg(repoText), log, now.
 * -> { processed, skipped, questions, todos, paused?, locked? }
 */
export async function tick({ repo, repoDir = process.cwd(), gh = github, review, reply = realReply, frame = realFrame, sweep, loadCfg, log = (m) => console.error(m), now = Date.now }) {
  review ??= async (o) => (await import("./review.mjs")).review(o);
  sweep ??= async (rs) => (await import("./review.mjs")).sweepWorktrees(rs);
  loadCfg ??= (repoText = baseConfigText(repoDir)) => loadConfig({ userPath: userConfigPath(), repoText });
  const rs = stateRoot(repo);
  const out = { processed: 0, skipped: 0, questions: 0, todos: 0 };
  if (existsSync(join(rs, "paused"))) { log(`pr-review-loop: paused; run "pr-review-loop resume" to continue`); return { ...out, paused: true }; }
  let release;
  try { release = acquireLock(rs); } catch (e) {
    if (!(e instanceof Locked)) throw e;
    log(`pr-review-loop: ${e.message}; this tick does nothing`);
    return { ...out, locked: true };
  }
  try {
    // reply-only runs end here, not in review(): sweep their worktrees too
    await sweep(rs);
    await run();
  } finally { release(); }
  out.questions = openQuestions(rs).length;
  const todoFile = join(rs, "todo.md");
  out.todos = existsSync(todoFile) ? (readFileSync(todoFile, "utf8").match(/^- \[ \]/gm) ?? []).length : 0;
  return out;

  async function run() {
    const config = loadCfg();
    const me = await gh.viewer();
    const runId = `tick-${now()}`;
    const update = (n, fn) => { const s = prState(rs, n); fn(s); savePrState(rs, n, s); };

    // 2. Print the queue and the to-do list.
    for (const w of questionWarnings(rs)) log(`warning: ${w}`);
    const open = openQuestions(rs);
    if (open.length) log(`${open.length} open question(s): ${open.map((q) => q.id).join(", ")}. Answer with "pr-review-loop answer".`);
    const todo = existsSync(join(rs, "todo.md")) ? readFileSync(join(rs, "todo.md"), "utf8").trim() : "";
    if (todo) log(`todo.md:\n${todo}`);

    // Apply answers. Questions without a loop kind belong to a review: its PR is forced into this tick's queue.
    const forced = new Map(); // pr -> [question ids]
    for (const q of pendingAnswers(rs)) {
      const kind = q.finding?.kind;
      try {
        if (!kind) {
          // A drop past the review budget needs no review: it is settled here.
          if (q.answer === "drop" && !budgetLeft(prState(rs, q.pr), config).review) appliedAnswer(rs, q.id);
          else forced.set(q.pr, [...(forced.get(q.pr) ?? []), q.id]);
          continue;
        }
        if (kind === "approve" && q.answer === "post" && !(await approve(q))) continue; // CI pending: retry next tick
        appliedAnswer(rs, q.id);
      } catch (e) { log(`question ${q.id}: ${e.message}; retried next tick`); }
    }

    const loopFile = join(rs, "loop.json");
    let baseline = readJson(loopFile)?.baseline;
    if (!baseline) {
      baseline = new Date(now()).toISOString();
      writeAtomic(loopFile, JSON.stringify({ baseline }) + "\n");
      log(`first run: baseline ${baseline}; older activity is ignored except open review requests`);
    }

    // Resume: an interrupted tick finishes its queue before new work is listed.
    const jf = join(rs, "tick.json");
    let budget = config.loop.max_prs_per_run;
    const handled = new Set();
    const old = readJson(jf);
    if (old) {
      log(`finishing the queue of an interrupted tick from ${old.startedAt}`);
      const n = await runQueue(old);
      if (n === null) return;
      // Handled by the resumed queue: not listed again in this tick.
      for (const r of old.queue) { handled.add(r.number); forced.delete(r.number); }
      budget -= n;
    }

    const rows = [], found = await gh.searchPRs(repo, "@me");
    // An answered review question on a PR that left the search (closed, merged) has nothing left to do.
    for (const [pr, ids] of forced) {
      if (found.some((r) => r.number === pr)) continue;
      for (const id of ids) appliedAnswer(rs, id);
      log(`#${pr}: not open any more; answers ${ids.join(", ")} closed without a review`);
      forced.delete(pr);
    }
    for (const r of found) {
      if (handled.has(r.number)) continue;
      if (config.loop.authors_ignore.includes(r.author)) continue;
      const force = forced.has(r.number);
      const fresh = r.updatedAt > baseline || r.reasons.includes("review-requested") || force;
      // shortcut: updatedAt stands in for head SHA + newest comment; our own posts bump it, so a PR gets one cheap extra pass.
      const c = prState(rs, r.number).cache;
      // a PR that could not be reviewed (exit 1) comes back when the user raises the cap, or after a day
      // (covers a cap raised in the repo's .pr-review.json, which this check does not load)
      const blockedStale = c.blocked && (c.blocked.cap !== config.review.max_diff_lines || now() - c.blocked.at > 24 * 3600e3);
      const changed = force || c.updatedAt !== r.updatedAt || blockedStale;
      if (fresh && changed) rows.push(blockedStale ? { ...r, blockedRetry: true } : r); else out.skipped++;
    }
    rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    await runQueue({ startedAt: new Date(now()).toISOString(), queue: rows.slice(0, Math.max(0, budget)), done: [], current: null });

    async function runQueue(j) {
      let n = 0;
      for (const r of j.queue) {
        if (j.done.includes(r.number)) continue;
        // Paused mid-run: keep tick.json so the next tick resumes this queue.
        if (existsSync(join(rs, "paused"))) { log("pr-review-loop: paused; the rest of this queue waits for resume"); return null; }
        writeAtomic(jf, JSON.stringify({ ...j, current: r.number }, null, 2) + "\n");
        let res;
        try { res = await handle(r, forced.get(r.number)); } catch (e) { log(`#${r.number}: ${e.message}`); res = { acted: false, cache: false }; }
        // the block marker stays until a review really ran (or a new exit 1 replaces it)
        if (res.cache) update(r.number, (s) => { const blocked = res.blocked ?? (res.reviewed ? undefined : s.cache?.blocked); s.cache = { updatedAt: r.updatedAt, ...(blocked && { blocked }) }; });
        res.acted ? out.processed++ : out.skipped++;
        j.done.push(r.number);
        writeAtomic(jf, JSON.stringify({ ...j, current: null }, null, 2) + "\n");
        n++;
      }
      rmSync(jf, { force: true });
      return n;
    }

    async function handle(r, force) {
      const n = r.number, own = r.author === me;
      const p = await gh.pr(repo, n);
      if (p.isDraft) {
        // A draft gets no review; an answer waiting on it is closed as dropped, never left pending.
        if (force) { for (const id of force) appliedAnswer(rs, id); log(`#${n}: draft; answers ${force.join(", ")} dropped`); }
        return { acted: false, cache: true };
      }
      const s = prState(rs, n);
      const seen = s.loopSeen ?? {};
      const mention = new RegExp(`@${me}(?![\\w-])`, "i");
      const markSeen = (t, c) => update(n, (x) => { x.loopSeen = { ...x.loopSeen, [t.id]: c.id }; });
      const threads = await gh.threads(repo, n);
      const human = (c) => c.author !== me && c.authorType !== "Bot" && !config.loop.authors_ignore.includes(c.author);
      // The newest human comment, and only when we have not answered after it.
      const fresh = threads.map((t) => {
        const i = t.comments.findLastIndex(human);
        return [t, t.comments[i], i >= 0 && !t.comments.slice(i + 1).some((x) => x.author === me)];
      }).filter(([t, c, open]) => open && c.createdAt > baseline && seen[t.id] !== c.id).map(([t, c]) => [t, c]);

      // 7.2: Marco's PR -> reply per new thread; a collaborator's mention -> reply, review only if asked.
      // shortcut: mentions in top-level PR comments are not read (threads only); add an issue-comment reader when needed.
      let requested = r.reasons.includes("review-requested"), wantReview = false;
      const toReply = [];
      if (own) toReply.push(...fresh);
      else for (const [t, c] of fresh) {
        if (!mention.test(c.body ?? "")) continue;
        if (!COLLABORATOR.has(await gh.permission(repo, c.author))) { log(`#${n}: mention by ${c.author} (no write access) not answered`); markSeen(t, c); continue; }
        toReply.push([t, c]);
        if (asksReview(c.body)) { wantReview = true; if (c.author === r.author) requested = true; }
      }

      // A forced PR (answered review question) is reviewed even when it is Marco's own, else the answer stays pending.
      // A blocked PR (exit 1 earlier) that is due for a retry is reviewed again, whatever started the first attempt.
      const retryBlocked = !!s.cache?.blocked && r.blockedRetry;
      let doReview = !!force || retryBlocked || (!own && (requested || wantReview || (r.reasons.includes("reviewed-by") && p.headSha !== s.lastReviewedSha)));
      let queued = false, wait = false;
      // 7.5 rule 5: after the round budget only a new request from the author reviews again.
      if (doReview && !requested && !force && !retryBlocked && !budgetLeft(s, config).review) {
        doReview = false;
        queued = true;
        const musts = threads.filter((t) => !t.isResolved && t.comments[0]?.author === me && SEVERITY.exec(t.comments[0].body ?? "")?.[1] === "must").map((t) => commentUrl(repo, n, t.comments[0].id));
        queueQuestion(rs, {
          pr: n, sha: p.headSha, fingerprint: sha1(`budget:${n}`), file: "(whole PR)", line: 0, snippet: "",
          finding: { kind: "budget", title: "Review budget used", case: `The loop made ${s.reviews} automatic reviews (loop.max_review_rounds ${config.loop.max_review_rounds}) and stops until a new review request. Open must items: ${musts.length ? musts.join(", ") : "none"}.` },
          sides: { keep: "Review it yourself with /pr-review, or ask the author to request a review again.", drop: "Leave the PR to the humans." },
          failure: "The loop makes no more automatic reviews of this PR.",
        });
      }
      // 5.2: pending CI waits up to loop.ci_wait_minutes.
      if (doReview && config.review.ci !== "ignore") {
        const c = await gh.checks(repo, n, p.headSha);
        if (c.state === "pending" && !(c.since && now() - Date.parse(c.since) > config.loop.ci_wait_minutes * 60000)) {
          log(`#${n}: CI pending; skipped this tick`);
          doReview = false;
          wait = true;
        }
      }
      if (!toReply.length && !doReview) return { acted: queued, cache: !wait };

      const dir = runDir(rs, n, p.headSha);
      const fr = await frame({ repo, n, repoDir, runDir: dir, config, gh, prState: s });
      for (const [t, c] of toReply) {
        await reply({ repo, n, threadId: t.id, mode: "loop", frame: fr, config, runDir: dir, gh, queue: (item) => queueQuestion(rs, replyQuestion(item, t, me, repo)) });
        markSeen(t, c);
      }
      // No review follows and none started here (no run.json): the folder only held replies, so it is final.
      if (!doReview && !existsSync(join(dir, "run.json"))) markDone(dir, FINAL_STAGE);
      if (doReview) {
        const pcfg = loadCfg(fr.repoConfigText ?? null);
        let effort = pcfg.loop.effort === "auto" ? pickEffort(fr.changedPaths, pcfg) : pcfg.loop.effort;
        if (fr.delta?.isAncestor) effort = lowerEffort(effort); // 5.1: delta review one level below
        const res = await review({ repo, n, mode: "loop", effort, effortFromConfig: true, repoDir, gh });
        // Exit 1 (diff too large, ...) repeats on every tick until the PR changes: close its answers and cache it.
        if (res?.exit === 1) {
          for (const id of force || []) { appliedAnswer(rs, id); log(`#${n}: answer ${id} closed; the review cannot run`); }
          log(`#${n}: ${res.summary}; skipped until the PR or review.max_diff_lines changes (retried after a day)`);
          return { acted: false, cache: true, blocked: { cap: config.review.max_diff_lines, at: now() } };
        }
        if (res?.exit) throw new Error(`review exit ${res.exit}: ${res.summary}; retried next tick`);
        // A skipped review leaves the answers to review(): a pending-review skip keeps them pending (forced again
        // next tick), and the answer-only follow-up closes the ones it handled itself.
        if (res?.skipped) log(`#${n}: ${res.summary}`);
        // The review ran with the answers: never force this PR again for them. review() queues approve? itself.
        else for (const id of force || []) appliedAnswer(rs, id);
      }
      return { acted: true, cache: !wait, reviewed: doReview && !wait };
    }

    // 7.4: check against the current head first; a moved head drops the answer with a note.
    // -> true when the answer is settled (approved or dropped), false to retry next tick.
    async function approve(q) {
      const p = await gh.pr(repo, q.pr);
      const ci = p.headSha === q.sha ? await gh.checks(repo, q.pr, q.sha) : null;
      if (!ci || ci.stale) { log(`#${q.pr}: head moved since question ${q.id}; approve dropped`); return true; }
      if (ci.state === "pending") { log(`#${q.pr}: CI pending; approve (${q.id}) waits for the next tick`); return false; }
      if (ci.state !== "green" && ci.state !== "none") { log(`#${q.pr}: CI ${ci.state}; approve (${q.id}) dropped`); return true; }
      const key = `key=${sha1(`approve\0${q.pr}\0${q.sha}`)}`;
      if (await gh.findMarker(repo, q.pr, key)) return true;
      await gh.postReview(repo, q.pr, { commitOID: q.sha, event: "APPROVE", body: `<!-- pr-review run=${runId} sha=${q.sha} ${key} -->` });
      log(`#${q.pr}: approved at ${q.sha} (answer to ${q.id})`);
      return true;
    }
  }
}
