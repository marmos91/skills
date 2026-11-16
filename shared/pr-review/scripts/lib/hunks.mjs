// Diff hunks and finding placement (spec 6.10 step 3): GitHub rejects a whole review (422)
// when one inline comment sits outside the diff, so only RIGHT-side diff lines go inline.

// shortcut: only \" and \\ escapes are decoded in quoted paths; octal-escaped UTF-8 names stay raw.
const unquote = (s) => (s.startsWith('"') ? s.slice(1, -1).replace(/\\(["\\])/g, "$1") : s);
const stripPrefix = (p) => p.replace(/\t.*$/, "").replace(/^[ab]\//, "");

export function parseHunks(patch) {
  const files = new Map();
  let cur = null; // { path, right, left }
  let oldL = 0, newL = 0, oldN = 0, newN = 0; // next line numbers / remaining counts
  const flush = () => cur && files.set(cur.path, { right: cur.right, left: cur.left });
  for (const line of String(patch).split("\n")) {
    if (oldN > 0 || newN > 0) {
      const c = line[0];
      if (c === "\\") continue;
      if (c === "+") { cur.right.set(newL++, "add"); newN--; continue; }
      if (c === "-") { cur.left.add(oldL++); oldN--; continue; }
      if (c === " " || line === "") { cur.right.set(newL++, "ctx"); oldL++; oldN--; newN--; continue; }
    }
    if (line.startsWith("diff --git ")) {
      flush();
      // Unrenamed paths repeat, so "a/P b/P" splits right even when P holds " b/" (binaries have no +++ line to fix it).
      const m = line.match(/^diff --git a\/(.*) b\/(\1)$/) ?? line.match(/^diff --git (?:"a\/(.*?)"|a\/(.*?)) (?:"b\/(.*?)"|b\/(.*))$/);
      cur = { path: m ? (m[4] ?? m[3] ?? m[2]) : line, right: new Map(), left: new Set(), old: m?.[1] ?? m?.[2] };
    } else if (!cur) continue;
    else if (line.startsWith("rename to ")) cur.path = unquote(line.slice(10));
    else if (line.startsWith("--- ")) cur.old = stripPrefix(unquote(line.slice(4)));
    else if (line.startsWith("+++ ")) {
      const p = unquote(line.slice(4));
      cur.path = p.startsWith("/dev/null") ? cur.old : stripPrefix(p);
    } else {
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (h) { oldL = +h[1]; oldN = h[2] === undefined ? 1 : +h[2]; newL = +h[3]; newN = h[4] === undefined ? 1 : +h[4]; }
    }
  }
  flush();
  return files;
}

// A fence of 3 or more backticks: a suggestion that itself holds ``` needs a longer one.
const FENCE = /^(\s*`{3,})suggestion\b/gm;

/**
 * The fenced code blocks of a comment, by line: { start, end, info, code, closed }. A block closes at a line of
 * at least as many backticks and nothing else; an unclosed block runs to the end (GitHub renders it so).
 */
export function fences(text) {
  const lines = String(text).split("\n"), out = [];
  let open = null;
  lines.forEach((l, i) => {
    const m = /^\s*(`{3,})(.*)$/.exec(l);
    if (!m) return;
    if (!open) open = { start: i, ticks: m[1].length, info: m[2].trim() };
    else if (m[1].length >= open.ticks && !m[2].trim()) { out.push({ start: open.start, end: i, info: open.info, code: lines.slice(open.start + 1, i).join("\n"), closed: true }); open = null; }
  });
  if (open) out.push({ start: open.start, end: lines.length - 1, info: open.info, code: lines.slice(open.start + 1).join("\n"), closed: false });
  return out;
}

/** The diff-line kind of a finding's RIGHT-side line (add or ctx); undefined off the diff. */
export const diffLine = (hunks, file, line) => (line == null ? undefined : hunks.get(file)?.right.get(line));

export function place(findings, hunks, permalinkBase) {
  const inline = [], body = [];
  for (const f of findings) {
    const kind = diffLine(hunks, f.file, f.line);
    if (kind) {
      inline.push({ path: f.file, line: f.line, side: "RIGHT", body: f.body }); // right holds only add/ctx lines
    } else {
      const head = f.body.replace(FENCE, "$1").split("\n")[0];
      body.push(`[\`${f.file}\`](${permalinkBase}/${encodeURI(f.file)}${f.line == null ? "" : `#L${f.line}`}): ${head}`);
    }
  }
  return { inline, body };
}

const FILE_LINE = /`?((?:[\w.-]+\/)*[\w.-]+\.\w+):(\d+)(?:-(\d+))?`?/g;
const RFC = /(?<![[\w/-])RFC ?(\d{3,5})(?:,? ?(?:§|section) ?(\d+(?:\.\d+)*))?/gi;

/**
 * Readable references for posted text (#65): `a.js:42` becomes a permalink at the head when isFile(path),
 * "RFC 9110 §15.3" a link to that section, and no § is left. Fenced code (a suggestion) is left as is.
 */
export function linkRefs(text, permalinkBase, isFile) {
  const lines = String(text).split("\n"), code = new Set();
  for (const b of fences(text)) for (let i = b.start; i <= b.end; i++) code.add(i);
  return lines.map((l, i) => code.has(i) ? l : l
    .replace(FILE_LINE, (m, p, a, b) => (isFile(p) ? `[\`${p}\`](${permalinkBase}/${encodeURI(p)}#L${a}${b ? `-L${b}` : ""})` : m))
    .replace(RFC, (_, n, s) => `[RFC ${n}${s ? `, section ${s}` : ""}](https://www.rfc-editor.org/rfc/rfc${n}${s ? `#section-${s}` : ""})`)
    .replace(/§\s*/g, "section ")).join("\n");
}
