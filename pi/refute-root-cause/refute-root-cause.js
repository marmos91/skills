// refute-root-cause.js — adversarial panel that tries to KILL a claimed root
// cause before a fix is written. Run via:
//   subagent({ workflowScriptPath: "<this file>", cwd: "<repo>",
//              async: false, timeoutMs: 1200000 })
//
// pi workflowScript calls take no args: edit this CONFIG block per run.

// ---- CONFIG -------------------------------------------------------------
const CONFIG = {
  // The root cause, stated as a falsifiable sentence.
  CLAIM: 'The e02s01 AI-assisted import implementation (heimdall api/import.ts, api/mapping.ts, api/parse.ts) is correct and safe to declare done.',
  // Repro output, logs, file:line anchors.
  EVIDENCE: 'npx tsc --noEmit: 0 errors (strict). node --test api/import.test.ts: 15/15 pass (RFC-4180 parser, coercion boundaries, suggestMapping scoring, transformRows, real-file end-to-end). python3 api/smoke.py against live API on :3001: upload ok (30 headers, 957 rows from the real 49KB roadmap CSV, independently confirmed by python csv), dry-run ok (3 imported, 0 skipped, duplicate detection correctly flags seeds DS3 Bridge/Gateway Operator update v1/Deploy DittoFS). Live commit with force:true: sheet CF-XX keys preserved (CF-03/CF-04 matched seeds, updated via ON CONFLICT (key) DO UPDATE, xmax=0 AS inserted distinguishes create/update).',
  // What someone actually observed (drives the alternatives agent).
  SYMPTOM: 'Reviewer should look for: any correctness bug in the stateless apply flow, transform layer, commitFeatures transaction, or SQL parameterization that tsc and the 15 tests would NOT catch.',
  LENSES: [
    'Control flow: is the claimed-correct path actually reachable with these inputs? Find a guard, an early return, or a caller that never passes this state — e.g. an unmapped header, a mapping flip, a keyless row, a keyless deps row, an unknown field in a confirmed mapping, Mimir unconfigured.',
    'Concurrency and ordering: does the claim survive interleaving, restart, and retry? Two imports racing on the same MAX(SUBSTRING) counter, restart mid-import, rerun with force, two users committing simultaneously — find the interleaving that breaks the counter, the transaction, or the upsert.',
    'Evidence fit: does the test+smoke evidence uniquely support this cause, or would a different failure produce identical output? Name a competing failure mode that fits the same evidence — e.g. a mapping key flip that silently writes the wrong column, a parseQuarter/parseDayFirst boundary that writes a wrong date, an alias that maps the wrong status.',
  ],
}

// A refutation only kills the claim if it produced a concrete counterexample;
// a bare `refuted: true` is a doubt to chase, not a kill.
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['refuted', 'reasoning'],
  properties: {
    refuted: { type: 'boolean' },
    reasoning: { type: 'string' },
    counterexample: { type: 'string', description: 'concrete inputs/state that break the claim, or empty' },
  },
}

// Three refuters in parallel, one lens each.
const refuters = await Promise.all(CONFIG.LENSES.map((lens, i) =>
  runs.run(`refute-${i}`, {
    agent: 'reviewer',
    task:
      `Orient in this repo before reading files (project map / code graph first, then the specific code).\n\n` +
      `CLAIMED ROOT CAUSE: ${CONFIG.CLAIM}\n\n` +
      `EVIDENCE OFFERED: ${CONFIG.EVIDENCE}\n\n` +
      `Your job is to REFUTE this claim through one specific lens. ${lens}\n\n` +
      `Read the actual code. Do not accept the claim because it sounds coherent. If you cannot construct a concrete counterexample after real investigation, set refuted=false — but default to refuted=true when you are genuinely uncertain, and say what you could not rule out.`,
    outputSchema: VERDICT,
    timeoutMs: 900000,
  }).then((r) => (r.structuredOutput || null)).catch(() => null)
))

const votes = refuters.filter(Boolean)
const kills = votes.filter((v) => v.refuted && (v.counterexample || '').trim())
const doubts = votes.filter((v) => v.refuted && !(v.counterexample || '').trim())

// Alternatives agent: ignore the claimed cause, work only from the symptom.
const alternatives = await runs.run('alternatives', {
  agent: 'reviewer',
  task:
    `SYMPTOM: ${CONFIG.SYMPTOM}\nCLAIMED CAUSE: ${CONFIG.CLAIM}\n\n` +
    `Ignore the claimed cause. Working only from the symptom, name every other mechanism in this codebase that would produce it. For each, say what cheap observation would distinguish it from the claimed cause. Return the strongest two, or state plainly that none are plausible.`,
  timeoutMs: 900000,
}).then((r) => r.output || '').catch(() => '')

return {
  // An all-fail panel proves nothing — not the same as a claim that survived
  // real adversarial testing. Check panelFailed before trusting survives.
  panelFailed: votes.length === 0,
  survives: votes.length > 0 && kills.length === 0,
  kills,
  doubts,
  votes,
  alternatives,
}
