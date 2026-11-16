import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileValues, scanOutbound, redact } from "../lib/secrets.mjs";

// A developer's own ~/.config/secret-scan must not change these results.
process.env.SECRET_SCAN_CONFIG = mkdtempSync(join(tmpdir(), "ss-empty-"));

const r = (c, n) => c.repeat(n);
const cases = {
  "aws-access-key-id": "AKIA" + r("X", 16),
  "github-token": "ghp_" + r("a", 36),
  "github-token-pat": "github_pat_" + r("b", 60),
  "private-key": "-----BEGIN RSA PRIVATE KEY-----",
  "slack-token": "xoxb-" + r("1", 12),
  jwt: "eyJ" + r("a", 10) + ".eyJ" + r("b", 10) + "." + r("c", 10),
  "age-secret-key": "AGE-SECRET-KEY-1" + r("Q", 58),
  bearer: "Bearer " + r("z", 24),
  "anthropic-key": "sk-ant-api03-" + r("A", 30),
  "openai-key": "sk-proj-" + r("B", 40),
  "stripe-key": "sk_live_" + r("C", 24),
  "slack-webhook": "https://hooks.slack.com/services/" + r("T", 9) + "/" + r("B", 11) + "/" + r("x", 24),
};

for (const [kind, secret] of Object.entries(cases)) {
  test(`hit: ${kind}`, () => {
    const res = scanOutbound(`Found this: ${secret} in the diff`);
    assert.equal(res.ok, false);
    assert.ok(res.hits.length >= 1);
    for (const h of res.hits) assert.ok(!h.includes(secret));
    const red = redact(`x ${secret} y`);
    assert.ok(!red.includes(secret));
    assert.match(red, /\[REDACTED:[a-z-]+\]/);
  });
}

test("normal review text has no hit", () => {
  const body = "The token is read from GH_TOKEN; the secret rotates. See commit 3f9a1c2 and abcdef0123456789abcdef0123456789abcdef01. Bearer auth is used.";
  assert.deepEqual(scanOutbound(body), { ok: true, hits: [] });
  assert.equal(redact(body), body);
});

test("gitleaks hits merge with built-ins", () => {
  const dir = mkdtempSync(join(tmpdir(), "gl-"));
  const stub = join(dir, "gitleaks");
  writeFileSync(stub, `#!/bin/sh
cat >/dev/null
while [ $# -gt 0 ]; do [ "$1" = "--report-path" ] && p="$2"; shift; done
echo '[{"RuleID":"custom-rule","Secret":"REDACTED","Match":"zzzzsecretvalue"}]' > "$p"
exit 1
`);
  chmodSync(stub, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try {
    const res = scanOutbound("clean text");
    assert.equal(res.ok, false);
    assert.ok(res.hits[0].startsWith("custom-rule"));
    assert.ok(!res.hits[0].includes("zzzzsecretvalue"));
  } finally {
    process.env.PATH = old;
  }
});

function withStub(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), "gl-"));
  const stub = join(dir, "gitleaks");
  writeFileSync(stub, `#!/bin/sh\n${script}\n`);
  chmodSync(stub, 0o755);
  const old = process.env.PATH;
  process.env.PATH = `${dir}:${old}`;
  try { return fn(); } finally { process.env.PATH = old; }
}
const getReport = `while [ $# -gt 0 ]; do [ "$1" = "--report-path" ] && p="$2"; shift; done`;

for (const [name, script] of Object.entries({
  "exit 2": "cat >/dev/null; exit 2",
  "no report": "cat >/dev/null; exit 0",
  "null report": `cat >/dev/null; ${getReport}; echo null > "$p"`,
  "invalid report": `cat >/dev/null; ${getReport}; echo '{{' > "$p"`,
})) {
  test(`scanner error fails closed: ${name}`, () => {
    withStub(script, () => {
      const res = scanOutbound("clean text");
      assert.equal(res.ok, false);
      assert.deepEqual(res.hits, ["gitleaks: scanner-error"]);
    });
  });
}

test("scanner error fails closed: timeout", () => {
  withStub("exec sleep 5", () => {
    const res = scanOutbound("clean text", { timeoutMs: 200 });
    assert.equal(res.ok, false);
    assert.deepEqual(res.hits, ["gitleaks: scanner-error"]);
  });
});

test("gitleaks exit 0 with empty array is ok", () => {
  withStub(`cat >/dev/null; ${getReport}; echo '[]' > "$p"`, () => {
    assert.deepEqual(scanOutbound("clean text"), { ok: true, hits: [] });
  });
});

test("redact removes whole private key block, complete and truncated", () => {
  const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC";
  const full = `a\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\nb`;
  const rf = redact(full);
  assert.ok(!rf.includes(body));
  assert.ok(rf.startsWith("a\n[REDACTED:private-key]") && rf.endsWith("\nb"));
  const cut = `a\n-----BEGIN RSA PRIVATE KEY-----\n${body}\nmore`;
  const rc = redact(cut);
  assert.ok(!rc.includes(body) && !rc.includes("more"));
});

test("tokens after underscore and case-insensitive bearer hit", () => {
  assert.equal(scanOutbound("KEY_" + cases["aws-access-key-id"]).ok, false);
  assert.equal(scanOutbound("TOKEN_" + cases["github-token"]).ok, false);
  assert.equal(scanOutbound("BEARER " + "z".repeat(24)).ok, false);
});

test("deterministic, redact-then-scan clean, multiple secrets all hit", () => {
  const text = `${cases["aws-access-key-id"]} and ${cases["github-token"]} and ${cases["slack-token"]}`;
  const a = scanOutbound(text);
  assert.deepEqual(scanOutbound(text), a);
  assert.equal(a.hits.length, 3);
  assert.deepEqual(scanOutbound(redact(text)), { ok: true, hits: [] });
});

const hasGitleaks = spawnSync("gitleaks", ["version"]).status === 0;
test("real gitleaks flags a random token and passes clean text", { skip: !hasGitleaks && "gitleaks not on PATH" }, () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const rand = Array.from(randomBytes(36), (b) => chars[b % chars.length]).join("");
  const res = scanOutbound(`leaked ghp_${rand} here`);
  assert.equal(res.ok, false);
  assert.ok(res.hits.length >= 2, `expected gitleaks plus built-in hit, got ${res.hits}`);
  assert.ok(res.hits.every((h) => !h.includes(rand)));
  assert.deepEqual(scanOutbound("Looks fine, but check GH_TOKEN handling."), { ok: true, hits: [] });
});

function withConfig(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "ss-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), typeof text === "function" ? text(dir) : text);
  const old = process.env.SECRET_SCAN_CONFIG;
  process.env.SECRET_SCAN_CONFIG = dir;
  t.after(() => { process.env.SECRET_SCAN_CONFIG = old; });
  return dir;
}

test("the outbound scan applies the local secret-scan config: private names, sops values, allow list", (t) => {
  const value = "v4lue" + "x".repeat(12);
  const dir = withConfig(t, { "private.txt": "example\\.internal\n", "creds.env": `export API_KEY="${value}"\n`, "sops-files.txt": (d) => join(d, "creds.env") });
  const res = scanOutbound(`ping db.example.internal with ${value}`);
  assert.deepEqual(res.hits.map((h) => h.split(":")[0]), ["private-infra", "sops-value"]);
  assert.ok(res.hits.every((h) => !h.includes("example") && !h.includes(value)));
  writeFileSync(join(dir, "allow.txt"), res.hits.map((h) => `${/fp (\w+)/.exec(h)[1]} test fixture`).join("\n"));
  assert.deepEqual(scanOutbound(`ping db.example.internal with ${value}`), { ok: true, hits: [] });
});

test("a trailing # comment on a config line is dropped; \\# is a literal #", (t) => {
  const value = "v4lue" + "y".repeat(12);
  withConfig(t, {
    "private.txt": "example\\.internal # our domain\nbuild\\#7\n",
    "creds.env": `TOKEN=${value}\n`,
    "sops-files.txt": (d) => `${join(d, "creds.env")}   # rendered by sops-nix\n`,
  });
  assert.equal(scanOutbound("deploy on db01.example.internal").ok, false);
  assert.equal(scanOutbound("see build#7").ok, false);
  assert.equal(scanOutbound(`uses ${value}`).ok, false);
});

test("a config file that is there but unreadable blocks; a missing one is skipped", { skip: process.getuid?.() === 0 && "root reads every file" }, (t) => {
  const dir = withConfig(t, { "private.txt": "example\\.internal\n" });
  assert.deepEqual(scanOutbound("clean text"), { ok: true, hits: [] });
  chmodSync(join(dir, "private.txt"), 0o000);
  t.after(() => chmodSync(join(dir, "private.txt"), 0o600));
  const res = scanOutbound("clean text");
  assert.equal(res.ok, false);
  assert.match(res.hits[0], /^secret-scan: config unreadable \(EACCES\)/);
  writeFileSync(join(dir, "sops-files.txt"), join(dir, "nope.env"));
  chmodSync(join(dir, "private.txt"), 0o600);
  assert.deepEqual(scanOutbound("clean text"), { ok: true, hits: [] });
});

test("CRLF config lines: a trailing comment is still dropped", (t) => {
  withConfig(t, { "private.txt": "example\\.internal # our domain\r\nother\\.internal\r\n" });
  assert.equal(scanOutbound("deploy on db01.example.internal").ok, false);
  assert.equal(scanOutbound("deploy on db01.other.internal").ok, false);
});

test("allow.txt: the reason is verbatim, a # in it does not cut it", (t) => {
  const dir = withConfig(t, { "private.txt": "example\\.internal\n" });
  const fp = /fp (\w+)/.exec(scanOutbound("see db01.example.internal").hits[0])[1];
  writeFileSync(join(dir, "allow.txt"), `${fp} #123 names it on purpose\n`);
  assert.deepEqual(scanOutbound("see db01.example.internal"), { ok: true, hits: [] });
  writeFileSync(join(dir, "allow.txt"), `${fp}\n# ${fp} commented out\n`);
  assert.equal(scanOutbound("see db01.example.internal").ok, false);
});

test("a dangling link in sops-files.txt (a secret that did not render) blocks", (t) => {
  const dir = withConfig(t, {});
  symlinkSync(join(dir, "gone.env"), join(dir, "creds.env"));
  writeFileSync(join(dir, "sops-files.txt"), join(dir, "creds.env"));
  const res = scanOutbound("clean text");
  assert.equal(res.ok, false);
  assert.match(res.hits[0], /^secret-scan: config unreadable \(ENOENT\)/);
});

test("a repo in private-repos.txt skips the private set through the library too; no repo is strict", (t) => {
  withConfig(t, { "private.txt": "example\\.internal\n", "private-repos.txt": "me/infra\n" });
  assert.equal(scanOutbound("db01.example.internal", { repo: "me/infra" }).ok, true);
  assert.equal(scanOutbound("db01.example.internal", { repo: "me/public" }).ok, false);
  assert.equal(scanOutbound("db01.example.internal").ok, false);
});

test("many hits in a big diff stay fast (line numbers are not recounted per hit)", () => {
  const line = `+const k = "${cases["aws-access-key-id"]}";\n`;
  const text = "+x\n".repeat(100000) + line.repeat(3000);
  const t0 = Date.now();
  // a stub gitleaks: a real one would add its own hits and time
  const res = withStub(`cat >/dev/null; ${getReport}; echo '[]' > "$p"`, () => scanOutbound(text));
  assert.equal(res.hits.length, 3000);
  assert.match(res.hits.at(-1), /\(line 103000, fp/);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});

test("fileValues: the values of each supported format", () => {
  const v = "Abcd1234Efgh5678";
  const pad = "dGhpc2lzYXZlcnlsb25nc2VjcmV0dmFsdWU=";
  const table = [
    ["bare line", `${v}\n`, [v]],
    ["bare base64 with = padding", `${pad}\n`, [pad]],
    ["key = value (INI)", `[default]\naws_secret = ${v}\n`, [v]],
    ["key=value (env)", `TOKEN=${v}\n`, [`TOKEN=${v}`, v]],
    ["export KEY=\"value\"", `export TOKEN="${v}"\n`, [`TOKEN="${v}"`, v]],
    ["key: value (YAML)", `token: ${v}\n`, [v]],
    ["nested YAML, quoted", `a:\n  b: '${v}'\n`, [v]],
    ["YAML list item", `- ${v}\n`, [v]],
    ["inline # comment", `token: ${v} # prod\n`, [v]],
    ["inline ; comment", `token = ${v} ; rotated\n`, [v]],
    ["# inside a value stays", `token: ab#cd${v}\n`, [`ab#cd${v}`]],
    ["CRLF", `token: ${v}\r\n`, [v]],
    ["JSON leaves", JSON.stringify({ a: { b: v }, n: [pad] }), [v, pad]],
    ["comments, sections, short values and spaces are not values", `# ${v}\n; ${v}\n[section]\n---\nregion: eu-west-1\nname: two words here ok\n`, []],
  ];
  for (const [name, text, want] of table) assert.deepEqual(fileValues(text), want, name);
});

test("a relative sops-files.txt entry is in the config folder, wherever the scan runs", (t) => {
  const value = "r3lative" + "z".repeat(10);
  withConfig(t, { "kubeconfig": `token: ${value}\n`, "sops-files.txt": "kubeconfig\n" });
  const cwd = process.cwd();
  process.chdir(tmpdir());
  t.after(() => process.chdir(cwd));
  assert.equal(scanOutbound(`uses ${value}`).ok, false);
});

test("mask never shows a whole short value", (t) => {
  withConfig(t, { "private.txt": "\\bab\\b\n" });
  const res = scanOutbound("x ab y");
  assert.equal(res.ok, false);
  assert.match(res.hits[0], /^private-infra: a… /);
});

test("gitleaks runs outside the scanned repo: a .gitleaks.toml in the cwd does not reach it", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "repo-"));
  writeFileSync(join(repo, ".gitleaks.toml"), "[allowlist]\nregexes = ['.*']\n");
  const cwd = process.cwd();
  process.chdir(repo);
  t.after(() => process.chdir(cwd));
  // the stub fails when it can see a repo config: a scan that reads it errors (fails closed)
  withStub(`cat >/dev/null; [ -e .gitleaks.toml ] && exit 2; ${getReport}; echo '[]' > "$p"`, () => {
    assert.deepEqual(scanOutbound("clean text"), { ok: true, hits: [] });
  });
});
