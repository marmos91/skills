// pr-converge: the loop around pr-review (a round), pr-respond (the agent's fixes) and pr-land (the merge).
// It adds only the loop, the stop rules and the state; each step is an injected function, so tests use fakes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot, writeAtomic } from "../../../pr-review/scripts/lib/state.mjs";

/** The loop state lives in the PR's pr-review state folder, beside the review state. */
export const convergeDir = (repo, n) => join(stateRoot(repo), "pr", String(n), "converge");

export function loadState(repo, n) {
  try { return JSON.parse(readFileSync(join(convergeDir(repo, n), "state.json"), "utf8")); } catch (e) {
    if (e.code !== "ENOENT") throw e;
    return { round: 1, phase: "review", head: null, merge: false, rounds: [], responses: [], pause: null, result: null };
  }
}

export const saveState = (repo, n, s) => writeAtomic(join(convergeDir(repo, n), "state.json"), JSON.stringify(s, null, 2) + "\n");

/**
 * Runs the loop from the saved state until it ends, pauses or hands a respond step to the agent.
 * deps (all async):
 *   head() -> sha of the PR head on GitHub
 *   review() -> { sha, findings: [{ fp, severity, title }], questions }: one pr-review round; findings are the new agreed ones
 *   respond(state) -> { handoff: true } | { question } | { sha, points }: points as pr-respond summary takes them
 *   checks(sha) -> "green" | "pending" | "red"
 *   land() -> { merged: true, commit } | { blocked: why }
 * save(state) persists after every step. -> { status, state }; status: converged|merged|capped|stalled|paused|respond
 */
export async function converge(state, { deps, save, maxRounds = 4 }) {
  const s = state;
  const pause = (kind, why) => { s.pause = { kind, why }; save(s); return { status: "paused", state: s }; };
  const end = (status) => { s.phase = "done"; s.result = status; save(s); return { status, state: s }; };
  for (;;) {
    if (s.phase === "done") return { status: s.result, state: s };
    if (s.pause) return { status: "paused", state: s };

    if (s.phase === "review") {
      const head = await deps.head();
      if (s.head && head !== s.head) return pause("foreign-push", `the head moved to ${head.slice(0, 7)}, not a push of this loop (expected ${s.head.slice(0, 7)})`);
      const r = await deps.review();
      s.head = r.sha ?? head;
      const fps = [...new Set(r.findings.map((f) => f.fp))];
      const must = r.findings.filter((f) => f.severity === "must").length;
      s.rounds = [...s.rounds.filter((x) => x.round !== s.round), { round: s.round, sha: s.head, fps, must, findings: r.findings }];
      save(s);
      // a question waits for the user; the rerun after the answer reviews the same round again
      if (r.questions) return pause("question", `${r.questions} pr-review question(s) wait for an answer (pr-review answer)`);
      if (!fps.length && !must) { s.phase = "land"; save(s); continue; }
      const prev = s.rounds.find((x) => x.round === s.round - 1);
      if (prev && fps.every((fp) => prev.fps.includes(fp))) return end("stalled");
      if (s.round >= maxRounds) return end("capped");
      s.phase = "respond"; save(s); continue;
    }

    if (s.phase === "respond") {
      const r = await deps.respond(s);
      if (r.handoff) return { status: "respond", state: s };
      if (r.question) return pause("question", r.question);
      s.responses = [...s.responses, { round: s.round, sha: r.sha, points: r.points ?? [] }];
      s.head = r.sha; s.round += 1; s.phase = "review";
      save(s); continue;
    }

    if (s.phase === "land") {
      const ci = await deps.checks(s.head);
      if (ci !== "green") return pause("checks", `checks are ${ci} on ${s.head.slice(0, 7)}`);
      if (!s.merge) return end("converged");
      const l = await deps.land();
      if (!l.merged) return pause("land", `pr-land: ${l.blocked}`);
      s.mergeCommit = l.commit ?? null;
      return end("merged");
    }

    throw new Error(`unknown phase ${s.phase}`);
  }
}

const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** The one end comment: rounds run, fixed, declined (with reasons), still open, and the merge commit. */
export function summaryText(repo, s) {
  const done = s.responses.flatMap((r) => r.points.filter((p) => p.status === "done"));
  const kept = s.responses.flatMap((r) => r.points.filter((p) => p.status === "open"));
  const last = s.rounds.at(-1);
  const open = ["capped", "stalled"].includes(s.result) ? last?.findings ?? [] : [];
  const how = {
    merged: "The PR converged and is merged.", converged: "The PR converged. It is not merged: merge was not asked for.",
    capped: `The round cap stopped the loop after ${plural(s.rounds.length, "round")}. Nothing is merged.`,
    stalled: "Two rounds in a row raised the same findings, so the loop stopped. Nothing is merged.",
  }[s.result];
  const sha = (x) => `[\`${x.slice(0, 7)}\`](https://github.com/${repo}/commit/${x})`;
  return [
    how,
    `Rounds: ${s.rounds.map((r) => `${r.round} (${plural(r.fps.length, "finding")} on ${r.sha.slice(0, 7)})`).join(", ")}.`,
    done.length ? `Fixed:\n${done.map((p) => `- ${p.text.trim()} (${sha(p.sha)})`).join("\n")}` : "",
    kept.length ? `Declined:\n${kept.map((p) => `- ${p.text.trim()}`).join("\n")}` : "",
    open.length ? `Still open:\n${open.map((f) => `- ${f.severity ? `${f.severity}: ` : ""}${f.title ?? f.fp}`).join("\n")}` : "",
    s.mergeCommit ? `Merge commit: ${sha(s.mergeCommit)}.` : "",
  ].filter(Boolean).join("\n\n");
}
