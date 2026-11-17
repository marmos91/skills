import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict, whyNotApproved } from "../lib/verdict.mjs";

const base = {
  agreed: [], openQuestions: 0, failedLenses: 0, earlierMustOpen: 0,
  ownPr: false, mode: "interactive", trustedAuthor: true, unanimousZero: true, ci: "green",
};
const v = (o) => verdict({ ...base, ...o });
const f = (severity) => ({ severity });

test("agreed must -> REQUEST_CHANGES", () => {
  const r = v({ agreed: [f("must")] });
  assert.equal(r.event, "REQUEST_CHANGES");
  assert.ok(r.reasons.includes("agreed must"));
});
test("earlier must still open -> REQUEST_CHANGES", () => {
  const r = v({ earlierMustOpen: 1 });
  assert.equal(r.event, "REQUEST_CHANGES");
  assert.ok(r.reasons.includes("earlier must open"));
});
test("open question or split or failed lens -> COMMENT", () => {
  assert.equal(v({ openQuestions: 1 }).event, "COMMENT");
  assert.equal(v({ failedLenses: 1 }).event, "COMMENT");
});
test("only should/nit -> COMMENT", () => {
  assert.equal(v({ agreed: [f("should"), f("nit")] }).event, "COMMENT");
});
test("nothing -> APPROVE (interactive)", () => {
  assert.deepEqual(v({ trustedAuthor: false, unanimousZero: false }), { event: "APPROVE", queueApprove: false, reasons: [] });
});
test("ci none does not block APPROVE", () => {
  assert.equal(v({ ci: "none" }).event, "APPROVE");
});
test("loop + untrusted author + nothing -> COMMENT and queueApprove", () => {
  const r = v({ mode: "loop", trustedAuthor: false });
  assert.equal(r.event, "COMMENT");
  assert.equal(r.queueApprove, true);
  assert.ok(r.reasons.includes("loop: untrusted author"));
});
test("loop + trusted + not unanimous zero -> COMMENT and queueApprove", () => {
  const r = v({ mode: "loop", unanimousZero: false });
  assert.equal(r.event, "COMMENT");
  assert.equal(r.queueApprove, true);
});
test("loop + trusted + unanimous zero -> APPROVE", () => {
  const r = v({ mode: "loop" });
  assert.equal(r.event, "APPROVE");
  assert.equal(r.queueApprove, false);
});
test("own PR -> always COMMENT", () => {
  for (const o of [{}, { agreed: [f("must")] }, { earlierMustOpen: 2 }]) {
    const r = v({ ownPr: true, ...o });
    assert.equal(r.event, "COMMENT");
    assert.equal(r.queueApprove, false);
    assert.ok(r.reasons.includes("own PR"));
  }
});
test("red or pending CI never gives APPROVE", () => {
  for (const ci of ["red", "pending"]) {
    const r = v({ ci });
    assert.equal(r.event, "COMMENT");
    assert.ok(r.reasons.includes(`ci ${ci}`));
  }
});
test("red CI and no agreed must -> COMMENT; loop does not queue", () => {
  const r = v({ ci: "red", mode: "loop", trustedAuthor: false });
  assert.equal(r.event, "COMMENT");
  assert.equal(r.queueApprove, false);
});

test("unknown or missing ci blocks APPROVE", () => {
  for (const ci of [undefined, "stale", "error"]) {
    const r = v({ ci });
    assert.equal(r.event, "COMMENT");
    assert.ok(r.reasons.includes(`ci ${ci ?? "unknown"}`));
  }
});

test("a dropped seat blocks APPROVE but not REQUEST_CHANGES", () => {
  const base = { agreed: [], earlierMustOpen: 0, openQuestions: 0, failedLenses: 0, ci: "green", mode: "loop", trustedAuthor: true, unanimousZero: true, ownPr: false };
  assert.equal(verdict({ ...base, mode: "interactive" }).event, "APPROVE");
  const v = verdict({ ...base, droppedSeats: 1 });
  assert.deepEqual([v.event, v.queueApprove], ["COMMENT", false]);
  assert.ok(v.reasons.includes("dropped seats"));
  assert.equal(verdict({ ...base, droppedSeats: 1, agreed: [{ severity: "must" }] }).event, "REQUEST_CHANGES");
});

test("CI pending alone -> COMMENT and queueApprove, interactive and loop; with another reason it does not queue (#82)", () => {
  for (const mode of ["interactive", "loop"]) assert.deepEqual(v({ ci: "pending", mode }), { event: "COMMENT", queueApprove: true, reasons: ["ci pending"] });
  assert.equal(v({ ci: "pending", openQuestions: 1 }).queueApprove, false);
  assert.equal(v({ ci: "red" }).queueApprove, false);
});

test("whyNotApproved: one plain line from the reasons, none when a must blocks (#82)", () => {
  const c = { questions: 2, lenses: 1, seats: 1 };
  assert.equal(whyNotApproved(v({ ci: "pending" }), { ...c, mode: "loop" }), "Not approved yet: CI is still running. It is approved when CI passes.");
  assert.equal(whyNotApproved(v({ ci: "pending" }), { ...c, mode: "interactive" }), "Not approved yet: CI is still running. Run pr-review again once CI passes to approve it, or let pr-review-loop do it.");
  assert.equal(whyNotApproved(v({ ci: "pending", mode: "loop", trustedAuthor: false }), c), "Not approved yet: CI is still running and the loop approves only a trusted author. It is approved when CI passes and you answer post to the approve question.");
  assert.equal(whyNotApproved(v({ failedLenses: 1, droppedSeats: 1 }), c), "Not approved: 1 lens did not run and 1 seat did not finish.");
  assert.equal(whyNotApproved(v({ ci: "red", openQuestions: 2 }), c), "Not approved: 2 questions are still open and CI failed.");
  assert.equal(whyNotApproved(v({ mode: "loop", trustedAuthor: false }), c), "Not approved yet: the loop approves only a trusted author. It is approved when you answer post to the approve question.");
  assert.equal(whyNotApproved(v({}), c), "");
  assert.equal(whyNotApproved(v({ agreed: [f("must")] }), c), "");
  assert.equal(whyNotApproved(v({ ownPr: true }), c), "", "own PR: COMMENT is the only option");
});
