import { createHash } from "node:crypto";

// No line number: a moved finding must keep its fingerprint. Only digits and punctuation leave the title.
const norm = (s) => String(s ?? "").toLowerCase().replace(/[\d\p{P}]/gu, "").replace(/\s+/g, " ").trim();

export function fingerprint(f) {
  // A title of only digits and punctuation normalizes to "": the case, digits kept, keeps such findings apart.
  const kase = String(f.case ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const title = norm(f.title) || (kase ? `\u0001${kase}` : `\u0002${f.title}`);
  return createHash("sha1").update([f.lens, f.file, f.symbol ?? "", title].join("\u0000")).digest("hex");
}

export function allowedSeverities(reviewNumber) {
  return new Set(reviewNumber <= 1 ? ["must", "should", "nit"] : reviewNumber === 2 ? ["must", "should"] : ["must"]);
}

export function filterNew(findings, { reviewNumber, settled, changedLines }) {
  const allowed = allowedSeverities(reviewNumber);
  const keep = [];
  const dropped = [];
  for (const finding of findings) {
    if (!allowed.has(finding.severity)) dropped.push({ finding, reason: "severity floor" });
    else if (settled.has(fingerprint(finding)) && !changedLines.get(finding.file)?.has(finding.line)) dropped.push({ finding, reason: "settled" });
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
