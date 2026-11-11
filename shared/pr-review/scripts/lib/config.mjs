import { readFileSync, existsSync } from "node:fs";

export const LENSES = ["adversarial", "correctness", "simplification", "architecture", "security"];

const CLAUDE_THINKING = ["low", "medium", "high", "xhigh", "max"];
const PI_THINKING = ["off", "minimal", ...CLAUDE_THINKING];
const HARNESSES = ["claude", "pi", "auto"];

const seat = (harness, model) => ({ harness, model, thinking: "high" });

const DEFAULTS = {
  seats: [seat("claude", "opus"), seat("auto", "cubbit/mimir-pro"), seat("auto", "cubbit/mimir")],
  round1: "per-seat",
  lenses: Object.fromEntries(LENSES.map((l) => [l, { enabled: true }])),
  judge: seat("claude", "opus"),
  decider: { kind: "auto", confidence: 0.5 },
  loop: { authors_ignore: [], max_prs_per_run: 10, max_review_rounds: 3, max_replies_per_thread: 2 },
  review: { guidance: [] },
};

// Repo level may set only these paths; "*" matches one lens name.
const REPO_ALLOWED = ["lenses.*.enabled", "loop.authors_ignore", "loop.max_prs_per_run", "review.guidance"];

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

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
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

function checkSeat(s, where) {
  if (!isObj(s) || !HARNESSES.includes(s.harness) || typeof s.model !== "string" || !s.model) {
    throw new Error(`bad seat in ${where}: need harness (claude|pi|auto) and model`);
  }
  const ok = s.harness === "claude" ? CLAUDE_THINKING : PI_THINKING;
  if (!ok.includes(s.thinking)) throw new Error(`bad thinking "${s.thinking}" for ${s.harness} seat in ${where}: use ${ok.join("|")}`);
}

function validate(c) {
  if (!["per-seat", "per-lens"].includes(c.round1)) throw new Error(`bad round1: ${c.round1}`);
  if (!Array.isArray(c.seats) || !c.seats.length) throw new Error("seats must be a non-empty array");
  c.seats.forEach((s, i) => checkSeat(s, `seats[${i}]`));
  checkSeat(c.judge, "judge");
  for (const [name, l] of Object.entries(c.lenses)) {
    if (!l.seats) continue;
    if (!Array.isArray(l.seats) || l.seats.length < 2) throw new Error(`lens ${name} needs 2 or more seats`);
    l.seats.forEach((s, i) => checkSeat(s, `lenses.${name}.seats[${i}]`));
  }
  if (!["auto", "jev", "off"].includes(c.decider.kind)) throw new Error(`bad decider.kind: ${c.decider.kind}`);
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
    cfg = merge(cfg, repo);
  }
  validate(cfg);
  return cfg;
}

export const seatId = (s) => `${s.harness}:${s.model}`;

export function seatsForLens(config, lens) {
  return config.lenses[lens]?.seats ?? config.seats;
}

export function resolveHarness(s, routerUp) {
  if (s.harness !== "auto") return s.harness;
  if (!s.model.startsWith("cubbit/")) return "claude";
  return routerUp ? "claude" : "pi";
}
