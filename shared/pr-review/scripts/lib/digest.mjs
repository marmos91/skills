// Daily digest (issue #15): the open questions and todo.md as one plain-text message, sent through digest.command.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openQuestions } from "./questions.mjs";
import { writeAtomic } from "./state.mjs";

const DAY = 24 * 3600e3;
const prUrl = (repo, n) => `https://github.com/${repo}/pull/${n}`;

/** The message, or "" when no question is open and todo.md has no open item. Titles are redacted at queue time. */
export function digestText(repo, rs) {
  const qs = openQuestions(rs);
  const todoFile = join(rs, "todo.md");
  const todo = existsSync(todoFile) ? readFileSync(todoFile, "utf8").trim() : "";
  const todos = todo.match(/^- \[ \].*$/gm) ?? [];
  if (!qs.length && !todos.length) return "";
  const lines = [`pr-review-loop digest for ${repo}`];
  if (qs.length) lines.push("", `${qs.length} open question(s). Answer with "pr-review-loop answer".`);
  for (const q of qs) {
    lines.push(`- ${q.id}: PR #${q.pr}: ${q.finding?.title ?? "(no title)"}`, `  ${prUrl(repo, q.pr)}`);
    if (q.finding?.commentId) lines.push(`  ${prUrl(repo, q.pr)}#discussion_r${q.finding.commentId}`);
    lines.push(`  ${join(rs, "questions", `${q.id}.md`)}`);
  }
  if (todos.length) lines.push("", `${todos.length} to-do item(s) in ${todoFile}:`, ...todos);
  return lines.join("\n") + "\n";
}

/**
 * Once a day, pipe the digest to config.digest.command (the user's own command; never logged). Runs under the tick lock.
 * The send time is saved only after the command exits 0, so a failed send is retried on the next tick.
 */
export function sendDigest({ repo, rs, config, now = Date.now, log = () => {} }) {
  const command = config.digest?.command;
  if (!command) return false;
  const file = join(rs, "digest.json");
  let last = 0;
  try { last = Date.parse(JSON.parse(readFileSync(file, "utf8")).sentAt) || 0; } catch {}
  if (now() - last < DAY) return false;
  const text = digestText(repo, rs);
  if (!text) return false;
  const r = spawnSync("sh", ["-c", command], { input: text, stdio: ["pipe", "ignore", "ignore"], timeout: 60000 });
  // only the exit: the command's output may carry its webhook or token
  if (r.status !== 0) { log(`digest: digest.command failed (${r.error ? r.error.code : `exit ${r.status ?? r.signal}`}); retried next tick`); return false; }
  writeAtomic(file, JSON.stringify({ sentAt: new Date(now()).toISOString() }) + "\n");
  log("digest: sent");
  return true;
}
