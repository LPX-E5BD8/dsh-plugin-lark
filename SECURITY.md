# Security Policy

## Supported versions

Security fixes are provided for the latest stable release.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for security-sensitive reports. Do not open a public issue before a fix is available.

Please provide a minimal, sanitized reproduction and the affected version. Do not include app credentials, user or chat identifiers, message contents, session logs, or other private data.

For ordinary defects that do not involve confidentiality, integrity, authorization, or availability, use the public issue tracker.

## Attachment boundary

Inbound direct-chat text files are disabled by default. Enabling them requires `im:resource` and intentionally places each accepted file's safe basename, normalized media type, byte count, and content into the Harness Session transcript as untrusted user data. Apply the same access control, encryption, backup, export, and retention policy used for prompts; never send credentials or production secrets as an attachment.

The channel accepts no attachment URL or local path. It downloads only the resource key carried by the authenticated platform event from the configured Feishu/Lark OpenAPI domain, with redirects disabled and a hard 256 KiB streamed limit. Report any path that exposes a resource key, credential, plugin/host-derived private path, raw header/error, or rejected content in logs, receipts, bindings, or user-facing failures as a security issue. User-supplied file content is intentionally not a redaction boundary.

Inbound direct-chat images are separately disabled by default. When enabled, the channel accepts only one static PNG or JPEG after authorization, durable deduplication, exact-model image capability, a global no-wait slot, plugin byte/pixel/aggregate ceilings, deployment attachment limits, strict structure checks, and authoritative attachment validation succeed. APNG, MPO, concatenated images, GIF, WebP, every group image, URLs, redirects, local paths, and capability inference from catalogs or model names remain rejected. Report any path that downloads before authorization/capability, bypasses a limit, persists a platform image key or raw bytes outside the attachment store, or submits a reference after its exact Session/model/service snapshot changed.

Accepted bytes are committed to the Harness attachment store before a content-addressed reference enters the Session. Harness rc.6 exposes no delete, reference-count, or garbage-collection API, and `saveImage()` cannot be cancelled. Shutdown waits for an in-progress save and refuses late admission; a crash, route/service mutation, follow-up failure, or receipt failure after publication can leave an indefinitely retained orphan. Session deletion, archival, compaction, fork deletion, or plugin rollback does not delete shared objects. Apply explicit capacity, access, backup, and retention controls to `$DSH_HOME/attachments` or the configured backend. Attachment IDs reveal equality of identical content to principals who can inspect Session references; treat that as metadata disclosure. Never delete an object merely because this channel's admission failed after save.

Model catalogs are not capability allowlists: any image history, whether admitted here or through another trusted Harness surface, may be sent only when exact adapter metadata explicitly includes image input. The bridge keeps incompatible cold Sessions recoverable for `/model`, `/new`, `/clear`, and navigation, but rejects ordinary prompts before provider I/O. Adapter replacement after a successful check remains a fail-closed provider boundary rather than a reason to infer or cache capability indefinitely.

## Outbound artifact boundary

Outbound Workspace artifacts are separately disabled by default. Enabling them exposes one Agent-scoped tool, not a generic destination or filesystem API. The tool accepts no destination, URL, URI, absolute path, hidden path, final symlink, escaping or unsafe-canonical intermediate symlink, hardlink, device, FIFO, directory, cross-device file, archive, generic binary, audio, video, animation, or nested Code Mode call. A stable intermediate symlink whose canonical target has only safe segments and remains inside the same Workspace is allowed. It can reply only to the exact message that owns the live Lark turn, and only after the exact initiating user acts on the exact confirmed approval Card. A generic approval answerer returning `allowed-once` is insufficient; the Bridge requires its own matching Lark claim and a confirmed durability flush before any platform write.

The supported Linux path uses a local non-privileged descriptor boundary: canonical root dev/inode, `O_NOFOLLOW | O_NONBLOCK`, regular-file `fstat`, one link, same device, path/descriptor fingerprint agreement, exact `/proc/self/fd/<fd>` canonical-target checks before and after reads, bounded reads, digest/type validation before and after approval, and final root/path revalidation. This prevents alternating parent-symlink observations, ordinary swap/restore, and same-name replacement races. The tool fails closed where that Linux descriptor boundary is unavailable. rc.6 provides no artifact-origin provenance, so approval authorizes an ordinary file currently present in the registered Workspace; it does not prove the Agent created it. A privileged same-device bind mount can evade the no-cross-device approximation and is outside the supported non-privileged threat model. Custom/non-local filesystem backends are unsupported for this tool.

Upload and reply are separate external writes with no transaction, uploaded-object deletion, or state rollback. Each phase is attempted once with no fallback. A successful upload followed by stale authority leaves a possible platform orphan; a reply timeout, abort, crash, or malformed acknowledgement means delivery may be unknown. Neither outcome is retried automatically. Report any path that sends before the Lark approval audit is durable, changes destination, falls back to chat creation, repeats an external write, or exposes an absolute path, platform key, destination/message identifier, file bytes, credential, or raw filesystem/SDK cause in tool content, Session result metadata, logs, receipts, bindings, or Cards. The model-authored relative path is already part of the ordinary `tool/call` transcript, and the approval Card intentionally shows its validated basename/type/size.

## Proactive notification boundary

Proactive delivery is disabled by default. Enabling it exposes one Agent-scoped tool, not a generic destination API. The tool accepts no chat, user, message, or receive ID from model output. Mentions are a bounded list of the token `initiator`; the initiating user's platform ID is resolved only from the conversation already registered by an authorized inbound turn. Web-originated, nested, and route-less calls fail closed.

The `lark_notify` sidecar hashes storage keys. Destination rows store the chat/user/message IDs required to deliver after restart—the same class of necessary platform identifiers as selected model route IDs. Outbox rows store kind, a bounded summary, mention tokens, retry/expiry, and terminal status. Report any path that accepts a model-supplied destination, retries a delivered idempotency key, or exposes destination IDs in tool results, logs, receipts, or Cards beyond the required `@` mention on the delivered card. A successful platform write followed by a crash before the outbox is marked delivered is recovered as pending and retried with the same idempotency key so the platform can deduplicate.

## Card shutdown boundary

Graceful shutdown makes a bounded attempt to remove live Stop authority from every known running execution Card before the Lark REST client closes. Ordinary Card writes use per-turn cancellation, and one dedicated terminal PATCH has a two-second whole-chain deadline. That PATCH contains a fixed statement that live execution was interrupted and the durable result is unconfirmed; it does not create a Session result, send a partial answer, or grant a pending tool approval.

Platform writes are not transactional with Session persistence. A hard crash, forced shutdown, ambiguous Card create before its message ID is returned, ambiguous PATCH, or a custom client that ignores cancellation can still leave a stale Card. Treat a Card that remains Running after its process exits as untrusted presentation state, not proof that a turn is live or complete. Report any path that preserves an actionable Stop/approval control after a confirmed graceful close, leaks Card/prompt identifiers in shutdown diagnostics, or sends partial output as a final answer.
