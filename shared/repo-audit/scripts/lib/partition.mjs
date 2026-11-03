#!/usr/bin/env node
// partition.mjs — deterministic area partition of a repo for the audit.
//   partition.mjs < areas.json     (stdin: `git ls-files` output)
//   partition.mjs validate <file>  (schema-check a (possibly scout-edited) areas.json)
//
// The deterministic partition is the ground truth the cheap scout may refine;
// if the scout fails 3x it IS the partition. Design rules:
//   - exclude what is not auditable code/docs (lockfiles, process specs in
//     specs/, CI yaml, images, generated output)
//   - group by directory cohesion first; split a directory whose LOC exceeds
//     CHUNK_LOC into alphabetical chunks of ~CHUNK_LOC (the finder lists exact
//     paths, so alphabetical chunks stay perfectly usable)
//   - assign lenses per repo rules (ui -> web/src, sql -> api, docs -> md area,
//     tests -> areas containing test files, simplify/structure/bugs -> code)
import fs from "node:fs";

const CHUNK_LOC = 18000;
const LENSES_CODE = ["simplify", "structure", "bugs", "security", "slop"];
const EXCLUDE = [
    /^pnpm-lock\.yaml$/,
    /^\.github\//,
    /^specs\//,
    /^docs\/scripts\/generated\//,
    /\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|pdf|zip|mp4)$/i,
    /(^|\/)dist\//,
    /(^|\/)test-results\//,
    /^docs\/mockups\//, // design reference art, not shipped code — no lens applies
];

const slug = (s) =>
    s
        .replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-+|-+$/g, "")
        .toLowerCase();

// stdin file list
function readStdin() {
    return fs
        .readFileSync(0, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}

function locOf(files, root) {
    let loc = 0;
    for (const f of files) {
        try {
            loc += fs.readFileSync(`${root}/${f}`, "utf8").split("\n").length;
        } catch {
            /* gone */
        }
    }
    return loc;
}

function lensesFor(files) {
    const web = files.some((f) => f.startsWith("web/src"));
    const api = files.some(
        (f) =>
            f.startsWith("api/") || f.startsWith("mcp/") || f.startsWith("cli/")
    );
    const hasTests = files.some(
        (f) => /\.(test|spec)\.[a-z]+$/i.test(f) || /(^|\/)(e2e|test)\//.test(f)
    );
    const docs = files.some((f) => f.endsWith(".md"));
    const anyCode = files.some((f) => /\.(ts|tsx|js|mjs|sql|sh|py)$/.test(f));
    const lenses = new Set();
    if (anyCode) for (const l of LENSES_CODE) lenses.add(l); // Set.add takes ONE arg — the spread call silently added only "simplify"
    if (web) {
        lenses.add("ui");
    }
    if (api) {
        lenses.add("sql");
        lenses.add("api-design");
    } // handlers hold queries + REST surface is born there; cli/mcp ride on the same routes
    if (hasTests) lenses.add("tests");
    if (docs && !anyCode) lenses.add("docs");
    return [...lenses];
}

// Build areas from a {dir -> files} map, splitting oversized dirs.
function buildAreas(byDir) {
    const areas = [];
    const groups = new Map(); // name -> files
    for (const [dir, files] of Object.entries(byDir)) {
        const name = dir === "." ? "root-config" : dir.replace(/\//g, "-");
        groups.set(name, files);
    }
    const chunks = [];
    for (const [name, files] of groups) {
        const loc = locOf(files, "."); // safety net, used for chunking decisions
        if (loc <= CHUNK_LOC) {
            chunks.push({ name, files, loc });
        } else {
            // alphabetical chunks ~CHUNK_LOC
            files.sort();
            let cur = [];
            let curLoc = 0;
            let i = 1;
            for (const f of files) {
                let l = 0;
                try {
                    l = fs.readFileSync(f, "utf8").split("\n").length;
                } catch {
                    /* gone */
                }
                cur.push(f);
                curLoc += l;
                if (curLoc >= CHUNK_LOC) {
                    chunks.push({
                        name: `${name}-${i}`,
                        files: cur,
                        loc: curLoc,
                    });
                    cur = [];
                    curLoc = 0;
                    i += 1;
                }
            }
            if (cur.length)
                chunks.push({
                    name: cur.length === files.length ? name : `${name}-${i}`,
                    files: cur,
                    loc: curLoc,
                });
        }
    }
    for (const c of chunks) {
        c.files.sort();
        areas.push({
            id: slug(c.name),
            name: c.name,
            paths: c.files,
            loc: c.loc,
            lenses: lensesFor(c.files),
        });
    }
    return areas;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "validate") {
    let areas;
    try {
        areas = JSON.parse(fs.readFileSync(arg, "utf8"));
    } catch {
        console.error("not valid JSON");
        process.exit(1);
    }
    const errs = [];
    if (!Array.isArray(areas) || areas.length < 1)
        errs.push("must be a non-empty JSON array");
    const ids = new Set();
    for (const a of areas || []) {
        if (typeof a.id !== "string" || !a.id) errs.push("area.id missing");
        if (ids.has(a.id)) errs.push(`duplicate id ${a.id}`);
        ids.add(a.id);
        if (typeof a.name !== "string") errs.push(`${a.id}: name missing`);
        if (!Array.isArray(a.paths) || a.paths.length < 1)
            errs.push(`${a.id}: paths must be a non-empty array`);
        if (!Array.isArray(a.lenses) || a.lenses.length < 1)
            errs.push(`${a.id}: lenses must be a non-empty array`);
        if (typeof a.loc !== "number")
            errs.push(`${a.id}: loc must be a number`);
    }
    if (errs.length) {
        console.error(errs.join("; "));
        process.exit(1);
    }
    console.log(`areas.json valid: ${areas.length} areas`);
    process.exit(0);
}

// default: stdin -> areas json on stdout
const files = readStdin().filter((f) => !EXCLUDE.some((re) => re.test(f)));
// group: docs+root-misc special-cased; code grouped by top dir, then split roots
// with many loose files via known subdir boundaries.
const byTop = {};
for (const f of files) {
    const top = f.includes("/") ? f.split("/")[0] : ".";
    if (!byTop[top]) byTop[top] = [];
    byTop[top].push(f);
}
// sub-group big flat tops so chunks keep some cohesion (api/, web/src/)
const byDir = {};
for (const [top, fs1] of Object.entries(byTop)) {
    for (const f of fs1) {
        let key;
        if (top === "api") {
            const sub = f.slice(4).split("/")[0];
            key = sub.includes(".") ? "api" : `api/${sub}`;
        } else if (f.startsWith("web/src/")) {
            const sub = f.slice("web/src/".length).split("/")[0];
            key = sub.includes(".") ? "web-src" : `web/src/${sub}`;
        } else if (top === ".") {
            key = f.endsWith(".md") ? "root-docs" : "root-config";
        } else if (top === "docs") {
            const sub = f.slice(5).split("/")[0];
            key = sub.includes(".") ? "docs" : `docs/${sub}`;
        } else {
            key = top;
        }
        if (!byDir[key]) byDir[key] = [];
        byDir[key].push(f);
    }
}
for (const k of Object.keys(byDir)) if (byDir[k].length === 0) delete byDir[k];
const areas = buildAreas(byDir);
process.stdout.write(JSON.stringify(areas, null, 1) + "\n");
