// pr-respond scan [--pr <n|url>]: the secret scan before a push, on every commit since the PR base.
// The same repos as pr-open: the PR target and what a push to origin really reaches. Exit: secret-scan's.
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pushRepos } from "../../pr-open/scripts/lib/open.mjs";

const gh = (...args) => execFileSync(process.env.GH_BIN || "gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "secret-scan", "scripts", "secret-scan");

process.exitCode = (() => {
  let pr;
  try { pr = parseArgs({ options: { pr: { type: "string" } } }).values.pr; } catch (e) { console.error(`pr-respond scan: ${e.message}`); return 2; }
  let base, target;
  try {
    base = gh("pr", "view", ...(pr ? [pr] : []), "--json", "baseRefName", "--jq", ".baseRefName");
    target = gh("repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner");
    // an explicit refspec: a single-branch clone would only fill FETCH_HEAD
    execFileSync("git", ["fetch", "-q", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`], { stdio: ["ignore", "inherit", "inherit"] });
  } catch (e) { console.error(`pr-respond scan: ${e.message.split("\n")[0]}`); return 2; }
  const pushed = pushRepos(process.cwd());
  if (pushed[0] === null) console.error("pr-respond scan: origin does not push only to github.com: strict scan, the private-repos opt-out does not apply");
  const r = spawnSync(CLI, [...[target, ...pushed].flatMap((x) => ["--repo", x ?? ""]), "--range", `origin/${base}..HEAD`], { stdio: "inherit" });
  return r.status ?? 2;
})();
