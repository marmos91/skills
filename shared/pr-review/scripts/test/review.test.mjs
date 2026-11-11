import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { review } from "../lib/review.mjs";
import { ChildFailed } from "../lib/child.mjs";
import { decide as realDecide } from "../lib/decider.mjs";
import { answer, openQuestions } from "../lib/questions.mjs";
import { stateRoot, prState, savePrState } from "../lib/state.mjs";
import { fingerprint } from "../lib/convergence.mjs";
import * as github from "../lib/github.mjs";

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
const S0 = "claude:opus", S1 = "auto:cubbit/mimir-pro", S2 = "auto:cubbit/mimir";

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (dir, files, msg) => {
  for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
  git(dir, "add", "-A"); git(dir, "commit", "-qm", msg);
  return git(dir, "rev-parse", "HEAD");
};

// origin (bare) with main = base and refs/pull/5/head = head; repoDir is a clone that also names the GitHub remote.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prr-review-"));
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.XDG_CONFIG_HOME = join(root, "config");
  const origin = join(root, "origin.git"), seed = join(root, "seed"), repoDir = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  const base = commit(seed, { "a.js": "const a = 1;\n" }, "base");
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
    "pr view 5 -R o/r --json id,headRefOid,baseRefName,author,isDraft,body,title,closingIssuesReferences": {
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
  const queued = [];
  const r = await review({ repo: REPO, n: N, repoDir: fx.repoDir, runChild: run, decide, routerUp: true, queue: (x) => queued.push(x), ...over });
  return { r, run, queued };
}

test("happy path posts one review with inline comments and the marker", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy());
  assert.equal(r.exit, 0, r.summary);
  const p = posts(fx);
  assert.equal(p.length, 1);
  assert.equal(p[0].commitOID, fx.head);
  assert.equal(p[0].event, "REQUEST_CHANGES");
  assert.match(p[0].body, /^Changes a\. One must item\.\n\n<!-- pr-review run=\S+ sha=[0-9a-f]{40} key=[0-9a-f]{40} -->$/);
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
  assert.equal(r.exit, 0, r.summary);
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

test("own pending review not owned by the run -> skip and queue a note", async () => {
  const fx = fixture(); routes(fx, { pending: { id: "PRR_1" } });
  const { r, queued } = await go(fx, happy());
  assert.equal(r.exit, 0);
  assert.equal(r.skipped, true);
  assert.equal(posts(fx).length, 0);
  assert.deepEqual(queued.map((q) => q.reason), ["pending-review"]);
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
  assert.match(rep.input.body, new RegExp(`^Fixed in \`${fx.head}\`\\.\\n\\n<!-- pr-review `));
  assert.ok(m.some((x) => x.key === "graphql ResolveThread"));
  assert.deepEqual(prState(fx.state, N).resolved, ["T1"]);
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

test("merge clusters with reverses are dropped and recorded; no_tracking reaches compose", async () => {
  const fx = fixture(); routes(fx);
  const { r, run } = await go(fx, happy({
    all: { findings: [F()], no_tracking: true },
    merge: [C("c1"), C("c2", { title: "Add the check back", reverses: "abc" })],
  }));
  assert.equal(r.exit, 0, r.summary);
  const rec = JSON.parse(readFileSync(join(r.runDir, "clusters.json"), "utf8"));
  assert.deepEqual(rec.reversed.map((c) => c.id), ["c2"]);
  assert.ok(!run.calls.find((c) => c.k === "v~2").prompt.includes("Add the check back"));
  assert.match(run.calls.find((c) => c.k === "compose").prompt, /No tracking issue or plan\./);
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
  assert.equal(existsSync(join(fx.state, "lock")), false, "lock released");
  rmSync(join(fake, "all~1.json.hang"));
  const q = cli(["--until", "round1"]);
  assert.equal(await new Promise((res) => q.on("close", res)), 0);
  assert.deepEqual(starts().sort(), ["all~0.json", "all~1.json", "all~1.json"], "all~0 ran once");
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
  assert.equal(r.exit, 0, r.summary);
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
