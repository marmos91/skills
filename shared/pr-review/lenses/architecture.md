# Architecture

Judge the shape of the change: where code lives, what depends on what, and
how data flows. Read the modules around the change first. Find the patterns
that the repo already uses, and similar features, with file:line.

Look for:

- Boundaries. Validation, parsing and error handling belong at the edges
  (CLI, config, network, external API). Inside, code trusts its types. Flag
  checks scattered deep in the call chain, and logic inside framework wiring
  that a pure function can hold.
- Leaks. A transport, storage or wire type in the public surface. One
  internal decision that 2 or more modules must know.
- Shallow modules. Callers must call several methods for one operation, or
  learn the implementation to use the interface.
- Split ownership. Two modules write the same state, or keep their own copy.
- Two ways to do one task. A hand-synced list that must change in 2 places.
- Fit. The change ignores a pattern that the repo uses for the same job.
- Scale. The design fails at the load that the repo expects.
- Experience. The API is hard to use right for the colleague who imports it.
  The user-facing behavior has a bad default, a silent failure, or an error
  message that does not say what to do.

Each finding names the next change that the current shape makes wrong or
expensive, and the file where that happens. A design that you only prefer is
not a finding.

No concrete case, no finding. No style taste, no "consider".

Output: each finding has `"lens": "architecture"`; `fix` names the target shape.

Sources: feature-dev code-architect, pstack architect, pstack principle-boundary-discipline, pstack principle-experience-first.
