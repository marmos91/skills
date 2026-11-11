import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as gh from "../lib/github.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const stubJs = join(here, "gh-stub.mjs");
const fixture = join(here, "fixtures", "gh", "routes.json");

const wrapper = join(mkdtempSync(join(tmpdir(), "ghbin-")), "gh");
writeFileSync(wrapper, `#!/bin/sh\nexec node "${stubJs}" "$@"\n`);
chmodSync(wrapper, 0o755);
process.env.GH_BIN = wrapper;

// Fresh stub dir per call; `over` replaces routes.
function stubDir(over = {}) {
  const d = mkdtempSync(join(tmpdir(), "ghstub-"));
  const routes = { ...JSON.parse(readFileSync(fixture, "utf8")), ...over };
  writeFileSync(join(d, "routes.json"), JSON.stringify(routes));
  process.env.GH_STUB_DIR = d;
  return d;
}
const muts = (d) => (existsSync(join(d, "mutations.jsonl")) ? readFileSync(join(d, "mutations.jsonl"), "utf8").trim().split("\n").map(JSON.parse) : []);

test("viewer and pr", async () => {
  stubDir();
  assert.equal(await gh.viewer(), "marmos91");
  const p = await gh.pr("o/r", 5);
  assert.deepEqual(p, { id: "PR_node1", headSha: "abc123", baseRef: "main", author: "alice", authorAssociation: "MEMBER", isDraft: false, body: "Fixes #7", title: "Add thing", closingIssues: [7] });
});

test("threads maps comments and author type", async () => {
  stubDir();
  const [t] = await gh.threads("o/r", 5);
  assert.equal(t.id, "T1");
  assert.equal(t.viewerCanResolve, true);
  assert.deepEqual(t.comments.map((c) => [c.id, c.author, c.authorType]), [[111, "alice", "User"], [112, "ci-bot", "Bot"]]);
});

test("threads paginates", async () => {
  const mk = (id, next) => ({ stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes: [{ id, isResolved: false, viewerCanResolve: false, path: "p", line: 1, comments: { nodes: [] } }] } } } } } });
  // The stub keys on operation only, so a self-advancing sh wrapper serves page 1 then 2.
  const d = stubDir({ "graphql Threads": mk("A", "c1") });
  const w = join(d, "gh");
  const second = join(d, "second.json");
  writeFileSync(second, JSON.stringify({ ...JSON.parse(readFileSync(join(d, "routes.json"), "utf8")), "graphql Threads": mk("B", null) }));
  writeFileSync(w, `#!/bin/sh\nif [ -f "${d}/seen" ]; then cp "${second}" "${d}/routes.json"; fi\ntouch "${d}/seen"\nexec node "${stubJs}" "$@"\n`);
  chmodSync(w, 0o755);
  const old = process.env.GH_BIN; process.env.GH_BIN = w;
  try { assert.deepEqual((await gh.threads("o/r", 5)).map((t) => t.id), ["A", "B"]); } finally { process.env.GH_BIN = old; }
});

test("pendingReview", async () => {
  stubDir();
  assert.deepEqual(await gh.pendingReview("o/r", 5), { id: "PRR_1" });
  stubDir({ "graphql PendingReview": { stdout: { data: { repository: { pullRequest: { reviews: { nodes: [] } } } } } } });
  assert.equal(await gh.pendingReview("o/r", 5), null);
});

test("findMarker: viewer's comments and review comments only", async () => {
  stubDir();
  assert.equal(await gh.findMarker("o/r", 5, "key=k1"), true);
  assert.equal(await gh.findMarker("o/r", 5, "key=k2"), true);
  assert.equal(await gh.findMarker("o/r", 5, "key=other"), false);
  assert.equal(await gh.findMarker("o/r", 5, "key=zzz"), false);
});

test("postReview sends exactly one mutation with commitOID", async () => {
  const d = stubDir();
  const r = await gh.postReview("o/r", 5, { commitOID: "abc123", event: "COMMENT", body: "sum", threads: [{ path: "a.js", line: 3, side: "RIGHT", body: "c" }] });
  assert.equal(r.url, "https://github.com/o/r/pull/5#pullrequestreview-1");
  const m = muts(d);
  assert.equal(m.length, 1);
  assert.equal(m[0].key, "graphql PostReview");
  assert.deepEqual(m[0].input.variables.input, { pullRequestId: "PR_node1", commitOID: "abc123", event: "COMMENT", body: "sum", threads: [{ path: "a.js", line: 3, side: "RIGHT", body: "c" }] });
});

test("reply and resolve are mutations", async () => {
  const d = stubDir();
  await gh.reply("o/r", 5, 111, "Agreed");
  await gh.resolve("T1");
  const m = muts(d);
  assert.deepEqual(m.map((x) => x.key), ["api -X POST repos/o/r/pulls/5/comments/111/replies --input -", "graphql ResolveThread"]);
  assert.deepEqual(m[0].input, { body: "Agreed" });
  assert.equal(m[1].input.variables.id, "T1");
});

test("reads record no mutations", async () => {
  const d = stubDir();
  await gh.pr("o/r", 5); await gh.threads("o/r", 5);
  assert.deepEqual(muts(d), []);
});

test("permission, 404 is none", async () => {
  stubDir();
  assert.equal(await gh.permission("o/r", "alice"), "write");
  assert.equal(await gh.permission("o/r", "nobody"), "none");
});

test("searchPRs merges and dedupes with reasons", async () => {
  stubDir();
  const r = await gh.searchPRs("o/r", "marmos91");
  assert.deepEqual(r.map((x) => [x.number, x.author, x.reasons]), [[5, "marmos91", ["author", "review-requested"]], [6, "bob", ["review-requested", "mentions"]]]);
});

test("checks: green, red, pending, none", async () => {
  stubDir();
  const g = await gh.checks("o/r", 5, "abc123");
  assert.equal(g.state, "green"); assert.equal(g.since, null);
  assert.equal(g.items[0].runId, "100"); assert.equal(g.items[1].runId, null);
  const red = await gh.checks("o/r", 6, "abc123");
  assert.equal(red.state, "red");
  const pend = await gh.checks("o/r", 7, "abc123");
  assert.equal(pend.state, "pending"); assert.equal(pend.since, "2026-11-01T10:07:00Z");
  assert.deepEqual(await gh.checks("o/r", 8, "abc123"), { state: "none", since: null, items: [] });
});

test("failedLog keeps the last lines", async () => {
  stubDir();
  assert.equal(await gh.failedLog("o/r", 200, 2), "line3\nline4");
});

test("errors: GhError with redacted token; unknown argv fails", async () => {
  stubDir({ "api user": { stderr: "bad token ghp_ABC123def456", exit: 4 } });
  await assert.rejects(gh.viewer(), (e) => e instanceof gh.GhError && e.code === 4 && !/ghp_ABC/.test(e.message + e.stderr) && /redacted/.test(e.stderr));
  stubDir({});
  await assert.rejects(gh.pr("o/r", 99), (e) => e instanceof gh.GhError && /no route/.test(e.stderr));
});
