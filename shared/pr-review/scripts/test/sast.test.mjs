import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
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
