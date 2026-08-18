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
- Finish each inbound-message event callback only after its successful handling receipt is durable; interactive Card action responses follow their feature-specific settlement boundary.

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

## 0.8.7 — Node.js 24 package compatibility on macOS

- Expand the existing macOS 26 arm64 package/runtime gate into independent Node.js 22 and 24 matrix legs without changing the package engine or minimum type baseline.
- Require both engine-strict runtimes to repeat the source/Harness, audit, independent packed-consumer, and exact Ubuntu-built canonical archive consumer checks.
- Keep macOS Web-profile composition, app boot, credentials, network readiness, state migration, Intel hardware, and other macOS releases outside the verified boundary.

## 0.8.8 — Product roadmap

- Prioritize user-facing project, session, human-input, media, delivery, policy, and operations gaps ahead of further low-impact compatibility expansion.
- Define each 0.9 milestone as one independently reviewable capability with explicit authorization, durability, privacy, failure, and upgrade boundaries.
- Record deliberate exclusions so later work does not weaken the registered-Workspace boundary, secret ownership, serialized message semantics, or the core channel's minimal permission surface.

## 0.9.0 — Self-service project registration

- Make an empty `/project` result actionable instead of presenting project switching as unavailable when the Workspace registry is mounted but empty.
- Let an explicitly configured project manager register the current Session's canonical working directory under a bounded display title from a direct chat, without accepting an arbitrary filesystem path or exposing that path in replies or logs.
- List and select registrations for ordinary authorized users, but require an exact full ID for manager-only removal; keep Registry visibility profile-global and make removal catalog-only so files, Agents, Sessions, bindings, and transcripts remain.
- Serialize Lark Workspace mutations, precommit bounded replay protection, fail closed on ambiguous host mutations, and verify canonical registration/removal/restart behavior against the real rc.6 Registry and persistence stack.

## 0.9.1 — First-command project registration reliability

- Declare the Harness `sessions` service consumed by project-registry checkpoints while keeping `sessionPersistence` an optional, fail-closed capability.
- Materialize a blank conversation Session before its first project-registry mutation binding is committed, so the binding remains recoverable after a cold restart.
- Verify the production Cordis owner context, default zstd persistence, real Workspace Registry, and restart path together; pin the adjacent profile upgrade to the attested v0.9.0 Release.

## 0.9.2 — Card 2.0 platform-schema compatibility

- Keep every emitted `column_set`, optional `element_id`, approval card, decision card, and running/terminal turn card inside the official Card 2.0 field and identifier contracts.
- Silence the official SDK's raw internal logger, classify resolved business errors, HTTP rejection, transport failure, and malformed message responses at a sanitized boundary, and never retry an ambiguous Card patch through another write API.
- Verify Approval and turn Card create/update payloads against Feishu before release while keeping card-action callbacks on the authenticated, conversation-bound handler and all approval failures fail-closed.

## 0.9.3 — Session navigation

- Add `/session`, `/session list [page]`, and `/session resume <reference>` with ten entries per page, at most 200 candidates, a bounded 1,000-entry Workspace-index scan, and app-plus-conversation-scoped opaque references that never accept a title, raw Session ID, or filesystem path.
- List only persisted top-level Sessions in the exact conversation lineage: the current Session or historical Sessions uniquely indexed by an available registered Workspace. Hide every archived record, and hide historical orphaned or unindexed, subagent/child, non-persisted, non-current live, ambiguous, and cross-scope records; revalidate the same boundary before resume and fail historical authority closed when the 1,000-entry index scan is incomplete.
- Display only a bounded stored Session title, creation timestamp, registered Workspace title, and opaque reference. A stored title can be derived from the first human prompt and is therefore visible to every user sharing that conversation scope; never add a full prompt, message/tool preview, raw platform/Session identifier, or path fallback.
- Resume from true idle only after checkpointing the current transcript, then atomically commit the existing v2 binding and mutation replay history while restoring the selected transcript, project, model, Agent preset, and scoped tools. Preserve the lineage high-water mark so later fresh generations cannot move backward.
- Verify the real rc.6 Session Query, default zstd persistence, Workspace Registry, restart, LRU, pagination, scope, and failure paths together. Keep archive state read-only: the chat interface does not archive, unarchive, delete, or search Sessions.

## 0.9.4 — Structured human input

- Intercept the compatible rc.6 `ask_user_question` definition for a claimed Lark direct Native call, render up to three single-choice, multiple-choice, or bounded free-text questions in one native Card, and return the authorized answer to the same running turn without registering a competing User Questions provider.
- Bind every question to the exact live Agent, turn, Session, conversation scope, chat, Card message, and initiating user; use internal option tokens, literal model-authored UI text, atomic batch validation, and first-wins settlement so stale, duplicate, malformed, replayed, or cross-context answers fail closed.
- Require an explicit successful Session checkpoint before Card creation, start the 30-minute answer window only after delivery, and define bounded cancellation, Stop, reset, shutdown, delivery-failure, callback-repair, hard-crash, and restart behavior. A callback acknowledges process-local acceptance; durability begins only when the Harness commits the tool result.
- Support direct Native calls in `native` and `both` modes. Fail nested Code Mode calls quickly without creating a Card because the rc.6 Code Runtime has no public API for pausing its worker wall-clock budget during human wait; revisit Code Mode only after that runtime capability exists.

## 0.9.5 — Graceful structured-input Card shutdown

- Export a non-constructible Cordis plugin entry so the async disposer returned by startup is registered and awaited during real root-fiber and SIGTERM shutdown, rather than being mistaken for a constructor whose Promise result is ignored.
- Register each known terminal human-input Card close synchronously inside first-wins settlement, then seal delivery admission before REST stops; shorten an in-flight close to two seconds during shutdown so it fits inside the rc.6 CLI's five-second whole-process grace.
- Best-effort advance Agent/Session quiescence alongside Card delivery, verify actual root-fiber disposal rather than only direct `bridge.stop()`, and repeat the real Feishu create/busy/SIGTERM/terminal-PATCH evidence path. Do not claim rc.6 commits the pending `tool/result` inside host grace: an unmatched call still cold-repairs after restart.

## 0.9.6 — Secure inbound text attachments

- Add opt-in direct-chat support for one bounded `.txt`, `.log`, `.patch`, or `.diff` resource using strict filename, MIME, byte, UTF-8, authorization, and replay checks before Agent admission; keep group attachments fail-closed because standalone platform file messages cannot carry the required bot mention.
- Download only the exact authenticated message resource from the fixed Feishu/Lark API, stream it into bounded memory without redirects or temporary files, and cancel the stream during shutdown.
- Frame accepted content as untrusted user data in the ordinary durable Session transcript; keep resource keys, credentials, private paths, raw SDK failures, and rejected contents out of logs, receipts, bindings, and error replies.
- Leave images, outbound artifacts, URLs, archives, standalone active-markup documents, audio, video, and generic binary files unsupported in this release; preserve markup inside a recognizable unified diff as code.

## 0.9.7 — Image-aware Session routing

- Detect images only on the exact current model-visible Session surface, including nested tool results while excluding history shadowed by compaction replacement.
- Refuse `/model` transitions from image history to a route whose exact adapter metadata does not explicitly include image input; advisory catalogs and model names never establish capability.
- Refuse `/session resume` when the target's actual compacted surface contains images but its persisted route is text-only, capability-unknown, or temporarily unverifiable, leaving the old binding and Handle authoritative.
- Let a cold image Session open in a recoverable degraded state: reject ordinary prompts and dynamic runtime commands before provider I/O, keep bridge-owned recovery commands available when idle, and let a compatible `/model` switch atomically wake an already durable pending inbox.

## 0.9.8 — Graceful execution-Card shutdown

- Before root teardown can remove Session listeners, synchronously freeze every known running execution Card into a control-free shutdown terminal state and remove its Stop token.
- Abort queued or in-flight running Card writes, then attempt one final signal-bound PATCH behind the old delivery chain with a two-second whole-close deadline below the rc.6 host grace budget.
- Preserve partial reasoning only as an interrupted snapshot; never send a partial long-answer continuation, claim a durable turn result, create a duplicate Card without a confirmed message ID, or let running tools/todos retain animated state.
- Cover direct Bridge stop, real root-fiber disposal, stalled create/PATCH, delivery failure, multiple Sessions, natural completion races, and credential-backed SIGTERM behavior.

## 0.9.9 — Bounded static inbound images

- Accept only opt-in direct-chat PNG and JPEG messages after authorization, exact-model image-capability confirmation, plugin-owned byte/pixel limits, a global no-wait concurrency slot, deployment attachment limits, and authoritative image validation all succeed.
- Commit bytes through one stable Harness attachment service before publishing an image block, persist only its content-addressed reference in the Session, and preserve cold-resume/fork readability.
- Recheck the exact Handle, Session, model route, surface, and attachment-service identity after every asynchronous boundary; document non-cancellable save, shared-object retention, and possible pre-followup orphan rather than deleting objects from the channel.
- Defer GIF and WebP until the supported Harness attachment backend can prove bounded validation of every animation frame; do not infer static content from a filename, MIME value, or first frame.

## 0.9.10 — Approved outbound artifacts

- Add an explicit Agent-scoped tool for sending a bounded generated text file or raster image from the exact registered Workspace serving the active Lark turn.
- Require one-shot approval, canonical containment, regular-file and final-symlink checks, safe names and extensions, and an exact active chat/user/turn route; reject URLs, `file:` URIs, absolute paths, subagents, nested Code Mode, and Web-originated calls.
- Upload and deliver without exposing local paths, platform keys, destination identifiers, file content, or credentials in the tool result, logs, Session sidecars, or error reply; do not retry an ambiguous send.

## 0.9.11 — Reliable proactive delivery

- Let an Agent send a completion or attention notification to a previously registered conversation scope, including a bounded explicit mention list, without accepting arbitrary destination IDs from model output.
- Persist a bounded outbox with idempotency keys, retry state, expiry, rate limits, and terminal delivery outcomes so process restarts cannot silently lose or duplicate admitted notifications.
- Leave scheduling to Harness or an external scheduler; keep the channel responsible only for authorization, durable delivery, and observability.

## 0.9.12 — Operator status and diagnostics

- Add an operator-only status command covering the current plugin version, uptime, connection state, conversation/session identity, project, model, active work, and bounded context/usage information.
- Add a sanitized diagnostic command that checks Bot REST identity, required scopes, Workspace registration count, session persistence, storage-domain write/flush participation, provider configuration, and recent categorized failures.
- Return actionable remediation without revealing credentials, platform identifiers, prompts, message/session IDs, private paths, provider endpoints, or raw errors.

## 0.9.13 — Conversation-scoped policy

- Support per-chat and per-group policy for authorized users, mention requirements, visible/selectable Workspaces, selectable provider/model routes, and allowed tool or approval classes.
- Intersect scoped policy with the global fail-closed configuration so a local rule can only narrow access unless an explicit administrator-controlled policy says otherwise.
- Apply policy before listing protected names or IDs as well as before execution, and persist no secret values in the policy document.

## 0.9.14 — Runtime supervision and safe recovery

- Ship optional, reviewable service-manager templates with graceful shutdown, bounded restart, stable logs, credential-environment guidance, and readiness checks for supported hosts.
- Detect a failed or non-ready DSH profile from outside that process and provide a minimal recovery path without loading the failing third-party profile graph.
- Prevent split-brain channel ownership through a heartbeat or lease, and require explicit operator action before any recovery component changes plugins, profiles, or durable state.

## 0.9.15 — Explicit parallel tasks

- Let a user explicitly create, list, inspect, and stop bounded parallel tasks, each with its own DSH session, run ID, reply target, lifecycle card, and durable conversation association.
- Keep ordinary consecutive messages serialized; never reinterpret them as implicit parallel work.
- Define project-level write-collision policy and concurrency limits so parallel tasks cannot silently modify the same Workspace without an explicit safe configuration.

## 0.9.16 — Optional document handoff

- Read only an explicitly supplied, authorized Lark document link through a separately permissioned tool with bounded content and clear source attribution.
- Publish a long final report as a document on explicit request, then return its link in the originating conversation while preserving the normal chat answer and delivery receipt.
- Keep the general Docs, Calendar, Base, Sheets, Tasks, Wiki, and Drive API surface in separate optional tools rather than expanding the core channel's default permissions.

## 1.0 — Stable release

- Complete the high-value 0.9 conversation, media, delivery, policy, and operations gates without weakening the existing authorization, durability, privacy, or reply-routing contracts.
- Expand the verified matrix only after additional Harness cohorts, Node.js LTS majors, operating systems, and credential-backed Web-profile startup plus persisted-state upgrade paths pass their own evidence-backed gates.
- Freeze public configuration and durable schemas only after cold upgrade, rollback, failure-injection, and long-running resource tests have passed on the supported deployment baseline.

## Not planned

- An administration UI.
- A generic card-authoring framework.
- Accepting arbitrary filesystem paths from chat.
- Reading or modifying provider credentials through chat commands.
- Implicit or unbounded parallel execution of ordinary messages.
- Bundling the complete Lark office API surface into the core channel.
