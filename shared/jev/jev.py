#!/usr/bin/env python3
"""jev — ask Mimir SystemOne typed questions, get yes/no (or distributions).

One standard CLI both pi and Claude Code can call from bash in any workflow.
Reads the same sops-provisioned credentials as the Mimir gateway
(~/.config/mimir/api-key, ~/.config/mimir/base-url — the latter ends in /v1).

Exit codes encode the decision so scripts and agent playbooks can branch:
  ask:   0 = yes, 1 = no (with -e, exit 1 when confidence < the threshold)
  doubt: 0 = doubted, 1 = trusted (P(yes) below threshold, default 0.5)
  any:   2 = no answer (missing credentials, API unreachable, bad response,
         usage error) — never read 2 as "no"

Wire format (mapped by probing {base-url}/systemone):
  POST {"state": {"text": ...},
        "questions": {"q": {"type": "noul",
                              "criteria": {"true": {"text": <question>},
                                           "false": null}}}}
  noul answers: {"noul": P(yes), "probabilities": {"yes":..,"no":..},
                 "confidence": ..}
The question travels in criteria.true.text: an empty noul question just asks
"is this positive/true?" about the state, which is why the question must be
phrased so yes = the desired beam. (Probed: question-level 'question',
'prompt', 'instruction', 'query' fields are all rejected with
"unknown field(s)".)
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import NoReturn

MIMIR_DIR = Path.home() / ".config" / "mimir"
DOUBT_QUESTION = "This claim is doubtful or likely false."


def die(msg: str) -> NoReturn:
    # 0/1 are answers; 2 = no answer (same code argparse uses for usage errors)
    print(msg, file=sys.stderr)
    sys.exit(2)


def _secret(name: str) -> str:
    try:
        return (MIMIR_DIR / name).read_text().strip()
    except OSError:
        die(f"jev: cannot read ~/.config/mimir/{name}; run `rebuild` to provision it from sops")


def ask_noul(question: str, text: str) -> dict:
    """One noul question about text. Returns the raw answer object."""
    key = _secret("api-key")
    base = _secret("base-url").rstrip("/")
    body = json.dumps(
        {
            "state": {"text": text},
            "questions": {
                "q": {
                    "type": "noul",
                    "criteria": {"true": {"text": question}, "false": None},
                }
            },
        }
    ).encode()
    try:
        req = urllib.request.Request(
            f"{base}/systemone",
            data=body,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:500]
        die(f"jev: HTTP {e.code} from SystemOne: {detail}")
    except (OSError, ValueError) as e:  # URLError, timeouts, non-JSON body
        die(f"jev: cannot get an answer from SystemOne: {e}")
    try:
        ans = resp["answers"]["q"]
        float(ans["probabilities"]["yes"]), float(ans["confidence"])
    except (KeyError, TypeError, ValueError):
        die(f"jev: unexpected SystemOne response: {str(resp)[:300]}")
    return ans


def fmt_pct(p: float) -> str:
    return f"{p * 100:.1f}%"


def main() -> None:
    p = argparse.ArgumentParser(
        prog="jev",
        description="Ask Mimir SystemOne typed questions; calibrated probabilities, not prose.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    ask = sub.add_parser(
        "ask",
        help="ask a yes/no question about text; exit 0 = yes, 1 = no",
    )
    ask.add_argument("question", help="the yes/no question")
    ask.add_argument(
        "-t",
        "--text",
        help="text to judge (default: stdin, or '-' for stdin explicitly)",
    )
    ask.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="minimum P(yes) to answer yes (default 0.5)",
    )
    ask.add_argument(
        "-e",
        "--exit-on-doubt",
        action="store_true",
        help="exit 1 instead of guessing when confidence < --confidence",
    )
    ask.add_argument(
        "--confidence",
        type=float,
        default=0.5,
        help="confidence below which the answer counts as doubted (default 0.5)",
    )
    ask.add_argument("--json", action="store_true", help="print the raw answer as JSON")

    doubt = sub.add_parser(
        "doubt",
        help="is this claim worth doubting? exit 0 = trusted, 1 = doubted",
    )
    doubt.add_argument("claim", help="the claim to check, stated plainly")
    doubt.add_argument(
        "--threshold",
        type=float,
        default=0.5,
        help="minimum P(yes) to doubt (default 0.5)",
    )
    doubt.add_argument("--json", action="store_true")

    args = p.parse_args()

    if args.cmd == "ask":
        text = args.text
        if text in (None, "-"):
            text = sys.stdin.read()

        ans = ask_noul(args.question, text)
        yes = ans["probabilities"]["yes"]
        if yes >= args.threshold:
            verdict, code = "yes", 0
        else:
            verdict, code = "no", 1
        if args.exit_on_doubt and ans["confidence"] < args.confidence:
            code = 1

        if args.json:
            print(json.dumps({**ans, "verdict": verdict}))
        else:
            print(
                f"{verdict}  (p_yes={fmt_pct(yes)}, confidence={fmt_pct(ans['confidence'])})"
            )
        sys.exit(code)

    else:  # doubt
        # the claim is the state; the fixed question makes P(yes) = P(doubtful)
        ans = ask_noul(DOUBT_QUESTION, args.claim)
        doubted = ans["probabilities"]["yes"] >= args.threshold
        if args.json:
            print(json.dumps({**ans, "doubted": doubted}))
        else:
            label = "doubted" if doubted else "trusted"
            print(
                f"{label}  (p_yes={fmt_pct(ans['probabilities']['yes'])}, "
                f"confidence={fmt_pct(ans['confidence'])})"
            )
        sys.exit(0 if doubted else 1)

if __name__ == "__main__":
    main()
