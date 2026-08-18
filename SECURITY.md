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

Image blocks can already exist in a Session shared with another trusted Harness surface even though this channel does not yet ingest images. Model catalogs are not capability allowlists: image history may be sent only when exact adapter metadata explicitly includes image input. The bridge keeps incompatible cold Sessions recoverable for `/model`, `/new`, `/clear`, and navigation, but rejects ordinary prompts before provider I/O. Adapter replacement after a successful check remains a fail-closed provider boundary rather than a reason to infer or cache capability indefinitely.

## Card shutdown boundary

Graceful shutdown makes a bounded attempt to remove live Stop authority from every known running execution Card before the Lark REST client closes. Ordinary Card writes use per-turn cancellation, and one dedicated terminal PATCH has a two-second whole-chain deadline. That PATCH contains a fixed statement that live execution was interrupted and the durable result is unconfirmed; it does not create a Session result, send a partial answer, or grant a pending tool approval.

Platform writes are not transactional with Session persistence. A hard crash, forced shutdown, ambiguous Card create before its message ID is returned, ambiguous PATCH, or a custom client that ignores cancellation can still leave a stale Card. Treat a Card that remains Running after its process exits as untrusted presentation state, not proof that a turn is live or complete. Report any path that preserves an actionable Stop/approval control after a confirmed graceful close, leaks Card/prompt identifiers in shutdown diagnostics, or sends partial output as a final answer.
