# Credential-backed smoke checks

Use these checks when a release changes the SDK client, authentication, event delivery, cards, or domain routing. Run a domain's full checklist before claiming that domain as credential-smoke-tested; use separate self-built apps for Feishu and Lark.

## Prepare the app

In the matching developer console (`open.feishu.cn` or `open.larksuite.com`):

1. Select long connection for event delivery.
2. Subscribe to `im.message.receive_v1`.
3. Register the `card.action.trigger` callback.
4. Grant the bot permission to receive and send messages. Grant `im:resource` only when the animated loading image is being checked.
5. Add the tester's `open_id` to a local `allowFrom` overlay. Do not use `allowAllUsers: true` for a shared or production app.

Build and install the exact checkout being tested:

```sh
npm ci --ignore-scripts
npm run check
npm run test:pack
dsh plugin --profile web add .
```

Export credentials only in the launch shell. Do not paste secrets into a patch, commit, issue, chat message, or smoke-test record.

```sh
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
export DEEPSEEK_API_KEY='<model-api-key>'
```

Create an overlay outside the checkout, such as `/tmp/dsh-lark-smoke.yml`:

```yaml
- id: lark
  config:
    domain: feishu # use lark for open.larksuite.com
    allowAllUsers: false
    allowFrom:
      - <tester-open-id>
    maxConversationHandles: 1 # exercise cold resume after idle LRU eviction
```

Start the Web profile. The Web app intentionally accepts loopback only; Feishu/Lark event delivery uses the outbound WebSocket and does not require a public HTTP listener.

```sh
dsh --profile web --patch /tmp/dsh-lark-smoke.yml --host 127.0.0.1 --port 3080
```

The startup gate passes only after both of these observations appear:

```text
dsh web: http://127.0.0.1:3080
[ws] ws client ready
```

When the Web profile is mounted, also verify the sanitized readiness response:

```sh
curl --fail-with-body http://127.0.0.1:3080/api/lark/health
curl --fail --head http://127.0.0.1:3080/api/lark/health
```

Both requests must return HTTP `200` only after the SDK WebSocket is connected. The JSON body may contain `component`, `ready`, `state`, `reconnectAttempts`, `lastAttemptAt`, and `nextAttemptAt`; it must not contain credentials, platform identifiers, message/session data, or raw errors. A headless profile has no HTTP readiness route by design.

Before exercising project switching, register at least two disposable test Workspaces in the Web profile. Their titles and contents must contain no production-sensitive information; every authorized Lark user can select every registered Workspace.

## Exercise the deployment

Perform the same checks in a direct chat on each domain:

1. Send `/help`; verify one localized help reply and the mounted Agent's compatible commands.
2. Send a task that requires a repository tool. Verify one Card 2.0 message is updated in place, shows reasoning, no more than the latest three tools, and reaches a terminal status.
3. Send `/new`, then a follow-up. Verify the acknowledgement arrives and the follow-up runs in the fresh session.
4. Trigger a protected tool when approval is mounted. Verify only the initiating user in the original chat can Allow once or Deny.
5. Request a response longer than 6,000 Unicode code points. When the model produces one, verify the card keeps a preview and subsequent text messages include the final tail without loss.
6. Stop the process cleanly and start it again. Verify the next message resumes the prior chat session with the same Agent preset and tools.
7. Send an image or file in the direct chat. Verify one generic text-only notice is returned and no attachment content appears in the Agent session or plugin logs.
8. Send `/project`; verify it marks the current Workspace, lists only registered titles and stable IDs, and reveals no absolute path. Switch by a unique title, then verify the acknowledgement, blank chat history, selected working directory, retained Agent preset/tools, and preserved old transcript. Before the first Lark prompt, create a Web session in the same Workspace and verify Web receives a different blank session and cannot write into the Lark generation. Send the first Lark turn and verify that generation becomes visible/indexed only after it is non-blank and durable. Restart while blank, then repeat after the first turn and after idle LRU eviction; every case must resume the selected project without Web history mixing.
9. While one conversation is running, verify `/project` refuses to switch it, then start a project lookup in another conversation and confirm unrelated chats still accept prompts. Force one candidate checkpoint failure and verify the old conversation remains current before and after restart; do not record the Workspace path or message contents.
10. In a disposable fault-injection run, let a `/new` or `/project` generation binding commit while suppressing its inbound receipt, restart, and redeliver the exact platform message. Verify the generation does not change and the command is acknowledged. Apply a later project mutation, redeliver the earlier message again, and verify the latest project remains current.
11. Inspect the disposable `lark_inbound.json` and `lark_conversations.json` media. Verify they contain only hashed keys/digests and minimal versioned binding data, including the opaque generation suffix—never a full plaintext app, conversation/session, chat, or message ID, Workspace path, or prompt value.

Repeat these group-chat checks:

1. Ordinary unmentioned text is ignored, while a bot mention or slash command is handled.
2. A root message and its ordinary replies retain one conversation; a second root does not inherit that context.
3. A native thread keeps command, card, approval, fallback, and long-answer delivery inside that thread.
4. `/new` in one reply tree does not reset another tree. With an explicit `defaultSessionId`, verify that the same command intentionally resets the shared session instead.
5. An unmentioned attachment stays silent; an attachment that explicitly mentions the bot receives the same generic text-only notice and is never downloaded.
6. With `maxConversationHandles: 1`, complete one turn in reply root A, then one in root B, and return to A with a question that requires A's earlier context. Verify A cold-resumes its prior history without inheriting B, losing its Agent preset or tools, duplicating the prompt, or interrupting either in-flight turn.
7. Switch the project in reply root A and verify root B and a native thread keep their own projects. With an explicit `defaultSessionId`, verify that the same command intentionally changes the globally shared session instead.

## Record and clean up

Record only sanitized facts:

- plugin version and commit;
- Harness, Node.js, and SDK versions;
- `feishu` or `lark` domain;
- UTC timestamp;
- pass/fail for startup, direct chat, group chat, cards, commands, approvals, long reply, restart, project switching, and bounded-cache cold resume;
- redacted error code and remediation when a check fails.

Never record app credentials, API keys, `open_id`, chat/message identifiers, message contents, session logs, or private filesystem paths.

After the run, stop the process, remove the local overlay, and clear the launch shell:

```sh
unset DSH_LARK_APP_ID DSH_LARK_APP_SECRET DEEPSEEK_API_KEY
```

## Common failures

- No `[ws] ws client ready` or readiness stays at `503`: confirm the app domain, long-connection mode, credentials, and event subscription. This endpoint reports SDK WebSocket state only; it does not diagnose REST permissions, model access, or storage.
- The bot receives nothing: confirm `im.message.receive_v1`, bot availability, group mentions, and the `allowFrom` entry.
- The bot receives but cannot reply: confirm message-send permissions and that the app version containing those permissions is published.
- The live conversation count remains above `maxConversationHandles`: wait for running commands and turns to become idle, then check for durability or cleanup warnings. The setting is a steady-state target; busy or non-durable handles are retained rather than cancelled or discarded.
- `/project` reports that projects are unavailable or rejects a selection: use the Web profile, confirm the Workspace is registered and its directory still exists, and use its full ID when titles are ambiguous. The command never accepts a raw path.
- `/project` says the current transcript could not be confirmed durable: the switch was rejected and the old live session remains current. Repair session persistence and retry; do not restart on the assumption that its newest tail was saved.
- `/project` or `/new` reports that a fresh session could not be started safely: the candidate was not committed and the old binding remains current. Wait for accepted work to finish, confirm both session persistence and `storage-domain` are mounted, then retry. A partially published candidate transcript is an orphan and is ignored on restart. Repeated `conversation binding write is unconfirmed` warnings instead mean that conversation is fail-stopped while the same atomic value is retried. Repair durable storage; after shutdown interrupts an ambiguous confirmation, construct a fresh Bridge and remount storage rather than restarting the old instance.
- The loading image is static: grant `im:resource` if animation is required; this cosmetic fallback does not fail the smoke run.
- A Lark app is tested with `domain: feishu` (or the reverse): fix the overlay before diagnosing credentials or permissions.
