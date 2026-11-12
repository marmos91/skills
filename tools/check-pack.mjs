#!/usr/bin/env node
// Fails when the npm tarball would ship tests, benchmarks, local state or a secret.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scanOutbound } from "../shared/pr-review/scripts/lib/secrets.mjs";

const FORBIDDEN = /(^|\/)(test|tests|fixtures|bench|__pycache__|\.claude|\.pi|\.headroom|\.github)\/|(^|\/)test_[^/]*\.py$|\.test\.[a-z]+$|^docs\/superpowers\//;

const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const files = pack.files.map((f) => f.path);
const bad = [];
for (const f of files) {
  if (FORBIDDEN.test(f)) { bad.push(`${f}: must not ship`); continue; }
  const { ok, hits } = scanOutbound(readFileSync(f, "utf8"));
  if (!ok) bad.push(`${f}: ${hits.join(", ")}`);
}
for (const bin of Object.values(JSON.parse(readFileSync("package.json", "utf8")).bin)) if (!files.includes(bin)) bad.push(`${bin}: bin entry missing from the tarball`);

console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
