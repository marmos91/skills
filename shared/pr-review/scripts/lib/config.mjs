import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The user config file, read from the environment at call time. */
export const userConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pr-review", "config.json");

export const LENSES = ["adversarial", "correctness", "simplification", "architecture", "security"];
/** The user lens folder, next to the user config. */
export const userLensDir = () => join(dirname(userConfigPath()), "lenses");
/** The file of a lens: built-in, else a user lens. */
export const lensFile = (name) => join(LENSES.includes(name) ? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lenses") : userLensDir(), `${name}.md`);
// Lenses about design across files: on a split PR they review the whole PR once, not part by part.
export const WHOLE_PR_LENSES = ["architecture"];

const CLAUDE_THINKING = ["low", "medium", "high", "xhigh", "max"];
const PI_THINKING = ["off", "minimal", ...CLAUDE_THINKING];
const HARNESSES = ["claude", "pi", "auto"];

export const EFFORTS = ["low", "medium", "high", "max"];
const EFFORT_VALUES = [...EFFORTS, "auto"];

// Default `auto` effort patterns (spec 5.1). Whole-path globs; see globMatch.
export const EFFORT_AUTO_DEFAULTS = {
  high_paths: [
    "**/auth/**", "**/*auth*.*", "**/crypto/**", "**/*crypto*.*", "**/security/**",
    "**/*permission*.*", "**/*secret*.*", "**/migrations/**", "**/*.sql",
    ".github/workflows/**", "**/Dockerfile*", "**/*.tf", "**/k8s/**", "**/helm/**", "**/infra/**",
  ],
  low_paths: [
    "**/*.md", "docs/**", "**/*.txt", "**/*.lock", "**/package-lock.json", "**/pnpm-lock.yaml",
    "**/*.png", "**/*.jpg", "**/*.svg",
  ],
};

const seat = (harness, model, thinking) => ({ harness, model, thinking, max_turns: 40, timeout_minutes: 15 });

export const DEFAULTS = {
  effort: "medium",
  effort_auto: EFFORT_AUTO_DEFAULTS,
  seats: [seat("claude", "opus", "high"), seat("auto", "cubbit/mimir", "medium"), seat("auto", "cubbit/mimir-pro", "medium")],
  round1: "per-seat",
  lenses: Object.fromEntries(LENSES.map((l) => [l, { enabled: true }])),
  judge: { harness: "claude", model: "opus", thinking: "high" },
  decider: { kind: "auto", confidence: 0 },
  loop: { authors_ignore: [], max_prs_per_run: 10, max_parallel_prs: 3, max_review_rounds: 3, max_replies_per_thread: 2, effort: "auto", ci_wait_minutes: 30 },
  // max_turns and timeout_minutes: defaults for every child; a seat or a lens may set its own.
  // A diff above chunk_lines splits into parts that round 1 reviews one by one; max_children caps the cost of a PR,
  // and max_parallel the round-1 children that run at once.
  // depth: light|full|auto (setup.mjs). checks: null = the built-in Go checks when go.mod is at the root.
  // core_paths has no default: auto asks for it once per repo.
  review: { guidance: [], ci: "use", max_diff_lines: 6000, chunk_lines: 500, max_children: 60, max_parallel: 9, max_turns: 40, timeout_minutes: 10, depth: "light", checks: null,
    // mutants (proof.mjs): at most max mutants, total_s for all of them (and again for the fix checks). Each run
    // keeps the repeat and timeout_s of its check.
    mutants: { max: 20, total_s: 900 } },
  hygiene: { enabled: true },
  // pr-respond: the review rounds on your own PR before it stops and reports
  respond: { max_rounds: 5 },
};

// Repo level may set only these paths; "*" matches one lens name.
const REPO_ALLOWED = ["lenses.*.enabled", "loop.authors_ignore", "loop.max_prs_per_run", "review.guidance", "review.core_paths", "effort_auto.high_paths", "hygiene.enabled"];

// Strip // comments outside of strings.
export function stripComments(text) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === "\\") out += text[++i] ?? "";
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else out += ch;
  }
  return out;
}

const UNSAFE = new Set(["__proto__", "constructor", "prototype"]);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (UNSAFE.has(k)) continue;
    out[k] = Object.hasOwn(base, k) ? merge(base[k], v) : v;
  }
  return out;
}

function parse(text, label) {
  try {
    return JSON.parse(stripComments(text));
  } catch (e) {
    throw new Error(`invalid JSON in ${label}: ${e.message}`);
  }
}

function checkRepoKeys(obj, path = "") {
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    const pat = p.replace(/^lenses\.[^.]+/, "lenses.*");
    if (REPO_ALLOWED.includes(pat)) continue;
    if (isObj(v) && REPO_ALLOWED.some((a) => a.startsWith(pat + "."))) checkRepoKeys(v, p);
    else throw new Error(`config key not allowed at repo level: ${p}`);
  }
}

const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
const posInt = (v) => Number.isInteger(v) && v > 0;

function need(ok, path, what) {
  if (!ok) throw new Error(`${path} must be ${what}`);
}

function checkStages(t, where, ok, label = "", stages = ["round1", "vote", "merge"]) {
  const list = stages.length > 1 ? `${stages.slice(0, -1).join(", ")} or ${stages.at(-1)}` : stages[0];
  if (t === undefined) return;
  need(isObj(t), `${where}.thinking_by_stage`, "an object");
  for (const [k, v] of Object.entries(t)) {
    need(stages.includes(k), `${where}.thinking_by_stage.${k}`, `a stage: ${list}`);
    need(ok.includes(v), `${where}.thinking_by_stage.${k}${label}`, `one of ${ok.join("|")}`);
  }
}

function checkSeat(s, where) {
  need(isObj(s), where, "an object");
  need(s.id === undefined || (typeof s.id === "string" && s.id), `${where}.id`, "a non-empty string");
  need(HARNESSES.includes(s.harness), `${where}.harness`, "claude, pi or auto");
  need(typeof s.model === "string" && s.model, `${where}.model`, "a non-empty string");
  need(s.provider === undefined || typeof s.provider === "string", `${where}.provider`, "a string");
  const ok = s.harness === "claude" ? CLAUDE_THINKING : PI_THINKING;
  need(ok.includes(s.thinking), `${where}.thinking (${s.harness} seat)`, `one of ${ok.join("|")}`);
  checkStages(s.thinking_by_stage, where, ok, ` (${s.harness} seat)`);
  for (const k of ["max_turns", "timeout_minutes"]) need(s[k] === undefined || posInt(s[k]), `${where}.${k}`, "a positive integer");
}

// Built-in lenses, and names with a meaning in child keys (all~0, v~0, merge, compose) or on Object.prototype.
const RESERVED = [...LENSES, "hygiene", "all", "v", "merge", "compose", "constructor", "prototype"];
// User lenses: <dir>/<name>.md. Only the user folder: a repo cannot add prompt text.
function userLenses(dir) {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith(".")).map((f) => f.slice(0, -3)).sort();
  for (const name of names) {
    const file = join(dir, `${name}.md`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`lens file ${file}: the name must use only a-z, 0-9 and -`);
    if (RESERVED.includes(name)) throw new Error(`lens file ${file}: ${name} is a built-in or reserved name; use a different name`);
  }
  return names;
}

/** What is wrong with the content of a user lens file (the size cap of a built-in lens), or null. */
export function lensFileProblem(dir, name) {
  const file = join(dir, `${name}.md`);
  let text;
  try { text = readFileSync(file, "utf8").trim(); } catch (e) { return `lens file ${file}: ${e.message}`; }
  if (!text) return `lens file ${file}: the file is empty`;
  if (text.split("\n").length > 40 || text.length > 4000) return `lens file ${file}: over 40 lines or 4000 characters`;
  return null;
}

function validate(c, known) {
  need(["per-seat", "per-lens"].includes(c.round1), "round1", "per-seat or per-lens");
  need(Array.isArray(c.seats) && c.seats.length > 0, "seats", "a non-empty array");
  c.seats.forEach((s, i) => checkSeat(s, `seats[${i}]`));
  checkSeat(c.judge, "judge");
  need(isObj(c.lenses), "lenses", "an object");
  for (const [name, l] of Object.entries(c.lenses)) {
    need(known.includes(name), `lenses.${name}`, `a known lens (${known.join(", ")})`);
    need(isObj(l), `lenses.${name}`, "an object");
    need(typeof l.enabled === "boolean", `lenses.${name}.enabled`, "a boolean");
    need(l.max_turns === undefined || posInt(l.max_turns), `lenses.${name}.max_turns`, "a positive integer");
    // Only round-1 children belong to one lens; claude children map off and minimal to low.
    checkStages(l.thinking_by_stage, `lenses.${name}`, PI_THINKING, "", ["round1"]);
    if (l.seats === undefined) continue;
    if (!Array.isArray(l.seats) || l.seats.length < 2) throw new Error(`lens ${name} needs 2 or more seats`);
    l.seats.forEach((s, i) => checkSeat(s, `lenses.${name}.seats[${i}]`));
  }
  need(isObj(c.decider), "decider", "an object");
  need(["auto", "jev", "off"].includes(c.decider.kind), "decider.kind", "auto, jev or off");
  need(typeof c.decider.confidence === "number" && c.decider.confidence >= 0 && c.decider.confidence <= 1, "decider.confidence", "a number in [0,1]");
  need(isObj(c.loop), "loop", "an object");
  need(strList(c.loop.authors_ignore), "loop.authors_ignore", "an array of strings");
  for (const k of ["max_prs_per_run", "max_parallel_prs", "max_review_rounds", "max_replies_per_thread", "ci_wait_minutes"]) need(posInt(c.loop[k]), `loop.${k}`, "a positive integer");
  need(EFFORT_VALUES.includes(c.effort), "effort", `one of ${EFFORT_VALUES.join("|")}`);
  need(EFFORT_VALUES.includes(c.loop.effort), "loop.effort", `one of ${EFFORT_VALUES.join("|")}`);
  need(isObj(c.effort_auto), "effort_auto", "an object");
  for (const k of ["high_paths", "low_paths"]) need(strList(c.effort_auto[k]), `effort_auto.${k}`, "an array of strings");
  need(isObj(c.review) && strList(c.review.guidance), "review.guidance", "an array of strings");
  need(["use", "ignore"].includes(c.review.ci), "review.ci", "use or ignore");
  need(isObj(c.hygiene) && typeof c.hygiene.enabled === "boolean", "hygiene.enabled", "a boolean");
  need(isObj(c.respond) && posInt(c.respond.max_rounds), "respond.max_rounds", "a positive integer");
  need(["light", "full", "auto"].includes(c.review.depth), "review.depth", "light, full or auto");
  need(c.review.core_paths === undefined || strList(c.review.core_paths), "review.core_paths", "an array of strings");
  need(c.review.checks === null || Array.isArray(c.review.checks), "review.checks", "an array");
  (c.review.checks ?? []).forEach((x, i) => {
    const w = `review.checks[${i}]`;
    need(isObj(x) && typeof x.name === "string" && x.name, `${w}.name`, "a non-empty string");
    need(typeof x.run === "string" && x.run, `${w}.run`, "a non-empty string");
    need(x.paths === undefined || strList(x.paths), `${w}.paths`, "an array of strings");
    for (const k of ["repeat", "timeout_s"]) need(x[k] === undefined || posInt(x[k]), `${w}.${k}`, "a positive integer");
    need(x.mutate === undefined || typeof x.mutate === "boolean", `${w}.mutate`, "a boolean");
  });
  need(isObj(c.review.mutants), "review.mutants", "an object");
  for (const k of ["max", "total_s"]) need(posInt(c.review.mutants[k]), `review.mutants.${k}`, "a positive integer");
  for (const k of ["max_diff_lines", "chunk_lines", "max_children", "max_parallel", "max_turns", "timeout_minutes"]) need(posInt(c.review[k]), `review.${k}`, "a positive integer");
}

/** The config of this user: config file, lens folder, and the optional --config file and repo text. */
export const loadUserConfig = (o = {}) => loadConfig({ userPath: userConfigPath(), lensDir: userLensDir(), ...o });

export function loadConfig({ userPath, repoText, cliPath, lensDir } = {}) {
  let cfg = structuredClone(DEFAULTS);
  const mine = lensDir ? userLenses(lensDir) : [];
  const known = [...LENSES, ...mine];
  for (const l of known) cfg.lenses[l] ??= { enabled: true };
  const path = cliPath ?? userPath;
  // A missing --config file is an error; a missing user file is not.
  if (cliPath && !existsSync(cliPath)) throw new Error(`config file not found: ${cliPath}`);
  if (path && existsSync(path)) {
    const user = parse(readFileSync(path, "utf8"), path);
    // One value per repo: a user-level list would hide every saved answer of `pr-review config core-paths`.
    if (user?.review?.core_paths !== undefined) throw new Error(`review.core_paths is per repo: set it with pr-review config core-paths <owner/repo>, or in the repo's .pr-review.json (${path})`);
    cfg = merge(cfg, user);
  }
  if (repoText) {
    const repo = parse(repoText, ".pr-review.json");
    checkRepoKeys(repo);
    // A repo may name a lens that this reviewer does not have: turning it off is then a no-op.
    // A repo may only turn a lens off: enabled true is ignored, so a lens the user turned off stays off.
    if (isObj(repo.lenses)) for (const [k, l] of Object.entries(repo.lenses)) {
      if (!known.includes(k)) delete repo.lenses[k];
      else if (isObj(l) && l.enabled === true) delete l.enabled;
    }
    const extra = repo.effort_auto?.high_paths;
    if (extra !== undefined) need(strList(extra), "effort_auto.high_paths", "an array of strings");
    const userHigh = cfg.effort_auto.high_paths;
    cfg = merge(cfg, repo);
    // The repo may only add high_paths; arrays normally replace.
    if (extra) cfg.effort_auto.high_paths = [...userHigh, ...extra];
  }
  validate(cfg, known);
  // A lens that is off is never read, so a bad file of its own does not stop the run (doctor warns).
  for (const n of mine) if (cfg.lenses[n].enabled) { const p = lensFileProblem(lensDir, n); if (p) throw new Error(p); }
  assignIds(cfg.seats, "seats");
  assignIds([cfg.judge], "judge");
  for (const [name, l] of Object.entries(cfg.lenses)) if (l.seats) assignIds(l.seats, `lenses.${name}.seats`);
  return cfg;
}

// Each seat gets a unique id: its own `id`, else harness:model, with #2, #3 for later seats on the same model.
// Two seats on one model are two independent seats (their finds and votes count apart): that is the user's choice.
// A lens list is numbered on its own, so its seats share ids (and votes) with the council seats of the same model.
function assignIds(list, where) {
  const taken = new Set();
  for (const s of list) if (s.id !== undefined) { need(!taken.has(s.id), `${where} id ${s.id}`, "unique"); taken.add(s.id); }
  for (const s of list) {
    if (s.id !== undefined) continue;
    let id = `${s.harness}:${s.model}`;
    for (let n = 2; taken.has(id); n++) id = `${s.harness}:${s.model}#${n}`;
    taken.add((s.id = id));
  }
}

/** A seat's identity (voters, tally, dropped seats, run.json). Seats built outside loadConfig fall back to harness:model. */
export const seatId = (s) => s.id ?? `${s.harness}:${s.model}`;

const STAGE_KEY = { round1: "round1", round2: "vote", vote: "vote", merge: "merge" };

/**
 * The seat for one child. Limits: the seat's own, then the lens's max_turns, then review.max_turns / review.timeout_minutes.
 * thinking for round1, vote (round2) and merge: seat thinking_by_stage, then lens thinking_by_stage (round1 only), then the default:
 * a cubbit seat (Mimir) thinks only in round 1, where it pays off; every other seat keeps its one level.
 */
export const withLimits = (config, s, lens, stage) => ({
  ...s,
  thinking: STAGE_KEY[stage]
    ? s.thinking_by_stage?.[STAGE_KEY[stage]] ?? (stage === "round1" ? config.lenses[lens]?.thinking_by_stage?.round1 : undefined)
      ?? (s.harness !== "claude" && s.model.startsWith("cubbit/") && STAGE_KEY[stage] !== "round1" ? "off" : s.thinking)
    : s.thinking,
  max_turns: s.max_turns ?? config.lenses[lens]?.max_turns ?? config.review.max_turns,
  timeout_minutes: s.timeout_minutes ?? config.review.timeout_minutes,
});

export function seatsForLens(config, lens) {
  return config.lenses[lens]?.seats ?? config.seats;
}

export function resolveHarness(s, routerUp) {
  if (s.harness !== "auto") return s.harness;
  if (!s.model.startsWith("cubbit/")) return "claude";
  return routerUp ? "claude" : "pi";
}

const RANK = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PROFILES = {
  low: { n: 2, round1: "per-seat", cap: "low", post: { severities: ["must", "should"], maxFindings: 5 } },
  medium: { n: 3, round1: "per-seat", cap: "medium", post: { severities: ["must", "should", "nit"], maxFindings: 10 } },
  high: { n: 3, round1: "per-lens", cap: "high", post: { severities: ["must", "should", "nit"], maxFindings: 20 } },
  max: { n: Infinity, round1: "per-lens", cap: null, post: { severities: ["must", "should", "nit"], maxFindings: null } },
};

function checkEffort(e) {
  if (!EFFORTS.includes(e)) throw new Error(`effort must be one of ${EFFORTS.join("|")} (resolve auto with pickEffort first), got ${e}`);
}

// Returns a new config; never mutates the input.
export function applyEffort(config, effort) {
  checkEffort(effort);
  const p = PROFILES[effort];
  const cap = (t) => (p.cap && RANK.indexOf(t) > RANK.indexOf(p.cap) ? p.cap : t);
  const capStages = (t) => t && Object.fromEntries(Object.entries(t).map(([k, v]) => [k, cap(v)]));
  const capSeat = (s) => ({ ...s, thinking: cap(s.thinking), ...(s.thinking_by_stage && { thinking_by_stage: capStages(s.thinking_by_stage) }) });
  const c = structuredClone(config);
  c.seats = c.seats.slice(0, p.n).map(capSeat);
  c.judge = capSeat(c.judge);
  for (const l of Object.values(c.lenses)) {
    if (l.seats) l.seats = l.seats.map(capSeat);
    if (l.thinking_by_stage) l.thinking_by_stage = capStages(l.thinking_by_stage);
  }
  c.round1 = p.round1;
  c.post = structuredClone(p.post);
  return c;
}

export function lowerEffort(effort) {
  checkEffort(effort);
  return EFFORTS[Math.max(0, EFFORTS.indexOf(effort) - 1)];
}

// Children for one PR: round 1 (one set per diff part) + one vote per distinct seat + 2 judge calls.
// A lens with its own seats runs in its own children in per-seat mode.
export function plannedChildren(config, lenses, parts = 1) {
  const all = new Set(), shared = new Set(), sharedLenses = [];
  // A job's children: one per part for its local lenses, plus one for its whole-PR lenses.
  const times = (ls) => (parts === 1 ? 1 : (ls.some((l) => !WHOLE_PR_LENSES.includes(l)) ? parts : 0) + (ls.some((l) => WHOLE_PR_LENSES.includes(l)) ? 1 : 0));
  let round1 = 0;
  for (const l of lenses) {
    const seats = seatsForLens(config, l);
    seats.forEach((s) => all.add(seatId(s)));
    if (config.round1 === "per-lens" || config.lenses[l]?.seats) round1 += seats.length * times([l]);
    else { seats.forEach((s) => shared.add(seatId(s))); sharedLenses.push(l); }
  }
  return round1 + shared.size * times(sharedLenses) + all.size + 2;
}

// Whole-path glob: `**` spans directories (or none), `*` and `?` stay in one segment. Case-insensitive (Dockerfile, .PNG).
export function globMatch(glob, path) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { re += "(?:.*/)?"; i += 2; }
      else if (re.endsWith("/")) { re = re.slice(0, -1) + "(?:/.*)?"; i += 1; }
      else { re += ".*"; i += 1; }
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i").test(path);
}

export function pickEffort(changedPaths, config) {
  const { high_paths, low_paths } = config.effort_auto;
  const any = (globs, p) => globs.some((g) => globMatch(g, p));
  if (changedPaths.some((p) => any(high_paths, p))) return "high";
  if (changedPaths.length > 0 && changedPaths.every((p) => any(low_paths, p))) return "low";
  return "medium";
}
