import { createHash } from "node:crypto";

// No line number: a moved finding must keep its fingerprint (R13).
export function fingerprint(f) {
  const title = f.title.toLowerCase().replace(/[\d\p{P}\p{S}]/gu, "").replace(/\s+/g, " ").trim();
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
