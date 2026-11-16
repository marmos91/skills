// The one secret scan: pr-review, pr-respond and pr-open use it here; the secret-scan skill is its CLI.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

const SCANNER_ERROR = { rule: "gitleaks", masked: "scanner-error" };

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
    return findings.map((f) => ({ rule: f.RuleID ?? "gitleaks", masked: mask(f.Secret ?? f.Match ?? ""), line: f.StartLine }));
  } catch {
    return [SCANNER_ERROR]; // missing or invalid report
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Local, untracked config: the lists never leave the machine and are never printed.
const configDir = () => process.env.SECRET_SCAN_CONFIG || join(homedir(), ".config", "secret-scan");
// A missing file is skipped (other machines); a file that is there but unreadable throws, so the scan fails closed.
// A dangling link (a sops-nix secret that did not render) is there: it throws too.
function readIfThere(path) {
  try { return readFileSync(path, "utf8"); } catch (e) {
    if (e.code !== "ENOENT") throw e;
    try { lstatSync(path); } catch { return null; }
    throw e;
  }
}
const rawLines = (name) => (readIfThere(join(configDir(), name)) ?? "").split(/\r?\n/);
// `#` at the start of a line or after whitespace starts a comment; `\#` is a literal `#` in a pattern.
const lines = (name) => rawLines(name).map((l) => l.replace(/(^|\s)#.*$/, "").trim()).filter(Boolean);
const fingerprint = (rule, value) => createHash("sha256").update(`${rule}\0${value}`).digest("hex").slice(0, 12);

// private.txt: one regex per line, case-insensitive; a line that is not a valid regex is a literal.
function privatePatterns() {
  return lines("private.txt").map((l) => {
    try { return new RegExp(l, "gi"); } catch { return new RegExp(l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"); }
  });
}

// sops-files.txt: one plain file per line, as sops-nix renders them (missing ones are skipped: other machines).
// Each value is a secret: JSON leaves, or the value of each `key = value` / `key: value` line, or a bare line.
// shortcut: values under 12 chars or with spaces are skipped as noise; add them to private.txt when they matter.
const leaves = (v) => (v && typeof v === "object" ? Object.values(v).flatMap(leaves) : [String(v)]);
function fileValues(text) {
  try { return leaves(JSON.parse(text)); } catch { /* not JSON */ }
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !/^[#;[]/.test(l))
    .map((l) => l.replace(/^(?:export\s+|-\s+)?[\w.-]+\s*[=:]\s*/, ""));
}
function sopsValues() {
  return lines("sops-files.txt").flatMap((f) => {
    const text = readIfThere(f.replace(/^~(?=\/)/, homedir()));
    return text === null ? [] : fileValues(text).map((v) => v.trim().replace(/^(["'])(.*)\1$/, "$2")).filter((v) => v.length >= 12 && !/\s/.test(v));
  });
}

// Where line n (1-based) is: file:line inside a unified diff, else `label:n` or `line n`.
function locator(text, label) {
  const where = [];
  let file = null, n = 0;
  for (const l of text.split("\n")) {
    let w = null;
    if (l.startsWith("+++ ")) file = l.slice(4).replace(/^b\//, "");
    else if (l.startsWith("@@") && file) n = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (file && n && /^[+ ]/.test(l)) w = `${file}:${n++}`;
    else if (!/^[-\\]/.test(l)) n = 0; // any other line ends the hunk (a commit message, a header)
    where.push(w);
  }
  return (line) => where[line - 1] ?? (label ? `${label}:${line}` : `line ${line}`);
}

/**
 * Every hit in text: { rule, masked, where, fp, allowed }. Never holds the full value.
 * A repo (owner/repo) listed in private-repos.txt skips the private-infrastructure patterns; no repo is strict.
 */
export function findings(text, { timeoutMs = 30000, repo = null, label = null } = {}) {
  const where = locator(text, label);
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineOf = (i) => { // binary search: a big diff has many hits
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= i) lo = m; else hi = m - 1; }
    return lo + 1;
  };
  const out = gitleaksHits(text, timeoutMs).map(({ line, ...h }) => ({ ...h, where: line ? where(line) : null, fp: null }));
  const add = (rule, value, i) => out.push({ rule, masked: mask(value), where: where(lineOf(i)), fp: fingerprint(rule, value) });
  for (const [kind, re] of PATTERNS) for (const m of text.matchAll(re)) add(kind, m[0], m.index);
  let allowed = new Set();
  try {
    if (!(repo && lines("private-repos.txt").includes(repo))) {
      for (const re of privatePatterns()) for (const m of text.matchAll(re)) if (m[0]) add("private-infra", m[0], m.index);
    }
    for (const v of new Set(sopsValues())) for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) add("sops-value", v, i);
    // allow.txt: `<fp> <reason>`, the reason verbatim (it may hold `#`); a line without a reason allows nothing
    allowed = new Set(rawLines("allow.txt").map((l) => /^\s*([0-9a-f]{12})\s+\S/.exec(l)?.[1]).filter(Boolean));
  } catch (e) {
    out.push({ rule: "secret-scan", masked: `config unreadable (${e.code ?? "error"})`, where: null, fp: null });
  }
  return out.map((h) => ({ ...h, allowed: !!h.fp && allowed.has(h.fp) }));
}

/** owner/repo of the GitHub origin of the clone at dir; null elsewhere (then the strict set applies). */
export function originRepo(dir = process.cwd()) {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch { return null; }
}

/** One line per hit: rule: masked (where, fp). */
export const format = (h) => `${h.rule}: ${h.masked}${h.where || h.fp ? ` (${[h.where, h.fp && `fp ${h.fp}`].filter(Boolean).join(", ")})` : ""}`;

/** Scan text about to be posted or pushed. Hits never hold the full value; allowed hits do not count. */
export function scanOutbound(text, opts = {}) {
  const hits = findings(text, opts).filter((h) => !h.allowed).map(format);
  return { ok: hits.length === 0, hits };
}
