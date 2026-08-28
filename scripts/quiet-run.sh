#!/bin/sh

set -u

if test "$#" -lt 2; then
  echo "usage: $0 <label> <command> [args ...]" >&2
  exit 64
fi

label=$1
shift

log_root=${TMPDIR:-/tmp}/agent-connect-command-logs
mkdir -p "$log_root"
log_file=$(mktemp "$log_root/quiet-run.XXXXXX.log")

if "$@" >"$log_file" 2>&1; then
  rm -f "$log_file"
  printf 'OK %s\n' "$label"
  exit 0
else
  status=$?
fi

tail_lines=${QUIET_RUN_TAIL_LINES:-80}
printf 'FAILED %s (exit %s)\n' "$label" "$status" >&2
printf '%s\n' "--- last $tail_lines log lines ---" >&2
tail -n "$tail_lines" "$log_file" >&2
printf '%s\n' "--- full log: $log_file ---" >&2
exit "$status"
