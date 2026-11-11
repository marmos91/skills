import { spawn } from "node:child_process";

export class GhError extends Error {
  constructor(msg, { code, stderr } = {}) { super(msg); this.name = "GhError"; this.code = code; this.stderr = stderr; }
}

const redact = (s) => String(s).replace(/gh[pousr]_\w+/g, "[redacted]");

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
  const v = await json(["pr", "view", String(n), "-R", repo, "--json", "id,headRefOid,baseRefName,author,isDraft,body,title,closingIssuesReferences"]);
  const rest = await json(["api", `repos/${repo}/pulls/${n}`]);
  return {
    id: v.id, headSha: v.headRefOid, baseRef: v.baseRefName, author: v.author?.login,
    authorAssociation: rest.author_association, isDraft: v.isDraft, body: v.body, title: v.title,
    closingIssues: (v.closingIssuesReferences ?? []).map((i) => i.number),
  };
}

const THREADS = `query Threads($owner: String!, $name: String!, $n: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    reviewThreads(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id isResolved viewerCanResolve path line
        comments(first: 100) { nodes { databaseId author { login __typename } body createdAt } } }
    } } } }`;

export async function threads(repo, n) {
  const [owner, name] = split(repo), out = [];
  let cursor = null;
  for (;;) {
    const rt = (await gql(THREADS, { owner, name, n, cursor })).repository.pullRequest.reviewThreads;
    for (const t of rt.nodes) {
      out.push({
        id: t.id, isResolved: t.isResolved, viewerCanResolve: t.viewerCanResolve, path: t.path, line: t.line,
        comments: t.comments.nodes.map((c) => ({ id: c.databaseId, author: c.author?.login ?? null, authorType: c.author?.__typename ?? null, body: c.body, createdAt: c.createdAt })),
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

const MARKERS = `query Markers($owner: String!, $name: String!, $n: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $n) {
    comments(last: 100) { nodes { body author { login } } }
    reviews(last: 50) { nodes { body author { login } comments(first: 100) { nodes { body author { login } } } } }
  } } }`;

export async function findMarker(repo, n, key) {
  const [owner, name] = split(repo);
  const d = await gql(MARKERS, { owner, name, n });
  const me = d.viewer.login, p = d.repository.pullRequest;
  const bodies = [...p.comments.nodes, ...p.reviews.nodes, ...p.reviews.nodes.flatMap((r) => r.comments.nodes)];
  return bodies.some((c) => c.author?.login === me && String(c.body ?? "").includes(key));
}

const POST = `mutation PostReview($input: AddPullRequestReviewInput!) {
  addPullRequestReview(input: $input) { pullRequestReview { url } } }`;

export async function postReview(repo, n, { commitOID, event, body, threads: ths = [] }) {
  const { id } = await pr(repo, n);
  const input = {
    pullRequestId: id, commitOID, event, body,
    threads: ths.map(({ path, line, side = "RIGHT", body: b }) => ({ path, line, side, body: b })),
  };
  const d = await gql(POST, { input });
  return { url: d.addPullRequestReview.pullRequestReview.url };
}

export async function reply(repo, n, commentId, body) {
  return json(["api", "-X", "POST", `repos/${repo}/pulls/${n}/comments/${commentId}/replies`, "--input", "-"], { input: JSON.stringify({ body }) });
}

const RESOLVE = `mutation ResolveThread($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } } }`;

export async function resolve(threadId) {
  await gql(RESOLVE, { id: threadId });
}

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

// sha is accepted for the engine's API; `gh pr checks` always reads the current head.
// gh exits 1 (failed checks), 8 (pending) or 1 with "no checks reported"; stdout still holds JSON except in the last case.
export async function checks(repo, n, _sha) {
  let rows;
  try {
    const { stdout } = await run(["pr", "checks", String(n), "-R", repo, "--json", "name,state,link,bucket,startedAt"], { okCodes: [0, 1, 8] });
    rows = stdout.trim() ? JSON.parse(stdout) : [];
  } catch (e) {
    if (e instanceof GhError && /no checks reported/i.test(e.stderr ?? "")) rows = [];
    else throw e;
  }
  const items = rows.map((r) => ({ name: r.name, state: r.bucket, url: r.link, runId: /\/actions\/runs\/(\d+)/.exec(r.link ?? "")?.[1] ?? null }));
  const pend = rows.filter((r) => !RED.has(r.bucket) && !OK.has(r.bucket));
  const state = !rows.length ? "none" : rows.some((r) => RED.has(r.bucket)) ? "red" : pend.length ? "pending" : "green";
  const starts = pend.map((r) => r.startedAt).filter((t) => t && !t.startsWith("0001")).sort();
  return { state, since: state === "pending" && starts.length ? starts[0] : null, items };
}

export async function failedLog(repo, runId, lines = 80) {
  const { stdout } = await run(["run", "view", String(runId), "-R", repo, "--log-failed"]);
  return stdout.replace(/\n+$/, "").split("\n").slice(-lines).join("\n");
}
