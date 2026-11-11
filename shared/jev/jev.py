#!/usr/bin/env python3
"""jev — ask Mimir SystemOne typed yes/no questions, get calibrated answers.

One standard CLI both pi and Claude Code can call from bash in any workflow.
Reads the same sops-provisioned credentials as the Mimir gateway
(~/.config/mimir/api-key, ~/.config/mimir/base-url — the latter ends in /v1).

Exit codes encode the decision so scripts and agent playbooks can branch:
  0 = yes (ask) / doubted (doubt): P(yes) >= 0.5
  1 = no  (ask) / trusted (doubt)
  2 = no answer: missing credentials, API unreachable, bad response, usage
      error, or confidence below --confidence. Never read 2 as "no".

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
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import NoReturn

MIMIR_DIR = Path.home() / ".config" / "mimir"
TIMEOUT = 30
DOUBT_QUESTION = "This claim is doubtful or likely false."
# verdict labels per subcommand: (P(yes) >= 0.5 -> exit 0, otherwise -> exit 1)
LABELS = {"ask": ("yes", "no"), "doubt": ("doubted", "trusted")}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    # urllib keeps the Authorization header across redirects; a 30x is an error
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


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
    """One noul question about text -> {"probabilities": {"yes", "no"}, "confidence"}."""
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
    req = urllib.request.Request(
        f"{base}/systemone",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with _OPENER.open(req, timeout=TIMEOUT) as r:
            resp = json.load(r)
    except urllib.error.HTTPError as e:
        die(f"jev: HTTP {e.code} from SystemOne: {e.read().decode(errors='replace')[:500]}")
    except (OSError, ValueError) as e:  # URLError, timeouts, non-JSON body
        die(f"jev: cannot get an answer from SystemOne: {e}")
    try:
        ans = resp["answers"]["q"]
        probs = {k: float(ans["probabilities"][k]) for k in ("yes", "no")}
        confidence = float(ans["confidence"])
        if not all(0 <= x <= 1 for x in (*probs.values(), confidence)):
            raise ValueError("probability out of [0, 1]")
    except (KeyError, TypeError, ValueError):
        die(f"jev: unexpected SystemOne response: {str(resp)[:300]}")
    return {"probabilities": probs, "confidence": confidence}


def main() -> None:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--confidence",
        type=float,
        default=0.0,
        metavar="MIN",
        help="answer 'unsure' and exit 2 when confidence < MIN (default 0: no gate)",
    )
    common.add_argument("--json", action="store_true", help="print the answer as one JSON object")

    p = argparse.ArgumentParser(
        prog="jev",
        description="Ask Mimir SystemOne typed questions; calibrated probabilities, not prose.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)
    ask = sub.add_parser(
        "ask", parents=[common], help="a yes/no question about text; exit 0 = yes, 1 = no"
    )
    ask.add_argument("question", help="the yes/no question, phrased so yes is what you act on")
    ask.add_argument("-t", "--text", help="text to judge (default or '-': stdin)")
    doubt = sub.add_parser(
        "doubt", parents=[common], help="is this claim doubtful? exit 0 = doubted, 1 = trusted"
    )
    doubt.add_argument("claim", help="the claim to check, stated plainly")
    args = p.parse_args()

    if args.cmd == "ask":
        question = args.question
        text = sys.stdin.read() if args.text in (None, "-") else args.text
    else:  # the claim is the state; the fixed question makes P(yes) = P(doubtful)
        question, text = DOUBT_QUESTION, args.claim
    if not text.strip():
        die("jev: no text to judge")

    ans = ask_noul(question, text)
    p_yes = ans["probabilities"]["yes"]
    if ans["confidence"] < args.confidence:
        verdict, code = "unsure", 2
    else:
        code = 0 if p_yes >= 0.5 else 1
        verdict = LABELS[args.cmd][code]

    if args.json:
        print(json.dumps({"verdict": verdict, **ans}))
    else:
        print(f"{verdict}  (p_yes={p_yes:.1%}, confidence={ans['confidence']:.1%})")
    sys.exit(code)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # an uncaught crash would exit 1, which reads as "no"
        die(f"jev: {type(e).__name__}: {e}")
