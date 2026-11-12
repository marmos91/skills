import { execFileSync, spawn } from "node:child_process";

const GH_URL = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/;
/** owner/repo of each GitHub remote of the current folder, origin first. */
export function remoteRepos() {
  let lines;
  try { lines = execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.url$"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n"); } catch { return []; }
  lines.sort((a, b) => b.startsWith("remote.origin.url ") - a.startsWith("remote.origin.url "));
  return lines.map((l) => GH_URL.exec(l.split(" ")[1] ?? "")?.[1]).filter(Boolean);
}

export class GhError extends Error {
  constructor(msg, { code, stderr } = {}) { super(msg); this.name = "GhError"; this.code = code; this.stderr = stderr; }
}

const redact = (s) => String(s).replace(/(?:gh[pousr]_|github_pat_)\w+/g, "[redacted]");

function run(args, { input, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.GH_BIN || "gh", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => reject(new GhError(redact(`gh failed to start: ${e.message}`))));
    p.on("close", (code) => {
      if (!okCodes.includes(code)) {
        const err = redact(stderr.trim());
        return reject(new GhError(`gh ${args.slice(0, 3).join(" ")} exited ${code}: ${err}`, { code, stderr: err }));
      }
      resolve({ stdout, code, stderr });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input ?? "");
  });
}

const json = async (args, opts) => JSON.parse((await run(args, opts)).stdout || "null");

async function gql(query, variables = {}) {
  const out = await json(["api", "graphql", "--input", "-"], { input: JSON.stringify({ query, variables }) });
  if (out?.errors?.length) throw new GhError(redact(`graphql: ${out.errors.map((e) => e.message).join("; ")}`));
  return out.data;
}

const split = (repo) => repo.split("/");

export async function viewer() {
  return (await json(["api", "user"])).login;
}

export async function pr(repo, n) {
  const v = await json(["pr", "view", String(n), "-R", repo, "--json", "id,headRefOid,baseRefName,author,isDraft,body,title,closingIssuesReferences,headRefName"]);
  const rest = await json(["api", `repos/${repo}/pulls/${n}`]);
  return {
    id: v.id, headSha: v.headRefOid, baseRef: v.baseRefName, author: v.author?.login,
    authorAssociation: rest.author_association, isDraft: v.isDraft, body: v.body, title: v.title,
    closingIssues: (v.closingIssuesReferences ?? []).map((i) => i.number), headRef: v.headRefName,
  };
}

const THREADS = `query Threads($owner: String!, $name: String!, $n: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved isOutdated viewerCanResolve path line originalLine
        comments(first: 100) { totalCount nodes { databaseId author { login __typename } authorAssociation body createdAt } } }
    } } } }`;

export async function threads(repo, n) {
  const [owner, name] = split(repo), out = [];
  let cursor = null;
  for (;;) {
    const rt = (await gql(THREADS, { owner, name, n, cursor })).repository.pullRequest.reviewThreads;
    for (const t of rt.nodes) {
      out.push({
        id: t.id, isResolved: t.isResolved, isOutdated: t.isOutdated, viewerCanResolve: t.viewerCanResolve, path: t.path, line: t.line, originalLine: t.originalLine, commentCount: t.comments.totalCount ?? t.comments.nodes.length,
        comments: t.comments.nodes.map((c) => ({ id: c.databaseId, author: c.author?.login ?? null, authorType: c.author?.__typename ?? null, authorAssociation: c.authorAssociation ?? null, body: c.body, createdAt: c.createdAt })),
      });
    }
    if (!rt.pageInfo.hasNextPage) return out;
    cursor = rt.pageInfo.endCursor;
  }
}

const PENDING = `query PendingReview($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) { reviews(states: PENDING, first: 10) { nodes { id } } } } }`;

// Pending reviews are visible only to their author, so these are the viewer's.
export async function pendingReview(repo, n) {
  const [owner, name] = split(repo);
  const node = (await gql(PENDING, { owner, name, n })).repository.pullRequest.reviews.nodes[0];
  return node ? { id: node.id } : null;
}

// Every marker key in the viewer's reviews, review comments and PR comments, fully paged (REST --paginate),
// so one post phase checks all its keys in memory and no window of "last 100" can miss one.
export async function markerKeys(repo, n) {
  const me = await viewer(), keys = new Set();
  for (const path of [`repos/${repo}/pulls/${n}/reviews`, `repos/${repo}/pulls/${n}/comments`, `repos/${repo}/issues/${n}/comments`]) {
    for (const r of (await json(["api", "--paginate", "--slurp", path])).flat()) {
      if (r?.user?.login !== me) continue;
      for (const m of String(r.body ?? "").matchAll(/<!-- pr-review [^>]*?\bkey=([0-9a-f]{40})/g)) keys.add(m[1]);
    }
  }
  return keys;
}

// Same full paging as markerKeys: a GraphQL walk caps comments per review at 100, and a missed marker means a duplicate post.
export const findMarker = async (repo, n, key) => (await markerKeys(repo, n)).has(key.replace(/^key=/, ""));

const POST = `mutation PostReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { url } } }`;

export async function postReview(repo, n, { commitOID, event, body, threads: ths = [] }) {
  if (!commitOID) throw new GhError("postReview: commitOID is required");
  const { id } = await pr(repo, n);
  const input = {
    pullRequestId: id, commitOID, event, body,
    threads: ths.map(({ path, line, side = "RIGHT", startLine, startSide, body: b }) => ({
      path, line, side, ...(startLine != null && { startLine, startSide: startSide ?? side }), body: b,
    })),
  };
  const d = await gql(POST, { input });
  return { url: d.addPullRequestReview.pullRequestReview.url };
}

// GitHub has no replies to replies: pass the id of the thread's first comment.
export async function reply(repo, n, commentId, body) {
  return json(["api", "-X", "POST", `repos/${repo}/pulls/${n}/comments/${commentId}/replies`, "--input", "-"], { input: JSON.stringify({ body }) });
}

/** A plain PR comment (not on a line). */
export async function comment(repo, n, body) {
  return json(["api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "--input", "-"], { input: JSON.stringify({ body }) });
}

/** Replaces the body of a review comment. */
export async function editComment(repo, commentId, body) {
  return json(["api", "-X", "PATCH", `repos/${repo}/pulls/comments/${commentId}`, "--input", "-"], { input: JSON.stringify({ body }) });
}

const RESOLVE = `mutation ResolveThread($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;

export async function resolve(threadId) {
  await gql(RESOLVE, { id: threadId });
}

// On public repos every user gets "read", so only "write"/"admin" mean collaborator.
export async function permission(repo, login) {
  try {
    return (await json(["api", `repos/${repo}/collaborators/${login}/permission`])).permission;
  } catch (e) {
    if (e instanceof GhError && /404|Not Found/i.test(e.stderr ?? "")) return "none";
    throw e;
  }
}

export async function searchPRs(repo, who) {
  const byNum = new Map();
  for (const reason of ["author", "review-requested", "reviewed-by", "mentions"]) {
    const rows = await json(["search", "prs", "--repo", repo, "--state", "open", "--draft=false", `--${reason}`, who, "--limit", "100", "--json", "number,title,author,updatedAt"]);
    for (const r of rows) {
      const e = byNum.get(r.number) ?? { number: r.number, title: r.title, author: r.author?.login, updatedAt: r.updatedAt, reasons: [] };
      e.reasons.push(reason);
      byNum.set(r.number, e);
    }
  }
  return [...byNum.values()];
}

const RED = new Set(["fail", "cancel"]), OK = new Set(["pass", "skipping"]);

// gh exits 1 (failed checks) or 8 (pending) with JSON on stdout; exit 1 with empty stdout is "none"
// only when gh says "no checks reported", else it is a real failure (auth, rate limit, network).
export async function checks(repo, n, sha) {
  const head = await json(["pr", "view", String(n), "-R", repo, "--json", "headRefOid,updatedAt"]);
  if (head.headRefOid !== sha) return { state: "pending", since: null, items: [], stale: true }; // head moved: CI of the pinned sha is unknown
  const { stdout, stderr, code } = await run(["pr", "checks", String(n), "-R", repo, "--json", "name,state,link,bucket,startedAt"], { okCodes: [0, 1, 8] });
  let rows = [];
  if (stdout.trim()) rows = JSON.parse(stdout);
  else if (code === 1 && !/no checks reported/i.test(stderr)) throw new GhError(`gh pr checks exited 1: ${redact(stderr.trim())}`, { code, stderr: redact(stderr.trim()) });
  const items = rows.map((r) => ({ name: r.name, state: r.bucket, url: r.link, runId: /\/actions\/runs\/(\d+)/.exec(r.link ?? "")?.[1] ?? null }));
  const pend = rows.filter((r) => !RED.has(r.bucket) && !OK.has(r.bucket));
  const state = !rows.length ? "none" : rows.some((r) => RED.has(r.bucket)) ? "red" : pend.length ? "pending" : "green";
  const starts = pend.map((r) => r.startedAt).filter((t) => t && !t.startsWith("0001")).sort();
  // Queued-only checks have no start time: fall back to the PR's updatedAt.
  return { state, since: state === "pending" ? starts[0] ?? head.updatedAt ?? null : null, items };
}

export async function failedLog(repo, runId, lines = 80) {
  const { stdout } = await run(["run", "view", String(runId), "-R", repo, "--log-failed"]);
  return stdout.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
}
