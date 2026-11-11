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
  if (i.splits > 0) reasons.push("splits");
  if (i.failedLenses > 0) reasons.push("failed lenses");
  if (i.droppedSeats > 0) reasons.push("dropped seats");
  if (i.agreed.length > 0) reasons.push("agreed findings");
  // only green or none (no checks configured) may approve; unknown or missing blocks
  if (i.ci !== "green" && i.ci !== "none") reasons.push(`ci ${i.ci ?? "unknown"}`);
  if (reasons.length) return { event: "COMMENT", queueApprove: false, reasons };

  if (i.mode === "loop") {
    if (!i.trustedAuthor) reasons.push("loop: untrusted author");
    if (!i.unanimousZero) reasons.push("loop: not unanimous zero");
    if (reasons.length) return { event: "COMMENT", queueApprove: true, reasons };
  }
  return { event: "APPROVE", queueApprove: false, reasons };
}
