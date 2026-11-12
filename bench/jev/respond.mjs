#!/usr/bin/env node
// Replays saved review threads through pr-respond's decide with the live jev.
//   node bench/jev/respond.mjs [fixture.json]   (default respond-pr44.json; run in a clone with the head fetched)
// Prints each decision, the fix count and the groups of duplicate findings that split. decide never declines,
// so a wrong decline is a bug (exit 1); a real finding that gets "ask" costs one agent check, and is counted.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decide, decideText } from "../../shared/pr-review/scripts/lib/respond.mjs";
import { askJev } from "../../shared/pr-review/scripts/lib/decider.mjs";
import { loadConfig } from "../../shared/pr-review/scripts/lib/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(process.argv[2] ?? join(here, "respond-pr44.json"), "utf8"));
const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 64 << 20 });
const show = (sha, path) => { try { return git("show", `${sha}:${path}`); } catch { return null; } };
const fileDiff = (base, head, path) => git("diff", `origin/${base}...${head}`, "--", path);
const config = loadConfig();
const jev = async (q, text) => (await askJev(q, text, config)).answer;
const pr = { headSha: fx.head, baseRef: fx.base, title: fx.title, body: fx.body };

let bad = 0;
const byGroup = new Map();
for (const t of fx.threads) {
  const th = { id: t.id, path: t.path, line: t.line, originalLine: t.line, isResolved: false, comments: t.comments.map((c, i) => ({ id: i + 1, ...c })) };
  const gh = { pr: async () => pr, threads: async () => [th] };
  const r = await decide({ repo: fx.repo, n: fx.pr, threadId: t.id, gh, jev, show, fileDiff });
  const size = decideText(pr, th, { show, fileDiff }).length;
  const wrong = r.decision === "decline" && t.expect !== "decline";
  bad += wrong;
  byGroup.set(t.group, [...(byGroup.get(t.group) ?? []), r.decision]);
  console.log(`${String(t.n).padStart(2)} ${t.group.padEnd(8)} ${r.decision.padEnd(7)} ${wrong ? "WRONG " : ""}${size} B  ${r.reason}`);
}
const split = [...byGroup].filter(([, ds]) => new Set(ds).size > 1);
for (const [g, ds] of split) console.log(`split group ${g}: ${ds.join(", ")}`);
const fixes = fx.threads.length - [...byGroup.values()].flat().filter((d) => d !== "fix").length;
console.log(`fix: ${fixes}/${fx.threads.length}; wrong declines: ${bad}; split groups: ${split.length}`);
process.exitCode = bad ? 1 : 0;
