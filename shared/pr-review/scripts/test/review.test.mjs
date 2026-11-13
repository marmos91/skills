import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { composeGuidance, review } from "../lib/review.mjs";
import { ChildFailed } from "../lib/child.mjs";
import { decide as realDecide } from "../lib/decider.mjs";
import { answer, openQuestions } from "../lib/questions.mjs";
import { stateRoot, prState, savePrState } from "../lib/state.mjs";
import { fingerprint } from "../lib/convergence.mjs";
import * as github from "../lib/github.mjs";
import { queueCoreQuestion, saveCorePaths } from "../lib/setup.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ghBin = join(mkdtempSync(join(tmpdir(), "ghbin-")), "gh");
writeFileSync(ghBin, `#!/bin/sh\nexec node "${join(here, "gh-stub.mjs")}" "$@"\n`);
chmodSync(ghBin, 0o755);
process.env.GH_BIN = ghBin;
// The hygiene child runs through the real runChild and the fake adapter.
const hygOut = join(mkdtempSync(join(tmpdir(), "hyg-")), "out.json");
writeFileSync(hygOut, '{"findings": []}');
process.env.PR_REVIEW_FAKE = hygOut;

const REPO = "o/r", N = 5, ME = "marmos91";
const S0 = "claude:opus", S1 = "auto:cubbit/mimir", S2 = "auto:cubbit/mimir-pro";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (dir, files, msg) => {
  for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", msg);
  return git(dir, "rev-parse", "HEAD");
};

// origin (bare) with main = base and refs/pull/5/head = head; repoDir is a clone that also names the GitHub remote.
function fixture(baseFiles = {}) {
  const root = mkdtempSync(join(tmpdir(), "prr-review-"));
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const origin = join(root, "origin.git"), seed = join(root, "seed"), repoDir = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  const base = commit(seed, { "a.js": "const a = 1;\n", ...baseFiles }, "base");
  git(seed, "push", "-q", origin, "main");
  git(seed, "checkout", "-qb", "feat");
  const head = commit(seed, { "a.js": "const a = 2;\nconst b = 3;\nconst c = 4;\nconst d = 5;\n" }, "feat: change a");
  git(seed, "push", "-q", origin, "HEAD:refs/pull/5/head");
  git(root, "clone", "-q", origin, repoDir);
  git(repoDir, "remote", "add", "gh", "https://github.com/o/r.git");
  const stubDir = join(root, "stub");
  mkdirSync(stubDir);
  process.env.GH_STUB_DIR = stubDir;
  return { root, seed, origin, repoDir, base, head, stubDir, state: stateRoot(REPO) };
}

const threadsRoute = (nodes = []) => ({ stdout: { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } } } });

function routes(fx, { head = fx.head, body = "Changes a.", threads = [], pending = null, postExit = 0, reviews = [], reviewComments = [] } = {}) {
  const r = {
    "api user": { stdout: { login: ME } },
    "pr view 5 -R o/r --json id,headRefOid,baseRefName,baseRefOid,author,isDraft,body,title,closingIssuesReferences,headRefName": {
      stdout: { id: "PR_1", headRefOid: head, baseRefName: "main", author: { login: "alice" }, isDraft: false, body, title: "feat: change a", closingIssuesReferences: [] },
    },
    "api repos/o/r/pulls/5": { stdout: { author_association: "CONTRIBUTOR" } },
    // markerKeys reads these three lists (REST, fully paged); frame reads reviews and issue comments too.
    "api --paginate --slurp repos/o/r/pulls/5/reviews": { stdout: [reviews] },
    "api --paginate --slurp repos/o/r/pulls/5/comments": { stdout: [reviewComments] },
    "api --paginate --slurp repos/o/r/issues/5/comments": { stdout: [[]] },
    "graphql Threads": threadsRoute(threads),
    "pr view 5 -R o/r --json headRefOid,updatedAt": { stdout: { headRefOid: head, updatedAt: "2026-11-11T00:00:00Z" } },
    "pr checks 5 -R o/r --json name,state,link,bucket,startedAt": { stderr: "no checks reported on the 'feat' branch", exit: 1 },
    "graphql PendingReview": { stdout: { data: { repository: { pullRequest: { reviews: { nodes: pending ? [pending] : [] } } } } } },
    "graphql PostReview": postExit ? { stderr: "boom", exit: postExit } : { stdout: { data: { addPullRequestReview: { pullRequestReview: { url: "https://github.com/o/r/pull/5#pullrequestreview-1" } } } } },
    "api -X POST repos/o/r/pulls/5/comments/11/replies --input -": { stdout: {} },
    "api -X PATCH repos/o/r/pulls/comments/12 --input -": { stdout: {} },
    "api -X PATCH repos/o/r/pulls/comments/13 --input -": { stdout: {} },
    "graphql ResolveThread": { stdout: { data: { resolveReviewThread: { thread: { id: "T1", isResolved: true } } } } },
  };
  writeFileSync(join(fx.stubDir, "routes.json"), JSON.stringify(r));
}

const mutations = (fx) => (existsSync(join(fx.stubDir, "mutations.jsonl")) ? readFileSync(join(fx.stubDir, "mutations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
const posts = (fx) => mutations(fx).filter((m) => m.key === "graphql PostReview").map((m) => m.input.variables.input);

const F = (over = {}) => ({ lens: "correctness", severity: "must", file: "a.js", line: 2, title: "Off by one", case: "b = 3 -> wrong total", evidence: "trace", fix: "use 2", ...over });
const C = (id, over = {}) => ({ ...F(), id, found: [S0, S1], ...over });
const keep = (id) => ({ id, vote: "keep", counter_case: "" });
const drop = (id) => ({ id, vote: "drop", counter_case: "the guard at a.js:1 stops it" });

// Answers by child file name (all~0, merge, v~2, compose); "all" answers every round-1 child. A function answer gets the options.
function fakeRun(answers) {
  const calls = [];
  const run = async (o) => {
    const k = basename(o.outFile, ".json");
    calls.push({ k, ...o, prompt: readFileSync(o.promptFile, "utf8") });
    let a = answers[k] ?? answers[k.split("~")[0]];
    if (typeof a === "function") a = await a(o);
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error(`fakeRun: no answer for ${k}`);
    return structuredClone(a);
  };
  run.calls = calls;
  return run;
}

const happy = (over = {}) => ({
  all: { findings: [F()] }, merge: [C("c1")], "v~2": [keep("c1")],
  compose: { body: "Changes a. One must item.", comments: [{ id: "c1", body: "**must:** off by one" }] }, ...over,
});

async function go(fx, answers, over = {}) {
  const run = fakeRun(answers);
  const decide = over.decide ?? (async () => ({ decision: "unsure", raw: null }));
  const r = await review({ repo: REPO, n: N, repoDir: fx.repoDir, runChild: run, decide, routerUp: true, ...over });
  return { r, run };
}

test("happy path posts one review with inline comments and the marker", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx);
  assert.equal(p.length, 1);
  assert.equal(p[0].commitOID, fx.head);
  assert.equal(p[0].event, "REQUEST_CHANGES");
  assert.match(p[0].body, /^What was checked: light depth, no checks run\.\n\nChanges a\. One must item\.\n\n<!-- pr-review run=\S+ sha=[0-9a-f]{40} key=[0-9a-f]{40} -->$/);
  assert.equal(p[0].threads.length, 1);
  assert.deepEqual([p[0].threads[0].path, p[0].threads[0].line, p[0].threads[0].side], ["a.js", 2, "RIGHT"]);
  assert.match(p[0].threads[0].body, new RegExp(`^\\*\\*must:\\*\\* off by one\n\n<!-- pr-review run=.* key=[0-9a-f]{40} fp=${fingerprint(F())} -->$`));
  // round 2 only for the seat that did not find c1
  assert.deepEqual(run.calls.map((c) => c.k).sort(), ["all~0", "all~1", "all~2", "compose", "merge", "v~2"]);
  const st = prState(fx.state, N);
  assert.equal(st.reviews, 1);
  assert.equal(st.lastReviewedSha, fx.head);
  assert.ok(st.settled.includes(fingerprint(F())));
  assert.equal(existsSync(join(r.runDir, "post.done")), true);
});

test("rerun after a crash before markDone(post) does not post again", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy());
  rmSync(join(r.runDir, "post.done"));
  routes(fx, { reviews: [{ body: posts(fx)[0].body, user: { login: ME }, state: "COMMENTED" }] });
  const again = await go(fx, happy());
  assert.equal(again.r.exit, 0);
  assert.equal(again.r.runDir, r.runDir, "same unfinished run");
  assert.equal(posts(fx).length, 1);
  assert.equal(again.run.calls.length, 0, "every child has its marker");
  assert.equal(prState(fx.state, N).reviews, 1, "the review is counted once");
});

test("rerun after an interrupted post: marker found on GitHub, nothing posted twice", async () => {
  const fx = fixture(); routes(fx, { postExit: 1 });
  await assert.rejects(go(fx, happy()), /exited 1/);
  const sent = posts(fx);
  assert.equal(sent.length, 1, "the mutation reached GitHub");
  // GitHub applied it although the client saw an error.
  routes(fx, { reviews: [{ body: sent[0].body, user: { login: ME }, state: "COMMENTED" }] });
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0);
  assert.equal(posts(fx).length, 1);
  assert.equal(prState(fx.state, N).reviews, 1);
});

test("head moved before post -> re-frame, no post for the old sha", async () => {
  const fx = fixture(); routes(fx);
  let moved = null;
  const compose = async () => {
    if (!moved) {
      git(fx.seed, "checkout", "-q", "feat");
      moved = commit(fx.seed, { "a.js": "const a = 2;\nconst b = 3;\nconst c = 4;\nconst d = 6;\n" }, "fix: d");
      git(fx.seed, "push", "-qf", fx.origin, "HEAD:refs/pull/5/head");
      routes(fx, { head: moved });
    }
    return happy().compose;
  };
  const { r } = await go(fx, happy({ compose }));
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx);
  assert.deepEqual(p.map((x) => x.commitOID), [moved]);
  const runs = readdirSync(join(fx.state, "pr", "5", "runs"));
  assert.equal(runs.length, 2);
  assert.ok(runs.some((d) => d.startsWith(fx.head)), "old run folder kept");
});

const split = (over = {}) => happy({ merge: [C("c1", { found: [S0] })], "v~1": [keep("c1")], "v~2": [drop("c1")], ...over });

test("split + jev unsure + interactive -> exit 3 and a question file", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, split());
  assert.equal(r.exit, 3);
  assert.equal(r.questions.length, 1);
  const md = readFileSync(r.questions[0], "utf8");
  assert.match(md, /Off by one/);
  assert.match(md, /the guard at a\.js:1 stops it/);
  assert.equal(posts(fx).length, 0);
  assert.equal(openQuestions(fx.state).length, 1);
});

test("answer post then rerun -> finding posted, exit 0", async () => {
  const fx = fixture(); routes(fx);
  const first = await go(fx, split());
  const id = basename(first.r.questions[0], ".md");
  answer(fx.state, id, "post");
  let asked = 0;
  const { r, run } = await go(fx, split(), { decide: async () => { asked++; return { decision: "unsure" }; } });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(asked, 0, "the answer settles it; jev is not asked again");
  assert.deepEqual(run.calls.map((c) => c.k), ["compose"]);
  assert.equal(posts(fx)[0].threads.length, 1);
  assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${id}.json`), "utf8")).appliedAt);
});

test("split + jev missing + loop -> question queued, review posted without it, event COMMENT", async () => {
  const fx = fixture(); routes(fx);
  const nit = C("c2", { severity: "nit", line: 3, title: "Name is vague" });
  const answers = split({
    merge: [C("c1", { found: [S0] }), nit], "v~1": [keep("c1")], "v~2": [drop("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c2", body: "**nit:** name" }] },
  });
  // The real decider with no jev on PATH and none next to the skill.
  const decide = (c, v, h, cfg) => realDecide(c, v, h, cfg, { env: { PATH: "/nonexistent" } });
  const { r, run } = await go(fx, answers, { mode: "loop", effort: "medium", decide });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(openQuestions(fx.state).length, 1);
  const p = posts(fx);
  assert.equal(p[0].event, "COMMENT");
  assert.deepEqual(p[0].threads.map((t) => t.line), [3]);
  assert.match(p[0].body, /1 point is still open with the reviewer\./);
  assert.ok(run.calls.find((c) => c.k === "compose"));
});

test("secret in a finding -> that post blocked, question queued", async () => {
  const fx = fixture(); routes(fx);
  const token = "ghp_" + "A".repeat(36);
  const { r } = await go(fx, happy({ compose: { body: "Summary.", comments: [{ id: "c1", body: `**must:** token ${token} leaks` }] } }));
  assert.equal(r.exit, 3, "interactive: the held comment is an open question");
  assert.equal(r.questions.length, 1);
  // a rerun before the answer posts nothing more
  const before = await go(fx, happy());
  assert.equal(before.r.exit, 0, before.r.summary);
  assert.equal(posts(fx).length, 1);
  const p = posts(fx);
  assert.equal(p[0].threads.length, 0);
  assert.ok(!JSON.stringify(mutations(fx)).includes(token));
  const q = openQuestions(fx.state);
  assert.equal(q.length, 1);
  assert.equal(q[0].fingerprint, fingerprint(F()));
  assert.match(q[0].finding.case, /^Secret rules: .*github-token/);
  assert.ok(!JSON.stringify(q).includes("leaks"), "no comment text in the question");
  assert.ok(!readFileSync(join(fx.state, "questions", `${q[0].id}.md`), "utf8").includes("leaks"));
  assert.match(p[0].body, /1 point is still open with the reviewer\./);
  // answer post -> the comment is composed again and posted with the secret redacted
  answer(fx.state, q[0].id, "post");
  const again = await go(fx, happy({ compose: { body: "Summary.", comments: [{ id: "c1", body: `**must:** token ${token} leaks` }] } }));
  assert.equal(again.r.exit, 0, again.r.summary);
  const t = posts(fx)[1].threads;
  assert.equal(t.length, 1);
  assert.match(t[0].body, /\[REDACTED:github-token\] leaks/);
  assert.ok(!JSON.stringify(mutations(fx)).includes(token));
});

test("own pending review not owned by the run -> skip", async () => {
  const fx = fixture(); routes(fx, { pending: { id: "PRR_1" } });
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0);
  assert.equal(r.skipped, true);
  assert.equal(posts(fx).length, 0);
  assert.equal(existsSync(join(fx.state, "queue.jsonl")), false, "nothing reads a note file");
  assert.equal(existsSync(join(r.runDir, "post.done")), false, "the run stays open for a later post");
});

test("earlier threads fixed -> 'Fixed in <sha>.' reply + resolve", async () => {
  const fx = fixture();
  routes(fx, { threads: [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { nodes: [{ databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" }] } }] });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const earlier = [{ thread_id: "T1", status: "fixed", evidence: "a.js:1 is 2 now" }];
  const { r, run } = await go(fx, { all: { findings: [], earlier }, compose: { body: "Looks good.", comments: [] } });
  assert.equal(r.exit, 0, r.summary);
  assert.ok(!run.calls.some((c) => c.k === "merge"), "no findings: no merge child");
  assert.equal(posts(fx)[0].event, "APPROVE");
  const m = mutations(fx);
  const rep = m.find((x) => x.key.includes("comments/11/replies"));
  assert.match(rep.input.body, new RegExp(`^Fixed in \\[\`${fx.head.slice(0, 7)}\`\\]\\(https://github\\.com/o/r/commit/${fx.head}\\)\\.\\n\\n<!-- pr-review `));
  assert.ok(m.some((x) => x.key === "graphql ResolveThread"));
  assert.deepEqual(prState(fx.state, N).resolved, ["T1"]);
});

test("a fixed thread whose newest comment is ours: that comment gets the link, no second reply", async () => {
  const fx = fixture();
  routes(fx, { threads: [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { nodes: [
      { databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" },
      { databaseId: 12, author: { login: ME, __typename: "User" }, body: "Fixed: a is 2 now.", createdAt: "y" },
    ] } }] });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const { r } = await go(fx, { all: { findings: [], earlier: [{ thread_id: "T1", status: "fixed", evidence: "a.js:1" }] }, compose: { body: "Looks good.", comments: [] } });
  assert.equal(r.exit, 0, r.summary);
  const m = mutations(fx);
  assert.ok(!m.some((x) => x.key.includes("/replies")), "no second reply");
  const ed = m.find((x) => x.key.startsWith("api -X PATCH repos/o/r/pulls/comments/12"));
  // the amend keeps the marker, so a rerun finds it on fully paged comments
  assert.match(ed.input.body, new RegExp(`^Fixed: a is 2 now\\.\\n\\nFixed in \\[\`${fx.head.slice(0, 7)}\`\\]\\(https://github\\.com/o/r/commit/${fx.head}\\)\\.\\n\\n<!-- pr-review run=\\S+ sha=${fx.head} key=[0-9a-f]{40} -->$`));
  assert.ok(m.some((x) => x.key === "graphql ResolveThread"));
  assert.deepEqual(prState(fx.state, N).resolved, ["T1"]);
});

test("a fixed thread reads the live thread: our reply posted after the frame is amended, not doubled", async () => {
  const fx = fixture();
  const th = (extra) => [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { nodes: [
      { databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" },
      { databaseId: 12, author: { login: "bob", __typename: "User" }, body: "fixed", createdAt: "y" },
      ...extra,
    ] } }];
  routes(fx, { threads: th([]) });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const res = { all: { findings: [], earlier: [{ thread_id: "T1", status: "fixed", evidence: "a.js:1" }] }, compose: { body: "Looks good.", comments: [] } };
  const { r: r0 } = await go(fx, res, { until: "frame" });
  rmSync(join(r0.runDir, "post.done")); // the same run goes on, with its frame-time threads.json
  // the loop answers bob between frame and post
  routes(fx, { threads: th([{ databaseId: 13, author: { login: ME, __typename: "User" }, body: "Thanks, checked.", createdAt: "z" }]) });
  const { r } = await go(fx, res);
  assert.equal(r.exit, 0, r.summary);
  assert.equal(r.runDir, r0.runDir);
  const m = mutations(fx);
  assert.ok(!m.some((x) => x.key.includes("/replies")), "no second reply");
  assert.ok(m.some((x) => x.key.startsWith("api -X PATCH repos/o/r/pulls/comments/13")));
});

test("a fixed thread longer than one page gets a reply: its newest comment is unknown", async () => {
  const fx = fixture();
  routes(fx, { threads: [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { totalCount: 150, nodes: [
      { databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" },
      { databaseId: 12, author: { login: ME, __typename: "User" }, body: "Fixed: a is 2 now.", createdAt: "y" },
    ] } }] });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const { r } = await go(fx, { all: { findings: [], earlier: [{ thread_id: "T1", status: "fixed", evidence: "a.js:1" }] }, compose: { body: "Looks good.", comments: [] } });
  assert.equal(r.exit, 0, r.summary);
  const m = mutations(fx);
  assert.ok(!m.some((x) => x.key.includes("PATCH")), "no edit of a comment in the middle");
  assert.ok(m.some((x) => x.key.includes("comments/11/replies")));
});

test("\"No new findings.\" is dropped when a finding posts", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy({ compose: { body: "No new findings.", comments: [{ id: "c1", body: "**must:** off by one" }] } }));
  assert.equal(r.exit, 0, r.summary);
  assert.doesNotMatch(posts(fx)[0].body, /No new findings/);
});

test("an earlier must still open blocks approve", async () => {
  const fx = fixture();
  routes(fx, { threads: [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { nodes: [{ databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" }] } }] });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const { r } = await go(fx, { all: { findings: [], earlier: [{ thread_id: "T1", status: "open", evidence: "x" }] }, compose: { body: "Still open.", comments: [] } });
  assert.equal(r.exit, 0);
  assert.equal(posts(fx)[0].event, "REQUEST_CHANGES");
  assert.ok(!mutations(fx).some((x) => x.key.includes("replies")));
});

test("--dry-run posts nothing and prints the planned child count", async () => {
  const fx = fixture(); routes(fx);
  const lines = [];
  const { r } = await go(fx, happy(), { dryRun: true, log: (l) => lines.push(l) });
  assert.equal(r.exit, 0);
  assert.equal(mutations(fx).length, 0);
  assert.match(lines[0], /effort medium: 8 children planned/); // 3 round 1 + 3 votes + 2 judge
  assert.equal(r.planned, 8);
  assert.match(readFileSync(r.file, "utf8"), /event: REQUEST_CHANGES[\s\S]*a\.js:2\n\*\*must:\*\* off by one/);
  assert.equal(existsSync(join(r.runDir, "post.done")), true, "a dry run is finished: the next run starts fresh");
  const next = await go(fx, happy(), { until: "frame" });
  assert.notEqual(next.r.runDir, r.runDir);
});

test("--until stops after the stage and finishes the run", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy(), { until: "round1" });
  assert.equal(r.exit, 0);
  assert.deepEqual(run.calls.map((c) => c.k).sort(), ["all~0", "all~1", "all~2"]);
  assert.equal(existsSync(join(r.runDir, "post.done")), true);
});

test("--effort low posts at most 5 findings, no nits, and says how many were left out", async () => {
  const fx = fixture(); routes(fx);
  const sev = ["must", "must", "should", "should", "should", "should", "should", "nit", "nit"];
  const clusters = sev.map((s, i) => C(`c${i + 1}`, { severity: s, title: `finding ${"abcdefghi"[i]}`, line: 1 + (i % 4) }));
  const compose = { body: "Summary.", comments: clusters.map((c) => ({ id: c.id, body: `**${c.severity}:** ${c.title}` })) };
  const { r, run } = await go(fx, { all: { findings: [F()] }, merge: clusters, compose }, { effort: "low" });
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(run.calls.map((c) => c.k).filter((k) => k.startsWith("all")).sort(), ["all~0", "all~1"], "2 seats");
  const p = posts(fx)[0];
  assert.equal(p.threads.length, 5);
  assert.ok(p.threads.every((t) => !t.body.startsWith("**nit:**")));
  assert.equal(p.threads.filter((t) => t.body.startsWith("**must:**")).length, 2);
  assert.match(p.body, /4 findings were left out by the effort limit\./);
});

test("hygiene findings appear as one list in the summary, not as inline comments", async () => {
  const fx = fixture(); routes(fx, { body: "" });
  const compose = { body: "Summary.\n\nHygiene:\n- PR body is empty", comments: [{ id: "c1", body: "**must:** off by one" }, { id: "h1", body: "should not be inline" }] };
  const { r, run } = await go(fx, happy({ compose }));
  assert.equal(r.exit, 0, r.summary);
  const prompt = run.calls.find((c) => c.k === "compose").prompt;
  assert.match(prompt, /"lens": "hygiene"/);
  assert.match(prompt, /PR body is empty/);
  const p = posts(fx)[0];
  assert.equal(p.threads.length, 1);
  assert.ok(!p.threads.some((t) => /should not be inline/.test(t.body)));
});

test("a failed lens after retries -> exit 4, nothing posted", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy({ "all~1": new ChildFailed("fake:x failed after 3 attempts") }));
  assert.equal(r.exit, 4);
  assert.match(r.summary, /failed after 3 attempts/);
  assert.equal(mutations(fx).length, 0);
  assert.ok(!run.calls.some((c) => c.k === "merge"));
});

test("--restart starts a new run folder", async () => {
  const fx = fixture(); routes(fx);
  const { r: a } = await go(fx, happy({ "all~1": new ChildFailed("x") }));
  const { r: b } = await go(fx, happy({ "all~1": new ChildFailed("x") }));
  const { r: c } = await go(fx, happy({ "all~1": new ChildFailed("x") }), { restart: true });
  const runs = readdirSync(join(fx.state, "pr", "5", "runs"));
  assert.equal(runs.length, 2);
  assert.equal(a.exit, 4);
  assert.ok(b.summary && c.summary);
});

test("merge clusters with reverses are dropped and recorded; no_tracking adds the engine line", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy({
    all: { findings: [F()], no_tracking: true },
    merge: [C("c1"), C("c2", { title: "Add the check back", reverses: "abc" })],
  }));
  assert.equal(r.exit, 0, r.summary);
  const rec = JSON.parse(readFileSync(join(r.runDir, "clusters.json"), "utf8"));
  assert.deepEqual(rec.reversed.map((c) => c.id), ["c2"]);
  assert.ok(!run.calls.find((c) => c.k === "v~2").prompt.includes("Add the check back"));
  assert.doesNotMatch(run.calls.find((c) => c.k === "compose").prompt, /No tracking issue or plan\./);
  assert.match(posts(fx)[0].body, /\n\nNo tracking issue or plan\.\n\n/);
});

test("ask_author: set for a one-seat finding and a jev-settled split, not for an agreed one", async () => {
  const fx = fixture(); routes(fx);
  const answers = happy({
    merge: [C("c1"), C("c2", { found: [S0], line: 3, title: "one seat" }), C("c3", { found: [S0], line: 4, title: "jev settled" })],
    "v~1": [keep("c2"), keep("c3")], "v~2": [keep("c2"), drop("c3")],
  });
  const { run } = await go(fx, answers, { decide: async () => ({ decision: "agreed", raw: { verdict: "yes" } }) });
  const json = /SEAT-DATA-\w+\n([\s\S]*?)\nSEAT-DATA/.exec(run.calls.find((c) => c.k === "compose").prompt)[1];
  const flags = Object.fromEntries(JSON.parse(json).map((c) => [c.id, c.ask_author]));
  assert.deepEqual(flags, { c1: false, c2: true, c3: true });
});

test("a stale CI sha means CI is unknown: no APPROVE", async () => {
  const fx = fixture(); routes(fx);
  const r0 = JSON.parse(readFileSync(join(fx.stubDir, "routes.json"), "utf8"));
  r0["pr view 5 -R o/r --json headRefOid,updatedAt"] = { stdout: { headRefOid: "f".repeat(40), updatedAt: "x" } };
  writeFileSync(join(fx.stubDir, "routes.json"), JSON.stringify(r0));
  const { r } = await go(fx, { all: { findings: [] }, compose: { body: "Fine.", comments: [] } });
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx)[0];
  assert.equal(p.event, "COMMENT");
  assert.match(p.body, /CI state of this commit is unknown/);
});

test("SIGTERM during round 1, then rerun: finished children are not started again", async () => {
  const fx = fixture(); routes(fx);
  const fake = join(fx.root, "fake");
  mkdirSync(fake);
  for (const k of ["all~0", "all~1"]) writeFileSync(join(fake, `${k}.json`), '{"findings": []}');
  writeFileSync(join(fake, "all~1.json.hang"), "");
  const env = { ...process.env, PR_REVIEW_FAKE: fake };
  const cli = (args) => spawn(process.execPath, [join(here, "..", "main.mjs"), "review", "5", "--repo", REPO, "--effort", "low", ...args], { cwd: fx.repoDir, env, stdio: "ignore" });
  const starts = () => (existsSync(join(fake, "starts.log")) ? readFileSync(join(fake, "starts.log"), "utf8").trim().split("\n") : []);
  const p = cli([]);
  const closed = new Promise((res) => p.on("close", (code) => res(code)));
  const runs = join(fx.state, "pr", "5", "runs");
  const doneMarker = () => existsSync(runs) && readdirSync(runs).some((d) => existsSync(join(runs, d, "round1", "all~0.done")));
  for (let i = 0; i < 200 && !(starts().length === 2 && doneMarker()); i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(starts().sort(), ["all~0.json", "all~1.json"]);
  p.kill("SIGTERM");
  assert.equal(await closed, 143);
  assert.equal(existsSync(join(fx.state, "pr", "5", "lock")), false, "lock released");
  rmSync(join(fake, "all~1.json.hang"));
  const q = cli(["--until", "round1"]);
  assert.equal(await new Promise((res) => q.on("close", res)), 0);
  assert.deepEqual(starts().sort(), ["all~0.json", "all~1.json", "all~1.json"], "all~0 ran once");
});

test("reviews of two PRs run at the same time in two processes; a second run of the same PR gets Locked", async () => {
  const fx = fixture(); routes(fx);
  // Another process reviews PR 6 and is stuck in its frame: it holds PR 6's lock.
  const other = spawn(process.execPath, ["--input-type=module", "-e", `const { review } = await import(${JSON.stringify(join(here, "..", "lib", "review.mjs"))});
    setInterval(() => {}, 1000);
    await review({ repo: "o/r", n: 6, gh: { pr: async () => ({ headSha: "f".repeat(40) }) }, frame: async () => { console.log("HELD"); await new Promise(() => {}); } });`],
  { cwd: fx.repoDir, env: process.env, stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((res) => other.stdout.once("data", res));
    const { r } = await go(fx, happy());
    assert.equal(r.exit, 0, r.summary);
    assert.equal(posts(fx).length, 1);
    await assert.rejects(go(fx, happy(), { n: 6 }), { name: "Locked", message: `another pr-review run holds the lock of PR #6 (pid ${other.pid})` });
  } finally { other.kill(); }
});

test("a stale PR lock (dead pid) is taken over and released", async () => {
  const fx = fixture(); routes(fx);
  const lock = join(fx.state, "pr", "5", "lock");
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "pid"), String(spawnSync("true").pid));
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.equal(existsSync(lock), false);
});

const R = (fx) => JSON.parse(readFileSync(join(fx.stubDir, "routes.json"), "utf8"));
const W = (fx, r) => writeFileSync(join(fx.stubDir, "routes.json"), JSON.stringify(r));
const composePromptOf = (run) => run.calls.find((c) => c.k === "compose").prompt;

test("same sha after a finished review -> 'already reviewed', nothing posted; loop too; --restart reviews again", async () => {
  const fx = fixture(); routes(fx);
  await go(fx, happy());
  for (const mode of ["interactive", "loop"]) {
    const { r, run } = await go(fx, happy(), { mode, effort: "medium" });
    assert.equal(r.exit, 0);
    assert.match(r.summary, new RegExp(`already reviewed ${fx.head}`));
    assert.equal(run.calls.length, 0);
  }
  assert.equal(posts(fx).length, 1);
  const { r } = await go(fx, happy(), { restart: true });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(posts(fx).length, 2);
});

test("a --lens subset never approves: missing lenses count as failed", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, { all: { findings: [] }, compose: { body: "Fine.", comments: [] } }, { lenses: ["security"] });
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx)[0];
  assert.equal(p.event, "COMMENT");
  assert.ok(r.reasons.includes("failed lenses"));
  assert.match(p.body, /Lenses not run: adversarial, correctness, simplification, architecture\./);
});

test("hygiene findings obey the severity floor and the settled list", async () => {
  const fx = fixture(); routes(fx, { body: "" });
  const empty = { lens: "hygiene", severity: "should", title: "PR body is empty", file: "", line: null };
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base, settled: [fingerprint(empty)] });
  const { run } = await go(fx, happy());
  assert.ok(!composePromptOf(run).includes("PR body is empty"), "settled");
  const fx2 = fixture(); routes(fx2, { body: "" });
  savePrState(fx2.state, N, { ...prState(fx2.state, N), reviews: 2, lastReviewedSha: fx2.base });
  const b = await go(fx2, happy());
  assert.ok(!composePromptOf(b.run).includes("PR body is empty"), "review 3 posts only must");
});

test("a signal during decide saves nothing: no decide file, no question; the rerun asks jev again", async () => {
  const fx = fixture(); routes(fx);
  let stop = false, asked = 0;
  const decide = async () => { asked++; stop = true; return { decision: "unsure", raw: null }; };
  const { r } = await go(fx, split(), { decide, stopping: () => stop });
  assert.equal(r.exit, 4);
  const runs = join(fx.state, "pr", "5", "runs");
  assert.ok(readdirSync(runs).every((d) => !existsSync(join(runs, d, "decide"))));
  assert.equal(openQuestions(fx.state).length, 0);
  stop = false;
  const again = await go(fx, split(), { decide: async () => { asked++; return { decision: "unsure" }; } });
  assert.equal(again.r.exit, 3);
  assert.equal(asked, 2);
});

const thread = (id, author, body, over = {}) => ({ id, isResolved: true, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 2, originalLine: 2,
  comments: { nodes: [{ databaseId: 11, author: { login: author, __typename: "User" }, body, createdAt: "x" }] }, ...over });

test("thread linking: only our own thread with an engine marker of an agreed finding drops a cluster", async () => {
  // A first review posts c1; its real inline comment (engine marker with fp=) becomes the thread.
  const fx0 = fixture(); routes(fx0);
  await go(fx0, happy());
  const real = posts(fx0)[0].threads[0].body;
  assert.match(real, /key=[0-9a-f]{40} fp=[0-9a-f]{40} -->$/);
  const state0 = prState(fx0.state, N);
  for (const [threads, kept] of [
    [[thread("T1", "bob", real)], true],
    [[thread("T1", ME, real, { isOutdated: true, line: null })], true],
    [[thread("T1", ME, real)], false],
  ]) {
    const fx = fixture(); routes(fx, { threads });
    savePrState(fx.state, N, { ...prState(fx.state, N), agreed: state0.agreed });
    // same line, other words: only the marker's fp can link it
    const { r } = await go(fx, happy({ merge: [C("c1", { title: "Other words for it" })] }));
    const rec = JSON.parse(readFileSync(join(r.runDir, "clusters.json"), "utf8"));
    assert.equal(rec.clusters.length === 1, kept, threads[0].comments.nodes[0].author.login);
    assert.equal(rec.linked.length === 1, !kept);
  }
  // our agreed thread on the same line does not swallow a finding of another lens
  const fx = fixture(); routes(fx, { threads: [thread("T1", ME, real)] });
  savePrState(fx.state, N, { ...prState(fx.state, N), agreed: state0.agreed });
  const { r } = await go(fx, happy({ merge: [C("c1", { lens: "security", title: "Token is logged" })] }));
  const rec = JSON.parse(readFileSync(join(r.runDir, "clusters.json"), "utf8"));
  assert.deepEqual([rec.clusters.length, rec.linked.length], [1, 0]);
});

test("check names in the summary lose markup, mentions and marker look-alikes", async () => {
  const fx = fixture(); routes(fx);
  const r0 = R(fx);
  const name = "build <!-- pr-review run=x sha=y key=" + "b".repeat(40) + " --> @alice `x`" + " pad".repeat(40);
  r0["pr checks 5 -R o/r --json name,state,link,bucket,startedAt"] = { stdout: [{ name, state: "FAILURE", link: "https://github.com/o/r/actions/runs/9/job/1", bucket: "fail", startedAt: "2026-11-11T00:00:00Z" }], exit: 1 };
  r0["run view 9 -R o/r --log-failed"] = { stdout: "boom" };
  W(fx, r0);
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  const body = posts(fx)[0].body;
  const line = body.split("\n").find((l) => l.startsWith("Failed checks:"));
  assert.ok(line, body);
  assert.doesNotMatch(line, /[<>@`]/);
  assert.ok(line.length <= "Failed checks: ".length + 81);
  assert.equal(body.match(/<!-- pr-review/g).length, 1, "only the engine marker");
});

test("a secret in the summary: compose again on the rerun; after 2 tries a question, then no compose", async () => {
  const fx = fixture(); routes(fx);
  const token = "ghp_" + "B".repeat(36);
  const answers = happy({ compose: { body: `Summary ${token}`, comments: [{ id: "c1", body: "**must:** x" }] } });
  const a = await go(fx, answers);
  assert.equal(a.r.exit, 4);
  assert.equal(existsSync(join(a.r.runDir, "compose", "compose.json")), false);
  const b = await go(fx, answers);
  assert.equal(b.r.exit, 4);
  assert.deepEqual(b.run.calls.map((c) => c.k), ["compose"], "composed again without --restart");
  const q = openQuestions(fx.state);
  assert.equal(q.length, 1);
  assert.equal(q[0].finding.kind, "summary-secret");
  assert.ok(!JSON.stringify(q).includes(token));
  const c = await go(fx, answers);
  assert.equal(c.r.exit, 4);
  assert.equal(c.run.calls.length, 0);
  assert.equal(posts(fx).length, 0);
});

test("a 'post' answer is posted even when the effort would filter it out", async () => {
  const fx = fixture(); routes(fx);
  const nit = split({ merge: [C("c1", { found: [S0], severity: "nit" })], "v~1": [keep("c1")], "v~2": undefined,
    compose: { body: "Summary.", comments: [{ id: "c1", body: "**nit:** off by one" }] } });
  delete nit["v~2"];
  // effort low: 2 seats; S1 keeps, nobody else votes -> 1 find + 1 keep = agreed? no: make S1 drop
  nit["v~1"] = [drop("c1")];
  const first = await go(fx, nit, { effort: "low" });
  assert.equal(first.r.exit, 3, first.r.summary);
  answer(fx.state, basename(first.r.questions[0], ".md"), "post");
  const { r } = await go(fx, nit, { effort: "low" });
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(posts(fx)[0].threads.map((t) => t.body.split("\n")[0]), ["**nit:** off by one"]);
});

test("loop rerun after a crash with the marker found queues 'approve?' once", async () => {
  const fx = fixture(); routes(fx);
  const answers = { all: { findings: [] }, compose: { body: "Fine.", comments: [] } };
  const a = await go(fx, answers, { mode: "loop", effort: "medium" });
  assert.equal(a.r.queueApprove, true);
  rmSync(join(a.r.runDir, "post.done"));
  routes(fx, { reviews: [{ body: posts(fx)[0].body, user: { login: ME }, state: "COMMENTED" }] });
  const b = await go(fx, answers, { mode: "loop", effort: "medium" });
  assert.equal(b.r.exit, 0, b.r.summary);
  assert.equal(posts(fx).length, 1);
  assert.equal(openQuestions(fx.state).filter((q) => q.finding.kind === "approve").length, 1);
});

test("a symlink in the worktree to a file outside it gives jev no snippet", async () => {
  const fx = fixture(); routes(fx);
  const outside = join(fx.root, "outside.txt");
  writeFileSync(outside, "TOP-SECRET-OUTSIDE\n".repeat(20));
  let snippet = null;
  const all = async (o) => { try { (await import("node:fs")).symlinkSync(outside, join(o.worktree, "link.js")); } catch {} return { findings: [F({ file: "link.js" })] }; };
  await go(fx, split({ all, merge: [C("c1", { found: [S0], file: "link.js" })] }), { decide: async (c, v, h) => { snippet = h; return { decision: "unsure" }; } });
  assert.equal(snippet, "");
  assert.ok(!readdirSync(join(fx.state, "questions")).map((f) => readFileSync(join(fx.state, "questions", f), "utf8")).join("").includes("TOP-SECRET"));
});

test("a finding whose inline marker is already on GitHub is not posted again", async () => {
  const fx = fixture();
  const { createHash } = await import("node:crypto");
  const key = createHash("sha1").update(`inline\0${fx.head}\0${fingerprint(F())}`).digest("hex");
  // one review comment among many (past the old 100-per-review window)
  const many = Array.from({ length: 150 }, (_, i) => ({ body: `c${i}`, user: { login: ME } }));
  routes(fx, { reviewComments: [...many, { body: `x <!-- pr-review run=r sha=s key=${key} fp=${fingerprint(F())} -->`, user: { login: ME } }] });
  const second = C("c2", { line: 3, title: "Second" });
  const { r } = await go(fx, happy({ merge: [C("c1"), second], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "S.", comments: [{ id: "c1", body: "**must:** one" }, { id: "c2", body: "**must:** two" }] } }));
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(posts(fx)[0].threads.map((t) => t.line), [3]);
});

test("CLI: no number uses the current branch's PR; none is a usage error; an unexpected error exits 4", async () => {
  const fx = fixture(); routes(fx);
  const cli = (args) => new Promise((res) => {
    const p = spawn(process.execPath, [join(here, "..", "main.mjs"), "review", ...args], { cwd: fx.repoDir, env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => res({ code, err }));
  });
  const r0 = R(fx);
  r0["pr view --json number"] = { stdout: { number: 5 } };
  W(fx, r0);
  assert.equal((await cli(["--repo", REPO, "--until", "frame"])).code, 0);
  r0["pr view --json number"] = { stderr: 'no pull requests found for branch "feat"', exit: 1 }; W(fx, r0);
  const none = await cli(["--repo", REPO]);
  assert.equal(none.code, 1);
  assert.match(none.err, /current branch has no PR/);
  r0["pr view --json number"] = { stderr: "HTTP 401: Bad credentials", exit: 1 }; W(fx, r0);
  assert.equal((await cli(["--repo", REPO])).code, 4, "auth or network failure is not a usage error");
  W(fx, {}); // gh fails on the first call: not a usage error
  assert.equal((await cli(["5", "--repo", REPO])).code, 4);
});

test("answer-only rerun, repro a: a held must answered drop -> nothing posted, no second summary", async () => {
  const fx = fixture(); routes(fx);
  const token = "ghp_" + "C".repeat(36);
  const { r } = await go(fx, happy({ compose: { body: "Summary.", comments: [{ id: "c1", body: `**must:** ${token}` }] } }));
  assert.equal(r.exit, 3, r.summary);
  const q = openQuestions(fx.state);
  assert.equal(q.length, 1);
  answer(fx.state, q[0].id, "drop");
  const again = await go(fx, happy());
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.equal(again.run.calls.length, 0, "no pipeline");
  assert.equal(posts(fx).length, 1);
  assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${q[0].id}.json`), "utf8")).appliedAt);
});

test("answer-only rerun, repro b: loop posts with a should and a question; both answered drop -> interactive rerun posts nothing", async () => {
  const fx = fixture(); routes(fx);
  const answers = split({
    merge: [C("c1", { found: [S0] }), C("c2", { severity: "should", line: 3, title: "Slow loop" })], "v~1": [keep("c1")], "v~2": [drop("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c2", body: "**should:** slow" }] },
  });
  await go(fx, answers, { mode: "loop", effort: "medium" });
  assert.equal(posts(fx).length, 1);
  for (const q of openQuestions(fx.state)) answer(fx.state, q.id, "drop");
  const again = await go(fx, answers);
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.equal(again.run.calls.length, 0);
  assert.deepEqual(posts(fx).map((p) => p.event), ["COMMENT"]);
});

test("answer-only rerun: 'post' goes out as one small COMMENT follow-up, never twice", async () => {
  const fx = fixture(); routes(fx);
  const answers = split({
    merge: [C("c1", { found: [S0] }), C("c2", { severity: "must", line: 3, title: "Must one" })], "v~1": [keep("c1")], "v~2": [drop("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c2", body: "**must:** one" }] },
  });
  await go(fx, answers, { mode: "loop", effort: "medium" });
  assert.equal(posts(fx)[0].event, "REQUEST_CHANGES");
  const [q] = openQuestions(fx.state);
  answer(fx.state, q.id, "post");
  const again = await go(fx, answers);
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.equal(again.run.calls.length, 0);
  const p = posts(fx);
  assert.equal(p.length, 2);
  assert.equal(p[1].event, "COMMENT");
  assert.match(p[1].body, new RegExp(`^Follow-up on the review of ${fx.head}: points settled by the maintainer\\.\\n\\n<!-- pr-review `));
  assert.deepEqual(p[1].threads.map((t) => [t.line, t.body.split("\n")[0]]), [[2, "**must:** Off by one"]]);
  // the posted finding joins agreed with its lens, so a reworded repeat on that line still links
  const ag = prState(fx.state, N).agreed.find((a) => a.id === q.fingerprint);
  assert.equal(ag?.lens, "correctness");
  // crash before appliedAnswer: the marker is on GitHub, so the rerun posts nothing
  const qf = join(fx.state, "questions", `${q.id}.json`);
  const rec = JSON.parse(readFileSync(qf, "utf8")); delete rec.appliedAt; writeFileSync(qf, JSON.stringify(rec));
  routes(fx, { reviews: [{ body: p[1].body, user: { login: ME }, state: "COMMENTED" }] });
  const third = await go(fx, answers);
  assert.equal(third.r.exit, 0);
  assert.equal(posts(fx).length, 2);
});

test("answer-only rerun: a finding already posted inline at this head is not posted again", async () => {
  const fx = fixture(); routes(fx);
  const answers = split({
    merge: [C("c1", { found: [S0] }), C("c2", { severity: "must", line: 3, title: "Must one" })], "v~1": [keep("c1")], "v~2": [drop("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c2", body: "**must:** one" }] },
  });
  await go(fx, answers, { mode: "loop", effort: "medium" });
  const [q] = openQuestions(fx.state);
  answer(fx.state, q.id, "post");
  // a later run already posted this finding inline at the same head
  const key = createHash("sha1").update(`inline\0${fx.head}\0${q.fingerprint}`).digest("hex");
  routes(fx, { reviewComments: [{ body: `x\n\n<!-- pr-review run=r sha=${fx.head} key=${key} fp=${q.fingerprint} -->`, user: { login: ME } }] });
  const again = await go(fx, answers);
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.equal(posts(fx).length, 1, "no follow-up for a finding already on GitHub");
  assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${q.id}.json`), "utf8")).appliedAt);
});

test("CI is read again at post time: none at frame, red at post -> no APPROVE", async () => {
  const fx = fixture(); routes(fx);
  const states = [{ state: "none", since: null, items: [] }, { state: "red", since: null, items: [{ name: "build", state: "fail", url: null, runId: null }] }];
  const calls = [];
  const gh = { ...github, checks: async (...a) => { calls.push(a); return states[Math.min(calls.length - 1, 1)]; } };
  const { r } = await go(fx, { all: { findings: [] }, compose: { body: "Fine.", comments: [] } }, { gh });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(calls.length, 2);
  const p = posts(fx)[0];
  assert.equal(p.event, "COMMENT");
  assert.match(p.body, /Failed checks: build\./);
});

test("a CI read that fails at post time counts as unknown: no APPROVE", async () => {
  const fx = fixture(); routes(fx);
  let k = 0;
  const gh = { ...github, checks: async () => { if (k++) throw new Error("rate limited"); return { state: "green", since: null, items: [] }; } };
  const { r } = await go(fx, { all: { findings: [] }, compose: { body: "Fine.", comments: [] } }, { gh });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(posts(fx)[0].event, "COMMENT");
});

// A new head B on the PR: a.js with `lines` (the fixture head is a=2, b=3, c=4, d=5).
const pushHead = (fx, lines) => {
  const b = commit(fx.seed, { "a.js": lines.join("\n") + "\n" }, "feat: more");
  git(fx.seed, "push", "-qf", fx.origin, "HEAD:refs/pull/5/head");
  routes(fx, { head: b });
  return b;
};
const ANSWER_NO_FINDINGS = { all: { findings: [] }, compose: { body: "Summary.", comments: [] } };

test("7.4: an answer from an older sha is posted when the finding's code did not change", async () => {
  const fx = fixture(); routes(fx);
  const first = await go(fx, split());
  const id = basename(first.r.questions[0], ".md");
  answer(fx.state, id, "post");
  pushHead(fx, ["const a = 2;", "const b = 3;", "const c = 4;", "const d = 6;"]);
  const { r } = await go(fx, ANSWER_NO_FINDINGS);
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(posts(fx)[0].threads.map((t) => t.line), [2]);
  assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${id}.json`), "utf8")).appliedAt);
});

test("7.4: an answer from an older sha is dropped with a note when the finding's code changed", async () => {
  for (const [why, lines] of [["line changed", ["const a = 2;", "const b = 30;", "const c = 4;", "const d = 5;"]], ["line shifted", ["// new", "const a = 2;", "const b = 3;", "const c = 4;", "const d = 5;"]]]) {
    const fx = fixture(); routes(fx);
    const first = await go(fx, split());
    const id = basename(first.r.questions[0], ".md");
    answer(fx.state, id, "post");
    pushHead(fx, lines);
    const lines2 = [];
    const { r } = await go(fx, ANSWER_NO_FINDINGS, { log: (l) => lines2.push(l) });
    assert.equal(r.exit, 0, r.summary);
    assert.deepEqual(posts(fx)[0].threads, [], why);
    assert.ok(lines2.some((l) => l.includes(id) && /changed/.test(l)), why);
    assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${id}.json`), "utf8")).appliedAt, why);
  }
});

test("7.4: a stale 'drop' never turns a must the whole council now agrees on into APPROVE", async () => {
  const fx = fixture(); routes(fx);
  const first = await go(fx, split());
  const id = basename(first.r.questions[0], ".md");
  answer(fx.state, id, "drop");
  pushHead(fx, ["const a = 2;", "const b = 30;", "const c = 4;", "const d = 5;"]);
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx)[0];
  assert.equal(p.event, "REQUEST_CHANGES");
  assert.deepEqual(p.threads.map((t) => t.line), [2]);
  assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${id}.json`), "utf8")).appliedAt);
});

test("7.4: a re-found split whose stale answer was dropped is asked again as a fresh question", async () => {
  const fx = fixture(); routes(fx);
  const first = await go(fx, split());
  const id = basename(first.r.questions[0], ".md");
  answer(fx.state, id, "post");
  pushHead(fx, ["const a = 2;", "const b = 30;", "const c = 4;", "const d = 5;"]);
  let asked = 0;
  const { r } = await go(fx, split(), { decide: async () => { asked++; return { decision: "unsure" }; } });
  assert.equal(r.exit, 3, r.summary);
  assert.equal(asked, 1, "the tally and jev decide again");
  const open = openQuestions(fx.state);
  assert.equal(open.length, 1, "exit 3 always has a question to answer");
  assert.deepEqual(r.questions.map((q) => basename(q, ".md")), open.map((q) => q.id));
  assert.equal(posts(fx).length, 0);
});

test("7.4: the answer-only follow-up drops an answer whose code changed since its sha", async () => {
  const fx = fixture(); routes(fx);
  const first = await go(fx, split(), { mode: "loop", effort: "medium" });
  assert.equal(first.r.exit, 0, first.r.summary);
  const [q] = openQuestions(fx.state);
  // The PR moved and was reviewed at B before the answer came.
  const b = pushHead(fx, ["const a = 2;", "const b = 30;", "const c = 4;", "const d = 5;"]);
  await go(fx, ANSWER_NO_FINDINGS, { mode: "loop", effort: "medium" });
  assert.equal(prState(fx.state, N).lastReviewedSha, b);
  answer(fx.state, q.id, "post");
  const again = await go(fx, ANSWER_NO_FINDINGS);
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.equal(posts(fx).length, 2, "no follow-up");
  assert.ok(JSON.parse(readFileSync(join(fx.state, "questions", `${q.id}.json`), "utf8")).appliedAt);
});

test("a diff above the cap is a clean exit 1 with a hint; --max-diff-lines raises the cap", async () => {
  const fx = fixture(); routes(fx);
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "pr-review"), { recursive: true });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"), JSON.stringify({ review: { max_diff_lines: 3 } }));
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 1);
  assert.match(r.summary, /above review\.max_diff_lines \(3\).*--max-diff-lines/);
  assert.equal(posts(fx).length, 0);
  const ok = await go(fx, happy(), { maxDiffLines: 1000 });
  assert.equal(ok.r.exit, 0, ok.r.summary);
  assert.equal(posts(fx).length, 1);
});

test("hygiene warnings are in the run summary; run.json keeps the planned child count", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy(), { hygiene: async () => ({ findings: [], warnings: ["hygiene child failed"] }) });
  assert.equal(r.exit, 0, r.summary);
  assert.match(r.summary, /warning: hygiene child failed/);
  assert.equal(JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8")).planned, r.planned);
  assert.match(JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8")).version, /^\d+\.\d+\.\d+$/);
  assert.ok(r.planned > 0);
});

test("round-1 children carry the lens max_turns; other children the global one", async () => {
  const fx = fixture(); routes(fx);
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "pr-review"), { recursive: true });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"), JSON.stringify({ seats: [S0, S1, S2].map((id) => ({ harness: id.split(":")[0], model: id.split(":")[1], thinking: "high" })), review: { max_turns: 25 }, lenses: { security: { enabled: true, max_turns: 12 } } }));
  const { r, run } = await go(fx, { all: { findings: [] }, security: { findings: [] }, correctness: { findings: [] }, adversarial: { findings: [] }, simplification: { findings: [] }, architecture: { findings: [] }, compose: { body: "Fine.", comments: [] } }, { effort: "high" });
  assert.equal(r.exit, 0, r.summary);
  const turns = (k) => run.calls.filter((c) => c.k.startsWith(k)).map((c) => c.seat.max_turns);
  assert.deepEqual([...new Set(turns("security~"))], [12]);
  assert.deepEqual([...new Set(turns("correctness~"))], [25]);
  assert.deepEqual(turns("compose"), [25]);
  const prompt = (k) => run.calls.find((c) => c.k.startsWith(k)).prompt;
  assert.match(prompt("security~"), /Budget: at most 7 tool calls\./);
  assert.match(prompt("correctness~"), /Budget: at most 20 tool calls\./);
  assert.ok(run.calls.every((c) => c.seat.timeout_minutes === 10));
});

test("a vote child gets 10 turns plus 3 per finding, never above its limit", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  const votes = run.calls.filter((c) => c.k.startsWith("v~"));
  assert.ok(votes.length > 0);
  for (const c of votes) {
    const n = (c.prompt.match(/"id": "c\d+"/g) ?? []).length;
    assert.equal(c.seat.max_turns, Math.min(40, 10 + 3 * n), c.k);
    assert.match(c.prompt, new RegExp(`Budget: at most ${c.seat.max_turns - 5} tool calls\\.`));
  }
});

test("compose gets the repo's review guidance only; round 1 still sees the whole guidance folder", async () => {
  const fx = fixture(); routes(fx);
  git(fx.seed, "checkout", "-q", "main");
  commit(fx.seed, { "REVIEW.md": "REVIEW-RULE\n", "CONTRIBUTING.md": "CONTRIB-RULE\n" }, "docs: guidance");
  git(fx.seed, "push", "-q", fx.origin, "main");
  const { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  const compose = run.calls.find((c) => c.k === "compose").prompt;
  assert.ok(compose.includes("REVIEW-RULE") && !compose.includes("CONTRIB-RULE"));
  assert.ok(existsSync(join(r.runDir, "ctx", "guidance", "CONTRIBUTING.md")));
});

test("each inline comment goes through the secret scanner once", async () => {
  const fx = fixture(); routes(fx);
  const bin = join(fx.root, "gl-bin"), log = join(fx.root, "gl.log");
  mkdirSync(bin);
  // stub gitleaks: log each scanned text, report no finding
  writeFileSync(join(bin, "gitleaks"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --report-path ] && r=$2; shift; done\ncat >>"${log}"; echo "@@END" >>"${log}"; echo '[]' >"$r"\n`);
  chmodSync(join(bin, "gitleaks"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const { r } = await go(fx, happy());
    assert.equal(r.exit, 0, r.summary);
  } finally { process.env.PATH = path; }
  const scans = readFileSync(log, "utf8").split("@@END\n").filter((t) => t.startsWith("**must:** off by one"));
  assert.equal(scans.length, 1);
});

test("every child gets the ctx folder next to the worktree", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.ok(run.calls.length > 0);
  for (const c of run.calls) assert.equal(c.ctxDir, join(r.runDir, "ctx"), c.k);
});

test("per-stage thinking reaches the children: cubbit seats vote with thinking off", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, split());
  assert.equal(r.exit, 3, r.summary);
  const th = (k) => run.calls.find((c) => c.k === k).seat.thinking;
  assert.equal(th("all~1"), "medium", "round 1: the seat's level after the effort cap");
  assert.equal(th("v~1"), "off");
  assert.equal(th("merge"), "medium", "the judge is a claude seat");
});

// --- dropped seats (turn limit or timeout): the council shrinks, the run goes on, APPROVE is blocked
const dropOf = (reason) => async (o) => { const { SeatDropped } = await import("../lib/child.mjs"); throw new SeatDropped(o.seat, reason); };
const runJson = (r) => JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8"));

test("a seat that hits its turn limit in round 1 is dropped: the rest of the council posts, the summary names it", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy({ "all~2": dropOf("turn limit") }));
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx)[0];
  assert.equal(p.event, "REQUEST_CHANGES");
  assert.deepEqual(p.threads.map((t) => t.line), [2]);
  assert.match(p.body, /Seat cubbit\/mimir-pro was dropped \(turn limit\)\./);
  assert.deepEqual(runJson(r).dropped, [{ seat: S2, reason: "turn limit", stage: "round1" }]);
  assert.ok(!run.calls.some((c) => c.k === "v~2"), "a dropped seat does not vote");
});

test("a dropped seat blocks APPROVE, interactive and loop", async () => {
  for (const mode of ["interactive", "loop"]) {
    const fx = fixture(); routes(fx);
    const { r } = await go(fx, { all: { findings: [] }, "all~1": dropOf("timeout"), compose: { body: "Fine.", comments: [] } }, { mode, effort: "medium" });
    assert.equal(r.exit, 0, r.summary);
    const p = posts(fx)[0];
    assert.equal(p.event, "COMMENT", mode);
    assert.equal(r.queueApprove, false, mode);
    assert.match(p.body, /Seat cubbit\/mimir was dropped \(timeout\)\./);
  }
});

test("a seat dropped in the vote leaves the tally to the seats that remain: found + keep of 2 seats is agreed", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, split({ "v~2": dropOf("timeout") }));
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx)[0];
  assert.deepEqual(p.threads.map((t) => t.line), [2]);
  assert.equal(p.event, "REQUEST_CHANGES");
  assert.deepEqual(runJson(r).dropped, [{ seat: S2, reason: "timeout", stage: "round2" }]);
});

test("fewer than 2 seats left: exit 4, nothing posted", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy({ "all~1": dropOf("timeout"), "all~2": dropOf("turn limit") }));
  assert.equal(r.exit, 4);
  assert.match(r.summary, /fewer than 2 seats/);
  assert.equal(posts(fx).length, 0);
});

test("the judge cannot be dropped: a merge at its turn limit fails the run", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy({ merge: dropOf("turn limit") }));
  assert.equal(r.exit, 4);
  assert.equal(posts(fx).length, 0);
});

test("resume: a dropped seat stays dropped and is not run again", async () => {
  const fx = fixture(); routes(fx);
  const first = await go(fx, happy({ "all~2": dropOf("turn limit"), compose: new ChildFailed("judge down") }));
  assert.equal(first.r.exit, 4);
  const { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.ok(!run.calls.some((c) => c.k === "all~2"));
  assert.match(posts(fx)[0].body, /Seat cubbit\/mimir-pro was dropped \(turn limit\)\./);
});

// --- two seats on one model (opus high + opus medium): two independent seats, by the user's choice
const O1 = "claude:opus", SN = "claude:sonnet", O2 = "claude:opus#2";
function twoOpus() {
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "pr-review"), { recursive: true });
  const s = (model, thinking) => ({ harness: "claude", model, thinking });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"), JSON.stringify({ seats: [s("opus", "high"), s("sonnet", "high"), s("opus", "medium")] }));
}
const abstain = (id) => ({ id, vote: "drop", counter_case: "" });
const opusAnswers = (over = {}) => ({
  all: { findings: [F()] },
  merge: [C("c1", { found: [O1, O2] }), C("c2", { found: [SN], line: 3, title: "Other" })],
  "v~0": [keep("c2")], "v~1": [abstain("c1")], "v~2": [drop("c2")], ...over,
});
const tallyOf = (r) => Object.fromEntries(JSON.parse(readFileSync(join(r.runDir, "tally.json"), "utf8")).map((t) => [t.id, t.status]));

test("two opus seats: 3 round-1 children, 3 votes, each opus find and vote counts on its own", async () => {
  const fx = fixture(); routes(fx); twoOpus();
  const { r, run } = await go(fx, opusAnswers(), { until: "tally" });
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(run.calls.map((c) => c.k).sort(), ["all~0", "all~1", "all~2", "merge", "v~0", "v~1", "v~2"]);
  assert.equal(run.calls.find((c) => c.k === "v~2").seat.thinking, "medium", "v~2 is the second opus seat");
  assert.equal(r.planned, 8);
  assert.equal(runJson(r).planned, 8);
  // c1: found by both opus seats = 2 keeps; c2: one opus keeps, the other drops with a case
  assert.deepEqual(tallyOf(r), { c1: "agreed", c2: "split" });
});

test("two opus seats: dropping one does not drop the other", async () => {
  const fx = fixture(); routes(fx); twoOpus();
  const { r, run } = await go(fx, opusAnswers({ "all~2": dropOf("turn limit"), merge: [C("c1", { found: [SN] })], "v~0": [keep("c1")] }), { until: "tally" });
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(runJson(r).dropped, [{ seat: O2, reason: "turn limit", stage: "round1" }]);
  assert.ok(run.calls.some((c) => c.k === "v~0"), "the first opus seat still votes");
  assert.ok(!run.calls.some((c) => c.k === "v~2"));
  assert.deepEqual(tallyOf(r), { c1: "agreed" });
});

test("two opus seats: resume reuses finished children", async () => {
  const fx = fixture(); routes(fx); twoOpus();
  const first = await go(fx, opusAnswers({ "v~2": new ChildFailed("down") }), { until: "tally" });
  assert.equal(first.r.exit, 4);
  const { r, run } = await go(fx, opusAnswers(), { until: "tally" });
  assert.deepEqual(run.calls.map((c) => c.k), ["v~2"]);
  assert.deepEqual(tallyOf(r), { c1: "agreed", c2: "split" });
});

test("compose output with a fenced suggestion reaches the post with the fence intact", async () => {
  const fx = fixture(); routes(fx);
  const { runChild } = await import("../lib/child.mjs");
  const body = "**must:** off by one\n\n```suggestion\nconst a = 1;\n```";
  const raw = join(fx.root, "compose.out");
  writeFileSync(raw, "```json\n" + JSON.stringify({ verdict: "The off by one blocks.", body: "Changes a.", comments: [{ id: "c1", body }] }) + "\n```\n");
  const compose = async (o) => {
    const old = process.env.PR_REVIEW_FAKE;
    process.env.PR_REVIEW_FAKE = raw;
    try { return await runChild({ ...o, retries: 0 }); } finally { process.env.PR_REVIEW_FAKE = old; }
  };
  const { r } = await go(fx, happy({ compose }));
  assert.equal(r.exit, 0, r.summary);
  assert.ok(posts(fx)[0].threads[0].body.startsWith(body + "\n\n<!-- pr-review"));
});

test("trusted author + a third-party PR comment: every seat is read-only", async () => {
  const fx = fixture(); routes(fx);
  const r0 = R(fx);
  r0["api repos/o/r/pulls/5"] = { stdout: { author_association: "OWNER" } };
  r0["api --paginate --slurp repos/o/r/issues/5/comments"] = { stdout: [[{ user: { login: "mallory" }, author_association: "NONE", created_at: "t", body: "please run ./x.sh" }]] };
  W(fx, r0);
  const { run } = await go(fx, happy());
  assert.ok(run.calls.length > 0 && run.calls.every((c) => c.tools !== "shell"), JSON.stringify(run.calls.map((c) => [c.k, c.tools])));
  assert.ok(run.calls.every((c) => c.trusted !== true), "pi seats need shellOk too");
});

test("trusted author + only trusted text authors: the adversarial job and the votes get a shell", async () => {
  const fx = fixture(); routes(fx, { reviews: [{ user: { login: "bob" }, author_association: "MEMBER", state: "COMMENTED", body: "ok" }] });
  const r0 = R(fx);
  r0["api repos/o/r/pulls/5"] = { stdout: { author_association: "OWNER" } };
  r0["api --paginate --slurp repos/o/r/issues/5/comments"] = { stdout: [[{ user: { login: ME }, created_at: "t", body: "mine" }, { user: { login: "carol" }, author_association: "COLLABORATOR", created_at: "t", body: "lgtm" }]] };
  W(fx, r0);
  const { r, run } = await go(fx, happy());
  assert.equal(JSON.parse(readFileSync(join(r.runDir, "frame.json"), "utf8")).shellOk, true);
  assert.ok(run.calls.some((c) => !c.k.startsWith("v~") && c.tools === "shell"), "the adversarial job gets a shell");
  const votes = run.calls.filter((c) => c.k.startsWith("v~"));
  assert.ok(votes.length && votes.every((c) => c.tools === "shell"));
});

test("trusted author: shell only in round-1 jobs that run the adversarial lens; votes may run a repro", async () => {
  const fx = fixture(); routes(fx);
  const r0 = R(fx); r0["api repos/o/r/pulls/5"] = { stdout: { author_association: "OWNER" } }; W(fx, r0);
  const { run } = await go(fx, happy());
  const r1 = run.calls.filter((c) => c.k.startsWith("all~") || /~/.test(c.k) && !c.k.startsWith("v~"));
  assert.ok(r1.length > 0 && r1.every((c) => c.tools === (c.prompt.includes("adversarial") ? "shell" : "read")), JSON.stringify(r1.map((c) => [c.k, c.tools])));
  assert.ok(run.calls.some((c) => c.tools === "shell"), "the adversarial job gets a shell");
  assert.ok(run.calls.filter((c) => c.k.startsWith("v~")).every((c) => c.tools === "shell"), "votes keep run evidence (R2)");
});

test("no lens left to run (all disabled, or --lens names a disabled one) is exit 1 and posts nothing", async () => {
  const fx = fixture(); routes(fx);
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "pr-review"), { recursive: true });
  const off = Object.fromEntries(["adversarial", "correctness", "simplification", "architecture"].map((l) => [l, { enabled: true }]));
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"), JSON.stringify({ lenses: { ...off, security: { enabled: false } } }));
  // a setup error throws (main.mjs exits 1); the loop retries a throw next tick instead of caching a block
  await assert.rejects(go(fx, happy(), { lenses: ["security"] }), (e) => e.name === "SetupError" && /no lens runs/.test(e.message));
  assert.equal(posts(fx).length, 0);
  rmSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"));
});

test("a seat that resolves to pi is never told it has a shell, and its votes carry no run evidence", async () => {
  const fx = fixture(); routes(fx);
  const r0 = R(fx); r0["api repos/o/r/pulls/5"] = { stdout: { author_association: "OWNER" } }; W(fx, r0);
  // routerUp false: the auto:cubbit seats resolve to pi
  const ev = [{ ...keep("c1"), evidence_run: true }];
  const answers = happy({ "v~0": ev, "v~1": ev, "v~2": ev });
  const { r, run } = await go(fx, answers, { routerUp: false });
  const piCalls = run.calls.filter((c) => c.seat.harness === "auto");
  assert.ok(piCalls.length > 0);
  for (const c of piCalls) {
    assert.equal(c.tools, "read", c.k);
    assert.doesNotMatch(c.prompt, /ran a command in the worktree/, c.k);
  }
  const claudeCall = run.calls.find((c) => c.k.startsWith("all~") && c.seat.harness === "claude");
  assert.equal(claudeCall.tools, "shell", "the claude seat keeps its sandboxed shell: " + run.calls.map((c) => `${c.k}:${c.seat.harness}:${c.tools}`).join(" "));
  const votes = readdirSync(join(r.runDir, "round2")).filter((x) => /^v~\d+\.json$/.test(x));
  const piVote = run.calls.find((c) => c.k.startsWith("v~") && c.seat.harness === "auto");
  assert.ok(piVote, "a pi seat votes: " + votes.join(","));
  const saved = JSON.parse(readFileSync(join(r.runDir, "round2", `${piVote.k}.json`), "utf8"));
  assert.ok(saved.every((x) => x.evidence_run === false), "evidence from a read-only seat is cleared");
});

// A head with Go-like packages in two folders; chunk_lines 3 splits the diff into one part per folder.
function splitFixture(review) {
  const fx = fixture();
  for (const d of ["x", "y"]) mkdirSync(join(fx.seed, d));
  fx.head = commit(fx.seed, { "x/a.go": "package x\nfunc A() {}\n", "y/b.go": "package y\nfunc B() {}\n" }, "feat: two packages");
  git(fx.seed, "push", "-qf", fx.origin, "HEAD:refs/pull/5/head");
  routes(fx);
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "pr-review"), { recursive: true });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"), JSON.stringify({ review: { chunk_lines: 6, ...review } }));
  return fx;
}

test("a diff above chunk_lines: one round-1 child per seat and part, at most max_parallel at once", async () => {
  const fx = splitFixture({ max_parallel: 2 });
  let active = 0, most = 0;
  const all = async () => { most = Math.max(most, ++active); await new Promise((r) => setTimeout(r, 20)); active--; return { findings: [F()] }; };
  const { r, run } = await go(fx, happy({ all }), { until: "round1" });
  assert.equal(r.exit, 0, r.summary);
  const keys = run.calls.map((c) => c.k).sort();
  assert.deepEqual(keys, ["all~0@0", "all~0@1", "all~0@2", "all~0@all", "all~1@0", "all~1@1", "all~1@2", "all~1@all", "all~2@0", "all~2@1", "all~2@2", "all~2@all"]);
  const whole = run.calls.find((c) => c.k === "all~0@all").prompt;
  assert.match(whole, /You review the whole PR for your lens/);
  assert.match(whole, /## Lens: architecture/);
  assert.doesNotMatch(whole, /## Lens: correctness/);

  assert.equal(most, 2);
  const y = run.calls.find((c) => c.k === "all~0@2").prompt;
  assert.match(y, /splits it into 3 parts/);
  assert.match(y, /Files of your part:\ny\/b\.go/);
  assert.match(y, /\+func B\(\) \{\}/);
  assert.doesNotMatch(y.slice(0, y.indexOf("Map of the PR")), /func A/);  assert.doesNotMatch(y, /## Lens: architecture/);
  assert.match(y, /Map of the PR[\s\S]*Part 1:\n  x\/a\.go/);
});

test("too many children for the parts: a config effort steps down; an explicit --effort exits 1", async () => {
  const fx = splitFixture({ max_children: 13 });
  const lines = [];
  const { r } = await go(fx, happy(), { until: "frame", log: (l) => lines.push(l) });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(r.planned, 2 * 4 + 2 + 2); // low: 2 seats x (3 parts + 1 whole PR) + 2 votes + 2 judge
  assert.ok(lines.some((l) => /effort medium needs 17 children for 3 diff parts.*using low/.test(l)), lines.join("\n"));
  const fx2 = splitFixture({ max_children: 13 });
  const { r: r2 } = await go(fx2, happy(), { effort: "medium" });
  assert.equal(r2.exit, 1);
  assert.match(r2.summary, /needs 17 children.*max_children \(13\)\. Use a lower --effort/);
  // auto and the loop's effort are not pinned: they step down too
  for (const over of [{ effort: "auto" }, { mode: "loop", effort: "medium", effortFromConfig: true }]) {
    const fx3 = splitFixture({ max_children: 13 });
    const { r: r3 } = await go(fx3, happy(), { until: "frame", ...over });
    assert.equal(r3.exit, 0, `${JSON.stringify(over)}: ${r3.summary}`);
    assert.equal(r3.planned, 12);
  }
});

test("split PR: a seat that misses one part keeps its other parts and its vote; the summary says so; no APPROVE", async () => {
  const fx = splitFixture({});
  const { r, run } = await go(fx, happy({ "all~2@1": dropOf("turn limit") }));
  assert.equal(r.exit, 0, r.summary);
  const st = JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8"));
  assert.deepEqual(st.dropped, []);
  assert.deepEqual(st.missed.map((m) => [m.seat, m.key]), [[S2, "all~2@1"]]);
  assert.ok(run.calls.some((c) => c.k === "v~2"), "the seat still votes");
  const p = posts(fx)[0];
  assert.match(p.body, /Seat cubbit\/mimir-pro missed 1 part of the split diff \(turn limit\)\./);
  assert.notEqual(p.event, "APPROVE");
});

test("the next review removes the worktree of a finished run and keeps its ctx", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy());
  const wt = join(r.runDir, "wt");
  assert.ok(existsSync(wt));
  const { r: r2 } = await go(fx, happy(), { restart: true });
  assert.equal(existsSync(wt), false, "the finished run's worktree is gone");
  assert.ok(existsSync(join(r.runDir, "ctx", "diff.patch")), "ctx stays for the loop");
  assert.doesNotMatch(git(fx.repoDir, "worktree", "list"), new RegExp(basename(r.runDir)), "and git forgets it");
  assert.ok(existsSync(join(r2.runDir, "wt")), "the new run keeps its own until it is swept");
});

test("sweep: a --restart at the same head removes the crashed run's worktree", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy(), { until: "round1" });
  rmSync(join(r.runDir, "post.done"), { force: true }); // crashed at this head
  assert.ok(existsSync(join(r.runDir, "wt")));
  const { r: r2 } = await go(fx, happy(), { restart: true });
  assert.equal(r2.exit, 0, r2.summary);
  assert.notEqual(r2.runDir, r.runDir);
  assert.equal(existsSync(join(r.runDir, "wt")), false, "the crashed run is never resumed");
  assert.doesNotMatch(git(fx.repoDir, "worktree", "list"), new RegExp(basename(r.runDir)));
  // a third review at the same head is skipped and keeps no worktree of this PR
  const { r: r3 } = await go(fx, happy());
  assert.ok(r3.skipped);
  assert.equal(existsSync(join(r2.runDir, "wt")), false);
});

test("sweep: a run at an old head loses its worktree; a folder that cannot go never fails the review", async () => {
  const fx = fixture(); routes(fx);
  const { r } = await go(fx, happy(), { until: "round1" });
  const st = JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8"));
  rmSync(join(r.runDir, "post.done")); // an unfinished run at this head
  assert.ok(st && existsSync(join(r.runDir, "wt")));
  const head2 = commit(fx.seed, { "a.js": "const a = 3;\n" }, "next");
  git(fx.seed, "push", "-qf", fx.origin, "HEAD:refs/pull/5/head");
  routes(fx, { head: head2 });
  const { r: r2 } = await go(fx, happy());
  assert.equal(r2.exit, 0, r2.summary);
  assert.equal(existsSync(join(r.runDir, "wt")), false, "the old-head run's worktree is gone");
  // a finished run whose worktree cannot be removed: the next review still runs
  const stuck = join(r2.runDir, "wt", "ro");
  mkdirSync(join(stuck, "x"), { recursive: true });
  execFileSync("chmod", ["555", stuck]);
  try {
    const { r: r3 } = await go(fx, happy(), { restart: true });
    assert.equal(r3.exit, 0, r3.summary);
  } finally { execFileSync("chmod", ["755", stuck]); }
});

test("one root cause found by 2 lenses: one comment with both fps; the next run links either lens to it", async () => {
  const sec = { lens: "security", title: "Total leaks the secret" };
  const fx0 = fixture(); routes(fx0);
  const fold = happy({
    merge: [C("c1"), C("c2", sec)], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Changes a.", comments: [{ id: "c1", also: ["c2"], body: "**must:** off by one, and it leaks" }] },
  });
  await go(fx0, fold);
  const t = posts(fx0)[0].threads;
  assert.equal(t.length, 1);
  assert.ok(t[0].body.endsWith(` fp=${fingerprint(F())},${fingerprint(F(sec))} -->`), t[0].body);
  const st = prState(fx0.state, N);
  assert.ok(st.settled.includes(fingerprint(F(sec))));
  assert.deepEqual(st.agreed.map((a) => a.lens).sort(), ["correctness", "security"]);
  // A later review: our thread holds both fps, so a reworded security repeat on that line links to it.
  const fx = fixture(); routes(fx, { threads: [thread("T1", ME, t[0].body)] });
  savePrState(fx.state, N, { ...prState(fx.state, N), agreed: st.agreed });
  const { r } = await go(fx, happy({ merge: [C("c2", { ...sec, title: "Other words" })] }));
  const rec = JSON.parse(readFileSync(join(r.runDir, "clusters.json"), "utf8"));
  assert.deepEqual([rec.clusters.length, rec.linked.length], [0, 1]);
});

test("compose `also` never folds a finding of another file", async () => {
  const fx = fixture(); routes(fx);
  await go(fx, happy({
    merge: [C("c1"), C("c2", { file: "b.js", lens: "security" })], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Changes a.", comments: [{ id: "c1", also: ["c2"], body: "**must:** x" }, { id: "c2", body: "**must:** y" }] },
  }));
  const all = JSON.stringify(posts(fx)[0]);
  assert.match(all, /\*\*must:\*\* x/);
  assert.match(all, /\*\*must:\*\* y/, "c2 keeps its own comment");
});

test("compose `also`: a chain loses no finding; another line of the same file is not folded", async () => {
  const fx = fixture(); routes(fx);
  await go(fx, happy({
    merge: [C("c1"), C("c2", { lens: "security", title: "Leak" }), C("c3", { lens: "simplification", title: "Dead" }), C("c4", { lens: "adversarial", title: "Other line", line: 3 })],
    "v~2": ["c1", "c2", "c3", "c4"].map(keep),
    compose: { body: "Changes a.", comments: [
      { id: "c1", also: ["c2"], body: "**must:** one" },
      { id: "c3", also: ["c1", "c4"], body: "**must:** three" },
    ] },
  }));
  const t = posts(fx)[0].threads;
  const fp = (o) => fingerprint(F(o));
  const by = (re) => t.find((x) => re.test(x.body));
  assert.ok(by(/one/).body.endsWith(`fp=${fp({})},${fp({ lens: "security", title: "Leak" })} -->`), "c2 folds into c1");
  assert.ok(by(/three/), "c1 keeps its own comment: a host is never folded");
  assert.ok(by(/three/).body.endsWith(`fp=${fp({ lens: "simplification", title: "Dead" })} -->`), "c3 carries only its own fp");
  const c4 = t.find((x) => x.line === 3);
  assert.ok(c4, "c4, on another line, is not folded");
  assert.match(c4.body, /Other line[\s\S]*use 2/, "a refused fold still posts its fix");
  const st = prState(fx.state, N);
  for (const o of [{}, { lens: "security", title: "Leak" }, { lens: "simplification", title: "Dead" }, { lens: "adversarial", title: "Other line", line: 3 }]) assert.ok(st.settled.includes(fp(o)));
});

test("a host held by the secret scan does not swallow its folded findings: they post on their own", async () => {
  const fx = fixture(); routes(fx);
  const token = "ghp_" + "A".repeat(36);
  const sec = { lens: "security", title: "Leak" };
  const { r } = await go(fx, happy({
    merge: [C("c1"), C("c2", sec)], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c1", also: ["c2"], body: `**must:** token ${token} leaks` }] },
  }), { mode: "loop" });
  assert.equal(r.exit, 0, r.summary);
  const t = posts(fx)[0].threads;
  assert.equal(t.length, 1, "the held host is not posted; c2 is");
  assert.match(t[0].body, /\*\*must:\*\* Leak[\s\S]*use 2/);
  assert.ok(t[0].body.endsWith(`fp=${fingerprint(F(sec))} -->`));
  assert.ok(!JSON.stringify(mutations(fx)).includes(token));
  assert.equal(openQuestions(fx.state).length, 1, "the host is a question");
  assert.ok(prState(fx.state, N).settled.includes(fingerprint(F(sec))));
});

test("a folded finding held on its own: answer post sends it with the secret redacted", async () => {
  const fx = fixture(); routes(fx);
  const token = "ghp_" + "B".repeat(36);
  const sec = { lens: "security", title: "Leak", case: `the token ${token} is logged` };
  const answers = happy({
    merge: [C("c1"), C("c2", sec)], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c1", also: ["c2"], body: `**must:** token ${token} leaks` }] },
  });
  await go(fx, answers, { mode: "loop" });
  const q = openQuestions(fx.state).find((x) => x.fingerprint === fingerprint(F(sec)));
  assert.ok(q, "the folded finding has its own question");
  answer(fx.state, q.id, "post");
  const again = await go(fx, answers, { mode: "loop" });
  assert.equal(again.r.exit, 0, again.r.summary);
  const all = JSON.stringify(posts(fx).slice(1));
  assert.match(all, /\[REDACTED:github-token\] is logged/);
  assert.ok(!JSON.stringify(mutations(fx)).includes(token));
});

test("a held host answered post goes out with its own text only, not the folded finding again", async () => {
  const fx = fixture(); routes(fx);
  const token = "ghp_" + "C".repeat(36);
  const sec = { lens: "security", title: "Leak" };
  const answers = happy({
    merge: [C("c1"), C("c2", sec)], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c1", also: ["c2"], body: `**must:** off by one, and Leak via ${token}` }] },
  });
  await go(fx, answers, { mode: "loop" });
  const q = openQuestions(fx.state).find((x) => x.fingerprint === fingerprint(F()));
  answer(fx.state, q.id, "post");
  const again = await go(fx, answers, { mode: "loop" });
  assert.equal(again.r.exit, 0, again.r.summary);
  const t = posts(fx).slice(1).flatMap((p) => p.threads);
  assert.equal(t.length, 1);
  assert.match(t[0].body, /^\*\*must:\*\* Off by one/);
  assert.doesNotMatch(t[0].body, /Leak/, "the folded finding is not posted twice");
});

// The agreed findings that compose got, from its prompt.
const agreedInCompose = (run) => {
  const p = run.calls.find((c) => c.k === "compose").prompt, at = p.indexOf("## Agreed findings");
  return JSON.parse(p.slice(p.indexOf("[", at), p.indexOf("\n]", at) + 2));
};

test("compose gets outside: true on a finding off the diff lines, and only there", async () => {
  const fx = fixture(); routes(fx);
  const { run } = await go(fx, happy({ merge: [C("c1"), C("c2", { file: "b.js", line: 3, lens: "security", title: "Elsewhere" })], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Changes a.", comments: [{ id: "c1", body: "**must:** one" }, { id: "c2", body: "**must:** two" }] } }));
  const data = agreedInCompose(run);
  assert.deepEqual(data.map((x) => [x.id, x.outside ?? false]), [["c1", false], ["c2", true]]);
});

test("the body index lists only threads that went inline, at their real line, Critical first", async () => {
  const fx = fixture(); routes(fx);
  const c2 = C("c2", { line: 99, severity: "should", title: "Off diff" }), c3 = C("c3", { line: 3, severity: "should", title: "Name" });
  const compose = {
    verdict: "The off by one blocks.", body: "", praise: "The test covers the edge.",
    index: [{ theme: "Totals", items: [{ id: "c3", text: "Rename c." }, { id: "c1", text: "Fix the total." }, { id: "c2", text: "Off-diff item." }, { id: "c9", text: "Made up." }] }],
    comments: [{ id: "c1", body: "**must:** off by one" }, { id: "c2", body: "**should:** off diff" }, { id: "c3", body: "**should:** name" }],
  };
  const { r } = await go(fx, { all: { findings: [F()] }, merge: [C("c1"), c2, c3], "v~2": [keep("c1"), keep("c2"), keep("c3")], compose });
  assert.equal(r.exit, 0, r.summary);
  const b = posts(fx)[0].body;
  assert.match(b, /^The off by one blocks\.\n\nWhat was checked: light depth, no checks run\.\n\nCritical:\n- Fix the total\. \(thread on `a\.js` L2\)\n\nTotals:\n- Rename c\. \(thread on `a\.js` L3\)\n\nThe test covers the edge\./);
  assert.doesNotMatch(b, /Off-diff item|Made up/);
  assert.match(b, /Outside the diff:/);
});

test("the author's questions in the PR body reach compose, and the answers come after the verdict", async () => {
  const fx = fixture(); routes(fx, { body: "Changes a.\n\nIs 2 the right value?" });
  const { r, run } = await go(fx, happy({ compose: { verdict: "Nothing blocks.", answers: ["Yes, 2 matches the spec.", "extra"], body: "", comments: [{ id: "c1", body: "**must:** off by one" }] } }));
  assert.equal(r.exit, 0, r.summary);
  assert.match(run.calls.find((c) => c.k === "compose").prompt, /## The author's questions[\s\S]*1\. Is 2 the right value\?/);
  // c1 is a must of this run: "Nothing blocks." would contradict REQUEST_CHANGES
  assert.match(posts(fx)[0].body, /^The must findings block the merge\.\n\nWhat was checked: light depth, no checks run\.\n\nYour questions:\n1\. Yes, 2 matches the spec\.\n\n<!-- pr-review/);
});

test("a bold or reworded \"nothing blocks\" verdict next to an earlier must still open is replaced", async () => {
  const fx = fixture();
  routes(fx, { threads: [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { nodes: [{ databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" }] } }] });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  for (const verdict of ["**Nothing blocks.**", "I find nothing blocking the merge."]) {
    const { r } = await go(fx, { all: { findings: [], earlier: [{ thread_id: "T1", status: "open", evidence: "x" }] }, compose: { verdict, body: "Still open.", comments: [] } }, { restart: true });
    assert.equal(r.exit, 0, r.summary);
    assert.match(posts(fx).at(-1).body, /1 earlier must finding is still open, so the PR is blocked\./, verdict);
  }
});

test("pass 2: an earlier finding the seats judge wrong is retracted first, and no longer blocks", async () => {
  const fx = fixture();
  routes(fx, { threads: [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: true, path: "a.js", line: 1, originalLine: 1,
    comments: { nodes: [{ databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" }] } }] });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const earlier = [{ thread_id: "T1", status: "wrong", evidence: "a.js:1 is the documented default" }];
  const compose = { verdict: "Nothing blocks.", body: "No new findings.", corrections: [{ thread_id: "T1", text: "Our finding on a was wrong: 2 is the documented default." }], comments: [] };
  const { r, run } = await go(fx, { all: { findings: [], earlier }, compose });
  assert.equal(r.exit, 0, r.summary);
  assert.match(run.calls.find((c) => c.k === "compose").prompt, /a\.js:1 is the documented default/);
  const p = posts(fx)[0];
  assert.match(p.body, new RegExp(`^Second pass, on \`${fx.head.slice(0, 7)}\`\\.\n\nCorrection: Our finding on a was wrong: 2 is the documented default\\. \\(thread on \`a\\.js\` L1\\)\n\nNothing blocks\\.`));
  assert.notEqual(p.event, "REQUEST_CHANGES");
  assert.ok(!mutations(fx).some((x) => x.key.includes("replies")), "a retracted thread gets no 'Fixed in' reply");
  assert.ok(mutations(fx).some((x) => x.key === "graphql ResolveThread"), "a retracted thread is resolved");
  assert.deepEqual(prState(fx.state, N).retracted, ["T1"]);
});

const T1 = (canResolve = true) => [{ id: "T1", isResolved: false, isOutdated: false, viewerCanResolve: canResolve, path: "a.js", line: 1, originalLine: 1,
  comments: { nodes: [{ databaseId: 11, author: { login: ME, __typename: "User" }, body: "**must:** a is wrong", createdAt: "x" }] } }];

test("pass 3: a thread we retracted is not judged again and does not block, also when GitHub kept it open", async () => {
  const fx = fixture(); routes(fx, { threads: T1(false) });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 2, lastReviewedSha: fx.base, retracted: ["T1"], resolved: ["T1"] });
  const { r } = await go(fx, { all: { findings: [], earlier: [{ thread_id: "T1", status: "open", evidence: "a.js:1" }] }, compose: { verdict: "Nothing blocks.", body: "No new findings.", comments: [] } });
  assert.equal(r.exit, 0, r.summary);
  assert.deepEqual(JSON.parse(readFileSync(join(r.runDir, "ctx", "earlier.json"), "utf8")), []);
  const p = posts(fx)[0];
  assert.notEqual(p.event, "REQUEST_CHANGES");
  assert.match(p.body, /^Pass 3, on `[0-9a-f]{7}`\.\n\nNothing blocks\./);
  assert.doesNotMatch(p.body, /Correction/);
});

test("pass 2: an earlier must still open reaches compose, and \"Nothing blocks.\" never contradicts the event", async () => {
  const fx = fixture(); routes(fx, { threads: T1() });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 1, lastReviewedSha: fx.base });
  const { r, run } = await go(fx, { all: { findings: [], earlier: [{ thread_id: "T1", status: "open", evidence: "x" }] }, compose: { verdict: "Nothing blocks.", body: "Still open.", comments: [] } });
  assert.equal(r.exit, 0, r.summary);
  const prompt = run.calls.find((c) => c.k === "compose").prompt;
  assert.match(prompt, /## Earlier must findings of ours that are still open[\s\S]*"thread_id": "T1"/);
  assert.match(prompt, /Never write "Nothing blocks\."/);
  const p = posts(fx)[0];
  assert.equal(p.event, "REQUEST_CHANGES");
  assert.match(p.body, /^Second pass, on `[0-9a-f]{7}`\.\n\n1 earlier must finding is still open, so the PR is blocked\.\n\nWhat was checked: light depth, no checks run\.\n\nStill open\./);
});

test("an empty answer keeps the next answers on their own question numbers", async () => {
  const fx = fixture(); routes(fx, { body: "Is 2 right?\nWhy not 3?" });
  await go(fx, happy({ compose: { verdict: "The off by one blocks.", answers: ["", "3 overflows the buffer."], body: "", comments: [{ id: "c1", body: "**must:** off by one" }] } }));
  assert.match(posts(fx)[0].body, /Your questions:\n2\. 3 overflows the buffer\.\n/);
});

test("compose guidance: REVIEW.md stays whole; only the review.guidance files are capped", () => {
  const ctx = mkdtempSync(join(tmpdir(), "prr-guide-"));
  mkdirSync(join(ctx, "guidance", "docs"), { recursive: true });
  writeFileSync(join(ctx, "guidance", "REVIEW.md"), "R".repeat(9000));
  writeFileSync(join(ctx, "guidance", "docs", "style.md"), "S".repeat(9000));
  writeFileSync(join(ctx, "guidance", "CONTRIBUTING.md"), "C");
  const g = composeGuidance(ctx, { review: { guidance: ["docs/style.md", "REVIEW.md"] } });
  assert.ok(g.startsWith("R".repeat(9000) + "\n\n"), "REVIEW.md first and whole");
  assert.ok(g.endsWith("S".repeat(8000) + "\n[cut]") && !g.includes("C"));
});

test("a user lens file runs in round 1 with its text; off in the config it is skipped; --lens picks it", async () => {
  const dir = () => join(process.env.XDG_CONFIG_HOME, "pr-review");
  const setup = (cfg) => {
    const fx = fixture(); routes(fx);
    mkdirSync(join(dir(), "lenses"), { recursive: true });
    writeFileSync(join(dir(), "lenses", "perf.md"), "Look for slow loops. PERF-LENS-TEXT\n");
    if (cfg) writeFileSync(join(dir(), "config.json"), JSON.stringify(cfg));
    return fx;
  };
  const r1 = (run) => run.calls.filter((c) => c.k.startsWith("all~"));
  let fx = setup();
  let { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.ok(r1(run).length > 0 && r1(run).every((c) => /## Lens: perf\n\nLook for slow loops\. PERF-LENS-TEXT/.test(c.prompt)));
  assert.match(r1(run)[0].prompt, /Use only these lens names: adversarial, correctness, simplification, architecture, security, perf\./);

  fx = setup({ lenses: { perf: { enabled: false } } });
  ({ r, run } = await go(fx, happy()));
  assert.equal(r.exit, 0, r.summary);
  assert.ok(r1(run).every((c) => !c.prompt.includes("PERF-LENS-TEXT")));

  fx = setup();
  ({ r, run } = await go(fx, { all: { findings: [] }, compose: { body: "Fine.", comments: [] } }, { lenses: ["perf"] }));
  assert.equal(r.exit, 0, r.summary);
  assert.ok(r1(run).every((c) => c.prompt.includes("PERF-LENS-TEXT") && !c.prompt.includes("## Lens: security")));
  assert.match(posts(fx)[0].body, /Lenses not run: adversarial, correctness, simplification, architecture, security\./);
});

test("--lens with an unknown name, or a bad user lens file, is a setup error before any child", async () => {
  const fx = fixture(); routes(fx);
  await assert.rejects(go(fx, happy(), { lenses: ["nope"] }), (e) => e.name === "SetupError" && /unknown lens nope; lenses: adversarial/.test(e.message));
  const lenses = join(process.env.XDG_CONFIG_HOME, "pr-review", "lenses");
  mkdirSync(lenses, { recursive: true });
  writeFileSync(join(lenses, "big.md"), "x\n".repeat(41));
  const run = fakeRun(happy());
  await assert.rejects(review({ repo: REPO, n: N, repoDir: fx.repoDir, runChild: run, routerUp: true }), (e) => e.name === "SetupError" && e.message.includes(join(lenses, "big.md")));
  assert.equal(run.calls.length, 0);
  assert.equal(posts(fx).length, 0);
});

test("a resumed run whose user lens file was removed is a setup error, not a crash in round 1", async () => {
  const fx = fixture(); routes(fx);
  const lenses = join(process.env.XDG_CONFIG_HOME, "pr-review", "lenses");
  mkdirSync(lenses, { recursive: true });
  writeFileSync(join(lenses, "perf.md"), "Look for slow loops.\n");
  // a round-1 child crashes: run.json stays and the next run resumes it
  await assert.rejects(go(fx, { ...happy(), all: new Error("boom") }), /boom/);
  rmSync(join(lenses, "perf.md"));
  await assert.rejects(go(fx, happy()), (e) => e.name === "SetupError" && /lens perf of this run is gone/.test(e.message));
});

// Depth and setup checks (#38).
const userConfig = (obj) => {
  mkdirSync(join(process.env.XDG_CONFIG_HOME, "pr-review"), { recursive: true });
  writeFileSync(join(process.env.XDG_CONFIG_HOME, "pr-review", "config.json"), JSON.stringify(obj));
};
const trusted = (fx) => { const r0 = R(fx); r0["api repos/o/r/pulls/5"] = { stdout: { author_association: "OWNER" } }; W(fx, r0); };

test("light depth (the default): no check runs, and the summary names the depth", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  userConfig({ review: { checks: [{ name: "x", run: "touch ../ran" }] } });
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.match(posts(fx)[0].body, /(?:^|\n\n)What was checked: light depth, no checks run\.\n\n/);
  assert.equal(existsSync(join(r.runDir, "ran")), false);
  assert.equal(existsSync(join(r.runDir, "setup.done")), true);
});

test("full depth: checks run once before round 1, a failure is data, every seat brief and the summary name them", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  userConfig({ review: { checks: [{ name: "hello", run: "echo hi", paths: ["**/*.js"] }, { name: "bad", run: "exit 2" }, { name: "docs", run: "true", paths: ["docs/**"] }] } });
  const { r, run } = await go(fx, happy(), { depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  const s = JSON.parse(readFileSync(join(r.runDir, "ctx", "setup.json"), "utf8"));
  assert.deepEqual(s.checks.map((c) => [c.name, c.exit]), [["hello", 0], ["bad", 2]]);
  // the seats that judge code get the checks; the judge (merge, compose) does not
  for (const c of run.calls) {
    if (c.k.startsWith("all~") || c.k.startsWith("v~")) {
      assert.match(c.prompt, /## Setup checks\nSetup checks: .*\n- hello: ok\n- bad: failed \(exit 2\)/, c.k);
      // engine data: inside no PR-data fence
      const brief = c.prompt.indexOf("## Setup checks");
      const fences = [...c.prompt.matchAll(/<<<(PR-DATA-[0-9a-f]+)\n[\s\S]*?\n\1>>>/g)];
      assert.ok(fences.length > 0 && fences.every((m) => brief < m.index || brief > m.index + m[0].length), `${c.k}: the brief is inside a PR-data fence`);
    }
    else assert.doesNotMatch(c.prompt, /Setup checks/, c.k);
  }
  assert.doesNotMatch(readFileSync(join(r.runDir, "hygiene-prompt.txt"), "utf8"), /Setup checks/);
  assert.match(posts(fx)[0].body, /(?:^|\n\n)What was checked: full depth; hello ok, bad failed \(exit 2\)\.\n\n/);
  assert.equal(JSON.parse(readFileSync(join(r.runDir, "run.json"), "utf8")).depth, "full");
});

test("auto depth with no core paths: an interactive run asks first; the saved answer is used next time", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  userConfig({ review: { depth: "auto", checks: [{ name: "hello", run: "echo hi" }] } });
  const first = await go(fx, happy());
  assert.equal(first.r.exit, 3);
  assert.match(first.r.summary, /^core paths not set for o\/r/);
  assert.equal(first.run.calls.length, 0);
  assert.equal(posts(fx).length, 0);
  // nothing ran: the run is closed, so status lists no open run
  assert.equal(existsSync(join(first.r.runDir, "post.done")), true);
  assert.equal(existsSync(join(first.r.runDir, "wt")), false);
  saveCorePaths(fx.state, ["*.js"]);
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.match(posts(fx)[0].body, /What was checked: full depth; hello ok\./);
});

test("auto depth with no core paths in the loop: one question for the repo, never repeated, and no block", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  userConfig({ review: { depth: "auto" } });
  const { r } = await go(fx, happy(), { mode: "loop" });
  assert.equal(r.exit, 0, r.summary);
  assert.match(posts(fx)[0].body, /What was checked: light depth, no checks run\./);
  await go(fx, happy(), { mode: "loop", restart: true });
  const qs = openQuestions(fx.state).filter((q) => q.finding?.kind === "core-paths");
  assert.equal(qs.length, 1);
});

test("auto depth with no core paths: a PR whose depth the answer cannot change is not held for it", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  userConfig({ review: { depth: "auto" } });
  // a new exported name decides full on its own
  git(fx.seed, "checkout", "-q", "feat");
  const head = commit(fx.seed, { "a.js": "export const a = 2;\n" }, "feat: export a");
  git(fx.seed, "push", "-qf", fx.origin, "HEAD:refs/pull/5/head");
  routes(fx, { head }); trusted(fx);
  const { r } = await go(fx, happy({ all: { findings: [F({ line: 1 })] }, merge: [C("c1", { line: 1 })] }));
  assert.equal(r.exit, 0, r.summary);
  assert.match(posts(fx)[0].body, /What was checked: full depth;/);
  assert.equal(openQuestions(fx.state).length, 0);
});

test("auto depth with no core paths: a docs-only PR is light, with no question", async () => {
  const fx = fixture();
  git(fx.seed, "checkout", "-q", fx.base); // a PR with one commit on main: docs/a.md only
  mkdirSync(join(fx.seed, "docs"), { recursive: true });
  const head = commit(fx.seed, { "docs/a.md": "# A\n" }, "docs: add a");
  git(fx.seed, "push", "-qf", fx.origin, "HEAD:refs/pull/5/head");
  routes(fx, { head }); trusted(fx);
  userConfig({ review: { depth: "auto" } });
  const { r } = await go(fx, happy({ all: { findings: [F({ file: "docs/a.md", line: 1 })] }, merge: [C("c1", { file: "docs/a.md", line: 1 })] }));
  assert.equal(r.exit, 0, r.summary);
  assert.match(posts(fx)[0].body, /What was checked: light depth, no checks run\./);
  assert.equal(openQuestions(fx.state).length, 0);
});

test("auto depth: a core-paths drop answered before any tick counts in an interactive review", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  userConfig({ review: { depth: "auto" } });
  answer(fx.state, queueCoreQuestion(fx.state, REPO, []), "drop");
  const { r } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  assert.match(posts(fx)[0].body, /What was checked: light depth, no checks run\./);
});

// Proven findings (#37): mutants, required proof, checked fixes; full depth only.
// a.test.js makes a.js a file with a test; the "test" passes only while line 2 reads `const b = 3;`.
const MUTATE = { name: "t", run: "grep -q 'const b = 3;' a.js", mutate: true };
const threadAt = (fx, line, i = 0) => posts(fx)[i].threads.filter((t) => t.line === line).map((t) => t.body).join("\n");
const suggest = (code) => `**must:** off by one\n\nUse this:\n\n\`\`\`suggestion\n${code}\n\`\`\``;

test("full depth: a surviving mutant is posted as a proven finding, a killed one is not; an agreed unproven must stays must and is marked", async () => {
  const fx = fixture({ "a.test.js": "" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE], mutants: { max: 2 } } });
  const { r, run } = await go(fx, happy(), { depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  const m = JSON.parse(readFileSync(join(r.runDir, "ctx", "mutants.json"), "utf8")).mutants;
  assert.deepEqual(m.map((x) => [x.line, x.status]), [[1, "survived"], [2, "killed"]]);
  assert.equal(git(join(r.runDir, "wt"), "status", "--porcelain"), "", "the worktree is restored");
  assert.match(run.calls.find((c) => c.k === "all~0").prompt, /Mutants: the engine broke 2 changed lines .*1 caught, 1 not caught/);
  const p = posts(fx)[0];
  assert.equal(p.event, "REQUEST_CHANGES");
  assert.match(threadAt(fx, 1), /^\*\*should:\*\* No test catches a break in `const a = 2;`[\s\S]*grep -q/);
  assert.doesNotMatch(threadAt(fx, 1), /Unproven/);
  assert.match(threadAt(fx, 2), /^\*\*must:\*\* off by one\n\nUnproven: no run in this review shows this case\.\n\n<!--/);
  assert.equal(p.threads.length, 2, "no finding for the killed mutant");
  assert.match(p.body, /What was checked: full depth; t ok\.\n\nProof: 1 proven, 1 unproven\.\n\n/);
});

test("full depth: no mutant runs when its finding cannot post (lens not run, or review 3)", async () => {
  const fx = fixture({ "a.test.js": "" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE] } });
  const { r, run } = await go(fx, happy({ all: { findings: [F({ lens: "security" })] }, merge: [C("c1", { lens: "security" })] }), { depth: "full", lenses: ["security"] });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(existsSync(join(r.runDir, "ctx", "mutants.json")), false);
  assert.match(run.calls[0].prompt, /Mutants did not run: the correctness lens does not run\./);
  assert.equal(posts(fx)[0].threads.length, 1, "no correctness finding from a mutant");
});

test("full depth: an unproven must that a seat dropped is posted as should; run evidence of the finding itself keeps it must", async () => {
  const agreedByJev = { decide: async () => ({ decision: "agreed", raw: null }), depth: "full" };
  const sev = (run) => agreedInCompose(run)[0].severity;
  let fx = fixture(); routes(fx); trusted(fx);
  let { r, run } = await go(fx, split(), agreedByJev);
  assert.equal(r.exit, 0, r.summary);
  assert.equal(sev(run), "should");
  assert.notEqual(posts(fx)[0].event, "REQUEST_CHANGES");
  assert.match(threadAt(fx, 2), /Unproven/);
  fx = fixture(); routes(fx); trusted(fx);
  ({ r, run } = await go(fx, split({ "v~1": [{ ...keep("c1"), evidence_run: true }] }), agreedByJev));
  assert.equal(r.exit, 0, r.summary);
  assert.equal(sev(run), "must");
  assert.equal(posts(fx)[0].event, "REQUEST_CHANGES");
  assert.doesNotMatch(threadAt(fx, 2), /Unproven/);
  assert.match(posts(fx)[0].body, /Proof: 1 proven, 0 unproven\./);
  // a round-1 run proves the cluster only through its members (fid), never by file and lens
  const ran = { all: { findings: [F({ evidence_run: true })] } };
  fx = fixture(); routes(fx); trusted(fx);
  ({ run } = await go(fx, split(ran), agreedByJev));
  assert.equal(sev(run), "should");
  const fid = (o) => /"fid": "(f\w+)"/.exec(readFileSync(o.promptFile, "utf8"))[1];
  fx = fixture(); routes(fx); trusted(fx);
  ({ run } = await go(fx, split({ ...ran, merge: (o) => [C("c1", { found: [S0], members: [fid(o)] })] }), agreedByJev));
  assert.equal(sev(run), "must");
});

test("full depth: a suggestion that fails the tests is posted as text only, with an engine note; a passing one keeps its code", async () => {
  const fx = fixture({ "a.test.js": "" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE], mutants: { max: 1 } } });
  const { r } = await go(fx, happy({ compose: { body: "Changes a.", comments: [{ id: "c1", body: suggest("const b = 99;") }] } }), { depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  const t = threadAt(fx, 2);
  assert.doesNotMatch(t, /```|const b = 99/);
  assert.match(t, /Use this:\n\nUnproven: .*\n\nEngine note: the suggested code was left out, because t failed \(exit 1\) with it\./);
  assert.equal(readFileSync(join(r.runDir, "wt", "a.js"), "utf8"), "const a = 2;\nconst b = 3;\nconst c = 4;\nconst d = 5;\n");
  const ok = fixture({ "a.test.js": "" }); routes(ok); trusted(ok);
  userConfig({ review: { checks: [MUTATE], mutants: { max: 1 } } });
  const good = await go(ok, happy({ compose: { body: "Changes a.", comments: [{ id: "c1", body: suggest("const b = 3; // same") }] } }), { depth: "full" });
  assert.ok(existsSync(join(good.r.runDir, "fixes")), "the fix was checked");
  assert.match(threadAt(ok, 2), /```suggestion\nconst b = 3; \/\/ same\n```/);
});

test("full depth: findings of another proof status are not folded; an unfolded comment is fix-checked too", async () => {
  let fx = fixture(); routes(fx); trusted(fx);
  const sec = { lens: "security", title: "Leak" };
  await go(fx, happy({
    merge: [C("c1"), C("c2", sec)], "v~2": [{ ...keep("c1"), evidence_run: true }, keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c1", also: ["c2"], body: "**must:** off by one, and Leak" }] },
  }), { depth: "full" });
  assert.equal(posts(fx)[0].threads.length, 2);
  assert.match(threadAt(fx, 2), /off by one, and Leak\n\n<!--[\s\S]*\*\*must:\*\* Leak[\s\S]*Unproven/);
  // the host is held by the secret scan, so c2 posts on its own: its suggestion is checked like any other
  fx = fixture({ "a.test.js": "" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE], mutants: { max: 1 } } });
  const token = "ghp_" + "D".repeat(36);
  const { r } = await go(fx, happy({
    merge: [C("c1"), C("c2", { ...sec, fix: "```suggestion\nconst b = 99;\n```" })], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Summary.", comments: [{ id: "c1", also: ["c2"], body: `**must:** token ${token} leaks` }] },
  }), { depth: "full", mode: "loop" });
  assert.equal(r.exit, 0, r.summary);
  const t = threadAt(fx, 2);
  assert.match(t, /\*\*must:\*\* Leak/);
  assert.doesNotMatch(t, /const b = 99/);
  assert.match(t, /Engine note: the suggested code was left out/);
});

test("light depth: no mutant, no fix check, no proof mark or line", async () => {
  const fx = fixture({ "a.test.js": "" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE] } });
  const body = "**must:** off by one\n\n```suggestion\nconst b = 99;\n```";
  const { r } = await go(fx, happy({ compose: { body: "Changes a.", comments: [{ id: "c1", body }] } }));
  assert.equal(r.exit, 0, r.summary);
  assert.equal(existsSync(join(r.runDir, "ctx", "mutants.json")), false);
  assert.equal(existsSync(join(r.runDir, "fixes")), false);
  assert.equal(posts(fx)[0].threads.length, 1);
  assert.match(threadAt(fx, 2), /```suggestion\nconst b = 99;\n```\n\n<!--/);
  assert.doesNotMatch(posts(fx)[0].body, /Proof:/);
});

test("full depth: an answered question posts with the proof status of its finding", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  const first = await go(fx, split(), { mode: "loop", effort: "medium", depth: "full" });
  assert.equal(first.r.exit, 0, first.r.summary);
  const [q] = openQuestions(fx.state);
  assert.equal(q.finding.proven, false);
  answer(fx.state, q.id, "post");
  const again = await go(fx, happy(), { depth: "full" });
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.match(posts(fx)[1].threads[0].body, /off by one[\s\S]*\n\nUnproven: no run in this review shows this case\.\n\n<!--/i);
});

test("full depth: fix checks skip a comment outside the diff", async () => {
  const fx = fixture({ "a.test.js": "x\n" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE], mutants: { max: 1 } } });
  const off = C("c2", { file: "a.test.js", line: 1, lens: "security", title: "Elsewhere" });
  const { r } = await go(fx, happy({ merge: [C("c1"), off], "v~2": [keep("c1"), keep("c2")],
    compose: { body: "Changes a.", comments: [{ id: "c1", body: "**must:** one" }, { id: "c2", body: "**must:** two\n\n```suggestion\ny\n```" }] } }), { depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(existsSync(join(r.runDir, "fixes")), false);
});

test("full depth: no mutant runs at review 3, where no should finding can post", async () => {
  const fx = fixture({ "a.test.js": "" }); routes(fx); trusted(fx);
  userConfig({ review: { checks: [MUTATE] } });
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 2 });
  const { r, run } = await go(fx, happy(), { depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(existsSync(join(r.runDir, "ctx", "mutants.json")), false);
  assert.match(run.calls.find((c) => c.k.startsWith("all")).prompt, /Mutants did not run: review 3 posts no should finding\./);
});

test("a read-only child is never told to run a command, also for a trusted author", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  const { run } = await go(fx, happy(), { lenses: ["correctness"] });
  for (const c of run.calls.filter((x) => x.k.startsWith("all"))) assert.doesNotMatch(c.prompt, /Set `evidence_run` to true/, c.k);
  const fx2 = fixture(); routes(fx2); trusted(fx2);
  const { run: run2 } = await go(fx2, happy());
  assert.match(run2.calls.find((x) => x.k === "all~0").prompt, /Set `evidence_run` to true/, "a shell child is");
});

test("full depth: proof follows a finding by its content, also after a resume that leaves out a dropped seat", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  const fidOf = (o, title) => new RegExp(`"fid": "(f\\w+)"(?:(?!"fid")[\\s\\S])*?"title": "${title}"`).exec(readFileSync(o.promptFile, "utf8"))[1];
  let composed = 0;
  const answers = {
    "all~0": { findings: [F({ title: "Zero", line: 4 })] },
    "all~1": { findings: [F({ title: "Q", line: 2 }), F({ title: "R", line: 3, severity: "should", evidence_run: true })] },
    "all~2": { findings: [] },
    merge: (o) => [C("c1", { title: "Q", found: [S1], members: [fidOf(o, "Q")] }), C("c2", { title: "R", line: 3, severity: "should", found: [S1], members: [fidOf(o, "R")] })],
    "v~0": dropOf("timeout"), "v~2": [drop("c1"), keep("c2")],
    compose: () => { if (!composed++) throw new ChildFailed("judge timeout"); return { body: "Summary.", comments: [{ id: "c1", body: "**must:** q" }, { id: "c2", body: "**should:** r" }] }; },
  };
  const opts = { depth: "full", decide: async () => ({ decision: "agreed", raw: null }) };
  const first = await go(fx, answers, opts);
  assert.equal(first.r.exit, 4, first.r.summary);
  const { r, run } = await go(fx, answers, opts);
  assert.equal(r.exit, 0, r.summary);
  const c1 = agreedInCompose(run).find((x) => x.id === "c1");
  assert.equal(c1.severity, "should", "c1 has no run of its own: R's run does not prove it");
  assert.match(threadAt(fx, 2), /Unproven/);
});

test("full depth: at review 3 an unproven must lowered to should does not post", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  savePrState(fx.state, N, { ...prState(fx.state, N), reviews: 2 });
  const { r } = await go(fx, split(), { decide: async () => ({ decision: "agreed", raw: null }), depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(posts(fx)[0].threads.length, 0);
  assert.notEqual(posts(fx)[0].event, "REQUEST_CHANGES");
});

test("full depth: a `proven` the judge copies into a merge cluster proves nothing", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  const { r, run } = await go(fx, split({ merge: [C("c1", { found: [S0], proven: true })] }), { decide: async () => ({ decision: "agreed", raw: null }), depth: "full" });
  assert.equal(r.exit, 0, r.summary);
  assert.equal(agreedInCompose(run)[0].severity, "should");
  assert.match(threadAt(fx, 2), /Unproven/);
});

test("full depth: a comment held by the secret scan keeps its proof status in the follow-up", async () => {
  const fx = fixture(); routes(fx); trusted(fx);
  const token = "ghp_" + "E".repeat(36);
  const answers = happy({ compose: { body: "Summary.", comments: [{ id: "c1", body: `**must:** token ${token} leaks` }] } });
  await go(fx, answers, { mode: "loop", depth: "full" });
  const [q] = openQuestions(fx.state);
  assert.equal(q.finding.proven, false);
  answer(fx.state, q.id, "post");
  const again = await go(fx, answers, { depth: "full" });
  assert.equal(again.r.exit, 0, again.r.summary);
  assert.match(posts(fx)[1].threads[0].body, /\[REDACTED:github-token\] leaks\n\nUnproven: no run in this review shows this case\.\n\n<!--/);
});
