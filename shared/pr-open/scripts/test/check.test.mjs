import { test } from "node:test";
import assert from "node:assert/strict";
import { initRepo, commit, git } from "./repo.mjs";
import { aiMentions, checkBranch } from "../lib/check.mjs";

test("an AI trailer and the robot are hits", () => {
  assert.ok(aiMentions("fix: x\n\nCo-Authored-By: Someone <noreply@anthropic.com>").includes("noreply@anthropic.com"));
  assert.deepEqual(aiMentions("🤖 Generated with tools"), ["🤖"]);
  assert.deepEqual(aiMentions("feat: x\n\nCo-Authored-By: Claude Opus <a@b.c>"), ["claude"]);
});

test("tool names are hits, case-insensitive", () => {
  assert.deepEqual(aiMentions("made by ChatGPT and GPT-4"), ["chatgpt", "gpt-4"]);
  assert.deepEqual(aiMentions("This is AI-generated"), ["ai-generated"]);
});

test("the allow list lets a word through", () => {
  assert.deepEqual(aiMentions("feat: answer Copilot reviews", ["copilot"]), []);
  assert.deepEqual(aiMentions("feat: answer Copilot reviews", ["Copilot"]), []);
  assert.deepEqual(aiMentions("feat: answer Copilot reviews"), ["copilot"]);
});

test("paths and identifiers are not hits", () => {
  assert.deepEqual(aiMentions("edit .claude/settings.json, docs/claude.md and claude_code; llm_client"), []);
});

test("plural and model forms are hits", () => {
  assert.deepEqual(aiMentions("LLMs, GPT4 and Sonnet 4.5 wrote this; Claude Code too"), ["llms", "gpt4", "sonnet 4.5", "claude"]);
});

test("hyphenated and dotted forms are hits", () => {
  assert.deepEqual(aiMentions("LLM-generated"), ["llm"]);
  assert.deepEqual(aiMentions("switch to gpt-4o-mini"), ["gpt-4o"]);
  assert.deepEqual(aiMentions("made with claude-3, ported from anthropic.ai"), ["claude", "anthropic"]);
});

test("checkBranch: a signed commit in a sha256 repo is signed", () => {
  const dir = initRepo({ objectFormat: "sha256" });
  git(dir, "checkout", "-q", "-b", "feat/x");
  commit(dir, "a.txt", "a", "feat: a");
  assert.deepEqual(checkBranch(dir, "main").unsigned, []);
});

test("plain words are not hits", () => {
  assert.deepEqual(aiMentions("fix: cursor position in the editor; recall the llama farm; email"), []);
});

test("checkBranch: one unsigned commit is reported", () => {
  const dir = initRepo();
  git(dir, "checkout", "-q", "-b", "feat/x");
  commit(dir, "a.txt", "a", "feat: a", { sign: true });
  const bad = commit(dir, "b.txt", "b", "feat: b", { sign: false });
  const r = checkBranch(dir, "main");
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsigned, [bad.slice(0, 7)]);
  assert.deepEqual(r.ai, []);
});

test("checkBranch: AI words in a commit and the body, with where", () => {
  const dir = initRepo();
  git(dir, "checkout", "-q", "-b", "feat/x");
  const sha = commit(dir, "a.txt", "a", "feat: a\n\nCo-Authored-By: Claude <x@y.z>");
  const r = checkBranch(dir, "main", { title: "feat: a", body: "made by ChatGPT" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.unsigned, []);
  assert.deepEqual(r.ai, [{ where: sha.slice(0, 7), hits: ["claude"] }, { where: "body", hits: ["chatgpt"] }]);
});

test("checkBranch: clean branch is ok", () => {
  const dir = initRepo();
  git(dir, "checkout", "-q", "-b", "feat/x");
  commit(dir, "a.txt", "a", "feat: a");
  assert.deepEqual(checkBranch(dir, "main", { title: "feat: a", body: "Closes #1" }), { ok: true, unsigned: [], ai: [] });
});
