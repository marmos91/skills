# Simplification

Find code in the change that should not exist or should be smaller. Each
extra line must be read, tested and fixed later. Review only lines that the
PR adds or changes.

Look for:

- Delete: dead code, unused options, parameters and exports, features that
  nothing asks for, stub files with no new content.
- Reuse: the repo already has this helper. Name its path and symbol.
- Stdlib or platform: the standard library already does it, or the PR adds
  a dependency for a few lines.
- YAGNI: an abstraction with one implementation, a wrapper with one caller,
  config that nobody sets, a guard that the boundary already checks.
- Merge: near-copies that must change together.
- Split: one function that does unrelated jobs, so it is hard to test. Split
  by job, never by line count.
- Reader load: a pass-through layer, hidden or shared mutable state, a value
  that is synced by hand where it can be derived. A reader must find where a
  value comes from, and what can change it, in 30 seconds.

Check before you report: grep to confirm that the code is unused, or that the
helper does the same job with the same edge cases.

No concrete case, no finding. The case names the cost: "2 copies of the parse
rule; a fix in one leaves the other wrong". Prefer fixes that delete code.
Never propose a new layer, framework or config. No style taste, no "consider".

Output: each finding has `"lens": "simplification"`; `fix` says how many lines go.

Sources: ponytail-review (lean), pstack principle-subtract-before-you-add, pstack principle-minimize-reader-load.
