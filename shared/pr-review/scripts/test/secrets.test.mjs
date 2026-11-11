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
