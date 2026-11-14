import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openQuestions, queueQuestion } from "../lib/questions.mjs";
import { queueCoreQuestion, readCorePaths } from "../lib/setup.mjs";
import { stateRoot } from "../lib/state.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, "..", "main.mjs");

// A git folder whose remote names the GitHub repo, and its own state and config roots.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prr-cli-"));
  const dir = join(root, "repo");
  mkdirSync(dir);
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/O/R.git"], { cwd: dir });
  const env = { ...process.env, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config") };
  return { root, dir, env, state: join(root, "state", "pr-review", "o__r") };
}
const cli = (fx, ...args) => spawnSync(process.execPath, [MAIN, ...args], { cwd: fx.dir, env: fx.env, encoding: "utf8" });

const QUESTION = {
  pr: 7, sha: "abc123", fingerprint: "deadbeefcafe", file: "a.js", line: 3, snippet: "const a = 2;",
  finding: { title: "Off by one", case: "The loop skips the last item." }, sides: { keep: "k", drop: "d" }, failure: "f",
};

test("answer: no args lists open questions as JSON; an answer closes the question", () => {
  const fx = fixture();
  process.env.XDG_STATE_HOME = fx.env.XDG_STATE_HOME;
  const id = queueQuestion(stateRoot("o/r"), QUESTION);
  let r = cli(fx, "answer");
  assert.equal(r.status, 0, r.stderr);
  const [q, ...more] = JSON.parse(r.stdout);
  assert.equal(more.length, 0);
  assert.equal(q.id, id);
  assert.deepEqual(q.options, ["post", "drop", "ask-author"]);
  assert.equal(q.file, join(fx.state, "questions", `${id}.md`));
  assert.equal(q.finding.title, "Off by one");
  assert.equal(q.snippet, undefined, "code from the PR stays in the fenced .md file");
  r = cli(fx, "answer", id, "post");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(cli(fx, "answer").stdout), []);
  assert.equal(cli(fx, "answer", id, "maybe").status, 1);
});

test("a command with no --repo and no git remote is a usage error", () => {
  const fx = fixture();
  execFileSync("git", ["remote", "remove", "origin"], { cwd: fx.dir });
  const r = cli(fx, "status");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--repo/);
});

test("an empty --lens list is a usage error", () => {
  const fx = fixture();
  for (const lens of ["", ","]) {
    const r = cli(fx, "review", "7", "--lens", lens);
    assert.equal(r.status, 1, JSON.stringify(lens));
    assert.match(r.stderr, /--lens needs at least one lens name/);
  }
});

test("status shows a stale lock, open questions, an unfinished run and the interrupted tick", async () => {
  const fx = fixture();
  process.env.XDG_STATE_HOME = fx.env.XDG_STATE_HOME;
  queueQuestion(stateRoot("o/r"), QUESTION);
  // A pid that is surely dead: a process that already exited.
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(join(fx.state, "lock"), { recursive: true });
  writeFileSync(join(fx.state, "lock", "pid"), dead);
  const run = join(fx.state, "pr", "7", "runs", "abc123-1");
  mkdirSync(join(run, "round1"), { recursive: true });
  writeFileSync(join(run, "run.json"), JSON.stringify({ effort: "low", lenses: ["correctness"], missing: [], planned: 9 }));
  writeFileSync(join(run, "frame.done"), "");
  writeFileSync(join(run, "setup.done"), "");
  mkdirSync(join(run, "setup"));
  writeFileSync(join(run, "setup", "0123abcd.done"), ""); // a check, not a child
  writeFileSync(join(run, "round1", "all~0.done"), "");
  writeFileSync(join(fx.state, "pr", "7", "state.json"), JSON.stringify({ reviews: 2, replies: { t1: 1, t2: 2 } }));
  mkdirSync(join(fx.state, "pr", "7", "lock"));
  writeFileSync(join(fx.state, "pr", "7", "lock", "pid"), dead);
  writeFileSync(join(fx.state, "todo.md"), "- [ ] fix x\n- [x] done y\n");
  writeFileSync(join(fx.state, "tick.json"), JSON.stringify({ startedAt: "2026-11-11T10:00:00Z", queue: [{ number: 7 }, { number: 8 }], done: [7], current: 8 }));
  writeFileSync(join(fx.state, "paused"), "");

  const r = cli(fx, "status", "--repo", "o/r");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.lock, { pid: Number(dead), stale: true });
  assert.equal(s.paused, true);
  assert.equal(s.questions.length, 1);
  assert.equal(s.todos, 1);
  assert.deepEqual(s.tick, { startedAt: "2026-11-11T10:00:00Z", current: 8, left: [8] });
  const pr = s.prs.find((p) => p.pr === 7);
  assert.deepEqual(pr.lock, { pid: Number(dead), stale: true });
  assert.equal(pr.reviews, 2);
  assert.equal(pr.replies, 3);
  assert.equal(pr.questions, 1);
  // the planned count saved in run.json (the run's own merged config), not one computed from the user config
  assert.deepEqual(pr.runs, [{ sha: "abc123", stage: "round1", children: { done: 1, total: 9 }, tokens: {} }]);
});

test("doctor: a seat whose probe fails is named and the exit is 1", async (t) => {
  const fx = fixture();
  Object.assign(process.env, { XDG_STATE_HOME: fx.env.XDG_STATE_HOME, XDG_CONFIG_HOME: fx.env.XDG_CONFIG_HOME });
  const cfg = join(fx.root, "c.json");
  mkdirSync(join(fx.env.XDG_CONFIG_HOME, "pr-review", "lenses"), { recursive: true });
  writeFileSync(join(fx.env.XDG_CONFIG_HOME, "pr-review", "lenses", "perf.md"), "Look for slow loops.\n");
  writeFileSync(join(fx.env.XDG_CONFIG_HOME, "pr-review", "lenses", "big.md"), "x\n".repeat(41));
  writeFileSync(cfg, JSON.stringify({ apiKey: "zz-unknown-key-value", lenses: { security: { enabled: false }, big: { enabled: false } }, seats: [{ harness: "claude", model: "opus", thinking: "high" }, { harness: "pi", model: "bad/model", thinking: "high" }, { harness: "claude", model: "opus", thinking: "medium" }] }));
  const gh = join(fx.root, "gh");
  writeFileSync(gh, "#!/bin/sh\nexit 0\n");
  chmodSync(gh, 0o755);
  const oldGh = process.env.GH_BIN;
  process.env.GH_BIN = gh;
  t.after(() => { if (oldGh === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = oldGh; });
  const { main } = await import("../main.mjs");
  const lines = [];
  t.mock.method(console, "log", (l) => lines.push(l));
  const probed = [];
  const runChild = async ({ seat, timeoutMs }) => {
    probed.push(`${seat.harness}:${seat.model}`);
    assert.equal(timeoutMs, 60000);
    if (seat.model === "bad/model") throw new Error("exit 1: no such model ghp_" + "a".repeat(36));
    return { ok: true };
  };
  const askJev = async () => ({ answer: "unsure", raw: null });
  const code = await main(["doctor", "--config", cfg], { runChild, askJev, findJev: () => null });
  assert.equal(code, 1);
  const out = lines.join("\n");
  assert.deepEqual(probed.sort(), ["claude:opus", "pi:bad/model"]); // two opus seats and the judge: one model, probed once
  assert.match(out, /FAIL\s+seat pi:bad\/model: exit 1: no such model/);
  assert.match(out, /ok\s+seat claude:opus/);
  assert.match(out, /WARN\s+jev: not found/);
  assert.match(out, /claude mode: --restricted/);
  assert.match(out, /^pr-review \d+\.\d+\.\d+ /m); // the version from SKILL.md
  assert.match(out, /lenses: adversarial, correctness, simplification, architecture, security \(off\), big \(user\) \(off\), perf \(user\)/);
  assert.match(out, /WARN\s+lens file \S+big\.md: over 40 lines or 4000 characters \(the lens is off\)/);
  assert.match(out, /effort low: \d+ children per PR/);
  assert.ok(!out.includes("zz-unknown-key-value"), "unknown config keys are not printed");
  assert.ok(!out.includes("ghp_" + "a".repeat(36)), "child errors are redacted");
});

test("status: a corrupt state.json and a young pid-less lock", () => {
  const fx = fixture();
  mkdirSync(join(fx.state, "lock"), { recursive: true });
  mkdirSync(join(fx.state, "pr", "9"), { recursive: true });
  writeFileSync(join(fx.state, "pr", "9", "state.json"), "{not json");
  const r = cli(fx, "status", "--repo", "o/r");
  assert.equal(r.status, 0, r.stderr);
  const s = JSON.parse(r.stdout);
  assert.deepEqual(s.lock, { pid: null, stale: false });
  assert.match(s.prs.find((p) => p.pr === 9).error, /state.json unreadable/);
});

test("review exits with Locked while another run holds that PR", async () => {
  const fx = fixture();
  const holder = spawn(process.execPath, ["--input-type=module", "-e",
    `const { acquireLock, stateRoot } = await import(${JSON.stringify(join(here, "..", "lib", "state.mjs"))}); acquireLock(stateRoot("o/r") + "/pr/5", " of PR #5"); console.log("held"); setTimeout(() => {}, 30000);`],
  { env: fx.env, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((res) => holder.stdout.once("data", res));
    const r = cli(fx, "review", "5", "--repo", "O/R");
    assert.equal(r.status, 1);
    assert.match(r.stderr, new RegExp(`holds the lock of PR #5 \\(pid ${holder.pid}\\)`));
  } finally { holder.kill(); }
});

test("tick takes the repo as a positional, like status", () => {
  const fx = fixture();
  const own = join(fx.root, "state", "pr-review", "o__r"); // stateRoot folds case
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, "paused"), "");
  const r = cli(fx, "tick", "O/R");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /paused/);
  assert.equal(cli(fx, "tick", "O/R", "z/w").status, 1);
});

test("tick outside a clone of the repo is a usage error: it fetches PR heads in this folder", () => {
  const fx = fixture();
  const r = cli(fx, "tick", "x/y");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a clone of x\/y/);
  assert.doesNotMatch(cli(fx, "tick", "o/r").stderr, /not a clone/, "the clone check folds case like GitHub");
});

test("--max-diff-lines takes a positive integer", () => {
  const fx = fixture();
  for (const bad of ["0", "-3", "x", "1.5"]) {
    const r = cli(fx, "review", "5", `--max-diff-lines=${bad}`);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--max-diff-lines must be a positive integer/, bad);
  }
  assert.match(cli(fx, "review", "5", "--repo", "x/y", "--max-diff-lines", "5000").stderr, /not a clone of x\/y/);
});

test("doctor: gitleaks probe (missing -> WARN, no stdin subcommand -> FAIL, ok)", async (t) => {
  const fx = fixture();
  Object.assign(process.env, { XDG_STATE_HOME: fx.env.XDG_STATE_HOME, XDG_CONFIG_HOME: fx.env.XDG_CONFIG_HOME });
  const gh = join(fx.root, "gh");
  writeFileSync(gh, "#!/bin/sh\nexit 0\n");
  chmodSync(gh, 0o755);
  const oldGh = process.env.GH_BIN;
  process.env.GH_BIN = gh;
  t.after(() => { if (oldGh === undefined) delete process.env.GH_BIN; else process.env.GH_BIN = oldGh; });
  const { main } = await import("../main.mjs");
  const fake = (name, help) => {
    const f = join(fx.root, name);
    writeFileSync(`${f}.help`, help + "\n");
    writeFileSync(f, `#!/bin/sh\ncase "$1" in version) echo 8.21.2 ;; --help) cat "${f}.help" ;; esac\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const run = async (gitleaks) => {
    const lines = [];
    const m = t.mock.method(console, "log", (l) => lines.push(l));
    const code = await main(["doctor"], { runChild: async () => ({ ok: true }), askJev: async () => ({ answer: "yes" }), findJev: () => "/x/jev", gitleaks });
    m.mock.restore();
    return { code, out: lines.join("\n") };
  };
  let r = await run(join(fx.root, "nope"));
  assert.match(r.out, /WARN\s+gitleaks: not found; the built-in secret patterns still apply/);
  assert.equal(r.code, 0);
  r = await run(fake("old", "Available Commands:\n  detect      detect secrets\n  version     version"));
  assert.match(r.out, /FAIL\s+gitleaks 8\.21\.2: no "stdin" subcommand/);
  assert.equal(r.code, 1);
  r = await run(fake("new", "Available Commands:\n  detect      detect secrets\n  stdin       detect secrets from stdin"));
  assert.match(r.out, /ok\s+gitleaks 8\.21\.2/);
  assert.equal(r.code, 0);
});

test("pause and resume take owner/repo, --repo or the remote, and reject extra arguments", () => {
  const fx = fixture();
  const paused = join(fx.root, "state", "pr-review", "x__y", "paused");
  assert.equal(cli(fx, "pause", "--repo", "x/y").status, 0);
  assert.ok(existsSync(paused));
  assert.equal(cli(fx, "resume", "x/y").status, 0);
  assert.ok(!existsSync(paused));
  assert.equal(cli(fx, "pause").status, 0, "the remote of the folder");
  assert.ok(existsSync(join(fx.state, "paused")));
  const extra = cli(fx, "pause", "x/y", "EXTRA");
  assert.equal(extra.status, 1);
  assert.ok(!existsSync(paused));
});

test("bin/pr-review runs the engine through a symlink, as install.sh links it", () => {
  const link = join(here, "..", "..", "bin", "pr-review");
  const dir = mkdtempSync(join(tmpdir(), "prbin-"));
  const outer = join(dir, "pr-review");
  execFileSync("ln", ["-s", link, outer]);
  const r = spawnSync(outer, ["status", "o/r"], { env: { ...process.env, XDG_STATE_HOME: join(dir, "s") }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).repo, "o/r");
});

test("status: lastRunTokens follows the newest run, also a finished dry run, and counts reply children", async () => {
  const fx = fixture();
  process.env.XDG_STATE_HOME = fx.env.XDG_STATE_HOME;
  const runs = join(fx.state, "pr", "9", "runs"), u = (input) => JSON.stringify({ input, output: 1, cache_read: null, cache_creation: null });
  const old = join(runs, "aaa-100"), dry = join(runs, "bbb-200");
  for (const d of [old, dry]) { mkdirSync(join(d, "round1"), { recursive: true }); writeFileSync(join(d, "post.done"), ""); }
  writeFileSync(join(old, "round1", "all~0.usage.json"), u(1));
  writeFileSync(join(dry, "round1", "all~0.usage.json"), u(10));
  mkdirSync(join(dry, "reply", "T1", "11"), { recursive: true });
  writeFileSync(join(dry, "reply", "T1", "11", "draft.usage.json"), u(5));
  writeFileSync(join(fx.state, "pr", "9", "state.json"), JSON.stringify({ reviews: 1, lastRunId: "aaa-100" }));
  const r = cli(fx, "status", "--repo", "o/r");
  assert.equal(r.status, 0, r.stderr);
  const pr = JSON.parse(r.stdout).prs.find((p) => p.pr === 9);
  assert.deepEqual(pr.runs, [], "both runs are finished");
  assert.equal(pr.lastRunTokens.round1.input, 10);
  assert.equal(pr.lastRunTokens.reply.input, 5);
  assert.equal(pr.lastRunTokens.total.input, 15);
});

test("respond loads the config: a missing --config file is a usage error that names it", () => {
  const fx = fixture();
  const r = cli(fx, "respond", "findings", "--pr", "7", "--config", join(fx.root, "nope.json"));
  assert.equal(r.status, 1, r.stderr);
  assert.doesNotMatch(r.stderr, /is not defined/);
  assert.match(r.stderr, /nope\.json/);
});

test("config core-paths saves the globs (none too) and closes the core-paths question; --depth is checked", () => {
  const fx = fixture();
  process.env.XDG_STATE_HOME = fx.env.XDG_STATE_HOME;
  const id = queueCoreQuestion(stateRoot("o/r"), "o/r", ["pkg/**"]);
  let r = cli(fx, "config", "core-paths", "O/R", "pkg/**", "cmd/**");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readCorePaths(fx.state), ["pkg/**", "cmd/**"]);
  assert.equal(openQuestions(fx.state).some((q) => q.id === id), false);
  writeFileSync(join(fx.dir, "main.go"), "package main\n");
  // argv is the same for a quoted literal path and an expanded glob: warn, and save as given
  r = cli(fx, "config", "core-paths", "o/r", "main.go", "pkg/**");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /main\.go exists here: if the shell expanded a glob, quote it/);
  assert.deepEqual(readCorePaths(fx.state), ["main.go", "pkg/**"]);
  r = cli(fx, "config", "core-paths", "o/r");
  assert.deepEqual(readCorePaths(fx.state), []);
  assert.equal(cli(fx, "config", "nope").status, 1);
  assert.match(cli(fx, "review", "1", "--depth", "deep").stderr, /--depth must be light\|full\|auto/);
});

test("review passes --depth to the engine", async () => {
  const fx = fixture();
  const { main } = await import("../main.mjs");
  const cwd = process.cwd();
  process.chdir(fx.dir);
  let got;
  try { await main(["review", "5", "--depth", "full"], { review: async (o) => { got = o; return { exit: 0, summary: "" }; } }); } finally { process.chdir(cwd); }
  assert.equal(got.depth, "full");
});
