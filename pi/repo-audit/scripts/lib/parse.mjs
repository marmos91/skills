#!/usr/bin/env node
// parse.mjs <file> [min-count] — extract and validate a child agent's JSON
// array reply. Children sometimes wrap JSON in prose or ```json fences despite
// instructions; salvage rather than re-run when the array itself is intact.
// On success the file is REWRITTEN with the clean array and the element count
// is printed. Exit 1 on anything unrecoverable (child died, no array, not
// objects). Callers treat exit 1 as "not done" and retry on the next run.
import fs from "node:fs";

const [file, minArg = "1"] = process.argv.slice(2);
const min = Number.parseInt(minArg, 10) || 0;
let text;
try {
    text = fs.readFileSync(file, "utf8");
} catch {
    process.exit(1);
}

// strip markdown code fences if present
const stripped = text.replace(/```(?:json)?\s*/gi, "\n").replace(/```/g, "\n");

// salvage: first '[' to last ']' — the widest bracket span in the text.
// Anti-echo guard: a child that echoes the schema example ("[{...}]" quoted in
// a refusal) would otherwise pass as one finding — require >40 bytes of
// content and a plausible object key before accepting.
const start = stripped.indexOf("[");
const end = stripped.lastIndexOf("]");
if (start === -1 || end < start) process.exit(1);
// "[]" / "[ ]" (whitespace ok) is a VALID result — the finder brief says
// "reply exactly [ ]", so real models emit exactly that shape. Accept any
// whitespace-only array as empty before the anti-echo guard below.
if (/^\[\s*\]$/.test(stripped.slice(start, end + 1))) {
    if (min > 0) process.exit(1);
    fs.writeFileSync(file, "[]\n");
    console.log(0);
    process.exit(0);
}
// Anti-echo guard: a child quoting the schema example ("[{...}]" inside a
// refusal) must not pass as a finding — require real object keys.
if (
    end - start < 40 ||
    !/"(file|what|title|verdict|epic|id)"\s*:/.test(
        stripped.slice(start, end + 1)
    )
)
    process.exit(1);

let arr;
try {
    arr = JSON.parse(stripped.slice(start, end + 1));
} catch {
    process.exit(1);
}
if (!Array.isArray(arr) || arr.length < min) process.exit(1);
if (!arr.every((x) => typeof x === "object" && x !== null)) process.exit(1);

fs.writeFileSync(file, JSON.stringify(arr, null, 1) + "\n");
console.log(arr.length);
