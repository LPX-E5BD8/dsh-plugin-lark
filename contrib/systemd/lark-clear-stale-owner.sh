#!/bin/sh
# Clear an abandoned channel-ownership record so a replacement instance can
# start. Run it from exactly one actor -- systemd ExecStartPre, or an operator by
# hand -- never from several starting instances at once: a starting instance is
# forbidden from removing the record precisely because contenders would race.
#
# A record whose heartbeat is still inside its ttl belongs to a live process and
# is never removed; stop that process first.
#
# Usage: lark-clear-stale-owner.sh <runtime-dir>
# Exit:  0 nothing to do, or an abandoned record was cleared.
#        1 a live owner holds the channel.
#        2 the record exists but cannot be judged.

set -eu

runtime_dir=${1:-}
if [ -z "$runtime_dir" ]; then
  echo 'usage: lark-clear-stale-owner.sh <runtime-dir>' >&2
  exit 2
fi

owner_file="$runtime_dir/owner.json"
[ -e "$owner_file" ] || exit 0

field() {
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$owner_file" | head -n 1
}

heartbeat=$(field heartbeatAt)
ttl=$(field ttlMs)

if [ -z "$heartbeat" ] || [ -z "$ttl" ]; then
  # An unreadable record is not proof that the channel is free.
  echo "lark: $owner_file is unreadable; inspect it before removing it" >&2
  exit 2
fi

now=$(( $(date -u +%s) * 1000 ))
age=$(( now - heartbeat ))

if [ "$age" -lt "$ttl" ]; then
  echo "lark: a live owner holds this channel (heartbeat ${age}ms old, ttl ${ttl}ms)" >&2
  exit 1
fi

rm -f "$owner_file"
echo "lark: cleared an abandoned owner record (heartbeat ${age}ms old, ttl ${ttl}ms)"
