#!/usr/bin/env python3
"""Run the jev benchmark against the live endpoint through the real CLI.

  python3 bench/jev/run.py [--reps 3] [--workers 4] [--only VARIANT]

Each (case, variant, rep) is one `jev ... --json` subprocess. Rows append to
results.jsonl; rows already there are skipped, so a rerun only fills gaps and
analyze.py never needs the network. Delete results.jsonl to start over.
No --confidence is passed: the gate is local (confidence < MIN -> unsure), so
analyze.py applies any threshold to the recorded confidence.
"""
import argparse
import json
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
JEV = HERE.parent.parent / "shared" / "jev" / "bin" / "jev"
DATASET = HERE / "dataset.jsonl"
RESULTS = HERE / "results.jsonl"

# Alternative wordings. invert: the question asks the opposite of the label
# (yes = claim true), so P(label yes) = 1 - p_yes.
DOUBT_VARIANTS = {
    "doubt:false": ("This claim is false.", False),
    "doubt:incorrect": ("This statement is factually incorrect.", False),
    "doubt:true-inv": ("This claim is true.", True),
}
PLAN_VARIANTS = {
    "plan:either": "The plan either fixes finding {id} ({title}: {what}) or explicitly skips it with a reason.",
    "plan:step-or-skip": "The plan has a step that fixes this problem: {title} ({what}); or it marks finding {id} as SKIP and says why.",
    "plan:short": "This plan addresses finding {id}: {title}.",
}
PLAN_BASE = "This plan fixes finding {id} ({title}: {what}), or states explicitly why that finding is skipped."


def jobs(case):
    """-> [(variant, argv, stdin, invert)] for one case."""
    if case["cmd"] == "doubt":
        out = [("base", ["doubt", case["claim"]], None, False)]
        out += [(v, ["ask", q, "-t", case["claim"]], None, inv) for v, (q, inv) in DOUBT_VARIANTS.items()]
        return out
    if case["cat"] == "plan":
        f = case["finding"]
        out = [("base", ["ask", PLAN_BASE.format(**f)], case["text"], False)]
        out += [(v, ["ask", q.format(**f)], case["text"], False) for v, q in PLAN_VARIANTS.items()]
        return out
    return [("base", ["ask", case["question"]], case["text"], False)]


_backoff_until = 0.0
_lock = threading.Lock()


def call(argv, stdin):
    """One CLI call with retry on no-answer errors; -> result dict."""
    global _backoff_until
    for attempt in range(5):
        wait = _backoff_until - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        t0 = time.monotonic()
        p = subprocess.run([sys.executable, str(JEV), *argv, "--json"], input=stdin,
                           capture_output=True, text=True, timeout=90)
        latency = time.monotonic() - t0
        if p.returncode in (0, 1):
            a = json.loads(p.stdout)
            return {"rc": p.returncode, "verdict": a["verdict"],
                    "p_yes": a["probabilities"]["yes"], "confidence": a["confidence"],
                    "latency": round(latency, 3), "attempts": attempt + 1}
        with _lock:  # shared backoff: every worker pauses after an error
            _backoff_until = max(_backoff_until, time.monotonic() + 2 ** attempt)
    return {"rc": p.returncode, "error": p.stderr.strip()[:300],
            "latency": round(latency, 3), "attempts": attempt + 1}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--only", help="run only this variant (e.g. base, plan:short)")
    args = ap.parse_args()
    assert 1 <= args.workers <= 4, "at most 4 in flight"

    done = set()
    if RESULTS.exists():
        for line in RESULTS.read_text().splitlines():
            r = json.loads(line)
            if "error" not in r:  # failed rows are retried on the next run
                done.add((r["case"], r["variant"], r["rep"]))
    todo = []
    for line in DATASET.read_text().splitlines():
        case = json.loads(line)
        for variant, argv, stdin, invert in jobs(case):
            if args.only and variant != args.only:
                continue
            for rep in range(args.reps):
                if (case["id"], variant, rep) not in done:
                    todo.append((case["id"], variant, rep, argv, stdin, invert))
    print(f"{len(todo)} calls to make ({len(done)} cached)", file=sys.stderr)

    out = RESULTS.open("a")

    def work(job):
        cid, variant, rep, argv, stdin, invert = job
        row = {"case": cid, "variant": variant, "rep": rep, "invert": invert, **call(argv, stdin)}
        with _lock:
            out.write(json.dumps(row) + "\n")
            out.flush()
        return row

    errors = 0
    with ThreadPoolExecutor(args.workers) as ex:
        for i, row in enumerate(ex.map(work, todo), 1):
            errors += "error" in row
            if i % 50 == 0 or i == len(todo):
                print(f"{i}/{len(todo)} done, {errors} errors", file=sys.stderr)
    out.close()


if __name__ == "__main__":
    main()
