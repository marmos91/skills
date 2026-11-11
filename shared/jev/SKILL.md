---
name: jev
description: "Ask Mimir SystemOne (Jev) typed yes/no questions and get calibrated probabilities and clean exit codes from any workflow — usable identically from bash in pi.dev and Claude Code. Use for verifying claims against text, gating CI or agent workflows on a judgment, deciding between branches of a playbook, or any fast classification where prose would be noise. Triggers on 'jev', 'ask jev', 'ask systemone', 'is this true', 'verify this claim', 'gate on'."
---

# jev — typed yes/no questions with calibrated probabilities

`jev` is one standard CLI both pi and Claude Code call from bash. It asks
Mimir's SystemOne endpoint (the Jev-style structured-decision API) typed
questions about text and returns calibrated probabilities, not prose. Exit
codes encode the decision so playbooks can branch without parsing output.

## Install

The skill lives in `shared/` and installs via `install.sh` into both
`~/.pi/agent/skills/jev/` and `~/.claude/skills/jev/`. Credentials are read
from the sops-provisioned `~/.config/mimir/api-key` and `~/.config/mimir/base-url`
(the latter ends in `/v1`); on the provisioned machine they already exist.

## Usage

```sh
# Ask a yes/no question about text. exit 0 = yes, 1 = no
echo "git log excerpt..." | jev ask "These commits touch only the docs directory."
jev ask "The config sets ssl to false." -t "$(cat nginx.conf)" && echo safe || echo investigate

# Raw JSON (probabilities, confidence) for scripts that want the distribution
jev ask "This JWT is expired." -t "$TOKEN" --json

# Gate a step on confidence: exit 1 instead of guessing when confidence < 0.7
jev ask "The error output shows an out-of-memory condition." -t "$LOGS" -e --confidence 0.7

# Doubt: is this claim worth doubting? exit 0 = doubted, 1 = trusted
jev doubt "This function has no side effects."
```

## Semantics

- The question goes to the API as `criteria.true.text`; phrase it so
  **yes** is the answer you'd act on. The answer is `P(yes)` with a
  `confidence` (the model's own calibration).
- Exit codes: `ask` exits 0 for yes and 1 for no; with `-e` it also exits 1
  when confidence is below `--confidence` (default 0.5) instead of guessing.
  `doubt` exits 0 when the claim is doubted, 1 when trusted.
  Both exit **2** when there is no answer (missing credentials, API down,
  malformed response, usage error). Gate on 0/1 only; treat 2 as "jev
  unavailable", never as "no".
- `--json` prints the full answer object (`noul`, `probabilities`,
  `confidence`, plus the verdict flag) for workflows that need the numbers.

## When to use jev (guidelines for agents)

- Reaching for a fast, calibrated yes/no about provided text — verifying a
  claim, classifying a log, gating a playbook step — use `jev ask` rather
  than asking a full model and parsing its prose.
- When a decision matters and you want to know *how sure*, use `--json` and
  report the confidence; don't present a low-confidence yes as a verdict.
- Don't use jev for open-ended questions, code generation, or anything where
  you need prose — it only returns typed distributions.
