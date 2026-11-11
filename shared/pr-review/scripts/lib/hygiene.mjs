// PR hygiene check (spec 6.3.1): code checks plus one cheap judge-seat child.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EFFORT_AUTO_DEFAULTS, globMatch } from "./config.mjs";
import { PR_DATA_NOTE, git, gitOk, readTree } from "./frame.mjs";
import { hygienePrompt } from "./prompts.mjs";
import { runChild } from "./child.mjs";

const CONVENTIONAL = /^(feat|fix|docs|chore|refactor|test|perf|build|ci|style|revert)(\(.+\))?!?: /;
const LINK_ISSUE = /link(ed)? (an |the )?issue/i;

export function usesConventional(subjects) {
  const s = subjects.slice(0, 50);
  return s.length > 0 && s.filter((x) => CONVENTIONAL.test(x)).length / s.length >= 0.6;
}

const styled = (s) => CONVENTIONAL.test(s) || s.startsWith('Revert "');
const f = (severity, title, c, fix) => ({ lens: "hygiene", severity, title, case: c, fix });

export function hygieneChecks({ title, body, commits, baseSubjects, changedPaths, hasChangelog, guidanceText, closingIssues }) {
  const out = [];
  const conv = usesConventional(baseSubjects);
  if (conv && !styled(title)) out.push(f("should", "PR title does not follow the commit style", "The PR title does not follow Conventional Commits, which the base branch uses.", 'Rename it, for example "feat(scope): short summary".'));
  if (!body.trim()) out.push(f("should", "PR body is empty", "The PR has no description, so a reviewer cannot see the intent.", "Say what changes and why."));
  if (LINK_ISSUE.test(guidanceText) && closingIssues.length === 0) out.push(f("should", "No linked issue", "The repo guidance asks for a linked issue. The PR closes none.", 'Add "Closes #<n>" to the body.'));
  const code = changedPaths.some((p) => !EFFORT_AUTO_DEFAULTS.low_paths.some((g) => globMatch(g, p)));
  if (hasChangelog && code && !changedPaths.includes("CHANGELOG.md")) out.push(f("nit", "CHANGELOG.md not updated", "The repo has a CHANGELOG.md and the PR changes code, but not the changelog.", "Add an entry."));
  const bad = conv ? commits.filter((c) => !styled(c.subject) && !/^Merge /.test(c.subject)) : [];
  if (bad.length) out.push(f("nit", "Commit subjects do not follow the commit style", `${bad.length} commit subject(s) do not follow Conventional Commits. Commits: ${bad.slice(0, 5).map((c) => c.sha.slice(0, 7)).join(", ")}.`, "Reword them, or squash on merge."));
  return out;
}


function unwrap(s, nonce) {
  const head = `<<<PR-DATA-${nonce}\n${PR_DATA_NOTE}\n`, tail = `\nPR-DATA-${nonce}>>>`;
  return typeof s === "string" && s.startsWith(head) && s.endsWith(tail) ? s.slice(head.length, -tail.length) : String(s ?? "");
}

// Returns { findings, warnings }. A failed child is advisory: a warning, not an error.
export async function hygiene(frame, config, effort, { routerUp } = {}) {
  if (!config.hygiene.enabled) return { findings: [], warnings: [] };
  const pr = JSON.parse(readFileSync(join(frame.ctxDir, "pr.json"), "utf8"));
  const un = (s) => unwrap(s, frame.nonce);
  const base = `origin/${frame.baseRef}`;
  let baseSubjects = [];
  try { baseSubjects = git(frame.worktree, ["log", "-50", "--format=%s", base]).split("\n").filter(Boolean); } catch {}
  const findings = hygieneChecks({
    title: un(pr.title), body: un(pr.body), commits: (pr.commits ?? []).map((c) => ({ sha: String(c.sha), subject: un(c.subject) })), baseSubjects,
    changedPaths: frame.changedPaths, hasChangelog: gitOk(frame.worktree, ["cat-file", "-e", `${base}:CHANGELOG.md`]),
    guidanceText: readTree(join(frame.ctxDir, "guidance")), closingIssues: pr.closingIssues ?? [],
  });
  const warnings = [];
  if (effort !== "low") {
    try {
      const runDir = dirname(frame.ctxDir);
      const promptFile = join(runDir, "hygiene-prompt.txt");
      let diffSummary = "";
      try { diffSummary = git(frame.worktree, ["diff", "--stat", `${base}...${frame.headSha}`]).slice(0, 8000); } catch {}
      writeFileSync(promptFile, hygienePrompt(frame, { diffSummary }));
      const j = config.judge;
      const seat = ["off", "minimal", "low"].includes(j.thinking) ? j : { ...j, thinking: "low" };
      const r = await runChild({ seat, tools: "read", promptFile, outFile: join(runDir, "hygiene.json"), worktree: frame.worktree, schema: "hygiene", routerUp });
      findings.push(...r.findings.map((x) => ({ ...x, ask_author: true })));
    } catch {
      warnings.push("hygiene child failed"); // the error text may hold model or PR text
    }
  }
  return { findings, warnings };
}
