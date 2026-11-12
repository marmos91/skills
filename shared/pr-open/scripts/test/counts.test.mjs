import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initRepo, git } from "./repo.mjs";
import { Blocked, parseCounts, readRecord, runTests } from "../lib/counts.mjs";

const c = (passed, failed, skipped) => ({ passed, failed, skipped });

test("node --test summary", () => {
  assert.deepEqual(parseCounts("ℹ tests 417\nℹ suites 0\nℹ pass 416\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n"), c(416, 0, 1));
  assert.deepEqual(parseCounts("# tests 3\n# pass 2\n# fail 1\n# skipped 0\n"), c(2, 1, 0));
});

test("jest summary", () => {
  assert.deepEqual(parseCounts("Tests:       1 failed, 2 skipped, 40 passed, 43 total\n"), c(40, 1, 2));
});

test("vitest summary", () => {
  assert.deepEqual(parseCounts("      Tests  40 passed | 1 failed | 2 skipped (43)\n"), c(40, 1, 2));
});

test("pytest summary", () => {
  assert.deepEqual(parseCounts("===== 40 passed, 1 failed, 2 skipped in 1.20s =====\n"), c(40, 1, 2));
  assert.deepEqual(parseCounts("==== 5 passed in 0.1s ====\n"), c(5, 0, 0));
});

test("cargo sums the summary of each crate; ignored counts as skipped", () => {
  const out = "test result: ok. 40 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out\n" +
    "test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out\n";
  assert.deepEqual(parseCounts(out), c(43, 1, 2));
});

test("go test -v counts the result lines", () => {
  const out = "=== RUN   TestA\n--- PASS: TestA (0.00s)\n--- PASS: TestB (0.00s)\n--- FAIL: TestC (0.00s)\n--- SKIP: TestD (0.00s)\nok  \tx\t0.1s\n";
  assert.deepEqual(parseCounts(out), c(2, 1, 1));
});

test("several runs (a monorepo) are summed", () => {
  assert.deepEqual(parseCounts("Tests:       1 passed, 1 total\nTests:       1 failed, 2 passed, 3 total\n"), c(3, 1, 0));
  assert.deepEqual(parseCounts("ℹ pass 2\nℹ fail 0\nℹ skipped 1\nℹ pass 3\nℹ fail 1\n"), c(5, 1, 1));
  assert.deepEqual(parseCounts("==== 2 passed in 0.1s ====\n==== 3 passed, 1 skipped in 0.2s ====\n"), c(5, 0, 1));
});

test("no summary: null", () => {
  assert.equal(parseCounts("no summary here\n"), null);
});

test("runTests records the run for HEAD", async () => {
  const dir = initRepo();
  const sha = git(dir, "rev-parse", "HEAD");
  const r = await runTests(dir, 'echo "ℹ pass 3"; echo "ℹ fail 0"', { quiet: true });
  assert.equal(r.sha, sha); assert.equal(r.exit, 0);
  assert.deepEqual(r.counts, c(3, 0, 0));
  assert.deepEqual(readRecord(dir, sha), r);
});

test("runTests records a failed run with its exit code", async () => {
  const dir = initRepo();
  const r = await runTests(dir, "exit 1", { quiet: true });
  assert.equal(r.exit, 1); assert.equal(r.counts, null);
});

test("runTests on a dirty tree is blocked and writes no record", async () => {
  const dir = initRepo();
  writeFileSync(join(dir, "new.txt"), "x");
  await assert.rejects(runTests(dir, "true", { quiet: true }), Blocked);
  assert.equal(readRecord(dir, git(dir, "rev-parse", "HEAD")), null);
  assert.equal(existsSync(join(dir, ".git", "pr-open")), false);
});
