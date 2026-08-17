# Roadmap

This roadmap records intended outcomes rather than release dates. Priorities may change as the project gains operational feedback.

## 0.1.1 — Reliability

- Restore the persisted Agent preset and its scoped tools when Lark sessions are created or resumed.
- Continue long final answers in platform-sized text messages after the execution-card preview.
- Provide one credential-backed smoke runbook for Feishu and Lark deployments.

## 0.1.2 — Delivery automation

- Rebase-merge owner-authored pull requests after required CI passes.
- Validate one forward package version per feature pull request and release the tested `main` commit automatically.

## 0.1.3 — Inbound durability

- Persist a bounded inbound-message receipt window across restarts.
- Finish each platform callback only after its successful handling receipt is durable.

## 0.2.0 — Reply delivery

- Deliver command results, execution cards, approvals, fallbacks, and long-answer continuations as replies to the triggering message.
- Preserve the originating reply target when a shared Harness session serves concurrent chats.

## 0.2.1–0.2.2 — Delivery reliability

- Close approval cards exactly once when cancellation, reset, or shutdown races card creation.
- Clean up rejected delivery tasks without creating unhandled derived promise rejections.

## 0.3.0 — Conversation context

- Map group reply trees and threads to isolated, resumable Harness sessions.
- Keep direct-chat session identities compatible and preserve explicit global session binding.
- Deliver native-thread replies inside the originating thread without changing ordinary reply-tree delivery.

## 0.4.0 — Input safety

- Classify unsupported non-text input without parsing or retaining its platform content or resource metadata.
- Reply with a generic text-only notice only after the existing authorization and group-mention gates.

## 0.5.0 — Connection readiness

- Expose the official SDK WebSocket connection state through an optional Web-profile readiness endpoint.
- Return only sanitized reconnect metadata, with non-connected states failing readiness.

## 0.6.0 — Bounded conversation residency

- Keep live conversation handles within a configurable steady-state target by releasing least-recently-used idle entries after a confirmed durability checkpoint.
- Preserve active turns, pending inbox work, and bridge operations, then cold-resume the exact persisted conversation scope when an evicted conversation is used again.

## 0.6.1 — Documentation

- Publish equivalent English and Simplified Chinese READMEs with a complete, scannable feature overview.
- Document provider-key ownership and the current project/model switching boundary explicitly.

## 0.7.0 — Conversation projects

- Let an authorized conversation list and select only Workspaces registered by the Web profile, without accepting arbitrary filesystem paths from chat.
- Start a blank, durable session generation in the selected Workspace and restore that exact project after restart or idle-handle eviction.
- Checkpoint the old transcript before switching, and keep each blank Lark generation out of the Workspace reuse index until its first durable turn.
- Commit the exact active generation through a privacy-preserving durable sidecar so failed candidates cannot win restart recovery, and retain a bounded hashed mutation history so receipt-loss replays cannot roll back a later project or reset.
- Serialize project changes against true Agent maintenance and bind replies to claimed message IDs across concurrent Lark and Web input.
- Reject an interrupted ambiguous mutation callback without a receipt, and require a fresh Bridge/storage remount before recovery.

## 0.8.0 — Conversation models

- Let an authorized conversation list live providers and their advertised models, then select an exact provider/model route, including dynamic model IDs resolved by the serving adapter.
- Treat model catalogs as advisory discovery rather than routing allowlists or credential-health probes.
- Persist the selected route within the exact conversation scope, restore it after restart or idle-handle eviction, and carry it into fresh generations created by `/new`, `/clear`, or `/project`.
- Switch only from true-idle maintenance, fail closed around existing running or pending work, retain input admitted during the atomic commit, and update one Agent-scoped step-snapshot selector without replacing the live Handle.
- Keep model choices isolated between direct chats, reply trees, and native threads while preserving the intentional global sharing of `defaultSessionId`.
- Protect model mutations against receipt-loss replay without changing the Harness-wide default model for unrelated conversations.

## 0.8.1 — Harness compatibility

- Publish an equivalent English and Simplified Chinese matrix for the exact Harness, host-library, and Node.js baseline exercised by the release gate.
- Distinguish supported combinations from installable or unverified ones, and fail closed around mixed Harness release cohorts.
- Keep the manifest, lockfile, packed-consumer resolution, documentation, and CI runtime aligned through automated checks.

## 0.8.2 — Upgrade and rollback

- Publish equivalent English and Simplified Chinese cold-upgrade, rollback, and durable-state migration procedures.
- Record the receipt, group-session, binding-authority, and model-selection schema boundaries across prior releases.
- Require one point-in-time backup unit for sessions, storage domains, and the Web profile; reject partial restore and unsupported down-migration guidance.

## 0.8.3 — Release provenance

- Carry the exact packed-consumer-tested npm archive into the corresponding GitHub Release without rebuilding it in a privileged job.
- Generate and verify SLSA build provenance for that archive with a SHA-pinned GitHub action and narrowly scoped release permissions.
- Reconcile tags, attestations, and Release assets idempotently while failing closed on commit or digest conflicts.

## 0.8.4 — Web-profile package lifecycle smoke

- Install the exact packed candidate archive into an isolated, newly initialized stock rc.6 Web profile before that archive can be uploaded for release.
- Upgrade a second isolated stock profile from the verified v0.8.3 Release package to the same candidate archive while preserving its user patch and resolving only the candidate package version.
- Require exactly one Lark bundle and one composed Lark configuration layer after each transition, while keeping app startup, credentials, WebSocket readiness, and persisted-state migration outside this boot-free gate.

## 0.8.5 — Node.js 24 on Linux

- Expand the package engine contract to the tested even-numbered Node.js 22 and 24 lines without admitting the unverified Node.js 23 or 25 lines.
- Keep Node.js 22 as the canonical archive producer and adjacent-release upgrade gate, then recreate dependencies under engine-strict Node.js 24 and repeat the assembled Harness and packed-consumer checks.
- Clean-install the exact canonical candidate archive into an isolated stock rc.6 Web profile under Node.js 24 before upload, without claiming a cross-runtime upgrade, real app boot, credentials, network readiness, or persisted-state migration.

## 0.8.6 — macOS package compatibility

- Require engine-strict Node.js 22 source, assembled Harness, audit, and independently packed-consumer checks on the versioned GitHub-hosted macOS 26 arm64 image.
- Transfer the exact Ubuntu-built canonical candidate through a digest-checked Actions artifact and install it as a separate macOS consumer without rebuilding or replacing the release archive.
- Keep the protected `test` context fail-closed across both operating-system gates while leaving macOS Web-profile composition, app boot, credentials, network readiness, state migration, Node.js 24, and Intel hardware unverified.

## 1.0 — Stable release

- Expand the verified matrix only after additional Harness cohorts, Node.js LTS majors, operating systems, and credential-backed Web-profile startup plus persisted-state upgrade paths pass their own evidence-backed gates.

## Not planned

- An administration UI.
- A generic card-authoring framework.
