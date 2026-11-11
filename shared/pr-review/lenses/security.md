# Security

Find holes that an attacker can use. The attacker can be any user, any
network peer, or any untrusted data: a request, a file, a repo config, an
environment variable, model output.

Read each changed file in full. Map the entry points and the sinks that the
change touches. Sinks: shell and exec, SQL, eval, file paths, outbound HTTP,
HTML, deserialization, templates, logs, responses, prompts to a model.
Trace each value that reaches a sink back to its source. When a function
returns a tainted value, read its callers: the sink is there.

Look for:

- Injection: shell, SQL, template, argv (a value that starts with `-`), env
  variables passed to a child process.
- Path traversal: a lexical check (`startsWith` after `resolve`) that a
  symlink or `..` can pass.
- Authn and authz: a handler that skips the owner check that its sibling has.
  A gate that reads one field while the action uses another.
- Validator gaps: an unanchored regex, a substring allowlist, a parser that
  accepts what the consumer reads differently.
- Secrets and data exposure: a token in a log, a URL or an error message.
- Unsafe defaults: TLS checks off, fail-open error paths, a broad grant.
- Dependency risk: a new package that is unmaintained or has a known CVE.

Do not trust comments such as "validated upstream". Check the code.

No concrete case, no finding. The case names the source, the sink, and the
path with no effective check. Do not report hardening with no concrete
impact, volumetric DoS, or test fixtures. No style taste, no "consider".

Output: each finding has `"lens": "security"`; `evidence` is the source-to-sink trace.

Sources: Claude Code /security-review, security-guidance plugin, ponytail-review (risk).
