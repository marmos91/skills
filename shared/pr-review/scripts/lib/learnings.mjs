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

// Code in Markdown: a fence of 3+ ` or ~ after 0-3 spaces at line start, closed by the same char at least as long
// (else it runs to the end; a ``` info string has no backtick), or an inline span on one line. A backslash-escaped backtick is a literal.
// shortcut: a span of 2+ backticks is not code here (its < shows as &lt;); match backtick runs if that matters.
const CODE = /(?<![^\n]) {0,3}((`|~)\2{2,})(?:(?<=`)[^\n`]*|(?<=~)[^\n]*)(?=\n|$)(?:\n[\s\S]*?)?(?:\n {0,3}\1\2*[ \t]*(?=\n|$)|$)|(?<![\\`])`[^`\n]*`(?!`)/g;
const esc = (t) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Model text of a posted comment with < and > escaped outside code, so it renders as written but holds no markup or
 * look-alike marker. Code keeps them: an entity there shows as text, and a suggestion must stay valid code. */
export function noMarkup(s) {
  s = String(s ?? "");
  let out = "", at = 0;
  for (const m of s.matchAll(CODE)) { out += esc(s.slice(at, m.index)) + m[0]; at = m.index + m[0].length; }
  return out + esc(s.slice(at));
}

/** The text with its code removed: a marker quoted in code is not a marker. */
export const outsideCode = (s) => String(s ?? "").replace(CODE, "");

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
