import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queueQuestion, openQuestions, answer, markAsked, appliedAnswer } from "../lib/questions.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "prr-q-"));
const q = (o = {}) => ({
  pr: 7, sha: "abc123", fingerprint: "deadbeefcafe1234", file: "a.js", line: 4, snippet: "let x = null;",
  finding: { title: "Null deref", case: "x is null", fix: "guard" },
  sides: { keep: "it crashes", drop: "never null" }, failure: "call f(null) throws", ...o,
});

test("queue writes md + json, id from pr and fingerprint, idempotent", () => {
  const r = tmp();
  const id = queueQuestion(r, q());
  assert.equal(id, "7-deadbeef");
  assert.deepEqual(readdirSync(join(r, "questions")).sort(), ["7-deadbeef.json", "7-deadbeef.md"]);
  const j = JSON.parse(readFileSync(join(r, "questions", `${id}.json`), "utf8"));
  assert.deepEqual(j.options, ["post", "drop", "ask-author"]);
  assert.equal(j.askedAt, null); assert.equal(j.answer, null); assert.equal(j.answeredAt, null);
  const md = readFileSync(join(r, "questions", `${id}.md`), "utf8");
  for (const w of ["a.js:4", "let x = null;", "Null deref", "it crashes", "never null", "call f(null) throws", "ask-author"]) assert.ok(md.includes(w), w);
  answer(r, id, "post");
  assert.equal(queueQuestion(r, q()), id); // does not reset the answer
  assert.equal(JSON.parse(readFileSync(join(r, "questions", `${id}.json`), "utf8")).answer, "post");
});

test("openQuestions: unanswered, sorted by createdAt", () => {
  const r = tmp();
  assert.deepEqual(openQuestions(r), []);
  const a = queueQuestion(r, q({ fingerprint: "aaaaaaaa11" }));
  const b = queueQuestion(r, q({ fingerprint: "bbbbbbbb22" }));
  const c = queueQuestion(r, q({ fingerprint: "cccccccc33" }));
  answer(r, a, "drop");
  const ids = openQuestions(r).map((x) => x.id);
  assert.deepEqual(ids, [b, c]);
});

test("answer validates option and id", () => {
  const r = tmp();
  const id = queueQuestion(r, q());
  assert.throws(() => answer(r, id, "nope"), /option/);
  assert.throws(() => answer(r, "9-unknown", "post"), /unknown question/);
  assert.throws(() => answer(r, "../x", "post"), /unknown question/);
  const j = answer(r, id, "ask-author");
  assert.equal(j.answer, "ask-author");
  assert.ok(j.answeredAt);
});

test("markAsked sets askedAt once; appliedAnswer marks applied", () => {
  const r = tmp();
  const id = queueQuestion(r, q());
  markAsked(r, [id]);
  const t = openQuestions(r)[0].askedAt;
  assert.ok(t);
  markAsked(r, [id]);
  assert.equal(openQuestions(r)[0].askedAt, t);
  assert.throws(() => appliedAnswer(r, id), /not answered/);
  answer(r, id, "post");
  const j = appliedAnswer(r, id);
  assert.ok(j.appliedAt);
  assert.equal(j.answer, "post");
});
