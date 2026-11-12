#!/usr/bin/env node
// CLI: pr-open detect|test|check|open. JSON on stdout. Exit codes: 0 done, 1 usage or setup error, 2 blocked by a check, 4 a command failed.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkBranch } from "./lib/check.mjs";
import { Blocked, Usage, runTests } from "./lib/counts.mjs";
import { detect, readOverride } from "./lib/detect.mjs";
import { openPr, resolveBase } from "./lib/open.mjs";

const USAGE = `usage: pr-open detect
       pr-open test [--command "<cmd>"]
       pr-open check [--base <branch>] [--title T] [--body-file F]
       pr-open open --title T --body-file F [--base <branch>] [--draft]`;

const OPTIONS = {
  command: { type: "string" }, base: { type: "string" }, title: { type: "string" },
  "body-file": { type: "string" }, draft: { type: "boolean" },
};

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const print = (v) => console.log(JSON.stringify(v, null, 2));

async function run(cmd, v) {
  let dir;
  try { dir = git("rev-parse", "--show-toplevel"); } catch { throw new Usage("run pr-open in a git repo"); }
  if (cmd === "detect") { print(detect(dir)); return 0; }
  if (cmd === "test") {
    const command = v.command ?? detect(dir).test;
    if (!command) throw new Usage("no test command found: pass --command, set PR_OPEN_TEST, or add test to .pr-open.json");
    const r = await runTests(dir, command);
    print(r);
    return r.exit === 0 && !(r.counts?.failed > 0) ? 0 : 2;
  }
  if (cmd === "check") {
    let body = "";
    try { if (v["body-file"]) body = readFileSync(v["body-file"], "utf8"); } catch (e) { throw new Usage(`cannot read the body file: ${e.message}`); }
    const r = checkBranch(dir, resolveBase(dir, v.base).ref, { title: v.title ?? "", body, allow: readOverride(dir).allow ?? [] });
    print(r);
    return r.ok ? 0 : 2;
  }
  if (cmd === "open") {
    if (!v["body-file"]) throw new Usage("--body-file is required");
    print(await openPr(dir, { title: v.title, bodyFile: v["body-file"], base: v.base, draft: v.draft ?? false }));
    return 0;
  }
  throw new Usage(USAGE);
}

export async function main(argv) {
  try {
    const { positionals, values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
    return await run(positionals[0], values);
  } catch (e) {
    if (e instanceof Blocked) { print({ blocked: e.message, ...(e.detail && typeof e.detail === "object" ? e.detail : {}) }); return 2; }
    if (e instanceof Usage || e.code?.startsWith?.("ERR_PARSE_ARGS")) { console.error(`pr-open: ${e.message}`); return 1; }
    console.error(`pr-open: ${e.message}`);
    return 4;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
