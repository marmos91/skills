import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
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

// A fork clone: origin is the fork, upstream is the source repo, and `gh repo view` would name the upstream.
function forkClone() {
  const root = mkdtempSync(join(tmpdir(), "loopw-fork-"));
  const dir = join(root, "repo"), bin = join(root, "bin");
  mkdirSync(dir); mkdirSync(bin);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["remote", "add", "upstream", "https://github.com/up/r.git"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:me/fork.git"], { cwd: dir });
  writeFileSync(join(bin, "gh"), "#!/bin/sh\necho up/r\n");
  chmodSync(join(bin, "gh"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  delete env.GH_BIN;
  return { dir, env };
}
const loop = (fx, ...args) => spawnSync(bin, args, { cwd: fx.dir, env: fx.env, encoding: "utf8" });

test("pause and tick resolve the same repo in a fork clone (origin, not the gh default)", () => {
  const fx = forkClone();
  const p = loop(fx, "pause");
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /paused: me\/fork/);
  const t = loop(fx);
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stderr, /paused/);
  assert.match(loop(fx, "resume").stdout, /resumed: me\/fork/);
});

test("tick with a positional repo sees the pause of that repo", () => {
  const fx = forkClone();
  assert.equal(loop(fx, "pause", "o/r").status, 0);
  const t = loop(fx, "o/r");
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stderr, /paused/);
});

test("the bin link runs the wrapper; pause takes --repo; answer passes --repo", () => {
  const link = join(dirname(bin), "..", "bin", "pr-review-loop");
  const env = { ...process.env, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "loopbin-")) };
  const paused = join(env.XDG_STATE_HOME, "pr-review", "o__r", "paused");
  assert.match(execFileSync(link, ["pause", "--repo", "o/r"], { env, encoding: "utf8" }), /paused: o\/r/);
  assert.ok(existsSync(paused));
  assert.equal(spawnSync(link, ["pause", "o/r", "EXTRA"], { env }).status, 1);
  assert.equal(JSON.parse(execFileSync(link, ["answer", "--repo", "o/r"], { env, encoding: "utf8" })).length, 0);
});
