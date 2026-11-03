export const meta = {
  name: 'fix-audit-findings',
  description: 'Plan + execute audit remediation in parallel waves (isolated worktrees), verify, assemble an integration branch',
  phases: [
    { title: 'Parse', detail: 'read report.md, classify, batch by file/area' },
    { title: 'Plan', detail: 'code-architect turns each batch into a fix plan' },
    { title: 'Fix', detail: 'parallel fix agents in worktrees, severity-ordered waves' },
    { title: 'Verify', detail: 'build+test+code-reviewer gate per batch' },
    { title: 'Assemble', detail: 'merge passing worktree branches into one integration branch' },
    { title: 'Harden', detail: 'simplify + add tests + re-audit-vs-plan + final review + linear history' },
  ],
}

const A = (typeof args === 'string' ? JSON.parse(args) : (args || {}))
const repoPath = (A.repoPath) || '.'
const reportPath = (A.reportPath) || `${repoPath}/report.md`
const severities = ((A.severities) || 'HIGH,MED').split(',').map((s) => s.trim().toUpperCase())
const maxParallel = (A.maxParallel) || 6
const issueMap = (A.issueMap) || {}
const branch = `audit-fixes-${(A.branchTag) || 'wave'}`
// Per-role models — cheap tiers for parse/review/git (low-judgement); code-writing
// (fix, simplify+tests) stays on the default/main model (inherited) for quality.
const M = Object.assign({ parse: 'sonnet', plan: 'sonnet', review: 'sonnet', reaudit: 'sonnet', history: 'sonnet', assemble: 'sonnet' }, (A.models) || {})

const BATCHES = {
  type: 'object', additionalProperties: false, required: ['batches'],
  properties: {
    deferred: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'reason'], properties: { title: { type: 'string' }, reason: { type: 'string' } } } },
    batches: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'severity', 'files', 'findings'],
      properties: {
        id: { type: 'string' },
        severity: { type: 'string', enum: ['HIGH', 'MED', 'LOW'] },
        files: { type: 'array', items: { type: 'string' } },     // files this batch will touch (collision key)
        findings: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['title'], properties: { title: { type: 'string' }, where: { type: 'string' }, what: { type: 'string' }, why: { type: 'string' }, fix: { type: 'string' } } } },
      } } },
  },
}
const PLAN = {
  type: 'object', additionalProperties: false, required: ['steps', 'testPlan'],
  properties: { steps: { type: 'string' }, testPlan: { type: 'string' }, risk: { type: 'string' } },
}
const RESULT = {
  type: 'object', additionalProperties: false, required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['landed', 'failed', 'skipped'] },
    summary: { type: 'string' },
    branch: { type: 'string', description: 'worktree branch name with the commits, if landed' },
    testsPass: { type: 'boolean' },
  },
}
const REVIEW = {
  type: 'object', additionalProperties: false, required: ['approve', 'notes'],
  properties: { approve: { type: 'boolean' }, notes: { type: 'string' } },
}

// ---- Parse + classify ---------------------------------------------------
phase('Parse')
const classified = await agent(
  `Read ${reportPath} in repo ${repoPath}. Extract every finding with severity in [${severities.join(', ')}].
Group findings into INDEPENDENT fix batches such that no two batches touch the same source file (so they can be fixed in parallel without collisions). For each batch list the exact files it will modify, its findings (title, where, what=the concrete defect, why=impact, fix=remediation — copy these verbatim from the report so the fix agent has full context), and the max severity.
Put any finding that requires a product/architecture DECISION (not a mechanical fix) into "deferred" with a reason — do not batch it.`,
  { label: 'parse-report', phase: 'Parse', model: M.parse, schema: BATCHES })

let batches = (classified.batches || []).filter((b) => severities.includes(b.severity))
const deferred = classified.deferred || []
// guard against overlap: keep first claimant of each file
const claimed = new Set(); batches = batches.filter((b) => {
  if (b.files.some((f) => claimed.has(f))) return false
  b.files.forEach((f) => claimed.add(f)); return true
})
// --- Cross-session resume: skip batches already landed in a prior run -----
// Signature = sorted file list (deterministic across runs even if batch ids differ).
const FIXCACHE = (A.cacheDir) || `${repoPath}/.audit-cache`
const resume = !(A.fresh)
const sigOf = (b) => (b.files || []).slice().sort().join('|')
let doneSigs = new Set(), priorBranches = []
if (resume) {
  const st = await agent(
    `If ${FIXCACHE}/fix-state.json exists, read and return it; it is {done:[{sig,branch}]}. If missing, return {done:[]}. Do not error.`,
    { label: 'fix-resume-scan', phase: 'Parse', model: M.parse,
      schema: { type: 'object', additionalProperties: false, required: ['done'], properties: { done: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['sig'], properties: { sig: { type: 'string' }, branch: { type: 'string' } } } } } } }).catch(() => ({ done: [] }))
  for (const d of st.done || []) { doneSigs.add(d.sig); if (d.branch) priorBranches.push(d.branch) }
}
const skipped = batches.filter((b) => doneSigs.has(sigOf(b)))
batches = batches.filter((b) => !doneSigs.has(sigOf(b)))
if (skipped.length) log(`Resume: ${skipped.length} batches already landed in a prior run, skipping`)
log(`Parse: ${batches.length} parallelizable batches, ${deferred.length} deferred`)

const refFor = (b) => b.findings.map((f) => issueMap[f.title]).filter(Boolean).map((n) => `Fixes #${n}`).join('\n')

// ---- Plan + Fix + Verify, severity-ordered waves ------------------------
// Pipeline each batch: plan -> fix(worktree) -> review. Severity ordering via wave grouping.
const order = { HIGH: 0, MED: 1, LOW: 2 }
batches.sort((a, b) => order[a.severity] - order[b.severity])

phase('Fix')
const results = await pipeline(
  batches,
  // stage 1: plan
  (b) => agent(
    `Repo ${repoPath}. Plan the fix for batch "${b.id}" (severity ${b.severity}).\nFiles: ${b.files.join(', ')}\nFindings:\n${b.findings.map((f) => `- ${f.title} @ ${f.where || '?'}\n    what: ${f.what || ''}\n    why: ${f.why || ''}\n    fix: ${f.fix || ''}`).join('\n')}\n\nGive concrete steps, the test to add/run that fails-before/passes-after, and risk. If the fix adds or changes a field on a persisted/serialized struct, the plan MUST include updating every backend (memory/badger/postgres) and any storetest conformance fixtures.`,
    { label: `plan:${b.id}`, phase: 'Plan', agentType: 'feature-dev:code-architect', model: M.plan, schema: PLAN })
    .then((plan) => ({ b, plan })).catch(() => null),
  // stage 2: implement in an isolated worktree
  (pb) => pb && agent(
    `Repo ${repoPath}. Implement this fix in your isolated worktree. Read the project's CLAUDE.md and honor its branch/commit/test/lint conventions (sign commits if required, no AI references in messages if forbidden).\n` +
    `Batch ${pb.b.id} (severity ${pb.b.severity}). Files: ${pb.b.files.join(', ')}\nPlan:\n${pb.plan.steps}\nTest plan:\n${pb.plan.testPlan}\n\n` +
    `Steps: (1) add/adjust a test that FAILS against current code. (2) implement the fix. (3) run the project's build + targeted tests; iterate until green. (4) commit atomically with a concise message describing the fix and these trailers if present:\n${refFor(pb.b) || '(no linked issues)'}\n` +
    `DISCIPLINE: (a) Do NOT use \`git stash\` — worktrees share one stash list and it leaks changes between parallel agents; to prove fail-before, revert your own edit in place (or a scratch copy) and re-run, then restore. (b) Stage and commit ONLY the files in this batch — never \`git add -A\`/\`git add .\`. (c) If you add/change a field on a persisted or serialized struct, update ALL its backends (memory/badger/postgres) AND the storetest conformance fixtures, or the conformance suite breaks. (d) Use the default branch name your worktree starts on; do not create extra oddly-named branches.\n` +
    `Report status=landed only if build+tests pass. Return the worktree branch name holding your commits.`,
    { label: `fix:${pb.b.id}`, phase: 'Fix', isolation: 'worktree', schema: RESULT })
    .then((r) => ({ ...pb, result: r })).catch((e) => ({ ...pb, result: { status: 'failed', summary: String(e), testsPass: false } })),
  // stage 3: code-review gate
  (pbr) => {
    if (!pbr || !pbr.result || pbr.result.status !== 'landed') return pbr
    return agent(
      `Review the fix for batch ${pbr.b.id} on branch ${pbr.result.branch} in repo ${repoPath}. Inspect ONLY this branch's changes via \`git diff <default-branch>...${pbr.result.branch}\` (three-dot, merge-base relative) — do NOT run a bare \`git diff\` or diff the working tree; it may carry unrelated uncommitted changes and make you review the WRONG files. Check: does it actually fix the findings (${pbr.b.findings.map((f) => f.title).join('; ')}), is the test meaningful (not a no-op), any regressions or new bugs, conventions honored. Approve only if shippable.`,
      { label: `review:${pbr.b.id}`, phase: 'Verify', agentType: 'feature-dev:code-reviewer', model: M.review, schema: REVIEW })
      .then((rev) => ({ ...pbr, review: rev })).catch(() => ({ ...pbr, review: { approve: false, notes: 'review error' } }))
  }
)

const ok = results.filter((r) => r && r.result && r.result.status === 'landed' && r.review && r.review.approve)
const bad = results.filter((r) => r && (!r.result || r.result.status !== 'landed' || !r.review || !r.review.approve))
log(`Fix waves: ${ok.length} approved, ${bad.length} failed/blocked`)

// ---- Assemble integration branch ---------------------------------------
phase('Assemble')
let assembled = { branch: null, merged: [], conflicts: [] }
const mergeList = ok.map((r) => r.result.branch).concat(priorBranches)   // include prior-session landed branches
if (mergeList.length) {
  assembled = await agent(
    `In repo ${repoPath}: create (or reuse) the integration branch named EXACTLY "${branch}" off the project's DEFAULT branch (do not invent a different name). Do the assembly in a DEDICATED git worktree (e.g. \`git worktree add\`) so you never disturb whatever branch other checkouts of this repo have out. Merge ONLY these explicitly-listed worktree branches into it, in order (do NOT glob \`worktree-*\` — that pulls in stale branches from other runs): ${mergeList.join(', ')}. Some may already be merged from a prior session — skip cleanly if so.
Resolve trivial conflicts; if a branch conflicts non-trivially, skip it and report it under conflicts. After assembly run the project's full build + test suite once. Report the final branch name, which branches merged, and any conflicts/test failures. Do NOT push or open a PR.`,
    { label: 'assemble', phase: 'Assemble', model: M.assemble,
      schema: { type: 'object', additionalProperties: false, required: ['branch', 'merged'],
        properties: { branch: { type: 'string' }, merged: { type: 'array', items: { type: 'string' } },
          conflicts: { type: 'array', items: { type: 'string' } }, testsPass: { type: 'boolean' }, notes: { type: 'string' } } } })
    .catch((e) => ({ branch: null, merged: [], conflicts: [], notes: String(e) }))
  // persist fix-state for cross-session resume (prior done + newly landed)
  if (resume && ok.length) {
    const done = Array.from(doneSigs).map((sig) => ({ sig })).concat(ok.map((r) => ({ sig: sigOf(r.b), branch: r.result.branch })))
    await agent(`Write this JSON to ${FIXCACHE}/fix-state.json (mkdir -p ${FIXCACHE} first), overwriting:\n${JSON.stringify({ done })}`,
      { label: 'persist-fix-state', phase: 'Assemble', model: M.parse }).catch(() => {})
  }
}

// ---- Harden the integration branch before PR ---------------------------
// Read-only checks run in parallel; editing passes run sequentially on the
// shared branch (no collisions); history-linearize runs last.
let harden = { reAudit: null, finalReview: null, simplify: null, tests: null, history: null }
if (assembled.branch) {
  const allFindings = ok.flatMap((r) => r.b.findings.map((f) => f.title))
  // parallel read-only: re-audit-vs-plan + final whole-diff review
  const [reAudit, finalReview] = await parallel([
    () => agent(
      `Inspect the integration branch ${assembled.branch} in repo ${repoPath} via \`git diff <default-branch>...${assembled.branch}\` (three-dot — do NOT diff the working tree, it may carry unrelated uncommitted changes). Confirm the audit fixes actually landed: for EACH original finding, check it is genuinely resolved in that diff (not just claimed) and introduced no regression:\n${allFindings.map((t) => `- ${t}`).join('\n')}\nList any finding still unresolved or any new issue the fixes introduced.`,
      { label: 're-audit-vs-plan', phase: 'Harden', agentType: 'feature-dev:code-reviewer', model: M.reaudit,
        schema: { type: 'object', additionalProperties: false, required: ['allResolved', 'unresolved', 'regressions'],
          properties: { allResolved: { type: 'boolean' }, unresolved: { type: 'array', items: { type: 'string' } }, regressions: { type: 'array', items: { type: 'string' } } } } }).catch(() => null),
    () => agent(
      `Final code review of the integration branch ${assembled.branch} in repo ${repoPath}. Review ONLY \`git diff <default-branch>...${assembled.branch}\` (three-dot, merge-base relative) — do NOT run a bare \`git diff\` or review the working tree; uncommitted/unrelated changes there will make you review the WRONG files and wrongly block the PR. Bugs, security, regressions, convention violations. Approve only if shippable.`,
      { label: 'final-review', phase: 'Harden', agentType: 'feature-dev:code-reviewer', model: M.review,
        schema: { type: 'object', additionalProperties: false, required: ['approve', 'notes'],
          properties: { approve: { type: 'boolean' }, notes: { type: 'string' } } } }).catch(() => null),
  ])
  harden.reAudit = reAudit; harden.finalReview = finalReview

  // sequential editing pass: simplify cleanups + fill useful test gaps, then commit
  harden.simplify = await agent(
    `On branch ${assembled.branch} in repo ${repoPath}: run a SIMPLIFY pass over the integration diff only — reduce complexity, remove duplication/dead code, improve clarity. Quality only, do NOT change behavior. Then ADD any useful missing tests covering the fixed findings and changed code paths. Run the project's build + full test suite; iterate until green. Commit the cleanups and tests (honor CLAUDE.md commit conventions; do NOT use \`git stash\`; stage only files you changed, never \`git add -A\`). Report what you changed and final test status.`,
    { label: 'simplify+tests', phase: 'Harden',
      schema: { type: 'object', additionalProperties: false, required: ['summary', 'testsPass'],
        properties: { summary: { type: 'string' }, testsPass: { type: 'boolean' } } } }).catch((e) => ({ summary: String(e), testsPass: false }))

  // linearize history last
  harden.history = await agent(
    `On branch ${assembled.branch} in repo ${repoPath}: rewrite history to be LINEAR and SIMPLE — rebase onto the default branch, squash fixup/WIP commits into coherent atomic commits (one logical change each, clear concise messages, honor CLAUDE.md: sign if required, no AI references if forbidden). Do NOT push. Report the final commit list.`,
    { label: 'linearize-history', phase: 'Harden', model: M.history,
      schema: { type: 'object', additionalProperties: false, required: ['commits'], properties: { commits: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } } } }).catch((e) => ({ commits: [], notes: String(e) }))
}

return {
  integrationBranch: assembled.branch,
  testsPass: (harden.simplify && harden.simplify.testsPass) ?? assembled.testsPass,
  readyForPR: !!(assembled.branch && harden.finalReview && harden.finalReview.approve &&
    harden.reAudit && harden.reAudit.allResolved && (harden.simplify ? harden.simplify.testsPass : true)),
  landed: ok.map((r) => ({ id: r.b.id, severity: r.b.severity, summary: r.result.summary, findings: r.b.findings.map((f) => f.title) })),
  failed: bad.map((r) => ({ id: r && r.b && r.b.id, why: (r && r.review && r.review.notes) || (r && r.result && r.result.summary) || 'unknown' })),
  conflicts: assembled.conflicts || [],
  deferred,
  harden,
  mergeStrategy: (A.mergeStrategy) || 'squash',
  // main loop uses these to open the PR and close issues
  prRefs: { umbrella: A.umbrellaIssue, fixes: ok.flatMap((r) => r.b.findings.map((f) => issueMap[f.title]).filter(Boolean)) },
}
