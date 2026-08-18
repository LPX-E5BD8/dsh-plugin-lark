#!/bin/sh
# Report whether the Lark channel is serving, by reading only the runtime status
# document. It never loads the Harness profile graph, so it still answers when
# the profile itself fails to boot.
#
# Usage: lark-readiness.sh <runtime-dir> [max-heartbeat-age-seconds]
# Exit:  0 ready, 1 not ready, 2 no usable status document.

set -eu

runtime_dir=${1:-}
max_age=${2:-90}

if [ -z "$runtime_dir" ]; then
  echo 'usage: lark-readiness.sh <runtime-dir> [max-heartbeat-age-seconds]' >&2
  exit 2
fi

status_file="$runtime_dir/status.json"
if [ ! -r "$status_file" ]; then
  echo "lark: no runtime status document at $status_file" >&2
  exit 2
fi

field() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\{0,1\}\([^",}]*\).*/\1/p' "$status_file" | head -n 1
}

state=$(field state)
ready=$(field ready)
heartbeat=$(field heartbeatAt)

if [ -z "$state" ] || [ -z "$heartbeat" ]; then
  echo 'lark: runtime status document is unreadable' >&2
  exit 2
fi

heartbeat_epoch=$(date -u -d "$heartbeat" +%s 2>/dev/null || echo '')
if [ -z "$heartbeat_epoch" ]; then
  echo 'lark: runtime status heartbeat is unreadable' >&2
  exit 2
fi

age=$(( $(date -u +%s) - heartbeat_epoch ))
if [ "$age" -gt "$max_age" ]; then
  echo "lark: state=$state heartbeat is ${age}s old (limit ${max_age}s)" >&2
  exit 1
fi

if [ "$ready" != 'true' ]; then
  echo "lark: state=$state is not serving" >&2
  exit 1
fi

echo "lark: state=$state heartbeat ${age}s ago"
