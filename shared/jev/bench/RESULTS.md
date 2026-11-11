# jev benchmark results

Measured 2026-11-11 against the live SystemOne endpoint through the real CLI
(`bin/jev ... --json`, one subprocess per call).

## Method

- `cases.py` holds 148 hand-written, hand-labeled cases and writes
  `dataset.jsonl`. Label = the side `P(yes) >= 0.5` should land on (for `doubt`,
  yes = the claim is false).
- `run.py` runs every case 3 times, at most 4 calls in flight, with a shared
  backoff on errors. Rows are cached in `results.jsonl`. Doubt and plan cases
  also run 3 alternative wordings each. No `--confidence` is passed: the gate is
  applied locally to the recorded confidence, so `analyze.py` sweeps it offline.
- `analyze.py` prints every table below.

| category | cases | label yes / no | notes |
|---|---|---|---|
| grounded | 30 | 15 / 15 | yes/no question about a short text |
| negation | 20 | 9 / 11 | negated questions or texts, comparisons |
| logs | 20 | 10 / 10 | build, test, k8s, git, HTTP, OOM output |
| plan | 36 | 23 / 13 | fix.sh question shape; 6 plans x 6 findings: 16 covered, 7 explicit skip, 9 absent, 4 partial |
| doubt | 30 | 20 / 10 | 10 true, 10 false, 10 plausible-but-false claims |
| length | 12 | 6 / 6 | 8 texts of 4-6 KB, 4 of 1-4 bytes |

Plan F (6 findings) is held out. I wrote it after the first comparison of
wordings, and its skips say "not fixing" and "won't fix" instead of "SKIP".
Totals: 1038 calls, 0 errors, 0 retries. Latency per call, including CLI
startup: p50 0.29 s, p95 0.50 s.

## Findings

**Accuracy with the wordings in use at the time (444 calls):** 93.2%. Grounded,
negation, logs and length cases are all 100%. Doubt is 96.7%: one miss in 30
cases, "HTTP 403 means not authenticated", trusted on every repeat. Plan coverage
is 75.0%, and the misses are systematic. Absent and covered findings score 100%.
Explicit skips score 14.3%: 6 of 7 skipped findings are flagged as gaps. Partial
fixes score 25%: they mostly pass as covered.

**Determinism:** in 346 of 346 (case, wording) groups, every repeat gives the
same verdict. The raw numbers move a little: p_yes by up to 0.38 and confidence
by up to 0.18.

**`confidence` does not predict correctness.** Its AUROC for separating right
from wrong answers is 0.53, which is chance level. It tracks the verdict instead:
median 0.92 on "no" answers and 0.48 on "yes" answers. This explains the 0.26
for "The sky is blue." Its accuracy by bucket is flat (82-100%, no trend). On
plan coverage with the old wording, raising `--confidence` from 0 to 0.7 cuts
the caught gaps from 30 to 18 and leaves the false gaps at 15. At 0.9, 6 false
gaps remain against 3 caught, and only 8% of calls get an answer.

**The p_yes margin does predict correctness:** AUROC 0.96. Most answers are
saturated, though. 411 of 444 calls have `min(p_yes, 1-p_yes) < 1e-9`, and 15
wrong answers are among them. A margin gate would need thresholds deep in that
range:

| unsure when min(p_yes, 1-p_yes) >= | answered | accuracy answered |
|---|---|---|
| (no gate) | 100% | 93.2% |
| 1e-6 | 95% | 95.0% |
| 1e-9 | 93% | 96.4% |
| 1e-12 | 77% | 100.0% |

The 1e-12 row is fitted on this data: the nearest wrong answers sit at 4.8e-12,
so treat it as fragile.

## Wordings

Doubt, 90 calls each:

| wording | accuracy |
|---|---|
| This claim is doubtful or likely false. (current) | 96.7% |
| This statement is factually incorrect. | 96.7% |
| This claim is false. | 93.3% |
| This claim is true. (answer inverted) | 93.3% |

Plan coverage, 108 calls each. A false gap is a wrong "no", which costs a revise
round. 39 calls are true gaps (13 findings x 3).

| wording | accuracy | gaps caught | false gaps | held-out plan |
|---|---|---|---|---|
| This plan fixes finding {id} ({title}: {what}), or states explicitly why that finding is skipped. (old) | 75.0% | 30 | 18 | 83.3% |
| The plan either fixes finding {id} ({title}: {what}) or explicitly skips it with a reason. | 80.6% | 30 | 12 | 66.7% |
| **The plan has a step that fixes this problem: {title} ({what}); or it marks finding {id} as SKIP and says why.** | **88.9%** | 27 | **0** | **100%** |
| This plan addresses finding {id}: {title}. | 75.0% | 33 | 21 | 66.7% |

With the chosen wording, the `--confidence` sweep gives 0 false gaps at every
bar. The bar only drops caught gaps: 27 at 0, 21 at 0.5, 12 at 0.9. The chosen
wording still misses 3 of 4 partial fixes, plus one absent finding (A11Y-5, alt
text), which it judged covered.

## Decisions

- **fix.sh plan-coverage question:** switched to the step-or-skip wording. It
  gave 0 false gaps where the old wording gave 18, and it handled the held-out
  "won't fix" / "not fixing" skips.
- **`JEV_CONFIDENCE` default: 0.5 -> 0 (no gate).** For plan coverage, a wrong
  "no" costs a revise round and "unsure" costs nothing. A gate earns its keep
  only if it removes wrong "no"s. Here it removed none and dropped 6 of 27 caught
  gaps at 0.5.
- **`DOUBT_QUESTION` unchanged.** No wording beat it: "factually incorrect"
  tied at 96.7%.
- **CLI change proposed, not implemented:** gate on the p_yes margin instead of
  `confidence`, for example `--margin U` (unsure when
  `min(p_yes, 1-p_yes) >= U`), or the same idea in log-odds. Keep `confidence`
  in `--json` as data. The threshold needs more varied data first.

## Limits

- The dataset is small and hand-written by one person; the plans are synthetic.
  The plan category has 36 findings and only 6 held out. Repeats are almost
  deterministic, so the real sample is cases, not calls.
- jev does not catch partial coverage with any wording. That stays the plan
  reviewer's job.
- The "base" plan variant in `run.py` is the old fix.sh wording, kept so the
  comparison can be rerun.

## Rerun

```sh
python3 shared/jev/bench/cases.py     # only after editing cases
python3 shared/jev/bench/run.py       # fills missing rows in results.jsonl
python3 shared/jev/bench/analyze.py   # offline
```

Delete `results.jsonl` to measure from scratch, for example after the endpoint
changes.
