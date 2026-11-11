import { spawn } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { redact } from "./secrets.mjs";
import { ENV_OK } from "./child.mjs";

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
  const tag = (t, body) => `<${t}>\n${body}\n</${t}>`;
  const v = votes.map((x) => tag(x.vote === "drop" ? "drop" : "keep", `${x.reason ?? ""}\n${x.counter_case ?? ""}`.trim()));
  return [
    tag("finding", `Title: ${c.title}\nCase: ${c.case}\nEvidence: ${c.evidence ?? ""}\nFix: ${c.fix ?? ""}`),
    ...v, tag("code", hunk),
  ].join("\n");
}

/** Settle a split finding with jev. -> { decision: "agreed"|"rejected"|"unsure", raw } */
export function decide(cluster, votes, codeHunk, config, { env = process.env, timeoutMs = 60000, skillDir } = {}) {
  const { kind, confidence } = config.decider;
  if (kind === "off") return Promise.resolve(UNSURE);
  skillDir ??= realpathSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const bin = findJev(skillDir, env);
  if (!bin) return Promise.resolve(UNSURE);
  env = Object.fromEntries(Object.entries(env).filter(([k]) => ENV_OK.test(k)));
  const args = ["ask", QUESTION, "--json", ...(confidence > 0 ? ["--confidence", String(confidence)] : [])];
  return new Promise((resolve) => {
    let out = "", settled = false;
    const p = spawn(bin, args, { env, detached: true, stdio: ["pipe", "pipe", "ignore"] });
    const end = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    const killGroup = () => { try { process.kill(-p.pid, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { killGroup(); end(UNSURE); }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.stdin.on("error", () => {});
    p.on("error", () => end(UNSURE));
    p.on("close", (code) => {
      let raw = null;
      try { raw = JSON.parse(out); } catch { /* raw stays null */ }
      killGroup(); // reap stragglers
      // R22: older jev builds exit 1 on network errors, so settle only when the verdict agrees with the exit code.
      const yes = code === 0 && ["yes", "doubted"].includes(raw?.verdict);
      const no = code === 1 && ["no", "trusted"].includes(raw?.verdict);
      end({ decision: yes ? "agreed" : no ? "rejected" : "unsure", raw });
    });
    p.stdin.end(redact(text(cluster, votes, codeHunk)));
  });
}
