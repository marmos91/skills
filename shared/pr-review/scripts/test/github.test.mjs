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
  assert.deepEqual(p, { id: "PR_node1", headSha: "abc123", baseRef: "main", author: "alice", authorAssociation: "MEMBER", isDraft: false, body: "Fixes #7", title: "Add thing", closingIssues: [7], headRef: "feat/thing" });
});

test("threads maps comments and author type", async () => {
  stubDir();
  const [t] = await gh.threads("o/r", 5);
  assert.equal(t.id, "T1");
  assert.equal(t.viewerCanResolve, true);
  const out = (await gh.threads("o/r", 5))[1];
  assert.deepEqual([out.id, out.isOutdated, out.line, out.originalLine], ["T2", true, null, 4]);
  assert.equal(t.isOutdated, false);
  assert.deepEqual(t.comments.map((c) => [c.id, c.author, c.authorType]), [[111, "alice", "User"], [112, "ci-bot", "Bot"]]);
});

const thr = (id, next) => ({ stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: !!next, endCursor: next }, nodes: [{ id, isResolved: false, viewerCanResolve: false, path: "p", line: 1, comments: { nodes: [] } }] } } } } } });
const calls = (d) => readFileSync(join(d, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);

test("threads paginates and sends the cursor", async () => {
  const d = stubDir({ "graphql Threads": thr("A", "c1"), "graphql Threads cursor=c1": thr("B", null) });
  assert.deepEqual((await gh.threads("o/r", 5)).map((t) => t.id), ["A", "B"]);
  assert.deepEqual(calls(d).map((c) => c.variables.cursor), [null, "c1"]);
});

test("pendingReview", async () => {
  stubDir();
  assert.deepEqual(await gh.pendingReview("o/r", 5), { id: "PRR_1" });
  stubDir({ "graphql PendingReview": { stdout: { data: { repository: { pullRequest: { reviews: { nodes: [] } } } } } } });
  assert.equal(await gh.pendingReview("o/r", 5), null);
});

const K = (c) => c.repeat(40); // a sha1-shaped key
const mk = (key, login = "marmos91") => ({ user: { login }, body: `x\n<!-- pr-review run=r1 sha=abc123 key=${key} -->` });
const lists = (o = {}) => Object.fromEntries(["pulls/5/reviews", "pulls/5/comments", "issues/5/comments"].map((p) => [`api --paginate --slurp repos/o/r/${p}`, { stdout: o[p] ?? [[]] }]));

test("findMarker: the viewer's reviews, review comments and PR comments only", async () => {
  stubDir(lists({ "pulls/5/reviews": [[mk(K("a"))]], "issues/5/comments": [[mk(K("b")), mk(K("c"), "mallory")]] }));
  assert.equal(await gh.findMarker("o/r", 5, `key=${K("a")}`), true);
  assert.equal(await gh.findMarker("o/r", 5, `key=${K("b")}`), true);
  assert.equal(await gh.findMarker("o/r", 5, `key=${K("c")}`), false, "someone else's marker");
  assert.equal(await gh.findMarker("o/r", 5, `key=${K("d")}`), false);
});

test("a review with more than 100 comments: a marker on the second page is found", async () => {
  // One review's 150 inline comments come back as two REST pages; GraphQL's comments(first: 100) never saw the last 50.
  const comments = Array.from({ length: 150 }, (_, i) => mk(i.toString(16).padStart(40, "0")));
  const d = stubDir(lists({ "pulls/5/comments": [comments.slice(0, 100), comments.slice(100)] }));
  const last = (149).toString(16).padStart(40, "0");
  assert.equal(await gh.findMarker("o/r", 5, `key=${last}`), true);
  const keys = await gh.markerKeys("o/r", 5);
  assert.equal(keys.size, 150);
  assert.ok(calls(d).some((c) => c.key === "api --paginate --slurp repos/o/r/pulls/5/comments"), "fully paged REST");
});

test("postReview needs commitOID and passes multi-line fields", async () => {
  const d = stubDir();
  await assert.rejects(gh.postReview("o/r", 5, { event: "COMMENT", body: "b" }), /commitOID/);
  assert.deepEqual(muts(d), []);
  await gh.postReview("o/r", 5, { commitOID: "abc123", event: "COMMENT", body: "b", threads: [{ path: "a", line: 5, startLine: 2, body: "m" }] });
  assert.deepEqual(muts(d)[0].input.variables.input.threads[0], { path: "a", line: 5, side: "RIGHT", startLine: 2, startSide: "RIGHT", body: "m" });
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

test("checks: stale head, queued-only since, real failures throw", async () => {
  stubDir();
  assert.deepEqual(await gh.checks("o/r", 11, "abc123"), { state: "pending", since: null, items: [], stale: true });
  const q = await gh.checks("o/r", 10, "abc123");
  assert.equal(q.state, "pending"); assert.equal(q.since, "2026-11-01T10:08:00Z");
  await assert.rejects(gh.checks("o/r", 9, "abc123"), (e) => e instanceof gh.GhError && /401/.test(e.message));
});

test("failedLog keeps the last lines", async () => {
  stubDir();
  assert.equal(await gh.failedLog("o/r", 200, 2), "line3\nline4");
});

test("errors: GhError with redacted token; unknown argv fails", async () => {
  stubDir({ "api user": { stderr: "bad token ghp_ABC123def456", exit: 4 } });
  await assert.rejects(gh.viewer(), (e) => e instanceof gh.GhError && e.code === 4 && !/ghp_ABC/.test(e.message + e.stderr) && /redacted/.test(e.stderr));
  stubDir({ "api user": { stderr: "github_pat_11AAAA_xyz", exit: 1 } });
  await assert.rejects(gh.viewer(), (e) => !/github_pat_/.test(e.stderr));
  stubDir({});
  await assert.rejects(gh.pr("o/r", 99), (e) => e instanceof gh.GhError && /no route/.test(e.stderr));
});
