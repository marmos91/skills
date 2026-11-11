import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../lib/schema.mjs";

const f = { lens: "correctness", severity: "must", file: "a.js", line: 3, title: "t", case: "because", fix: "x" };

test("validate(round1) accepts a good finding", () => {
  assert.deepEqual(validate("round1", { findings: [f] }), []);
});
test("validate(round1) rejects a finding with no case", () => {
  assert.ok(validate("round1", { findings: [{ ...f, case: "" }] }).length > 0);
});
test("validate covers the other stages", () => {
  assert.deepEqual(validate("vote", [{ id: "a", vote: "keep", counter_case: "" }]), []);
  assert.ok(validate("vote", [{ id: "a", vote: "maybe", counter_case: "" }]).length);
  assert.deepEqual(validate("merge", [{ id: "a", lens: "l", severity: "nit", file: "f", line: 1, title: "t", found: [] }]), []);
  assert.deepEqual(validate("compose", { body: "b", comments: [{ id: "a", body: "b" }] }), []);
  assert.deepEqual(validate("reply", { position: "ask", body: "b" }), []);
  assert.ok(validate("reply", { position: "x", body: "" }).length);
  assert.ok(validate("nope", {}).length);
});
