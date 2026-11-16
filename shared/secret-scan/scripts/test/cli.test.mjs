import "../../../pr-review/scripts/test/hermetic.mjs";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "secret-scan");
// Built at runtime: no fixture holds a real token or a real private name.
const TOKEN = "ghp_" + "D".repeat(36);
const HOST = "db01.example.internal";
const SOPS_VALUE = "s3cr" + "Q7".repeat(8);

function setup(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "secret-scan-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  // cwd outside any clone: no repo is detected
  const scan = (input, ...args) => spawnSync(CLI, args, { input, cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, SECRET_SCAN_CONFIG: dir } });
  return { dir, scan };
}

test("clean text exits 0 and prints nothing", () => {
  const r = setup().scan("Fixes the retry loop; see GH_TOKEN handling.");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, "");
});

test("a key in a diff: exit 1, file:line, masked", () => {
  const diff = `diff --git a/src/config.js b/src/config.js\n--- a/src/config.js\n+++ b/src/config.js\n@@ -1,2 +1,3 @@\n const a = 1;\n-const t = "";\n+const t = "${TOKEN}";\n const b = 2;\n`;
  const r = setup().scan(diff);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^github-token: ghp_… \(src\/config\.js:2, fp [0-9a-f]{12}\)$/m);
  assert.ok(!r.stderr.includes(TOKEN));
});

test("a private hostname in a PR body: hit without printing the name or the list", () => {
  const { scan } = setup({ "private.txt": `# internal hosts\ndb\\d+\\.example\\.internal\n` });
  const r = scan(`## Summary\n\nMoves the cache next to ${HOST.toUpperCase()}.\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^private-infra: DB01… \(line 3, fp [0-9a-f]{12}\)$/m);
  assert.ok(!/example|internal|\\d/i.test(r.stderr));
});

test("a private repo listed in private-repos.txt skips the private set; others stay strict", () => {
  const { scan } = setup({ "private.txt": "example\\.internal\n", "private-repos.txt": "me/infra\n" });
  assert.equal(scan(`host ${HOST}`, "--repo", "me/infra").status, 0);
  assert.equal(scan(`host ${HOST}`, "--repo", "me/public").status, 1);
  assert.equal(scan(`host ${HOST} ${TOKEN}`, "--repo", "me/infra").status, 1, "secrets are still checked");
});

test("a sops value in a review comment: hit, value and key never printed; missing files skipped", () => {
  const { dir, scan } = setup();
  writeFileSync(join(dir, "creds.yaml"), `service:\n  api_password: "${SOPS_VALUE}"\n  region: eu-west-1\n`);
  writeFileSync(join(dir, "token.json"), JSON.stringify({ nested: { value: "tok-" + "9".repeat(20) } }));
  writeFileSync(join(dir, "sops-files.txt"), `${join(dir, "creds.yaml")}\n${join(dir, "token.json")}\n${join(dir, "missing.env")}\n`);
  const r = scan(`Nit: the test uses ${SOPS_VALUE} as a password.`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^sops-value: s3cr… \(line 1, fp [0-9a-f]{12}\)$/m);
  assert.ok(!r.stderr.includes(SOPS_VALUE));
  assert.equal(scan("tok-" + "9".repeat(20)).status, 1, "JSON leaves are values");
  assert.equal(scan("api_password and region eu-west-1 and service").status, 0, "keys and short values are not");
});

test("an allowed hit with a reason does not block; without a reason it does", () => {
  const { dir, scan } = setup({ "private.txt": "example\\.internal\n" });
  const body = `see ${HOST}`;
  const fp = /fp ([0-9a-f]{12})/.exec(scan(body).stderr)[1];
  writeFileSync(join(dir, "allow.txt"), `${fp}\n`);
  assert.equal(scan(body).status, 1);
  writeFileSync(join(dir, "allow.txt"), `# docs name it on purpose\n${fp} example name in the README\n`);
  const r = scan(body);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(scan(`${body} ${TOKEN}`).status, 1, "other hits still block");
});

test("file arguments are labelled file:line; usage errors exit 2", () => {
  const { dir, scan } = setup();
  writeFileSync(join(dir, "notes.md"), `one\ntwo ${TOKEN}\n`);
  const r = scan("", "notes.md");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /\(notes\.md:2, /);
  assert.equal(scan("", "nope.md").status, 2);
  assert.equal(scan("", "--bogus").status, 2);
  assert.equal(scan("", "--help").status, 0);
});

test("every hit line reaches a pipe before the exit", () => {
  const { dir, scan } = setup();
  writeFileSync(join(dir, "big.txt"), `${TOKEN}\n`.repeat(50000));
  const r = scan("", "big.txt");
  assert.equal(r.status, 1);
  assert.equal(r.stderr.trimEnd().split("\n").length, 50000);
});

const git = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

test("more than 125k hits: every line printed, no stack overflow", () => {
  const { dir, scan } = setup();
  writeFileSync(join(dir, "huge.txt"), `${TOKEN}\n`.repeat(150000));
  const r = scan("", "huge.txt");
  assert.equal(r.status, 1, r.stderr.slice(-300));
  assert.equal(r.stderr.trimEnd().split("\n").length, 150000);
});

test("a read error on a later file: the earlier hits still print, then the error, exit 2", () => {
  const { dir, scan } = setup();
  writeFileSync(join(dir, "a.txt"), `${TOKEN}\n`);
  const r = scan("", "a.txt", "missing.md");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^github-token: ghp_… \(a\.txt:1, fp [0-9a-f]{12}\)\nsecret-scan: cannot read missing\.md: ENOENT/);
});

test("no --repo is strict: the cwd's origin does not opt out", () => {
  const { dir, scan } = setup({ "private.txt": "example\\.internal\n", "private-repos.txt": "me/infra\n" });
  git(dir, "init", "-q");
  git(dir, "remote", "add", "origin", "git@github.com:me/infra.git");
  assert.equal(scan(`host ${HOST}`).status, 1);
  assert.equal(scan(`host ${HOST}`, "--repo", "me/infra").status, 0);
});

test("--range scans each commit's patch, binary-marked files included, and a bad range exits 2", () => {
  const { dir, scan } = setup();
  const g = (...a) => git(dir, ...a);
  g("init", "-q", "-b", "main"); g("config", "user.name", "T"); g("config", "user.email", "t@example.com");
  writeFileSync(join(dir, "README.md"), "x\n"); g("add", "."); g("commit", "-q", "--no-gpg-sign", "-m", "init");
  writeFileSync(join(dir, ".gitattributes"), "* -diff\n");
  writeFileSync(join(dir, "prod.yaml"), `token: ${TOKEN}\n`);
  g("add", "."); g("commit", "-q", "--no-gpg-sign", "-m", "add config");
  const r = scan("", "--range", "HEAD~1..HEAD");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^github-token: ghp_… \(prod\.yaml:1, fp /m);
  assert.equal(scan("", "--range", "HEAD..HEAD").status, 0);
  const bad = scan("", "--range", "nope..HEAD");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /cannot read range nope\.\.HEAD/);
});
