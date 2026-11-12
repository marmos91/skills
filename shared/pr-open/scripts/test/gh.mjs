// Test stand-in for `gh`. ghStub(routes) returns { dir, calls() } and sets GH_BIN.
// A route key is a prefix of the argv joined with spaces; the longest matching prefix answers.
// Run as a script (by the sh wrapper), it answers one call and logs it to calls.jsonl.
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const self = fileURLToPath(import.meta.url);

export function ghStub(routes) {
  const dir = mkdtempSync(join(tmpdir(), "pr-open-gh-"));
  writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
  writeFileSync(join(dir, "calls.jsonl"), "");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nGH_STUB_DIR='${dir}' exec node '${self}' "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.GH_BIN = bin;
  return { dir, calls: () => readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

if (process.argv[1] === self) {
  const dir = process.env.GH_STUB_DIR;
  const argv = process.argv.slice(2);
  const key = argv.join(" ");
  appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ argv }) + "\n");
  const routes = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
  const hit = Object.keys(routes).filter((k) => key === k || key.startsWith(k + " ")).sort((a, b) => b.length - a.length)[0];
  if (!hit) { process.stderr.write(`gh stub: no route for: ${key}\n`); process.exit(1); }
  const r = routes[hit];
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout));
  process.exit(r.exit ?? 0);
}
