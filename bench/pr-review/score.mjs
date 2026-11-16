// Case loader and scorer of the pr-review benchmark. Pure: no git, no gh, no model calls (run.mjs does those).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const SHA = /^[0-9a-f]{40}$/;
// ids and labels become file and folder names: no dots, no slashes, so never "." or ".."
export const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** Reads and checks a cases file (a JSON array). Throws on the first bad field, naming the case. */
export function loadCases(file) {
  return checkCases(JSON.parse(readFileSync(file, "utf8")));
}

export function checkCases(cases) {
  if (!Array.isArray(cases) || !cases.length) throw new Error("cases: want a non-empty JSON array");
  const ids = new Set();
  for (const [i, c] of cases.entries()) {
    const bad = (m) => { throw new Error(`case ${c?.id ?? i}: ${m}`); };
    if (typeof c?.id !== "string" || !NAME.test(c.id)) bad("id: want lowercase letters, digits and -, starting with a letter or digit");
    if (ids.has(c.id)) bad("id: duplicate");
    ids.add(c.id);
    // github.com only: run.mjs checks that the repo is public before it runs
    if (typeof c.repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(c.repo) || c.repo.split("/").some((p) => /^\.+$/.test(p))) bad("repo: want owner/repo");
    if (!Number.isSafeInteger(c.pr) || c.pr <= 0) bad("pr: want a positive integer");
    for (const k of ["base", "head", "fix"]) if (!SHA.test(c[k] ?? "")) bad(`${k}: want a full 40-character sha`);
    if (!Array.isArray(c.bugs) || !c.bugs.length) bad("bugs: want a non-empty array");
    for (const b of c.bugs) {
      if (typeof b?.file !== "string" || !b.file || b.file.startsWith("/") || b.file.split("/").includes("..")) bad("bug file: want a path inside the repo");
      const [s, e] = Array.isArray(b.lines) && b.lines.length === 2 ? b.lines : [];
      if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s < 1 || e < s) bad(`bug ${b.file}: lines want [start, end], 1 <= start <= end`);
      if (typeof b.what !== "string" || !b.what.trim()) bad(`bug ${b.file}: what is empty`);
    }
  }
  return cases;
}

/** Checks the runner's flags. -> { slack, cases (the ones --only picks), label }. Throws a usage error. */
export function checkArgs(v, cases) {
  if (!["low", "medium", "high", "max"].includes(v.effort)) throw new Error("--effort must be low|medium|high|max (auto would pick per case)");
  if (!["tally", "frame"].includes(v.until)) throw new Error("--until must be tally or frame");
  if (!["light", "full"].includes(v.depth)) throw new Error("--depth must be light or full");
  // Number("3l") is NaN, and a NaN slack matches no finding: every hit would score as a false positive
  if (!/^\d+$/.test(String(v.slack))) throw new Error("--slack must be a non-negative integer");
  if (v.label !== undefined && !NAME.test(v.label)) throw new Error("--label: want lowercase letters, digits and -");
  let picked = cases;
  if (v.only !== undefined) {
    const only = v.only.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = only.filter((id) => !cases.some((c) => c.id === id));
    if (!only.length || unknown.length) throw new Error(`--only: no case ${unknown.join(", ") || "named"}; cases: ${cases.map((c) => c.id).join(", ")}`);
    picked = cases.filter((c) => only.includes(c.id));
  }
  // the default label names what ran, so a run of one case or another config never overwrites a full run
  const config = v.config && `${basename(v.config).replace(/\.json$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${createHash("sha1").update(resolve(v.config)).digest("hex").slice(0, 6)}`;
  const label = v.label ?? [v.effort, config || "user-config", v.depth === "full" && "full", v.only !== undefined && picked.map((c) => c.id).join("-")].filter(Boolean).join("-");
  return { slack: Number(v.slack), cases: picked, label };
}

/** The seat mix of an effective config, one line: what ran, for the results. */
export function mixLine(config) {
  const id = (s) => `${s.harness}:${s.model}${s.thinking ? `/${s.thinking}` : ""}`;
  const lenses = Object.entries(config.lenses ?? {}).filter(([, l]) => l.seats).map(([n, l]) => `${n} (${l.seats.map(id).join(", ")})`);
  return [`seats ${config.seats.map(id).join(", ")}`, `judge ${id(config.judge)}`, lenses.length && `lens seats ${lenses.join("; ")}`].filter(Boolean).join("; ");
}

// slack: a finding a few lines off the range names the same code (seats cite the call, the bug sits above it)
const hits = (f, b, slack) => f.file === b.file && f.line >= b.lines[0] - slack && f.line <= b.lines[1] + slack;
const serious = (f) => f.severity === "must" || f.severity === "should";

/**
 * findings: the merged clusters of one run, each { file, line, severity, status } with status
 * agreed|split|rejected from the vote. Recall counts a bug once any finding (any severity) overlaps it;
 * false positives are the must/should findings that overlap no bug. "agreed" is what would post, "prevote"
 * every cluster before the vote, so the two show how much the vote filters.
 */
export function scoreCase(c, findings, { slack = 3 } = {}) {
  const agreed = findings.filter((f) => f.status === "agreed");
  const side = (fs) => ({
    found: c.bugs.filter((b) => fs.some((f) => hits(f, b, slack))).length,
    fp: fs.filter((f) => serious(f) && !c.bugs.some((b) => hits(f, b, slack))).length,
  });
  const count = (s) => findings.filter((f) => f.status === s).length;
  return {
    id: c.id, bugs: c.bugs.length,
    agreed: side(agreed), prevote: side(findings),
    clusters: { total: findings.length, agreed: agreed.length, split: count("split"), rejected: count("rejected") },
    missed: c.bugs.filter((b) => !agreed.some((f) => hits(f, b, slack))).map((b) => `${b.file}:${b.lines.join("-")}`),
  };
}

const sum = (rows, get) => rows.reduce((a, r) => a + (get(r) ?? 0), 0);
const tokensIn = (t) => (t?.input ?? 0) + (t?.cache_read ?? 0) + (t?.cache_creation ?? 0);

/** Totals over the scored rows; a row with an error counts in `failed` and nowhere else. */
export function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const bugs = sum(ok, (r) => r.bugs);
  const ratio = (n) => (bugs ? n / bugs : null);
  return {
    cases: rows.length, failed: rows.length - ok.length, bugs,
    recall: ratio(sum(ok, (r) => r.agreed.found)), recallPrevote: ratio(sum(ok, (r) => r.prevote.found)),
    fp: sum(ok, (r) => r.agreed.fp), fpPrevote: sum(ok, (r) => r.prevote.fp),
    tokensIn: sum(ok, (r) => tokensIn(r.tokens)), tokensOut: sum(ok, (r) => r.tokens?.output),
    wallS: Math.round(sum(ok, (r) => r.wallMs) / 1000),
  };
}

const pct = (x) => (x == null ? "-" : `${Math.round(x * 100)}%`);

/** The short Markdown table of one run. */
export function markdown(label, rows) {
  const t = summarize(rows);
  const line = (r) => r.error
    ? `| ${r.id} | error: ${String(r.error).replace(/[|\n]/g, " ").slice(0, 120)} | | | | | |`
    : `| ${r.id} | ${r.agreed.found}/${r.bugs} | ${r.prevote.found}/${r.bugs} | ${r.agreed.fp} (${r.prevote.fp}) | ${r.clusters.agreed}/${r.clusters.split}/${r.clusters.rejected} | ${tokensIn(r.tokens)}/${r.tokens?.output ?? 0} | ${Math.round(r.wallMs / 1000)} |`;
  return [
    `## ${label}`, "",
    "| case | found by an agreed finding | found before the vote | FP must/should agreed (before) | clusters agreed/split/rejected | tokens in/out | wall s |",
    "|---|---|---|---|---|---|---|",
    ...rows.map(line),
    `| **total** | ${pct(t.recall)} | ${pct(t.recallPrevote)} | ${t.fp} (${t.fpPrevote}) | | ${t.tokensIn}/${t.tokensOut} | ${t.wallS} |`,
    "", t.failed ? `${t.failed} of ${t.cases} cases failed and are left out of the totals.` : "",
  ].join("\n").trimEnd() + "\n";
}
