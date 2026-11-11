import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./state.mjs";

export const OPTIONS = ["post", "drop", "ask-author"];
const dir = (repoState) => join(repoState, "questions");
const jsonFile = (repoState, id) => join(dir(repoState), `${id}.json`);

function load(repoState, id) {
  if (!/^[\w-]+$/.test(id) || !existsSync(jsonFile(repoState, id))) throw new Error(`unknown question ${id}`);
  return JSON.parse(readFileSync(jsonFile(repoState, id), "utf8"));
}
const save = (repoState, q) => writeAtomic(jsonFile(repoState, q.id), JSON.stringify(q, null, 2) + "\n");

function markdown(q, { file, line, snippet, failure }) {
  const f = q.finding;
  return `# Question ${q.id}

PR #${q.pr} at ${q.sha}
Location: ${file}:${line}

\`\`\`
${snippet}
\`\`\`

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

/** q: { pr, sha, fingerprint, file, line, snippet, finding, sides: {keep, drop}, failure }. Same id twice keeps the first. */
export function queueQuestion(repoState, q) {
  const id = `${q.pr}-${q.fingerprint.slice(0, 8)}`;
  if (existsSync(jsonFile(repoState, id))) return id;
  const rec = {
    id, pr: q.pr, sha: q.sha, fingerprint: q.fingerprint, finding: q.finding, sides: q.sides,
    options: [...OPTIONS], createdAt: new Date().toISOString(), askedAt: null, answer: null, answeredAt: null,
  };
  writeAtomic(join(dir(repoState), `${id}.md`), markdown(rec, q));
  save(repoState, rec);
  return id;
}

const all = (repoState) => {
  if (!existsSync(dir(repoState))) return [];
  return readdirSync(dir(repoState)).filter((f) => f.endsWith(".json"))
    .map((f) => load(repoState, f.slice(0, -5)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
};

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
