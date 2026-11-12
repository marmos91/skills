// Checks before the push: every commit signed, no AI or tool mention in commits, title or body.
import { execFileSync } from "node:child_process";

// A word inside a path or an identifier (.claude/, claude_code, llm_client) is not a mention.
const B = "(?<![A-Za-z0-9_./-])", E = "(?![A-Za-z0-9_]|[./-][A-Za-z0-9])";
// The email comes first, so a trailer email is one hit, not "anthropic" as well.
const AI = new RegExp(`noreply@anthropic\\.com|🤖|${B}(?:claude|anthropic|chatgpt|openai|gpt-?\\d+(?:\\.\\d+)?o?|(?:sonnet|opus|haiku) \\d+(?:\\.\\d+)?|copilot|gemini|codex|cursor ai|llms?|ai[- ]generated|generated (?:with|by) ai)${E}`, "gi");

/** AI or tool words in text, lower case, each once. Words in `allow` are not hits. */
export function aiMentions(text, allow = []) {
  const ok = new Set(allow.map((w) => w.toLowerCase()));
  return [...new Set([...text.matchAll(AI)].map((m) => m[0].toLowerCase()))].filter((w) => !ok.has(w));
}

const git = (dir, ...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Commits in base..HEAD: unsigned ones (no gpgsig header), and AI words in commits, title and body. */
export function checkBranch(dir, base, { title = "", body = "", allow = [] } = {}) {
  const shas = git(dir, "rev-list", "--reverse", `${base}..HEAD`).split("\n").filter(Boolean);
  const unsigned = [], ai = [];
  for (const sha of shas) {
    const obj = git(dir, "cat-file", "commit", sha);
    const [head, ...msg] = obj.split("\n\n");
    if (!/^gpgsig /m.test(head)) unsigned.push(sha.slice(0, 7));
    const hits = aiMentions(msg.join("\n\n"), allow);
    if (hits.length) ai.push({ where: sha.slice(0, 7), hits });
  }
  for (const [where, text] of [["title", title], ["body", body]]) {
    const hits = aiMentions(text, allow);
    if (hits.length) ai.push({ where, hits });
  }
  return { ok: unsigned.length === 0 && ai.length === 0, unsigned, ai };
}
