# Upgrade, rollback, and durable state

English | [简体中文](./UPGRADING.zh-CN.md)

This runbook covers `dsh-plugin-lark` on the supported DeepSeek Harness `0.1.0-rc.6` baseline with Node.js 22.x, or Node.js 24.x starting with plugin v0.8.5. It assumes the stock Web profile's JSONL session persistence and JSON storage-domain backend. For custom backends, use their native consistent-snapshot and restore procedures while preserving the same logical units. Upgrade the plugin on Node.js 22 before changing an existing deployment to Node.js 24; treat the runtime change as a separate cold restart and never combine it with a Harness-cohort or state migration. Every procedure below remains Linux-only: the macOS gates verify Node.js 22 package/runtime consumption from v0.8.6 and Node.js 22/24 consumption from v0.8.7, not Web-profile operation, upgrade, rollback, or state migration.

## Safety rules

- Run only one Harness process against a state root. The JSON backend has no cross-process writer lock.
- Stop Harness gracefully and wait for the process to exit before copying or restoring state. Do not take a live `cp`/`tar` snapshot, and do not use `kill -9` as a backup boundary.
- Keep the same Lark app ID, state roots, launch workspace, `defaultSessionId`, JSONL compression, canonical Workspace paths, profile configuration, and credential source unless the migration explicitly changes them. The app ID participates in hashed storage keys; changing it makes prior receipts and bindings appear absent.
- Snapshot sessions, storage domains, attachments, and the Web profile at one point in time. Never restore only one referenced attachment or `lark_conversations.json`, merge old and new JSON by hand, or edit references/hashes/schema fields manually.
- Treat every snapshot as sensitive. Session logs can contain prompts, tool results, and repository data; Workspace state contains paths; selected model route IDs and notify destination chat/user/message IDs are plaintext. Store snapshots outside the checkout with restrictive access, and never attach them to an issue.
- A state rollback does not undo messages already sent, model/provider usage, tool side effects, or files changed in a Workspace. Protect project directories with their own version control or backup.

## One cold-backup unit

The stock rc.6 Web profile uses these paths:

| Unit | Stock location | Why it must stay aligned |
| --- | --- | --- |
| Session persistence | `$DSH_HOME/sessions` | JSONL headers, events, generations, cwd, preset, and request headers |
| Storage domains | `$DSH_HOME/storages` | `lark_inbound.json`, `lark_conversations.json`, `lark_notify.json`, `workspace.json`, and other host-domain state |
| Attachment store | `$DSH_HOME/attachments` | Immutable image objects referenced by Session events; objects and logs must stay aligned |
| Web profile installation | `$DSH_HOME/profiles/web` | Plugin specification, profile package graph, and local-checkout reference |
| Plugin checkout | The absolute path passed to `dsh plugin --profile web add` | A local install can remain linked to that directory; keep the old checkout through the rollback window |

An overlay can replace any stock path, so the composed local configuration is authoritative. Inspect it locally and do not paste it into a ticket. Credentials and project directories are not part of this four-directory state snapshot; preserve their service-manager/secret-store configuration and repository backups separately.

## Durable-state history

| Release boundary | Forward behavior | Rollback consequence |
| --- | --- | --- |
| `0.1.3` | Adds the `lark_inbound` domain (domain version 0) with a bounded hashed receipt window. Existing messages are not backfilled. | `0.1.2` and older ignore receipts, so a platform redelivery can repeat a previously completed side effect. |
| `0.3.0` | Group reply trees and native threads receive new scoped session IDs. Legacy chat-wide group sessions are retained but deliberately not assigned to a new scope. | `0.2.2` and older return to chat-wide group identity and cannot see scoped group context. The newer logs remain stored for a later roll-forward. |
| `0.3.0`–`0.6.1` | No further plugin-owned durable format change; v0.6 changes process residency, not stored transcripts. | State format is compatible inside this range, while the v0.3 group-scope boundary still applies. |
| `0.7.0` | Adds `lark_conversations` record schema v1 as the commit authority for the active generation and mutation-replay history. | `0.6.1` and older ignore the sidecar and choose the greatest persisted generation, which can be an uncommitted orphan. In-place rollback is not safe. |
| `0.8.0` | Reads v1 or v2 bindings and writes strict v2 records with `modelSelection`. A v1 record is upgraded lazily on its next binding write, not at startup. | `0.7.0` accepts only strict v1. Any v2 record makes its full-table startup validation fail. Restore a pre-v0.8 cold snapshot. |
| `0.8.1`–`0.8.8` | No plugin-owned durable schema change from v0.8.0. | These releases can share v2 state with v0.8.0, subject to the normal cold-backup rule. Plugin v0.8.1–v0.8.4 requires Node.js 22. |
| `0.9.0` | Keeps plugin-owned conversation bindings at v2, but allows authorized Lark managers to create and delete records in the Harness-owned `workspace` domain v2. | Rolling plugin code back does not undo registrations added or removed after the snapshot. Directories and transcripts are never deleted by these commands, but Registry visibility/order must be reconciled explicitly or restored from the complete cold snapshot. |
| `0.9.1` | Keeps the same schemas while materializing a first-command Session before committing its project-registry mutation binding. | State remains compatible with v0.9.0. Rolling code back reintroduces the project-registry service-dependency defect and removes the first-command checkpoint materializer; keep a complete cold snapshot and prefer rolling forward. |
| `0.9.2` | Keeps every durable schema unchanged while correcting Card 2.0 payload fields and sanitizing SDK message-delivery failures. | State remains compatible with v0.9.1. Rolling code back can make protected-tool approval cards unavailable again; the older path fails closed and does not grant the tool call. |
| `0.9.3` | Keeps conversation binding schema v2 and Workspace domain v2 unchanged. `/session resume` checkpoints the current transcript, then atomically points the existing binding at an already persisted, scope-visible Session while carrying the existing mutation-hash window forward. Opaque references are derived rather than stored, and the command does not write archive state or copy/delete a transcript. | v0.9.2 reads the same binding and continues the Session selected by v0.9.3, but it has no `/session` list/resume command. Rolling back does not undo the selection; archive state and Session logs require no conversion. |
| `0.9.4` | Adds no plugin-owned durable schema. A structured question uses the existing tool-call/result Session vocabulary and checkpoints the pending call before Card delivery; pending request tokens and answers are never stored in plugin sidecars. | v0.9.3 reads the same binding, Workspace, and Session logs but does not intercept structured questions in Lark. Pending Cards are process-local and become stale across any restart. An answer acknowledged before its `tool/result` commit is not crash-durable and may require the question to be asked again. |
| `0.9.5` | Adds no durable schema. It makes the exported Cordis entry non-constructible so root shutdown owns the async disposer, registers a known-message terminal delivery synchronously (or immediately on a late create response), and bounds shutdown Card close below the host grace period. | v0.9.4 reads the same state but can drop its async teardown during real profile unload, leaving a pending form stale and an open tool call to cold repair. Even v0.9.5 may cold-repair the open call after a graceful SIGTERM because rc.6 disposes the Agent concurrently; terminal Card delivery is not a durable tool result. |
| `0.9.6` | Adds no plugin-owned schema. Opted-in accepted text files become ordinary user text blocks in the Session log; resource keys, download state, and file metadata are not added to receipts or bindings. | v0.9.5 reads Sessions that contain these ordinary text blocks, but reverts every new file message to the generic unsupported path. Rolling back does not remove already committed attachment content from Session history. |
| `0.9.7` | Adds no durable schema or image bytes. It reads the existing exact model-visible Session surface and exact adapter modality metadata before model/session routing; incompatible checks perform no binding mutation. | v0.9.6 reads the same bindings and Session events but removes the image-history guard. Existing image blocks from another surface remain stored and can again reach a text-only route, where the provider is expected to fail closed. |
| `0.9.8` | Adds no durable schema. During graceful shutdown it makes a bounded attempt to terminalize every known running execution Card through a signal-aware final PATCH without appending a Session result or sending partial output. | v0.9.7 reads the same state but can leave an already delivered running Card with a stale Stop control after its process-local turn authority disappears. Stop v0.9.8 cleanly before rollback and treat any still-running older Card as stale. |
| `0.9.9` | Adds no plugin-owned schema. Opted-in images publish immutable objects under the Harness attachment backend, while Session events store only validated content-addressed references and metadata. | v0.9.8 retains and reads the same Session image blocks when its deployment has an attachment service, but new Lark image messages return to the unsupported path. Rolling code back does not delete objects or orphans; keep the attachment backend aligned with Session logs. |
| `0.9.10` | Adds no plugin-owned schema. Approved outbound artifacts use existing `tool/call`, approval audit, and `tool/result` events; platform upload keys, destinations, paths, and bytes are never stored in plugin sidecars. | v0.9.9 reads the same Session log but no longer registers the send tool. Rollback cannot retract a delivered platform message or delete an uploaded orphan, and an open/unknown tool call follows ordinary rc.6 cold repair. |
| `0.9.11` | Adds the `lark_notify` storage-domain unit (`destinations` + `outbox`). Destination rows store the chat/user/message IDs required to deliver after restart; outbox rows store hashed keys, kind, bounded summary, mention tokens, retry/expiry, and terminal status. | v0.9.10 ignores the new unit and no longer registers `notify_lark`. Already delivered platform cards remain; pending outbox items are not drained until the feature is enabled again. Do not replay a delivered idempotency key after rollback. |
| `0.9.12` | Adds no schema. The notify drain worker releases its slot after each run so a later admit or backoff timer can send again; leftover review-thread closures fail closed on retirement maintenance throw and require outbound `sent`. | v0.9.11 reads the same `lark_notify` unit but can leave later admits pending after the first drain. Pending rows remain; do not mint a new idempotency key. |
| `0.9.13` | Adds no durable schema. Operator `/status` and `/diag` are process-local Card replies gated by `operatorFrom`. | v0.9.12 ignores the commands. No sidecar migration. |
| `0.9.14` | Adds the `lark_policy` storage-domain unit (`policies`). Rows are keyed by a salted hash of the chat or group and store only the mention mode, tool/approval flags, and bounded Workspace, model, and salted-hash user lists. No plaintext open ID, chat ID, or secret is stored. | v0.9.13 ignores the new unit and no longer applies conversation-scoped narrowing, so a conversation reverts to the global fail-closed configuration. Nothing is migrated; re-apply `/policy` after a roll-forward. |
| `0.9.15` | Adds no durable schema. Card callbacks resolve the same `lark_policy` document as inbound messages, and `/diag` reports an unconfirmed bot when the client exposes no health probe. | v0.9.14 reads the same unit but gates only inbound messages, so a conversation narrowed after a Card was delivered can still be driven through that Card's buttons. No sidecar migration. |
| `0.9.16` | Adds no storage-domain schema. Optional `runtimeDir` supervision writes two files in that directory: an ownership heartbeat and a status document. Neither holds credentials, platform identifiers, conversation scopes, or paths beyond the directory itself. | v0.9.15 ignores `runtimeDir` and never claims ownership, so a second process can serve the same bot again. Delete the runtime directory after rolling back; a leftover ownership record is inert in v0.9.15 but refuses a v0.9.16 start until `contrib/systemd/lark-clear-stale-owner.sh` clears it. |
| `0.9.17` | Adds the `lark_tasks` storage-domain unit (`tasks`). Rows are keyed by a salted hash of an opaque task reference and store the conversation scope, chat, reply target, a bounded title derived from the instruction, a salted-hash project collision key, status, and timestamps. No prompt body, filesystem path, or credential is stored. | v0.9.16 ignores the new unit and no longer serves `/task`, so live rows stay `running` and their projects stay claimed for a later roll-forward. Stop every task before rolling back, or clear the unit. |

The DSH JSONL format and Workspace domain belong to Harness rc.6 rather than this plugin. This project does not claim cross-Harness migration support. Upgrade the plugin and Harness cohort as separate changes, never in one recovery window.

A stopped deployment can upgrade directly from any prior plugin release to the current release on the same supported Harness cohort; it does not need to run intermediate plugin versions or rewrite JSONL. Without a `lark_conversations` record, recovery chooses the greatest numeric generation only within the exact current base-ID lineage; this is a legacy heuristic, not commit authority. A pre-v0.3 chat-wide group generation is not reassigned to a newer scoped reply-tree/thread lineage. A later durable binding mutation establishes commit authority. No receipt, group transcript, or binding is bulk backfilled: the boundaries in the table remain observable after the direct upgrade.

A custom profile originating before v0.1.3 must mount the current storage hub, a durable KV backend, and `storage-domain` before the new plugin starts; creating an empty `storages` directory is insufficient. Pre-v0.7 state has no binding authority, and the legacy heuristic cannot distinguish a partially published candidate. Verify known conversations before any binding mutation. On a wrong or ambiguous resume, stop and restore a complete known-good snapshot. Operators must never hand-select or delete one JSONL artifact.

## Prepare the target checkout

Prepare and verify a sibling checkout before downtime. Replace the example paths and tag with exact values; do not update the checkout currently serving traffic.

```bash
(
set -Eeuo pipefail

target_checkout_input='/srv/dsh-plugin-lark-next'
target_tag='v0.9.17'

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
umask 077
test ! -L "$dsh_state_root/attachments"
if test ! -e "$dsh_state_root/attachments"; then
  install -d -m 700 -- "$dsh_state_root/attachments"
fi
test -d "$dsh_state_root/sessions"
test -d "$dsh_state_root/storages"
test -d "$dsh_state_root/attachments"
test -d "$dsh_state_root/profiles/web"
test -d "$backup_parent"
test ! -L "$dsh_state_root/sessions"
test ! -L "$dsh_state_root/storages"
test ! -L "$dsh_state_root/attachments"
test ! -L "$dsh_state_root/profiles"
test ! -L "$dsh_state_root/profiles/web"
command -v mountpoint >/dev/null
! mountpoint -q -- "$dsh_state_root/sessions"
! mountpoint -q -- "$dsh_state_root/storages"
! mountpoint -q -- "$dsh_state_root/attachments"
! mountpoint -q -- "$dsh_state_root/profiles"
! mountpoint -q -- "$dsh_state_root/profiles/web"
root_device="$(stat -c '%d' -- "$dsh_state_root")"
root_mount="$(stat -c '%m' -- "$dsh_state_root")"
for active_unit in "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/attachments" "$dsh_state_root/profiles" "$dsh_state_root/profiles/web"; do
  test "$(stat -c '%d' -- "$active_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$active_unit")" = "$root_mount"
done

required_kib="$(du -sk -- "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/attachments" "$dsh_state_root/profiles/web" | awk '{ total += $1 } END { print total }')"
available_kib="$(df -Pk -- "$backup_parent" | awk 'NR == 2 { print $4 }')"
[[ "$required_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
test "$available_kib" -gt "$required_kib"

upgrade_snapshot="$(mktemp -d -- "$backup_parent/dsh-lark-pre-upgrade.XXXXXX")"
test -d "$upgrade_snapshot"
test ! -L "$upgrade_snapshot"
test "$(realpath -e -- "$upgrade_snapshot")" = "$upgrade_snapshot"
test "$(dirname -- "$upgrade_snapshot")" = "$backup_parent"
case "$(basename -- "$upgrade_snapshot")" in dsh-lark-pre-upgrade.*) ;; *) exit 1 ;; esac
cp -a -- "$dsh_state_root/sessions" "$upgrade_snapshot/sessions"
cp -a -- "$dsh_state_root/storages" "$upgrade_snapshot/storages"
cp -a -- "$dsh_state_root/attachments" "$upgrade_snapshot/attachments"
cp -a -- "$dsh_state_root/profiles/web" "$upgrade_snapshot/web-profile"
test -d "$upgrade_snapshot/sessions"
test -d "$upgrade_snapshot/storages"
test -d "$upgrade_snapshot/attachments"
test -d "$upgrade_snapshot/web-profile"
tree_digest() {
  tar --sort=name --format=posix \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --numeric-owner -C "$1" -cf - sessions storages attachments web-profile |
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

Only a private snapshot carrying `SNAPSHOT_SHA256` and `SNAPSHOT_COMPLETE` after all four copies is eligible for this restore template. The checksum detects accidental corruption while the protected directory supplies its trust boundary; it is not a signature against an attacker who can rewrite both files. Verify the snapshot before changing the profile. Do not move or delete the source state. If a custom backend spans databases, volumes, mountpoints, or top-level symlinks, replace the template with one backend-native snapshot that establishes a common consistency point.

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
3. Check `/help`, then list `/project`, `/session`, and `/model`. In a disposable registered Workspace, resume one listed historical Session by its full opaque reference and verify the expected transcript, project, model, preset, and tools. The list may expose a bounded stored title derived from the first human prompt, so use non-sensitive test content.
4. From a direct Native `ask_user_question` call, complete disposable single-choice, multiple-choice, free-text, and Cancel interactions in a real client. Verify the answer resumes the same turn and terminal Cards contain no answer or controls. A pending pre-upgrade Card is expected to be stale after restart; never put credentials in a question or answer.
5. Verify an unrelated direct conversation and group reply root cannot use that reference. Restart once, list again, and repeat the resume check before accepting the migration.
6. Run the relevant credential-backed checks in `SMOKE_TESTS.md`, including `/new`, structured input, session navigation, project/model inheritance, restart, and LRU cold resume, then retain the snapshot and old checkout until the rollback window closes.

Every handled validation message advances the inbound receipt state. A later snapshot restore rewinds those receipts and can allow redelivery; use disposable checks and reconcile external side effects.

## Cold migration to another machine

A host move is a cold migration, not a blue/green rollout. Stop the source first and keep it stopped; no source and destination Harness processes may share the state or connect the same Lark app at once. This stock procedure is limited to a cold same-Linux move into an empty root that preserves numeric ownership, modes, symlink targets, and the exact absolute `DSH_HOME`, checkout, launch, and Workspace paths. Other layouts and backends remain unverified and require their native procedure.

Prepare the destination with the exact rc.6 cohort, one Node.js line supported by both the source and target plugin versions, target and rollback plugin tags/commits, app ID, `defaultSessionId`, JSONL compression, launch workspace, and credential source. Do not change the Node.js line during this state transfer. Transfer one completed four-directory snapshot plus the required immutable checkouts over an authenticated channel, then recompute and verify `SNAPSHOT_SHA256` before installation. Copy Workspace repositories separately so their canonical paths and commits match; they are not inside the state snapshot. Never merge destination JSONL/JSON or attachment objects with existing state. Validate the destination while the source remains stopped, and stop the destination before any source rollback or retry.

## Rollback decision table

Every rollback target older than v0.9.2 restores the previous Card payload contract. Feishu can reject its approval card at creation, making the protected call unavailable while remaining fail-closed; this shared behavior is in addition to the target-specific state consequences below.

| Rollback target from v0.9.17 | State handling |
| --- | --- |
| v0.9.16 | Keeps the `lark_tasks` rows but stops serving `/task`. Rows left `running` are retired to `orphaned` on the next v0.9.17 start, not on v0.9.16. |
| v0.9.15 | Same durable state; channel ownership and the runtime status document stop being maintained. A supervisor reading `status.json` sees a heartbeat that stops advancing, so disable that probe before rolling back. |
| v0.9.14 | Same durable state; conversation policy stops gating Card callbacks and `/diag` reports a healthy bot whenever no failure is observed. |
| v0.9.13 | Keeps the `lark_policy` rows but stops reading them, so every conversation falls back to the global configuration. A conversation that was narrowed becomes as permissive as the global gates allow; re-check `allowFrom`, `operatorFrom`, `outboundArtifacts`, and `proactiveDelivery` before rollback. |
| v0.9.12 | Same as v0.9.13, and `/status` and `/diag` disappear. |
| v0.9.11 | Uses the same `lark_notify` unit and tool, but the first drain worker can leave later admits or backoff retries pending until remount. |
| v0.9.10 | Uses the same Session, bindings, and artifact tool, but ignores `lark_notify` and does not register `notify_lark`. Already delivered notification cards remain on the platform; pending outbox rows stay until the feature is enabled again. |
| v0.9.9 | Uses the same bindings, attachment store, approval audit, and Session vocabulary, but removes the outbound-artifact tool. Already delivered messages and uploaded platform orphans remain external; do not infer their state from a rolled-back `tool/result`. |
| v0.9.8 | Uses the same bindings, Session logs, and image-routing guard but never downloads a new Lark image. Existing image blocks still require their referenced attachment objects and an image-capable route. No object or orphan is deleted; keep the attachment store with the snapshot. |
| v0.9.7 | Uses the same durable state and image-routing guard, but removes graceful terminalization for ordinary running execution Cards. A Card still showing Running/Stop after process exit has no live Stop authority; inspect the Session after restart and retry as needed. |
| v0.9.6 | Uses the same durable state but removes image-aware model and Session routing checks. Image blocks already present through another Harness surface remain in the Session; verify every affected conversation uses an image-capable route before serving ordinary prompts. |
| v0.9.5 | Uses the same durable state and continues every accepted text attachment already committed as an ordinary user block, but new file messages return to the generic unsupported notice and are never downloaded. Stop cleanly first; no attachment sidecar or temporary-file cleanup exists. |
| v0.9.4 | Uses the same durable state, but its constructible plugin entry can lose the async disposer during root unload. Pending questions may remain interactive-looking while their process state is gone, and their tool calls cold-repair as interrupted. Prefer roll-forward; if rollback is required, stop v0.9.9 cleanly first and treat every outstanding v0.9.4 Card as stale. |
| v0.9.3 | Uses the same v2 conversation binding, Workspace domain, and Session logs. Structured Card handling and its process-local pending state disappear; stop cleanly first. Already-sent Cards remain terminal or stale in chat, and every outstanding action is rejected. Completed answers already committed as ordinary tool results remain in the transcript. |
| v0.9.2 | Uses the same v2 conversation binding, Workspace domain, and Session logs. A Session selected through v0.9.3 remains active because v0.9.2 follows that committed binding, but the `/session` list/resume command disappears and rollback does not restore the previously active Session. No archive, unarchive, delete, or search state was introduced by v0.9.3. |
| v0.9.1 | No durable-state conversion is required. The older Card payload can be rejected by Feishu, so approvals may become unavailable while remaining fail-closed; retain the full snapshot and prefer roll-forward recovery. |
| v0.9.0 | Same v2 binding and Workspace schemas. The already materialized v0.9.1 Session remains readable, but v0.9.0 reintroduces failed project-registry checkpoints and lacks safe first-command materialization; retain the full snapshot and prefer roll-forward recovery. |
| v0.8.8, v0.8.7, v0.8.6, or v0.8.5 | Same v2 binding schema and Node.js 22/24 engine contract. The older plugin ignores project-management commands, but rollback does not restore registrations removed during v0.9.x or remove registrations added during v0.9.x. Keep the complete snapshot and reconcile the Harness `workspace` domain before serving traffic; project directories, files, and transcripts remain. |
| v0.8.4, v0.8.3, v0.8.2, v0.8.1, or v0.8.0 | Same v2 binding schema. Stop cleanly and keep a snapshot; an in-place code rollback is schema-compatible on the exact rc.6 cohort. This runbook supports only Node.js 22 for these targets: v0.8.1–v0.8.4 enforce it in `engines`, while v0.8.0's broader historical range did not establish Node.js 24 support. A deployment already on Node.js 24 must restore the runtime in a separate cold step before starting the older plugin. |
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
test -d "$upgrade_snapshot/attachments"
test -d "$upgrade_snapshot/web-profile"
test -f "$upgrade_snapshot/SNAPSHOT_SHA256"
test -f "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test -d "$dsh_state_root/sessions"
test -d "$dsh_state_root/storages"
test -d "$dsh_state_root/attachments"
test -d "$dsh_state_root/profiles/web"
test ! -L "$upgrade_snapshot/sessions"
test ! -L "$upgrade_snapshot/storages"
test ! -L "$upgrade_snapshot/attachments"
test ! -L "$upgrade_snapshot/web-profile"
test ! -L "$upgrade_snapshot/SNAPSHOT_SHA256"
test ! -L "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test ! -L "$dsh_state_root/sessions"
test ! -L "$dsh_state_root/storages"
test ! -L "$dsh_state_root/attachments"
test ! -L "$dsh_state_root/profiles"
test ! -L "$dsh_state_root/profiles/web"

root_device="$(stat -c '%d' -- "$dsh_state_root")"
root_mount="$(stat -c '%m' -- "$dsh_state_root")"
command -v mountpoint >/dev/null
for active_unit in "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/attachments" "$dsh_state_root/profiles" "$dsh_state_root/profiles/web"; do
  ! mountpoint -q -- "$active_unit"
  test "$(stat -c '%d' -- "$active_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$active_unit")" = "$root_mount"
done

tree_digest() {
  tar --sort=name --format=posix \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --numeric-owner -C "$1" -cf - sessions storages attachments web-profile |
    sha256sum | awk '{ print $1 }'
}
expected_digest="$(< "$upgrade_snapshot/SNAPSHOT_SHA256")"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]]
test "$(tree_digest "$upgrade_snapshot")" = "$expected_digest"
required_kib="$(du -sk -- "$upgrade_snapshot/sessions" "$upgrade_snapshot/storages" "$upgrade_snapshot/attachments" "$upgrade_snapshot/web-profile" | awk '{ total += $1 } END { print total }')"
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
cp -a -- "$upgrade_snapshot/attachments" "$restore_stage/attachments"
cp -a -- "$upgrade_snapshot/web-profile" "$restore_stage/web-profile"
for staged_unit in "$restore_stage/sessions" "$restore_stage/storages" "$restore_stage/attachments" "$restore_stage/web-profile"; do
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
  rollback_one "$dsh_state_root/attachments" "$rollback_hold/attachments" "$restore_stage/attachments" "$original_attachments_id" "$staged_attachments_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile attachments'; rollback_failed=1; }
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
original_attachments_id="$(dir_id "$dsh_state_root/attachments")"
original_web_id="$(dir_id "$dsh_state_root/profiles/web")"
staged_sessions_id="$(dir_id "$restore_stage/sessions")"
staged_storages_id="$(dir_id "$restore_stage/storages")"
staged_attachments_id="$(dir_id "$restore_stage/attachments")"
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
rename_empty_target "$dsh_state_root/attachments" "$rollback_hold/attachments" "$original_attachments_id" || exit 1
rename_empty_target "$dsh_state_root/profiles/web" "$rollback_hold/web-profile" "$original_web_id" || exit 1
rename_empty_target "$restore_stage/sessions" "$dsh_state_root/sessions" "$staged_sessions_id" || exit 1
rename_empty_target "$restore_stage/storages" "$dsh_state_root/storages" "$staged_storages_id" || exit 1
rename_empty_target "$restore_stage/attachments" "$dsh_state_root/attachments" "$staged_attachments_id" || exit 1
rename_empty_target "$restore_stage/web-profile" "$dsh_state_root/profiles/web" "$staged_web_id" || exit 1
test "$(dir_id "$dsh_state_root/sessions")" = "$staged_sessions_id"
test "$(dir_id "$dsh_state_root/storages")" = "$staged_storages_id"
test "$(dir_id "$dsh_state_root/attachments")" = "$staged_attachments_id"
test "$(dir_id "$dsh_state_root/profiles/web")" = "$staged_web_id"
test "$(dir_id "$rollback_hold/sessions")" = "$original_sessions_id"
test "$(dir_id "$rollback_hold/storages")" = "$original_storages_id"
test "$(dir_id "$rollback_hold/attachments")" = "$original_attachments_id"
test "$(dir_id "$rollback_hold/web-profile")" = "$original_web_id"
if path_present "$restore_stage/sessions" || path_present "$restore_stage/storages" || path_present "$restore_stage/attachments" || path_present "$restore_stage/web-profile"; then exit 1; fi
rename_committed=1
trap - ERR EXIT HUP INT QUIT TERM
printf 'active root: %s\nrollback hold: %s\nrestore stage: %s\n' "$dsh_state_root" "$rollback_hold" "$restore_stage"
)
```

The subshell fails closed on validation, copy, checksum, or rename errors. During the rename phase, its `EXIT`/`HUP`/`INT`/`QUIT`/`TERM` trap uses non-overwriting moves plus device/inode checks to restore the original four units. SIGKILL, host power loss, and kernel failure cannot run the trap. After any interrupted or incomplete result, keep Harness stopped and reconcile the printed active, hold, and stage paths against their recorded invariants; never overwrite or merge them.

The restored profile must find the immutable original checkout at the same absolute path and exact commit recorded before downtime. Do not point it at another directory or run `plugin add` as a substitute. Start the exact old plugin on the same rc.6 cohort. `/api/lark/health` exists only in v0.5.0 and newer; for v0.1.0–v0.4.0, require the historical `[ws] ws client ready` gate plus a disposable end-to-end reply and conversation-resume check, and do not treat HTTP 404 alone as plugin failure. Retain `rollback_hold`, `restore_stage`, the snapshot, and both immutable old/target checkouts until the incident closes.

Restoring the snapshot rewinds transcripts, referenced attachment objects, receipts, Workspace registration/order, project/model bindings, and mutation history to the snapshot time. Workspaces on disk, outbound artifact uploads/messages, other platform messages, provider calls, and external side effects remain at their current time. Review that split explicitly before allowing new turns; never resend an artifact merely because its restored tool result is absent or unknown.

## Failure recovery

- Startup rejecting `lark_conversations` after a downgrade usually indicates an unsupported v2-to-v1 rollback. Stop and restore or roll forward.
- A conversation opening on the wrong generation after downgrading below v0.7 indicates that the old release ignored commit authority. Stop before it accepts more work and restore the pre-v0.7 snapshot.
- Missing context after downgrading below v0.3 is expected for scoped group sessions; do not delete or automatically select the newer JSONL logs.
- Duplicate handling after restoring an older snapshot or downgrading below v0.1.3 is possible under the documented at-least-once boundary. Reconcile platform and tool side effects before retrying.
- Never solve a state error by deleting one storage-domain file. Preserve the failed state, collect only sanitized version/error facts, and prefer a compatible roll-forward when no known-good snapshot exists.
