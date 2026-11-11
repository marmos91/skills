import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./state.mjs";
import { redact } from "./secrets.mjs";

export const OPTIONS = ["post", "drop", "ask-author"];
const ID = /^[\w-]+$/;
const dir = (repoState) => join(repoState, "questions");
const jsonFile = (repoState, id) => join(dir(repoState), `${id}.json`);

function load(repoState, id) {
  if (!ID.test(id) || !existsSync(jsonFile(repoState, id))) throw new Error(`unknown question ${id}`);
  return JSON.parse(readFileSync(jsonFile(repoState, id), "utf8"));
}
const save = (repoState, q) => writeAtomic(jsonFile(repoState, q.id), JSON.stringify(q, null, 2) + "\n");

function markdown(q, { file, line, snippet, failure }) {
  const f = q.finding;
  const fence = "`".repeat(Math.max(3, ...[...snippet.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `# Question ${q.id}

PR #${q.pr} at ${q.sha}
Location: ${file}:${line}

${fence}
${snippet}
${fence}

## Finding
${f.title}

${f.case}${f.fix ? `\n\nFix: ${f.fix}` : ""}

## Best argument to keep it
${q.sides.keep}

## Best argument to drop it
${q.sides.drop}

## Failure example
${failure}

## Options
${OPTIONS.map((o) => `- ${o}`).join("\n")}
`;
}

/**
 * q: { pr, sha, fingerprint, file, line, snippet, finding, sides: {keep, drop}, failure }. Same id twice keeps the first,
 * except a review finding whose earlier question was answered and applied: it comes back as a fresh question.
 */
export function queueQuestion(repoState, q) {
  const id = `${q.pr}-${q.fingerprint.slice(0, 8)}`;
  if (existsSync(jsonFile(repoState, id))) {
    const old = load(repoState, id);
    if (old.finding?.kind || !old.appliedAt) return id;
  }
  const r = (x) => (typeof x === "string" ? redact(x) : x);
  const finding = Object.fromEntries(Object.entries(q.finding).map(([k, v]) => [k, r(v)]));
  const sides = { keep: r(q.sides.keep), drop: r(q.sides.drop) };
  q = { ...q, snippet: r(q.snippet), failure: r(q.failure), finding, sides };
  const rec = {
    id, pr: q.pr, sha: q.sha, fingerprint: q.fingerprint, finding: q.finding, sides: q.sides,
    options: [...OPTIONS], createdAt: new Date().toISOString(), askedAt: null, answer: null, answeredAt: null,
  };
  writeAtomic(join(dir(repoState), `${id}.md`), markdown(rec, q));
  save(repoState, rec);
  return id;
}

/** Bad files are skipped, never thrown; pass `warnings` to collect why. */
const all = (repoState, warnings = []) => {
  if (!existsSync(dir(repoState))) return [];
  const out = [];
  for (const f of readdirSync(dir(repoState)).filter((f) => f.endsWith(".json"))) {
    const id = f.slice(0, -5);
    try {
      if (!ID.test(id)) throw new Error("bad name");
      const q = JSON.parse(readFileSync(jsonFile(repoState, id), "utf8"));
      if (q?.id !== id || typeof q.createdAt !== "string") throw new Error("missing id or createdAt");
      out.push(q);
    } catch (e) { warnings.push(`questions/${f}: ${e.message}`); }
  }
  return out
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
};
export const questionWarnings = (repoState) => { const w = []; all(repoState, w); return w; };

export const openQuestions = (repoState) => all(repoState).filter((q) => q.answer === null);

/** Answered and not yet applied by a run. */
export const pendingAnswers = (repoState) => all(repoState).filter((q) => q.answer !== null && !q.appliedAt);

export function answer(repoState, id, option) {
  if (!OPTIONS.includes(option)) throw new Error(`option must be one of ${OPTIONS.join("|")}, got ${option}`);
  const q = load(repoState, id);
  save(repoState, Object.assign(q, { answer: option, answeredAt: new Date().toISOString() }));
  return q;
}

export function markAsked(repoState, ids) {
  for (const id of ids) {
    const q = load(repoState, id);
    if (!q.askedAt) save(repoState, Object.assign(q, { askedAt: new Date().toISOString() }));
  }
}

export function appliedAnswer(repoState, id) {
  const q = load(repoState, id);
  if (q.answer === null) throw new Error(`question ${id} is not answered`);
  if (!q.appliedAt) save(repoState, Object.assign(q, { appliedAt: new Date().toISOString() }));
  return q;
}
