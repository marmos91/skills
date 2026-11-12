// Test stand-in for `gh`. Routes live in $GH_STUB_DIR/routes.json:
//   { "<key>": { "stdout": <json|string>, "stderr": "...", "exit": 0 } }
// key = argv joined with spaces; for `api graphql` it is "graphql <OperationName>".
// Every mutation (GraphQL `mutation`, REST POST/PATCH/PUT/DELETE) is appended to mutations.jsonl.
import { readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const dir = process.env.GH_STUB_DIR;
if (!dir) { console.error("gh-stub: GH_STUB_DIR not set"); process.exit(1); }

let key = argv.join(" ");
let mutation = false, input = null, vars = null;
const ii = argv.indexOf("--input");
if (ii >= 0) input = readFileSync(0, "utf8");
if (argv[0] === "api" && argv[1] === "graphql") {
  const body = JSON.parse(input ?? "{}");
  key = `graphql ${/(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ?? "?"}`;
  vars = body.variables ?? {};
  mutation = /^\s*mutation\b/.test(body.query ?? "");
} else {
  const m = argv.indexOf("-X") >= 0 ? argv[argv.indexOf("-X") + 1] : argv.indexOf("--method") >= 0 ? argv[argv.indexOf("--method") + 1] : "GET";
  mutation = /^(POST|PATCH|PUT|DELETE)$/i.test(m);
}
if (mutation) appendFileSync(join(dir, "mutations.jsonl"), JSON.stringify({ key, argv, input: input && JSON.parse(input) }) + "\n");

// Reads are logged too, with GraphQL variables, so tests can assert cursors.
appendFileSync(join(dir, "calls.jsonl"), JSON.stringify({ key, argv, variables: vars }) + "\n");
const routes = JSON.parse(readFileSync(join(dir, "routes.json"), "utf8"));
// Paging: a route "graphql Op cursor=c1" answers the call whose cursor variable (cursor|cc|rc) is c1.
const page = vars ? ["cursor", "cc", "rc"].filter((k) => typeof vars[k] === "string").map((k) => `${k}=${vars[k]}`).join(" ") : "";
const r = (page && routes[`${key} ${page}`]) || routes[key];
if (!r) { console.error(`gh-stub: no route for key: ${key}`); process.exit(1); }
if (r.stderr) process.stderr.write(r.stderr);
if (r.stdout !== undefined) process.stdout.write(typeof r.stdout === "string" ? r.stdout : JSON.stringify(r.stdout));
process.exit(r.exit ?? 0);
