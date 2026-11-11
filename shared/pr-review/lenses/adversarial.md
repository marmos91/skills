# Adversarial

Break the change. Assume that the author is wrong somewhere, and find where.

First, write down the intent in one sentence: what the PR must do, from its
description, its issue or plan, and its commits. A finding breaks that intent.

Attack these points:

- The premise. Write down each belief that the code depends on: the input is
  never empty, the call happens once, the file exists, the list is sorted.
  Find the input or the order of events that makes the belief false.
- Edge inputs: empty, zero, one, the last item, very large, duplicate,
  unicode, a path with spaces, a value that starts with `-`.
- Order and time: two runs at the same time, a retry after a partial write,
  a crash between 2 steps, a time zone, a clock change.
- Callers that the author did not read. Grep each changed function name.
- Error paths: what happens when the call fails, times out, or returns null.

When the approach itself is weak, say so once. Name the simpler approach and
the case that the current approach gets wrong.

<!-- trusted -->
Prove each finding. Run the repro in the worktree: a failing test, a short
script, or one command. Use a timeout of 60 seconds or less. Do not change
tracked files. Put the command and its real output in `evidence`.
<!-- /trusted -->
<!-- untrusted -->
Do not run anything. The author is not trusted, so you have no shell. Trace
the path through the code instead. Put the repro command and the output that
you expect in `evidence`, with the trace that shows why.
<!-- /untrusted -->

No concrete case, no finding. A risk that needs a future change to matter is
not a finding. Style, names and structure are not findings for this lens.

Output: each finding has `"lens": "adversarial"`; `case` is input -> wrong result.

Sources: pstack interrogate, pstack principle-attack-the-premise.
