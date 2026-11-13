import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, readOverride } from "../lib/detect.mjs";
import { Usage } from "../lib/counts.mjs";

const tmp = (files) => {
  const d = mkdtempSync(join(tmpdir(), "pr-open-detect-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  return d;
};
const pick = ({ format, lint, test }) => ({ format, lint, test });

test("package.json scripts with a pnpm lockfile", () => {
  const d = tmp({ "package.json": JSON.stringify({ scripts: { fmt: "x", lint: "y", test: "z" } }), "pnpm-lock.yaml": "" });
  assert.deepEqual(pick(detect(d, {})), { format: "pnpm run fmt", lint: "pnpm run lint", test: "pnpm run test" });
});

test("bun.lock (text lockfile) uses bun", () => {
  const d = tmp({ "package.json": JSON.stringify({ scripts: { test: "z" } }), "bun.lock": "" });
  assert.equal(detect(d, {}).test, "bun run test");
});

test("package.json without a lockfile uses npm", () => {
  const d = tmp({ "package.json": JSON.stringify({ scripts: { format: "x", test: "z" } }) });
  assert.deepEqual(pick(detect(d, {})), { format: "npm run format", lint: null, test: "npm run test" });
});

test("env beats .pr-open.json beats Makefile", () => {
  const d = tmp({ Makefile: "test:\n\ttrue\nlint:\n\ttrue\n", ".pr-open.json": JSON.stringify({ lint: "my-lint" }) });
  const r = detect(d, { PR_OPEN_TEST: "my-test" });
  assert.equal(r.test, "my-test"); assert.equal(r.source.test, "env");
  assert.equal(r.lint, "my-lint"); assert.equal(r.source.lint, ".pr-open.json");
  assert.equal(r.format, null); assert.equal(r.source.format, null);
});

test("Makefile and justfile targets", () => {
  assert.deepEqual(pick(detect(tmp({ Makefile: "fmt:\n\tgofmt\ntest: build\n\tgo test\n" }), {})), { format: "make fmt", lint: null, test: "make test" });
  assert.deepEqual(pick(detect(tmp({ justfile: "lint:\n  x\ntest *args:\n  y\n" }), {})), { format: null, lint: "just lint", test: "just test" });
});

test("go.mod and Cargo.toml defaults", () => {
  assert.deepEqual(pick(detect(tmp({ "go.mod": "module x\n" }), {})), { format: "gofmt -w .", lint: "go vet ./...", test: "go test -v ./..." });
  assert.deepEqual(pick(detect(tmp({ "Cargo.toml": "[package]\n" }), {})), { format: "cargo fmt", lint: "cargo clippy -- -D warnings", test: "cargo test" });
});

test("nothing found: all null", () => {
  assert.deepEqual(pick(detect(tmp({}), {})), { format: null, lint: null, test: null });
});

test("readOverride: missing file is empty, invalid JSON throws with the file name", () => {
  assert.deepEqual(readOverride(tmp({})), {});
  assert.throws(() => readOverride(tmp({ ".pr-open.json": "{" })), (e) => e instanceof Usage && /\.pr-open\.json/.test(e.message));
});
