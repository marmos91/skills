// Test stand-in for `gh`: pr-review's gh-stub behind a wrapper. ghStub(routes) sets GH_BIN; calls() reads the call log.
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const stub = fileURLToPath(new URL("../../../pr-review/scripts/test/gh-stub.mjs", import.meta.url));

export function ghStub(routes) {
  const dir = mkdtempSync(join(tmpdir(), "pr-open-gh-"));
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nGH_STUB_DIR='${dir}' exec '${process.execPath}' '${stub}' "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.GH_BIN = bin;
  return { dir, calls: () => readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}
