import { createHash } from "node:crypto";

// No line number: a moved finding must keep its fingerprint. Only digits and punctuation leave the title.
const norm = (s) => String(s ?? "").toLowerCase().replace(/[\d\p{P}]/gu, "").replace(/\s+/g, " ").trim();

export function fingerprint(f) {
  // A title of only digits and punctuation normalizes to "": the case, digits kept, keeps such findings apart.
  const kase = String(f.case ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const title = norm(f.title) || (kase ? `\u0001${kase}` : `\u0002${f.title}`);
  return createHash("sha1").update([f.lens, f.file, f.symbol ?? "", title].join("\u0000")).digest("hex");
}

// The key of a rejected finding (learnings.mjs): the fingerprint inputs with the title's digits kept, so
// "null check at line 3" and "at line 40" stay apart. A block across PRs must not catch a neighbour.
export function learnKey(f) {
  const title = String(f.title ?? "").toLowerCase().replace(/\p{P}/gu, "").replace(/\s+/g, " ").trim();
  return createHash("sha1").update(["learn", f.lens, f.file, f.symbol ?? "", title].join("\u0000")).digest("hex");
}

// Stores (settled list, questions) key a finding by fingerprint and line: 2 findings with one title at 2 lines of
// a file stay 2. A bare fingerprint in an older settled list still matches.
export const findingKey = (fp, line) => `${fp}:${line}`;

// A settled entry is the fp with its code anchor: the trimmed text of the finding's line. A moved line keeps its
// anchor, so it stays settled; another instance of the fp on other code is new. With no anchor (a blank line, a
// file the engine cannot read) the entry is fp:line, like the entries an older engine wrote.
export const settledKey = (fp, line, anchor) => (anchor ? `${fp}@${createHash("sha1").update(anchor).digest("hex").slice(0, 16)}` : findingKey(fp, line));
const isSettled = (settled, fp, line, anchor) => settled.has(fp) || settled.has(findingKey(fp, line)) || settled.has(settledKey(fp, line, anchor));

export function allowedSeverities(reviewNumber) {
  return new Set(reviewNumber <= 1 ? ["must", "should", "nit"] : reviewNumber === 2 ? ["must", "should"] : ["must"]);
}

// learned: learn keys rejected on any PR of the repo (learnings.mjs). Dropped wherever they are, changed lines too.
// anchor(file, line): the trimmed text of that line at the head ("" when unknown).
export function filterNew(findings, { reviewNumber, settled, changedLines, learned = new Set(), anchor = () => "" }) {
  const allowed = allowedSeverities(reviewNumber);
  const keep = [];
  const dropped = [];
  for (const finding of findings) {
    if (!allowed.has(finding.severity)) dropped.push({ finding, reason: "severity floor" });
    else if (learned.has(learnKey(finding))) dropped.push({ finding, reason: "learned" });
    else if (isSettled(settled, fingerprint(finding), finding.line, anchor(finding.file, finding.line)) && !changedLines.get(finding.file)?.has(finding.line)) dropped.push({ finding, reason: "settled" });
    else keep.push(finding);
  }
  return { keep, dropped };
}

export function budgetLeft(prState, config) {
  return {
    review: prState.reviews < config.loop.max_review_rounds,
    replies: (threadId) => (prState.replies[threadId] ?? 0) < config.loop.max_replies_per_thread,
  };
}
