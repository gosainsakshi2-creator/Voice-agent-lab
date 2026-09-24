#!/bin/sh
# usage: run-suites.sh <outdir> <script names...>
out="$1"; shift
mkdir -p "$out"
for s in "$@"; do
  printf '=== %s ===\n' "$s"
  npm run --silent "$s" > "$out/$s.log" 2>&1
  code=$?
  tail -n 1 "$out/$s.log" > /dev/null
  summary=$(grep -E '^[0-9]+ passed, [0-9]+ failed' "$out/$s.log" | tail -1)
  printf '%s  exit=%s  %s\n' "$s" "$code" "${summary:-NO-SUMMARY}"
  grep -E '^  - ' "$out/$s.log" | sed 's/^/     FAIL: /'
done
