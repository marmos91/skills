import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  Object.assign(process.env, { PR_REVIEW_FAKE: fixture, PR_REVIEW_FAKE_ENV: envFile, GH_TOKEN: "x", GITHUB_PERSONAL_ACCESS_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x" });
  try {
    await runChild(base(claudeSeat));
    const env = readFileSync(envFile, "utf8");
    assert.doesNotMatch(env, /^(GH_TOKEN|GITHUB_PERSONAL_ACCESS_TOKEN|AWS_)/m);
    assert.match(env, /^PATH=/m);
  } finally {
    for (const k of ["PR_REVIEW_FAKE", "PR_REVIEW_FAKE_ENV", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN", "AWS_SECRET_ACCESS_KEY"]) delete process.env[k];
  }
});

test("pi adapter closes stdin", async () => {
  stub("pi", `cat >/dev/null; printf '%s' '${OK}'`);
  // a hang would exceed the 5 s child timeout and fail
  const r = await runChild(base(piSeat, { routerUp: false }));
  assert.equal(r.position, "ask");
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
  stub("claude", `echo claude >"${dir}/who"; printf '%s' '${OK}'`);
  stub("pi", `echo pi >"${dir}/who"; printf '%s' '${OK}'`);
  const seat = { harness: "auto", model: "cubbit/mimir", thinking: "high" };
  await runChild(base(seat, { routerUp: true }));
  assert.equal(readFileSync(join(dir, "who"), "utf8").trim(), "claude");
  await runChild(base(seat, { routerUp: false }));
  assert.equal(readFileSync(join(dir, "who"), "utf8").trim(), "pi");
});

test("timeout kills the process group", async () => {
  stub("claude", `sleep 300 &\necho $! >"${dir}/gc.pid"\necho $$ >"${dir}/c.pid"\nwait`);
  await assert.rejects(runChild(base(claudeSeat, { timeoutMs: 500 })), ChildFailed);
  for (const f of ["gc.pid", "c.pid"]) {
    const pid = Number(readFileSync(join(dir, f), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
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
