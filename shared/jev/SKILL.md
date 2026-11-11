---
name: jev
description: "Ask Mimir SystemOne (Jev) typed yes/no questions and get calibrated probabilities and clean exit codes from any workflow — usable identically from bash in pi.dev and Claude Code. Use for verifying claims against text, gating CI or agent workflows on a judgment, deciding between branches of a playbook, or any fast classification where prose would be noise. Triggers on 'jev', 'ask jev', 'ask systemone', 'is this true', 'verify this claim', 'gate on'."
---

# jev — typed yes/no questions with calibrated probabilities

`jev` asks Mimir's SystemOne endpoint a yes/no question about some text and
returns a probability and a confidence, not prose. The exit code is the
decision, so scripts and playbooks branch without parsing output.

`install.sh` links `bin/jev` into `~/.local/bin`. Credentials come from the
sops-provisioned `~/.config/mimir/api-key` and `~/.config/mimir/base-url`
(ends in `/v1`).

## Usage

```sh
# Ask about text from -t or stdin. Phrase the question so yes is what you act on.
jev ask "The sky is blue." -t "A clear summer day at noon."
# yes  (p_yes=100.0%, confidence=25.6%)                        exit 0
git diff --name-only main | jev ask "Every changed path is under docs/."
# no  (p_yes=0.0%, confidence=26.9%)                           exit 1

# Is a claim doubtful? The claim is judged on its own, without context.
jev doubt "The Earth is flat."
# doubted  (p_yes=100.0%, confidence=9.2%)                     exit 0

# Gate on confidence: below MIN the verdict is "unsure" and the exit is 2.
jev ask "The service ran out of memory." -t "$LOGS" --confidence 0.9
# unsure  (p_yes=100.0%, confidence=59.2%)                     exit 2

# One JSON object for scripts that want the numbers.
jev doubt "Water boils at 100 degrees Celsius at sea level." --json
# {"verdict": "trusted", "probabilities": {"yes": 1.96e-17, "no": 1.0}, "confidence": 0.998}  (shortened)
```

## Semantics

- The answer is `P(yes)` plus `confidence`, the model's own calibration.
  Both are in `[0, 1]`. The verdict is yes (`ask`) or doubted (`doubt`)
  when `P(yes) >= 0.5`; `doubt` asks "This claim is doubtful or likely
  false." about the claim.
- Exit codes are the same for both subcommands:
  `0` = yes / doubted, `1` = no / trusted, `2` = no answer. No answer means
  missing credentials, API down or timed out (30 s), a malformed response,
  a usage error, empty text, or confidence below `--confidence MIN`
  (default `0`, no gate). Gate on 0/1 only and treat 2 as "jev has no
  answer", never as "no".
- `--json` prints `{"verdict", "probabilities": {"yes", "no"}, "confidence"}`.
  `verdict` is `yes`/`no`, `doubted`/`trusted`, or `unsure` under the gate.
  Nothing goes to stdout on a failure; the reason goes to stderr.

## When to use jev

- A fast, calibrated yes/no about text you have (verify a claim, classify a
  log, gate a playbook step): use `jev ask` instead of asking a model and
  parsing its prose.
- When the decision matters, gate with `--confidence` or report the
  confidence from `--json`. Don't present a low-confidence yes as a verdict.
- Not for open-ended questions, code generation, or anything that needs prose.
- Never send secrets (tokens, keys, credentials, `.env` contents): the text
  leaves the machine and goes to an external model API.

Tests: `python3 -m unittest discover shared/jev` (stub server, no network).
`JEV_LIVE=1` adds a smoke test against the real endpoint.
