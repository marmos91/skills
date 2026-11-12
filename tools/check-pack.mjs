#!/usr/bin/env node
// Fails when the npm tarball would ship tests, benchmarks, local state or a secret.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

// release-please bumps metadata.version only in the files it lists: every SKILL.md must be there
const listed = JSON.parse(readFileSync("release-please-config.json", "utf8")).packages["."]["extra-files"];
const skills = ["shared", "pi", "claude"].flatMap((g) => existsSync(g) ? readdirSync(g).map((s) => `${g}/${s}/SKILL.md`).filter(existsSync) : []);
for (const f of skills) {
  if (!listed.includes(f)) bad.push(`${f}: missing from extra-files in release-please-config.json`);
  if (!/^\s+version:.*x-release-please-version/m.test(readFileSync(f, "utf8"))) bad.push(`${f}: no metadata.version line for release-please`);
}
// npm ships only the folders in package.json "files": a skill group outside it never reaches the tarball
const pkgFiles = JSON.parse(readFileSync("package.json", "utf8")).files;
for (const g of new Set(skills.map((s) => s.split("/")[0]))) if (!pkgFiles.includes(`${g}/`)) bad.push(`${g}/: has skills but is missing from "files" in package.json`);
for (const f of listed) if (!skills.includes(f)) bad.push(`${f}: in extra-files but not a skill`);

console.log(`${pack.name}@${pack.version}: ${files.length} files, ${pack.size} bytes`);
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
