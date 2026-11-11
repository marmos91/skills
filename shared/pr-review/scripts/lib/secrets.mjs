import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const L = "(?<![A-Za-z0-9])"; // \b misses tokens after "_"
const R = "(?![A-Za-z0-9])";
const PATTERNS = [
  ["aws-access-key-id", new RegExp(`${L}(AKIA|ASIA)[0-9A-Z]{16}${R}`, "g")],
  ["github-token", new RegExp(`${L}gh[pousr]_[A-Za-z0-9]{36,}${R}`, "g")],
  ["github-token", new RegExp(`${L}github_pat_[A-Za-z0-9_]{60,}${R}`, "g")],
  // whole block; no END marker redacts to the end of the text
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["slack-token", new RegExp(`${L}xox[baprs]-[A-Za-z0-9-]{10,}`, "g")],
  ["jwt", new RegExp(`${L}eyJ[A-Za-z0-9_-]{8,}\\.eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`, "g")],
  ["age-secret-key", /AGE-SECRET-KEY-1[0-9A-Z]{58}/g],
  ["bearer", new RegExp(`${L}bearer\\s+[A-Za-z0-9._~+/-]{20,}=*`, "gi")],
  ["anthropic-key", new RegExp(`${L}sk-ant-[A-Za-z0-9_-]{20,}`, "g")],
  ["openai-key", new RegExp(`${L}sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}`, "g")],
  ["stripe-key", new RegExp(`${L}[rs]k_live_[A-Za-z0-9]{16,}`, "g")],
  ["slack-webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g],
];

const mask = (s) => `${String(s).slice(0, 4)}…`;

/** Replace every built-in pattern match with [REDACTED:<kind>]. */
export function redact(text) {
  return PATTERNS.reduce((t, [kind, re]) => t.replace(re, `[REDACTED:${kind}]`), text);
}

const SCANNER_ERROR = "gitleaks: scanner-error";

// Fails closed: only "not installed" (ENOENT) is silent.
function gitleaksHits(text, timeoutMs) {
  const dir = mkdtempSync(join(tmpdir(), "pr-review-gl-"));
  const report = join(dir, "report.json");
  try {
    const res = spawnSync(
      "gitleaks",
      ["stdin", "--redact", "--report-format", "json", "--report-path", report],
      { input: text, encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
    );
    if (res.error?.code === "ENOENT") return [];
    if (res.error || (res.status !== 0 && res.status !== 1)) return [SCANNER_ERROR];
    const findings = JSON.parse(readFileSync(report, "utf8"));
    if (!Array.isArray(findings)) return [SCANNER_ERROR];
    return findings.map((f) => `${f.RuleID ?? "gitleaks"}: ${mask(f.Secret ?? f.Match ?? "")}`);
  } catch {
    return [SCANNER_ERROR]; // missing or invalid report
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Scan text about to be posted publicly. Hits never hold the full secret. */
export function scanOutbound(text, { timeoutMs = 30000 } = {}) {
  const hits = gitleaksHits(text, timeoutMs);
  for (const [kind, re] of PATTERNS) {
    for (const m of text.matchAll(re)) hits.push(`${kind}: ${mask(m[0])}`);
  }
  return { ok: hits.length === 0, hits };
}
