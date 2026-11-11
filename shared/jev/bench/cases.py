#!/usr/bin/env python3
"""Hand-written, hand-labeled jev benchmark cases -> dataset.jsonl.

Run `python3 shared/jev/bench/cases.py` after editing; dataset.jsonl is the
committed output that run.py reads.

Fields: id, cat, cmd (ask|doubt), label (yes|no: the expected P(yes) >= 0.5
side; for doubt, yes = the claim is false, i.e. should be doubted), plus
  ask:   question, text
  doubt: claim, kind (true|false|plausible-false)
  plan:  finding {id, title, what}, text (the plan), kind (covered|skip|absent|partial)
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CASES = []


def ask(cat, cid, label, question, text, **extra):
    CASES.append({"id": cid, "cat": cat, "cmd": "ask", "label": label,
                  "question": question, "text": text, **extra})


# --- (a) text-grounded yes/no questions --------------------------------------
G = "grounded"
ask(G, "g01", "yes", "The meeting was moved to Thursday.",
    "Hi all, quick update: because of the office move, Tuesday's planning meeting is now on Thursday at 10:00, same room.")
ask(G, "g02", "no", "The meeting was cancelled.",
    "Hi all, quick update: because of the office move, Tuesday's planning meeting is now on Thursday at 10:00, same room.")
ask(G, "g03", "yes", "The function returns None when the list is empty.",
    "def first(xs):\n    if not xs:\n        return None\n    return xs[0]")
ask(G, "g04", "no", "The function raises an exception when the list is empty.",
    "def first(xs):\n    if not xs:\n        return None\n    return xs[0]")
ask(G, "g05", "yes", "The customer is asking for a refund.",
    "Hello, I ordered the blue jacket (order 4471) but it arrived torn at the seam. I'd like my money back please, I don't want a replacement.")
ask(G, "g06", "no", "The customer wants a replacement item.",
    "Hello, I ordered the blue jacket (order 4471) but it arrived torn at the seam. I'd like my money back please, I don't want a replacement.")
ask(G, "g07", "yes", "The release includes a breaking change.",
    "v3.0.0\n- BREAKING: `connect()` now requires a `timeout` argument.\n- Fixed a race in the retry loop.\n- Docs: new quickstart.")
ask(G, "g08", "no", "The release includes a breaking change.",
    "v2.4.1\n- Fixed a race in the retry loop.\n- Docs: typo fixes in the quickstart.\n- Internal: bumped test dependencies.")
ask(G, "g09", "yes", "The candidate has more than five years of Go experience.",
    "Senior backend engineer. 2016-2019 Go at Acme (payments). 2019-2024 Go at Globex (storage, team lead). Before that, Java.")
ask(G, "g10", "no", "The candidate has worked with Rust professionally.",
    "Senior backend engineer. 2016-2019 Go at Acme (payments). 2019-2024 Go at Globex (storage, team lead). Before that, Java.")
ask(G, "g11", "yes", "The PR description says tests were added.",
    "This PR fixes the off-by-one in pagination. I added two tests in test_pages.py covering the last page and an empty result.")
ask(G, "g12", "no", "The PR changes the database schema.",
    "This PR fixes the off-by-one in pagination. I added two tests in test_pages.py covering the last page and an empty result.")
ask(G, "g13", "yes", "The recipe is vegetarian.",
    "Ingredients: 400 g chickpeas, 1 onion, 2 garlic cloves, 1 tin tomatoes, spinach, cumin, olive oil, salt.")
ask(G, "g14", "no", "The recipe is vegetarian.",
    "Ingredients: 400 g minced beef, 1 onion, 2 garlic cloves, 1 tin tomatoes, oregano, olive oil, salt.")
ask(G, "g15", "yes", "The contract can be terminated with 30 days' notice.",
    "Either party may terminate this agreement at any time by giving the other party thirty (30) days' written notice.")
ask(G, "g16", "no", "The contract renews automatically.",
    "This agreement runs for twelve months from the start date and ends on that date unless both parties sign a new agreement.")
ask(G, "g17", "yes", "The train arrives before noon.",
    "Train IC 512 departs Milano Centrale at 09:05 and arrives in Roma Termini at 11:59.")
ask(G, "g18", "no", "The train arrives before noon.",
    "Train IC 518 departs Milano Centrale at 10:05 and arrives in Roma Termini at 13:10.")
ask(G, "g19", "yes", "The config enables TLS.",
    "server:\n  port: 8443\n  tls:\n    enabled: true\n    cert: /etc/certs/srv.pem")
ask(G, "g20", "no", "The config enables TLS.",
    "server:\n  port: 8080\n  tls:\n    enabled: false\n  log_level: info")
ask(G, "g21", "yes", "The review approves the change.",
    "Looks good to me. Small nit on naming in utils.py but not blocking. Approving.")
ask(G, "g22", "no", "The review approves the change.",
    "This breaks the public API for existing callers. Please keep the old signature and add a new function instead. Requesting changes.")
ask(G, "g23", "yes", "The email mentions a deadline.",
    "Hi Marco, please send the signed form back by Friday 14 March so we can process your onboarding. Thanks, HR")
ask(G, "g24", "no", "The email mentions a deadline.",
    "Hi Marco, welcome aboard! Your laptop is ready for pickup at the front desk whenever suits you. Thanks, IT")
ask(G, "g25", "yes", "The SQL query filters by date.",
    "SELECT id, total FROM orders WHERE created_at >= '2024-01-01' ORDER BY total DESC;")
ask(G, "g26", "no", "The SQL query deletes rows.",
    "SELECT id, total FROM orders WHERE created_at >= '2024-01-01' ORDER BY total DESC;")
ask(G, "g27", "yes", "The patient is allergic to penicillin.",
    "Allergies: penicillin (rash, 2015). Current meds: none. Reason for visit: sore throat for three days.")
ask(G, "g28", "no", "The patient takes daily medication.",
    "Allergies: penicillin (rash, 2015). Current meds: none. Reason for visit: sore throat for three days.")
ask(G, "g29", "yes", "Python 3.12 is a supported version.",
    "Supported Python versions: 3.10, 3.11, 3.12. Python 3.9 reached end of support in this release.")
ask(G, "g30", "no", "Python 3.9 is a supported version.",
    "Supported Python versions: 3.10, 3.11, 3.12. Python 3.9 reached end of support in this release.")

# --- (b) negations and trick phrasing ----------------------------------------
N = "negation"
ask(N, "n01", "yes", "The deployment did not fail.",
    "Deploy #812 to production finished successfully in 4m12s. All health checks green.")
ask(N, "n02", "no", "The deployment did not fail.",
    "Deploy #813 to production failed at step 'migrate': relation \"users_v2\" already exists. Rolled back.")
ask(N, "n03", "no", "The deployment failed.",
    "The deployment did not fail; it completed in four minutes with every health check green.")
ask(N, "n04", "yes", "The report says nothing was lost.",
    "Incident summary: the disk filled up for 20 minutes, but no data was lost because writes were retried from the queue.")
ask(N, "n05", "no", "Data was lost during the incident.",
    "Incident summary: the disk filled up for 20 minutes, but no data was lost because writes were retried from the queue.")
ask(N, "n06", "yes", "It is not true that the store is open on Sundays.",
    "Opening hours: Monday to Saturday 9:00-19:00. Closed on Sundays and public holidays.")
ask(N, "n07", "no", "The store is open on Sundays.",
    "Opening hours: Monday to Saturday 9:00-19:00. Closed on Sundays and public holidays.")
ask(N, "n08", "yes", "None of the tests failed.",
    "Ran 214 tests in 12.3s\n\nOK (skipped=3)")
ask(N, "n09", "no", "None of the tests failed.",
    "Ran 214 tests in 12.3s\n\nFAILED (failures=1, skipped=3)")
ask(N, "n10", "no", "The author agrees with the proposal.",
    "I can't say I'm against the idea in principle, but I will not support this proposal as written: the cost estimate is missing.")
ask(N, "n11", "yes", "The author opposes the proposal as written.",
    "I can't say I'm against the idea in principle, but I will not support this proposal as written: the cost estimate is missing.")
ask(N, "n12", "no", "The text says the bug was fixed in version 2.0.",
    "The crash on startup was reported in version 2.0 and fixed in version 2.1.")
ask(N, "n13", "yes", "The bug was fixed after it was reported.",
    "The crash on startup was reported in version 2.0 and fixed in version 2.1.")
ask(N, "n14", "no", "The function is never called.",
    "def helper(x):\n    return x * 2\n\ndef main():\n    print(helper(21))\n\nmain()")
ask(N, "n15", "yes", "The variable is not used anywhere after it is assigned.",
    "def run():\n    result = compute()\n    log('done')\n    return 0")
ask(N, "n16", "no", "Alice is older than Bob.",
    "Alice was born in 1990. Bob was born in 1985. Carol was born in 1995.")
ask(N, "n17", "yes", "Carol is the youngest of the three.",
    "Alice was born in 1990. Bob was born in 1985. Carol was born in 1995.")
ask(N, "n18", "no", "The text recommends upgrading immediately.",
    "There is no need to upgrade right away: the vulnerability only affects deployments that expose the admin port publicly, which the default config does not.")
ask(N, "n19", "yes", "The default configuration is not affected by the vulnerability.",
    "There is no need to upgrade right away: the vulnerability only affects deployments that expose the admin port publicly, which the default config does not.")
ask(N, "n20", "no", "The flag is disabled by default.",
    "--cache: keep a local cache of downloaded files. On by default; pass --no-cache to turn it off.")

# --- (c) log / output classification -----------------------------------------
L = "logs"
ask(L, "l01", "yes", "The process was killed because it ran out of memory.",
    "2024-05-02T10:14:03Z worker-3 started\n2024-05-02T10:16:41Z worker-3 rss=7.8GiB\nkernel: Out of memory: Killed process 4121 (python3) total-vm:9123456kB\nworker-3 exited with code 137")
ask(L, "l02", "no", "The process was killed because it ran out of memory.",
    "2024-05-02T10:14:03Z worker-3 started\n2024-05-02T10:16:41Z worker-3 processed 1200 jobs\n2024-05-02T10:16:42Z worker-3 received SIGTERM, draining\nworker-3 exited with code 0")
ask(L, "l03", "yes", "The build succeeded.",
    "   Compiling serde v1.0.197\n   Compiling app v0.3.0 (/src/app)\n    Finished release [optimized] target(s) in 41.02s")
ask(L, "l04", "no", "The build succeeded.",
    "   Compiling app v0.3.0 (/src/app)\nerror[E0308]: mismatched types\n --> src/main.rs:12:18\n  |\n12|     let n: u32 = \"5\";\n  |            ---   ^^^ expected `u32`, found `&str`\nerror: could not compile `app` due to previous error")
ask(L, "l05", "yes", "At least one test failed.",
    "============ test session starts ============\ncollected 58 items\n\ntests/test_api.py ......F...\n\n================= FAILURES =================\n___ test_create_user_duplicate ___\nAssertionError: expected 409, got 500\n======= 1 failed, 57 passed in 3.21s =======")
ask(L, "l06", "no", "At least one test failed.",
    "============ test session starts ============\ncollected 58 items\n\ntests/test_api.py ..........\ntests/test_db.py ..............\n======= 58 passed in 3.02s =======")
ask(L, "l07", "yes", "The error is a network timeout.",
    "requests.exceptions.ConnectTimeout: HTTPSConnectionPool(host='api.stripe.com', port=443): Max retries exceeded with url: /v1/charges (Caused by ConnectTimeoutError(..., 'Connection to api.stripe.com timed out. (connect timeout=10)'))")
ask(L, "l08", "no", "The error is a network timeout.",
    "Traceback (most recent call last):\n  File \"app.py\", line 30, in <module>\n    total = sum(prices) / len(prices)\nZeroDivisionError: division by zero")
ask(L, "l09", "yes", "The error is caused by a missing file.",
    "Error: ENOENT: no such file or directory, open '/app/config/production.json'\n    at Object.openSync (node:fs:601:3)\n    at loadConfig (/app/src/config.js:12:20)")
ask(L, "l10", "no", "The error is caused by a missing file.",
    "Error: EACCES: permission denied, open '/var/log/app/out.log'\n    at Object.openSync (node:fs:601:3)\n    at createLogger (/app/src/log.js:8:14)")
ask(L, "l11", "yes", "The container is stuck in a crash loop.",
    "NAME                     READY   STATUS             RESTARTS      AGE\napi-7d9f8b6c5-x2kqp      0/1     CrashLoopBackOff   14 (2m ago)   41m\ndb-0                     1/1     Running            0             3d")
ask(L, "l12", "no", "The container is stuck in a crash loop.",
    "NAME                     READY   STATUS    RESTARTS   AGE\napi-7d9f8b6c5-x2kqp      1/1     Running   0          41m\ndb-0                     1/1     Running   0          3d")
ask(L, "l13", "yes", "The disk is almost full.",
    "Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1  100G   97G  3.0G  98% /\ntmpfs           7.8G     0  7.8G   0% /dev/shm")
ask(L, "l14", "no", "The disk is almost full.",
    "Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1  100G   31G   69G  31% /\ntmpfs           7.8G     0  7.8G   0% /dev/shm")
ask(L, "l15", "yes", "The git push was rejected.",
    "To github.com:acme/api.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'github.com:acme/api.git'\nhint: Updates were rejected because the remote contains work that you do not have locally.")
ask(L, "l16", "no", "The git push was rejected.",
    "Enumerating objects: 7, done.\nWriting objects: 100% (4/4), 412 bytes | 412.00 KiB/s, done.\nTo github.com:acme/api.git\n   3f2a1b0..9c4d7e2  main -> main")
ask(L, "l17", "yes", "The HTTP request returned a server error.",
    "10.0.3.7 - - [02/May/2024:10:14:03 +0000] \"POST /api/orders HTTP/1.1\" 502 157 \"-\" \"curl/8.4.0\" rt=30.001")
ask(L, "l18", "no", "The HTTP request returned a server error.",
    "10.0.3.7 - - [02/May/2024:10:14:03 +0000] \"POST /api/orders HTTP/1.1\" 404 157 \"-\" \"curl/8.4.0\" rt=0.004")
ask(L, "l19", "yes", "The database migration was applied.",
    "INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.\nINFO  [alembic.runtime.migration] Running upgrade 3a1c2b -> 7f9e0d, add orders.customer_id index\nINFO  done")
ask(L, "l20", "no", "The database migration was applied.",
    "INFO  [alembic.runtime.migration] Context impl PostgresqlImpl.\nINFO  [alembic.runtime.migration] Will assume transactional DDL.\nINFO  No new upgrade operations to perform; database is at head 7f9e0d")


# --- (d) plan coverage, exact fix.sh question shape ---------------------------
P = "plan"
PLAN_A = """# Plan: auth-hardening

## Files touched
- src/auth/hash.ts: replace md5 hashing with argon2id.
- src/auth/jwt.ts: remove the hardcoded secret fallback.
- src/auth/session.ts: set the Secure flag on the session cookie.
- src/routes/login.ts: call the new verifyPassword() (signature change only).

## Per finding
- AUTH-1 (MD5 password hashing): hashPassword() and verifyPassword() in src/auth/hash.ts switch to argon2id via the `argon2` package already in package.json. Existing md5 hashes are upgraded on next successful login: verify with md5 once, then rehash with argon2id and save.
- AUTH-2 (hardcoded JWT secret fallback): getSecret() throws at startup when JWT_SECRET is unset instead of returning 'dev-secret'. The test env sets JWT_SECRET in test/setup.ts.
- AUTH-3 (no rate limit on /login): SKIP. Research confirmed nginx already applies `limit_req zone=login burst=5` to /login in deploy/nginx.conf; a second limiter in the app adds nothing.
- AUTH-4 (session cookie flags): add `secure: true` to the cookie options in src/auth/session.ts.

## Tests
- test/auth/hash.test.ts: an md5 hash still verifies once and is rehashed to argon2id (could fail if the upgrade path writes before verifying).
- test/auth/jwt.test.ts: getSecret() throws when JWT_SECRET is missing.

## Steps
1. feat(auth): hash passwords with argon2id, upgrade md5 hashes on login
2. fix(auth): no JWT secret fallback
3. fix(auth): secure session cookie

## Verification
npm run lint && npm run typecheck && npm test -- auth
"""
for cid, label, kind, fid, title, what in [
    ("pa1", "yes", "covered", "AUTH-1", "Password hash uses MD5", "src/auth/hash.ts hashes passwords with md5; use a slow password hash"),
    ("pa2", "yes", "covered", "AUTH-2", "Hardcoded JWT secret fallback", "src/auth/jwt.ts returns 'dev-secret' when JWT_SECRET is unset"),
    ("pa3", "yes", "skip", "AUTH-3", "No rate limit on /login", "brute-force attempts on /login are not throttled"),
    ("pa4", "no", "partial", "AUTH-4", "Session cookie lacks Secure and SameSite flags", "src/auth/session.ts sets neither Secure nor SameSite on the session cookie"),
    ("pa5", "no", "absent", "AUTH-5", "Password reset tokens never expire", "src/auth/reset.ts stores reset tokens with no expiry, so an old emailed link works forever"),
    ("pa6", "no", "absent", "AUTH-6", "Login error reveals whether an email exists", "src/routes/login.ts answers 'no such user' vs 'wrong password', enabling account enumeration"),
]:
    CASES.append({"id": cid, "cat": P, "cmd": "ask", "label": label, "kind": kind,
                  "finding": {"id": fid, "title": title, "what": what}, "text": PLAN_A})

PLAN_B = """# Plan: dead-code-cleanup

## Files touched
- utils/legacy_csv.py: delete (no importers; research grep found none).
- reports/dates.py, api/dates.py: delete; both callers import common/dates.py instead.
- common/dates.py: new home of parse_iso_date() (the reports/ copy, which handles the trailing Z).
- billing/invoice.py: drop the 40-line commented-out block under compute_vat().
- pyproject.toml: no changes.

## Per finding
- DC-1 (unused module utils/legacy_csv.py): delete the file.
- DC-2 (duplicate date parsing): keep one parse_iso_date() in common/dates.py; reports/ and api/ import it.
- DC-3 (commented-out code in billing/invoice.py): delete the block; git history keeps it.
- DC-4 (unused flag ENABLE_V1_EXPORT): SKIP. The flag is read by infra/helm/values.yaml to turn the v1 export cron on in two customer clusters, so it is not dead; research flagged the finding as wrong.

## Tests
- tests/test_dates.py: parse_iso_date('2024-01-02T03:04:05Z') returns an aware UTC datetime (the api/ copy dropped the Z; the merge must keep the reports/ behaviour).

## Steps
1. refactor(dates): one parse_iso_date in common/dates.py
2. chore: delete utils/legacy_csv.py and dead invoice code

## Verification
ruff check . && pytest -q
"""
for cid, label, kind, fid, title, what in [
    ("pb1", "yes", "covered", "DC-1", "Unused module", "utils/legacy_csv.py is never imported"),
    ("pb2", "yes", "covered", "DC-2", "Duplicate date parsing", "reports/dates.py and api/dates.py both define parse_iso_date with slightly different behaviour"),
    ("pb3", "yes", "covered", "DC-3", "Commented-out code", "billing/invoice.py keeps a 40-line commented-out block under compute_vat()"),
    ("pb4", "yes", "skip", "DC-4", "Unused feature flag", "ENABLE_V1_EXPORT is defined in settings.py but never read"),
    ("pb5", "no", "absent", "DC-5", "Tests for deleted code", "tests/test_old_parser.py only tests old_parser.py, which was deleted last release, and is skipped"),
    ("pb6", "no", "absent", "DC-6", "Unused dependency", "requests-cache is listed in pyproject.toml but never imported"),
]:
    CASES.append({"id": cid, "cat": P, "cmd": "ask", "label": label, "kind": kind,
                  "finding": {"id": fid, "title": title, "what": what}, "text": PLAN_B})

PLAN_C = """# Plan: sql-safety

## Files touched
- internal/search/handler.go: build the WHERE clause with placeholders.
- internal/orders/repo.go: replace the per-order items query with one JOIN.
- migrations/0042_orders_customer_idx.sql: new index.

## Per finding
- SQL-1 (injection in search): handler.go stops using fmt.Sprintf on the q parameter; the query becomes `... WHERE name ILIKE $1` with "%"+q+"%" passed as an argument.
- SQL-3 (N+1 when listing orders): ListOrders() runs one query `SELECT ... FROM orders o LEFT JOIN order_items i ON i.order_id = o.id WHERE o.customer_id = $1` and groups rows in Go.
- SQL-4 (missing index on orders.customer_id): migration 0042 adds `CREATE INDEX CONCURRENTLY orders_customer_id_idx ON orders (customer_id)`.
- SQL-5 (transfer not rolled back on error): SKIP. Research read internal/db/tx.go: WithTx() already defers tx.Rollback() and only commits on a nil error; the finding misread the transfer handler, which runs inside WithTx.

## Tests
- internal/search/handler_test.go: a q of `x' OR '1'='1` returns no rows (fails if the value is still interpolated).
- internal/orders/repo_test.go: ListOrders returns an order with zero items (the LEFT JOIN null row must not become a phantom item).

## Steps
1. fix(search): parameterize the search query
2. perf(orders): list orders with one JOIN
3. perf(db): index orders.customer_id

## Verification
go vet ./... && go test ./internal/... && run the load test with the default pool size of 5
"""
for cid, label, kind, fid, title, what in [
    ("pc1", "yes", "covered", "SQL-1", "SQL injection in search", "internal/search/handler.go builds the WHERE clause with fmt.Sprintf from the q parameter"),
    ("pc2", "no", "absent", "SQL-2", "SQL injection in export", "internal/export/csv.go interpolates the user-supplied sort column into ORDER BY"),
    ("pc3", "yes", "covered", "SQL-3", "N+1 queries listing orders", "ListOrders runs one items query per order"),
    ("pc4", "yes", "covered", "SQL-4", "Missing index", "orders.customer_id is filtered on every request but has no index"),
    ("pc5", "yes", "skip", "SQL-5", "Transfer not rolled back on error", "the transfer handler does not roll back the transaction when the second UPDATE fails"),
    ("pc6", "no", "absent", "SQL-6", "Hardcoded connection pool size", "internal/db/pool.go hardcodes MaxOpenConns to 5; it should come from config"),
]:
    CASES.append({"id": cid, "cat": P, "cmd": "ask", "label": label, "kind": kind,
                  "finding": {"id": fid, "title": title, "what": what}, "text": PLAN_C})

PLAN_D = """# Plan: frontend-a11y

## Files touched
- src/components/IconButton.tsx: require an `label` prop, render it as aria-label.
- src/components/Modal.tsx: wrap content in the existing <FocusTrap> from src/a11y/FocusTrap.tsx.
- src/components/FormField.tsx: render the error message under the input in red.
- src/styles/global.css: delete `*:focus { outline: none }`; add a :focus-visible ring.

## Per finding
- A11Y-1 (icon-only buttons without names): IconButton gets a required `label` prop passed to aria-label; TypeScript flags the 23 call sites, each gets a label.
- A11Y-2 (modal focus not trapped): reuse FocusTrap (already used by Drawer) inside Modal; focus returns to the opener on close.
- A11Y-3 (low-contrast muted text): SKIP. The muted color token belongs to the design-tokens package owned by the design team; the fix is tracked in their issue #212 and is out of this repo.
- A11Y-4 (form errors): FormField shows the error text below the input in the error color.
- A11Y-6 (focus outline removed globally): remove the global outline reset and add `:focus-visible { outline: 2px solid var(--focus) }`.

## Tests
- Modal.test.tsx: Tab from the last element cycles to the first; Escape returns focus to the opener.

## Steps
1. fix(a11y): accessible names for icon buttons
2. fix(a11y): trap focus in Modal
3. fix(a11y): restore focus outlines; show field errors

## Verification
pnpm lint && pnpm typecheck && pnpm test Modal
"""
for cid, label, kind, fid, title, what in [
    ("pd1", "yes", "covered", "A11Y-1", "Icon-only buttons lack accessible names", "IconButton renders only an svg, so screen readers announce 'button'"),
    ("pd2", "yes", "covered", "A11Y-2", "Modal does not trap focus", "Tab moves focus behind the open modal"),
    ("pd3", "yes", "skip", "A11Y-3", "Low contrast muted text", "the muted text color has a 3.1:1 contrast ratio, below WCAG AA 4.5:1"),
    ("pd4", "no", "partial", "A11Y-4", "Form errors are not announced to screen readers", "validation errors are not linked to inputs with aria-describedby and no live region announces them"),
    ("pd5", "no", "absent", "A11Y-5", "Images missing alt text", "ProductCard renders <img> without an alt attribute"),
    ("pd6", "yes", "covered", "A11Y-6", "Focus outline removed globally", "global.css sets outline: none on every focused element"),
]:
    CASES.append({"id": cid, "cat": P, "cmd": "ask", "label": label, "kind": kind,
                  "finding": {"id": fid, "title": title, "what": what}, "text": PLAN_D})

# Long plan (~4 KB): the realistic size for an architect's plan.md.
PLAN_E = """# Plan: ci-reliability

Context: the CI workflow (.github/workflows/ci.yml) runs lint, test and build on
every PR, and deploy.yml ships main to staging. Research (research.md) confirmed
four of the six findings against the current workflows; CI-6 was found wrong.
House rules from AGENTS.md: conventional commits, one concern per commit, no new
third-party actions without pinning, and every workflow change is tested on a
throwaway branch before merge.

## Files touched
- .github/workflows/ci.yml: pin every third-party action to a full commit SHA;
  fix the dependency cache key; add `timeout-minutes: 15` to the `test` job.
- .github/workflows/deploy.yml: pin actions to SHAs (same list as ci.yml).
- tests/upload/test_retry.py: replace the sleep-based wait with a fake clock.
- tests/conftest.py: add a `fake_clock` fixture (monotonic time that tests can
  advance; the uploader already takes a `clock` argument, so no prod change).

## Per finding

- CI-1 (flaky test_upload_retry): the test sleeps 2 s and hopes the third retry
  happened. The uploader accepts an injectable clock (src/upload/retry.py,
  `Retrier(clock=time.monotonic)`), so the test passes `fake_clock`, advances it
  past each backoff, and asserts exactly three attempts. No sleeps remain in
  tests/upload/. This removes the timing dependency that made it fail on busy
  runners about once in thirty runs.

- CI-2 (unpinned actions): actions/checkout@main, actions/setup-node@v4,
  actions/cache@v4 and docker/build-push-action@master are replaced with their
  current release commit SHAs, each with a trailing `# vX.Y.Z` comment so
  Dependabot (already configured for github-actions in .github/dependabot.yml)
  keeps proposing bumps. Both ci.yml and deploy.yml change.

- CI-3 (cache key ignores the lockfile): the cache key becomes
  `${{ runner.os }}-node-${{ hashFiles('pnpm-lock.yaml') }}` with a restore key
  of `${{ runner.os }}-node-`. Today the key is just the OS, so a dependency bump
  restores a stale store and the install step silently reuses old packages.

- CI-5 (jobs have no timeout): add `timeout-minutes: 15` to the `test` job in
  ci.yml. The test suite takes about six minutes, so fifteen leaves room for a
  slow runner while stopping a hung test from burning the default six hours.

- CI-6 (Docker image built twice): SKIP. Research checked ci.yml after PR #88:
  the build job uploads the image as an artifact and the deploy job downloads
  it; nothing rebuilds. The finding described the workflow before #88.

## Design
No new workflow, no new composite action: the pins and the cache key are edits
in place, and the fake clock reuses the injection point the uploader already
has. The fixture lives in tests/conftest.py because two other test modules
(tests/upload/test_resume.py and tests/sync/test_backoff.py) can use it later;
this plan does not change them.

## Tests
- tests/upload/test_retry.py::test_retries_three_times: with the fake clock
  advanced past each backoff, the uploader makes exactly three attempts and then
  raises UploadFailed. It could fail if the backoff schedule reads wall time
  anywhere other than the injected clock.
- No tests for the workflow edits; they are verified by running CI on a branch.

## Steps
1. test(upload): drive the retry test with a fake clock
2. ci: pin third-party actions to commit SHAs
3. ci: key the dependency cache on the lockfile
4. ci: time out the test job after 15 minutes

Each step keeps the tree green: step 1 only touches tests, steps 2-4 only touch
workflow YAML and are checked by a branch run.

## Verification
- `pnpm lint && pnpm test` locally for step 1.
- `actionlint .github/workflows/*.yml` for steps 2-4.
- Push the branch, confirm the CI run is green, then re-run it once to confirm
  the second run restores the cache (the log shows "Cache restored from key").
"""
for cid, label, kind, fid, title, what in [
    ("pe1", "yes", "covered", "CI-1", "Flaky retry test", "tests/upload/test_retry.py sleeps 2 s and fails on slow runners"),
    ("pe2", "yes", "covered", "CI-2", "Unpinned third-party actions", "workflows use actions at @main/@master or floating tags instead of commit SHAs"),
    ("pe3", "yes", "covered", "CI-3", "Cache key ignores the lockfile", "the dependency cache key is only the OS, so stale packages are restored after a bump"),
    ("pe4", "no", "absent", "CI-4", "Secrets echoed in deploy logs", "deploy.yml runs `echo $DEPLOY_TOKEN` for debugging, printing the token into the job log"),
    ("pe5", "no", "partial", "CI-5", "No job sets a timeout", "none of the lint, test, build or deploy jobs set timeout-minutes, so a hang burns six hours"),
    ("pe6", "yes", "skip", "CI-6", "Docker image built twice", "the deploy job rebuilds the image the build job already built"),
]:
    CASES.append({"id": cid, "cat": P, "cmd": "ask", "label": label, "kind": kind,
                  "finding": {"id": fid, "title": title, "what": what}, "text": PLAN_E})

# Held-out plan, written after the wordings were first compared: skips are
# phrased without the word SKIP, to check the chosen wording does not just
# match the token.
PLAN_F = """# Plan: api-errors

## Files touched
- src/main/java/com/acme/api/ErrorHandler.java: map exceptions to RFC 7807 problem responses.
- src/main/java/com/acme/api/OrderController.java: return 404 instead of 500 when an order is missing.

## Approach per finding
- ERR-1 (stack traces in responses): ErrorHandler stops copying exception.getStackTrace() into the body; the trace goes to the log with the request id, and the client gets a problem+json with that id.
- ERR-2 (missing order returns 500): OrderController.get() maps Optional.empty() to ResponseStatusException(NOT_FOUND).
- ERR-3 (inconsistent error JSON across services): not fixing here. The billing and auth services are separate repos; this epic only changes the api module, and the shared format is decided in ADR-17, which is still open.
- ERR-4 (validation errors return a bare 400): won't fix — research showed Spring's MethodArgumentNotValidException is already mapped to a field-level problem response by the existing ValidationAdvice, so the finding is outdated.
- ERR-5 (errors not logged with request id): ErrorHandler also logs 4xx responses at WARN (status and path only).

## Tests
- ErrorHandlerTest: a thrown RuntimeException yields a body with no "stackTrace" key.

## Steps
1. fix(api): no stack traces in error bodies
2. fix(orders): 404 for a missing order

## Verification
./gradlew check
"""
for cid, label, kind, fid, title, what in [
    ("pf1", "yes", "covered", "ERR-1", "Stack traces leak in error responses", "ErrorHandler copies the Java stack trace into the JSON body"),
    ("pf2", "yes", "covered", "ERR-2", "Missing order returns 500", "OrderController.get() throws NoSuchElementException on an unknown id"),
    ("pf3", "yes", "skip", "ERR-3", "Inconsistent error JSON", "the api, billing and auth services each return a different error shape"),
    ("pf4", "yes", "skip", "ERR-4", "Validation errors return a bare 400", "invalid request bodies get a 400 with no field details"),
    ("pf5", "no", "partial", "ERR-5", "Errors logged without request id", "ErrorHandler logs neither 4xx nor 5xx with the request id, so errors cannot be traced"),
    ("pf6", "no", "absent", "ERR-6", "Timeouts surface as 500", "downstream timeouts are reported as 500 instead of 504"),
]:
    CASES.append({"id": cid, "cat": P, "cmd": "ask", "label": label, "kind": kind,
                  "finding": {"id": fid, "title": title, "what": what}, "text": PLAN_F,
                  "heldout": True})


# --- (e) doubt claims -----------------------------------------------------------
def doubt(cid, kind, claim):
    CASES.append({"id": cid, "cat": "doubt", "cmd": "doubt", "kind": kind,
                  "label": "no" if kind == "true" else "yes", "claim": claim})


for i, c in enumerate([
    "Water boils at 100 degrees Celsius at sea level.",
    "Paris is the capital of France.",
    "The Pacific is the largest ocean on Earth.",
    "Python lists are mutable.",
    "HTTP status code 404 means the resource was not found.",
    "The human heart has four chambers.",
    "Light travels faster than sound.",
    "Git commits are identified by a hash of their content.",
    "Mount Everest is the highest mountain above sea level.",
    "A TCP connection starts with a three-way handshake.",
], 1):
    doubt(f"dt{i:02d}", "true", c)
for i, c in enumerate([
    "The Earth is flat.",
    "The Sun orbits the Earth once a day.",
    "Humans have three lungs.",
    "Water freezes at 50 degrees Celsius at sea level.",
    "Rome is the capital of Germany.",
    "Spiders are insects with six legs.",
    "The Moon is made of cheese.",
    "HTTP status code 200 means the server crashed.",
    "Python was first released in 2015.",
    "Two plus two equals five.",
], 1):
    doubt(f"df{i:02d}", "false", c)
for i, c in enumerate([
    "The Great Wall of China is visible from the Moon with the naked eye.",
    "Humans only use 10 percent of their brains.",
    "Sydney is the capital of Australia.",
    "Goldfish have a memory span of three seconds.",
    "Lightning never strikes the same place twice.",
    "Napoleon Bonaparte was unusually short for his time.",
    "Bulls are enraged by the color red.",
    "Python's sort() method returns the sorted list.",
    "HTTP status code 403 means the user is not authenticated.",
    "Git rebase keeps the original commit hashes of the rebased commits.",
], 1):
    doubt(f"dp{i:02d}", "plausible-false", c)


# --- (f) long text (several KB) and very short text ----------------------------
S = "length"
# Long log: ~5 KB of routine lines, one needle (or none) near the middle.
ROUTINE = [
    "INFO  http  GET /api/health 200 1ms",
    "INFO  http  GET /api/orders?page={n} 200 {ms}ms",
    "INFO  jobs  sync-inventory finished batch {n} ({ms} items)",
    "DEBUG cache hit ratio 0.{n}{ms}",
    "INFO  http  POST /api/orders 201 {ms}ms",
    "INFO  auth  token refreshed for service account billing-{n}",
]


def long_log(needle=None, lines=90):
    out = []
    for i in range(lines):
        t = f"2024-05-02T10:{i // 60:02d}:{i % 60:02d}Z "
        out.append(t + ROUTINE[i % len(ROUTINE)].format(n=i % 9 + 1, ms=(i * 37) % 400 + 3))
        if needle and i == lines // 2:
            out.append(t + needle)
    return "\n".join(out)


ask(S, "s01", "yes", "The log shows a database connection error.",
    long_log("ERROR db    connection to postgres://db-0:5432 refused: too many clients already"))
ask(S, "s02", "no", "The log shows a database connection error.", long_log())
ask(S, "s03", "yes", "The log contains a request that returned HTTP 500.",
    long_log("ERROR http  POST /api/checkout 500 2034ms (panic: nil map write)"))
ask(S, "s04", "no", "The log contains a request that returned HTTP 500.", long_log())

POLICY = """Expense policy (effective 1 January).

1. Scope. This policy covers every employee and contractor who spends company
money while travelling or working. Managers approve expenses for their reports;
directors approve their own expenses with finance.

2. Travel. Book economy class for flights under six hours. Flights of six hours
or more may be booked in premium economy. Business class requires written
approval from a director before booking. Trains: second class, or first class
when the fare difference is under 20 percent. Rental cars only when public
transport would cost more than one extra hour each way.

3. Hotels. The nightly cap is 180 euros in most cities and 250 euros in London,
Paris, New York, San Francisco and Tokyo. Breakfast is included in the cap when
the hotel bundles it. Minibar, spa, and in-room entertainment are personal.

4. Meals. While travelling, the daily meal allowance is 60 euros. Client meals
are reimbursed at cost with the names of the attendees and the business purpose.
Alcohol is reimbursed only at client meals and only in moderation.

5. Equipment. Laptops and phones come from IT; do not buy them yourself. Small
accessories (cables, adapters, mice) under 50 euros can be expensed without
approval. Anything over 50 euros needs manager approval first.

6. Home office. Each employee may claim up to 300 euros per year for desk, chair
or lighting. Internet costs are not reimbursed, since the salary already
includes a remote-work allowance.

7. Training. Courses and conferences need manager approval. The yearly budget is
1,500 euros per person; unused budget does not roll over.

8. Submitting. Submit expenses within 60 days with an itemised receipt. Expenses
submitted after 60 days are rejected unless finance grants an exception.
Lost receipts need a signed statement and are limited to 50 euros.

9. Corporate cards. Cards are for business spending only. Personal charges must
be repaid within 30 days and are reported to the employee's manager.

10. Questions go to finance@ on the internal chat.
"""
ask(S, "s05", "yes", "Business class flights need a director's approval before booking.", POLICY * 2)
ask(S, "s06", "no", "Internet costs at home are reimbursed.", POLICY * 2)
ask(S, "s07", "yes", "Unused training budget is lost at the end of the year.", POLICY * 2)
ask(S, "s08", "no", "Expenses can be submitted up to 90 days later without an exception.", POLICY * 2)

ask(S, "s09", "yes", "The answer is affirmative.", "Yes.")
ask(S, "s10", "no", "The answer is affirmative.", "No.")
ask(S, "s11", "yes", "The status is OK.", "OK")
ask(S, "s12", "no", "The number is greater than 10.", "7")


if __name__ == "__main__":
    ids = [c["id"] for c in CASES]
    assert len(ids) == len(set(ids)), "duplicate case id"
    assert all(c["label"] in ("yes", "no") for c in CASES)
    with open(HERE / "dataset.jsonl", "w") as f:
        for c in CASES:
            f.write(json.dumps(c) + "\n")
    print(f"{len(CASES)} cases -> {HERE / 'dataset.jsonl'}")
