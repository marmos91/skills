// Import first in a test file whose code runs the secret scan: the developer's gitleaks and
// ~/.config/secret-scan must not change the results. A stub gitleaks reports nothing; the config is empty.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const bin = mkdtempSync(join(tmpdir(), "hermetic-gl-"));
writeFileSync(join(bin, "gitleaks"), `#!/bin/sh\ncat >/dev/null\nwhile [ $# -gt 0 ]; do [ "$1" = --report-path ] && r=$2; shift; done\n[ -n "$r" ] && echo '[]' >"$r"\nexit 0\n`);
chmodSync(join(bin, "gitleaks"), 0o755);
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
process.env.SECRET_SCAN_CONFIG = mkdtempSync(join(tmpdir(), "hermetic-ss-"));
// No semgrep (sast.mjs): a path with no file reads as "not installed". A test sets its own stub.
process.env.PR_REVIEW_SEMGREP = join(bin, "semgrep");
