import test from "node:test";
import assert from "node:assert/strict";
import { fingerprint, allowedSeverities, filterNew, budgetLeft } from "../lib/convergence.mjs";

const f = (o = {}) => ({ lens: "bugs", file: "a.js", line: 42, severity: "must", title: "Null deref in parse()", ...o });

test("review 2 drops nits; review 3 keeps only must", () => {
  const fs = [f({ severity: "must" }), f({ severity: "should", title: "b" }), f({ severity: "nit", title: "c" })];
  const sev = (n) => filterNew(fs, { reviewNumber: n, settled: new Set(), changedLines: new Map() }).keep.map((x) => x.severity);
  assert.deepEqual(sev(1), ["must", "should", "nit"]);
  assert.deepEqual(sev(2), ["must", "should"]);
  assert.deepEqual(sev(3), ["must"]);
  assert.deepEqual([...allowedSeverities(5)], ["must"]);
  const r = filterNew(fs, { reviewNumber: 3, settled: new Set(), changedLines: new Map() });
  assert.equal(r.dropped[0].reason, "severity floor");
});
test("settled fingerprint is dropped unless its lines changed", () => {
  const x = f();
  const settled = new Set([fingerprint(x)]);
  let r = filterNew([x], { reviewNumber: 1, settled, changedLines: new Map() });
  assert.equal(r.keep.length, 0);
  assert.equal(r.dropped[0].reason, "settled");
  r = filterNew([x], { reviewNumber: 1, settled, changedLines: new Map([["a.js", new Set([42])]]) });
  assert.equal(r.keep.length, 1);
  r = filterNew([x], { reviewNumber: 1, settled, changedLines: new Map([["a.js", new Set([7])]]) });
  assert.equal(r.keep.length, 0);
});
test("titles that normalize to empty fall back to the case", () => {
  assert.notEqual(fingerprint(f({ title: "1.", case: "a -> b" })), fingerprint(f({ title: "2!", case: "c -> d" })));
  assert.equal(fingerprint(f({ title: "1.", case: "a -> b" })), fingerprint(f({ title: "2!", case: "A -> b" })));
  assert.notEqual(fingerprint(f({ title: "1.", case: "off by one at line 42" })), fingerprint(f({ title: "2!", case: "off by one at line 43" })));
  assert.notEqual(fingerprint(f({ title: "404", case: "500" })), fingerprint(f({ title: "429", case: "502" })));
  assert.notEqual(fingerprint(f({ title: "404" })), fingerprint(f({ title: "429" })), "no case: the raw title");
});
test("same finding with a moved line number keeps its fingerprint", () => {
  assert.equal(fingerprint(f({ line: 42 })), fingerprint(f({ line: 45 })));
  assert.equal(fingerprint(f({ line: 48 })), fingerprint(f({ line: 52 })));
});
test("title is normalized; different title or symbol differs", () => {
  assert.equal(fingerprint(f({ title: "  NULL deref   in parse() 2 " })), fingerprint(f()));
  assert.notEqual(fingerprint(f({ title: "Race in cache" })), fingerprint(f()));
  assert.notEqual(fingerprint(f({ symbol: "parse" })), fingerprint(f()));
});
test("R13: only digits and punctuation are stripped; symbols such as < and > stay", () => {
  assert.notEqual(fingerprint(f({ title: "x < y" })), fingerprint(f({ title: "x > y" })));
  assert.notEqual(fingerprint(f({ title: "a + b" })), fingerprint(f({ title: "a - b" })), "- is punctuation, + is a symbol");
  assert.equal(fingerprint(f({ title: "Check: x < y!" })), fingerprint(f({ title: "check x < y" })));
});
test("review budget: 3 reviews done -> review false", () => {
  const c = { loop: { max_review_rounds: 3, max_replies_per_thread: 2 } };
  assert.equal(budgetLeft({ reviews: 2, replies: {} }, c).review, true);
  assert.equal(budgetLeft({ reviews: 3, replies: {} }, c).review, false);
});
test("thread budget: 2 replies done -> replies(thread) false", () => {
  const c = { loop: { max_review_rounds: 3, max_replies_per_thread: 2 } };
  const b = budgetLeft({ reviews: 0, replies: { t1: 2, t2: 1 } }, c);
  assert.equal(b.replies("t1"), false);
  assert.equal(b.replies("t2"), true);
  assert.equal(b.replies("t3"), true);
});
