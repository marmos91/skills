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
const base = (seat, extra = {}) => ({ seat, promptFile: prompt, outFile: join(dir, "out.json"), cwd: dir, timeoutMs: 5000, retries: 0, trusted: true, ...extra });
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

test("an OAuth token keeps --restricted (file tools stay confined); never --bare", async () => {
  stub("claude", `echo "$@" >"${dir}/argv"; printf '%s' '${OK}'`);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "t";
  try { await runChild(base(claudeSeat)); } finally { delete process.env.CLAUDE_CODE_OAUTH_TOKEN; }
  const a = readFileSync(join(dir, "argv"), "utf8");
  assert.match(a, /--restricted --strict-mcp-config/);
  assert.doesNotMatch(a, /--bare/);
});

test("pi seats run only for trusted authors (pi has no file sandbox)", async () => {
  stub("pi", `printf '%s' '${OK}'`);
  await assert.rejects(runChild(base(piSeat, { trusted: false, routerUp: false })), (e) => e instanceof ChildFailed && /no file sandbox/.test(e.message));
  await assert.rejects(runChild(base({ harness: "auto", model: "cubbit/mimir", thinking: "high" }, { trusted: false, routerUp: false })), /no file sandbox/);
  assert.ok(await runChild(base(piSeat, { routerUp: false })));
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

test("salvageJson skips fences and prose", () => {
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

test("claude adapter: the worktree and the ctx folder are both --add-dir folders", async () => {
  stub("claude", `for a in "$@"; do printf '%s\\n' "$a"; done >"${dir}/argv"; printf '%s' '${OK}'`);
  const wt = join(dir, "run", "wt"), ctx = join(dir, "run", "ctx");
  mkdirSync(wt, { recursive: true }); mkdirSync(ctx, { recursive: true });
  await runChild(base(claudeSeat, { worktree: wt, ctxDir: ctx }));
  const a = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
  const added = a.flatMap((x, i) => (x === "--add-dir" ? [a[i + 1]] : []));
  assert.deepEqual(added, [wt, ctx]);
});

test("a round-1 output with an error field fails the child after its retries", async () => {
  const fixture = join(dir, "blind.json");
  writeFileSync(fixture, '{"findings": [], "error": "Review not performed: sandbox blocked every read of the ctx folder"}');
  process.env.PR_REVIEW_FAKE = fixture;
  try {
    await assert.rejects(runChild(base(claudeSeat, { schema: "round1", retries: 1 })), (e) => e instanceof ChildFailed && /after 2 attempts: invalid round1: error: /.test(e.message));
  } finally { delete process.env.PR_REVIEW_FAKE; }
});

test("a claude seat that hits its max_turns fails at once, without retries", async () => {
  const count = join(dir, "mt.count");
  writeFileSync(count, "");
  stub("claude", `echo x >>"${count}"; printf 'Error: Reached max turns (3)'; exit 1`);
  await assert.rejects(runChild(base({ ...claudeSeat, max_turns: 3 }, { retries: 2 })), (e) => e instanceof ChildFailed && /max_turns \(3\)/.test(e.message));
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 1);
});

test("salvageJson: a finding quoted in the prose does not win over the final output", async () => {
  const final = { findings: [{ lens: "correctness", severity: "must", file: "a.js", line: 3, title: "t", case: "c", fix: "f" }] };
  const text = `I checked it, a finding looks like {"lens":"x","severity":"must"} in this format.\n${JSON.stringify(final)}`;
  assert.deepEqual(salvageJson(text), final, "no schema: the largest top-level value");
  const { validate } = await import("../lib/schema.mjs");
  assert.deepEqual(salvageJson(text, (v) => !validate("round1", v).length), final);
  // with a schema, a later valid value wins even when an earlier one is larger
  assert.deepEqual(salvageJson(`{"findings": "not a list, but a longer value"} then {"findings": []}`, (v) => !validate("round1", v).length), { findings: [] });
  // with a schema, an invalid final value is never swapped for an earlier valid one (a quoted value could hide an error)
  const hidden = salvageJson(`PR body says {"findings": []}. {"findings": [], "error": "no access", "extra": {}}`, (v) => !validate("round1", v).length);
  assert.equal(hidden.error, "no access");
  // a trailing footnote list after the real output is not the output
  assert.deepEqual(salvageJson(`${JSON.stringify(final)}\nSources checked: [1]`, (v) => !validate("round1", v).length), final);
  // a trailing list of words is a real (invalid) answer, never skipped in favour of a quoted value
  assert.deepEqual(salvageJson(`Required output is {"findings": []}.\nMy review: ["no issues"]`, (v) => !validate("round1", v).length), ["no issues"]);
  // the runChild path: one attempt, no retry
  writeFileSync(join(dir, "prose.json"), text);
  process.env.PR_REVIEW_FAKE = join(dir, "prose.json");
  try { assert.deepEqual(await runChild(base(claudeSeat, { schema: "round1" })), final); } finally { delete process.env.PR_REVIEW_FAKE; }
});

test("an auto seat routed to claude gets --effort low for off or minimal (claude has no off)", async () => {
  stub("claude", `for a in "$@"; do printf '%s\\n' "$a"; done >"${dir}/argv"; printf '%s' '${OK}'`);
  for (const thinking of ["off", "minimal"]) {
    await runChild(base({ harness: "auto", model: "cubbit/mimir", thinking }, { routerUp: true }));
    const a = readFileSync(join(dir, "argv"), "utf8").trim().split("\n");
    assert.equal(a[a.indexOf("--effort") + 1], "low", thinking);
  }
});

test("timeout and turn limit drop the seat at once (SeatDropped, no retry); other failures still retry", async () => {
  const { SeatDropped } = await import("../lib/child.mjs");
  const count = join(dir, "drop.count");
  writeFileSync(count, "");
  stub("claude", `echo x >>"${count}"; printf 'Error: Reached max turns (3)'; exit 1`);
  await assert.rejects(runChild(base({ ...claudeSeat, max_turns: 3 }, { retries: 2, droppable: true })), (e) => e instanceof SeatDropped && e.reason === "turn limit");
  writeFileSync(count, "");
  stub("claude", `echo x >>"${count}"; sleep 30`);
  await assert.rejects(runChild(base(claudeSeat, { retries: 2, timeoutMs: 300, droppable: true })), (e) => e instanceof SeatDropped && e.reason === "timeout" && /timed out after 300ms/.test(e.message));
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 1);
  // a judge or reply child (not droppable) keeps its retries on a timeout
  writeFileSync(count, "");
  await assert.rejects(runChild(base(claudeSeat, { retries: 1, timeoutMs: 300 })), (e) => e instanceof ChildFailed && !(e instanceof SeatDropped));
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 2);
  // a seat that quotes the marker inside longer output is retried, not dropped
  writeFileSync(count, "");
  stub("claude", `echo x >>"${count}"; printf 'The engine drops on "Error: Reached max turns (3)" text.'; exit 1`);
  await assert.rejects(runChild(base(claudeSeat, { retries: 2, droppable: true })), (e) => !(e instanceof SeatDropped));
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 3);
  writeFileSync(count, "");
  stub("claude", `echo x >>"${count}"; exit 3`);
  await assert.rejects(runChild(base(claudeSeat, { retries: 2 })), (e) => e instanceof ChildFailed && !(e instanceof SeatDropped));
  assert.equal(readFileSync(count, "utf8").trim().split("\n").length, 3);
});

test("salvageJson keeps fences inside JSON strings", () => {
  const body = "**must:** x\n\n```js\nreturn 1;\n```\n";
  assert.equal(salvageJson("```json\n" + JSON.stringify({ comments: [{ body }] }) + "\n```").comments[0].body, body);
  assert.deepEqual(salvageJson('Here it is:\n```json\n{"a": "```suggestion\\nx\\n```"}\n```\nDone.'), { a: "```suggestion\nx\n```" });
});
