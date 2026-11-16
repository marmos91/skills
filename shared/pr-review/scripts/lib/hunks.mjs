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
    const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(l);
    if (!m) return;
    if (!open) open = { start: i, ch: m[1][0], ticks: m[1].length, info: m[2].trim() };
    else if (m[1][0] === open.ch && m[1].length >= open.ticks && !m[2].trim()) { out.push({ start: open.start, end: i, info: open.info, code: lines.slice(open.start + 1, i).join("\n"), closed: true }); open = null; }
  });
  if (open) out.push({ start: open.start, end: lines.length - 1, info: open.info, code: lines.slice(open.start + 1).join("\n"), closed: false });
  return out;
}

/** The diff-line kind of a finding's RIGHT-side line (add or ctx); undefined off the diff. */
export const diffLine = (hunks, file, line) => (line == null ? undefined : hunks.get(file)?.right.get(line));

/**
 * A markdown link to a file (and line) at the head. The label drops characters that end a code span or start
 * markup; the path is percent-encoded per segment, so ( ) # ? stay in the path. A path that climbs out of the
 * tree (a ".." segment) gets no link.
 */
export function codeLink(permalinkBase, file, line, end) {
  const f = String(file), label = `\`${f.replace(/[`[\]<>@\n]/g, "")}\``;
  if (f.split("/").includes("..")) return label;
  const path = f.split("/").map((s) => encodeURIComponent(s).replace(/[()!*']/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
  return `[${label}](${permalinkBase}/${path}${line == null ? "" : `#L${line}${end ? `-L${end}` : ""}`})`;
}

export function place(findings, hunks, permalinkBase) {
  const inline = [], body = [];
  for (const f of findings) {
    const kind = diffLine(hunks, f.file, f.line);
    if (kind) {
      inline.push({ path: f.file, line: f.line, side: "RIGHT", body: f.body }); // right holds only add/ctx lines
    } else {
      const head = f.body.replace(FENCE, "$1").split("\n")[0];
      body.push(`${codeLink(permalinkBase, f.file, f.line)}: ${head}`);
    }
  }
  return { inline, body };
}

const FILE_LINE = /`?((?:[\w.-]+\/)*[\w.-]+\.\w+):(\d+)(?:-(\d+))?`?/g;
const SPAN = /((`+)[^]*?\2(?!`)|\[[^\]]*\]\([^)]*\))/;
const PATH_SPAN = /^`(?:[\w.-]+\/)*[\w.-]+\.\w+:\d+(?:-\d+)?`$/;
const RFC = /(?<![[\w/-])RFC ?(\d{3,5})(?![\w])(?:,? ?(?:§|section) ?(\d+(?:\.\d+)*))?/;
const REF = new RegExp(`${FILE_LINE.source}|${RFC.source}|§\\s*`, "gi");

/**
 * Readable references for posted text (#65): `a.js:42` becomes a permalink at the head when isFile(path),
 * "RFC 9110 §15.3" a link to that section, and no § is left. Fenced code, inline code and links are left as is,
 * except a code span that is exactly `path:line`.
 */
export function linkRefs(text, permalinkBase, isFile) {
  const lines = String(text).split("\n"), code = new Set();
  for (const b of fences(text)) for (let i = b.start; i <= b.end; i++) code.add(i);
  // One pass, so a link built here is never scanned again (a path such as rfc9110.md:3 stays one link).
  const plain = (s) => s.replace(REF, (m, p, a, b, n, sec) =>
    p ? (isFile(p) ? codeLink(permalinkBase, p, a, b) : m)
      : n ? `[RFC ${n}${sec ? `, section ${sec}` : ""}](https://www.rfc-editor.org/rfc/rfc${n}${sec ? `#section-${sec}` : ""})`
        : "section ");
  // split keeps 2 groups per span (the span, its backtick run): parts go text, span, run, text, ...
  return lines.map((l, i) => code.has(i) ? l : l.split(SPAN)
    .map((part, j) => (j % 3 === 2 ? "" : j % 3 === 0 || PATH_SPAN.test(part) ? plain(part ?? "") : part)).join("")).join("\n");
}
