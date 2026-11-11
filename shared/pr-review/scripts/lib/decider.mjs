import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./secrets.mjs";

const QUESTION = "This finding describes a real defect that this PR introduces.";
const UNSURE = { decision: "unsure", raw: null };

const executable = (f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };

// Sibling `<skill dir>/../jev/bin/jev` first, else `jev` on PATH.
function findJev(skillDir, env) {
  const sibling = join(skillDir, "..", "jev", "bin", "jev");
  if (executable(sibling)) return sibling;
  return (env.PATH || "").split(delimiter).filter(Boolean).map((d) => join(d, "jev")).find(executable) ?? null;
}

function text(c, votes, hunk) {
  const v = votes.map((x, i) => `Vote ${i + 1}: ${x.vote}\n${x.reason ?? ""}\n${x.counter_case ?? ""}`.trim());
  return [
    `Title: ${c.title}`, `Case: ${c.case}`, `Evidence: ${c.evidence ?? ""}`, `Fix: ${c.fix ?? ""}`,
    "", ...v, "", "Code:", hunk,
  ].join("\n");
}

/** Settle a split finding with jev. -> { decision: "agreed"|"rejected"|"unsure", raw } */
export function decide(cluster, votes, codeHunk, config, { env = process.env, timeoutMs = 60000, skillDir } = {}) {
  const { kind, confidence } = config.decider;
  if (kind === "off") return Promise.resolve(UNSURE);
  skillDir ??= realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const bin = findJev(skillDir, env);
  if (!bin) return Promise.resolve(UNSURE);
  const args = ["ask", QUESTION, "--json", ...(confidence > 0 ? ["--confidence", String(confidence)] : [])];
  return new Promise((resolve) => {
    let out = "", settled = false;
    const p = spawn(bin, args, { env, stdio: ["pipe", "pipe", "ignore"] });
    const end = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { p.kill("SIGKILL"); end(UNSURE); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stdin.on("error", () => {});
    p.on("error", () => end(UNSURE));
    p.on("close", (code) => {
      let raw = null;
      try { raw = JSON.parse(out); } catch { /* raw stays null */ }
      end({ decision: code === 0 ? "agreed" : code === 1 ? "rejected" : "unsure", raw });
    });
    p.stdin.end(redact(text(cluster, votes, codeHunk)));
  });
}
