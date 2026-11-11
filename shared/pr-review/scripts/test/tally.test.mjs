import test from "node:test";
import assert from "node:assert/strict";
import { tally, votersFor } from "../lib/tally.mjs";

const keep = (seat, evidence_run = false) => ({ seat, vote: "keep", counter_case: "", evidence_run });
const drop = (seat, counter_case = "it is fine because X") => ({ seat, vote: "drop", counter_case, evidence_run: false });
const three = (found) => ({ found, seats: ["a", "b", "c"] });

test("found by all lens seats -> agreed, no voters", () => {
  const c = three(["a", "b", "c"]);
  assert.deepEqual(votersFor(c), []);
  assert.equal(tally({ cluster: c, votes: [] }), "agreed");
});
test("votersFor: seats minus found, order preserved", () => {
  assert.deepEqual(votersFor({ found: ["c"], seats: ["a", "b", "c", "d"] }), ["a", "b", "d"]);
});
test("1 find + 2 keeps -> agreed", () => {
  assert.equal(tally({ cluster: three(["a"]), votes: [keep("b"), keep("c")] }), "agreed");
});
test("1 find + 1 keep + 1 drop with counter-case -> split", () => {
  assert.equal(tally({ cluster: three(["a"]), votes: [keep("b"), drop("c")] }), "split");
});
test("drops without counter-case abstain: 1 keep alone is not agreement -> split", () => {
  assert.equal(tally({ cluster: three(["a"]), votes: [drop("b", ""), drop("c", "   ")] }), "split");
});
test("2 drops with counter-cases vs 1 find -> rejected", () => {
  assert.equal(tally({ cluster: three(["a"]), votes: [drop("b"), drop("c")] }), "rejected");
});
test("keep with run evidence vs majority drop -> split", () => {
  const c = { found: ["a"], seats: ["a", "b", "c", "d"] };
  assert.equal(tally({ cluster: c, votes: [keep("b", true), drop("c"), drop("d")] }), "split");
});
test("2-seat lens: other seat keeps -> agreed; drops with counter-case -> split", () => {
  const c = { found: ["a"], seats: ["a", "b"] };
  assert.equal(tally({ cluster: c, votes: [keep("b")] }), "agreed");
  assert.equal(tally({ cluster: c, votes: [drop("b")] }), "split");
});
test("votes from the finder or from outsiders are ignored", () => {
  const c = three(["a"]);
  assert.equal(tally({ cluster: c, votes: [keep("a"), keep("a"), keep("zzz")] }), "split");
  assert.equal(tally({ cluster: c, votes: [keep("b"), drop("a"), drop("zzz"), drop("zzz")] }), "agreed");
  assert.equal(tally({ cluster: c, votes: [drop("a"), drop("zzz"), drop("c")] }), "split");
});

test("evidence_run exemption is what flips rejected to split", () => {
  const c = { found: ["a"], seats: ["a", "b", "c", "d", "e"] };
  const votes = (ev) => [keep("b", ev), drop("c"), drop("d"), drop("e")];
  assert.equal(tally({ cluster: c, votes: votes(true) }), "split");
  assert.equal(tally({ cluster: c, votes: votes(false) }), "rejected");
});
test("duplicate votes and duplicate found seats count once", () => {
  assert.equal(tally({ cluster: three([]), votes: [keep("b"), keep("b")] }), "split");
  assert.equal(tally({ cluster: three(["a", "a"]), votes: [] }), "split");
  assert.equal(tally({ cluster: three(["a"]), votes: [drop("b"), drop("b"), keep("c")] }), "split");
});
test("non-string counter_case abstains", () => {
  const bad = (seat, cc) => ({ seat, vote: "drop", counter_case: cc, evidence_run: false });
  assert.equal(tally({ cluster: three(["a"]), votes: [bad("b", null), bad("c", 42)] }), "split");
  assert.equal(tally({ cluster: three(["a"]), votes: [bad("b", undefined), keep("c")] }), "agreed");
});
