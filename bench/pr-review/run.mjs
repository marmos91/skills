#!/usr/bin/env node
// Runs the pr-review engine on each case, up to the vote tally (no decide, no compose, nothing posted), and scores it.
//   node bench/pr-review/run.mjs --effort medium [--config seats.json] [--label name] [--depth light|full]
//        [--only id,id] [--until tally|frame] [--slack 3] [--cases file] [--clones dir] [--state dir]
// --until frame stops before any model call: it prints the planned children per case, the cost of a full run.
// Writes results/<label>.json and results/<label>.md, and prints the table.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadCases, markdown, scoreCase } from "./score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: v } = parseArgs({ options: {
  effort: { type: "string", default: "medium" }, config: { type: "string" }, label: { type: "string" }, depth: { type: "string", default: "light" },
  only: { type: "string" }, until: { type: "string", default: "tally" }, slack: { type: "string", default: "3" },
  cases: { type: "string", default: join(here, "cases.json") }, clones: { type: "string", default: join(homedir(), ".cache", "pr-review-bench") }, state: { type: "string" },
} });
if (!["low", "medium", "high", "max"].includes(v.effort)) throw new Error("--effort must be low|medium|high|max (auto would pick per case)");
if (!["tally", "frame"].includes(v.until)) throw new Error("--until must be tally or frame");
if (!["light", "full"].includes(v.depth)) throw new Error("--depth must be light or full");

// The engine keeps its state here, never in the user's own pr-review state: no question, lock or settled finding leaks either way.
process.env.XDG_STATE_HOME = v.state ?? mkdtempSync(join(tmpdir(), "pr-review-bench-"));
const engine = join(here, "..", "..", "shared", "pr-review", "scripts", "lib");
const { review } = await import(join(engine, "review.mjs"));
const github = await import(join(engine, "github.mjs"));
const { usageByStage } = await import(join(engine, "state.mjs"));
(await import(join(engine, "child.mjs"))).installSignalHandlers();

const gh = (...a) => execFileSync(process.env.GH_BIN || "gh", a, { encoding: "utf8" }).trim();
const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// Old review threads would show the seats earlier findings on the very bug, and link clusters to them: none.
const benchGh = { ...github, threads: async () => [] };

const only = v.only?.split(",");
const cases = loadCases(v.cases).filter((c) => !only || only.includes(c.id));
const label = v.label ?? `${v.effort}${v.config ? `-${basename(v.config).replace(/\.json$/, "")}` : ""}${v.depth === "full" ? "-full" : ""}`;
const rows = [];
for (const c of cases) {
  const t0 = Date.now();
  try {
    // A case from a private repo must never run: its code would reach the seats and the results file.
    if (gh("repo", "view", c.repo, "--json", "visibility", "-q", ".visibility") !== "PUBLIC") throw new Error(`${c.repo} is not public`);
    const head = (await github.pr(c.repo, c.pr)).headSha;
    if (head !== c.head) throw new Error(`PR head is ${head}, the case says ${c.head}`);
    const dir = join(v.clones, c.repo.replace("/", "__"));
    if (!existsSync(dir)) { mkdirSync(v.clones, { recursive: true }); execFileSync("git", ["clone", "-q", "--filter=blob:none", `https://github.com/${c.repo}.git`, dir]); }
    console.error(`${c.id}: reviewing ${c.repo}#${c.pr} at effort ${v.effort}`);
    const r = await review({ repo: c.repo, n: c.pr, repoDir: dir, gh: benchGh, effort: v.effort, depth: v.depth, configPath: v.config,
      dryRun: true, until: v.until, restart: true, log: (l) => console.error(`  ${l}`) });
    if (r.exit !== 0 || !r.runDir) throw new Error(`engine exit ${r.exit}: ${r.summary}`);
    const frame = JSON.parse(readFileSync(join(r.runDir, "frame.json"), "utf8"));
    const base = git(dir, "merge-base", `origin/${frame.baseRef}`, c.head);
    if (base !== c.base) throw new Error(`the diff base is ${base}, the case says ${c.base}`);
    if (v.until === "frame") { rows.push({ id: c.id, planned: r.planned }); console.error(`  ${r.planned} children planned`); continue; }
    const { clusters } = JSON.parse(readFileSync(join(r.runDir, "clusters.json"), "utf8"));
    const status = new Map(JSON.parse(readFileSync(join(r.runDir, "tally.json"), "utf8")).map((t) => [`${t.id}\0${t.fp}`, t.status]));
    const findings = clusters.map((x) => ({ file: x.file, line: x.line, severity: x.severity, lens: x.lens, title: x.title, status: status.get(`${x.id}\0${x.fp}`) }));
    rows.push({ ...scoreCase(c, findings, { slack: Number(v.slack) }), planned: r.planned, tokens: usageByStage(r.runDir).total ?? null, wallMs: Date.now() - t0, findings, runDir: r.runDir });
  } catch (e) {
    rows.push({ id: c.id, error: e.message, wallMs: Date.now() - t0 });
    console.error(`  ${c.id}: ${e.message}`);
  }
}

if (v.until === "frame") {
  for (const r of rows) console.log(`${r.id}: ${r.error ?? `${r.planned} children planned at effort ${v.effort}`}`);
} else {
  const out = join(here, "results");
  mkdirSync(out, { recursive: true });
  const md = markdown(`${label} (effort ${v.effort}, depth ${v.depth}${v.config ? `, config ${basename(v.config)}` : ""})`, rows);
  writeFileSync(join(out, `${label}.json`), JSON.stringify({ label, effort: v.effort, depth: v.depth, config: v.config ? basename(v.config) : null, slack: Number(v.slack), at: new Date().toISOString(), rows }, null, 2) + "\n");
  writeFileSync(join(out, `${label}.md`), md);
  console.log(md);
}
console.error(`engine state: ${process.env.XDG_STATE_HOME}`);
process.exitCode = rows.some((r) => r.error) ? 1 : 0;
