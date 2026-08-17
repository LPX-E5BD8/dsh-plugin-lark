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

## 1.0 — Stable release

- Publish a supported DeepSeek Harness compatibility matrix.
- Document upgrade, rollback, and session-state migration procedures.
- Automate package provenance for tagged releases.

## Not planned

- An administration UI.
- A generic card-authoring framework.
