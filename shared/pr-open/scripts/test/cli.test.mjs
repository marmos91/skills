import { test } from "node:test";
import assert from "node:assert/strict";
import { initRepo, commit, git } from "./repo.mjs";
import { main } from "../main.mjs";

function capture(t) {
  const out = [];
  t.mock.method(console, "log", (l) => out.push(l));
  t.mock.method(console, "error", () => {});
  return () => JSON.parse(out.join("\n"));
}

test("check: an unsigned commit exits 2 with JSON", async (t) => {
  const dir = initRepo();
  git(dir, "checkout", "-q", "-b", "feat/x");
  commit(dir, "a.txt", "a", "feat: a", { sign: false });
  const cwd = process.cwd(); process.chdir(dir); t.after(() => process.chdir(cwd));
  const json = capture(t);
  assert.equal(await main(["check", "--base", "main"]), 2);
  assert.equal(json().unsigned.length, 1);
});

test("test: no command found exits 1; a passing --command exits 0 with the record", async (t) => {
  const dir = initRepo();
  const cwd = process.cwd(); process.chdir(dir); t.after(() => process.chdir(cwd));
  const old = process.env.PR_OPEN_TEST; delete process.env.PR_OPEN_TEST;
  t.after(() => { if (old !== undefined) process.env.PR_OPEN_TEST = old; });
  const json = capture(t);
  assert.equal(await main(["test"]), 1);
  assert.equal(await main(["test", "--command", 'echo "ℹ pass 4"']), 0);
  assert.deepEqual(json().counts, { passed: 4, failed: 0, skipped: 0 });
});

test("unknown command exits 1", async (t) => {
  capture(t);
  assert.equal(await main(["nope"]), 1);
});
