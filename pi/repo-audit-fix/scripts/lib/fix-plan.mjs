#!/usr/bin/env node
// fix-plan.mjs <audit-state-dir> <out-file> <gh-issues.tsv|null>
// Stage 1 of repo-audit-fix: turn the audit artifacts (epics.json, findings.json)
// into a fix plan: for every epic, embed its findings (id, file, what, why, fix),
// resolve the GH issue number by exact-title match, and compute dependency waves
// (topological batches). Severities drive ordering inside a wave.
import fs from "node:fs";

const parseOrDie = (p) => {
    try {
        return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
        console.error(`fix-plan: corrupt JSON in ${p}: ${err.message}`);
        process.exit(1);
    }
};

const [stateDir, outFile, ghTsv] = process.argv.slice(2);
if (!stateDir || !outFile) {
    console.error(
        "usage: fix-plan.mjs <audit-state-dir> <out-file> [gh-issues.tsv]"
    );
    process.exit(2);
}

const epics = parseOrDie(`${stateDir}/epics.json`);
const findings = parseOrDie(`${stateDir}/findings.json`);
const byId = new Map(findings.map((f) => [f.id, f]));

// optional GH issue map: pairs [<number>, "<title>"] from `gh issue list
// --jq '.[] | [.number, .title]'`. matchAll scans EVERY pair (line-shaped or
// pretty-printed) so a jq format change can't silently zero the map.
const issueByTitle = new Map();
if (ghTsv && fs.existsSync(ghTsv)) {
    const text = fs.readFileSync(ghTsv, "utf8");
    const pair = /\[\s*(\d+)\s*,\s*"((?:[^"\\]|\\.)*)"\s*\]/g;
    for (const m of text.matchAll(pair)) {
        issueByTitle.set(m[2], m[1] * 1);
    }
    if (issueByTitle.size === 0 && text.trim() !== "") {
        console.error(
            "fix-plan: WARNING issue map present but unparsed — PRs will lack Fixes refs"
        );
    }
}

const names = new Set(epics.map((e) => e.epic));
const depsOf = new Map(
    epics.map((e) => [e.epic, (e.depends_on || []).filter((d) => names.has(d))])
);

// topological waves; a cycle should never happen, but fail loudly not silently
const placed = new Set();
const waves = [];
let guard = 0;
while (placed.size < epics.length) {
    const wave = [...names]
        .filter(
            (n) => !placed.has(n) && depsOf.get(n).every((d) => placed.has(d))
        )
        .sort((a, b) => a.localeCompare(b));
    if (!wave.length) {
        console.error(
            `fix-plan: dependency cycle among ${[...names].filter((n) => !placed.has(n)).join(", ")}`
        );
        process.exit(1);
    }
    if (++guard > 200) {
        console.error("fix-plan: guard tripped");
        process.exit(1);
    }
    wave.forEach((w) => {
        placed.add(w);
    });
    waves.push(wave);
}
const waveOf = new Map();
waves.forEach((w, i) => {
    w.forEach((n) => {
        waveOf.set(n, i + 1);
    });
});

const sevScore = (f) => {
    const k = (f.severity || "low").toLowerCase();
    return k.startsWith("h") ? 3 : k.startsWith("m") ? 1 : 0;
};

const plan = epics
    .map((e) => {
        const dropped = [];
        const fs2 = (e.findings || [])
            .map((id) => {
                const found = byId.get(id);
                if (!found) dropped.push(id);
                return found;
            })
            .filter((f) => f !== null)
            .map((f) => ({
                id: f.id,
                file: f.file,
                line: f.line,
                severity: (f.severity || "low").toLowerCase(),
                title: f.title,
                what: f.what,
                why: f.why || "",
                fix: f.fix || "",
            }))
            .sort((a, b) => sevScore(b) - sevScore(a));
        for (const d of dropped) {
            console.error(
                `fix-plan: WARNING epic '${e.epic}' lists finding '${d}' missing from findings.json — dropped`
            );
        }
        return {
            epic: e.epic,
            title: e.title,
            goal: e.goal || "",
            acceptance: e.acceptance || [],
            depends_on: depsOf.get(e.epic),
            wave: waveOf.get(e.epic),
            parallelizable: e.parallelizable !== false,
            issue: issueByTitle.get(e.title) || null,
            severity: fs2.reduce((a, f) => a + sevScore(f), 0),
            findings: fs2,
        };
    })
    .sort(
        (a, b) =>
            a.wave - b.wave ||
            b.severity - a.severity ||
            a.epic.localeCompare(b.epic)
    );

const unmatched = plan.filter((p) => !p.issue).map((p) => p.epic);
fs.writeFileSync(
    outFile,
    JSON.stringify({ created: new Date().toISOString(), epics: plan }, null, 1)
);
for (const u of unmatched)
    console.error(
        `fix-plan: WARNING no GH issue matched epic '${u}' — PRs will omit Fixes refs`
    );
console.error(
    `fix-plan: ${plan.length} epics in ${waves.length} waves -> ${outFile}`
);
