// .pr-review/learnings.md: one "- <learn key> <reason>" line per finding the author or the user rejected.
// The council reads the copy on the base branch and the local one in the state folder. New lines go only to the
// local one: committing them to the base branch is the user's call.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./secrets.mjs";
import { writeAtomic } from "./state.mjs";

export const LEARNINGS = ".pr-review/learnings.md";
const local = (repoState) => join(repoState, "learnings.md");
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");
const KEY = /^[0-9a-f]{40}$/;

/** The learned keys in the base-branch text and the local file. */
export const learnedKeys = (repoState, baseText) =>
  new Set([...`${baseText ?? ""}\n${read(local(repoState))}`.matchAll(/^- ([0-9a-f]{40})\b/gm)].map((m) => m[1]));

/** The fp= and learn= lists of a pr-review comment marker (the council's inline comments). */
export function parseMarker(body) {
  const m = /<!-- pr-review run=\S+ sha=\S+ key=[0-9a-f]{40}(?: learn=([0-9a-f]{40}(?:,[0-9a-f]{40})*))? fp=([0-9a-f]{40}(?:,[0-9a-f]{40})*) -->/.exec(body ?? "");
  return { learn: m?.[1]?.split(",") ?? [], fps: m?.[2].split(",") ?? [] };
}

/** Adds the keys to the local file. -> the new lines, to suggest for the base branch. */
export function learn(repoState, keys, reason) {
  const have = learnedKeys(repoState), why = redact(String(reason ?? "").replace(/\s+/g, " ").trim());
  const lines = [...new Set(keys)].filter((k) => KEY.test(k) && !have.has(k)).map((k) => `- ${k} ${why}`.trim());
  if (lines.length) writeAtomic(local(repoState), `${read(local(repoState))}${lines.join("\n")}\n`);
  return lines;
}

/** Removes the keys from the local file (an answer changed from drop). */
export function unlearn(repoState, keys) {
  const text = read(local(repoState));
  const kept = text.split("\n").filter((l) => !keys.some((k) => l.startsWith(`- ${k}`))).join("\n");
  if (kept !== text) writeAtomic(local(repoState), kept);
}

export const suggestion = (lines) => `add to ${LEARNINGS} on the base branch so every review skips them:\n${lines.join("\n")}`;
