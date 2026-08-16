# dsh-plugin-lark

Feishu/Lark long-connection bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Incoming text becomes an agent follow-up; each turn, tool lifecycle, and approval is rendered back into the originating chat with Card 2.0.

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

## Credentials

The plugin reads app credentials only from environment variables. It does not accept them in plugin config.

```sh
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
```

`FEISHU_APP_SECRET` remains an environment-only fallback for existing deployments. Local `.env*`, `.credentials.yaml`, and `.dsh/` state are ignored by Git.

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
```

`allowFrom` is fail-closed: an empty list with `allowAllUsers: false` denies everyone. Use `allowAllUsers: true` only for an intentionally public bot. Use `domain: lark` for apps hosted on `open.larksuite.com`.

The `0.1.0` release was credential-smoke-tested against Feishu. The Lark domain path uses the official SDK domain switch and automated coverage. The release runbook covers credential-backed checks for both domains; a recorded Lark run is still required before claiming that domain as credential-smoke-tested.

Leave `defaultSessionId` empty for conversation isolation. Direct chats retain the compatible `lark:<chatId>` session. In group chats, each ordinary reply tree uses its root message as a resumable scope, while each native Lark thread uses its chat and thread IDs. `parent_id` never selects a session. Set `defaultSessionId` only when every authorized direct chat, reply tree, and thread should share one Harness session.

With a Harness session-persistence backend, the bridge resumes the latest generation for the exact conversation scope after restart. `/new` and `/clear` reset only that direct chat, reply tree, or thread; with `defaultSessionId`, they intentionally reset the global shared session. An acknowledgement arrives only after the fresh generation reaches the durability checkpoint, and storage or resume failures never fall back to an empty session.

Group sessions created before `0.3.0` were chat-wide and cannot be assigned safely to one reply root. They remain in storage for rollback or export, but `0.3.0` does not auto-attach them to a new reply-tree or thread session. Direct-chat and explicit `defaultSessionId` sessions keep their existing identities.

Successfully handled inbound messages are remembered in a durable 1,024-receipt window, so WebSocket redelivery after a normal restart does not repeat a follow-up or command. The receipt medium (normally `$DSH_HOME/storages/lark_inbound.json` in the Web profile) stores only SHA-256 digests, not plaintext app, chat, or message IDs. Custom profiles must mount the Harness storage hub, one durable KV backend, and `storage-domain` before this plugin.

Delivery remains at-least-once: a hard process failure after an external side effect but before its receipt commit can still repeat that side effect. If a receipt write fails while the window is full, an older receipt may already have been evicted; the callback still rejects, but the effective replay window can temporarily shrink. Do not share one JSON storage root between Harness processes; the backend has no cross-process writer lock. Multiple processes connected to one bot are not an exactly-once configuration even when they use separate roots.

Bridge commands: `/help`, `/new`, `/clear`. When the DSH command runtime is mounted, `/help` also discovers the commands available to the exact Agent. A standard DSH Base profile exposes `/compact`, `/goal`, `/permission`, and `/plan`; channel-incompatible commands are omitted.

## Cards and approvals

One turn owns one Card 2.0 message. Reasoning, todos, retries, compaction, hooks, nested code tools, workflows, tool calls, results, and the final answer update that card in serialized order. Streaming updates are throttled, and every payload is bounded to Lark's 28 KiB card limit. A final answer longer than the card preview is also delivered in complete, platform-sized text messages.

Command results and each turn's initial cards, approval cards, text fallbacks, and long-answer continuations reply to the Lark message that triggered them. Later card changes patch the bot message returned by that reply, so concurrent chats sharing one Harness session keep independent reply targets.

For a native Lark thread, every initial text or card reply also carries `reply_in_thread: true`, so delivery remains inside that thread. Ordinary group reply trees keep replying to the current inbound message without being converted into native threads.

The execution panel bounds visible reasoning and recent tool calls. Running cards use an animated loading indicator when `im:resource` is available, replace it with a terminal status icon on completion, and provide a stop action bound to the originating session, chat, and user. The compact footer reports elapsed time, context-window occupancy, cache hits, input, output, and reasoning usage on one line.

Ordinary replies have no attention header. Failed, blocked, cancelled, and token-limited turns use semantic headers. If Card APIs are unavailable, final assistant text still falls back to text delivery.

When `@deepseek-ai/dsh-user-approval` is mounted, protected tool calls show Allow once / Deny. A decision is bound to the originating session, chat, and user; duplicate, expired, malformed, or cross-chat actions fail closed. Cancellation and card-delivery failure also close without granting access.

Every event in the installed DSH session catalog has an explicit render, consume, or ignore policy. A dependency upgrade that adds a catalog event fails the test gate until a policy is selected. Unknown runtime extension events are warned once and ignored.

## Scope

The first release accepts text messages only. Group messages require a bot mention or slash command. Attachments, an administration UI, and a generic card framework are intentionally out of scope.

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
