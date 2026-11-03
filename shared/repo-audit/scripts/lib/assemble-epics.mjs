#!/usr/bin/env node
// assemble-epics.mjs <state-dir> — stage 2 of the roadmap step.
// Deterministically merges the per-lens epics from .audit/epic-pass/*.json into
// one epics.json, then ENFORCES the coverage contract: every confirmed finding
// id from findings.json must sit in exactly one epic. Extra ids (typos from a
// model pass) are dropped with a warning; missing ids are appended to a
// "<lens>-triage" fallback epic so nothing is silently lost.
// Dependencies on epics from other lenses are preserved verbatim.
import fs from "node:fs";

const state = process.argv[2];
if (!state) {
    console.error("usage: assemble-epics.mjs <state-dir>");
    process.exit(2);
}
const R = (p) => `${state}/${p}`;

// raw parse that dies LOUDLY with a named file — a corrupt intermediate is a
// failed step, never a silent empty result
function parseOrDie(path) {
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch (err) {
        console.error(`assemble: corrupt JSON in ${path}: ${err.message}`);
        process.exit(1);
    }
}

const findings = parseOrDie(R("findings.json"));
const allIds = new Set(findings.map((f) => f.id));

const passDir = R("epic-pass");
const epics = [];
for (const name of fs
    .readdirSync(passDir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    for (const e of parseOrDie(`${passDir}/${name}`)) {
        if (!e || !Array.isArray(e.findings)) continue;
        epics.push(e);
    }
}

// drop unknown ids, dedup across epics (first epic wins), count leftovers
const seen = new Set();
const report = [];
for (const e of epics) {
    const clean = [];
    for (const id of e.findings) {
        if (!allIds.has(id)) {
            report.push(`dropped unknown id ${id} (epic ${e.epic})`);
            continue;
        }
        if (seen.has(id)) {
            report.push(`dropped duplicate id ${id} (epic ${e.epic})`);
            continue;
        }
        seen.add(id);
        clean.push(id);
    }
    e.findings = clean;
}
// keep only epics that still carry findings (or are explicitly fallbacks)
const kept = [];
for (const e of epics)
    if (e.findings.length || e.epic.endsWith("-triage")) kept.push(e);

const missing = findings.filter((f) => !seen.has(f.id));
if (missing.length) {
    const byLens = new Map();
    for (const f of missing) {
        if (!byLens.has(f.lens)) byLens.set(f.lens, []);
        byLens.get(f.lens).push(f.id);
    }
    for (const [lens, ids] of byLens) {
        kept.push({
            epic: `${lens}-leftovers`,
            title: `${lens} unclustered findings`,
            goal: `Assembly fallback: ${ids.length} confirmed ${lens} findings were not mapped by the per-lens clustering passes; triage by hand.`,
            findings: ids,
            acceptance: ["every finding triaged to an epic or closed"],
            parallelizable: true,
            depends_on: [],
        });
    }
    report.push(`${missing.length} findings recovered into fallback epics`);
}

// deterministic order: high-severity weight desc, then lens name
const sev = (f) => {
    const k = (f.severity || "low").toLowerCase();
    return k.startsWith("h") ? 3 : k.startsWith("m") ? 1 : 0;
};
const fById = new Map(findings.map((f) => [f.id, f]));
const score = (e) =>
    e.findings.reduce((acc, id) => acc + sev(fById.get(id) || {}), 0);
kept.sort((a, b) => score(b) - score(a) || a.epic.localeCompare(b.epic));

process.stdout.write(JSON.stringify(kept, null, 1) + "\n");
for (const line of report) console.error(`assemble: ${line}`);
console.error(
    `assemble: ${kept.length} epics covering ${allIds.size} findings (unique mapped: ${seen.size}+missing fallback)`
);
