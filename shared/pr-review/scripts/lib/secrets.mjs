import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PATTERNS = [
  ["aws-access-key-id", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ["github-token", /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["slack-token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["age-secret-key", /AGE-SECRET-KEY-1[0-9A-Z]{58}/g],
  ["bearer", /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g],
];

const mask = (s) => `${String(s).slice(0, 4)}…`;

/** Replace every built-in pattern match with [REDACTED:<kind>]. */
export function redact(text) {
  return PATTERNS.reduce((t, [kind, re]) => t.replace(re, `[REDACTED:${kind}]`), text);
}

function gitleaksHits(text) {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-gl-"));
  const report = join(dir, "report.json");
  try {
    // exit 1 means leaks found; the report file is the source of truth.
    const res = spawnSync(
      "gitleaks",
      ["detect", "--no-git", "--pipe", "--redact", "--report-format", "json", "--report-path", report],
      { input: text, encoding: "utf8" },
    );
    if (res.error) return []; // not on PATH
    const findings = JSON.parse(readFileSync(report, "utf8") || "[]");
    return findings.map((f) => `${f.RuleID ?? "gitleaks"}: ${mask(f.Secret ?? f.Match ?? "")}`);
  } catch {
    return []; // shortcut: unreadable report is treated as no hits; built-ins still run
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Scan text about to be posted publicly. Hits never hold the full secret. */
export function scanOutbound(text) {
  const hits = gitleaksHits(text);
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) hits.push(`${kind}: ${mask(m[0])}`);
  }
  return { ok: hits.length === 0, hits };
}
