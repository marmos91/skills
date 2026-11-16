import "../../../pr-review/scripts/test/hermetic.mjs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initRepo, commit, git } from "../../../pr-open/scripts/test/repo.mjs";
import { ghStub } from "../../../pr-open/scripts/test/gh.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "pr-respond");

test("scan: the private-repos opt-out needs a GitHub push target; off GitHub it is strict and says so", () => {
  const cfg = process.env.SECRET_SCAN_CONFIG;
  writeFileSync(join(cfg, "private.txt"), "example\\.internal\n");
  writeFileSync(join(cfg, "private-repos.txt"), "o/r\n");
  ghStub({ "pr view --json baseRefName --jq .baseRefName": { stdout: "main" }, "repo view --json nameWithOwner --jq .nameWithOwner": { stdout: "o/r" } });
  const dir = initRepo({ origin: true });
  git(dir, "checkout", "-q", "-b", "fix/x");
  commit(dir, "a.txt", "cache on db01.example.internal\n", "fix: a");
  const scan = () => spawnSync(CLI, ["scan"], { cwd: dir, encoding: "utf8" });

  const strict = scan(); // origin is a local path
  assert.equal(strict.status, 1, strict.stderr);
  assert.match(strict.stderr, /origin does not push only to github\.com/);
  assert.match(strict.stderr, /^private-infra: /m);
  assert.ok(!strict.stderr.includes("db01"));

  git(dir, "config", "remote.origin.pushurl", "https://github.com/o/r.git");
  const listed = scan();
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stderr, "");
});
