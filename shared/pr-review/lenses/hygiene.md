# Hygiene

Check the PR as a whole, not its code. A cheap check; one child, low
thinking. Do not review code lines here: the lenses do that.

Look for:

- Description: a claim in the title or body that the diff does not do.
- Missing mention: a large change in the diff that the body never names.
- Docs: a changed public interface (CLI flag, config key, API, exported
  function) with no change in the README, docs folder or help text.
- Tests named in the body that the diff does not add.

Check before you report: read the diff and grep the docs. Do not report what
the code checks already cover (title style, empty body, linked issue,
changelog, commit subjects).

Severity: `should` when a reader would be misled. `nit` for the rest. Never
`must`.

You are 1 seat. Write each finding as a question to the author: "The body
says X. The diff does Y. Is X still true?"

Output: each finding has `"lens": "hygiene"`; no `file` and no `line`.

Sources: spec section 6.3.1; pstack principle-prove-it-works.
