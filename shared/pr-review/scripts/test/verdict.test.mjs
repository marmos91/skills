import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../lib/verdict.mjs";

const base = {
  agreed: [], openQuestions: 0, splits: 0, failedLenses: 0, earlierMustOpen: 0,
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
  assert.equal(v({ splits: 1 }).event, "COMMENT");
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
