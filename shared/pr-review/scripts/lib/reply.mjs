// Reply flow for one review thread (spec 7.2, 7.3, 7.5 rule 6).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, appendFileSync, constants, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as github from "./github.mjs";
import { runChild as realRunChild, ENV_OK } from "./child.mjs";
import { budgetLeft } from "./convergence.mjs";
import { prData, replyPrompt, seatData } from "./prompts.mjs";
import { redact, scanOutbound } from "./secrets.mjs";
import { prState, savePrState, stateRoot } from "./state.mjs";

const CORRECT = "The last comment in this thread, by the other party, is correct about this code.";
const NEW_ARG = "This reply adds a new argument or new evidence.";
// On public repos every user has "read" (Task 8 note).
const COLLABORATOR = new Set(["write", "admin"]);

const executable = (f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };

// shortcut: same jev lookup and R22 rule as decider.decide (Task 11a, not on this branch); fold into one helper when both land.
/** Ask jev a yes/no question about text. -> "yes" | "no" | "unsure" */
export function askJev(question, text, config, { env = process.env, timeoutMs = 60000, skillDir } = {}) {
  const { kind, confidence } = config.decider;
  if (kind === "off") return Promise.resolve("unsure");
  skillDir ??= realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const sibling = join(skillDir, "..", "jev", "bin", "jev");
  const bin = executable(sibling) ? sibling : (env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, "jev")).find(executable);
  if (!bin) return Promise.resolve("unsure");
  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([k]) => ENV_OK.test(k)));
  const args = ["ask", question, "--json", ...(confidence > 0 ? ["--confidence", String(confidence)] : [])];
  return new Promise((resolve) => {
    let out = "", settled = false;
    const p = spawn(bin, args, { env: cleanEnv, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    const killGroup = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
    const end = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { killGroup(); end("unsure"); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stdin.on("error", () => {});
    p.on("error", () => end("unsure"));
    p.on("close", (code) => {
      let v = null;
      try { v = JSON.parse(out).verdict; } catch {}
      killGroup();
      // R22: settle only when the verdict agrees with the exit code.
      end(code === 0 && ["yes", "doubted"].includes(v) ? "yes" : code === 1 && ["no", "trusted"].includes(v) ? "no" : "unsure");
    });
    p.stdin.end(redact(text));
  });
}

const family = (s) => `${s.harness}|${s.model.split("/")[0]}`;
const threadData = (t) => prData(JSON.stringify(t.comments.map((c) => ({ author: c.author, body: c.body })), null, 2), "the PR and its commenters");
const isSkip = (b) => b.replace(/[`\p{P}\s]/gu, "").toUpperCase() === "SKIP";

/**
 * Answer the newest human comment of one review thread.
 * Extra inputs: frame (from frame()), config, runDir; injectable gh, runChild, jev, queue; routerUp (R1).
 * queue(item) gets { kind: "reply", reason, pr, sha, threadId, commentId, path, line, mode, positions?, hits? }.
 * -> { action: "replied"|"queued"|"skipped", resolved, queued: [items] }
 */
export async function reply({ repo, n, threadId, mode, frame, config, runDir, gh = github, runChild = realRunChild, jev, queue = () => {}, routerUp }) {
  jev ??= (q, text) => askJev(q, text, config);
  const queued = [];
  const t = (await gh.threads(repo, n)).find((x) => x.id === threadId);
  if (!t) throw new Error(`thread ${threadId} not found on ${repo}#${n}`);
  const me = await gh.viewer();
  const last = t.comments.at(-1);
  const result = (action, resolved = false) => ({ action, resolved, queued });
  const enqueue = (reason, extra = {}) => {
    const item = { kind: "reply", reason, pr: n, sha: frame.headSha, threadId, commentId: last.id, path: t.path, line: t.line ?? t.originalLine, mode, ...extra };
    queued.push(item);
    queue(item);
    return result("queued");
  };
  const repoState = stateRoot(repo);

  // Crash after the post, before the bookkeeping: GitHub has the reply, so only finish the state.
  const pending = prState(repoState, n).pending?.[threadId];
  if (pending) {
    if (await gh.findMarker(repo, n, pending.key)) return result("replied", await finish(pending));
    const s = prState(repoState, n);
    delete s.pending[threadId];
    savePrState(repoState, n, s);
  }

  // Rule 7.3: only a new human comment gets an answer; our own last comment means it was answered.
  if (!last || last.author === me || last.authorType === "Bot" || config.loop.authors_ignore.includes(last.author)) return result("skipped");
  // A resolved thread reopens for us only when someone answers our reply.
  const mine = t.comments.findLast((x) => x.author === me);
  if (t.isResolved && !mine) return result("skipped");
  if (!COLLABORATOR.has(await gh.permission(repo, last.author))) return enqueue("not-collaborator");
  if (!budgetLeft(prState(repoState, n), config).replies(threadId)) {
    return enqueue("budget", { positions: [
      { side: "ours", commentId: mine?.id ?? null, body: mine?.body ?? null },
      { side: "theirs", author: last.author, commentId: last.id, body: last.body },
    ] });
  }

  const dir = join(runDir, "reply", encodeURIComponent(threadId), String(last.id));
  mkdirSync(dir, { recursive: true });
  const seat = async (role, s, draft) => {
    const promptFile = join(dir, `${role}.prompt`);
    writeFileSync(promptFile, replyPrompt(frame, t, role, draft));
    return runChild({ seat: s, promptFile, outFile: join(dir, `${role}.json`), worktree: frame.worktree, schema: "reply", routerUp });
  };

  const drafter = config.seats[0];
  const challenger = config.seats.find((s) => family(s) !== family(drafter));
  if (!challenger) return enqueue("no-challenger");
  const d = await seat("draft", drafter);
  const c = await seat("challenge", challenger, { position: d.position, body: d.body });
  let position = d.position;
  if (c.position !== d.position) {
    // The question is about the other party's comment, so yes = accept for our side on any PR.
    const role = frame.ownPr ? "the reviewer" : "the PR author";
    const v = await jev(CORRECT, [
      `The other party is ${last.author}, ${role}. We are ${me}. The last comment in the thread below is by the other party.`,
      threadData(t), seatData(JSON.stringify([d, c], null, 2)),
    ].join("\n"));
    position = v === "yes" ? "accept" : v === "no" ? "push_back" : null;
    // Own PR: a split never concedes by default; jev must pick a side a seat argued, else Marco decides.
    if (!position || ![d, c].some((x) => x.position === position)) return enqueue("unsure", { positions: [d, c] });
  }
  const agreed = [d, c].find((x) => x.position === position);
  const body = (await seat("compose", config.judge, { position, body: agreed.body })).body.trim();
  // The judge (SKIP) or jev finds a repeat: it goes to Marco, not to the thread (7.5 rule 7).
  if (isSkip(body) || (mine && (await jev(NEW_ARG, `${threadData(t)}\n${seatData(body)}`)) === "no")) {
    enqueue("repeat", { positions: [d, c] });
    return result("skipped");
  }

  const key = `key=${createHash("sha1").update(`reply\0${threadId}\0${last.id}`).digest("hex")}`;
  const full = `${body}\n\n<!-- pr-review run=${basename(runDir)} sha=${frame.headSha} ${key} -->`;
  const scan = scanOutbound(full);
  if (!scan.ok) return enqueue("secret", { hits: scan.hits });

  const rec = {
    key, position,
    // Engine text only: no model or reviewer words in todo.md.
    todo: position === "accept" && frame.ownPr ? `- [ ] PR #${n} ${t.path}:${t.line ?? t.originalLine}: accepted review point, change pending. https://github.com/${repo}/pull/${n}#discussion_r${last.id}\n` : null,
    // Resolve only threads Marco started; an accept on his own PR waits for the fix in the head.
    resolve: position === "accept" && !frame.ownPr && t.comments[0].author === me && !t.isResolved,
  };
  const s = prState(repoState, n);
  s.pending = { ...s.pending, [threadId]: rec };
  savePrState(repoState, n, s);
  // GitHub has no replies to replies: answer on the first comment.
  if (!(await gh.findMarker(repo, n, key))) await gh.reply(repo, n, t.comments[0].id, full);
  return result("replied", await finish(rec));

  async function finish(p) {
    const st = prState(repoState, n);
    st.replies = { ...st.replies, [threadId]: (st.replies[threadId] ?? 0) + 1 };
    if (p.todo) {
      mkdirSync(repoState, { recursive: true });
      appendFileSync(join(repoState, "todo.md"), p.todo);
    }
    let resolved = false;
    // A thread in st.resolved that is open again was reopened by a human: leave it.
    if (p.resolve && t.viewerCanResolve && !(st.resolved ?? []).includes(threadId)) {
      await gh.resolve(threadId);
      st.resolved = [...(st.resolved ?? []), threadId];
      resolved = true;
    }
    delete st.pending[threadId];
    savePrState(repoState, n, st);
    return resolved;
  }
}
