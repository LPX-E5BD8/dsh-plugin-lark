# Upgrade, rollback, and durable state

English | [简体中文](./UPGRADING.zh-CN.md)

This runbook covers `dsh-plugin-lark` on the supported DeepSeek Harness `0.1.0-rc.6` / Node.js 22.x baseline. It assumes the stock Web profile's JSONL session persistence and JSON storage-domain backend. For custom backends, use their native consistent-snapshot and restore procedures while preserving the same logical units.

## Safety rules

- Run only one Harness process against a state root. The JSON backend has no cross-process writer lock.
- Stop Harness gracefully and wait for the process to exit before copying or restoring state. Do not take a live `cp`/`tar` snapshot, and do not use `kill -9` as a backup boundary.
- Keep the same Lark app ID, state roots, launch workspace, `defaultSessionId`, JSONL compression, canonical Workspace paths, profile configuration, and credential source unless the migration explicitly changes them. The app ID participates in hashed storage keys; changing it makes prior receipts and bindings appear absent.
- Snapshot sessions, storage domains, and the Web profile at one point in time. Never restore only `lark_conversations.json`, merge old and new JSON by hand, or edit hashes/schema fields manually.
- Treat every snapshot as sensitive. Session logs can contain prompts, tool results, and repository data; Workspace state contains paths; selected model route IDs are plaintext. Store snapshots outside the checkout with restrictive access, and never attach them to an issue.
- A state rollback does not undo messages already sent, model/provider usage, tool side effects, or files changed in a Workspace. Protect project directories with their own version control or backup.

## One cold-backup unit

The stock rc.6 Web profile uses these paths:

| Unit | Stock location | Why it must stay aligned |
| --- | --- | --- |
| Session persistence | `$DSH_HOME/sessions` | JSONL headers, events, generations, cwd, preset, and request headers |
| Storage domains | `$DSH_HOME/storages` | `lark_inbound.json`, `lark_conversations.json`, `workspace.json`, and other host-domain state |
| Web profile installation | `$DSH_HOME/profiles/web` | Plugin specification, profile package graph, and local-checkout reference |
| Plugin checkout | The absolute path passed to `dsh plugin --profile web add` | A local install can remain linked to that directory; keep the old checkout through the rollback window |

An overlay can replace any stock path, so the composed local configuration is authoritative. Inspect it locally and do not paste it into a ticket. Credentials and project directories are not part of this three-directory state snapshot; preserve their service-manager/secret-store configuration and repository backups separately.

## Durable-state history

| Release boundary | Forward behavior | Rollback consequence |
| --- | --- | --- |
| `0.1.3` | Adds the `lark_inbound` domain (domain version 0) with a bounded hashed receipt window. Existing messages are not backfilled. | `0.1.2` and older ignore receipts, so a platform redelivery can repeat a previously completed side effect. |
| `0.3.0` | Group reply trees and native threads receive new scoped session IDs. Legacy chat-wide group sessions are retained but deliberately not assigned to a new scope. | `0.2.2` and older return to chat-wide group identity and cannot see scoped group context. The newer logs remain stored for a later roll-forward. |
| `0.3.0`–`0.6.1` | No further plugin-owned durable format change; v0.6 changes process residency, not stored transcripts. | State format is compatible inside this range, while the v0.3 group-scope boundary still applies. |
| `0.7.0` | Adds `lark_conversations` record schema v1 as the commit authority for the active generation and mutation-replay history. | `0.6.1` and older ignore the sidecar and choose the greatest persisted generation, which can be an uncommitted orphan. In-place rollback is not safe. |
| `0.8.0` | Reads v1 or v2 bindings and writes strict v2 records with `modelSelection`. A v1 record is upgraded lazily on its next binding write, not at startup. | `0.7.0` accepts only strict v1. Any v2 record makes its full-table startup validation fail. Restore a pre-v0.8 cold snapshot. |
| `0.8.1`–`0.8.2` | No plugin-owned durable schema change from v0.8.0. | These releases can share v2 state with v0.8.0, subject to the normal cold-backup rule. |

The DSH JSONL format and Workspace domain belong to Harness rc.6 rather than this plugin. This project does not claim cross-Harness migration support. Upgrade the plugin and Harness cohort as separate changes, never in one recovery window.

A stopped deployment can upgrade directly from any prior plugin release to the current release on the same supported Harness cohort; it does not need to run intermediate plugin versions or rewrite JSONL. Without a `lark_conversations` record, recovery chooses the greatest numeric generation only within the exact current base-ID lineage; this is a legacy heuristic, not commit authority. A pre-v0.3 chat-wide group generation is not reassigned to a newer scoped reply-tree/thread lineage. A later durable binding mutation establishes commit authority. No receipt, group transcript, or binding is bulk backfilled: the boundaries in the table remain observable after the direct upgrade.

A custom profile originating before v0.1.3 must mount the current storage hub, a durable KV backend, and `storage-domain` before the new plugin starts; creating an empty `storages` directory is insufficient. Pre-v0.7 state has no binding authority, and the legacy heuristic cannot distinguish a partially published candidate. Verify known conversations before any binding mutation. On a wrong or ambiguous resume, stop and restore a complete known-good snapshot. Operators must never hand-select or delete one JSONL artifact.

## Prepare the target checkout

Prepare and verify a sibling checkout before downtime. Replace the example paths and tag with exact values; do not update the checkout currently serving traffic.

```bash
(
set -Eeuo pipefail

target_checkout_input='/srv/dsh-plugin-lark-next'
target_tag='v0.8.2'

case "$target_checkout_input" in /*) ;; *) exit 1 ;; esac
test ! -e "$target_checkout_input"
test ! -L "$target_checkout_input"
[[ "$target_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
git clone https://github.com/LPX-E5BD8/dsh-plugin-lark.git "$target_checkout_input"
target_checkout="$(realpath -e -- "$target_checkout_input")"
test "$target_checkout" = "$target_checkout_input"
git -C "$target_checkout" switch --detach "$target_tag"
target_commit="$(git -C "$target_checkout" rev-parse HEAD)"
test "$target_commit" = "$(git -C "$target_checkout" rev-list -n 1 "$target_tag")"
manifest_version="$(node -e 'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$target_checkout/package.json")"
test "v$manifest_version" = "$target_tag"
npm --prefix "$target_checkout" ci --ignore-scripts
npm --prefix "$target_checkout" run check
npm --prefix "$target_checkout" run test:pack
)
```

Confirm the tag points to the intended GitHub Release and that the compatibility row matches the installed Harness cohort. The Web-profile snapshot preserves only its current absolute local-checkout link, not the link target. Identify that exact path before downtime and require it to be a clean, detached checkout at the deployed commit, installed from its committed lockfile with `npm ci --ignore-scripts` and already passing that release's checks. Do not pull, switch, install, or rebuild it until the rollback window closes. If the profile currently references a mutable development checkout, migrate it to an immutable checkout and complete a restart/validation in a separate change window before beginning this upgrade.

## Stop and snapshot

First stop admission through the service manager or foreground process, request a normal SIGINT/SIGTERM shutdown, and wait for all DSH processes using the root to exit. If shutdown reports an interrupted or unconfirmed conversation-binding write, restart the current version, let it recover the authoritative sidecar, verify the affected conversation, then repeat the graceful stop. Do not upgrade from an ambiguous stop.

For the stock Linux filesystem backends, this is a conservative snapshot template. Export the exact absolute `DSH_HOME` used by the stopped process, and replace the literal backup path. The template rejects a backup nested inside the state root and top-level symlinked units; use the overlay/backend-native procedure instead when those checks do not match the deployment.

```bash
(
set -Eeuo pipefail

: "${DSH_HOME:?set DSH_HOME to the active absolute state root}"
backup_parent_input='/srv/private-backups'

case "$DSH_HOME" in /*) ;; *) exit 1 ;; esac
case "$backup_parent_input" in /*) ;; *) exit 1 ;; esac
dsh_state_root="$(realpath -e -- "$DSH_HOME")"
backup_parent="$(realpath -e -- "$backup_parent_input")"
test "$dsh_state_root" != '/'
test "$backup_parent" != '/'
test "$dsh_state_root" = "$DSH_HOME"
test "$backup_parent" = "$backup_parent_input"
case "$backup_parent" in
  "$dsh_state_root"|"$dsh_state_root"/*) exit 1 ;;
esac
test -d "$dsh_state_root/sessions"
test -d "$dsh_state_root/storages"
test -d "$dsh_state_root/profiles/web"
test -d "$backup_parent"
test ! -L "$dsh_state_root/sessions"
test ! -L "$dsh_state_root/storages"
test ! -L "$dsh_state_root/profiles"
test ! -L "$dsh_state_root/profiles/web"
command -v mountpoint >/dev/null
! mountpoint -q -- "$dsh_state_root/sessions"
! mountpoint -q -- "$dsh_state_root/storages"
! mountpoint -q -- "$dsh_state_root/profiles"
! mountpoint -q -- "$dsh_state_root/profiles/web"
root_device="$(stat -c '%d' -- "$dsh_state_root")"
root_mount="$(stat -c '%m' -- "$dsh_state_root")"
for active_unit in "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/profiles" "$dsh_state_root/profiles/web"; do
  test "$(stat -c '%d' -- "$active_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$active_unit")" = "$root_mount"
done

required_kib="$(du -sk -- "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/profiles/web" | awk '{ total += $1 } END { print total }')"
available_kib="$(df -Pk -- "$backup_parent" | awk 'NR == 2 { print $4 }')"
[[ "$required_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
test "$available_kib" -gt "$required_kib"

umask 077
upgrade_snapshot="$(mktemp -d -- "$backup_parent/dsh-lark-pre-upgrade.XXXXXX")"
test -d "$upgrade_snapshot"
test ! -L "$upgrade_snapshot"
test "$(realpath -e -- "$upgrade_snapshot")" = "$upgrade_snapshot"
test "$(dirname -- "$upgrade_snapshot")" = "$backup_parent"
case "$(basename -- "$upgrade_snapshot")" in dsh-lark-pre-upgrade.*) ;; *) exit 1 ;; esac
cp -a -- "$dsh_state_root/sessions" "$upgrade_snapshot/sessions"
cp -a -- "$dsh_state_root/storages" "$upgrade_snapshot/storages"
cp -a -- "$dsh_state_root/profiles/web" "$upgrade_snapshot/web-profile"
test -d "$upgrade_snapshot/sessions"
test -d "$upgrade_snapshot/storages"
test -d "$upgrade_snapshot/web-profile"
tree_digest() {
  tar --sort=name --format=posix \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --numeric-owner -C "$1" -cf - sessions storages web-profile |
    sha256sum | awk '{ print $1 }'
}
snapshot_digest="$(tree_digest "$upgrade_snapshot")"
[[ "$snapshot_digest" =~ ^[0-9a-f]{64}$ ]]
printf '%s\n' "$snapshot_digest" > "$upgrade_snapshot/SNAPSHOT_SHA256"
test "$(tree_digest "$upgrade_snapshot")" = "$snapshot_digest"
touch -- "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test ! -L "$upgrade_snapshot/SNAPSHOT_SHA256"
test ! -L "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test -f "$upgrade_snapshot/SNAPSHOT_SHA256"
test -f "$upgrade_snapshot/SNAPSHOT_COMPLETE"
printf 'completed snapshot: %s\n' "$upgrade_snapshot"
)
```

Only a private snapshot carrying `SNAPSHOT_SHA256` and `SNAPSHOT_COMPLETE` after all three copies is eligible for this restore template. The checksum detects accidental corruption while the protected directory supplies its trust boundary; it is not a signature against an attacker who can rewrite both files. Verify the snapshot before changing the profile. Do not move or delete the source state. If a custom backend spans databases, volumes, mountpoints, or top-level symlinks, replace the template with one backend-native snapshot that establishes a common consistency point.

## Upgrade and validate

While the old process remains stopped, bind both profile inspection and modification explicitly to the state root that was just backed up. Set the literal checkout path below to the same canonical path verified earlier; the block independently canonicalizes both paths, so it cannot silently inherit a different profile root.

```bash
(
set -Eeuo pipefail
: "${DSH_HOME:?set DSH_HOME to the snapshotted absolute state root}"
target_checkout_input='/srv/dsh-plugin-lark-next'
dsh_state_root="$(realpath -e -- "$DSH_HOME")"
target_checkout="$(realpath -e -- "$target_checkout_input")"
test "$dsh_state_root" = "$DSH_HOME"
test "$target_checkout" = "$target_checkout_input"
DSH_HOME="$dsh_state_root" dsh --profile web --dump-config >/dev/null
DSH_HOME="$dsh_state_root" dsh plugin --profile web add "$target_checkout"
DSH_HOME="$dsh_state_root" dsh --profile web --dump-config >/dev/null
)
```

Then:

1. Start the same Harness `0.1.0-rc.6` profile from the same workspace with the same app ID, `defaultSessionId`, storage roots, JSONL compression, canonical Workspace paths, config overlays, and inherited credentials. DSH rc.6 rejects `DSH_*` application credentials in `.env`; use the launch/service environment described in the README.
2. Require `/api/lark/health` to report HTTP 200 and `state: connected` when `webServer` is mounted.
3. Check `/help`, then list `/project` and `/model`. Verify a known direct conversation and one group scope resume the expected project, model, preset, and tools.
4. Restart once and repeat the resume check before accepting the migration.
5. Run the relevant credential-backed checks in `SMOKE_TESTS.md`, including `/new`, project/model inheritance, restart, and LRU cold resume, then retain the snapshot and old checkout until the rollback window closes.

Every handled validation message advances the inbound receipt state. A later snapshot restore rewinds those receipts and can allow redelivery; use disposable checks and reconcile external side effects.

## Cold migration to another machine

A host move is a cold migration, not a blue/green rollout. Stop the source first and keep it stopped; no source and destination Harness processes may share the state or connect the same Lark app at once. This stock procedure is limited to a cold same-Linux move into an empty root that preserves numeric ownership, modes, symlink targets, and the exact absolute `DSH_HOME`, checkout, launch, and Workspace paths. Other layouts and backends remain unverified and require their native procedure.

Prepare the destination with the exact rc.6 cohort, Node.js 22.x, target and rollback plugin tags/commits, app ID, `defaultSessionId`, JSONL compression, launch workspace, and credential source. Transfer one completed three-directory snapshot plus the required immutable checkouts over an authenticated channel, then recompute and verify `SNAPSHOT_SHA256` before installation. Copy Workspace repositories separately so their canonical paths and commits match; they are not inside the state snapshot. Never merge destination JSONL/JSON with existing state. Validate the destination while the source remains stopped, and stop the destination before any source rollback or retry.

## Rollback decision table

| Rollback target from v0.8.2 | State handling |
| --- | --- |
| v0.8.1 or v0.8.0 | Same v2 binding schema. Stop cleanly and keep a snapshot; an in-place code rollback is schema-compatible on the exact rc.6 cohort. |
| v0.7.0 | Do not start it on state that v0.8.x may have written. Restore the complete pre-v0.8 snapshot because v0.7 cannot read any v2 binding. |
| v0.3.0–v0.6.1 | Restore a snapshot taken before v0.7. Those versions ignore commit-authority bindings and can select a newer orphan generation. |
| v0.1.3–v0.2.2 | Also expect group sessions to revert to chat-wide identity; scoped group history is not down-migrated. |
| v0.1.0–v0.1.2 | Also expect durable inbound deduplication to disappear; repeated platform delivery can repeat effects. |

If the required compatible snapshot does not exist, roll forward to the newest version that can read the current state. Do not invent a v2-to-v1 JSON transformation during an outage, and do not hand-select or delete an apparent orphan generation.

## Restore a stock filesystem snapshot

Stop the failed/new process and verify the exact absolute source and destination paths. This stock-Linux template first copies the snapshot into a staging directory on the state filesystem, then moves the current state into a recoverable hold on that same filesystem; it does not delete it. It rejects symlinked units and separately mounted top-level units. Ensure the state filesystem has room for the staged restore as well as the current state.

```bash
(
set -Eeuo pipefail

: "${DSH_HOME:?set DSH_HOME to the active absolute state root}"
backup_parent_input='/srv/private-backups'
upgrade_snapshot_input='/srv/private-backups/dsh-lark-pre-upgrade.REPLACE_ME'

case "$DSH_HOME" in /*) ;; *) exit 1 ;; esac
case "$backup_parent_input" in /*) ;; *) exit 1 ;; esac
case "$upgrade_snapshot_input" in /*) ;; *) exit 1 ;; esac
dsh_state_root="$(realpath -e -- "$DSH_HOME")"
backup_parent="$(realpath -e -- "$backup_parent_input")"
upgrade_snapshot="$(realpath -e -- "$upgrade_snapshot_input")"
test "$dsh_state_root" != '/'
test "$backup_parent" != '/'
test "$dsh_state_root" = "$DSH_HOME"
test "$backup_parent" = "$backup_parent_input"
case "$backup_parent" in
  "$dsh_state_root"|"$dsh_state_root"/*) exit 1 ;;
esac
test "$(dirname -- "$upgrade_snapshot")" = "$backup_parent"
case "$(basename -- "$upgrade_snapshot")" in dsh-lark-pre-upgrade.?*) ;; *) exit 1 ;; esac
case "$upgrade_snapshot" in "$dsh_state_root"|"$dsh_state_root"/*) exit 1 ;; esac
case "$dsh_state_root" in "$upgrade_snapshot"|"$upgrade_snapshot"/*) exit 1 ;; esac
test -d "$upgrade_snapshot/sessions"
test -d "$upgrade_snapshot/storages"
test -d "$upgrade_snapshot/web-profile"
test -f "$upgrade_snapshot/SNAPSHOT_SHA256"
test -f "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test -d "$dsh_state_root/sessions"
test -d "$dsh_state_root/storages"
test -d "$dsh_state_root/profiles/web"
test ! -L "$upgrade_snapshot/sessions"
test ! -L "$upgrade_snapshot/storages"
test ! -L "$upgrade_snapshot/web-profile"
test ! -L "$upgrade_snapshot/SNAPSHOT_SHA256"
test ! -L "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test ! -L "$dsh_state_root/sessions"
test ! -L "$dsh_state_root/storages"
test ! -L "$dsh_state_root/profiles"
test ! -L "$dsh_state_root/profiles/web"

root_device="$(stat -c '%d' -- "$dsh_state_root")"
root_mount="$(stat -c '%m' -- "$dsh_state_root")"
command -v mountpoint >/dev/null
for active_unit in "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/profiles" "$dsh_state_root/profiles/web"; do
  ! mountpoint -q -- "$active_unit"
  test "$(stat -c '%d' -- "$active_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$active_unit")" = "$root_mount"
done

tree_digest() {
  tar --sort=name --format=posix \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --numeric-owner -C "$1" -cf - sessions storages web-profile |
    sha256sum | awk '{ print $1 }'
}
expected_digest="$(< "$upgrade_snapshot/SNAPSHOT_SHA256")"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]]
test "$(tree_digest "$upgrade_snapshot")" = "$expected_digest"
required_kib="$(du -sk -- "$upgrade_snapshot/sessions" "$upgrade_snapshot/storages" "$upgrade_snapshot/web-profile" | awk '{ total += $1 } END { print total }')"
available_kib="$(df -Pk -- "$dsh_state_root" | awk 'NR == 2 { print $4 }')"
[[ "$required_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
test "$available_kib" -gt "$required_kib"

umask 077
restore_stage="$(mktemp -d -- "$dsh_state_root/.dsh-lark-restore-stage.XXXXXX")"
test -d "$restore_stage"
test ! -L "$restore_stage"
test "$(realpath -e -- "$restore_stage")" = "$restore_stage"
test "$(dirname -- "$restore_stage")" = "$dsh_state_root"
case "$(basename -- "$restore_stage")" in .dsh-lark-restore-stage.?*) ;; *) exit 1 ;; esac
test "$(stat -c '%d' -- "$restore_stage")" = "$root_device"
test "$(stat -c '%m' -- "$restore_stage")" = "$root_mount"
cp -a -- "$upgrade_snapshot/sessions" "$restore_stage/sessions"
cp -a -- "$upgrade_snapshot/storages" "$restore_stage/storages"
cp -a -- "$upgrade_snapshot/web-profile" "$restore_stage/web-profile"
for staged_unit in "$restore_stage/sessions" "$restore_stage/storages" "$restore_stage/web-profile"; do
  test -d "$staged_unit"
  test ! -L "$staged_unit"
  test "$(stat -c '%d' -- "$staged_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$staged_unit")" = "$root_mount"
done
test "$(tree_digest "$restore_stage")" = "$expected_digest"

rollback_hold="$(mktemp -d -- "$dsh_state_root/.dsh-lark-rollback-hold.XXXXXX")"
test -d "$rollback_hold"
test ! -L "$rollback_hold"
test "$(realpath -e -- "$rollback_hold")" = "$rollback_hold"
test "$(dirname -- "$rollback_hold")" = "$dsh_state_root"
case "$(basename -- "$rollback_hold")" in .dsh-lark-rollback-hold.?*) ;; *) exit 1 ;; esac
test "$(stat -c '%d' -- "$rollback_hold")" = "$root_device"
test "$(stat -c '%m' -- "$rollback_hold")" = "$root_mount"

path_present() { test -e "$1" || test -L "$1"; }
plain_dir() { test -d "$1" && test ! -L "$1"; }
dir_id() { stat -c '%d:%i' -- "$1"; }
rename_empty_target() {
  plain_dir "$1" || return 1
  test "$(dir_id "$1")" = "$3" || return 1
  if path_present "$2"; then return 1; fi
  mv -nT -- "$1" "$2" || return 1
  if path_present "$1"; then return 1; fi
  plain_dir "$2" || return 1
  test "$(dir_id "$2")" = "$3"
}
rollback_one() {
  if path_present "$2"; then
    plain_dir "$2" && test "$(dir_id "$2")" = "$4" || return 1
    if path_present "$1"; then
      plain_dir "$1" && test "$(dir_id "$1")" = "$5" || return 1
      if path_present "$3"; then return 1; fi
      rename_empty_target "$1" "$3" "$5" || return 1
    fi
    if path_present "$1"; then return 1; fi
    rename_empty_target "$2" "$1" "$4" || return 1
  else
    plain_dir "$1" && test "$(dir_id "$1")" = "$4" || return 1
  fi
}
rollback_all() {
  rollback_failed=0
  rollback_one "$dsh_state_root/profiles/web" "$rollback_hold/web-profile" "$restore_stage/web-profile" "$original_web_id" "$staged_web_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile profiles/web'; rollback_failed=1; }
  rollback_one "$dsh_state_root/storages" "$rollback_hold/storages" "$restore_stage/storages" "$original_storages_id" "$staged_storages_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile storages'; rollback_failed=1; }
  rollback_one "$dsh_state_root/sessions" "$rollback_hold/sessions" "$restore_stage/sessions" "$original_sessions_id" "$staged_sessions_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile sessions'; rollback_failed=1; }
  return "$rollback_failed"
}
on_exit() {
  restore_rc=$1
  trap '' HUP INT QUIT TERM
  trap - ERR EXIT
  set +e
  if test "$rename_active" -eq 1 && test "$rename_committed" -eq 0; then
    test "$restore_rc" -ne 0 || restore_rc=1
    printf >&2 'active root: %s\nrollback hold: %s\nrestore stage: %s\n' "$dsh_state_root" "$rollback_hold" "$restore_stage"
    if rollback_all; then
      printf >&2 '%s\n' 'rename failed; original state was restored; keep Harness stopped until paths are verified'
    else
      printf >&2 '%s\n' 'automatic rollback stopped without overwriting; keep Harness stopped and inspect active, hold, and stage'
      restore_rc=1
    fi
  fi
  exit "$restore_rc"
}

original_sessions_id="$(dir_id "$dsh_state_root/sessions")"
original_storages_id="$(dir_id "$dsh_state_root/storages")"
original_web_id="$(dir_id "$dsh_state_root/profiles/web")"
staged_sessions_id="$(dir_id "$restore_stage/sessions")"
staged_storages_id="$(dir_id "$restore_stage/storages")"
staged_web_id="$(dir_id "$restore_stage/web-profile")"
rename_active=0
rename_committed=0
trap 'on_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
rename_active=1
rename_empty_target "$dsh_state_root/sessions" "$rollback_hold/sessions" "$original_sessions_id" || exit 1
rename_empty_target "$dsh_state_root/storages" "$rollback_hold/storages" "$original_storages_id" || exit 1
rename_empty_target "$dsh_state_root/profiles/web" "$rollback_hold/web-profile" "$original_web_id" || exit 1
rename_empty_target "$restore_stage/sessions" "$dsh_state_root/sessions" "$staged_sessions_id" || exit 1
rename_empty_target "$restore_stage/storages" "$dsh_state_root/storages" "$staged_storages_id" || exit 1
rename_empty_target "$restore_stage/web-profile" "$dsh_state_root/profiles/web" "$staged_web_id" || exit 1
test "$(dir_id "$dsh_state_root/sessions")" = "$staged_sessions_id"
test "$(dir_id "$dsh_state_root/storages")" = "$staged_storages_id"
test "$(dir_id "$dsh_state_root/profiles/web")" = "$staged_web_id"
test "$(dir_id "$rollback_hold/sessions")" = "$original_sessions_id"
test "$(dir_id "$rollback_hold/storages")" = "$original_storages_id"
test "$(dir_id "$rollback_hold/web-profile")" = "$original_web_id"
if path_present "$restore_stage/sessions" || path_present "$restore_stage/storages" || path_present "$restore_stage/web-profile"; then exit 1; fi
rename_committed=1
trap - ERR EXIT HUP INT QUIT TERM
printf 'active root: %s\nrollback hold: %s\nrestore stage: %s\n' "$dsh_state_root" "$rollback_hold" "$restore_stage"
)
```

The subshell fails closed on validation, copy, checksum, or rename errors. During the rename phase, its `EXIT`/`HUP`/`INT`/`QUIT`/`TERM` trap uses non-overwriting moves plus device/inode checks to restore the original three units. SIGKILL, host power loss, and kernel failure cannot run the trap. After any interrupted or incomplete result, keep Harness stopped and reconcile the printed active, hold, and stage paths against their recorded invariants; never overwrite or merge them.

The restored profile must find the immutable original checkout at the same absolute path and exact commit recorded before downtime. Do not point it at another directory or run `plugin add` as a substitute. Start the exact old plugin on the same rc.6 cohort. `/api/lark/health` exists only in v0.5.0 and newer; for v0.1.0–v0.4.0, require the historical `[ws] ws client ready` gate plus a disposable end-to-end reply and conversation-resume check, and do not treat HTTP 404 alone as plugin failure. Retain `rollback_hold`, `restore_stage`, the snapshot, and both immutable old/target checkouts until the incident closes.

Restoring the snapshot rewinds transcripts, receipts, Workspace registration/order, project/model bindings, and mutation history to the snapshot time. Workspaces on disk and external side effects remain at their current time. Review that split explicitly before allowing new turns.

## Failure recovery

- Startup rejecting `lark_conversations` after a downgrade usually indicates an unsupported v2-to-v1 rollback. Stop and restore or roll forward.
- A conversation opening on the wrong generation after downgrading below v0.7 indicates that the old release ignored commit authority. Stop before it accepts more work and restore the pre-v0.7 snapshot.
- Missing context after downgrading below v0.3 is expected for scoped group sessions; do not delete or automatically select the newer JSONL logs.
- Duplicate handling after restoring an older snapshot or downgrading below v0.1.3 is possible under the documented at-least-once boundary. Reconcile platform and tool side effects before retrying.
- Never solve a state error by deleting one storage-domain file. Preserve the failed state, collect only sanitized version/error facts, and prefer a compatible roll-forward when no known-good snapshot exists.
