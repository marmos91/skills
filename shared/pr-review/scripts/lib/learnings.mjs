// .pr-review/learnings.md: one "- <learn key> <reason>" line per finding the author or the user rejected.
// The council reads the copy on the base branch and the local one in the state folder. New lines go only to the
// local one: committing them to the base branch is the user's call.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact, scanOutbound } from "./secrets.mjs";
import { writeAtomic } from "./state.mjs";

export const LEARNINGS = ".pr-review/learnings.md";
const local = (repoState) => join(repoState, "learnings.md");
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const KEY = /^[0-9a-f]{40}$/;

/** The learned keys in the base-branch text and the local file. */
export const learnedKeys = (repoState, baseText) =>
  new Set([...`${baseText ?? ""}\n${read(local(repoState))}`.matchAll(/^- ([0-9a-f]{40})\b/gm)].map((m) => m[1]));

/** The fp= and learn= lists of the engine marker, which ends the body: a look-alike in the text above it is not read. */
export function parseMarker(body) {
  const m = /<!-- pr-review run=\S+ sha=\S+ key=[0-9a-f]{40}(?: learn=([0-9a-f]{40}(?:,[0-9a-f]{40})*))? fp=([0-9a-f]{40}(?:,[0-9a-f]{40})*) -->\s*$/.exec(body ?? "");
  return { learn: m?.[1]?.split(",") ?? [], fps: m?.[2].split(",") ?? [] };
}

/** Model text of a posted comment with < and > escaped, so it renders as written but holds no markup or look-alike
 * marker. Code spans and fences keep theirs: an entity there shows as text, and a suggestion must stay valid code.
 * A backslash-escaped backtick is a literal (GitHub renders it so), never a span delimiter; a span may cross one
 * newline, not a blank line. */
export const noMarkup = (s) => String(s ?? "").split(/((?<!\\)```[\s\S]*?```|(?<!\\)`(?:[^`\n]|\n(?![ \t]*\n))*`)/).map((x, i) => (i % 2 ? x : x.replace(/</g, "&lt;").replace(/>/g, "&gt;"))).join("");

/** Adds the keys to the local file. A reason the secret scan holds is left out. -> the new lines, to suggest for the base branch. */
export function learn(repoState, keys, reason, repo) {
  let why = redact(String(reason ?? "").replace(/\s+/g, " ").trim());
  if (why && !scanOutbound(why, { repo }).ok) why = "";
  const have = learnedKeys(repoState);
  const lines = [...new Set(keys)].filter((k) => KEY.test(k) && !have.has(k)).map((k) => `- ${k} ${why}`.trim());
  if (lines.length) writeAtomic(local(repoState), `${read(local(repoState))}${lines.join("\n")}\n`);
  return lines;
}

/** Removes a key from the local file. -> true when it was there. The base-branch copy is the user's to edit. */
export function forget(repoState, key) {
  const text = read(local(repoState));
  const kept = text.split("\n").filter((l) => !l.startsWith(`- ${key}`));
  if (kept.length === text.split("\n").length) return false;
  writeAtomic(local(repoState), kept.join("\n"));
  return true;
}

export const suggestion = (lines) => `add to ${LEARNINGS} on the base branch so every review skips them:\n${lines.join("\n")}`;
