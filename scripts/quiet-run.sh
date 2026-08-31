#!/bin/sh

set -u

usage() {
  echo "usage: $0 [--detach|--status <handle>] <label> <command> [args ...]" >&2
  exit 64
}

log_root=${TMPDIR:-/tmp}/agent-connect-command-logs
mkdir -p "$log_root"

# Internal detached worker. The tmux server below owns this process after the
# short launcher exits, which also works in command runners that reap every
# descendant of the launching process group.
if test "${1:-}" = "--worker"; then
  test "$#" -ge 3 || usage
  handle=$2
  shift 2
  if "$@" >"$handle.log" 2>&1; then
    printf '0' >"$handle.status"
  else
    printf '%s' "$?" >"$handle.status"
  fi
  exit 0
fi

# --status <handle>: report on a run started with --detach. Prints one line while
# the command is still running, and the same OK/FAILED result as a foreground run
# once it has exited. Poll this instead of waiting on a blocked foreground call.
if test "${1:-}" = "--status"; then
  test "$#" -eq 2 || usage
  handle=$2
  status_file="$handle.status"
  log_file="$handle.log"
  label_file="$handle.label"

  if ! test -f "$label_file"; then
    echo "unknown handle: $handle" >&2
    exit 66
  fi
  label=$(cat "$label_file")

  if ! test -f "$status_file"; then
    printf 'RUNNING %s (handle %s)\n' "$label" "$handle"
    exit 0
  fi

  status=$(cat "$status_file")
  if test "$status" -eq 0; then
    printf 'OK %s\n' "$label"
    exit 0
  fi

  tail_lines=${QUIET_RUN_TAIL_LINES:-80}
  printf 'FAILED %s (exit %s)\n' "$label" "$status" >&2
  printf '%s\n' "--- last $tail_lines log lines ---" >&2
  tail -n "$tail_lines" "$log_file" >&2
  printf '%s\n' "--- full log: $log_file ---" >&2
  exit "$status"
fi

detach=0
if test "${1:-}" = "--detach"; then
  detach=1
  shift
fi

test "$#" -ge 2 || usage

label=$1
shift

# --detach: start the command in the background and return immediately with a
# handle. Do other work, then read the result once with --status. A long command
# polled in the foreground costs a full-context model request per poll; this
# costs one request to start and one to collect.
if test "$detach" -eq 1; then
  handle=$(mktemp -u "$log_root/quiet-run.XXXXXX")
  printf '%s' "$label" >"$handle.label"
  session_name=$(basename "$handle" | tr -cd 'A-Za-z0-9_-')
  if command -v tmux >/dev/null 2>&1; then
    tmux new-session -d -s "$session_name" "$0" --worker "$handle" "$@"
  else
    "$0" --worker "$handle" "$@" >/dev/null 2>&1 &
  fi
  printf 'STARTED %s (handle %s)\n' "$label" "$handle"
  printf 'check with: %s --status %s\n' "$0" "$handle"
  exit 0
fi

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
