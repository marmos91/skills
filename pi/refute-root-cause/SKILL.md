---
name: refute-root-cause
description: Use when a claimed root cause rests on reading code rather than on a reproduction, or before any fix built on a hypothesis — an adversarial multi-lens panel tries to KILL the claim; only refutations with a concrete counterexample kill it. Triggers on "refute this root cause", "put the root cause on trial", "adversarial panel on this cause", "test this hypothesis before the fix".
metadata:
  version: "0.2.0" # x-release-please-version
---

# Refute the root cause before fixing

The most expensive failure mode is a confident fix for the wrong problem. Issues
and audits describe symptoms and often carry a theory about the cause; that
theory is frequently wrong — sometimes written by a past agent that read code
without running it.

Before you design a fix around a claimed root cause, try to kill it. A root
cause that survives a genuine attempt at refutation is worth far more than one
that merely explains the symptom. Several plausible causes usually explain the
same symptom, and picking the wrong one produces a fix that passes review and
leaves the bug in.

## When to run the panel

- The claimed cause rests on reading code rather than on a reproduction.
- The defect is data-corruption, durability, or concurrency.
- The fix would change a shared seam (cache, access point, shared function).
- The issue's own premise already turned out to be wrong once.

## When to skip it

- The reproduction already pins the cause unambiguously (a failing assertion on
  the exact line).
- The fix is mechanical and self-evident — a typo, a read-only variable, a
  missing invalidation call. A four-agent panel on a two-line fix is waste.

## The panel

Call the `subagent` tool ONCE with `workflowScriptPath` pointing at
`refute-root-cause.js` in this skill dir, `cwd` set to the repo, `async: false`:

```text
subagent({ workflowScriptPath: "<skill-dir>/refute-root-cause.js",
           cwd: "<repo-or-worktree>", async: false, timeoutMs: 1200000 })
```

**CONFIG** (edit the block at the top of the script before launching):
- `CLAIM` — the root cause, stated as a **falsifiable sentence**.
- `EVIDENCE` — repro output, logs, file:line anchors.
- `SYMPTOM` — what someone actually observed (for the alternatives agent).
- `LENSES` — the three refutation lenses (control flow / concurrency / evidence fit; edit for the domain).

## How to read the result

- **Any refutation with a concrete counterexample kills the claim** — go back to
  investigation, do NOT average the votes.
- Refutations **without** a counterexample are doubts, not kills — chase the
  specific thing they could not rule out.
- **`panelFailed: true`** — every refuter died (provider outage, launch errors);
  the claim is UNTESTED, not surviving. Re-run when the API is healthy.
- If the claim survives but the alternatives agent names a competing mechanism,
  run the distinguishing observation it suggests **before writing any code**.
- `survives: true` + no plausible alternatives = the cause is trustworthy.

## Workflow shape

3 refuter agents in parallel (one lens each, `outputSchema` verdict with a
required counterexample field) → 1 alternatives agent working only from the
symptom. Keep it to this size: under a parallel issue fan-out every panel
multiplies against the budget.

## Common mistakes

- **Averaging votes.** One concrete counterexample beats three "plausible" votes.
- **Treating bare `refuted: true` as a kill.** A refutation without a
  counterexample is a doubt to chase, not a kill.
- **Accepting the claim because it sounds coherent.** Default is refuted; the
  burden is on the claim.
- **Running the panel on a mechanical fix.** YAGNI.
