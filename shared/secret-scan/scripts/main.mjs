// secret-scan [--repo owner/repo] [file...]: text on stdin (or the files) -> exit 0 clean, 1 hit (masked hits on stderr), 2 usage.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { findings, format, originRepo } from "../../pr-review/scripts/lib/secrets.mjs";

const USAGE = "usage: secret-scan [--repo owner/repo] [file...]   (no file: reads stdin)";

let args;
try { args = parseArgs({ options: { repo: { type: "string" }, help: { type: "boolean", short: "h" } }, allowPositionals: true }); }
catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
if (args.values.help) { console.log(USAGE); process.exit(0); }

const repo = args.values.repo ?? originRepo();
const inputs = args.positionals.length ? args.positionals.map((f) => [f, f]) : [[null, "-"]];
const hits = [];
for (const [label, path] of inputs) {
  let text;
  try { text = readFileSync(path === "-" ? 0 : path, "utf8"); } catch (e) { console.error(`secret-scan: cannot read ${path}: ${e.message}`); process.exit(2); }
  hits.push(...findings(text, { repo, label }).filter((h) => !h.allowed));
}
for (const h of hits) console.error(format(h));
process.exit(hits.length ? 1 : 0);
