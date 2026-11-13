// Proven findings (issue #37), full depth only, and only when every author is trusted (the setup rule):
// mutants on the changed lines, run evidence for each finding, and checked fixes. Runs reuse the setup runner
// (worktree cwd, minimal env, time cap, process-group kill, the check's repeat), and the worktree is reset to
// the head before and after each run.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { globMatch } from "./config.mjs";
import { ChildFailed } from "./child.mjs";
import { git } from "./frame.mjs";
import { fences, parseHunks } from "./hunks.mjs";
import { redact } from "./secrets.mjs";
import { TEST_PATHS, checksFor, resetWorktree, runCheck } from "./setup.mjs";
import { done, markDone, writeAtomic } from "./state.mjs";
import { validVotes } from "./tally.mjs";

const OUT_MAX = 2000;
export const UNPROVEN = "Unproven: no run in this review shows this case.";

// Line-level operators, in this order. A line gets 1 mutant, from the first operator that changes it.
// The spaces around an operator keep generics, arrows and Go channels out.
const SWAP = { "===": "!==", "!==": "===", "==": "!=", "!=": "==", "<": "<=", "<=": "<", ">": ">=", ">=": ">", "&&": "||", "||": "&&", true: "false", false: "true" };
export const OPS = [
  ["flip comparison", / (===|!==|==|!=) /, (_, o) => ` ${SWAP[o]} `],
  ["boundary", / (<=|>=|<|>) /, (_, o) => ` ${SWAP[o]} `],
  ["flip logic", / (&&|\|\|) /, (_, o) => ` ${SWAP[o]} `],
  ["negate condition", /\bif \((.+)\)(\s*\{?\s*)$/, (_, c, rest) => `if (!(${c}))${rest}`],
  ["flip boolean", /\b(true|false)\b/, (_, o) => SWAP[o]],
  ["number +1", /(?<![\w.])(\d+)(?![\w.])/, (_, d) => String(Number(d) + 1)],
  ["drop return value", /\breturn\s+[^;]+;/, () => "return;"],
  // a log or print call is not behavior a test should pin
  ["drop statement", /^(\s*)(?!(?:console|log|logger|slog|fmt|t|b)\.|print(?:ln)?\()[\w.$]+\(.*\);?\s*$/, (_, sp) => sp],
];
const SKIP = /^\s*(\/\/|\/\*|\*|#|import\b|package\b|$)/;
// The line comment of each supported language. Other files get no mutant.
const LANG = [
  [/\.(?:[cm]?js|[cm]?ts|jsx|tsx|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|swift|scala|dart)$/i, "//"],
  [/\.(?:py|rb|sh|bash)$/i, "#"],
];
const LITERAL = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*.*?\*\//g;

/**
 * The first operator that changes code on the line, or null. String literals and comments are blanked first,
 * so they never change. shortcut: a line with an open literal or comment (a multi-line string, a Rust
 * lifetime, a JS regex with a quote) gets no mutant; use a tokenizer if real lines are missed too often.
 */
export function mutateLine(text, file) {
  const cm = LANG.find(([re]) => re.test(String(file)))?.[1];
  if (!cm || SKIP.test(text)) return null;
  let bare = text.replace(LITERAL, (m) => " ".repeat(m.length));
  const at = bare.indexOf(cm);
  if (at >= 0) bare = bare.slice(0, at) + " ".repeat(bare.length - at);
  if (/["'`]|\/\*|\*\//.test(bare)) return null;
  for (const [op, re, fn] of OPS) {
    const m = new RegExp(re.source, "d").exec(bare);
    if (!m) continue;
    const groups = m.indices.map((ix) => (ix ? text.slice(ix[0], ix[1]) : undefined));
    const after = text.slice(0, m.index) + fn(...groups) + text.slice(m.index + m[0].length);
    if (after !== text) return { op, after };
  }
  return null;
}

const CLOSE = { "/*": "*/" };
/**
 * The line numbers (1-based) that start inside a multi-line string or block comment: backtick strings and
 * block comments for C-like files, triple quotes for `#` files. Their lines never get a mutant.
 * shortcut: a Rust or C++ raw string and a multi-line "..." string are not tracked; mutateLine still skips
 * their first line.
 */
export function insideLines(text, file) {
  const cm = LANG.find(([re]) => re.test(String(file)))?.[1];
  const toks = [...(cm === "#" ? ['"""', "'''"] : ["`", "/*"]), '"', "'", cm];
  const inside = new Set();
  let open = null, line = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      if (open === '"' || open === "'" || open === cm) open = null;
      if (open) inside.add(line + 1);
      line++;
    } else if (!open) {
      const t = toks.find((x) => x && text.startsWith(x, i));
      if (t) { open = t; i += t.length - 1; }
    } else if (open === cm) continue;
    else if (text[i] === "\\" && open !== "/*" && text[i + 1] !== "\n") i++;
    else if (text.startsWith(CLOSE[open] ?? open, i)) { i += (CLOSE[open] ?? open).length - 1; open = null; }
  }
  return inside;
}

/** The patch whose added lines can get findings: the delta of a later review, else the whole diff. */
export const scopePatch = (f) => join(f.ctxDir, existsSync(join(f.ctxDir, "delta.patch")) ? "delta.patch" : "diff.patch");

const isTest = (p) => TEST_PATHS.some((g) => globMatch(g, p));
const stem = (p) => basename(p).replace(/\..*$/, "");
// The tests of a file: tracked test files in its folder, or named after it in any folder
// (a.go: a_test.go; lib/review.mjs: test/review.test.mjs).
const testsOf = (file, tests) => tests.filter((t) => dirname(t) === dirname(file) || basename(t).startsWith(`${stem(file)}.`) || basename(t).startsWith(`${stem(file)}_`));
const trackedTests = (f) => git(f.worktree, ["ls-files"]).split("\n").filter(isTest);
// The path comes from the PR: a plain file inside the worktree, never a symlink.
function safeFile(wt, file) {
  try {
    const p = join(wt, file);
    return !lstatSync(p).isSymbolicLink() && realpathSync(p).startsWith(realpathSync(wt) + sep) ? p : null;
  } catch { return null; }
}
/**
 * The test command for a file: the first check with mutate: true whose paths match it. It counts only when it
 * runs one of the file's tests: a command without {dirs} runs every test; {dirs} holds the folder of the file
 * and the folder of each of its tests that the check's paths match. -> the check, or null.
 */
function testFor(config, f, file, tests) {
  const own = testsOf(file, tests);
  const name = own.length && checksFor(config, { ...f, changedPaths: [file] }).find((c) => c.mutate)?.name;
  const c = name && checksFor(config, { ...f, changedPaths: [file, ...own] }).find((x) => x.mutate && x.name === name);
  return c && (!c.dirs || own.some((t) => c.dirs.includes(t.includes("/") ? `./${dirname(t)}` : "."))) ? c : null;
}

/**
 * Mutants for the added lines (scopePatch) of changed non-test files that have a test and a test command. At most
 * review.mutants.max. A line must be added by the PR too (diff.patch): after a rebase, delta.patch holds main's lines.
 */
export function planMutants(f, config) {
  const tests = trackedTests(f), pr = parseHunks(readFileSync(join(f.ctxDir, "diff.patch"), "utf8"));
  const plan = [];
  for (const [file, h] of parseHunks(readFileSync(scopePatch(f), "utf8"))) {
    const p = !isTest(file) && safeFile(f.worktree, file);
    const c = p && testFor(config, f, file, tests);
    if (!c) continue;
    const text = readFileSync(p, "utf8"), lines = text.split("\n"), inside = insideLines(text, file);
    for (const [n, kind] of h.right) {
      const m = kind === "add" && pr.get(file)?.right.get(n) === "add" && lines[n - 1] !== undefined && !inside.has(n) && mutateLine(lines[n - 1], file);
      if (m) plan.push({ file, line: n, op: m.op, before: lines[n - 1], after: m.after, name: c.name, command: c.run, repeat: c.repeat, timeout_s: c.timeout_s });
    }
  }
  return plan.slice(0, config.review.mutants.max);
}

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
// A result with a marker is read back, never run again.
async function cached(runDir, stage, key, fn) {
  const file = join(runDir, stage, `${encodeURIComponent(key)}.json`);
  if (done(runDir, stage, key)) return JSON.parse(readFileSync(file, "utf8"));
  const v = await fn();
  if (v?.unchecked) return v; // cut short by the time cap: a resume tries again
  writeAtomic(file, JSON.stringify(v, null, 2) + "\n");
  markDone(runDir, stage, key);
  return v;
}

// From a clean head: writes `text` to `file` (null: no change), runs the check, and resets the worktree after.
async function runWith(f, file, text, c, ms) {
  resetWorktree(f.worktree, f.headSha);
  try {
    if (text !== null) writeFileSync(join(f.worktree, file), text);
    const r = await runCheck({ run: c.command, repeat: c.repeat }, f.worktree, ms);
    return { exit: r.exit, timed_out: r.timedOut, runs: r.runs, output: redact(r.output.slice(-OUT_MAX)) };
  } finally { resetWorktree(f.worktree, f.headSha); }
}
const withLine = (text, n, line) => { const l = text.split("\n"); l.splice(n - 1, 1, ...line.split("\n")); return l.join("\n"); };
// The check at the head, once per command for mutants and fixes alike. A run the total cap cut short is no
// result: it is not cached, and a resume tries again.
const baseline = (f, runDir, c, ms) => cached(runDir, "mutants", `base-${sha1(`${c.command}\0${c.repeat}\0${c.timeout_s}`)}`, async () => {
  const r = await runWith(f, null, null, c, ms);
  return r.timed_out && ms < c.timeout_s * 1000 ? { unchecked: "the time cap ran out" } : r;
});
const headFails = (b) => (b.timed_out ? "the tests time out with no mutant" : b.exit !== 0 ? "the tests fail with no mutant" : null);

/**
 * Runs each planned mutant: survived (every run of the check passes), killed (a run fails) or timeout.
 * A check that fails at the head runs no mutant. Resumable by a marker per run. Results go to ctx/mutants.json.
 */
export async function runMutants(f, config, runDir, log = () => {}) {
  const out = join(f.ctxDir, "mutants.json");
  if (!f.shellOk) return { ran: false, reason: "an author is not trusted", mutants: [] };
  const mutants = [];
  // A failed reset follows the setup rule: logged, no result, and the brief says why. A run stopped by a
  // signal can leave a mutant in the worktree, so a resume starts from the head too.
  try {
    resetWorktree(f.worktree, f.headSha);
    if (done(runDir, "mutants")) return JSON.parse(readFileSync(out, "utf8"));
    const deadline = Date.now() + config.review.mutants.total_s * 1000;
    const left = (m) => Math.min(m.timeout_s * 1000, deadline - Date.now());
    for (const m of planMutants(f, config)) {
      // keyed by the mutant itself: a config edited before a resume never reuses another mutant's run
      const key = sha1(`${m.file}\0${m.line}\0${m.before}\0${m.after}\0${m.command}\0${m.repeat}\0${m.timeout_s}`).slice(0, 16);
      const ran = done(runDir, "mutants", key);
      if (!ran && left(m) <= 0) { mutants.push({ ...m, status: "skipped", reason: "time cap" }); continue; }
      const b = await baseline(f, runDir, m, left(m));
      const why = b.unchecked ? "time cap" : headFails(b);
      if (why) { mutants.push({ ...m, status: "skipped", reason: why }); continue; }
      if (!ran && left(m) <= 0) { mutants.push({ ...m, status: "skipped", reason: "time cap" }); continue; }
      const res = await cached(runDir, "mutants", key, async () => {
        log(`mutant: ${m.file}:${m.line} ${m.op}`);
        const text = readFileSync(join(f.worktree, m.file), "utf8"), ms = left(m);
        const r = await runWith(f, m.file, withLine(text, m.line, m.after), m, ms);
        // the total cap cut it short: no result, and a resume runs it again
        if (r.timed_out && ms < m.timeout_s * 1000) return { unchecked: "the time cap ran out" };
        return { ...m, ...r, status: r.timed_out ? "timeout" : r.exit === 0 ? "survived" : "killed" };
      });
      mutants.push(res.unchecked ? { ...m, status: "skipped", reason: "time cap" } : res);
    }
  } catch (e) {
    if (e instanceof ChildFailed) throw e;
    log(`mutants: worktree reset failed: ${e.message}`);
    return { ran: false, reason: "the worktree reset failed", mutants: [] };
  }
  const result = { ran: true, mutants };
  writeAtomic(out, JSON.stringify(result, null, 2) + "\n");
  markDone(runDir, "mutants");
  return result;
}

/** The brief line the seats get at full depth. */
export function mutantBrief(r, ctxDir) {
  if (!r?.ran) return r ? `Mutants did not run: ${r.reason}.` : "";
  if (!r.mutants.length) return "Mutants: no changed line has a test and a test command.";
  const n = (s) => r.mutants.filter((m) => m.status === s).length, skipped = r.mutants.filter((m) => m.status === "skipped");
  const skip = skipped.length ? `, ${skipped.length} skipped (${skipped[0].reason})` : "";
  if (skipped.length === r.mutants.length) return `Mutants did not run: ${skipped[0].reason}.`;
  return `Mutants: the engine broke ${r.mutants.length - skipped.length} changed lines one at a time and ran their tests: ${n("killed")} caught, ${n("survived")} not caught${skip}. Output: ${join(ctxDir, "mutants.json")}. The engine posts each one not caught as a finding: do not report it again.`;
}

const code = (s) => String(s).trim().replace(/`/g, "'").slice(0, 60);
/** A surviving mutant is a finding: the tests cannot catch a break in this line. Its run is its proof. */
export const mutantFindings = (r) => (r?.mutants ?? []).filter((m) => m.status === "survived").map((m) => ({
  lens: "correctness", severity: "should", file: m.file, line: m.line, symbol: `line ${m.line}`, // 2 equal lines stay 2 findings
  title: `No test catches a break in \`${code(m.before)}\``,
  case: `The engine changed \`${code(m.before)}\` to \`${code(m.after)}\` (${m.op}). \`${m.command}\` still passes.`,
  evidence: `${m.command}: exit 0 with the mutant.\n${m.output.slice(-500)}`,
  fix: "Add a test that fails on this change.", proven: true,
}));

/**
 * Sets `proven` on each agreed finding and holds unproven musts. Run evidence: a member finding of the cluster
 * (merge `members`) with evidence_run from a seat that found it, or a keep vote with evidence_run that the
 * tally counts. An unproven must stays must only when the tally agreed (no drop) or Marco answered; else should.
 * fids: round-1 finding id -> finding with its seat. tallied: [{ cluster (as tallied), votes, status }].
 */
export const isProven = (c, t, fids) => c.proven === true
  || (t ? validVotes(t) : []).some((v) => v.vote === "keep" && v.evidence_run === true)
  // a member counts only as a round-1 finding of this run, from a seat that found the cluster and still counts in
  // the tally, in its lens and file: a wrong id from the judge proves nothing
  || (Array.isArray(c.members) ? c.members : []).some((id) => { const x = fids.get(id); return x?.evidence_run === true && x.lens === c.lens && x.file === c.file && ((t?.cluster ?? c).found ?? []).includes(x.seat); });

export function applyProof(agreed, tallied, fids) {
  const byFp = new Map(tallied.map((t) => [t.cluster.fp, t]));
  for (const c of agreed) {
    const t = byFp.get(c.fp);
    c.proven = isProven(c, t, fids);
    if (!c.proven && c.severity === "must" && !c.answered && t?.status !== "agreed") c.severity = "should";
  }
  return agreed;
}

export const suggestionOf = (body) => fences(body).find((b) => b.closed && /^suggestion\b/.test(b.info));
/**
 * Checks the first `suggestion` block of a comment: applies it at the comment line and runs the file's test
 * command, then the mutants of the file that the tests caught (they must still be caught). A check that
 * fails at the head blames no fix. -> null (nothing to check, untrusted), { unchecked: why } (the time cap ran out),
 * { ok: true }, or { ok: false, why }.
 */
export async function checkFix(f, config, runDir, item, mutants, deadline) {
  if (!f.shellOk) return null;
  const s = suggestionOf(item.body ?? "");
  const p = s && typeof item.line === "number" && safeFile(f.worktree, String(item.file));
  const t = p && testFor(config, f, item.file, trackedTests(f));
  if (!t) return null;
  const c = { command: t.run, repeat: t.repeat, timeout_s: t.timeout_s }, ms = () => Math.min(t.timeout_s * 1000, deadline - Date.now());
  const cut = { unchecked: "the time cap ran out" };
  try {
    if (ms() <= 0) return cut;
    const b = await baseline(f, runDir, c, ms());
    if (b.unchecked) return cut;
    if (headFails(b)) return null;
    if (ms() <= 0) return cut;
    return await cached(runDir, "fixes", sha1([item.fp, item.line, s.code, t.run, t.repeat, t.timeout_s].join("\0")), async () => {
      const text = readFileSync(p, "utf8"), n = text.split("\n").length;
      if (item.line < 1 || item.line > n) return null; // a line past the file would append the code
      const fixed = withLine(text, item.line, s.code), shift = fixed.split("\n").length - n;
      const budget = ms(), r = await runWith(f, item.file, fixed, c, budget);
      if (r.timed_out && budget < t.timeout_s * 1000) return cut; // the total cap cut it short: not the fix's fault
      if (r.exit !== 0 || r.timed_out) return { ok: false, why: `${t.name} ${r.timed_out ? "timed out" : `failed (exit ${r.exit})`} with it` };
      for (const m of mutants.filter((x) => x.status === "killed" && x.file === item.file && x.line !== item.line)) {
        const at = m.line > item.line ? m.line + shift : m.line;
        if (fixed.split("\n")[at - 1] !== m.before) continue;
        if (ms() <= 0) return cut;
        const left = ms(), k = await runWith(f, item.file, withLine(fixed, at, m.after), m, left);
        if (k.timed_out && left < t.timeout_s * 1000) return cut;
        if (k.exit === 0 && !k.timed_out) return { ok: false, why: `the tests no longer catch a break at line ${m.line} with it` };
      }
      return { ok: true };
    });
  } catch (e) {
    if (e instanceof ChildFailed) throw e;
    return null; // best effort: a failed reset or read checks nothing
  }
}

/** A fix the time cap left unchecked keeps its code, with a short engine note. */
export const uncheckedNote = (body, why) => `${body}\n\nEngine note: this fix was not checked, because ${why}.`;

/** A fix that failed its check: the text stays, every code block goes, and a short engine note says why. */
export function directionOnly(body, why) {
  const lines = body.split("\n");
  for (const b of fences(body).reverse()) lines.splice(b.start, b.end - b.start + 1);
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n\nEngine note: the suggested code was left out, because ${why}.`;
}

/** The engine line of the posted summary at full depth. */
export const proofLine = (posted) => `Proof: ${posted.filter((c) => c.proven).length} proven, ${posted.filter((c) => !c.proven).length} unproven.`;
