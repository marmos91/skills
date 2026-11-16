import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { codeLink, fences, linkRefs, parseHunks, place } from "../lib/hunks.mjs";

const fx = (n) => parseHunks(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const base = "https://github.com/o/r/blob/abc";
const sug = "Use X\n```suggestion\nfoo\n```";

test("parses multiple files, hunks, omitted counts, spaced paths", () => {
  const h = fx("diff-basic.patch");
  const a = h.get("src/a.ts");
  assert.deepEqual([...a.right], [[1, "ctx"], [2, "add"], [3, "add"], [4, "ctx"], [5, "ctx"], [51, "ctx"], [52, "add"], [53, "ctx"]]);
  assert.deepEqual([...a.left], [2, 51]);
  assert.deepEqual([...h.get("one.txt").right], [[1, "add"]]);
  assert.deepEqual([...h.get("dir/x y.txt").right], [[2, "ctx"], [3, "add"], [4, "ctx"]]);
});

test("line inside a hunk -> inline", () => {
  const r = place([{ file: "src/a.ts", line: 2, body: "bad" }], fx("diff-basic.patch"), base);
  assert.deepEqual(r, { inline: [{ path: "src/a.ts", line: 2, side: "RIGHT", body: "bad" }], body: [] });
});

test("line outside any hunk -> body with permalink", () => {
  const r = place([{ file: "src/a.ts", line: 120, body: "first\nsecond" }], fx("diff-basic.patch"), base);
  assert.equal(r.inline.length, 0);
  assert.equal(r.body[0], `[\`src/a.ts\`](${base}/src/a.ts#L120): first`);
});

test("deleted file / LEFT-only line -> body; new file lines inline", () => {
  const h = fx("diff-newdel.patch");
  assert.equal(h.get("gone.txt").right.size, 0);
  assert.deepEqual([...h.get("gone.txt").left], [1, 2]);
  const r = place([{ file: "gone.txt", line: 1, body: "x" }, { file: "added.txt", line: 2, body: "y" }], h, base);
  assert.equal(r.body.length, 1);
  assert.equal(r.inline[0].path, "added.txt");
});

test("suggestion on a removed line is downgraded; kept on add/ctx", () => {
  const h = fx("diff-basic.patch");
  const kept = place([{ file: "src/a.ts", line: 2, body: sug }], h, base).inline[0].body;
  assert.match(kept, /```suggestion/);
  const ctx = place([{ file: "src/a.ts", line: 1, body: sug }], h, base).inline[0].body;
  assert.match(ctx, /```suggestion/);
  const out = place([{ file: "src/a.ts", line: 120, body: sug }], h, base);
  assert.equal(out.inline.length, 0);
  const noop = place([{ file: "gone.txt", line: 1, body: sug }], fx("diff-newdel.patch"), base);
  assert.doesNotMatch(noop.body[0], /suggestion/);
});

test("a suggestion placed in the body loses its suggestion label", () => {
  const r = place([{ file: "gone.txt", line: 9, body: sug }], new Map(), base);
  assert.doesNotMatch(r.body[0], /suggestion/);
});

test("renamed file uses the new path", () => {
  const h = fx("diff-rename.patch");
  assert.ok(h.has("new/name.js") && !h.has("old/name.js"));
  assert.equal(h.get("new/name.js").right.get(2), "add");
});

test("binary file has no lines; no-newline markers ignored", () => {
  const h = fx("diff-binary.patch");
  assert.equal(h.get("img.png").right.size, 0);
  assert.deepEqual([...h.get("f.txt").right], [[1, "ctx"], [2, "add"]]);
  assert.deepEqual([...h.get("f.txt").left], [2]);
});

test("binary file whose path holds \" b/\" keeps its full path", () => {
  const h = parseHunks("diff --git a/x b/y.png b/x b/y.png\nindex 111..222 100644\nBinary files a/x b/y.png and b/x b/y.png differ\n");
  assert.deepEqual([...h.keys()], ["x b/y.png"]);
});

test("finding without line goes to body without #L", () => {
  const r = place([{ file: "src/a.ts", line: null, body: "general" }], fx("diff-basic.patch"), base);
  assert.equal(r.body[0], `[\`src/a.ts\`](${base}/src/a.ts): general`);
});

test("a longer suggestion fence is downgraded too", () => {
  const r = place([{ file: "gone.txt", line: 9, body: "````suggestion\na\n````" }], new Map(), base);
  assert.doesNotMatch(r.body[0], /suggestion/);
});

test("linkRefs turns file:line into a permalink and an RFC section into a link, with no section sign; code is left as is", () => {
  const isFile = (p) => p === "src/a.ts";
  const out = linkRefs("See `src/a.ts:12` and src/a.ts:3-5, not example.com:443. RFC 9110 §15.3 and [RFC 7230](https://x/rfc7230).\n```suggestion\nconst s = \"§1\"; // src/a.ts:12\n```", base, isFile);
  assert.equal(out, `See [\`src/a.ts\`](${base}/src/a.ts#L12) and [\`src/a.ts\`](${base}/src/a.ts#L3-L5), not example.com:443. [RFC 9110, section 15.3](https://www.rfc-editor.org/rfc/rfc9110#section-15.3) and [RFC 7230](https://x/rfc7230).\n\`\`\`suggestion\nconst s = "§1"; // src/a.ts:12\n\`\`\``);
  assert.equal(linkRefs("see spec §6.4", base, isFile), "see spec section 6.4");
});

test("linkRefs leaves inline code, links and ~~~ fences as they are, but links a span that is only path:line", () => {
  const isFile = (p) => p === "lib/a.js";
  for (const t of ['the separator `"§"` in `split("§")`', "run `node lib/a.js:3`", "see [lib/a.js:12](u)", "see the `RFC 9110` spec", "~~~js\n// lib/a.js:12 §2\n~~~"]) {
    assert.equal(linkRefs(t, base, isFile), t, t);
  }
  assert.equal(linkRefs("in `lib/a.js:3` here", base, isFile), `in [\`lib/a.js\`](${base}/lib/a.js#L3) here`);
});

test("fences: ~~~ opens a block that only ~~~ closes", () => {
  assert.deepEqual(fences("~~~\n```\nx\n~~~").map((b) => [b.start, b.end, b.closed]), [[0, 3, true]]);
});

test("linkRefs leaves an RFC name inside an identifier and a double-backtick code span as they are", () => {
  const isFile = (p) => p === "a.js";
  for (const t of ["format it with time.RFC3339Nano, not RFC1123Z", "see RFC 1234567", "``use `a.js:3` here``"]) assert.equal(linkRefs(t, base, isFile), t, t);
  assert.match(linkRefs("see RFC 3339.", base, isFile), /^see \[RFC 3339\]\(https:\/\/www\.rfc-editor\.org\/rfc\/rfc3339\)\.$/);
});

test("an off-diff permalink escapes the file: ( ) # in the path, markup in the label, no link out of the tree", () => {
  const r = place([{ file: "docs/Guide (v2).md", line: 3, body: "x" }, { file: "we#ird.md", line: 1, body: "y" }], new Map(), base);
  assert.deepEqual(r.body, [`[\`docs/Guide (v2).md\`](${base}/docs/Guide%20%28v2%29.md#L3): x`, `[\`we#ird.md\`](${base}/we%23ird.md#L1): y`]);
  assert.equal(codeLink(base, "x` [docs](https://evil.example) `y.js", 1), `[\`x docs(https://evil.example) y.js\`](${base}/x%60%20%5Bdocs%5D%28https%3A//evil.example%29%20%60y.js#L1)`);
  assert.equal(codeLink(base, "../../../../evil/repo/blob/main/README.md", 1), "`../../../../evil/repo/blob/main/README.md`");
});

test("linkRefs never rewrites a link it built: a path that starts with rfcNNNN stays one link", () => {
  assert.equal(linkRefs("rfc9110.md:3 and §2", base, (p) => p === "rfc9110.md"), `[\`rfc9110.md\`](${base}/rfc9110.md#L3) and section 2`);
});
