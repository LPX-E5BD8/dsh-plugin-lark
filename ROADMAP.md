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

## Later 0.x — Usability

- Publish a Chinese README alongside the English documentation and add a complete feature overview.
- Let each authorized conversation select a validated project/workspace without affecting other conversations.
- Let each conversation select and persist an available provider/model without cross-session leakage.

## 1.0 — Stable release

- Publish a supported DeepSeek Harness compatibility matrix.
- Document upgrade, rollback, and session-state migration procedures.
- Automate package provenance for tagged releases.

## Not planned

- An administration UI.
- A generic card-authoring framework.
