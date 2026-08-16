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

## Later 0.2.x — Conversation context

- Map group reply trees and threads to isolated, resumable Harness sessions.
- Define safe handling for image and file input before enabling it.
- Add connection-health diagnostics for operators.

## 1.0 — Stable release

- Publish a supported DeepSeek Harness compatibility matrix.
- Document upgrade, rollback, and session-state migration procedures.
- Automate package provenance for tagged releases.

## Not planned

- An administration UI.
- A generic card-authoring framework.
