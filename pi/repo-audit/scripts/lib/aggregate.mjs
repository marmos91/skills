#!/usr/bin/env node
// aggregate.mjs — findings id-hashing, verify batching, and the verified merge.
//
//   aggregate.mjs prep   <state>   -> stdout: "batch-id<TAB>count" lines of OPEN
//                                     batches; writes .audit/verify-input/<id>.json
//   aggregate.mjs check  <state>   -> exit 1 if any finding lacks a verdict
//   aggregate.mjs merge   <state>   -> writes findings.json (kept, severity as
//                                     verified) + findings-refuted.json
//
// Finding ids are content-stable: sha256(lens|file|line|title) truncated to 12
// hex — re-running a finder that re-reports the same finding keeps its id (and
// its already-earned verdict). Batch ids hash the sorted finding ids inside,
// so a batch is always the exact set of findings it names — resume can never
// apply a stale verdict to a re-shuffled batch, because the id changes.
import fs from "node:fs";
import crypto from "node:crypto";

const state = process.argv[3];
if (!state) {
    console.error("usage: aggregate.mjs <prep|check|merge> <state-dir>");
    process.exit(2);
}
const cmd = process.argv[2];
const R = (p) => `${state}/${p}`;

// FINDINGS_CAP belongs to the FINDER prompt only (per lens×area) — the merge
// must never truncate the confirmed set: verification already established
// reachability and severity, and the roadmap needs the full picture. Enforcing
// a global cap here silently deleted 641 confirmed findings on the first real
// run; keep the merge faithful to what the gate confirmed.
const sevScore = (s) => {
    const k = (s || "low").toLowerCase();
    return k.startsWith("h") ? 0 : k.startsWith("m") ? 1 : 2;
};

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const fid = (f, lens) =>
    sha(`${lens}|${f.file}|${f.line}|${f.title}`).slice(0, 12);

// raw parse that dies LOUDLY with a named file instead of a stack trace —
// a corrupt child output is a failed step, never a silent empty result
function parseOrDie(path) {
    try {
        return JSON.parse(fs.readFileSync(path, "utf8"));
    } catch (err) {
        console.error(`aggregate: corrupt JSON in ${path}: ${err.message}`);
        process.exit(1);
    }
}

function loadRaw() {
    const dir = R("findings");
    const out = [];
    if (!fs.existsSync(dir)) return out;
    for (const name of fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        const lens = name.replace(/\.json$/, "").split("__")[0];
        const arr = parseOrDie(`${dir}/${name}`);
        for (const f of arr) out.push({ ...f, id: fid(f, lens), lens });
    }
    return out;
}

function loadVerdicts() {
    const dir = R("verified");
    const map = new Map();
    if (!fs.existsSync(dir)) return map;
    for (const name of fs
        .readdirSync(dir)
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        for (const v of parseOrDie(`${dir}/${name}`)) {
            // NB: each finding lives in exactly one batch (prep slices disjointly),
            // and step_verify wipes verdicts when the findings fingerprint changes,
            // so a conflicting double-verdict cannot occur — last read wins.
            if (v && v.id) map.set(v.id, v);
        }
    }
    return map;
}

const BATCH_SIZE = Number.parseInt(process.env.VERIFY_BATCH || "10", 10);

if (cmd === "prep") {
    const findings = loadRaw();
    const verdicts = loadVerdicts();
    const open = findings.filter((f) => !verdicts.has(f.id));
    fs.mkdirSync(R("verify-input"), { recursive: true });
    // formulate and delete the stale verify-input files of closed batches
    const keep = new Set();
    const lines = [];
    for (let i = 0; i < open.length; i += BATCH_SIZE) {
        const slice = open.slice(i, i + BATCH_SIZE);
        const id = sha(
            slice
                .map((f) => f.id)
                .sort()
                .join(",")
        ).slice(0, 12);
        keep.add(id);
        lines.push(`${id}\t${slice.length}`);
        fs.writeFileSync(
            R(`verify-input/${id}.json`),
            JSON.stringify(slice, null, 1)
        );
    }
    for (const n of fs.readdirSync(R("verify-input"))) {
        if (n.endsWith(".json") && !keep.has(n.replace(/\.json$/, ""))) {
            fs.rmSync(R(`verify-input/${n}`));
        }
    }
    process.stdout.write(lines.length ? lines.join("\n") + "\n" : "");
    process.exit(0);
}

if (cmd === "check") {
    const findings = loadRaw();
    const verdicts = loadVerdicts();
    const missing = findings.filter((f) => !verdicts.has(f.id));
    if (missing.length) {
        console.error(
            `findings without verdicts: ${missing.length} — re-run 'audit.sh verify'`
        );
        process.exit(1);
    }
    process.exit(0);
}

if (cmd === "merge") {
    const findings = loadRaw();
    if (!findings.length) {
        console.error("no findings found — run 'find' first");
        process.exit(1);
    }
    const verdicts = loadVerdicts();
    const seen = new Map(); // id -> finding (first wins; dedups cross-batch echoes)
    const kept = [];
    const refuted = [];
    for (const f of findings) {
        if (seen.has(f.id)) continue;
        seen.set(f.id, f);
        const v = verdicts.get(f.id);
        // `check` gates before merge, so v is always present; guard the boundary anyway
        if (!v || v.verdict === "refuted") {
            refuted.push({ ...f, evidence: v?.evidence });
            continue;
        }
        kept.push({
            ...f,
            severity: v.severity || f.severity,
            verifyEvidence: v.evidence,
            verdict: v.verdict,
        });
    }
    // severity is the 3-value scale high|med|low; "medium" and other spellings
    // normalize down to med so a chatty verify child cannot demote a finding to low
    kept.sort(
        (a, b) =>
            sevScore(a.severity) - sevScore(b.severity) ||
            a.lens.localeCompare(b.lens) ||
            a.file.localeCompare(b.file)
    );
    fs.writeFileSync(R("findings.json"), JSON.stringify(kept, null, 1));
    refuted.sort((a, b) => sevScore(a.severity) - sevScore(b.severity));
    fs.writeFileSync(
        R("findings-refuted.json"),
        JSON.stringify(refuted, null, 1)
    );
    console.log(`kept ${kept.length}, refuted ${refuted.length}`);
    process.exit(0);
}

console.error("usage: aggregate.mjs <prep|check|merge> <state-dir>");
process.exit(2);
