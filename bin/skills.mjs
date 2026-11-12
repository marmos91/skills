#!/usr/bin/env node
// skills install|uninstall|list [--claude] [--pi] [--link] [skill...]
// Copies (or links, with --link) each skill into the agent's skills folder and links its CLIs into BIN_DIR.
// Idempotent. A local copy that this package did not write is moved aside once to <name>.pre-skills-repo.
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const MARKER = ".skills-package"; // written into each copy: tells our copies from the user's
const NEEDS = { "pr-review-loop": ["pr-review"] }; // pr-review-loop runs the pr-review engine from its sibling folder
const USAGE = "usage: skills install|uninstall|list [--claude] [--pi] [--link] [skill...]";

const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const exists = (p) => existsSync(p) || isLink(p);
const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

// pi/ skills go to pi, claude/ skills to Claude Code, shared/ skills to both.
function catalog() {
  const out = new Map();
  for (const [group, agents] of [["shared", ["claude", "pi"]], ["pi", ["pi"]], ["claude", ["claude"]]]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (existsSync(join(dir, name, "SKILL.md"))) out.set(name, { src: join(dir, name), agents });
  }
  return out;
}

/** metadata.version from a SKILL.md frontmatter, or null. */
export function skillVersion(skillDir) {
  try {
    const fm = readFileSync(join(skillDir, "SKILL.md"), "utf8").match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    return fm.match(/^\s+version:\s*"?([^"\s#]+)/m)?.[1] ?? null;
  } catch { return null; }
}

// Copies from the Nix store are read-only: make them writable so the next install can replace them.
function writable(p) {
  const s = lstatSync(p);
  if (s.isSymbolicLink()) return;
  chmodSync(p, s.mode | 0o200);
  if (s.isDirectory()) for (const e of readdirSync(p)) writable(join(p, e));
}

function place(src, dest, link, log) {
  const name = dest.split(sep).pop();
  if (isLink(dest)) {
    if (link && resolve(dirname(dest), readlinkSync(dest)) === src) return log(`  ${name}: already linked`);
    rmSync(dest);
  } else if (existsSync(dest)) {
    if (existsSync(join(dest, MARKER))) rmSync(dest, { recursive: true, force: true });
    else {
      const backup = `${dest}.pre-skills-repo`;
      if (exists(backup)) throw new Error(`${dest} is a local copy and ${backup} already exists; move one of them away`);
      renameSync(dest, backup);
      log(`  ${name}: WARNING moved the local copy to ${backup}`);
    }
  }
  if (link) symlinkSync(src, dest);
  else {
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true, filter: (s) => !s.includes(`${sep}__pycache__`) });
    writable(dest);
    writeFileSync(join(dest, MARKER), `${PKG.name}@${PKG.version}\n`);
  }
  log(`  ${name}: ${link ? "linked" : "copied"} (${skillVersion(src) ?? "no version"})`);
}

function ours(dest) {
  if (isLink(dest)) return inside(resolve(dirname(dest), readlinkSync(dest)), ROOT);
  return existsSync(join(dest, MARKER));
}

// bin name -> [skill, path inside the skill], from package.json "bin".
function bins(names) {
  return Object.entries(PKG.bin).flatMap(([bin, path]) => {
    const [group, skill, ...rest] = path.split("/");
    return group !== "bin" && names.includes(skill) ? [[bin, skill, rest.join("/")]] : [];
  });
}

export function run(argv, { env = process.env, log = console.log } = {}) {
  const { values: v, positionals: [cmd, ...wanted] } = parseArgs({
    args: argv, allowPositionals: true,
    options: { claude: { type: "boolean" }, pi: { type: "boolean" }, link: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  if (v.help) { log(USAGE); return 0; }
  if (!["install", "uninstall", "list"].includes(cmd)) { console.error(USAGE); return 1; }
  const home = env.HOME || homedir();
  const dirs = { claude: env.CLAUDE_DIR || join(home, ".claude", "skills"), pi: env.PI_DIR || join(home, ".pi", "agent", "skills") };
  const binDir = env.BIN_DIR || join(home, ".local", "bin");
  const agents = v.claude || v.pi ? ["claude", "pi"].filter((a) => v[a]) : ["claude", "pi"];
  const all = catalog();
  const unknown = wanted.filter((n) => !all.has(n));
  if (unknown.length) { console.error(`skills: unknown skill ${unknown.join(", ")}; known: ${[...all.keys()].join(", ")}`); return 1; }
  let names = wanted.length ? wanted : [...all.keys()];
  if (cmd === "install") names = [...new Set(names.flatMap((n) => [n, ...(NEEDS[n] ?? [])]))];

  if (cmd === "list") {
    log(`${PKG.name}@${PKG.version} (${ROOT})`);
    for (const n of names) log(`  ${n.padEnd(20)} ${agents.map((a) => `${a}: ${all.get(n).agents.includes(a) && exists(join(dirs[a], n)) ? skillVersion(join(dirs[a], n)) ?? "?" : "-"}`).join("  ")}`);
    return 0;
  }

  const placed = new Map(); // skill -> the installed folder its CLIs run from
  for (const a of agents) {
    log(`${cmd === "install" ? "Installing into" : "Removing from"} ${a}: ${dirs[a]}`);
    for (const n of names) {
      const { src, agents: targets } = all.get(n);
      if (!targets.includes(a)) continue;
      const dest = join(dirs[a], n);
      if (cmd === "install") {
        mkdirSync(dirs[a], { recursive: true });
        place(src, dest, v.link, log);
        if (!placed.has(n)) placed.set(n, dest);
      } else if (exists(dest) && ours(dest)) {
        rmSync(dest, { recursive: true, force: true });
        log(`  ${n}: removed`);
        placed.set(n, dest);
      }
    }
  }

  log(`CLIs: ${binDir}`);
  for (const [bin, skill, rel] of bins([...placed.keys()])) {
    const dest = join(binDir, bin);
    if (cmd === "uninstall") {
      if (isLink(dest) && agents.some((a) => inside(resolve(binDir, readlinkSync(dest)), dirs[a]) || inside(resolve(binDir, readlinkSync(dest)), ROOT))) { rmSync(dest); log(`  ${bin}: removed`); }
      continue;
    }
    if (exists(dest) && !isLink(dest)) { log(`  ${bin}: WARNING ${dest} is not a link; left as it is`); continue; }
    const target = join(placed.get(skill), rel);
    chmodSync(target, statSync(target).mode | 0o111);
    mkdirSync(binDir, { recursive: true });
    rmSync(dest, { force: true });
    symlinkSync(target, dest);
    log(`  ${bin} -> ${target}`);
  }
  return 0;
}

// realpath: npm and BIN_DIR start this file through a symlink
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { console.error(`skills: ${e.message}`); process.exitCode = 1; }
}
