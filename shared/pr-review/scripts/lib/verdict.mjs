// Pick the GitHub review event (spec 6.8).
export function verdict(i) {
  const reasons = [];
  const must = i.agreed.some((f) => f.severity === "must");
  if (i.ownPr) reasons.push("own PR");
  if (must) reasons.push("agreed must");
  if (i.earlierMustOpen > 0) reasons.push("earlier must open");
  if (i.ownPr) return { event: "COMMENT", queueApprove: false, reasons };
  if (must || i.earlierMustOpen > 0) return { event: "REQUEST_CHANGES", queueApprove: false, reasons };

  if (i.openQuestions > 0) reasons.push("open questions");
  if (i.failedLenses > 0) reasons.push("failed lenses");
  if (i.droppedSeats > 0) reasons.push("dropped seats");
  if (i.agreed.length > 0) reasons.push("agreed findings");
  // only green or none (no checks configured) may approve; unknown or missing blocks
  if (i.ci !== "green" && i.ci !== "none") reasons.push(`ci ${i.ci ?? "unknown"}`);
  // CI pending alone queues the approve: tick.mjs approves once CI is green at the same head.
  if (reasons.length && reasons.join() !== "ci pending") return { event: "COMMENT", queueApprove: false, reasons };

  if (i.mode === "loop") {
    if (!i.trustedAuthor) reasons.push("loop: untrusted author");
    if (!i.unanimousZero) reasons.push("loop: not unanimous zero");
  }
  if (reasons.length) return { event: "COMMENT", queueApprove: true, reasons };
  return { event: "APPROVE", queueApprove: false, reasons };
}

const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
const WHY = {
  "open questions": (c) => `${n(c.questions, "question is", "questions are")} still open`,
  "failed lenses": (c) => `${n(c.lenses, "lens", "lenses")} did not run`,
  "dropped seats": (c) => `${n(c.seats, "seat", "seats")} did not finish`,
  "agreed findings": () => "the agreed findings are open",
  "ci pending": () => "CI is still running",
  "ci red": () => "CI failed",
  "loop: untrusted author": () => "the loop approves only a trusted author",
  "loop: not unanimous zero": () => "not every seat found nothing",
};

// The body line that says why a review with no blocking finding is not an APPROVE. Engine text, from the reasons.
export function whyNotApproved({ event, queueApprove, reasons }, counts) {
  if (event !== "COMMENT" || reasons.some((r) => r.includes("must") || r === "own PR")) return "";
  const why = reasons.map((r) => WHY[r]?.(counts) ?? (r.startsWith("ci ") ? "the CI state is unknown" : r));
  const list = why.length > 1 ? `${why.slice(0, -1).join(", ")} and ${why.at(-1)}` : why[0];
  if (!queueApprove) return `Not approved: ${list}.`;
  // only the loop's tick posts the queued approval
  if (reasons.join() === "ci pending") return counts.mode === "loop" ? `Not approved yet: ${list}. It is approved when CI passes.` : `Not approved yet: ${list}. pr-review-loop approves it when CI passes; or run pr-review again then.`;
  return `Not approved yet: ${list}. It is approved when ${reasons.includes("ci pending") ? "CI passes and " : ""}you answer post to the approve question.`;
}
