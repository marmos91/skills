// Review pipeline (spec 6): frame -> round1 -> merge -> round2 -> tally -> decide -> compose -> post.
// Every child output and stage gets a marker (spec 8), so a rerun continues where the last run stopped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import * as github from "./github.mjs";
import { runChild as realRunChild, ChildFailed, stopping } from "./child.mjs";
import { LENSES, applyEffort, loadConfig, pickEffort, plannedChildren, seatId, seatsForLens, userConfigPath, withLimits } from "./config.mjs";
import { frame as realFrame, git, readTree, HeadMoved, DiffTooLarge } from "./frame.mjs";
import { composePrompt, mergePrompt, round1Prompt, votePrompt } from "./prompts.mjs";
import { tally } from "./tally.mjs";
import { filterNew, fingerprint } from "./convergence.mjs";
import { parseHunks, place } from "./hunks.mjs";
import { verdict } from "./verdict.mjs";
import { redact, scanOutbound } from "./secrets.mjs";
import { hygiene as realHygiene } from "./hygiene.mjs";
import { decide as realDecide } from "./decider.mjs";
import { appliedAnswer, pendingAnswers, queueQuestion } from "./questions.mjs";
import { FINAL_STAGE, acquireLock, done, markDone, prState, runDir as pickRunDir, savePrState, stateRoot, writeAtomic } from "./state.mjs";

export const STAGES = ["frame", "round1", "merge", "round2", "tally", "decide", "compose", "post"];
const RANK = { must: 0, should: 1, nit: 2 };
const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const save = (f, v) => writeAtomic(f, JSON.stringify(v, null, 2) + "\n");
// fp= on inline comments lets a later run link a thread to its finding (spec 6.4); key= is the dedupe key.
const marker = (runId, sha, key, fp) => `<!-- pr-review run=${runId} sha=${sha} key=${key}${fp ? ` fp=${fp}` : ""} -->`;
// Fields the seats and the judge see; engine bookkeeping stays out of prompts.
const view = ({ seats, fp, answered, ...c }) => c;
// GitHub text that the engine puts into a posted body: no markup, no mentions, no marker look-alikes.
export const safeText = (s) => String(s ?? "").replace(/[<>@`]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
const ruleIds = (hits) => [...new Set(hits.map((h) => h.split(":")[0]))].join(", ");
const MARKER_FP = /<!-- pr-review run=\S+ sha=\S+ key=[0-9a-f]{40} fp=([0-9a-f]{40}) -->/;

/** Config, flag or state problems: exit 1, not a failed stage. */
export class SetupError extends Error { constructor(m) { super(m); this.name = "SetupError"; } }
// maxDiffLines (--max-diff-lines) wins over review.max_diff_lines at every level.
const config0 = (o, maxDiffLines) => {
  let c;
  try { c = loadConfig(o); } catch (e) { throw new SetupError(e.message); }
  if (maxDiffLines) c.review.max_diff_lines = maxDiffLines;
  return c;
};

/**
 * Review one PR. -> { exit: 0|3|4, summary, runDir?, url?, event?, questions?, planned? }
 * Options: repo, n, mode ("interactive"|"loop"), effort, dryRun, until, restart, lenses, maxDiffLines, configPath, repoDir;
 * injectable gh, runChild, decide, frame, hygiene, log(line); lock=false when the caller holds it.
 */
export async function review(opts) {
  const { repo, n, mode = "interactive", lock = true } = opts;
  if (!["interactive", "loop"].includes(mode)) throw new SetupError(`mode must be interactive or loop, got ${mode}`);
  if (opts.until && !STAGES.includes(opts.until)) throw new SetupError(`--until must be one of ${STAGES.join("|")}`);
  const repoState = stateRoot(repo);
  const o = {
    gh: github, runChild: realRunChild, decide: realDecide, stopping: () => stopping, frame: realFrame, hygiene: realHygiene, log: () => {},
    ...opts, mode, repoState,
  };
  // Reentrant: the loop calls review() while it holds the repo lock.
  const mine = () => { try { return Number(readFileSync(join(repoState, "lock", "pid"), "utf8")) === process.pid; } catch { return false; } };
  const release = lock && !mine() ? acquireLock(repoState) : () => {};
  try {
    for (let attempt = 0; ; attempt++) {
      try { return await once(o, o.restart && attempt === 0); } catch (e) {
        if (!(e instanceof HeadMoved) || attempt >= 2) throw e;
        o.log(`${e.message}`); // spec 6.10 step 2: drop the run, frame again
      }
    }
  } catch (e) {
    // Too large is the user's call, not a failed stage: nothing ran, so exit 1 with the way out.
    if (e instanceof DiffTooLarge) return { exit: 1, summary: `${e.message}. Review it anyway with --max-diff-lines N, or raise review.max_diff_lines in the config.` };
    if (e instanceof ChildFailed || e instanceof HeadMoved) return { exit: 4, summary: e.message };
    throw e;
  } finally { release(); }
}

// One child: a marker means its output is reused, never paid for twice (spec 8).
// lens: the one lens of a round-1 child, for a lens-level max_turns.
async function child(ctx, stage, key, { seat, prompt, schema, tools = "read", lens }) {
  const dir = join(ctx.runDir, stage), outFile = join(dir, `${key}.json`);
  if (done(ctx.runDir, stage, key)) return readJson(outFile);
  mkdirSync(dir, { recursive: true });
  const promptFile = join(dir, `${key}.prompt`);
  writeFileSync(promptFile, prompt());
  const v = await ctx.runChild({ seat: withLimits(ctx.config, seat, lens), tools, promptFile, outFile, worktree: ctx.frame.worktree, ctxDir: ctx.frame.ctxDir, schema, routerUp: ctx.routerUp });
  save(outFile, v);
  markDone(ctx.runDir, stage, key);
  return v;
}

// Waits for every child, so finished ones keep their markers when another fails.
async function settled(promises) {
  const r = await Promise.allSettled(promises);
  const bad = r.find((x) => x.status === "rejected");
  if (bad) throw bad.reason;
  return r.map((x) => x.value);
}

function round1Jobs(config, lenses) {
  const shared = lenses.filter((l) => config.round1 === "per-seat" && !config.lenses[l].seats);
  const jobs = shared.length ? config.seats.map((seat, i) => ({ key: `all~${i}`, seat, lenses: shared })) : [];
  for (const l of lenses.filter((x) => !shared.includes(x))) seatsForLens(config, l).forEach((seat, i) => jobs.push({ key: `${l}~${i}`, seat, lenses: [l] }));
  return jobs;
}

// Code around a finding, for jev and questions. The path comes from a model: it must stay in the worktree.
function hunk(f, c) {
  let file;
  try {
    const wt = realpathSync(f.worktree);
    file = realpathSync(resolve(wt, String(c.file))); // a symlink in the PR must not lead outside
    if (!file.startsWith(wt + sep)) return "";
  } catch { return ""; }
  try { return readFileSync(file, "utf8").split("\n").slice(Math.max(0, c.line - 6), c.line + 5).join("\n"); } catch { return ""; }
}

// Spec 7.4: an answer given at an older sha holds only while the finding's line is the same code at the same place.
// A failed diff (the old sha is gone) counts as changed.
export function codeMoved(repoDir, q, head) {
  if (q.sha === head) return false;
  const { file, line } = q.finding ?? {};
  if (!file || typeof line !== "number") return true;
  let d;
  try { d = git(repoDir, ["-c", "core.quotePath=false", "diff", "--no-color", "--no-renames", "-U0", q.sha, head, "--", file]); } catch { return true; }
  let shift = 0;
  for (const m of d.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/gm)) {
    const a = +m[1], removed = m[2] === undefined ? 1 : +m[2], added = m[3] === undefined ? 1 : +m[3];
    if (removed > 0 && a <= line && line < a + removed) return true; // the line itself changed
    if (removed > 0 ? a + removed <= line : a < line) shift += added - removed; // a hunk above it moves it
  }
  return shift !== 0;
}

function changedLines(f) {
  const d = join(f.ctxDir, existsSync(join(f.ctxDir, "delta.patch")) ? "delta.patch" : "diff.patch");
  const out = new Map();
  for (const [file, h] of parseHunks(readFileSync(d, "utf8"))) out.set(file, new Set([...h.right].filter(([, k]) => k === "add").map(([l]) => l)));
  return out;
}

function ciOf(f) {
  const file = join(f.ctxDir, "ci.json");
  return existsSync(file) ? ciState(readJson(file)) : { state: f.ci, line: null };
}

function ciState(c) {
  // A stale sha means the checks belong to another commit: CI of the pinned head is unknown (blocks APPROVE).
  if (c.stale) return { state: "unknown", line: "The CI state of this commit is unknown." };
  if (c.state === "red") return { state: "red", line: `Failed checks: ${c.items.filter((i) => i.state === "fail" || i.state === "cancel").map((i) => safeText(i.name)).join(", ")}.` };
  return { state: c.state, line: null };
}

async function once(o, restart) {
  const { repo, n, mode, gh, log, repoState } = o;
  const userPath = userConfigPath();
  const userConfig = config0({ userPath, cliPath: o.configPath }, o.maxDiffLines);
  let config = userConfig;
  const head = (await gh.pr(repo, n)).headSha;
  const runDir = pickRunDir(repoState, n, head, { restart });
  const runId = basename(runDir);
  const pst0 = prState(repoState, n);
  // Same sha, posted before: nothing new to say. Exceptions: --restart, answers that wait for a run, and the
  // posted run itself when it crashed before its bookkeeping ended (lastRunId).
  if (!restart && pst0.lastReviewedSha === head && pst0.lastRunId !== runId) {
    const answered = pendingAnswers(repoState).filter((q) => q.pr === n && !q.finding?.kind);
    if (answered.length) return followUp(o, head, pst0, answered);
    return { exit: 0, runDir, skipped: true, summary: `already reviewed ${head}; use --restart to review it again` };
  }
  const f = await o.frame({ repo, n, repoDir: o.repoDir ?? process.cwd(), runDir, config, gh, prState: prState(repoState, n) });
  config = config0({ userPath, cliPath: o.configPath, repoText: f.repoConfigText ?? undefined }, o.maxDiffLines);

  // A resumed run keeps its effort and lenses: its finished children depend on them.
  const runFile = join(runDir, "run.json");
  if (!existsSync(runFile)) {
    let effort = o.effort ?? (mode === "loop" ? config.loop.effort : config.effort);
    if (effort === "auto") effort = pickEffort(f.changedPaths, config);
    const lenses = LENSES.filter((l) => config.lenses[l].enabled && (!o.lenses || o.lenses.includes(l)));
    // A lens the user runs but this run skips (--lens, or off in the repo config) counts as failed: no APPROVE.
    // planned: the count for this run's merged config, which status shows.
    save(runFile, { effort, lenses, missing: LENSES.filter((l) => userConfig.lenses[l].enabled && !lenses.includes(l)), planned: plannedChildren(applyEffort(config, effort), lenses) });
  }
  const run = readJson(runFile);
  config = applyEffort(config, run.effort);
  const planned = run.planned ?? plannedChildren(config, run.lenses);
  log(`effort ${run.effort}: ${planned} children planned; seats ${config.seats.map(seatId).join(", ")}; judge ${seatId(config.judge)}`);

  const finish = (stage, extra = {}) => { markDone(runDir, FINAL_STAGE); return { exit: 0, runDir, planned, summary: `stopped after ${stage}`, ...extra }; };
  if (o.until === "frame") return finish("frame");

  // Round 1 (spec 6.2) and the hygiene check (6.3.1) run side by side.
  const ctx = { runDir, frame: f, runChild: o.runChild, routerUp: o.routerUp, config };
  const tools = f.trusted ? "shell" : "read";
  const jobs = round1Jobs(config, run.lenses);
  const hygFile = join(runDir, "hygiene-result.json");
  const [outs, hyg] = await settled([
    settled(jobs.map((j) => child(ctx, "round1", j.key, { seat: j.seat, tools, schema: "round1", lens: j.lenses.length === 1 ? j.lenses[0] : undefined, prompt: () => round1Prompt(f, j.lenses) }).then((v) => ({ ...j, v })))),
    existsSync(hygFile) ? readJson(hygFile) : o.hygiene(f, config, run.effort, { routerUp: o.routerUp }).then((h) => { save(hygFile, h); return h; }),
  ]);
  markDone(runDir, "round1");
  const bySeat = {}, earlier = new Map();
  for (const { seat, lenses, v } of outs) {
    const id = seatId(seat);
    (bySeat[id] ??= []).push(...v.findings.filter((x) => lenses.includes(x.lens)));
    for (const e of v.earlier ?? []) {
      const r = earlier.get(e?.thread_id) ?? { fixed: new Set(), open: new Set() };
      (e?.status === "fixed" ? r.fixed : r.open).add(id);
      earlier.set(e?.thread_id, r);
    }
  }
  const noTracking = outs.some((x) => x.v.no_tracking === true);
  const unanimousZero = outs.every((x) => x.v.findings.length === 0);
  if (o.until === "round1") return finish("round1");

  // Merge (spec 6.4, 7.5 rule 4): a cluster that reverses an earlier agreed finding is dropped and recorded.
  const pst = pst0;
  const raw = Object.values(bySeat).some((x) => x.length)
    ? await child(ctx, "merge", "merge", { seat: config.judge, schema: "merge", prompt: () => mergePrompt(f, bySeat, pst.agreed ?? []) })
    : [];
  const threads = readJson(join(f.ctxDir, "threads.json"));
  // Spec 6.4: a cluster repeats a thread of ours on the same line whose finding was agreed or settled before.
  // An outdated thread has no current line (originalLine is the old file), so it never matches.
  // shortcut: other reviewers' threads never drop a cluster; "a reviewer gave evidence against it" needs a judge call.
  const me = await gh.viewer();
  const known = new Set([...pst.settled, ...(pst.agreed ?? []).map((a) => a.id)]);
  const ours = threads.filter((t) => t.comments[0]?.author === me && t.line != null).map((t) => ({ t, key: MARKER_FP.exec(t.comments[0].body ?? "")?.[1] }));
  const resolvedThread = (c) => ours.some(({ t, key }) => t.path === c.file && t.line === c.line && key && (known.has(key) || key === c.fp));
  const all = raw.filter((c) => run.lenses.includes(c.lens)).map((c) => {
    const seats = [...new Set(seatsForLens(config, c.lens).map(seatId))];
    return { ...c, found: [...new Set(c.found)].filter((s) => seats.includes(s)), seats, fp: fingerprint(c) };
  });
  const reversed = all.filter((c) => c.reverses), linked = all.filter((c) => !c.reverses && resolvedThread(c));
  const { keep: clusters, dropped } = filterNew(all.filter((c) => !c.reverses && !resolvedThread(c)), {
    reviewNumber: f.reviewNumber, settled: new Set(pst.settled), changedLines: changedLines(f),
  });
  save(join(runDir, "clusters.json"), { clusters, reversed, linked, dropped });
  markDone(runDir, "merge");
  if (o.until === "merge") return finish("merge");

  // Round 2 (spec 6.5): one vote child per seat, on the clusters of its lenses that it did not find.
  const voters = [...new Map(run.lenses.flatMap((l) => seatsForLens(config, l)).map((s) => [seatId(s), s])).values()];
  const ballots = await settled(voters.map((seat, i) => {
    const id = seatId(seat), mine = clusters.filter((c) => c.seats.includes(id) && !c.found.includes(id));
    if (!mine.length) return { id, votes: [] };
    return child(ctx, "round2", `v~${i}`, { seat, tools, schema: "vote", prompt: () => votePrompt(f, mine.map(view)) }).then((votes) => ({ id, votes }));
  }));
  markDone(runDir, "round2");
  if (o.until === "round2") return finish("round2");

  const votesOf = (c) => ballots.flatMap((b) => b.votes.filter((v) => v.id === c.id).map((v) => ({ ...v, seat: b.id })));
  const tallied = clusters.map((c) => ({ c, votes: votesOf(c), status: tally({ cluster: c, votes: votesOf(c) }) }));
  save(join(runDir, "tally.json"), tallied.map(({ c, status }) => ({ id: c.id, fp: c.fp, status })));
  markDone(runDir, "tally");
  if (o.until === "tally") return finish("tally");

  // Decide (spec 6.7): jev settles splits; otherwise a question. A finding of one seat, or settled by jev, asks the author.
  const agreed = [], rejected = [], open = [], applied = [];
  // Marco's answers win over the tally, from this run or an earlier one (the loop posts without the finding).
  const answers = new Map(pendingAnswers(repoState).filter((q) => q.pr === n).map((q) => [q.fingerprint, q]));
  const repoDir = o.repoDir ?? process.cwd();
  const moved = (q) => {
    if (!codeMoved(repoDir, q, f.headSha)) return false;
    log(`question ${q.id}: the code at ${q.finding?.file}:${q.finding?.line} changed since ${q.sha}; its answer is dropped`);
    return true;
  };
  const take = (q, c) => {
    answers.delete(q.fingerprint);
    applied.push(q.id);
    if (q.answer === "drop") rejected.push(c);
    else agreed.push({ ...c, ask_author: q.answer === "ask-author", answered: q.answer });
  };
  for (const { c, votes, status } of tallied) {
    if (answers.has(c.fp)) {
      const q = answers.get(c.fp);
      if (!moved(q)) { take(q, c); continue; }
      // The answer was about other code: close it now, and let the tally (and jev or a fresh question) decide again.
      answers.delete(q.fingerprint);
      appliedAnswer(repoState, q.id);
    }
    if (status === "agreed") { agreed.push({ ...c, ask_author: c.found.length === 1 }); continue; }
    if (status === "rejected") { rejected.push(c); continue; }
    const dfile = join(runDir, "decide", `${c.fp}.json`);
    if (!existsSync(dfile)) {
      const snippet = hunk(f, c);
      const r = await o.decide(view(c), votes, snippet, config);
      // A signal killed jev: its "unsure" is not an answer. Save nothing; the rerun asks again.
      if (o.stopping()) throw new ChildFailed("engine is stopping on a signal");
      const d = { decision: r.decision, raw: r.raw ?? null };
      if (d.decision === "unsure") {
        d.question = queueQuestion(repoState, {
          pr: n, sha: f.headSha, fingerprint: c.fp, file: c.file, line: c.line, snippet, finding: view(c),
          sides: { keep: c.evidence || c.case, drop: votes.find((v) => v.vote === "drop" && v.counter_case?.trim())?.counter_case ?? "No seat gave a counter-case." },
          failure: c.case,
        });
      }
      save(dfile, d);
    }
    const d = readJson(dfile);
    if (d.decision === "agreed") agreed.push({ ...c, ask_author: true });
    else if (d.decision === "rejected") rejected.push(c);
    else open.push(d.question);
  }
  // An answered finding that this run did not find again is posted from the question record.
  // A held comment that was not found again has no text to post: its answer is closed.
  for (const q of [...answers.values()].filter((x) => x.finding?.secret)) { answers.delete(q.fingerprint); applied.push(q.id); }
  for (const q of [...answers.values()].filter((x) => !x.finding?.kind && moved(x))) { answers.delete(q.fingerprint); applied.push(q.id); }
  [...answers.values()].filter((q) => !q.finding?.kind).forEach((q, i) => take(q, { ...q.finding, id: `q${i + 1}`, found: [], seats: [], fp: q.fingerprint }));
  const questionFiles = () => open.map((id) => join(repoState, "questions", `${id}.md`));
  if (open.length && mode === "interactive") {
    return { exit: 3, runDir, planned, questions: questionFiles(), summary: `${open.length} question(s) wait for an answer: pr-review answer <id> post|drop|ask-author` };
  }
  markDone(runDir, "decide");
  if (o.until === "decide") return finish("decide");

  // Compose (spec 6.8, 5.1): drop findings outside the effort's severities and above its limit, lowest severity first.
  // A finding Marco answered "post" or "ask-author" is posted at any effort: he decided (it is not marked applied unposted).
  const allowed = new Set(config.post.severities);
  const forced = agreed.filter((c) => c.answered);
  const ranked = agreed.filter((c) => !c.answered && allowed.has(c.severity)).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const posted = [...forced, ...ranked.slice(0, Math.max(0, (config.post.maxFindings ?? Infinity) - forced.length))];
  const leftOut = agreed.length - posted.length;
  // Hygiene obeys the same severity floor and settled list as council findings (spec 7.5).
  const hygNew = filterNew(hyg.findings.map((h) => ({ ...h, file: "", line: null })), { reviewNumber: f.reviewNumber, settled: new Set(pst.settled), changedLines: new Map() }).keep;
  const hygItems = hygNew.filter((h) => allowed.has(h.severity)).map((h, i) => ({ ...h, id: `h${i + 1}`, fp: fingerprint(h) }));
  if (!restart && (pst.summaryBlocked?.[f.headSha] ?? 0) >= 2) {
    return { exit: 4, runDir, planned, summary: `the review summary was blocked by the secret scan twice at ${f.headSha}; see the question, or use --restart` };
  }
  // The held line is engine text, written at post time, so it also counts comments that the secret scan holds back.
  const composed = await child(ctx, "compose", "compose", {
    seat: config.judge, schema: "compose",
    prompt: () => composePrompt(f, [...posted, ...hygItems].map(view), readTree(join(f.ctxDir, "guidance")), { noTracking }),
  });
  markDone(runDir, "compose");
  if (o.until === "compose") return finish("compose");

  const text = new Map(composed.comments.map((x) => [x.id, x.body]));
  const items = posted.map((c) => ({ ...c, body: text.get(c.id) ?? `**${c.severity}:** ${c.title}\n\n${c.case}` }));
  const earlierAll = readJson(join(f.ctxDir, "earlier.json"));
  const fixed = earlierAll.filter((e) => { const r = earlier.get(e.threadId); return r && r.open.size === 0 && r.fixed.size >= 2; });
  let ci = ciOf(f);
  const v = () => verdict({
    agreed: [...agreed, ...hygItems], earlierMustOpen: earlierAll.filter((e) => e.severity === "must" && !fixed.includes(e)).length,
    openQuestions: open.length, splits: 0, failedLenses: run.missing?.length ?? 0, ci: ci.state, mode, trustedAuthor: f.trusted, unanimousZero, ownPr: f.ownPr,
  });
  const bodyOf = (outside, key) => [
    composed.body.trim(),
    outside.length ? `Outside the diff:\n${outside.map((l) => `- ${l}`).join("\n")}` : "",
    open.length ? `${open.length} ${open.length === 1 ? "point is" : "points are"} still open with the reviewer.` : "",
    leftOut ? `${leftOut} ${leftOut === 1 ? "finding was" : "findings were"} left out by the effort limit.` : "",
    run.missing?.length ? `Lenses not run: ${run.missing.join(", ")}.` : "",
    ci.line ?? "", marker(runId, f.headSha, key),
  ].filter(Boolean).join("\n\n");
  const hunks = parseHunks(readFileSync(join(f.ctxDir, "diff.patch"), "utf8"));
  const permalink = `https://github.com/${repo}/blob/${f.headSha}`;

  const warnings = (hyg.warnings ?? []).map((w) => `warning: ${w}`);
  if (o.dryRun) {
    const p = place(items.map((x) => ({ file: x.file, line: x.line, body: x.body })), hunks, permalink);
    const file = join(runDir, "review.md");
    writeFileSync(file, [`event: ${v().event}`, bodyOf(p.body, "dry-run"), ...p.inline.map((x) => `---\n${x.path}:${x.line}\n${x.body}`)].join("\n\n") + "\n");
    return finish("compose (dry run)", { dryRun: true, file, ...v(), summary: [`dry run: review written to ${file}; ${planned} children planned`, ...warnings].join("\n") });
  }

  // Post (spec 6.10). CI may have changed since frame: read it again; a failed read is unknown and blocks APPROVE.
  if (config.review.ci !== "ignore") {
    try { ci = ciState(await gh.checks(repo, n, f.headSha)); } catch (e) { log(`CI read failed: ${e.message}`); ci = ciState({ stale: true }); }
  }
  // Step 2: a moved head drops this run; review() frames again.
  const now = (await gh.pr(repo, n)).headSha;
  if (now !== f.headSha) throw new HeadMoved(f.headSha, now);
  const clean = [];
  for (const x of items) {
    // Marco answered "post" on a held comment: post it with the secret redacted. If it still hits, it stays out.
    const text = x.answered ? redact(x.body) : x.body;
    const s = scanOutbound(text);
    if (s.ok) { clean.push({ ...x, body: text }); continue; }
    if (x.answered) continue;
    // Held back. The question keeps the fingerprint and the rule ids only: never the text, which holds the secret.
    open.push(queueQuestion(repoState, {
      pr: n, sha: f.headSha, fingerprint: x.fp, file: x.file, line: x.line, snippet: "",
      finding: { lens: x.lens, severity: x.severity, file: x.file, line: x.line, title: "Comment held by the secret scan", case: `Secret rules: ${ruleIds(s.hits)}`, fix: "", secret: true },
      sides: { keep: "post: post the comment with the secret redacted.", drop: "drop: do not post this finding." }, failure: `Secret rules: ${ruleIds(s.hits)}`,
    }));
  }
  // Step 6 per finding: a key per sha and finding, so a crash, a --restart or a re-frame never posts a finding twice.
  const inlineKey = (x) => sha1(`inline\0${f.headSha}\0${x.fp}`);
  const fresh = [];
  const seen = await gh.markerKeys(repo, n); // one fetch for every check of this post phase
  for (const x of clean) if (!seen.has(inlineKey(x))) fresh.push(x);
  const p = place(fresh.map((x) => ({ file: x.file, line: x.line, body: `${x.body}\n\n${marker(runId, f.headSha, inlineKey(x), x.fp)}` })), hunks, permalink);
  const key = sha1(`review\0${runId}`);
  const body = bodyOf(p.body, key);
  const scan = scanOutbound(body);
  if (!scan.ok) {
    const st = prState(repoState, n);
    const tries = (st.summaryBlocked?.[f.headSha] ?? 0) + 1;
    savePrState(repoState, n, { ...st, summaryBlocked: { ...st.summaryBlocked, [f.headSha]: tries } });
    // Drop the cached summary so a rerun composes again; after 2 tries Marco decides.
    rmSync(join(runDir, "compose"), { recursive: true, force: true });
    rmSync(join(runDir, "compose.done"), { force: true });
    if (tries >= 2) {
      queueQuestion(repoState, {
        pr: n, sha: f.headSha, fingerprint: sha1(`summary\0${n}\0${f.headSha}`), file: "(review summary)", line: 0, snippet: "",
        finding: { kind: "summary-secret", title: "Review summary held by the secret scan", case: `Secret rules: ${ruleIds(scan.hits)}. Composed ${tries} times.` },
        sides: { keep: "post: not possible; run again with --restart after you check the PR text.", drop: "drop: skip this review." }, failure: "No review is posted at this commit.",
      });
    }
    return { exit: 4, runDir, planned, summary: `review summary blocked by the secret scan (${ruleIds(scan.hits)}), try ${tries}` };
  }
  const { event, queueApprove, reasons } = v();
  let url = null;
  // Step 6: GitHub is the source of truth; a marker hit means an earlier, interrupted run posted.
  if (!seen.has(key)) {
    if (await gh.pendingReview(repo, n)) {
      return { exit: 0, runDir, planned, skipped: true, summary: "skipped: you have a pending review on this PR; submit or delete it, then run again" };
    }
    url = (await gh.postReview(repo, n, { commitOID: f.headSha, event, body, threads: p.inline })).url;
  }
  // Same fingerprint and record as tick.mjs: a rerun (or the tick after it) finds the question and adds nothing.
  if (queueApprove) {
    queueQuestion(repoState, {
      pr: n, sha: f.headSha, fingerprint: sha1(`approve:${n}:${f.headSha}`), file: "(whole PR)", line: 0, snippet: "",
      finding: { kind: "approve", title: "Approve this PR?", case: `The review at ${f.headSha} has no agreed finding. The loop approves only a trusted author with a unanimous zero-finding vote. Reasons: ${reasons.join("; ")}.` },
      sides: { keep: "post: approve the PR at this commit.", drop: "drop: keep the review as a comment." },
      failure: "The PR waits for a human approval.",
    });
  }

  let st = prState(repoState, n);
  if (st.lastRunId !== runId) { // a rerun after a crash here must not count the review twice
    const fps = [...clean, ...rejected, ...hygItems].map((c) => c.fp);
    Object.assign(st, {
      reviews: st.reviews + 1, lastReviewedSha: f.headSha, lastRunId: runId, settled: [...new Set([...st.settled, ...fps])],
      agreed: [...(st.agreed ?? []), ...clean.map((c) => ({ id: c.fp, lens: c.lens, severity: c.severity, file: c.file, line: c.line, title: c.title }))],
    });
    savePrState(repoState, n, st);
  }

  // Spec 6.9: reply "Fixed in <sha>." and resolve. prState.resolved is the list reply.mjs reads too.
  for (const e of fixed) {
    st = prState(repoState, n);
    if ((st.resolved ?? []).includes(e.threadId)) continue;
    const k = sha1(`fixed\0${e.threadId}`);
    const msg = `Fixed in \`${f.headSha}\`.\n\n${marker(runId, f.headSha, k)}`;
    if (!scanOutbound(msg).ok) continue;
    if (!seen.has(k)) await gh.reply(repo, n, e.commentId, msg);
    if (threads.find((t) => t.id === e.threadId)?.viewerCanResolve) await gh.resolve(e.threadId);
    st.resolved = [...(st.resolved ?? []), e.threadId];
    savePrState(repoState, n, st);
  }
  markDone(runDir, FINAL_STAGE);
  for (const id of applied) appliedAnswer(repoState, id);
  return {
    // Interactive: a comment held by the secret scan is an open question, so exit 3. The rerun takes the answer-only path.
    exit: open.length && mode === "interactive" ? 3 : 0, runDir, planned, url, event, queueApprove, reasons, questions: questionFiles(),
    summary: [
      `${url ? `posted ${event}: ${url}` : "already posted (marker found on GitHub)"}; ${clean.length} inline finding(s)${open.length ? `; ${open.length} question(s) queued` : ""}`,
      ...warnings,
    ].join("\n"),
  };
}

// The text of a comment that an earlier run composed and the secret scan held back, redacted; null when gone.
function heldText(repoState, n, runId, fp) {
  const dir = join(repoState, "pr", String(n), "runs", runId ?? "");
  try {
    const c = readJson(join(dir, "clusters.json")).clusters.find((x) => x.fp === fp);
    const body = readJson(join(dir, "compose", "compose.json")).comments.find((x) => x.id === c?.id)?.body;
    return body ? redact(body) : null;
  } catch { return null; }
}

/**
 * Answers at a sha that was already reviewed: no pipeline and no new summary (spec 6.7).
 * "drop" only closes the question. "post" / "ask-author" go out as inline comments in one small COMMENT review,
 * whose key comes from the answered fingerprints, so a rerun never posts it twice.
 */
async function followUp(o, head, pst, answered) {
  const { repo, n, gh, repoState } = o;
  const items = [], already = [];
  // one fetch: an answered finding already posted inline at this head (an earlier follow-up that crashed
  // before appliedAnswer, or a later full run) is not posted again
  const seen = await gh.markerKeys(repo, n);
  for (const q of answered.filter((x) => x.answer !== "drop")) {
    if (seen.has(sha1(`inline\0${head}\0${q.fingerprint}`))) { already.push(q.fingerprint); continue; }
    if (codeMoved(o.repoDir ?? process.cwd(), q, head)) { o.log(`question ${q.id}: the code at ${q.finding?.file}:${q.finding?.line} changed since ${q.sha}; its answer is dropped`); continue; }
    const f = q.finding;
    const text = f.secret ? heldText(repoState, n, pst.lastRunId, q.fingerprint)
      : `**${f.severity}:** ${f.title}\n\n${f.case}${f.fix ? `\n\n${f.fix}` : ""}${q.answer === "ask-author" ? "\n\nCan you confirm this case?" : ""}`;
    if (text && scanOutbound(text).ok) items.push({ q, text });
  }
  let url = null;
  if (items.length) {
    const fps = items.map((x) => x.q.fingerprint).sort();
    const key = sha1(`followup\0${head}\0${fps.join(",")}`);
    const runId = pst.lastRunId ?? "followup";
    const diff = join(repoState, "pr", String(n), "runs", runId, "ctx", "diff.patch");
    const hunks = parseHunks(existsSync(diff) ? readFileSync(diff, "utf8") : "");
    const p = place(items.map(({ q, text }) => ({ file: q.finding.file, line: q.finding.line, body: `${text}\n\n${marker(runId, head, sha1(`inline\0${head}\0${q.fingerprint}`), q.fingerprint)}` })), hunks, `https://github.com/${repo}/blob/${head}`);
    const body = [`Follow-up on the review of ${head}: points settled by the maintainer.`, p.body.length ? p.body.map((l) => `- ${l}`).join("\n") : "", marker(runId, head, key)].filter(Boolean).join("\n\n");
    if (!scanOutbound(body).ok) return { exit: 4, skipped: true, summary: "follow-up blocked by the secret scan" };
    if (!seen.has(key)) {
      if (await gh.pendingReview(repo, n)) return { exit: 0, skipped: true, summary: "skipped: you have a pending review on this PR; submit or delete it, then run again" };
      url = (await gh.postReview(repo, n, { commitOID: head, event: "COMMENT", body, threads: p.inline })).url;
    }
    const st = prState(repoState, n);
    st.settled = [...new Set([...st.settled, ...fps])];
    savePrState(repoState, n, st);
  }
  if (already.length) {
    const st = prState(repoState, n);
    st.settled = [...new Set([...st.settled, ...already])];
    savePrState(repoState, n, st);
  }
  for (const q of answered) appliedAnswer(repoState, q.id);
  return {
    exit: 0, skipped: !items.length, url, event: items.length ? "COMMENT" : undefined, queueApprove: false, reasons: [],
    summary: items.length ? `follow-up posted with ${items.length} answered finding(s)${url ? `: ${url}` : " (marker found on GitHub)"}` : `answers applied at ${head}; nothing to post`,
  };
}
