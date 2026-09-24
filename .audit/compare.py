"""Compare two suite-log directories BY EXACT TEST NAME.

usage: python .audit/compare.py <before-dir>[,<before-dir>...] <after-dir>
"""
import io
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SUMMARY = re.compile(r"(\d+) passed, (\d+) failed")
ALT_SUMMARY = re.compile(r"^\s*(\d+) passed\s*$", re.M)
# The two shapes the harnesses print a failing test in.
FAIL_DASH = re.compile(r"^  - (.+?)\s*$", re.M)
FAIL_WORD = re.compile(r"^\s*FAILED: (.+?)\s*$", re.M)


def read(path):
    return io.open(path, encoding="utf-8", errors="replace", newline="").read().replace("\r", "")


def digest(path):
    s = read(path)
    m = list(SUMMARY.finditer(s))
    if m:
        counts = (int(m[-1].group(1)), int(m[-1].group(2)))
    else:
        a = list(ALT_SUMMARY.finditer(s))
        counts = (int(a[-1].group(1)), 0) if a else (None, None)
    names = set(FAIL_DASH.findall(s)) | set(FAIL_WORD.findall(s))
    return counts, names


def collect(dirs):
    out = {}
    for d in dirs:
        if not os.path.isdir(d):
            continue
        for f in sorted(os.listdir(d)):
            if f.endswith(".log"):
                out.setdefault(f[:-4].replace("", ":"), os.path.join(d, f))
    return out


before = collect(sys.argv[1].split(","))
after = collect([sys.argv[2]])

for suite in sorted(set(before) | set(after)):
    bp, ap = before.get(suite), after.get(suite)
    if ap is None:
        print("%-34s AFTER MISSING (not re-run)" % suite)
        continue
    (ap_pass, ap_fail), an = digest(ap)
    if bp is None:
        print("%-34s after=%s/%s   NO BASELINE LOG" % (suite, ap_pass, ap_fail))
        for n in sorted(an):
            print("      after-FAIL: %s" % n)
        continue
    (bp_pass, bp_fail), bn = digest(bp)
    new = sorted(an - bn)
    fixed = sorted(bn - an)
    flag = "NEW FAILURES" if new else "ok"
    print(
        "%-34s before=%s/%s  after=%s/%s  %s"
        % (suite, bp_pass, bp_fail, ap_pass, ap_fail, flag)
    )
    for n in new:
        print("      + NEW FAIL : %s" % n)
    for n in fixed:
        print("      - no longer failing: %s" % n)
    for n in sorted(an & bn):
        print("      = pre-existing: %s" % n)
