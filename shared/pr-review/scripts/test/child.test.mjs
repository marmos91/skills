import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runChild, salvageJson, ChildFailed } from "../lib/child.mjs";

const dir = mkdtempSync(join(tmpdir(), "child-"));
const bin = join(dir, "bin");
import { mkdirSync } from "node:fs";
mkdirSync(bin);
const stub = (name, body) => { const p = join(bin, name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); };
const prompt = join(dir, "prompt.txt");
writeFileSync(prompt, "SECRET-PROMPT-TEXT");
process.env.PATH = `${bin}:${process.env.PATH}`;
const OK = '{"position":"ask","body":"b"}';
const base = (seat, extra = {}) => ({ seat, promptFile: prompt, outFile: join(dir, "out.json"), cwd: dir, timeoutMs: 5000, retries: 0, ...extra });
const claudeSeat = { harness: "claude", model: "opus", thinking: "high" };
const piSeat = { harness: "pi", model: "cubbit/mimir", thinking: "high" };

test("child env has no GitHub or AWS secrets", async () => {
  const envFile = join(dir, "env.txt"), fixture = join(dir, "fx.json");
  writeFileSync(fixture, OK);
  Object.assign(process.env, { PR_REVIEW_FAKE: fixture, PR_REVIEW_FAKE_ENV: envFile, GH_TOKEN: "x", GITHUB_TOKEN: "x", FOO_SECRET: "x", AWS_ACCESS_KEY_ID: "x", GITHUB_PERSONAL_ACCESS_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", ANTHROPIC_BASE_URL: "http://r" });
  try {
    await runChild(base(claudeSeat));
    const env = readFileSync(envFile, "utf8");
    assert.doesNotMatch(env, /^(GH_TOKEN|GITHUB_TOKEN|FOO_SECRET|GITHUB_PERSONAL_ACCESS_TOKEN|AWS_)/m);
    assert.match(env, /^ANTHROPIC_BASE_URL=http:\/\/r$/m);
    assert.match(env, /^PATH=/m);
  } finally {
    for (const k of ["PR_REVIEW_FAKE", "PR_REVIEW_FAKE_ENV", "GH_TOKEN", "GITHUB_TOKEN", "FOO_SECRET", "AWS_ACCESS_KEY_ID", "ANTHROPIC_BASE_URL", "GITHUB_PERSONAL_ACCESS_TOKEN", "AWS_SECRET_ACCESS_KEY"]) delete process.env[k];
  }
});

test("pi adapter closes stdin", async () => {
  // stub blocks reading stdin; only returns if pi.sh redirects it from /dev/null
  stub("pi", `cat >/dev/null; printf '%s' '${OK}'`);
  const pi = join(dirname(fileURLToPath(import.meta.url)), "..", "harness", "pi.sh");
  const p = spawn(pi, ["m", "high", "read", prompt, join(dir, "pi-out.json")], { stdio: ["pipe", "ignore", "ignore"] }); // pipe never closed
  const code = await new Promise((res) => { const t = setTimeout(() => { p.kill("SIGKILL"); res("hung"); }, 5000); p.on("close", (c) => { clearTimeout(t); res(c); }); });
  assert.equal(code, 0);
});

test("pi adapter attaches the prompt as a file and omits an empty provider", async () => {
  stub("pi", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  await runChild(base({ harness: "pi", model: "plain", thinking: "high" }));
  const a = readFileSync(join(dir, "argv"), "utf8");
  assert.doesNotMatch(a, /--provider|SECRET-PROMPT/);
  assert.match(a, new RegExp(`@${prompt}`));
});

test("claude --bare keeps --strict-mcp-config when an OAuth token is set", async () => {
  stub("claude", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
  try { await runChild(base(claudeSeat)); } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  const a = readFileSync(join(dir, "argv"), "utf8");
  assert.match(a, /--bare --strict-mcp-config/);
  assert.doesNotMatch(a, /--restricted/);
});

test("cwd is a neutral folder; the worktree is added via --add-dir", async () => {
  const wt = join(dir, "wt"); mkdirSync(join(wt, ".claude"), { recursive: true });
  writeFileSync(join(wt, "CLAUDE.md"), "x"); writeFileSync(join(wt, ".claude", "settings.json"), "{}");
  stub("claude", `pwd -P >"${dir}/cwd"; echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  await runChild(base(claudeSeat, { worktree: wt }));
  assert.notEqual(readFileSync(join(dir, "cwd"), "utf8").trim(), realpathSync(wt));
  assert.match(readFileSync(join(dir, "argv"), "utf8"), new RegExp(`--add-dir ${wt} `));
});

test("SIGTERM to the engine kills running seats", async () => {
  stub("claude", `echo $$ >"${dir}/live.pid"; sleep 300 & wait`);
  const mod = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "child.mjs");
  const script = `import {runChild} from ${JSON.stringify(mod)};
    runChild({seat:{harness:"claude",model:"o",thinking:"high"},promptFile:${JSON.stringify(prompt)},outFile:${JSON.stringify(join(dir, "live-out.json"))},timeoutMs:60000,retries:0}).catch(()=>{});`;
  const parent = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
  const pidFile = join(dir, "live.pid");
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
  const pid = Number(readFileSync(pidFile, "utf8"));
  const closed = new Promise((r) => parent.on("close", r));
  parent.kill("SIGTERM");
  await closed;
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("claude adapter sends the prompt on stdin", async () => {
  stub("claude", `echo "$@" >"${dir}/argv"; cat >"${dir}/stdin"; printf '%s' '${OK}'`);
  await runChild(base(claudeSeat));
  assert.doesNotMatch(readFileSync(join(dir, "argv"), "utf8"), /SECRET-PROMPT/);
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "SECRET-PROMPT-TEXT");
});

test("tools=read gives no shell; tools=shell adds Bash/bash", async () => {
  stub("claude", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  stub("pi", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const argv = () => readFileSync(join(dir, "argv"), "utf8");
  await runChild(base(claudeSeat, { tools: "read" }));
  assert.match(argv(), /--tools Read,Grep,Glob\b(?!,)/);
  assert.match(argv(), /--restricted --strict-mcp-config/);
  await runChild(base(claudeSeat, { tools: "shell" }));
  assert.match(argv(), /--tools Read,Grep,Glob,Bash/);
  await runChild(base(piSeat, { tools: "read", routerUp: false }));
  assert.match(argv(), /--tools read,grep,find,ls\b(?!,)/);
  assert.match(argv(), /--provider cubbit --model mimir --thinking high/);
  await runChild(base(piSeat, { tools: "shell", routerUp: false }));
  assert.match(argv(), /--tools read,grep,find,ls,bash/);
});

test("auto resolves via routerUp", async () => {
  stub("claude", `echo "claude \${ANTHROPIC_BASE_URL:-none}" >"${dir}/who"; printf '%s' '${OK}'`);
  stub("pi", `echo pi >"${dir}/who"; printf '%s' '${OK}'`);
  const seat = { harness: "auto", model: "cubbit/mimir", thinking: "high" };
  await runChild(base(seat, { routerUp: true }));
  // the router model goes through the router, like claude-mimir
  assert.equal(readFileSync(join(dir, "who"), "utf8").trim(), "claude http://127.0.0.1:4000");
  await runChild(base(claudeSeat));
  assert.equal(readFileSync(join(dir, "who"), "utf8").trim(), "claude none", "a plain claude seat keeps its own endpoint");
  await runChild(base(seat, { routerUp: false }));
  assert.equal(readFileSync(join(dir, "who"), "utf8").trim(), "pi");
});

test("timeout kills the process group", async () => {
  stub("claude", `sleep 300 &\necho $! >"${dir}/gc.pid"\necho $$ >"${dir}/c.pid"\nwait`);
  await assert.rejects(runChild(base(claudeSeat, { timeoutMs: 500 })), ChildFailed);
  for (const f of ["gc.pid", "c.pid"]) {
    const pid = Number(readFileSync(join(dir, f), "utf8"));
    // SIGKILL is delivered synchronously, but the orphaned grandchild is reaped by init
    // asynchronously; until then it is a zombie that still answers kill(pid, 0).
    const gone = async () => {
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch (e) { return e.code === "ESRCH"; }
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };
    assert.ok(await gone(), `pid ${pid} (${f}) still alive after 2s`);
  }
});

test("invalid output is retried, then ChildFailed", async () => {
  stub("claude", `echo x >>"${dir}/n"; printf 'not json'`);
  await assert.rejects(runChild(base(claudeSeat, { schema: "reply", retries: 2 })), ChildFailed);
  assert.equal(readFileSync(join(dir, "n"), "utf8").trim().split("\n").length, 3);
  stub("claude", `printf '{"position":"bad","body":"b"}'`);
  await assert.rejects(runChild(base(claudeSeat, { schema: "reply" })), /invalid reply/);
});

test("salvageJson strips fences and prose", () => {
  assert.deepEqual(salvageJson('Sure!\n```json\n{"a":[1,{"b":"}"}]}\n```\nthanks'), { a: [1, { b: "}" }] });
  assert.deepEqual(salvageJson("x [1,2] y"), [1, 2]);
  assert.equal(salvageJson("nothing"), null);
});

test("claude adapter: file tools stay confined (no allow rule, deny rules for secrets); only shell seats allow Bash", async () => {
  stub("claude", `for a in "$@"; do printf '%s\\n' "$a"; done >"${dir}/argv"; printf '%s' '${OK}'`);
  const deny = ["--disallowedTools", "Read(~/.ssh/**)", "Read(~/.config/**)", "Read(~/.aws/**)", "Read(~/.gnupg/**)"];
  await runChild(base(claudeSeat));
  let a = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
  assert.deepEqual(a.slice(a.indexOf("--disallowedTools"), a.indexOf("--disallowedTools") + 5), deny);
  assert.equal(a[a.indexOf("--tools") + 1], "Read,Grep,Glob");
  assert.ok(!a.includes("--allowedTools"), "an allow rule for Read would reach outside the add-dir folders");
  assert.ok(a.includes("--restricted") && a.includes("--strict-mcp-config"));
  await runChild(base(claudeSeat, { tools: "shell" }));
  a = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
  assert.equal(a[a.indexOf("--tools") + 1], "Read,Grep,Glob,Bash");
  assert.deepEqual(a.slice(a.indexOf("--allowedTools"), a.indexOf("--allowedTools") + 2), ["--allowedTools", "Bash"]);
  assert.ok(a.includes("--disallowedTools"));
});

test("max_turns: claude gets --max-turns; pi has no such flag", async () => {
  stub("claude", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  await runChild(base({ ...claudeSeat, max_turns: 7 }));
  assert.match(readFileSync(join(dir, "argv"), "utf8"), /--max-turns 7(\s|$)/);
  await runChild(base(claudeSeat));
  assert.doesNotMatch(readFileSync(join(dir, "argv"), "utf8"), /--max-turns/);
  stub("pi", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  await runChild(base({ ...piSeat, max_turns: 7 }));
  assert.doesNotMatch(readFileSync(join(dir, "argv"), "utf8"), /max-turns/);
});

test("timeout_minutes sets the child timeout (default 10 minutes)", async (t) => {
  stub("claude", "sleep 300");
  const realSetTimeout = globalThis.setTimeout;
  const wait = (ms) => new Promise((r) => realSetTimeout(r, ms));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const [seat, ms] of [[{ ...claudeSeat, timeout_minutes: 2 }, 120000], [claudeSeat, 600000]]) {
    let msg;
    const p = runChild({ seat, promptFile: prompt, outFile: join(dir, "to.json"), retries: 0 }).then(() => "ok", (e) => e.message).then((m) => (msg = m));
    t.mock.timers.tick(ms - 1);
    await wait(300);
    assert.equal(msg, undefined, "not before the timeout");
    t.mock.timers.tick(1);
    for (let i = 0; i < 50 && msg === undefined; i++) await wait(100);
    if (msg === undefined) t.mock.timers.tick(3600000); // a wrong timeout must not hang the suite
    await p;
    assert.match(msg, new RegExp(`timed out after ${ms}ms`));
  }
});
