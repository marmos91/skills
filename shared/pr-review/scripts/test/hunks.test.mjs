import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHunks, place } from "../lib/hunks.mjs";

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
  assert.equal(r.body[0], `\`src/a.ts:120\` — first (${base}/src/a.ts#L120)`);
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

test("downgrade fence label when target is not add/ctx", () => {
  // inline only ever holds RIGHT add/ctx, so check the body-preserving helper path via a hunks stub
  const hunks = new Map([["f", { right: new Map([[5, "del"]]), left: new Set() }]]);
  const r = place([{ file: "f", line: 5, body: sug }], hunks, base);
  assert.equal(r.inline[0].body, "Use X\n```\nfoo\n```");
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

test("finding without line goes to body without #L", () => {
  const r = place([{ file: "src/a.ts", line: null, body: "general" }], fx("diff-basic.patch"), base);
  assert.equal(r.body[0], `\`src/a.ts\` — general (${base}/src/a.ts)`);
});
