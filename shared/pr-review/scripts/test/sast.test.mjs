import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSast } from "../lib/sast.mjs";

test("runSast does not block the event loop while semgrep runs", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "sast-slow-"));
  writeFileSync(join(d, "a.js"), "x\n");
  writeFileSync(join(d, "semgrep"), `#!/bin/sh\ncat >/dev/null\nsleep 2\necho '{"results": []}'\n`);
  chmodSync(join(d, "semgrep"), 0o755);
  const was = process.env.PR_REVIEW_SEMGREP;
  process.env.PR_REVIEW_SEMGREP = join(d, "semgrep");
  t.after(() => { process.env.PR_REVIEW_SEMGREP = was; });
  const scan = runSast({ worktree: d, shellOk: true }, { review: { sast: true } }, ["security"], new Map([["a.js", new Set([1])]]), join(d, "sast.json"));
  // a blocking scan returns its result before any timer can fire
  assert.equal(await Promise.race([scan, new Promise((r) => setTimeout(() => r("tick"), 100))]), "tick");
  assert.equal((await scan).ran, true);
});

test("a semgrep timeout kills its whole process group", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "sast-grp-"));
  writeFileSync(join(d, "a.js"), "x\n");
  writeFileSync(join(d, "semgrep"), `#!/bin/sh\nsleep 30 &\necho $! >"${d}/pid"\nsleep 30\n`);
  chmodSync(join(d, "semgrep"), 0o755);
  const was = process.env.PR_REVIEW_SEMGREP;
  process.env.PR_REVIEW_SEMGREP = join(d, "semgrep");
  t.after(() => { process.env.PR_REVIEW_SEMGREP = was; });
  const t0 = Date.now();
  const r = await runSast({ worktree: d, shellOk: true }, { review: { sast: true } }, ["security"], new Map([["a.js", new Set([1])]]), join(d, "sast.json"), () => {}, 3000);
  assert.ok(Date.now() - t0 < 10000, "the scan waited for the grandchild"); // the grandchild holds stdout open
  assert.equal(r.ran, false);
  assert.match(r.note, /timed out/);
  const pid = Number(readFileSync(join(d, "pid"), "utf8"));
  const alive = () => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
  for (const end = Date.now() + 5000; alive() && Date.now() < end;) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(), false, "the grandchild still runs");
});

test("review.sast_timeout_s caps the scan", async (t) => {
  const d = mkdtempSync(join(tmpdir(), "sast-cap-"));
  writeFileSync(join(d, "a.js"), "x\n");
  writeFileSync(join(d, "semgrep"), `#!/bin/sh\nsleep 5\necho '{"results": []}'\n`);
  chmodSync(join(d, "semgrep"), 0o755);
  const was = process.env.PR_REVIEW_SEMGREP;
  process.env.PR_REVIEW_SEMGREP = join(d, "semgrep");
  t.after(() => { process.env.PR_REVIEW_SEMGREP = was; });
  const r = await runSast({ worktree: d, shellOk: true }, { review: { sast: true, sast_timeout_s: 1 } }, ["security"], new Map([["a.js", new Set([1])]]), join(d, "sast.json"));
  assert.match(r.note, /timed out after 1s/);
});
