#!/usr/bin/env node
// CLI: pr-land <pr>... [--dry-run]. JSON on stdout. Exit codes: 0 done, 1 usage error, 2 blocked (not ready, a scan hit, a conflict), 4 a command failed.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Blocked, STEPS, Usage, landAll } from "./lib/land.mjs";

const USAGE = "usage: pr-land <pr>... [--dry-run]";
const print = (v) => console.log(JSON.stringify(v, null, 2));

export async function main(argv) {
  let landed = [];
  try {
    const { positionals, values } = parseArgs({ args: argv, options: { "dry-run": { type: "boolean" }, help: { type: "boolean" } }, allowPositionals: true });
    if (values.help) { console.log(USAGE); return 0; }
    if (!positionals.length || positionals.some((p) => !/^\d+$/.test(p))) throw new Usage(USAGE);
    let dir;
    try { dir = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { throw new Usage("run pr-land in a clone of the repo"); }
    landed = await landAll(dir, [...new Set(positionals.map(Number))], { dryRun: values["dry-run"] ?? false });
    print({ landed });
    return 0;
  } catch (e) {
    if (e instanceof Usage || e.code?.startsWith?.("ERR_PARSE_ARGS")) { console.error(`pr-land: ${e.message}`); return 1; }
    // A failed step stops here: say what is done and what is not. A merge is never undone.
    const done = e.done ?? [];
    print({
      landed: e.landed ?? landed, stopped: e.pr, [e instanceof Blocked ? "blocked" : "error"]: e.message,
      ...(e.detail && typeof e.detail === "object" ? e.detail : {}),
      done, notDone: STEPS.filter((s) => !done.includes(s)), notes: e.notes ?? [],
    });
    return e instanceof Blocked ? 2 : 4;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
