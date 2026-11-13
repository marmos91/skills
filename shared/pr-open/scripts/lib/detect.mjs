// Find the format, lint and test commands of a project. First hit wins per key.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Usage } from "./counts.mjs";

const KEYS = ["format", "lint", "test"];
const NAMES = { format: ["format", "fmt"], lint: ["lint"], test: ["test"] };

/** .pr-open.json at the repo root: { format?, lint?, test?, allow?: string[] }. */
export function readOverride(dir) {
  const f = join(dir, ".pr-open.json");
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch (e) { throw new Usage(`bad .pr-open.json: ${e.message}`); }
}

const read = (dir, f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);

function fromPackage(dir) {
  const txt = read(dir, "package.json");
  if (txt === null) return null;
  const scripts = JSON.parse(txt).scripts ?? {};
  const pm = ["pnpm-lock.yaml", "pnpm"], yarn = ["yarn.lock", "yarn"], bun = ["bun.lockb", "bun"], bunText = ["bun.lock", "bun"];
  const run = [pm, yarn, bun, bunText].find(([lock]) => existsSync(join(dir, lock)))?.[1] ?? "npm";
  return (key) => { const n = NAMES[key].find((x) => scripts[x]); return n ? `${run} run ${n}` : null; };
}

// Makefile and justfile: a target is a name at the start of a line followed by ":" or recipe args.
function fromTargets(dir, file, tool) {
  const txt = read(dir, file);
  if (txt === null) return null;
  return (key) => { const n = NAMES[key].find((x) => new RegExp(`^${x}(\\s[^:]*)?:`, "m").test(txt)); return n ? `${tool} ${n}` : null; };
}

const fixed = (dir, file, cmds) => (existsSync(join(dir, file)) ? (key) => cmds[key] : null);

export function detect(dir, env = process.env) {
  const over = readOverride(dir);
  const sources = [
    ["env", (key) => env[`PR_OPEN_${key.toUpperCase()}`] || null],
    [".pr-open.json", (key) => over[key] || null],
    ["package.json", fromPackage(dir)],
    ["Makefile", fromTargets(dir, "Makefile", "make")],
    ["justfile", fromTargets(dir, "justfile", "just")],
    ["Cargo.toml", fixed(dir, "Cargo.toml", { format: "cargo fmt", lint: "cargo clippy -- -D warnings", test: "cargo test" })],
    ["go.mod", fixed(dir, "go.mod", { format: "gofmt -w .", lint: "go vet ./...", test: "go test -v ./..." })],
  ].filter(([, get]) => get);
  const out = { source: {} };
  for (const key of KEYS) {
    const hit = sources.map(([name, get]) => [name, get(key)]).find(([, cmd]) => cmd);
    out[key] = hit?.[1] ?? null;
    out.source[key] = hit?.[0] ?? null;
  }
  return out;
}
