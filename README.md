# dsh-plugin-lark

English | [简体中文](./README.zh-CN.md)

Feishu/Lark long-connection bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Incoming text becomes an agent follow-up; each turn, tool lifecycle, and approval is rendered back into the originating chat with Card 2.0.

## Features

- **No inbound public endpoint:** receives Feishu/Lark events through the official SDK WebSocket long connection.
- **Isolated, resumable conversations:** direct chats, group reply trees, and native threads keep separate durable Harness sessions; an explicit global session remains available when desired.
- **Live execution cards:** streams reasoning, todos, retries, compaction, hooks, workflows, tool calls, results, token usage, and the final answer into one bounded Card 2.0 message.
- **Safe tool approval and cancellation:** approval and stop actions are bound to the originating session, chat, and user, with stale or cross-chat actions failing closed.
- **Reliable reply delivery:** keeps cards and fallbacks attached to the triggering message or native thread, continues long answers in full, and durably suppresses normal WebSocket redelivery duplicates.
- **Bounded process residency:** releases durably checkpointed least-recently-used idle Agents and cold-resumes their exact session without deleting transcripts.
- **Localized and observable:** includes `zh-CN` and `en-US` UI copy plus an optional, sanitized WebSocket readiness endpoint.
- **Fail-closed boundaries:** authorization defaults to deny, Lark app credentials stay launch-environment-only, non-text payloads are never ingested, and approval failures never grant access.

## Requirements

- Node.js 22 or newer
- DeepSeek Harness `0.1.0-rc.6` compatible packages
- A durable `storageDomain` service; the stock Web profile supplies its JSON-backed storage stack
- A self-built Feishu or Lark app with a bot

## Install

Clone the repository, build it, and add the checkout to a Harness profile:

```sh
git clone https://github.com/LPX-E5BD8/dsh-plugin-lark.git
cd dsh-plugin-lark
npm ci --ignore-scripts
npm run build
dsh plugin --profile web add .
```

Keep the checkout in place while the profile uses it. An npm registry release is not required.

In the Feishu/Lark developer console:

1. Select **long connection** for event delivery.
2. Subscribe to `im.message.receive_v1`.
3. Register the `card.action.trigger` callback.
4. Grant the bot `im:message` send/receive access.
5. Optionally grant `im:resource` to enable the bundled animated loading indicator; without it, the card uses a static icon.

## Run

Start DSH from the project that the Lark Agent should work on:

```sh
cd /path/to/target-project
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
dsh --profile web --host 127.0.0.1 --port 3080
```

The invocation directory becomes the workspace for each fresh Lark session. A persisted session resumes its stored workspace instead. Until conversation-level project switching is available, changing a conversation's project requires restarting DSH from the new directory and then using `/new` in that conversation. Binding the Web UI beyond loopback is deployment-specific; Feishu/Lark event delivery itself uses the outbound long connection and needs no inbound public listener.

## Credentials

The plugin reads app credentials only from environment variables. It does not accept them in plugin config.

```sh
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
```

These `DSH_*` values must be inherited by the DSH launch process. DSH `0.1.0-rc.6` rejects `DSH_*` entries in both the invocation directory's `.env` and `$DSH_HOME/.env`; export them in the launching shell or inject them through the service/container environment. `FEISHU_APP_SECRET` remains a launch-environment-only fallback for existing deployments.

Model credentials belong to the Harness provider rather than this plugin. For the default provider, use the Web profile's Models page or store the following mapping in `$DSH_HOME/.credentials.yaml` with file mode `0600`:

```yaml
DEEPSEEK_API_KEY: <provider-api-key>
```

For a per-run override, export it before starting DSH:

```sh
export DEEPSEEK_API_KEY='<provider-api-key>'
```

With the stock Web profile, each request resolves this key in order from the inherited launch environment, managed `.credentials.yaml`, invocation-directory `.env`, then `$DSH_HOME/.env`. The two `.env` layers are accepted as lower-priority fallbacks for this provider key, but all secret-bearing files must remain untracked. Never put a resolved key in `cordis.patch.yml` or commit it.

See [SMOKE_TESTS.md](./SMOKE_TESTS.md) for the repeatable credential-backed Feishu and Lark release checks.

## Config

The bundled Cordis patch uses these defaults:

```yaml
- id: lark
  name: dsh-plugin-lark
  config:
    domain: feishu               # feishu / lark
    locale: zh-CN                # zh-CN / en-US
    allowAllUsers: false
    allowFrom: []                # authorized Feishu/Lark open_id values
    defaultSessionId: ''         # empty = scoped private/group conversations
    provider: deepseek-official
    model: deepseek-v4-flash
    streamUpdateIntervalMs: 1000
    maxConversationHandles: 32  # steady-state live conversation-handle target
```

`allowFrom` is fail-closed: an empty list with `allowAllUsers: false` denies everyone. Use `allowAllUsers: true` only for an intentionally public bot. Use `domain: lark` for apps hosted on `open.larksuite.com`.

The `0.1.0` release was credential-smoke-tested against Feishu. The Lark domain path uses the official SDK domain switch and automated coverage. The release runbook covers credential-backed checks for both domains; a recorded Lark run is still required before claiming that domain as credential-smoke-tested.

Leave `defaultSessionId` empty for conversation isolation. Direct chats retain the compatible `lark:<chatId>` session. In group chats, each ordinary reply tree uses its root message as a resumable scope, while each native Lark thread uses its chat and thread IDs. `parent_id` never selects a session. Set `defaultSessionId` only when every authorized direct chat, reply tree, and thread should share one Harness session.

With a Harness session-persistence backend, the bridge resumes the latest generation for the exact conversation scope after restart. `/new` and `/clear` reset only that direct chat, reply tree, or thread; with `defaultSessionId`, they intentionally reset the global shared session. An acknowledgement arrives only after the fresh generation reaches the durability checkpoint, and storage or resume failures never fall back to an empty session.

`maxConversationHandles` is the per-plugin steady-state target for live conversation handles, not a hard concurrency limit. When the total rises above the target, the bridge releases least-recently-used handles only after the conversation has no active turn, pending inbox work, or bridge-owned operation, and `sessions.flush()` confirms that a durability listener participated. The bridge never cancels or refuses those workloads merely to make room. Missing durability or a failed checkpoint keeps the handle resident and can leave the live total temporarily above the target. Once terminal cleanup starts, that retired handle is never reused; cleanup failures are logged, and later access cold-resumes the durable session.

Set `maxConversationHandles: 0` to keep no durably checkpointed idle handle warm. A later message cold-resumes the exact persisted session generation with its Agent preset and scoped tools. Eviction removes only the process-local Agent and Session; it never deletes the durable transcript. Cold resume can add latency, and custom profiles without session persistence retain their handles rather than discard conversation history.

Group sessions created before `0.3.0` were chat-wide and cannot be assigned safely to one reply root. They remain in storage for rollback or export, but `0.3.0` does not auto-attach them to a new reply-tree or thread session. Direct-chat and explicit `defaultSessionId` sessions keep their existing identities.

Successfully handled inbound messages are remembered in a durable 1,024-receipt window, so WebSocket redelivery after a normal restart does not repeat a follow-up or command. The receipt medium (normally `$DSH_HOME/storages/lark_inbound.json` in the Web profile) stores only SHA-256 digests, not plaintext app, chat, or message IDs. Custom profiles must mount the Harness storage hub, one durable KV backend, and `storage-domain` before this plugin.

Delivery remains at-least-once: a hard process failure after an external side effect but before its receipt commit can still repeat that side effect. If a receipt write fails while the window is full, an older receipt may already have been evicted; the callback still rejects, but the effective replay window can temporarily shrink. Do not share one JSON storage root between Harness processes; the backend has no cross-process writer lock. Multiple processes connected to one bot are not an exactly-once configuration even when they use separate roots.

Bridge commands: `/start` (an alias for `/help`), `/help`, `/new`, `/clear`. When the DSH command runtime is mounted, `/help` also discovers the commands available to the exact Agent. A standard DSH Base profile exposes `/compact`, `/goal`, `/permission`, and `/plan`; channel-incompatible commands are omitted.

`provider` and `model` currently come from plugin configuration; a fresh session gets the invocation directory as its workspace, while a persisted session resumes its stored workspace. Conversation-level project/workspace and provider/model switching are tracked in the roadmap and are not available in `0.6.x` yet.

## Cards and approvals

One turn owns one Card 2.0 message. Reasoning, todos, retries, compaction, hooks, nested code tools, workflows, tool calls, results, and the final answer update that card in serialized order. Streaming updates are throttled, and every payload is bounded to Lark's 28 KiB card limit. A final answer longer than the card preview is also delivered in complete, platform-sized text messages.

Command results and each turn's initial cards, approval cards, text fallbacks, and long-answer continuations reply to the Lark message that triggered them. Later card changes patch the bot message returned by that reply, so concurrent chats sharing one Harness session keep independent reply targets.

For a native Lark thread, every initial text or card reply also carries `reply_in_thread: true`, so delivery remains inside that thread. Ordinary group reply trees keep replying to the current inbound message without being converted into native threads.

The execution panel bounds visible reasoning and recent tool calls. Running cards use an animated loading indicator when `im:resource` is available, replace it with a terminal status icon on completion, and provide a stop action bound to the originating session, chat, and user. The compact footer reports elapsed time, context-window occupancy, cache hits, input, output, and reasoning usage on one line.

Ordinary replies have no attention header. Failed, blocked, cancelled, and token-limited turns use semantic headers. If Card APIs are unavailable, final assistant text still falls back to text delivery.

When `@deepseek-ai/dsh-user-approval` is mounted, protected tool calls show Allow once / Deny. A decision is bound to the originating session, chat, and user; duplicate, expired, malformed, or cross-chat actions fail closed. Cancellation and card-delivery failure also close without granting access.

Every event in the installed DSH session catalog has an explicit render, consume, or ignore policy. A dependency upgrade that adds a catalog event fails the test gate until a policy is selected. Unknown runtime extension events are warned once and ignored.

## Scope

The bridge sends only text to the Agent. Images, files, audio, and other non-text messages are classified from the platform message type, but the plugin never parses or copies their serialized content, resource keys, names, or resource metadata into its logs, storage, or Agent input. An authorized direct message, or a group message that explicitly mentions the bot, receives a generic localized text-only notice; other group attachments remain silent. This boundary requires no media-download permission.

Group messages require a bot mention or slash command. Attachment ingestion, an administration UI, and a generic card framework remain intentionally out of scope.

## Operations

When the Harness `webServer` service is mounted, the plugin registers `GET /api/lark/health` (and `HEAD` for probes). HTTP `200` means the official Lark SDK WebSocket is connected; startup, reconnecting, stopped, failed, malformed, and unavailable states return `503`. The JSON response contains only the component name, readiness, normalized connection state, reconnect count, and optional reconnect timestamps. It does not test REST permissions, the model provider, storage, or an end-to-end chat turn.

Custom headless profiles do not need `webServer`; chat operation remains available without this endpoint. Responses use `Cache-Control: no-store`, and other methods receive `405 Method Not Allowed` with `Allow: GET, HEAD`.

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for planned reliability, conversation, and release work.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm run test:pack
```

`npm run check` runs unit/integration tests, the real assembled Harness E2E, type checking, and build. `npm run test:pack` installs the generated tarball into an isolated consumer and imports its public API.

## Releases

Keep each user-facing feature in its own pull request and advance the stable version in both `package.json` and `package-lock.json`. CI rejects a pull request whose version is not newer than the latest `v*` release.

Non-draft pull requests authored by the repository owner are automatically set to rebase-merge after the required `test` check passes. The resulting `main` build tags that tested commit and creates the matching GitHub Release. Pull requests from other authors still require an explicit maintainer merge.

Auto-merge uses the repository Actions secret `AUTO_MERGE_TOKEN`, provisioned with owner `repo` and `workflow` scopes. It deliberately does not fall back to `GITHUB_TOKEN`, whose anti-recursion behavior would suppress the post-merge `main` release workflow. Rotate the secret whenever the owner token is replaced or revoked.

## License

Apache-2.0

## Security

See [SECURITY.md](./SECURITY.md) for supported versions and private vulnerability reporting.
