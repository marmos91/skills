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
  assert.deepEqual(c.seats.map((s) => [seatId(s), s.thinking, s.max_turns, s.timeout_minutes]), [
    ["claude:opus", "high", 40, 15], ["auto:cubbit/mimir", "medium", 40, 15], ["auto:cubbit/mimir-pro", "medium", 40, 15],
  ]);
  assert.equal(c.round1, "per-seat");
  assert.equal(c.loop.max_review_rounds, 3);
  assert.deepEqual([c.review.ci, c.review.max_diff_lines, c.review.chunk_lines, c.review.max_children, c.review.max_parallel], ["use", 6000, 500, 60, 9]);
  assert.equal(c.loop.max_replies_per_thread, 2);
  assert.equal(c.loop.ci_wait_minutes, 30);
  assert.equal(c.loop.max_prs_per_run, 10);
  assert.deepEqual(c.decider, { kind: "auto", confidence: 0 });
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
  assert.equal(c.decider.confidence, 0);
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
    ['{"review":{"ci":"maybe"}}', /review.ci must be use or ignore/],
    ['{"review":{"max_diff_lines":0}}', /review.max_diff_lines must be a positive integer/],
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

test("turn and time limits: seat, then lens, then review.* (defaults 40 turns, 10 minutes); validated", async () => {
  const { withLimits } = await import("../lib/config.mjs");
  const c = loadConfig({ userPath: tmp(JSON.stringify({
    seats: [{ harness: "claude", model: "opus", thinking: "high", max_turns: 12, timeout_minutes: 4 }, { harness: "pi", model: "m", thinking: "high" }],
    lenses: { security: { enabled: true, max_turns: 20 } },
  })) });
  assert.deepEqual([c.review.max_turns, c.review.timeout_minutes], [40, 10]);
  const [a, b] = c.seats;
  assert.deepEqual([withLimits(c, a, "security").max_turns, withLimits(c, a).timeout_minutes], [12, 4]);
  assert.deepEqual([withLimits(c, b, "security").max_turns, withLimits(c, b, "correctness").max_turns, withLimits(c, b).timeout_minutes], [20, 40, 10]);
  for (const [text, re] of [
    ['{"seats":[{"harness":"pi","model":"m","thinking":"low","max_turns":0}]}', /seats\[0\].max_turns must be a positive integer/],
    ['{"seats":[{"harness":"pi","model":"m","thinking":"low","timeout_minutes":"5"}]}', /seats\[0\].timeout_minutes must be a positive integer/],
    ['{"judge":{"harness":"claude","model":"opus","thinking":"high","max_turns":1.5}}', /judge.max_turns must be a positive integer/],
    ['{"lenses":{"security":{"enabled":true,"max_turns":-1}}}', /lenses.security.max_turns must be a positive integer/],
    ['{"review":{"max_turns":0}}', /review.max_turns must be a positive integer/],
    ['{"review":{"timeout_minutes":0}}', /review.timeout_minutes must be a positive integer/],
  ]) assert.throws(() => loadConfig({ userPath: tmp(text) }), re, text);
});

test("thinking_by_stage: seat, then lens, then the default (cubbit seats think only in round 1); effort cap on top; validated", async () => {
  const { withLimits, applyEffort } = await import("../lib/config.mjs");
  const c0 = loadConfig({ userPath: tmp(JSON.stringify({
    seats: [
      { harness: "claude", model: "opus", thinking: "high" },
      { harness: "auto", model: "cubbit/mimir-pro", thinking: "high" },
      { harness: "pi", model: "cubbit/mimir", thinking: "high", thinking_by_stage: { vote: "low", round1: "max" } },
    ],
    lenses: { security: { enabled: true, thinking_by_stage: { round1: "xhigh", vote: "minimal" } } },
  })) });
  const c = applyEffort(c0, "medium");
  const [opus, pro, mimir] = c.seats;
  const t = (s, stage, lens) => withLimits(c, s, lens, stage).thinking;
  // claude: one level everywhere
  assert.deepEqual(["round1", "vote", "merge", "compose"].map((st) => t(opus, st)), ["medium", "medium", "medium", "medium"]);
  // cubbit default: round1 = the capped thinking, vote and merge off
  assert.deepEqual(["round1", "vote", "merge", "compose"].map((st) => t(pro, st)), ["medium", "off", "off", "medium"]);
  // the seat wins, capped by the effort; then the lens; then the default
  assert.deepEqual([t(mimir, "round1"), t(mimir, "vote"), t(mimir, "merge")], ["medium", "low", "off"]);
  assert.equal(t(pro, "round1", "security"), "medium", "lens xhigh capped to medium");
  assert.equal(t(pro, "vote", "security"), "minimal");
  assert.equal(t(mimir, "vote", "security"), "low", "seat beats lens");
  assert.equal(withLimits(c, pro).thinking, "medium", "no stage: the seat's thinking");
  for (const [text, re] of [
    ['{"seats":[{"harness":"claude","model":"opus","thinking":"high","thinking_by_stage":{"vote":"off"}}]}', /seats\[0\].thinking_by_stage.vote \(claude seat\) must be one of low/],
    ['{"seats":[{"harness":"pi","model":"m","thinking":"high","thinking_by_stage":{"compose":"low"}}]}', /seats\[0\].thinking_by_stage.compose must be a stage: round1, vote or merge/],
    ['{"seats":[{"harness":"pi","model":"m","thinking":"high","thinking_by_stage":"low"}]}', /seats\[0\].thinking_by_stage must be an object/],
    ['{"lenses":{"security":{"enabled":true,"thinking_by_stage":{"round1":"huge"}}}}', /lenses.security.thinking_by_stage.round1 must be one of/],
  ]) assert.throws(() => loadConfig({ userPath: tmp(text) }), re, text);
});

test("seat ids: harness:model, later duplicates #2, #3 in config order; an explicit id wins", () => {
  const s = (model, thinking, id) => ({ harness: "claude", model, thinking, ...(id && { id }) });
  const c = loadConfig({ userPath: tmp(JSON.stringify({
    seats: [s("opus", "high"), s("sonnet", "high"), s("opus", "medium"), s("opus", "low", "fast")],
    lenses: { security: { seats: [s("opus", "max"), s("opus", "high")] } },
  })) });
  assert.deepEqual(c.seats.map(seatId), ["claude:opus", "claude:sonnet", "claude:opus#2", "fast"]);
  // a lens list is numbered on its own, so its seats name the council seats of the same model
  assert.deepEqual(seatsForLens(c, "security").map(seatId), ["claude:opus", "claude:opus#2"]);
  assert.equal(seatId(c.judge), "claude:opus");
  assert.throws(() => loadConfig({ userPath: tmp(JSON.stringify({ seats: [s("a", "high", "x"), s("b", "high", "x")] })) }), /seats.*id/);
  assert.throws(() => loadConfig({ userPath: tmp(JSON.stringify({ seats: [{ ...s("a", "high"), id: "" }, s("b", "high")] })) }), /id/);
});
