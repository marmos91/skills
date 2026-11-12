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
      const m = line.match(/^diff --git (?:"a\/(.*?)"|a\/(.*?)) (?:"b\/(.*?)"|b\/(.*))$/);
      cur = { path: m ? (m[3] ?? m[4]) : line, right: new Map(), left: new Set(), old: m?.[1] ?? m?.[2] };
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

export function place(findings, hunks, permalinkBase) {
  const inline = [], body = [];
  for (const f of findings) {
    const kind = f.line == null ? undefined : hunks.get(f.file)?.right.get(f.line);
    if (kind) {
      inline.push({ path: f.file, line: f.line, side: "RIGHT", body: f.body }); // right holds only add/ctx lines
    } else {
      const head = f.body.replace(FENCE, "$1").split("\n")[0];
      const loc = f.line == null ? "" : `:${f.line}`;
      body.push(`\`${f.file}${loc}\` — ${head} (${permalinkBase}/${f.file}${f.line == null ? "" : `#L${f.line}`})`);
    }
  }
  return { inline, body };
}
