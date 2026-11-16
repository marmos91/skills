// secret-scan [--repo owner/repo] [--range a..b] [file...]: text on stdin, the files, or the commits of a range
// -> exit 0 clean, 1 hit (masked hits on stderr), 2 usage or read error (after the hits found so far).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { rangeText, scanOutbound } from "../../pr-review/scripts/lib/secrets.mjs";

const USAGE = "usage: secret-scan [--repo owner/repo]... [--range <a..b>] [file...]   (no file or range: reads stdin)";

let args;
try { args = parseArgs({ options: { repo: { type: "string", multiple: true }, range: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true }); }
catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
if (args.values.help) { console.log(USAGE); process.exit(0); }

// exitCode, not exit(): exit() drops stderr writes still pending on a pipe
process.exitCode = (() => {
  // No --repo: strict. The cwd's origin can be a private fork of a public target.
  const repo = args.values.repo ?? null; // several: opt out only when every one is listed
  const { range } = args.values;
  if (range !== undefined && !range.trim()) { console.error(`secret-scan: --range needs a range (a..b)\n${USAGE}`); return 2; }
  // [name, label for hit lines, read]; a range is a diff, so its hits carry file:line
  const inputs = [
    ...(range !== undefined ? [[`range ${range}`, null, () => rangeText(process.cwd(), range)]] : []),
    ...args.positionals.map((f) => [f, f, () => readFileSync(f, "utf8")]),
  ];
  if (!inputs.length) inputs.push(["stdin", null, () => readFileSync(0, "utf8")]);
  let hits = 0;
  const errors = [];
  for (const [name, label, read] of inputs) {
    let text;
    try { text = read(); } catch (e) { errors.push(`secret-scan: cannot read ${name}: ${String(e.stderr || e.message).trim()}`); continue; }
    for (const h of scanOutbound(text, { repo, label }).hits) { console.error(h); hits++; }
  }
  for (const e of errors) console.error(e);
  return errors.length ? 2 : hits ? 1 : 0;
})();
