// .pr-review/learnings.md: one "- <fingerprint> <reason>" line per finding the author or the user rejected.
// The council reads the copy on the base branch and the local one in the state folder. New lines go only to the
// local one: committing them to the base branch is the user's call.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { redact } from "./secrets.mjs";
import { writeAtomic } from "./state.mjs";

export const LEARNINGS = ".pr-review/learnings.md";
const local = (repoState) => join(repoState, "learnings.md");
const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

/** The learned fingerprints in the base-branch text and the local file. */
export const learnedFps = (repoState, baseText) =>
  new Set([...`${baseText ?? ""}\n${read(local(repoState))}`.matchAll(/^- ([0-9a-f]{40})\b/gm)].map((m) => m[1]));

/** The fp= list of a pr-review comment marker (the council's inline comments). */
export const markerFps = (body) => /<!-- pr-review run=\S+ sha=\S+ key=[0-9a-f]{40} fp=([0-9a-f,]+) -->/.exec(body ?? "")?.[1].split(",").filter(Boolean) ?? [];

/** Adds the fingerprints to the local file. -> the new lines, to suggest for the base branch. */
export function learn(repoState, fps, reason) {
  const have = learnedFps(repoState), why = redact(String(reason ?? "").replace(/\s+/g, " ").trim());
  const lines = [...new Set(fps)].filter((fp) => /^[0-9a-f]{40}$/.test(fp) && !have.has(fp)).map((fp) => `- ${fp} ${why}`.trim());
  if (lines.length) writeAtomic(local(repoState), `${read(local(repoState))}${lines.join("\n")}\n`);
  return lines;
}

export const suggestion = (lines) => `add to ${LEARNINGS} on the base branch so every review skips them:\n${lines.join("\n")}`;
