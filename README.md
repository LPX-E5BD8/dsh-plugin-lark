# dsh-plugin-lark

Feishu/Lark long-connection bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Incoming text becomes an agent follow-up; each turn, tool lifecycle, and approval is rendered back into the originating chat with Card 2.0.

## Requirements

- Node.js 22 or newer
- DeepSeek Harness `0.1.0-rc.6` compatible packages
- A self-built Feishu or Lark app with a bot

## Install

Install the published package into a Harness profile:

```sh
dsh plugin --profile web add dsh-plugin-lark
```

To test a local checkout, run `npm ci` and then install the checkout from its root:

```sh
dsh plugin --profile web add .
```

In the Feishu/Lark developer console:

1. Select **long connection** for event delivery.
2. Subscribe to `im.message.receive_v1`.
3. Register the `card.action.trigger` callback.
4. Grant the bot `im:message` send/receive access.

## Credentials

The plugin reads app credentials only from environment variables. It does not accept them in plugin config.

```sh
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
```

`FEISHU_APP_SECRET` remains an environment-only fallback for existing deployments. Local `.env*`, `.credentials.yaml`, and `.dsh/` state are ignored by Git.

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
    defaultSessionId: ''         # empty = one session per chat
    provider: deepseek-official
    model: deepseek-v4-flash
    streamUpdateIntervalMs: 1000
```

`allowFrom` is fail-closed: an empty list with `allowAllUsers: false` denies everyone. Use `allowAllUsers: true` only for an intentionally public bot. Use `domain: lark` for apps hosted on `open.larksuite.com`.

Leave `defaultSessionId` empty for `lark:<chatId>` isolation. Set it only when every authorized chat should share one Harness session. With a Harness session-persistence backend, the bridge resumes the latest session generation after restart. `/new` and `/clear` acknowledge only after the fresh generation reaches the durability checkpoint; storage or resume failures never fall back to an empty session.

Commands: `/help`, `/new`, `/clear`.

## Cards and approvals

One turn owns one Card 2.0 message. Reasoning, todos, retries, compaction, hooks, nested code tools, workflows, tool calls, results, and the final answer update that card in serialized order. Streaming updates are throttled, and every payload is bounded to Lark's 28 KiB card limit.

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

## License

Apache-2.0
