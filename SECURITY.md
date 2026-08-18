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
