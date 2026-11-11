import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOutbound, redact } from "../lib/secrets.mjs";

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
