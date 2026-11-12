# Correctness

Find the defects that make the change give a wrong result. Read the diff,
then the code it touches: callers of each changed function, the functions it
calls, and the tests. Trace the data from where it comes in to where it goes
out.

Look for:

- Bugs: a wrong result, a crash, a missed edge case (empty, zero, last item,
  rounding, time zone), an inverted condition, an off-by-one.
- Broken callers. When a signature, a return value or a behavior changes,
  grep each caller and check that it still works.
- A fix in one caller while the shared function stays broken.
- Lost data: a swallowed error, writes in the wrong order, no transaction.
- Scale: a check-then-write race, a list that only grows, a query per item,
  O(n^2) work on large input. Judge against the load that the repo expects.
- Missing test: risky new logic (a branch, a parser, money, security, a data
  write, a bug fix) with no test that fails when the logic breaks. Ask for
  one good test, not coverage.
- The practice of the language and the framework, when breaking it causes a
  real failure.

Check the plan. Read the issue or plan in the context folder. Does the PR do
all of it, and nothing else? A missing part or an unasked change is a finding.
When there is no issue or plan, check the PR against its own description,
and set `no_tracking: true` in the output.
If CI failed, read the failed log and connect the failure to a line.

No concrete case, no finding. Re-read the lines before you report: confirm
that the caller exists and that the value can really be empty. A comment
`shortcut:` that names its limit is a decision, unless the expected load
already crosses that limit. No style taste, no "consider".

Output: each finding has `"lens": "correctness"`; `fix` is the smallest fix.

Sources: ponytail-review, superpowers requesting-code-review, Claude Code /code-review.
