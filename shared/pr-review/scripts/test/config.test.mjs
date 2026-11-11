import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, resolveHarness, seatsForLens, seatId, LENSES } from "../lib/config.mjs";

const example = new URL("../../config.example.json", import.meta.url);
const tmp = (text) => {
  const p = join(mkdtempSync(join(tmpdir(), "prr-")), "c.json");
  writeFileSync(p, text);
  return p;
};

test("defaults match spec §5", () => {
  const c = loadConfig({});
  assert.deepEqual(c.seats.map(seatId), ["claude:opus", "auto:cubbit/mimir-pro", "auto:cubbit/mimir"]);
  assert.equal(c.round1, "per-seat");
  assert.equal(c.loop.max_review_rounds, 3);
  assert.equal(c.loop.max_replies_per_thread, 2);
  assert.equal(c.loop.max_prs_per_run, 10);
  assert.deepEqual(c.decider, { kind: "auto", confidence: 0.5 });
  assert.equal(seatId(c.judge), "claude:opus");
  assert.deepEqual(Object.keys(c.lenses), LENSES);
});

test("user arrays replace, objects merge deep", () => {
  const p = tmp('{"seats":[{"harness":"pi","model":"a","thinking":"low"},{"harness":"pi","model":"b","thinking":"low"}],"loop":{"max_review_rounds":5}}');
  const c = loadConfig({ userPath: p });
  assert.deepEqual(c.seats.map(seatId), ["pi:a", "pi:b"]);
  assert.equal(c.loop.max_review_rounds, 5);
  assert.equal(c.loop.max_replies_per_thread, 2);
});

test("// comments are stripped", () => {
  const c = loadConfig({ userPath: fileURLToPath(example) });
  assert.equal(c.decider.confidence, 0.8);
  const p = tmp('{"decider":{"confidence":0.7} // x\n, "judge":{"model":"http://a//b"}}');
  const d = loadConfig({ userPath: p });
  assert.equal(d.judge.model, "http://a//b");
});

test("repo level may set only the allowlist", () => {
  assert.throws(() => loadConfig({ repoText: '{"judge":{"harness":"pi","model":"x"}}' }), /not allowed at repo level: judge/);
  assert.throws(() => loadConfig({ repoText: '{"loop":{"max_review_rounds":9}}' }), /not allowed at repo level: loop.max_review_rounds/);
  assert.equal(loadConfig({ repoText: '{"lenses":{"security":{"enabled":false}}}' }).lenses.security.enabled, false);
  assert.deepEqual(loadConfig({ repoText: '{"loop":{"authors_ignore":["bot"]},"review":{"guidance":["G.md"]}}' }).review.guidance, ["G.md"]);
});

test("a lens needs 2 or more seats", () => {
  const p = tmp('{"lenses":{"security":{"seats":[{"harness":"claude","model":"opus","thinking":"high"}]}}}');
  assert.throws(() => loadConfig({ userPath: p }), /needs 2 or more seats/);
});

test("thinking is checked per harness", () => {
  const seat = (harness, thinking) => tmp(JSON.stringify({ judge: { harness, model: "m", thinking } }));
  assert.throws(() => loadConfig({ userPath: seat("claude", "minimal") }), /thinking/);
});

test("cliPath replaces the user level", () => {
  const u = tmp('{"round1":"per-lens"}');
  const cli = tmp('{"loop":{"max_review_rounds":7}}');
  const c = loadConfig({ userPath: u, cliPath: cli });
  assert.equal(c.round1, "per-seat");
  assert.equal(c.loop.max_review_rounds, 7);
});

test("seatsForLens uses override else default seats", () => {
  const p = tmp('{"lenses":{"security":{"seats":[{"harness":"claude","model":"a","thinking":"max"},{"harness":"pi","model":"b","thinking":"off"}]}}}');
  const c = loadConfig({ userPath: p });
  assert.deepEqual(seatsForLens(c, "security").map(seatId), ["claude:a", "pi:b"]);
  assert.equal(seatsForLens(c, "correctness").length, 3);
});

test("auto seat resolves to claude when the router is up, pi when down", () => {
  const s = { harness: "auto", model: "cubbit/mimir", thinking: "high" };
  assert.equal(resolveHarness(s, true), "claude");
  assert.equal(resolveHarness(s, false), "pi");
  assert.equal(resolveHarness({ ...s, harness: "pi" }, true), "pi");
  assert.equal(resolveHarness({ ...s, harness: "claude" }, false), "claude");
});

test("opus seat resolves to claude even when the router is down", () => {
  assert.equal(resolveHarness({ harness: "auto", model: "opus", thinking: "high" }, false), "claude");
});

test("allowed values are type-checked, with the key path in the error", () => {
  const cases = [
    ['{"lenses":{"security":{"enabled":"false"}}}', /lenses.security.enabled must be a boolean/],
    ['{"lenses":{"bogus":{"enabled":true}}}', /lenses.bogus must be a known lens/],
    ['{"lenses":{"security":true}}', /lenses.security must be an object/],
    ['{"loop":{"authors_ignore":"bot"}}', /loop.authors_ignore must be an array of strings/],
    ['{"loop":{"max_prs_per_run":"x"}}', /loop.max_prs_per_run must be a positive integer/],
    ['{"loop":{"max_review_rounds":0}}', /loop.max_review_rounds must be a positive integer/],
    ['{"loop":{"max_replies_per_thread":1.5}}', /loop.max_replies_per_thread must be a positive integer/],
    ['{"decider":{"confidence":2}}', /decider.confidence must be a number in \[0,1\]/],
    ['{"decider":{"kind":"x"}}', /decider.kind must be/],
    ['{"round1":"x"}', /round1 must be/],
    ['{"review":{"guidance":"G.md"}}', /review.guidance must be an array of strings/],
    ['{"seats":[{"harness":"pi","model":3,"thinking":"low"}]}', /seats\[0\].model must be/],
    ['{"seats":[{"harness":"pi","model":"m","thinking":"low","provider":1}]}', /seats\[0\].provider must be a string/],
    ['{"seats":["x"]}', /seats\[0\] must be an object/],
  ];
  for (const [text, re] of cases) assert.throws(() => loadConfig({ userPath: tmp(text) }), re, text);
  assert.throws(() => loadConfig({ repoText: '{"loop":{"authors_ignore":"bot"}}' }), /loop.authors_ignore must be an array of strings/);
  assert.throws(() => loadConfig({ repoText: '{"lenses":{"security":{"enabled":"no"}}}' }), /lenses.security.enabled must be a boolean/);
});

test("__proto__ keys cannot pollute prototypes", () => {
  assert.throws(() => loadConfig({ repoText: '{"__proto__":{"polluted":true}}' }), /not allowed at repo level/);
  assert.equal(({}).polluted, undefined);
  const c = loadConfig({ userPath: tmp('{"__proto__":{"polluted":true},"loop":{"__proto__":{"polluted":true}}}') });
  assert.equal(({}).polluted, undefined);
  assert.equal(c.polluted, undefined);
  assert.equal(c.loop.polluted, undefined);
});
