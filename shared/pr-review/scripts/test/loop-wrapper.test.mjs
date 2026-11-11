import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const bin = join(dirname(fileURLToPath(import.meta.url)), "../../../pr-review-loop/scripts/pr-review-loop");

test("pause writes the paused file; resume removes it", () => {
  const env = { ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "loopw-")) };
  const paused = join(env.XDG_STATE_HOME, "pr-review", "o__r", "paused");
  assert.match(execFileSync(bin, ["pause", "o/r"], { env, encoding: "utf8" }), /paused: o\/r/);
  assert.ok(existsSync(paused));
  execFileSync(bin, ["resume", "o/r"], { env });
  assert.equal(existsSync(paused), false);
  execFileSync(bin, ["resume", "o/r"], { env }); // resume when not paused is fine
});

test("pause rejects a bad repo name", () => {
  const env = { ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "loopw-")) };
  assert.throws(() => execFileSync(bin, ["pause", "../x"], { env, stdio: "pipe" }));
});
