import { createHash } from "node:crypto";

// No line number: a moved finding must keep its fingerprint. Only digits and punctuation leave the title.
const norm = (s) => String(s ?? "").toLowerCase().replace(/[\d\p{P}]/gu, "").replace(/\s+/g, " ").trim();

export function fingerprint(f) {
  // A title of only digits and punctuation normalizes to "": the case keeps such findings apart.
  const title = norm(f.title) || `\u0001${norm(f.case)}`;
  return createHash("sha1").update([f.lens, f.file, f.symbol ?? "", title].join("\u0000")).digest("hex");
}

export function allowedSeverities(reviewNumber) {
  return new Set(reviewNumber <= 1 ? ["must", "should", "nit"] : reviewNumber === 2 ? ["must", "should"] : ["must"]);
}

// A multi-line finding (start_line..line, as GitHub ranges) reopens when any line of its range changed.
const touched = (f, lines) => [...(lines ?? [])].some((l) => l >= (f.start_line ?? f.line) && l <= f.line);

export function filterNew(findings, { reviewNumber, settled, changedLines }) {
  const allowed = allowedSeverities(reviewNumber);
  const keep = [];
  const dropped = [];
  for (const finding of findings) {
    if (!allowed.has(finding.severity)) dropped.push({ finding, reason: "severity floor" });
    else if (settled.has(fingerprint(finding)) && !touched(finding, changedLines.get(finding.file))) dropped.push({ finding, reason: "settled" });
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
