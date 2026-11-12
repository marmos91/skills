import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The user config file, read from the environment at call time. */
export const userConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pr-review", "config.json");

export const LENSES = ["adversarial", "correctness", "simplification", "architecture", "security"];

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
  loop: { authors_ignore: [], max_prs_per_run: 10, max_review_rounds: 3, max_replies_per_thread: 2, effort: "auto", ci_wait_minutes: 30 },
  // max_turns and timeout_minutes: defaults for every child; a seat or a lens may set its own.
  review: { guidance: [], ci: "use", max_diff_lines: 3000, max_turns: 40, timeout_minutes: 10 },
  hygiene: { enabled: true },
};

// Repo level may set only these paths; "*" matches one lens name.
const REPO_ALLOWED = ["lenses.*.enabled", "loop.authors_ignore", "loop.max_prs_per_run", "review.guidance", "effort_auto.high_paths", "hygiene.enabled"];

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
  if (t === undefined) return;
  need(isObj(t), `${where}.thinking_by_stage`, "an object");
  for (const [k, v] of Object.entries(t)) {
    need(stages.includes(k), `${where}.thinking_by_stage.${k}`, `a stage: ${stages.join(", ")}`);
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

function validate(c) {
  need(["per-seat", "per-lens"].includes(c.round1), "round1", "per-seat or per-lens");
  need(Array.isArray(c.seats) && c.seats.length > 0, "seats", "a non-empty array");
  c.seats.forEach((s, i) => checkSeat(s, `seats[${i}]`));
  checkSeat(c.judge, "judge");
  need(isObj(c.lenses), "lenses", "an object");
  for (const [name, l] of Object.entries(c.lenses)) {
    need(LENSES.includes(name), `lenses.${name}`, `a known lens (${LENSES.join(", ")})`);
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
  for (const k of ["max_prs_per_run", "max_review_rounds", "max_replies_per_thread", "ci_wait_minutes"]) need(posInt(c.loop[k]), `loop.${k}`, "a positive integer");
  need(EFFORT_VALUES.includes(c.effort), "effort", `one of ${EFFORT_VALUES.join("|")}`);
  need(EFFORT_VALUES.includes(c.loop.effort), "loop.effort", `one of ${EFFORT_VALUES.join("|")}`);
  need(isObj(c.effort_auto), "effort_auto", "an object");
  for (const k of ["high_paths", "low_paths"]) need(strList(c.effort_auto[k]), `effort_auto.${k}`, "an array of strings");
  need(isObj(c.review) && strList(c.review.guidance), "review.guidance", "an array of strings");
  need(["use", "ignore"].includes(c.review.ci), "review.ci", "use or ignore");
  need(isObj(c.hygiene) && typeof c.hygiene.enabled === "boolean", "hygiene.enabled", "a boolean");
  for (const k of ["max_diff_lines", "max_turns", "timeout_minutes"]) need(posInt(c.review[k]), `review.${k}`, "a positive integer");
}

export function loadConfig({ userPath, repoText, cliPath } = {}) {
  let cfg = structuredClone(DEFAULTS);
  const path = cliPath ?? userPath;
  // A missing --config file is an error; a missing user file is not.
  if (cliPath && !existsSync(cliPath)) throw new Error(`config file not found: ${cliPath}`);
  if (path && existsSync(path)) cfg = merge(cfg, parse(readFileSync(path, "utf8"), path));
  if (repoText) {
    const repo = parse(repoText, ".pr-review.json");
    checkRepoKeys(repo);
    const extra = repo.effort_auto?.high_paths;
    if (extra !== undefined) need(strList(extra), "effort_auto.high_paths", "an array of strings");
    const userHigh = cfg.effort_auto.high_paths;
    cfg = merge(cfg, repo);
    // The repo may only add high_paths; arrays normally replace.
    if (extra) cfg.effort_auto.high_paths = [...userHigh, ...extra];
  }
  validate(cfg);
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
    ? s.thinking_by_stage?.[STAGE_KEY[stage]] ?? config.lenses[lens]?.thinking_by_stage?.[STAGE_KEY[stage]]
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

// Children for one PR: round 1 + one vote per distinct seat + 2 judge calls.
// A lens with its own seats runs in its own children in per-seat mode.
export function plannedChildren(config, lenses) {
  const all = new Set();
  let round1 = 0;
  const shared = new Set();
  for (const l of lenses) {
    const seats = seatsForLens(config, l);
    seats.forEach((s) => all.add(seatId(s)));
    if (config.round1 === "per-lens") round1 += seats.length;
    else if (config.lenses[l]?.seats) round1 += seats.length;
    else seats.forEach((s) => shared.add(seatId(s)));
  }
  return round1 + shared.size + all.size + 2;
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
