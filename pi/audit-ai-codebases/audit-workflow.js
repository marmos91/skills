// audit-workflow.js — pi-subagents port of the Claude dynamic workflow
// of the same name. Run via:
//   subagent({ workflowScriptPath: "<this file>", cwd: "<repo>",
//              async: false, timeoutMs: 3000000, maxSubagentSpawnsPerRun: 300,
//              globalConcurrencyLimit: 12 })
//
// pi workflowScript calls take no args: edit this CONFIG block per run.
// NOTE: raw workflowScriptPath scripts have no runs.host/filesystem access —
// nothing persists mid-run. If the run dies after finders, salvage each
// finder's raw findings from the workflow artifacts ({runId}_find-*.md /
// .jsonl under the subagent artifact dir), dedup by (file,line,title), and
// re-run with FINDINGS_SEED set to skip re-finding.

// ---- CONFIG -------------------------------------------------------------
const CONFIG = {
  REPO: null,            // null => workflow cwd
  DEPTH: 'standard',     // quick | standard | deep
  LENSES: null,          // e.g. ['perf','structure','bloat'] => exactly those
  DEEP_ROUNDS: 2,        // DeepWaves baseline rounds (0 disables)
  STACK_GUIDANCE: '',    // stack-skill best-practice text for structure lens
  MAX_FINDER_AGENTS: 120,
  MAX_VERIFY: 300,
  VERIFY_BATCH: 10,
  // Salvage from an interrupted prior run: JSON array of raw findings
  // (each {file,line,title,what,why,fix,area,dimension}) — skips re-finding,
  // goes straight to deep-waves + verify + report.
  FINDINGS_SEED: null,
}

// ---- roles --------------------------------------------------------------
// pi has no per-run model-tier lever in workflowScript children (thinking on
// runs.run opts is ignored at dispatch; per-agent config is deployment policy).
// All children inherit the default model.
const ROLES = {
  probe:     { agent: 'scout' },
  recon:     { agent: 'scout' },
  reference: { agent: 'researcher' },
  finder:    { agent: 'reviewer' },
  report:    { agent: 'worker' },
}

// ---- helpers (plain functions — no nested async) ------------------------
const keyOf = (f) => `${(f && f.file) || ''}:${(f && f.line) || ''}:${(f && f.title) || ''}`.toLowerCase()

const TERSE = '\n\nBe terse caveman-style: drop articles/filler. Keep file:line, exact symbols, and the fix. Fragments OK. No preamble.'

// Retrying child run. A dropped connection costs one attempt, not the cell.
// Plain helper returning runs.run(...) — retried via .then/.catch chains.
function agentR(key, role, task, schema) {
  const opts = () => ({
    agent: ROLES[role].agent,
    task,
    outputSchema: schema || undefined,
    timeoutMs: 900000,
  })
  return runs.run(key, opts())
    .then((r) => (r && r.ok !== false ? r : runs.run(key + '-r1', opts())))
    .catch(() => runs.run(key + '-r2', opts()))
}

// ---- lenses (each wave hunts ONE bug class) -----------------------------
const LENSES = [
  { key: 'bugs',      hunt: 'Logic errors, edge cases, race conditions, nil/None derefs, broken error handling, off-by-one, resource leaks, incorrect concurrency.' },
  { key: 'security',  hunt: 'Injection, hardcoded secrets/keys, missing auth/authz, unsafe deserialization, path traversal, SSRF, vulnerable or hallucinated dependencies.' },
  { key: 'slop',      hunt: 'AI-slop: hallucinated APIs/imports/deps that do not exist, invented functions, fabricated or no-op test assertions, stubs/TODOs passing as done, plausible-but-wrong logic, copy-paste drift.' },
  { key: 'perf',      hunt: 'Performance gaps: hot-path allocations, N+1, O(n^2) where O(n) exists, unbounded buffers, missing streaming/pooling, redundant recomputation, sync work that should be batched.' },
  { key: 'structure', hunt: 'Design-pattern & best-practice violations for the DETECTED language(s)/stack. Judge against established idioms for THIS language — e.g. Go: internal/ vs pkg/ layout, package naming, accept-interfaces/return-structs, error wrapping (%w), context propagation, no naked concurrency; Python: layout, type hints, dataclasses/protocols; TS/JS: module boundaries, no any-soup, proper async. Flag SOLID violations, god objects, leaky abstractions, wrong-layer logic, missing canonical patterns. Cite the idiom/pattern violated.' },
  { key: 'bloat',     hunt: 'Dead code, unused abstractions, speculative generality, duplication, needless indirection, over-engineering typical of AI output.' },
  { key: 'comments',  hunt: 'Useless comments: redundant restatements of code, AI narration ("Now we loop over..."), stale/misleading comments, commented-out code blocks.' },
  { key: 'gaps',      hunt: 'Feature/correctness gaps vs the reference implementation provided in context. What does the real product do that this code omits or gets wrong?' },
]

// ---- schemas ------------------------------------------------------------
const RECON = {
  type: 'object', additionalProperties: false,
  required: ['stack', 'productType', 'sizeClass', 'areas'],
  properties: {
    stack: { type: 'string' },
    productType: { type: 'string' },
    idiomRules: { type: 'string' },
    sizeClass: { type: 'string', enum: ['small', 'medium', 'large'] },
    areas: {
      type: 'array', minItems: 1, maxItems: 40,
      items: { type: 'object', additionalProperties: false, required: ['key', 'path', 'desc'],
        properties: {
          key: { type: 'string' }, path: { type: 'string' }, desc: { type: 'string' },
          importance: { type: 'string', enum: ['critical', 'high', 'normal'] },
        } },
    },
  },
}
const SIZE = {
  type: 'object', additionalProperties: false, required: ['loc', 'sizeClass'],
  properties: { loc: { type: 'integer' }, files: { type: 'integer' }, subsystems: { type: 'integer' },
    sizeClass: { type: 'string', enum: ['small', 'medium', 'large'] } },
}

// Classify LOC into the sizeClass the recon prompt needs.
const classifyLoc = (loc) => (loc > 100_000 ? 'large' : loc < 10_000 ? 'small' : 'medium')
const FINDINGS = {
  type: 'object', additionalProperties: false, required: ['findings'],
  properties: { findings: { type: 'array', maxItems: 60, items: {
    type: 'object', additionalProperties: false,
    required: ['title', 'file', 'line', 'severity', 'what', 'why', 'fix'],
    properties: {
      title: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' },
      severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
      what: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' },
    } } } },
}
const VERDICTS = {
  type: 'object', additionalProperties: false, required: ['verdicts'],
  properties: { verdicts: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['idx', 'real'],
    properties: { idx: { type: 'integer' }, real: { type: 'boolean' }, reachable: { type: 'boolean' },
      severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] }, reason: { type: 'string' } } } } },
}
const REFERENCE = {
  type: 'object', additionalProperties: false, required: ['checklist'],
  properties: { checklist: { type: 'string' }, sources: { type: 'array', items: { type: 'string' } } },
}

// ---- lens selection -----------------------------------------------------
const DEFAULT_PASSES = { quick: 3, standard: 6, deep: 8 }
const requestedPasses = DEFAULT_PASSES[CONFIG.DEPTH] || 6
const selectedLenses = (Array.isArray(CONFIG.LENSES) && CONFIG.LENSES.length)
  ? LENSES.filter((l) => CONFIG.LENSES.includes(l.key))
  : LENSES.slice(0, Math.min(requestedPasses, LENSES.length))
const passes = selectedLenses.length
const MAX_AREAS = Math.max(4, Math.floor(CONFIG.MAX_FINDER_AGENTS / passes))

// =====================================================================
// Phase 1: Recon
// =====================================================================
const repo = CONFIG.REPO || '.'

const sizeR = await agentR('size-probe', 'probe',
  `Quickly size the repository at ${repo}: approximate total source LOC, file count, and distinct top-level modules (exclude vendored/generated/node_modules/.git). Use shell (cloc/find/wc). Classify the repo as small (<~10k LOC), medium, or large (>~100k LOC or many subsystems) and return the metrics with that sizeClass.`,
  SIZE)
// Derive sizeClass from LOC in the script — never trust the probe's label alone.
const sizeProbe = sizeR.structuredOutput || { loc: 0 }
sizeProbe.sizeClass = classifyLoc(sizeProbe.loc || 0)
const big = sizeProbe.sizeClass === 'large'

const reconPrompt =
  `You are auditing the repository at ${repo} (~${sizeProbe.loc} LOC, ${sizeProbe.sizeClass}). Map it for a multi-agent audit.
Detect the full tech stack, frameworks, build tooling. State what this PRODUCT is (one phrase, for a reference search).
List the stack-specific best-practice and project-layout rules to judge structure against.
Partition the codebase into INDEPENDENT, FOCUSED audit areas (by package/module/subsystem). Each area must be small enough for one agent to audit deeply — split large directories; aim for areas under ~3k LOC each. Tag each area's importance (critical/high/normal; entrypoints, data plane, auth, persistence = critical). Cover the whole repo; exclude vendored/generated.
ENUMERATE EVERY MODULE/SUBPROJECT — do NOT partition only the primary/root module. Run \`find ${repo} -name go.mod -not -path '*/vendor/*'\` and look for package.json / Cargo.toml / pyproject.toml workspaces, plus deployment dirs — Dockerfile* / docker-compose* / k8s/ / Helm charts / deploy/. Each secondary module and deployment surface MUST be its own area.` +
  (CONFIG.STACK_GUIDANCE ? `\n\nStack-specific guidance (subsystems/dirs it flags as critical MUST become critical areas):\n${CONFIG.STACK_GUIDANCE}` : ``) +
  (big ? `\n\nThis is a LARGE repo: also note the major subsystem dependencies in each area's desc.` : ``)

const reconR = await agentR('recon-map', 'recon', reconPrompt, RECON)
const recon = reconR.structuredOutput
if (!recon || !Array.isArray(recon.areas) || !recon.areas.length) {
  throw new Error('recon-map failed: no areas returned. Nothing to audit. Re-run when the API is healthy.')
}

// pin deployment/critical areas; drop only non-pinned overflow
const impRank = { critical: 0, high: 1, normal: 2 }
const DEPLOY_RE = /(^|\/)(dockerfile|docker-compose|compose\.ya?ml)|(^|\/)(k8s|kubernetes|chart|charts|helm|deploy|deployment|operator)(\/|$)|operator/i
const isPinned = (a) => a.importance === 'critical' || DEPLOY_RE.test(`${a.path || ''} ${a.key || ''} ${a.desc || ''}`)
const allAreas = recon.areas.slice().sort((a, b) => (isPinned(a) ? -1 : impRank[a.importance] ?? 2) - (isPinned(b) ? -1 : impRank[b.importance] ?? 2))
const pinned = allAreas.filter(isPinned)
const areas = pinned.concat(allAreas.filter((a) => !isPinned(a))).slice(0, Math.max(MAX_AREAS, pinned.length))
const droppedAreas = allAreas.filter((a) => !areas.includes(a))
emit(`Recon: ${recon.stack} — ${areas.length}/${allAreas.length} areas, product="${recon.productType}", ${passes} lenses`)
if (droppedAreas.length) emit(`Dropped non-pinned: ${droppedAreas.map((a) => a.key).join(', ')}`)

// ---- dedup seed (salvaged findings) into the seen-set -------------------
const seen = new Set()
const fresh = []
if (Array.isArray(CONFIG.FINDINGS_SEED)) {
  for (const f of CONFIG.FINDINGS_SEED) {
    const k = keyOf(f)
    if (!seen.has(k)) { seen.add(k); fresh.push({ ...f, severity: f.severity || 'MED' }) }
  }
  emit(`Salvage seed: ${fresh.length} prior findings loaded — finders SKIPPED`)
}

// =====================================================================
// Phase 2: Reference scan
// =====================================================================
let reference = { checklist: '', sources: [] }
if (!CONFIG.FINDINGS_SEED) {
  const refR = await agentR('reference-scan', 'reference',
    `Search the web for the official, canonical, or most popular open-source implementation(s) of this product class: "${recon.productType}" (stack: ${recon.stack}).
Produce an expected-behavior + feature checklist a correct implementation must satisfy, each item with a source URL (spec, RFC, official docs, or reference repo). Focus on things AI-written clones commonly get wrong or omit.`,
    REFERENCE)
  reference = refR.structuredOutput || reference
}

const ctxFor = (lens) =>
  `Repo: ${repo}\nStack: ${recon.stack}\nIdiom rules: ${recon.idiomRules || 'standard for the stack'}` +
  (CONFIG.STACK_GUIDANCE && (lens.key === 'structure' || lens.key === 'bugs' || lens.key === 'slop')
    ? `\nStack-specific best-practice guidance (judge against THIS):\n${CONFIG.STACK_GUIDANCE}` : '') +
  (lens.key === 'gaps' || lens.key === 'structure' ? `\nReference checklist:\n${reference.checklist}` : '')

// =====================================================================
// Phase 3: Audit waves — one lens per wave, one finder per area
// =====================================================================
if (!CONFIG.FINDINGS_SEED) {
  for (const lens of selectedLenses) {
    // one wave = all area finders for this lens, fanned out together
    const pend = areas.map((area, i) => ({
      key: `find-${lens.key}-${i}`,
      promise: agentR(`find-${lens.key}-${i}`, 'finder',
        `${ctxFor(lens)}\n\nAudit ONLY area "${area.key}" (${area.path}): ${area.desc}\n` +
        `Hunt EXCLUSIVELY for this class of issue — ${lens.hunt}\n` +
        `Read the actual source. Report concrete findings with exact file path and line number. Do NOT report issues outside this dimension. If none, return an empty list.` + TERSE,
        FINDINGS)
        .then((r) => (((r.structuredOutput || {}).findings) || []).map((f) => ({ ...f, dimension: lens.key, area: area.key })))
        .catch(() => []),
    }))
    const cells = await Promise.all(pend.map((p) => p.promise))
    for (const fs of cells) {
      for (const f of fs) { const k = keyOf(f); if (!seen.has(k)) { seen.add(k); fresh.push(f) } }
    }
    emit(`Wave ${lens.key}: ${cells.flat().length} findings this wave (${fresh.length} unique total)`)
  }
}

// =====================================================================
// Phase 4: Deep waves — completeness re-hunt (ON BY DEFAULT)
// =====================================================================
let deepRounds = 0
while (deepRounds < CONFIG.DEEP_ROUNDS) {
  deepRounds++
  const critic = await agentR(`deep-wave-${deepRounds}`, 'finder',
    `${areas.map((a) => `${a.key}: ${a.desc}`).join('\n')}\n\n` +
    `An audit already found ${fresh.length} issues across dimensions [${selectedLenses.map((l) => l.key).join(', ')}].\n` +
    `Already-found titles:\n${fresh.slice(0, 60).map((f) => `- ${f.area}/${f.dimension}: ${f.title}`).join('\n')}\n\n` +
    `Find DIFFERENT issues earlier waves missed in repo ${repo}. Look across all dimensions, especially cross-file/integration bugs. Read source. Concrete file:line. Return empty if genuinely none remain.`,
    FINDINGS)
  const add = (((critic.structuredOutput) || { findings: [] }).findings || [])
    .map((f) => ({ ...f, dimension: f.dimension || 'bugs', area: f.area || 'cross' }))
    .filter((f) => { const k = keyOf(f); if (seen.has(k)) return false; seen.add(k); return true })
  if (!add.length) continue
  fresh.push(...add)
  emit(`Deep wave ${deepRounds}: +${add.length} new (total ${fresh.length})`)
}

// =====================================================================
// Phase 5: Adversarial verify — batched skeptics
// =====================================================================
const rank = { HIGH: 0, MED: 1, LOW: 2 }
fresh.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
const toVerify = fresh.slice(0, CONFIG.MAX_VERIFY)
if (fresh.length > toVerify.length) emit(`Verifying top ${toVerify.length}/${fresh.length} by severity`)

const vBatches = []
for (let i = 0; i < toVerify.length; i += CONFIG.VERIFY_BATCH) vBatches.push(toVerify.slice(i, i + CONFIG.VERIFY_BATCH))

const verdictBatches = await Promise.all(vBatches.map((batch, bi) =>
  agentR(`verify-${bi}`, 'finder',
    `Adversarial verify in repo ${repo}. For EACH claim below, READ the actual code and try HARD to REFUTE it. Return a verdict per claim by idx. Set real=true ONLY if ALL THREE hold; otherwise real=false:\n` +
    ` 1. CONFIRMED FROM SOURCE — you opened the file and the described defect is actually present (not a misread, not already handled nearby).\n` +
    ` 2. REACHABLE IN PRODUCTION — the affected function/type/field is constructed or called from a real (non-test) entrypoint. grep for its constructor and callers; if only referenced by tests or otherwise dead/unreachable, set real=false and reachable=false — dead code is a separate 'bloat' concern, NOT a live bug.\n` +
    ` 3. NOT SPEC-CORRECT BEHAVIOR — for protocol/security/interop claims, the current behavior must actually be WRONG versus the protocol spec or the reference implementation, AND changing it must not break documented or conformance-tested behavior.\n` +
    `Default real=false whenever you cannot positively confirm all three. Set reachable=false when criterion 2 fails. Adjust severity if warranted. Put the deciding evidence in reason.\n\nClaims:\n` +
    batch.map((f, j) => `[idx ${j}] (${f.severity} ${f.dimension}) ${f.file}:${f.line} — ${f.title}\n   what: ${f.what}\n   why: ${f.why}`).join('\n') + TERSE,
    VERDICTS)
    .then((r) => (((r.structuredOutput || {}).verdicts) || []).map((v) => {
      const f = batch[v.idx]; if (!f) return null
      return { ...f, severity: v.severity || f.severity, confirmed: !!v.real && v.reachable !== false, verdict: v.reason || '' }
    }).filter(Boolean))
    .catch(() => [])
))

const allVerified = verdictBatches.flat().filter(Boolean)
const confirmed = allVerified.filter((f) => f.confirmed)
confirmed.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
emit(`Verified: ${confirmed.length}/${toVerify.length} confirmed`)

// =====================================================================
// Phase 6: Incremental report — header, then one worker per chunk
// =====================================================================
const REPORT_PATH = `${repo}/report.md`
const sevCount = (s) => confirmed.filter((f) => f.severity === s).length
const dimTable = selectedLenses.map((l) => l.key)
  .concat([...new Set(confirmed.map((f) => f.dimension))].filter((d) => !selectedLenses.some((l) => l.key === d)))
const dimRows = dimTable.map((d) => {
  const sub = confirmed.filter((f) => f.dimension === d)
  return `| ${d} | ${sub.filter((f) => f.severity === 'HIGH').length} | ${sub.filter((f) => f.severity === 'MED').length} | ${sub.filter((f) => f.severity === 'LOW').length} |`
}).join('\n')
const areaCounts = confirmed.reduce((m, f) => ((m[f.area] = (m[f.area] || 0) + 1), m), {})
const areaRows = Object.keys(areaCounts).sort().map((a) => `| ${a} | ${areaCounts[a]} |`).join('\n')

// (1) header
await agentR('report-init', 'report',
  `Write the START of a Markdown audit report to ${REPORT_PATH} using the Write tool (create/overwrite). Write ONLY the header and the two summary tables, ending right after the "## Findings" heading.\n\n` +
  `Exact structure:\n` +
  `# Audit Report — <repo basename> (<short commit sha if \`git -C ${repo} rev-parse --short HEAD\` works, else omit>)\n` +
  `Stack: ${recon.stack} · Areas: ${areas.length} · Findings: ${sevCount('HIGH')} HIGH / ${sevCount('MED')} MED / ${sevCount('LOW')} LOW\n\n` +
  `## Summary by dimension\n\n| Dimension | HIGH | MED | LOW |\n|---|---|---|---|\n${dimRows}\n\n` +
  `## Summary by area\n\n| Area | Findings |\n|---|---|\n${areaRows}\n\n` +
  `## Findings\n\nThen STOP — append no findings. Confirm the path after writing.`)

// (2) chunked appends — strictly serial (concurrent appends corrupt one file)
const REPORT_CHUNK = 15
const chunks = []
for (let i = 0; i < confirmed.length; i += REPORT_CHUNK) chunks.push(confirmed.slice(i, i + REPORT_CHUNK))
for (let ci = 0; ci < chunks.length; ci++) {
  const chunk = chunks[ci]
  const r = await agentR(`report-chunk-${ci}`, 'report',
    `APPEND a Markdown section to the EXISTING file ${REPORT_PATH} (it already has a header and may already have earlier sections). Do NOT overwrite: Read the file, then Write it back with these ${chunk.length} findings appended at the very END.\n\n` +
    `Emit for EACH finding exactly:\n` +
    `### [SEV] <title> · \`<dimension>\` · area: <area>\n- **Where:** \`<file>:<line>\`\n- **What:** <what>\n- **Why it matters:** <why>\n- **Fix:** <fix>\n- **Verified:** <verdict>\n\n` +
    `Findings (JSON):\n${JSON.stringify(chunk)}\n\n` +
    `Preserve order. Add nothing else (no new top-level headings, no summary). Confirm after writing.` + TERSE)
  // A failed chunk agent leaves a HOLE in the report; a retried one that wrote
  // before erroring can DOUBLE-append. Fail loudly instead of shipping either.
  if (r && r.ok === false) throw new Error(`report-chunk-${ci} failed after retries — report at ${REPORT_PATH} is incomplete; re-run to finish.`)
}

// (3) tail: gaps vs reference
if (reference.checklist) {
  const gapsFindings = confirmed.filter((f) => f.dimension === 'gaps')
  await agentR('report-tail', 'report',
    `APPEND a final "## Implementation gaps vs reference" section to the END of the EXISTING file ${REPORT_PATH} (Read it, then Write it back with this section appended — do NOT overwrite). Build a table (expected behavior → our behavior → gap → source URL) from this reference checklist plus any gaps findings.\n\n` +
    `Reference checklist:\n${reference.checklist}\n\nGaps findings (JSON):\n${JSON.stringify(gapsFindings)}\n\n` +
    `Add only this one section. Confirm the path after writing.` + TERSE)
}

// summary back to the orchestrator
const by = (k) => confirmed.reduce((m, f) => ((m[f[k]] = (m[f[k]] || 0) + 1), m), {})
return {
  reportPath: REPORT_PATH,
  stack: recon.stack, productType: recon.productType,
  areas: areas.map((a) => a.key),
  lensesRun: selectedLenses.map((l) => l.key),
  totals: { HIGH: sevCount('HIGH'), MED: sevCount('MED'), LOW: sevCount('LOW') },
  byDimension: by('dimension'), byArea: by('area'),
  findings: confirmed,
}
