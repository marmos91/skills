#!/usr/bin/env node
// report.mjs — assemble the audit document (report) and render one GitHub
// issue body per epic (issues).
//   report.mjs report <state> <repo-name> <worktree-sha> <base-ref>
//   report.mjs issues <state>     -> writes issues/*.md + issues.tsv
import fs from "node:fs";

// argv: <script> <report|issues> <state-dir> [repo-name worktree-sha base-ref]
const mode = process.argv[2];
const state = process.argv[3];
if (!mode || !state) {
    console.error(
        "usage: report.mjs <report|issues> <state-dir> [repo-name sha base-ref]"
    );
    process.exit(2);
}
const R = (p) => `${state}/${p}`;
const read = (p) => fs.readFileSync(R(p), "utf8");
// dies LOUDLY with the named file — corrupt child output is a failed step, never an empty report
const readJ = (p) => {
    try {
        return JSON.parse(read(p));
    } catch (err) {
        console.error(`report: corrupt JSON in ${R(p)}: ${err.message}`);
        process.exit(1);
    }
};

if (mode === "report") {
    const [, , , , repoName, sha, baseRef] = process.argv;
    const findings = readJ("findings.json");
    const epics = readJ("epics.json");
    const refuted = fs.existsSync(R("findings-refuted.json"))
        ? readJ("findings-refuted.json")
        : [];
    const research = fs.existsSync(R("research.md"))
        ? read("research.md")
        : null;

    const n = (s) => (s === "med" ? "MED" : s.toUpperCase());
    const bySev = { high: 0, med: 0, low: 0 };
    for (const f of findings) {
        const s = (f.severity || "low").toLowerCase().startsWith("med")
            ? "med"
            : (f.severity || "").toLowerCase() || "low";
        bySev[s in bySev ? s : "low"] = (bySev[s] ?? 0) + 1;
    }
    const byLens = {};
    for (const f of findings) byLens[f.lens] = (byLens[f.lens] ?? 0) + 1;

    const out = [];
    out.push(`# Audit Report — ${repoName}`);
    out.push("");
    out.push(
        `Audited tree: \`${baseRef}\` @ \`${sha}\` (immutable detached worktree; findings verified by an adversarial gate).`
    );
    out.push("");
    out.push(
        `**${findings.length} verified findings** (${bySev.high} HIGH / ${bySev.med} MED / ${bySev.low} LOW); ${refuted.length} candidate findings were refuted by the verification gate and are excluded (full list in \`findings-refuted.json\`).`
    );
    out.push("");
    out.push("## Summary by lens");
    out.push("");
    out.push("| Lens | Findings |");
    out.push("| --- | --- |");
    for (const [l, c] of Object.entries(byLens).sort((a, b) => b[1] - a[1]))
        out.push(`| ${l} | ${c} |`);
    out.push("");

    out.push("## Roadmap — epics");
    out.push("");
    out.push(
        "Epics are ordered for sequential delivery; `parallelizable` epics with no unmet `depends_on` can run concurrently."
    );
    out.push("");
    const fById = new Map(findings.map((f) => [f.id, f]));
    // topological ordering by depends_on, hardened against epics missing optional fields
    const depsOf = (e) => (Array.isArray(e.depends_on) ? e.depends_on : []);
    const remaining = new Set(epics.map((e) => e.epic));
    const ordered = [];
    const depRank = (e) => depsOf(e).filter((d) => remaining.has(d)).length;
    while (remaining.size) {
        const ready = epics.filter(
            (e) => remaining.has(e.epic) && depRank(e) === 0
        );
        if (!ready.length) break; // cycle — flush the rest
        ready.sort((a, b) => {
            const sevScore = (e) =>
                (e.findings || []).reduce(
                    (acc, id) =>
                        acc +
                        (fById.get(id)?.severity === "high"
                            ? 3
                            : fById.get(id)?.severity === "med"
                              ? 1
                              : 0),
                    0
                );
            return sevScore(b) - sevScore(a);
        });
        for (const e of ready) {
            ordered.push(e);
            remaining.delete(e.epic);
        }
    }
    for (const e of epics.filter((x) => remaining.has(x.epic))) {
        ordered.push(e);
        remaining.delete(e.epic);
    }

    ordered.forEach((e, i) => {
        out.push(`### Epic ${i + 1}: ${e.title}`);
        out.push("");
        out.push(`- **Epic:** \`${e.epic}\``);
        out.push(`- **Goal:** ${e.goal}`);
        const efs = e.findings || [];
        out.push(
            `- **Findings:** ${efs.length}${efs.length ? ` (ids: ${efs.join(", ")})` : ""}`
        );
        out.push(
            `- **Runs:** ${e.parallelizable ? "parallelizable (disjoint territories)" : "sequential"}${(e.depends_on || []).length ? ` — depends on: ${(e.depends_on || []).map((d) => `\`${d}\``).join(", ")}` : ""}`
        );
        out.push("- **Acceptance criteria:**");
        for (const a of e.acceptance || []) out.push(`  - ${a}`);
        out.push("");
        const members = efs.map((id) => fById.get(id)).filter(Boolean);
        for (const f of members) {
            out.push(
                `  - **[${n(f.severity)}] ${f.title}** (\`${f.lens}\`) — \`${f.file}${f.line ? ":" + f.line : ""}\``
            );
            out.push(`    - ${f.what}`);
            if (f.why) out.push(`    - Impact: ${f.why}`);
            if (f.fix) out.push(`    - Fix: ${f.fix}`);
        }
        out.push("");
    });

    if (research) {
        out.push("---");
        out.push("");
        out.push(research.trim());
        out.push("");
    }
    out.push("---");
    out.push("");
    out.push("## All verified findings (flat list)");
    out.push("");
    findings.forEach((f) => {
        out.push(
            `### [${n(f.severity)}] ${f.title || f.what}  · \`${f.lens}\``
        );
        out.push(`- Where: \`${f.file}${f.line ? ":" + f.line : ""}\``);
        out.push(`- What: ${f.what}`);
        out.push(`- Impact: ${f.why}`);
        out.push(`- Fix: ${f.fix}`);
        if (f.verifyEvidence) out.push(`- Verified: ${f.verifyEvidence}`);
        out.push("");
    });
    out.push("## Refuted candidates (not defects — kept for the record)");
    out.push("");
    refuted.forEach((f) => {
        out.push(
            `- \`${f.file}${f.line ? ":" + f.line : ""}\` — ${f.title || f.what}${f.evidence ? ` — refuted: ${f.evidence}` : ""}`
        );
    });
    out.push("");
    process.stdout.write(out.join("\n") + "\n");
    process.exit(0);
}

if (mode === "issues") {
    const epics = readJ("epics.json");
    const findings = fs.existsSync(R("findings.json"))
        ? readJ("findings.json")
        : [];
    const fById = new Map(findings.map((f) => [f.id, f]));
    fs.rmSync(R("issues"), { recursive: true, force: true });
    fs.mkdirSync(R("issues"), { recursive: true });
    const tsv = [];
    epics.forEach((e, i) => {
        const members = e.findings.map((id) => fById.get(id)).filter(Boolean);
        const body = [];
        body.push(`## Goal`);
        body.push("");
        body.push(e.goal || "");
        body.push("");
        body.push(
            `Part of the repo quality audit roadmap (epic ${i + 1} of ${epics.length}).${e.depends_on?.length ? ` Depends on: ${e.depends_on.map((d) => `\`${d}\``).join(", ")}.` : ""} ${e.parallelizable ? "This epic can run in parallel with other parallelizable epics." : "Deliver sequentially."}`
        );
        body.push("");
        body.push("## Findings in scope");
        body.push("");
        for (const f of members) {
            body.push(
                `- [ ] **${(f.severity || "").toUpperCase() || "LOW"} · ${f.title}** — \`${f.file}${f.line ? ":" + f.line : ""}\``
            );
            body.push(`  - ${f.what}`);
            if (f.fix) body.push(`  - Suggested fix: ${f.fix}`);
        }
        if (!members.length)
            body.push("(no mapped findings — triage separately)");
        body.push("");
        body.push("## Acceptance criteria");
        body.push("");
        for (const a of e.acceptance || []) body.push(`- [ ] ${a}`);
        body.push("");
        body.push(
            `_From the repo quality audit (\`${epics.length}\` epics). Roadmap order and dependencies are tracked in the audit report._`
        );
        const fname = `${String(i + 1).padStart(2, "0")}-${e.epic}.md`;
        fs.writeFileSync(R(`issues/${fname}`), body.join("\n") + "\n");
        tsv.push(`${e.epic}\t${e.title}\t${fname}\t${R(`issues/${fname}`)}`);
    });
    fs.writeFileSync(R("issues.tsv"), tsv.join("\n") + "\n");
    console.log(`rendered ${epics.length} issue bodies in ${R("issues")}`);
    process.exit(0);
}

console.error(
    "usage: report.mjs <report|issues> <state> [repo-name sha base-ref]"
);
process.exit(2);
