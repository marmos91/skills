import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide } from "../lib/decider.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "prr-dec-"));
// Stub jev: logs argv and stdin, prints $PR_REVIEW_JEV_OUT, exits $PR_REVIEW_JEV_EXIT.
function stub(dir, extra = "") {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, "jev");
  writeFileSync(f, `#!/bin/sh\necho "$@" > "$PR_REVIEW_JEV_LOG.args"\ncat > "$PR_REVIEW_JEV_LOG.in"\n${extra}\n[ -n "$PR_REVIEW_JEV_OUT" ] && echo "$PR_REVIEW_JEV_OUT"\nexit \${PR_REVIEW_JEV_EXIT:-0}\n`);
  chmodSync(f, 0o755);
  return dir;
}
const cluster = { title: "Null deref", case: "x is null here", evidence: "foo.js:3", fix: "guard it", file: "foo.js", line: 3 };
const votes = [{ vote: "keep", reason: "agree" }, { vote: "drop", counter_case: "never null" }];
const cfg = (o = {}) => ({ decider: { kind: "auto", confidence: 0, ...o } });

function setup(t, { path = true, sibling = false } = {}) {
  const root = tmp(), log = join(root, "log");
  const skill = join(root, "skills", "pr-review");
  mkdirSync(skill, { recursive: true });
  const env = { PATH: process.env.PATH, PR_REVIEW_JEV_LOG: log };
  if (path) env.PATH = `${stub(join(root, "bin"))}:${env.PATH}`;
  if (sibling) stub(join(root, "skills", "jev", "bin"));
  return { env, skill, log };
}

test("exit 0/1/other map to agreed/rejected/unsure and raw JSON is recorded", async () => {
  const s = setup();
  const run = (code, out) => decide(cluster, votes, "+ code", cfg(), { env: { ...s.env, PR_REVIEW_JEV_EXIT: code, PR_REVIEW_JEV_OUT: out }, skillDir: s.skill });
  const out = '{"verdict":"yes","probabilities":{"yes":0.9,"no":0.1},"confidence":0.9}';
  assert.deepEqual(await run("0", out), { decision: "agreed", raw: JSON.parse(out) });
  assert.equal((await run("1", out)).decision, "unsure"); // verdict contradicts exit
  assert.equal((await run("1", out.replace("yes", "no"))).decision, "rejected");
  assert.deepEqual(await run("2", ""), { decision: "unsure", raw: null });
  assert.equal((await run("0", "not json")).raw, null);
});

test("argv, confidence flag and stdin content", async () => {
  const s = setup();
  await decide(cluster, votes, "+ hunk", cfg(), { env: { ...s.env, PR_REVIEW_JEV_OUT: '{"verdict":"yes"}' }, skillDir: s.skill });
  const args = readFileSync(s.log + ".args", "utf8");
  assert.match(args, /This finding describes a real defect that this PR introduces\./);
  assert.match(args, /--json/);
  assert.doesNotMatch(args, /--confidence/);
  const input = readFileSync(s.log + ".in", "utf8");
  for (const w of ["Null deref", "x is null here", "foo.js:3", "guard it", "agree", "never null", "+ hunk"]) assert.ok(input.includes(w), w);
  await decide(cluster, votes, "h", cfg({ confidence: 0.7 }), { env: { ...s.env, PR_REVIEW_JEV_OUT: '{"verdict":"yes"}' }, skillDir: s.skill });
  assert.match(readFileSync(s.log + ".args", "utf8"), /--confidence 0\.7/);
});

test("the text is redacted before it leaves", async () => {
  const s = setup();
  const key = "AKIA" + "ABCDEFGHIJKLMNOP";
  await decide({ ...cluster, evidence: `key ${key}` }, votes, "h", cfg(), { env: { ...s.env, PR_REVIEW_JEV_OUT: '{"verdict":"yes"}' }, skillDir: s.skill });
  const input = readFileSync(s.log + ".in", "utf8");
  assert.ok(!input.includes(key));
  assert.match(input, /REDACTED/);
});

test("kind off and missing jev -> unsure without running anything", async () => {
  const s = setup();
  assert.equal((await decide(cluster, votes, "h", cfg({ kind: "off" }), { env: s.env, skillDir: s.skill })).decision, "unsure");
  assert.ok(!existsSync(s.log + ".args"));
  const n = setup(0, { path: false });
  const r = await decide(cluster, votes, "h", cfg(), { env: { PATH: "/nonexistent", PR_REVIEW_JEV_LOG: n.env.PR_REVIEW_JEV_LOG }, skillDir: n.skill });
  assert.deepEqual(r, { decision: "unsure", raw: null });
});

test("sibling jev wins over PATH", async () => {
  const s = setup(0, { sibling: true });
  const root = join(s.skill, "..");
  stub(join(root, "pathbin"), 'echo path > "$PR_REVIEW_JEV_LOG.which"');
  stub(join(root, "jev", "bin"), 'echo sibling > "$PR_REVIEW_JEV_LOG.which"');
  await decide(cluster, votes, "h", cfg(), { env: { ...s.env, PATH: `${join(root, "pathbin")}:${s.env.PATH}` }, skillDir: s.skill });
  assert.equal(readFileSync(s.log + ".which", "utf8").trim(), "sibling");
});

test("timeout kills jev and returns unsure", async () => {
  const s = setup();
  stub(join(s.skill, "..", "jev", "bin"), "sleep 5");
  const t0 = Date.now();
  const r = await decide(cluster, votes, "h", cfg(), { env: s.env, skillDir: s.skill, timeoutMs: 300 });
  assert.equal(r.decision, "unsure");
  assert.ok(Date.now() - t0 < 3000);
});

test("parent secrets are not passed to jev", async () => {
  const s = setup();
  stub(join(s.skill, "..", "jev", "bin"), 'echo "[$GH_TOKEN]" > "$PR_REVIEW_JEV_LOG.tok"');
  await decide(cluster, votes, "h", cfg(), { env: { ...s.env, GH_TOKEN: "ghp_secretvalue", PR_REVIEW_JEV_OUT: '{"verdict":"yes"}' }, skillDir: s.skill });
  assert.equal(readFileSync(s.log + ".tok", "utf8").trim(), "[]");
});

test("R22: exit 1 without JSON or with a mismatching verdict is unsure", async () => {
  const s = setup();
  const run = (code, out, extra = "") => {
    stub(join(s.skill, "..", "jev", "bin"), extra);
    return decide(cluster, votes, "h", cfg(), { env: { ...s.env, PR_REVIEW_JEV_EXIT: code, PR_REVIEW_JEV_OUT: out }, skillDir: s.skill });
  };
  assert.equal((await run("1", "", "echo network error >&2")).decision, "unsure");
  assert.equal((await run("1", '{"verdict":"yes"}')).decision, "unsure");
  assert.equal((await run("0", '{"verdict":"no"}')).decision, "unsure");
  assert.equal((await run("1", '{"verdict":"trusted"}')).decision, "rejected");
  assert.equal((await run("0", '{"verdict":"doubted"}')).decision, "agreed");
});
