// Static analysis candidates (#70). semgrep reads the changed files and never runs them, so it is safe at any
// depth and for any author. Its hits on added lines become security clusters that no seat found: the seats vote
// on them like any other finding, and a hit no seat keeps is not posted.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TIMEOUT_MS = 120_000; // shortcut: a fixed cap, make it a config key when a repo needs longer
const REPO_RULES = [".semgrep.yml", ".semgrep.yaml", ".semgrep"];

/**
 * Runs semgrep once per run (cached in file). changed: file -> Set of added lines.
 * -> { tool, ran, note, hits: [{ rule, file, line, message }] }; note says why it did not run or what went wrong.
 */
export function runSast(f, config, lenses, changed, file, log = () => {}) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const r = scan(f, config, lenses, changed);
  if (r.note) log(`static analysis: ${r.note}`);
  writeFileSync(file, JSON.stringify(r));
  return r;
}

function scan(f, config, lenses, changed) {
  const out = (ran, note, hits = []) => ({ tool: "semgrep", ran, note, hits });
  if (config.review.sast === false) return out(false, "off in the config");
  if (!lenses.includes("security")) return out(false, "the security lens does not run");
  const files = [...changed.keys()].filter((p) => changed.get(p).size && existsSync(join(f.worktree, p)));
  if (!files.length) return out(false, "no added lines");
  // An untrusted author could write the repo's rules (and so the text the seats read): use the registry's then.
  const own = f.shellOk && REPO_RULES.find((p) => existsSync(join(f.worktree, p)));
  const res = spawnSync(process.env.PR_REVIEW_SEMGREP || "semgrep",
    ["scan", "--json", "--quiet", "--metrics", "off", "--disable-version-check", "--config", own || "p/default", "--", ...files],
    { cwd: f.worktree, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (res.error?.code === "ENOENT") return out(false, "semgrep is not installed, skipped");
  if (res.error?.code === "ETIMEDOUT") return out(false, `semgrep timed out after ${TIMEOUT_MS / 1000}s`);
  let results;
  try { results = JSON.parse(res.stdout).results; } catch { /* below */ }
  if (res.error || !Array.isArray(results)) return out(false, `semgrep failed (exit ${res.status})`);
  const hits = results.filter((x) => changed.get(x.path)?.has(x.start?.line))
    .map((x) => ({ rule: String(x.check_id), file: x.path, line: x.start.line, message: String(x.extra?.message ?? "").trim().slice(0, 500) }));
  return out(true, null, hits);
}

/** The tail of the "What was checked" line: the tools that ran, "" when none did. */
export const sastLine = (r) => (r?.ran ? ` Static analysis: ${r.tool} (${r.hits.length} hit${r.hits.length === 1 ? "" : "s"} on added lines).` : "");

/** Hits as merge clusters with no finder; a hit on a line where the seats already raised a security finding is left out. */
export const sastClusters = (r, merged) => [...new Map((r?.hits ?? [])
  .filter((h) => !merged.some((c) => c.lens === "security" && c.file === h.file && c.line === h.line))
  .map((h) => ({
    id: `sast-${createHash("sha1").update(`${h.rule}\0${h.file}\0${h.line}`).digest("hex").slice(0, 10)}`,
    lens: "security", severity: "should", file: h.file, line: h.line, symbol: `line ${h.line}`,
    title: `semgrep rule ${h.rule}`,
    case: h.message || `The rule ${h.rule} matches this line.`,
    evidence: `Engine data: semgrep rule ${h.rule} hit ${h.file}:${h.line}. A tool hit, not a finding: keep it only when the code is really at risk.`,
    found: [],
  })).map((c) => [c.id, c])).values()]; // one rule twice on a line (2 columns) is one cluster
