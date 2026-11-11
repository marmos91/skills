#!/usr/bin/env python3
"""Analyze results.jsonl (from run.py) against dataset.jsonl. No network.

  python3 shared/jev/bench/analyze.py   # prints markdown tables
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = {c["id"]: c for c in map(json.loads, (HERE / "dataset.jsonl").read_text().splitlines())}
ROWS = [json.loads(l) for l in (HERE / "results.jsonl").read_text().splitlines()]
OK = [r for r in ROWS if "error" not in r]
for r in OK:
    c = CASES[r["case"]]
    r["p"] = 1 - r["p_yes"] if r["invert"] else r["p_yes"]  # P(label "yes")
    r["pred"] = "yes" if r["p"] >= 0.5 else "no"
    r["correct"] = r["pred"] == c["label"]
    r["cat"], r["label"] = c["cat"], c["label"]
    r["kind"] = c.get("kind", "")
    r["u"] = min(r["p_yes"], 1 - r["p_yes"])  # distance to the 0.5 line, as 0.5 - |p - 0.5|
BASE = [r for r in OK if r["variant"] == "base"]


def table(head, rows):
    print("| " + " | ".join(head) + " |")
    print("|" + "---|" * len(head))
    for row in rows:
        print("| " + " | ".join(str(x) for x in row) + " |")
    print()


def acc(rs):
    return f"{sum(r['correct'] for r in rs) / len(rs):.1%}" if rs else "-"


def auroc(rs, key):
    """P(score of a correct row > score of a wrong row); ties count half."""
    pos = [key(r) for r in rs if r["correct"]]
    neg = [key(r) for r in rs if not r["correct"]]
    if not pos or not neg:
        return "-"
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return f"{wins / (len(pos) * len(neg)):.2f}"


def pct(xs, q):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(q * len(xs)))]


print(f"## Volume\n\n{len(CASES)} cases, {len(ROWS)} calls, {len(ROWS) - len(OK)} errors "
      f"({(len(ROWS) - len(OK)) / len(ROWS):.1%}), retries: {sum(r['attempts'] > 1 for r in ROWS)}.\n")
lat = [r["latency"] for r in ROWS]
print(f"Latency per call (CLI process incl. startup): p50 {pct(lat, .5):.2f} s, "
      f"p95 {pct(lat, .95):.2f} s, max {max(lat):.2f} s.\n")

print("## Accuracy, base wording (each call counted; 3 reps per case)\n")
by = defaultdict(list)
for r in BASE:
    by[r["cat"]].append(r)
table(["category", "cases", "calls", "accuracy", "wrong yes", "wrong no"],
      [[k, len(v) // 3, len(v), acc(v),
        sum(not r["correct"] and r["pred"] == "yes" for r in v),
        sum(not r["correct"] and r["pred"] == "no" for r in v)]
       for k, v in sorted(by.items())] +
      [["**all**", len(BASE) // 3, len(BASE), acc(BASE),
        sum(not r["correct"] and r["pred"] == "yes" for r in BASE),
        sum(not r["correct"] and r["pred"] == "no" for r in BASE)]])

by = defaultdict(list)
for r in BASE:
    if r["kind"]:
        by[(r["cat"], r["kind"])].append(r)
table(["category", "kind", "calls", "accuracy"],
      [[c, k, len(v), acc(v)] for (c, k), v in sorted(by.items())])

print("Wrong cases (base):\n")
wrong = sorted({r["case"] for r in BASE if not r["correct"]})
for cid in wrong:
    rs = [r for r in BASE if r["case"] == cid]
    c = CASES[cid]
    what = c.get("question") or c.get("claim") or c["finding"]["id"]
    print(f"- {cid} ({c['cat']}, label {c['label']}): {what!r} -> "
          f"p_yes {rs[0]['p_yes']:.3g}, confidence {rs[0]['confidence']:.2f}")
print()

print("## Determinism (all variants)\n")
groups = defaultdict(list)
for r in OK:
    groups[(r["case"], r["variant"])].append(r)
same_v = sum(len({r["verdict"] for r in g}) == 1 for g in groups.values())
spread_p = max(max(r["p_yes"] for r in g) - min(r["p_yes"] for r in g) for g in groups.values())
spread_c = max(max(r["confidence"] for r in g) - min(r["confidence"] for r in g) for g in groups.values())
print(f"{same_v}/{len(groups)} (case, wording) groups give the same verdict on every repeat; "
      f"max spread across repeats: p_yes {spread_p:.2g}, confidence {spread_c:.2g}.\n")

print("## What predicts correctness (base)\n")
table(["signal", "AUROC (correct vs wrong)"],
      [["confidence", auroc(BASE, lambda r: r["confidence"])],
       ["p_yes margin |p_yes - 0.5|", auroc(BASE, lambda r: -r["u"])]])
for pred in ("yes", "no"):
    rs = [r for r in BASE if r["pred"] == pred]
    cs = [r["confidence"] for r in rs]
    print(f"- answered {pred}: {len(rs)} calls, accuracy {acc(rs)}, confidence "
          f"median {statistics.median(cs):.2f} (min {min(cs):.2f}, max {max(cs):.2f})")
print()

print("Accuracy by confidence bucket (base):\n")
rows = []
for lo in [i / 10 for i in range(10)]:
    rs = [r for r in BASE if lo <= r["confidence"] < lo + 0.1 or (lo == 0.9 and r["confidence"] == 1)]
    rows.append([f"{lo:.1f}-{lo + .1:.1f}", len(rs), acc(rs),
                 sum(r["pred"] == "yes" for r in rs), sum(r["pred"] == "no" for r in rs)])
table(["confidence", "calls", "accuracy", "answered yes", "answered no"], rows)

print("Accuracy by p_yes margin (base); u = min(p_yes, 1 - p_yes) = 0.5 - |p_yes - 0.5|:\n")
edges = [0, 1e-9, 1e-6, 1e-3, 0.05, 0.2, 0.5001]
table(["u range", "calls", "accuracy"],
      [[f"{a:g}-{b:g}", len(rs), acc(rs)]
       for a, b in zip(edges, edges[1:])
       for rs in [[r for r in BASE if a <= r["u"] < b]]])

print("Hypothetical margin gate (not in the CLI): unsure when min(p_yes, 1 - p_yes) >= U (base):\n")
table(["U", "answered", "accuracy answered", "wrong answers kept"],
      [[u, f"{len(ans) / len(BASE):.0%}", acc(ans), sum(not r["correct"] for r in ans)]
       for u in (0.5001, 1e-3, 1e-6, 1e-9, 1e-12)
       for ans in [[r for r in BASE if r["u"] < u]]])


def sweep(rs, title):
    print(f"`--confidence` sweep, {title} ({len(rs)} calls):\n")
    rows = []
    for t in [0, .1, .2, .3, .4, .5, .6, .7, .8, .9, .95]:
        ans = [r for r in rs if r["confidence"] >= t]
        nos = [r for r in ans if r["pred"] == "no"]
        rows.append([t, f"{len(ans) / len(rs):.0%}", acc(ans),
                     f"{sum(r['correct'] for r in nos)}/{len(nos)}",
                     sum(r["label"] == "no" and r["pred"] == "no" for r in ans),
                     sum(r["label"] == "yes" and r["pred"] == "no" for r in ans)])
    table(["MIN", "answered", "accuracy answered", "correct 'no' / 'no'",
           "true 'no' (gap caught)", "wrong 'no' (false gap)"], rows)


sweep(BASE, "all categories, base wording")
plan_base = [r for r in BASE if r["cat"] == "plan"]
sweep(plan_base, "plan coverage, base wording")
gaps = sum(r["label"] == "no" for r in plan_base)
print(f"Plan coverage has {gaps} true-gap calls ({gaps // 3} findings x 3 reps).\n")

print("## Wordings\n")
for cat, base_q in (("doubt", "This claim is doubtful or likely false. (current)"),
                    ("plan", "This plan fixes finding <id> (<title>: <what>), or states explicitly why that finding is skipped. (current)")):
    vs = defaultdict(list)
    for r in OK:
        if r["cat"] == cat:
            vs[r["variant"]].append(r)
    rows = []
    for v, rs in sorted(vs.items(), key=lambda kv: kv[0] != "base"):
        rows.append([base_q if v == "base" else v, len(rs), acc(rs),
                     sum(not r["correct"] and r["pred"] == "yes" for r in rs),
                     sum(not r["correct"] and r["pred"] == "no" for r in rs),
                     auroc(rs, lambda r: r["confidence"])])
    table(["wording", "calls", "accuracy", "wrong yes", "wrong no", "conf AUROC"], rows)
    kinds = sorted({r["kind"] for r in vs["base"]})
    table(["wording"] + kinds + ["held-out plan"],
          [[v] + [acc([r for r in rs if r["kind"] == k]) for k in kinds] +
           [acc([r for r in rs if CASES[r["case"]].get("heldout")])]
           for v, rs in sorted(vs.items())])
    if cat == "plan":
        for v, rs in sorted(vs.items()):
            if v != "base":
                sweep(rs, f"plan coverage, {v}")
