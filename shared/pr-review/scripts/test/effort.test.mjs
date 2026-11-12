import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, applyEffort, lowerEffort, plannedChildren, pickEffort, globMatch, LENSES, seatId } from "../lib/config.mjs";

function loadConfigWith(obj, repoText) {
  const p = join(mkdtempSync(join(tmpdir(), "prr-")), "c.json");
  writeFileSync(p, JSON.stringify(obj));
  return loadConfig({ userPath: p, repoText });
}

const fable = { harness: "claude", model: "claude-fable-5-1", thinking: "max" };
const lensCfg = () => {
  const c = loadConfig({});
  c.lenses.security.seats = [fable, { harness: "pi", model: "cubbit/mimir-pro", thinking: "high" }];
  return c;
};

test("low: 2 seats, per-seat, thinking capped at low, must+should, 5 findings", () => {
  const c = applyEffort(loadConfig({}), "low");
  assert.equal(c.seats.length, 2);
  assert.equal(c.round1, "per-seat");
  assert.ok([...c.seats, c.judge].every((s) => s.thinking === "low"));
  assert.deepEqual(c.post, { severities: ["must", "should"], maxFindings: 5 });
});

test("medium is the default effort", () => {
  assert.equal(loadConfig({}).effort, "medium");
  const c = applyEffort(loadConfig({}), "medium");
  assert.equal(c.seats.length, 3);
  assert.equal(c.seats[0].thinking, "medium");
  assert.equal(c.post.maxFindings, 10);
  assert.equal(c.post.severities.length > 2, true);
});

test("high: per-lens, cap high; a configured 'medium' seat stays medium", () => {
  const base = loadConfig({});
  base.seats[1].thinking = "medium";
  base.seats[0].thinking = "xhigh";
  const c = applyEffort(base, "high");
  assert.equal(c.round1, "per-lens");
  assert.deepEqual(c.seats.map((s) => s.thinking), ["high", "medium", "medium"]);
  assert.equal(c.post.maxFindings, 20);
});

test("max: no cap, all seats, no finding limit", () => {
  const base = loadConfig({});
  base.seats[0].thinking = "max";
  const c = applyEffort(base, "max");
  assert.equal(c.seats.length, 3);
  assert.equal(c.seats[0].thinking, "max");
  assert.equal(c.round1, "per-lens");
  assert.equal(c.post.maxFindings, null);
});

test("lens override seats keep their model and get the cap", () => {
  const c = applyEffort(lensCfg(), "low");
  assert.equal(c.lenses.security.seats[0].model, "claude-fable-5-1");
  assert.equal(c.lenses.security.seats[0].thinking, "low");
  assert.equal(applyEffort(lensCfg(), "max").lenses.security.seats[0].thinking, "max");
});

test("applyEffort does not mutate its input and rejects auto/unknown", () => {
  const base = lensCfg();
  const snap = structuredClone(base);
  applyEffort(base, "low");
  assert.deepEqual(base, snap);
  assert.throws(() => applyEffort(base, "auto"), /effort/);
  assert.throws(() => applyEffort(base, "bogus"), /effort/);
  assert.throws(() => lowerEffort("bogus"), /effort/);
});

test("lowerEffort(low) is low; lowerEffort(high) is medium", () => {
  assert.equal(lowerEffort("low"), "low");
  assert.equal(lowerEffort("high"), "medium");
  assert.equal(lowerEffort("max"), "high");
});

test("plannedChildren(low) is 6 for 5 lenses and 2 seats", () => {
  assert.equal(plannedChildren(applyEffort(loadConfig({}), "low"), LENSES), 6);
});

test("plannedChildren: per-lens and lens overrides", () => {
  const c = applyEffort(loadConfig({}), "high");
  assert.equal(plannedChildren(c, LENSES), 5 * 3 + 3 + 2);
  const o = applyEffort(lensCfg(), "medium");
  assert.equal(seatId(o.lenses.security.seats[0]), "claude:claude-fable-5-1");
  // round1: 3 default seats + 2 security seats; votes: 5 distinct seat ids; judge 2
  assert.equal(plannedChildren(o, LENSES), 5 + 5 + 2);
});

test("plannedChildren counts two seats on one model as two seats", () => {
  const s = (model, thinking) => ({ harness: "claude", model, thinking });
  const c = applyEffort(loadConfigWith({ seats: [s("opus", "high"), s("sonnet", "high"), s("opus", "medium")] }), "medium");
  assert.equal(plannedChildren(c, LENSES), 3 + 3 + 2);
});

test("unknown effort in config throws", () => {
  assert.throws(() => loadConfigWith({ effort: "huge" }), /effort/);
  assert.throws(() => loadConfigWith({ loop: { effort: 3 } }), /loop.effort/);
  assert.equal(loadConfigWith({ effort: "auto" }).effort, "auto");
});

test("loop.effort defaults to auto", () => {
  assert.equal(loadConfig({}).loop.effort, "auto");
});

test("globMatch: ** spans directories, * and ? do not cross /", () => {
  assert.ok(globMatch("**/x/**", "x/a"));
  assert.ok(globMatch("**/x/**", "a/x/b"));
  assert.ok(!globMatch("**/x/**", "ax/b"));
  assert.ok(globMatch("**/*.md", "README.md"));
  assert.ok(globMatch("**/*.md", "a/b/c.md"));
  assert.ok(!globMatch("*.md", "a/b.md"));
  assert.ok(globMatch("a?c", "abc"));
  assert.ok(!globMatch("a?c", "a/c"));
  assert.ok(globMatch("docs/**", "docs/a/b.png"));
  assert.ok(!globMatch("a.b", "axb"));
});

test("auto: a change under .github/workflows -> high", () => {
  assert.equal(pickEffort(["README.md", ".github/workflows/ci.yml"], loadConfig({})), "high");
});

test("auto: only README.md and docs/a.md -> low", () => {
  assert.equal(pickEffort(["README.md", "docs/a.md"], loadConfig({})), "low");
});

test("auto: docs plus src/x.ts -> medium", () => {
  assert.equal(pickEffort(["docs/a.md", "src/x.ts"], loadConfig({})), "medium");
});

test("auto: no changed paths -> medium", () => {
  assert.equal(pickEffort([], loadConfig({})), "medium");
});

test("repo level can append high_paths but not low_paths or effort", () => {
  const c = loadConfigWith({ effort_auto: { high_paths: ["mine/**"] } }, '{"effort_auto":{"high_paths":["billing/**"]}}');
  assert.deepEqual(c.effort_auto.high_paths, ["mine/**", "billing/**"]);
  assert.equal(pickEffort(["billing/x.ts"], c), "high");
  const d = loadConfig({ repoText: '{"effort_auto":{"high_paths":["billing/**"]}}' });
  assert.ok(d.effort_auto.high_paths.includes("**/auth/**") && d.effort_auto.high_paths.includes("billing/**"));
  assert.throws(() => loadConfig({ repoText: '{"effort_auto":{"low_paths":["**"]}}' }), /not allowed at repo level/);
  assert.throws(() => loadConfig({ repoText: '{"effort":"low"}' }), /not allowed at repo level/);
  assert.throws(() => loadConfig({ repoText: '{"loop":{"effort":"low"}}' }), /not allowed at repo level/);
  assert.throws(() => loadConfig({ repoText: '{"effort_auto":{"high_paths":"x"}}' }), /high_paths/);
});

test("effort_auto arrays are validated", () => {
  assert.throws(() => loadConfigWith({ effort_auto: { low_paths: [1] } }), /low_paths/);
});

test("plannedChildren: each diff part repeats round 1, not the votes or the judge", () => {
  assert.equal(plannedChildren(applyEffort(loadConfig({}), "medium"), LENSES, 3), 3 * 3 + 3 + 2);
});
