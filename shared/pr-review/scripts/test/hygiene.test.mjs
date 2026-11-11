import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hygieneChecks, usesConventional, hygiene } from "../lib/hygiene.mjs";
import { hygienePrompt } from "../lib/prompts.mjs";
import { validate } from "../lib/schema.mjs";
import { loadConfig } from "../lib/config.mjs";

const conv = ["feat: a", "fix(x): b", "chore: c", "docs: d", "Merge it"];
const base = { title: "feat: add thing", body: "Does the thing.", commits: ["feat: add thing"], baseSubjects: conv, changedPaths: ["src/a.js"], hasChangelog: false, guidanceText: "", closingIssues: [1] };
const run = (o) => hygieneChecks({ ...base, ...o });

test("usesConventional needs 60% of subjects", () => {
  assert.equal(usesConventional(conv), true);
  assert.equal(usesConventional(["Update a", "Fix b", "feat: c"]), false);
  assert.equal(usesConventional([]), false);
});

test("conventional base + 'Update stuff' title -> should finding", () => {
  const f = run({ title: "Update stuff" });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "should");
  assert.match(f[0].title, /title/i);
});

test("non-conventional base -> no title finding", () => {
  assert.deepEqual(run({ title: "Update stuff", baseSubjects: ["Update a", "Fix b"], commits: ["Update x"] }), []);
});

test("empty body -> should", () => {
  const f = run({ body: "  \n" });
  assert.deepEqual(f.map((x) => x.severity), ["should"]);
});

test("guidance asks for a linked issue and none is linked -> should", () => {
  assert.equal(run({ guidanceText: "Every PR must link an issue.", closingIssues: [] })[0].severity, "should");
  assert.deepEqual(run({ guidanceText: "Every PR must link an issue.", closingIssues: [3] }), []);
  assert.deepEqual(run({ closingIssues: [] }), []);
});

test("repo has CHANGELOG.md, code changed, changelog untouched -> nit", () => {
  const f = run({ hasChangelog: true });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "nit");
  assert.deepEqual(run({ hasChangelog: true, changedPaths: ["src/a.js", "CHANGELOG.md"] }), []);
});

test("docs-only PR -> no changelog finding", () => {
  assert.deepEqual(run({ hasChangelog: true, changedPaths: ["docs/a.md", "README.md"] }), []);
});

test("bad commit subjects -> one nit listing at most 5", () => {
  const bad = ["a1", "a2", "a3", "a4", "a5", "a6", "Merge branch x"];
  const f = run({ commits: ["feat: ok", ...bad] });
  assert.equal(f.length, 1);
  assert.equal(f[0].severity, "nit");
  assert.match(f[0].case, /a5/);
  assert.doesNotMatch(f[0].case, /a6|Merge/);
});

test("never severity must, lens hygiene", () => {
  const f = run({ title: "x", body: "", hasChangelog: true, commits: ["y"], guidanceText: "link an issue", closingIssues: [] });
  assert.ok(f.length >= 4);
  for (const x of f) { assert.equal(x.lens, "hygiene"); assert.notEqual(x.severity, "must"); assert.ok(x.case && x.fix); }
});

test("hygiene schema stage", () => {
  const ok = { findings: [{ lens: "hygiene", severity: "nit", title: "t", case: "c", fix: "f" }] };
  assert.deepEqual(validate("hygiene", ok), []);
  assert.ok(validate("hygiene", { findings: [{ ...ok.findings[0], severity: "must" }] }).length);
  assert.ok(validate("hygiene", { findings: [{ ...ok.findings[0], lens: "x" }] }).length);
  assert.ok(validate("hygiene", {}).length);
});

test("hygiene.enabled is a repo-level boolean, default true", () => {
  assert.equal(loadConfig().hygiene.enabled, true);
  assert.equal(loadConfig({ repoText: '{"hygiene":{"enabled":false}}' }).hygiene.enabled, false);
  assert.throws(() => loadConfig({ repoText: '{"hygiene":{"enabled":"no"}}' }), /hygiene.enabled must be a boolean/);
});

// --- hygiene() with a temp repo and the fake harness
const dir = mkdtempSync(join(tmpdir(), "hyg-"));
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@t"); git("config", "user.name", "t"); git("config", "commit.gpgsign", "false");
writeFileSync(join(dir, "CHANGELOG.md"), "x");
git("add", "."); git("commit", "-qm", "feat: one"); git("commit", "-q", "--allow-empty", "-m", "fix: two");
git("update-ref", "refs/remotes/origin/main", "HEAD");
const ctxDir = join(dir, "run", "ctx");
mkdirSync(join(ctxDir, "guidance"), { recursive: true });
writeFileSync(join(ctxDir, "guidance", "CONTRIBUTING.md"), "Please link an issue.");
const wrap = (s) => `<<<PR-DATA-ab12\nnote\n${s}\nPR-DATA-ab12>>>`;
writeFileSync(join(ctxDir, "pr.json"), JSON.stringify({ title: wrap("Update stuff"), body: wrap(""), commits: [{ sha: "1", subject: wrap("Update stuff") }], closingIssues: [] }));
const frame = { headSha: "HEAD", baseRef: "main", trusted: true, ctxDir, worktree: dir, changedPaths: ["src/a.js"], nonce: "ab12", reviewNumber: 1, delta: {} };
const fx = join(dir, "fx.json");
const cfg = loadConfig();
const model = { findings: [{ lens: "hygiene", severity: "should", title: "Description differs", case: "Body says X, diff does Y", fix: "Update the body" }] };

test("hygiene(): code findings plus a model finding with ask_author", async () => {
  writeFileSync(fx, JSON.stringify(model));
  process.env.PR_REVIEW_FAKE = fx;
  try {
    const r = await hygiene(frame, cfg, "medium");
    assert.deepEqual(r.warnings, []);
    assert.ok(r.findings.some((f) => /title/i.test(f.title)));
    assert.ok(r.findings.some((f) => /changelog/i.test(f.title)));
    const m = r.findings.find((f) => f.title === "Description differs");
    assert.equal(m.ask_author, true);
    assert.ok(r.findings.filter((f) => f !== m).every((f) => !f.ask_author));
  } finally { delete process.env.PR_REVIEW_FAKE; }
});

test("effort low skips the model child", async () => {
  process.env.PR_REVIEW_FAKE = join(dir, "missing.json"); // would fail the child if it ran
  try {
    const r = await hygiene(frame, cfg, "low");
    assert.deepEqual(r.warnings, []);
    assert.ok(r.findings.length > 0);
  } finally { delete process.env.PR_REVIEW_FAKE; }
});

test("a failed child warns and keeps the code findings", async () => {
  writeFileSync(fx, '{"findings":[{"lens":"hygiene","severity":"must","title":"t","case":"c","fix":"f"}]}');
  process.env.PR_REVIEW_FAKE = fx;
  try {
    const r = await hygiene(frame, cfg, "medium");
    assert.equal(r.warnings.length, 1);
    assert.ok(r.findings.length > 0);
  } finally { delete process.env.PR_REVIEW_FAKE; }
});

test("hygiene.enabled false -> no findings and no child", async () => {
  const r = await hygiene(frame, { ...cfg, hygiene: { enabled: false } }, "medium");
  assert.deepEqual(r, { findings: [], warnings: [] });
});

test("hygienePrompt names absolute paths, wraps data, gives the schema", () => {
  const p = hygienePrompt(frame, { diffSummary: " a.js | 2 +-" });
  assert.match(p, new RegExp(`${ctxDir}/pr.json`));
  assert.match(p, /<<<PR-DATA-[0-9a-f]{8}/);
  assert.match(p, /a\.js \| 2/);
  assert.match(p, /"lens": "hygiene"/);
  assert.match(p, /should\|nit/);
});
