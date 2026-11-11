// One loop run (spec 7.1-7.5, 8): lock, answers, list, act per PR. Never asks; it only queues.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as github from "./github.mjs";
import { reply as realReply } from "./reply.mjs";
import { frame as realFrame } from "./frame.mjs";
import { loadConfig, pickEffort, lowerEffort } from "./config.mjs";
import { budgetLeft } from "./convergence.mjs";
import { acquireLock, Locked, prState, savePrState, runDir, stateRoot, writeAtomic } from "./state.mjs";
import { appliedAnswer, openQuestions, pendingAnswers, queueQuestion, questionWarnings } from "./questions.mjs";

const USER_CONFIG = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pr-review", "config.json");
// On public repos every user has "read" (Task 8 note).
const COLLABORATOR = new Set(["write", "admin"]);
const MUST = /^\s*\*\*must:\*\*/;
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

/** Adapts a reply() queue item to a queueQuestion record. The finding is engine text only; PR text goes only into sides. */
export function replyQuestion(item, t, me) {
  const ours = t?.comments.findLast((c) => c.author === me);
  const theirs = t?.comments.findLast((c) => c.author !== me);
  return {
    pr: item.pr, sha: item.sha, fingerprint: sha1(`reply:${item.threadId}`), file: item.path, line: item.line, snippet: "",
    finding: { kind: "reply", title: `Review thread needs your answer (${item.reason})`, case: REPLY_REASONS[item.reason] ?? "The loop did not reply.", threadId: item.threadId, commentId: item.commentId },
    sides: { keep: ours?.body ?? "(no comment by you)", drop: theirs?.body ?? "(no comment)" },
    failure: `The loop posts no reply in thread ${item.threadId} for this comment.`,
  };
}

function baseConfigText(repoDir) {
  try { return execFileSync("git", ["show", "origin/HEAD:.pr-review.json"], { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; }
}

/**
 * Injectable: gh, review (default: lazy review.mjs), reply, frame, loadCfg(repoText), log, now.
 * -> { processed, skipped, questions, todos, paused?, locked? }
 */
export async function tick({ repo, repoDir = process.cwd(), gh = github, review, reply = realReply, frame = realFrame, loadCfg, log = (m) => console.error(m), now = Date.now }) {
  review ??= async (o) => (await import("./review.mjs")).review(o);
  loadCfg ??= (repoText = baseConfigText(repoDir)) => loadConfig({ userPath: USER_CONFIG, repoText });
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

    // Apply answers. Questions without a loop kind belong to a review, which applies them on its next run.
    const forced = new Set();
    for (const q of pendingAnswers(rs)) {
      const kind = q.finding?.kind;
      if (!kind) { forced.add(q.pr); continue; }
      if (kind === "approve" && q.answer === "post") await approve(q);
      appliedAnswer(rs, q.id);
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
    const old = readJson(jf);
    if (old) {
      log(`finishing the queue of an interrupted tick from ${old.startedAt}`);
      budget -= await runQueue(old);
    }

    const rows = [];
    for (const r of await gh.searchPRs(repo, "@me")) {
      if (config.loop.authors_ignore.includes(r.author)) continue;
      const force = forced.has(r.number);
      const fresh = r.updatedAt > baseline || r.reasons.includes("review-requested") || force;
      // shortcut: updatedAt stands in for head SHA + newest comment; our own posts bump it, so a PR gets one cheap extra pass.
      const changed = force || prState(rs, r.number).cache.updatedAt !== r.updatedAt;
      if (fresh && changed) rows.push(r); else out.skipped++;
    }
    rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    await runQueue({ startedAt: new Date(now()).toISOString(), queue: rows.slice(0, Math.max(0, budget)), done: [], current: null });

    async function runQueue(j) {
      let n = 0;
      for (const r of j.queue) {
        if (j.done.includes(r.number)) continue;
        writeAtomic(jf, JSON.stringify({ ...j, current: r.number }, null, 2) + "\n");
        let res;
        try { res = await handle(r, forced.has(r.number)); } catch (e) { log(`#${r.number}: ${e.message}`); res = { acted: false, cache: false }; }
        if (res.cache) update(r.number, (s) => { s.cache = { updatedAt: r.updatedAt }; });
        res.acted ? out.processed++ : out.skipped++;
        j.done.push(r.number);
        n++;
      }
      rmSync(jf, { force: true });
      return n;
    }

    async function handle(r, force) {
      const n = r.number, own = r.author === me;
      const p = await gh.pr(repo, n);
      if (p.isDraft) return { acted: false, cache: true };
      const s = prState(rs, n);
      const seen = s.loopSeen ?? {};
      const mention = new RegExp(`@${me}(?![\\w-])`, "i");
      const markSeen = (t, c) => update(n, (x) => { x.loopSeen = { ...x.loopSeen, [t.id]: c.id }; });
      const threads = await gh.threads(repo, n);
      const fresh = threads.map((t) => [t, t.comments.at(-1)]).filter(([t, c]) => c && c.author !== me && c.authorType !== "Bot"
        && !config.loop.authors_ignore.includes(c.author) && c.createdAt > baseline && seen[t.id] !== c.id);

      // 7.2: Marco's PR -> reply per new thread; a collaborator's mention -> reply, review only if asked.
      // shortcut: mentions in top-level PR comments are not read (threads only); add an issue-comment reader when needed.
      let requested = r.reasons.includes("review-requested"), wantReview = false;
      const toReply = [];
      if (own) toReply.push(...fresh);
      else for (const [t, c] of fresh) {
        if (!mention.test(c.body ?? "")) continue;
        if (!COLLABORATOR.has(await gh.permission(repo, c.author))) { log(`#${n}: mention by ${c.author} (no write access) not answered`); markSeen(t, c); continue; }
        toReply.push([t, c]);
        if (/\breview\b/i.test(c.body)) { wantReview = true; if (c.author === r.author) requested = true; }
      }

      let doReview = !own && (requested || wantReview || force || (r.reasons.includes("reviewed-by") && p.headSha !== s.lastReviewedSha));
      let queued = false, wait = false;
      // 7.5 rule 5: after the round budget only a new request from the author reviews again.
      if (doReview && !requested && !budgetLeft(s, config).review) {
        doReview = false;
        queued = true;
        const musts = threads.filter((t) => !t.isResolved && t.comments[0]?.author === me && MUST.test(t.comments[0].body ?? "")).map((t) => `${t.path}:${t.line ?? t.originalLine}`);
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
        await reply({ repo, n, threadId: t.id, mode: "loop", frame: fr, config, runDir: dir, gh, queue: (item) => queueQuestion(rs, replyQuestion(item, t, me)) });
        markSeen(t, c);
      }
      if (doReview) {
        const pcfg = loadCfg(fr.repoConfigText ?? null);
        let effort = pcfg.loop.effort === "auto" ? pickEffort(fr.changedPaths, pcfg) : pcfg.loop.effort;
        if (fr.delta?.base) effort = lowerEffort(effort); // 5.1: delta review one level below
        const res = await review({ repo, n, mode: "loop", effort, repoDir, gh });
        if (res?.exit === 4) throw new Error("review failed after retries; retried next tick");
        if (res?.queueApprove) {
          const why = Array.isArray(res.reasons) ? ` Reasons: ${res.reasons.join("; ")}.` : "";
          queueQuestion(rs, {
            pr: n, sha: p.headSha, fingerprint: sha1(`approve:${n}:${p.headSha}`), file: "(whole PR)", line: 0, snippet: "",
            finding: { kind: "approve", title: "Approve this PR?", case: `The review at ${p.headSha} has no agreed finding. The loop approves only a trusted author with a unanimous zero-finding vote.${why}` },
            sides: { keep: "post: approve the PR at this commit.", drop: "drop: keep the review as a comment." },
            failure: "The PR waits for a human approval.",
          });
        }
      }
      return { acted: true, cache: !wait };
    }

    // 7.4: check against the current head first; a moved head drops the answer with a note.
    async function approve(q) {
      const p = await gh.pr(repo, q.pr);
      if (p.headSha !== q.sha) { log(`#${q.pr}: head moved since question ${q.id}; not approved`); return; }
      const key = `key=${sha1(`approve\0${q.pr}\0${q.sha}`)}`;
      if (await gh.findMarker(repo, q.pr, key)) return;
      await gh.postReview(repo, q.pr, { commitOID: q.sha, event: "APPROVE", body: `<!-- pr-review run=${runId} sha=${q.sha} ${key} -->` });
      log(`#${q.pr}: approved at ${q.sha} (answer to ${q.id})`);
    }
  }
}
