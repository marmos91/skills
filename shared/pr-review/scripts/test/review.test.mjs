import test from "node:test";
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
const markerRoute = (field, nodes = []) => ({ stdout: { data: { viewer: { login: ME }, repository: { pullRequest: { [field]: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes } } } } } });

function routes(fx, { head = fx.head, body = "Changes a.", threads = [], pending = null, postExit = 0, reviews = [] } = {}) {
  const r = {
    "api user": { stdout: { login: ME } },
    "pr view 5 -R o/r --json id,headRefOid,baseRefName,author,isDraft,body,title,closingIssuesReferences": {
      stdout: { id: "PR_1", headRefOid: head, baseRefName: "main", author: { login: "alice" }, isDraft: false, body, title: "feat: change a", closingIssuesReferences: [] },
    },
    "api repos/o/r/pulls/5": { stdout: { author_association: "CONTRIBUTOR" } },
    "api --paginate --slurp repos/o/r/pulls/5/reviews": { stdout: [[]] },
    "api --paginate --slurp repos/o/r/issues/5/comments": { stdout: [[]] },
    "graphql Threads": threadsRoute(threads),
    "pr view 5 -R o/r --json headRefOid,updatedAt": { stdout: { headRefOid: head, updatedAt: "2026-11-11T00:00:00Z" } },
    "pr checks 5 -R o/r --json name,state,link,bucket,startedAt": { stderr: "no checks reported on the 'feat' branch", exit: 1 },
    "graphql MarkerComments": markerRoute("comments"),
    "graphql MarkerReviews": markerRoute("reviews", reviews),
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
  assert.match(p[0].threads[0].body, /^\*\*must:\*\* off by one\n\n<!-- pr-review run=.* key=[0-9a-f]{40} -->$/);
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
  routes(fx, { reviews: [{ body: posts(fx)[0].body, author: { login: ME }, comments: { nodes: [] } }] });
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
  routes(fx, { reviews: [{ body: sent[0].body, author: { login: ME }, comments: { nodes: [] } }] });
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
  assert.match(run.calls.find((c) => c.k === "compose").prompt, /1 point is still open with the reviewer/);
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
  assert.match(q[0].sides.drop, /secret pattern/);
  assert.ok(!JSON.stringify(q).includes(token));
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
