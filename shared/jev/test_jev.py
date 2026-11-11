#!/usr/bin/env python3
"""Self-check for jev.py — exercises argument parsing and exit-code logic
against a stubbed API. Run: python3 test_jev.py (no network, no secrets)."""
import json
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import jev  # noqa: E402


def run_main(argv, stdin_text=""):
    with patch.object(sys, "argv", ["jev"] + argv):
        with patch.object(sys.stdin, "read", return_value=stdin_text):
            try:
                jev.main()
                return 0, ""
            except SystemExit as e:
                return e.code, ""


ANS = {
    "noul": 0.9,
    "probabilities": {"yes": 0.9, "no": 0.1},
    "confidence": 0.8,
}


def main():
    # ask: high p_yes -> yes, exit 0
    with patch.object(jev, "ask_noul", return_value=ANS):
        code, _ = run_main(["ask", "q?", "-t", "text"])
        assert code == 0, code

        # low p_yes -> no, exit 1
        low = dict(ANS, noul=0.1, probabilities={"yes": 0.1, "no": 0.9})
        with patch.object(jev, "ask_noul", return_value=low):
            code, _ = run_main(["ask", "q?", "-t", "text"])
            assert code == 1, code

        # -e with low confidence -> refuses to guess, exit 1
        unsure = dict(ANS, confidence=0.1)
        with patch.object(jev, "ask_noul", return_value=unsure):
            code, _ = run_main(["ask", "q?", "-t", "text", "-e", "--confidence", "0.5"])
            assert code == 1, code
            # without -e it still answers by threshold
            code, _ = run_main(["ask", "q?", "-t", "text"])
            assert code == 0, code

    # doubt: doubted -> exit 0, trusted -> exit 1
    with patch.object(jev, "ask_noul", return_value=ANS):
        code, _ = run_main(["doubt", "claim"])
        assert code == 0, code
    low = dict(ANS, noul=0.1, probabilities={"yes": 0.1, "no": 0.9})
    with patch.object(jev, "ask_noul", return_value=low):
        code, _ = run_main(["doubt", "claim"])
        assert code == 1, code

    # request shape: question in criteria.true.text
    captured = {}

    def fake_ask(question, text):
        captured["question"] = question
        captured["state_text"] = text
        return ANS

    with patch.object(jev, "ask_noul", side_effect=fake_ask):
        run_main(["ask", "is it about pasta?", "-t", "about weather"])
        assert captured["question"] == "is it about pasta?"
        assert captured["state_text"] == "about weather"

    print("test_jev: all assertions passed")


if __name__ == "__main__":
    main()
