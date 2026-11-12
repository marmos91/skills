import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "skills-test-"));
  t.after(() => { chmodTree(root, 0o200); rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: root, CLAUDE_DIR: join(root, "claude"), PI_DIR: join(root, "pi"), BIN_DIR: join(root, "bin") };
  const run = (pkg, ...args) => spawnSync(process.execPath, [join(pkg, "bin", "skills.mjs"), ...args], { env, encoding: "utf8" });
  return { root, env, run };
}

function chmodTree(p, bits) {
  const s = lstatSync(p);
  if (s.isSymbolicLink()) return;
  chmodSync(p, s.mode | bits);
  if (s.isDirectory()) for (const e of readdirSync(p)) chmodTree(join(p, e), bits);
}

// A copy of the package, read-only like the Nix store.
function storeCopy(root, { clone = false } = {}) {
  const pkg = join(root, "store");
  for (const p of ["package.json", "bin", "shared", "pi"]) cpSync(join(REPO, p), join(pkg, p), { recursive: true, verbatimSymlinks: true });
  if (clone) mkdirSync(join(pkg, ".git"));
  const strip = (p) => { const s = lstatSync(p); if (s.isSymbolicLink()) return; if (s.isDirectory()) readdirSync(p).forEach((e) => strip(join(p, e))); chmodSync(p, s.mode & ~0o222); };
  strip(pkg);
  return pkg;
}

test("install copies each skill to its agents, links the CLIs, and a re-install replaces read-only copies", (t) => {
  const { root, env, run } = setup(t);
  const pkg = storeCopy(root);
  for (let i = 0; i < 2; i++) {
    const r = run(pkg, "install");
    assert.equal(r.status, 0, r.stderr);
  }
  for (const s of ["pr-review", "pr-review-loop", "jev", "repo-audit", "repo-audit-fix"]) {
    assert.ok(existsSync(join(env.CLAUDE_DIR, s, "SKILL.md")), `claude ${s}`);
    assert.ok(existsSync(join(env.PI_DIR, s, "SKILL.md")), `pi ${s}`);
    assert.equal(readFileSync(join(env.CLAUDE_DIR, s, ".skills-package"), "utf8").trim(), `@marmos91/skills@${VERSION}`);
  }
  assert.ok(existsSync(join(env.PI_DIR, "refute-root-cause")), "pi-only skill goes to pi");
  assert.ok(!existsSync(join(env.CLAUDE_DIR, "refute-root-cause")), "pi-only skill stays out of claude");
  assert.ok(statSync(join(env.CLAUDE_DIR, "pr-review", "SKILL.md")).mode & 0o200, "copies are writable");
  assert.equal(readlinkSync(join(env.BIN_DIR, "pr-review")), join(env.CLAUDE_DIR, "pr-review", "scripts", "pr-review"));
  // the CLIs run from the installed copy, through the BIN_DIR link
  for (const bin of ["pr-review", "pr-review-loop"]) {
    const r = spawnSync(join(env.BIN_DIR, bin), ["--help"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${bin}: ${r.stderr}`);
    assert.match(r.stdout, /usage: pr-review/);
  }
  // audit.sh finds its lib/ through the link, and a report with no audit yet exits 0
  const a = spawnSync(join(env.BIN_DIR, "repo-audit"), ["status"], { env: { ...env, REPO: root, WORKTREE: join(root, "wt") }, encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /repo-audit state/);
  const list = run(pkg, "list");
  assert.match(list.stdout, new RegExp(`pr-review\\s+claude: ${VERSION.replaceAll(".", "\\.")}\\s+pi: ${VERSION.replaceAll(".", "\\.")}`));
  assert.match(list.stdout, /refute-root-cause\s+claude: -\s+pi: /);
});

test("install of one skill brings what it needs; --claude leaves pi alone", (t) => {
  const { env, run } = setup(t);
  const r = run(REPO, "install", "--claude", "pr-review-loop");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(env.CLAUDE_DIR).sort(), ["pr-review", "pr-review-loop"]);
  assert.ok(!existsSync(env.PI_DIR));
  assert.deepEqual(readdirSync(env.BIN_DIR).sort(), ["pr-review", "pr-review-loop"]);
  assert.equal(run(REPO, "install", "nope").status, 1);
});

test("a local copy is moved aside once; a link is replaced; --link links to the package", (t) => {
  const { env, run } = setup(t);
  mkdirSync(join(env.CLAUDE_DIR, "jev"), { recursive: true });
  writeFileSync(join(env.CLAUDE_DIR, "jev", "mine"), "x");
  assert.equal(run(REPO, "install", "--claude", "--link", "jev").status, 0);
  assert.ok(existsSync(join(env.CLAUDE_DIR, "jev.pre-skills-repo", "mine")), "backup kept");
  assert.equal(readlinkSync(join(env.CLAUDE_DIR, "jev")), join(REPO, "shared", "jev"));
  assert.match(run(REPO, "install", "--claude", "--link", "jev").stdout, /already linked/);
  // a second local copy with a backup in place: refuse, change nothing
  rmSync(join(env.CLAUDE_DIR, "jev"));
  mkdirSync(join(env.CLAUDE_DIR, "jev"));
  const r = run(REPO, "install", "--claude", "jev");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists/);
});

test("uninstall removes only what the package installed", (t) => {
  const { env, run } = setup(t);
  assert.equal(run(REPO, "install").status, 0);
  mkdirSync(join(env.CLAUDE_DIR, "other"));
  assert.equal(run(REPO, "uninstall").status, 0);
  assert.deepEqual(readdirSync(env.CLAUDE_DIR), ["other"]);
  assert.deepEqual(readdirSync(env.PI_DIR), []);
  assert.deepEqual(readdirSync(env.BIN_DIR), []);
});

test("--link from a read-only package links the skills and the CLIs", (t) => {
  const { root, env, run } = setup(t);
  const pkg = storeCopy(root, { clone: true });
  // a chmod needs ownership: the Nix store is root's, so the package file must not be touched at all
  const target = join(pkg, "shared", "jev", "jev.py"), before = statSync(target).ctimeMs;
  const r = run(pkg, "install", "--claude", "--link", "jev");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readlinkSync(join(env.BIN_DIR, "jev")), join(env.CLAUDE_DIR, "jev", "jev.py"));
  assert.equal(statSync(target).ctimeMs, before, "no chmod on the package");
});

test("uninstall from one agent moves the CLIs to the copy that stays", (t) => {
  const { env, run } = setup(t);
  assert.equal(run(REPO, "install").status, 0);
  assert.equal(run(REPO, "uninstall", "--claude").status, 0);
  assert.equal(readlinkSync(join(env.BIN_DIR, "pr-review")), join(env.PI_DIR, "pr-review", "scripts", "pr-review"));
  const r = spawnSync(join(env.BIN_DIR, "pr-review"), ["--help"], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(run(REPO, "uninstall", "--pi").status, 0);
  assert.deepEqual(readdirSync(env.BIN_DIR), []);
});

test("install fails when no selected skill runs on the selected agent", (t) => {
  const { run } = setup(t);
  const r = run(REPO, "install", "--claude", "refute-root-cause");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no selected skill runs on claude/);
});

test("a link that the package did not make is replaced with a warning", (t) => {
  const { root, env, run } = setup(t);
  mkdirSync(join(root, "mine", "jev"), { recursive: true });
  mkdirSync(env.CLAUDE_DIR, { recursive: true });
  mkdirSync(env.BIN_DIR, { recursive: true });
  symlinkSync(join(root, "mine", "jev"), join(env.CLAUDE_DIR, "jev"));
  symlinkSync(join(root, "mine", "jev"), join(env.BIN_DIR, "jev"));
  const r = run(REPO, "install", "--claude", "jev");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`jev: WARNING replaced the link to ${join(root, "mine", "jev")}`));
  assert.equal((r.stdout.match(/WARNING replaced the link/g) ?? []).length, 2, "skill folder and CLI");
  assert.ok(existsSync(join(env.CLAUDE_DIR, "jev", ".skills-package")));
});

test("a CLI without the exec bit runs from the copy that stays after a partial uninstall", (t) => {
  const { root, env, run } = setup(t);
  const pkg = join(root, "pkg");
  for (const p of ["package.json", "bin", "shared", "pi"]) cpSync(join(REPO, p), join(pkg, p), { recursive: true, verbatimSymlinks: true });
  const audit = join(pkg, "shared", "repo-audit", "scripts", "audit.sh");
  chmodSync(audit, 0o644);
  assert.equal(run(pkg, "install", "repo-audit").status, 0);
  assert.equal(run(pkg, "uninstall", "--claude", "repo-audit").status, 0);
  assert.equal(readlinkSync(join(env.BIN_DIR, "repo-audit")), join(env.PI_DIR, "repo-audit", "scripts", "audit.sh"));
  const r = spawnSync(join(env.BIN_DIR, "repo-audit"), ["status"], { env: { ...env, REPO: root, WORKTREE: join(root, "wt") }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("--link from an installed package stops: npm can delete it under the links", (t) => {
  const { root, env, run } = setup(t);
  for (const where of [[".npm", "_npx", "0123abcd"], ["proj"], ["pnpm", "dlx", "x"]]) {
    const pkg = join(root, ...where, "node_modules", "@marmos91", "skills");
    for (const p of ["package.json", "bin", "shared", "pi"]) cpSync(join(REPO, p), join(pkg, p), { recursive: true, verbatimSymlinks: true });
    const r = run(pkg, "install", "--claude", "--link", "jev");
    assert.equal(r.status, 1, where.join("/"));
    assert.match(r.stderr, /--link needs a git clone/);
    assert.ok(!existsSync(env.CLAUDE_DIR), "nothing installed");
  }
  assert.equal(run(join(root, "proj", "node_modules", "@marmos91", "skills"), "install", "--claude", "jev").status, 0, "a copy still works");
});
