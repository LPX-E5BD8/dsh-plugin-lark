# Credential-backed smoke checks

Use these checks when a release changes the SDK client, authentication, event delivery, cards, or domain routing. Run a domain's full checklist before claiming that domain as credential-smoke-tested; use separate self-built apps for Feishu and Lark.

## Prepare the app

In the matching developer console (`open.feishu.cn` or `open.larksuite.com`):

1. Select long connection for event delivery.
2. Subscribe to `im.message.receive_v1`.
3. Register the `card.action.trigger` callback.
4. Grant the bot permission to receive and send messages. Grant `im:resource` only when the animated loading image is being checked.
5. Add the tester's `open_id` to local `allowFrom` and `projectManageFrom` overlays. Do not use `allowAllUsers: true` for a shared or production app.

Build and install the exact checkout being tested:

```sh
npm ci --ignore-scripts
npm run check
npm run test:pack
dsh plugin --profile web add .
```

When this smoke run follows an upgrade or rollback, complete the cold snapshot and state-compatibility decision in [UPGRADING.md](./UPGRADING.md) before changing the installed checkout. Do not use the smoke run itself as a backup boundary.

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
    projectManageFrom:
      - <tester-open-id>
    maxConversationHandles: 1 # exercise cold resume after idle LRU eviction
```

Start the Web profile. The Web app intentionally accepts loopback only; Feishu/Lark event delivery uses the outbound WebSocket and does not require a public HTTP listener.

```sh
dsh --profile web --patch /tmp/dsh-lark-smoke.yml --host 127.0.0.1 --port 3080
```

The Web listener still announces its loopback URL:

```text
dsh web: http://127.0.0.1:3080
```

Starting with v0.9.2, the plugin deliberately replaces the official SDK logger so raw HTTP configuration, Authorization headers, and message/Card bodies cannot escape before the plugin sanitizes a failure. Do not require the SDK's historical `[ws] ws client ready` log line. When the Web profile is mounted, use the sanitized readiness response as the connection gate:

```sh
curl --fail-with-body http://127.0.0.1:3080/api/lark/health
curl --fail --head http://127.0.0.1:3080/api/lark/health
```

Both requests must return HTTP `200` only after the SDK WebSocket is connected. The JSON body may contain `component`, `ready`, `state`, `reconnectAttempts`, `lastAttemptAt`, and `nextAttemptAt`; it must not contain credentials, platform identifiers, message/session data, or raw errors. A headless profile has no HTTP readiness route by design.

Before exercising project management, use a disposable launch directory that is not yet registered, place one marker file in it, and register one other disposable test Workspace through the Web profile. Titles and contents must contain no production-sensitive information: a Lark registration is profile-global, and every user authorized to select projects can see its title/ID and enter its directory.

Before exercising model switching, configure at least two disposable model targets. Keep their provider display names, provider IDs, model names, and model IDs free of production-sensitive information because `/model` can display them in a group. For the advisory-catalog check, prepare one exact model ID that the provider adapter can resolve but deliberately does not advertise.

## Exercise the deployment

Perform the same checks in a direct chat on each domain:

1. Send `/help`; verify one localized help reply and the mounted Agent's compatible commands.
2. Send a task that requires a repository tool. Verify one Card 2.0 message is updated in place, shows reasoning, no more than the latest three tools, and reaches a terminal status.
3. Send `/new`, then a follow-up. Verify the acknowledgement arrives and the follow-up runs in the fresh session.
4. Trigger a protected tool when approval is mounted. Verify the initial Approval Card 2.0 is accepted by the configured platform, only the initiating user in the original chat can Allow once or Deny, the callback returns the expected toast, and the decided card update succeeds. A rejected create must resolve unavailable without running the tool; a rejected update must not reverse or repeat an admitted decision. The v0.9.2 release blocker requires this path on Feishu; an international Lark claim still requires a separate Lark app and the domain's complete checklist.
5. Request a response longer than 6,000 Unicode code points. When the model produces one, verify the card keeps a preview and subsequent text messages include the final tail without loss.
6. Stop the process cleanly and start it again. Verify the next message resumes the prior chat session with the same Agent preset and tools.
7. Send an image or file in the direct chat. Verify one generic text-only notice is returned and no attachment content appears in the Agent session or plugin logs.
8. Send `/project`; with an empty current registration, verify the manager-only guidance points to `/project register <title>` without revealing a path. Register the active Session directory, verify the Session/Agent/model/preset/tools do not reset, and repeat with another title to confirm the existing title is not renamed. From another authorized non-manager, verify the registration is globally visible/selectable but register/remove are denied. Remove it by the full ID and verify the marker file, active Agent, cwd, binding, and transcript remain while the Session becomes ungrouped; restart, confirm the Registry stays empty and the transcript resumes, then re-register and verify a fresh ID with no inherited session index. Switch to the separately registered Workspace by unique title and verify the acknowledgement, blank chat history, selected directory, retained preset/tools, and preserved old transcript. Before the first Lark prompt, create a Web session there and verify Web receives a different blank session and cannot write into the Lark generation. Send the first Lark turn and verify that generation becomes visible/indexed only after it is non-blank and durable. Restart while blank, then repeat after the first turn and after idle LRU eviction; every case must resume the selected project without Web history mixing.
9. While one conversation is running, verify `/project` refuses to switch it, then start a project lookup in another conversation and confirm unrelated chats still accept prompts. Force one candidate checkpoint failure and verify the old conversation remains current before and after restart; do not record the Workspace path or message contents.
10. Send `/model`; verify it marks the configured or persisted current route, groups only advertised model names and IDs under live providers, bounds an oversized catalog with an explicit truncation notice, and shows no separately configured endpoint or credential material. While a turn is running and again with pending inbox work, send `/model <provider-id> <model-id>` and verify it reports busy without changing the route or Handle. Retry at true idle; verify the acknowledgement, unchanged transcript/project/preset/tools, Session ID, and Handle, then verify the next assembled model step uses the exact selected route. In a fault-injection run, admit input during the final sidecar write and verify it remains queued and uses the committed route rather than being dropped.
11. Select the prepared adapter-resolvable but unadvertised model by its exact provider and model IDs. Verify the switch succeeds even though that model is absent from `/model`. Make one other provider's catalog lookup fail and verify usable provider groups remain selectable with only a sanitized partial-failure notice. Instrument the disposable provider or inspect sanitized request counters to confirm that listing and selection perform no model request or credential probe; the next ordinary turn must be the first provider call.
12. After selecting a model, restart the process and then force idle LRU eviction; verify `/model` reports the same route after each recovery. Run `/new`, `/clear`, and `/project` in turn and verify each fresh generation inherits that route. A fresh unrelated direct conversation must still start from its own persisted choice or the configured default rather than inheriting this switch.
13. In a disposable fault-injection run, let a `/new`, project switch/register/remove, or `/model` mutation commit while suppressing its inbound receipt, restart, and redeliver the exact platform message. Verify it is acknowledged without another mutation. Register, remove with a later message, then replay the old register and verify it cannot recreate the project. Also stop after the register/remove mutation digest commits but before the Registry call: the same message must remain suppressed under the documented at-most-once boundary, and a newly sent command must be required after inspecting `/project`.
14. Inspect the disposable `lark_inbound.json` and `lark_conversations.json` media. Verify app/conversation keys and mutation receipts are digests while selected provider/model route IDs are intentionally stored in plaintext inside otherwise minimal versioned binding data. The media must never contain a full plaintext app, conversation/session, chat, or message ID, Workspace path, prompt value, separately configured endpoint, or credential; do not encode secrets in route IDs.

Repeat these group-chat checks:

1. Ordinary unmentioned text is ignored, while a bot mention or slash command is handled.
2. A root message and its ordinary replies retain one conversation; a second root does not inherit that context.
3. A native thread keeps command, card, approval, fallback, and long-answer delivery inside that thread.
4. `/new` in one reply tree does not reset another tree. With an explicit `defaultSessionId`, verify that the same command intentionally resets the shared session instead.
5. An unmentioned attachment stays silent; an attachment that explicitly mentions the bot receives the same generic text-only notice and is never downloaded.
6. With `maxConversationHandles: 1`, complete one turn in reply root A, then one in root B, and return to A with a question that requires A's earlier context. Verify A cold-resumes its prior history without inheriting B, losing its Agent preset or tools, duplicating the prompt, or interrupting either in-flight turn.
7. Switch the project in reply root A and verify root B and a native thread keep their own projects. With an explicit `defaultSessionId`, verify that the same command intentionally changes the globally shared session instead.
8. Switch the model in reply root A and verify root B and a native thread keep their own routes. Confirm the group response exposes advertised provider/model display names and IDs—and the exact selected dynamic route in an acknowledgement—but never separately configured endpoints or credentials. With an explicit `defaultSessionId`, verify that the same command intentionally changes the globally shared model choice instead.
9. As a configured project manager, send project register/remove commands in a group with and without a mention. Both must return the direct-chat-only boundary and perform no Registry mutation.

## Record and clean up

Record only sanitized facts:

- plugin version and commit;
- the exact compatibility-matrix row (Harness cohort, Cordis, Schemastery, and Node.js), plus the SDK version;
- whether every resolved DSH package matched the recorded cohort;
- `feishu` or `lark` domain;
- UTC timestamp;
- pass/fail for startup, direct chat, group chat, cards, commands, approvals, long reply, restart, project switching, model switching, and bounded-cache cold resume;
- redacted error code and remediation when a check fails.

Never record app credentials, API keys, `open_id`, chat/message identifiers, message contents, session logs, or private filesystem paths.

After the run, stop the process, remove the local overlay, and clear the launch shell:

```sh
unset DSH_LARK_APP_ID DSH_LARK_APP_SECRET DEEPSEEK_API_KEY
```

## Common failures

- Readiness stays at `503`: confirm the app domain, long-connection mode, credentials, and event subscription. This endpoint reports SDK WebSocket state only; it does not diagnose REST permissions, model access, or storage. On v0.9.2 and newer, the absence of the historical raw SDK ready log is intentional.
- The bot receives nothing: confirm `im.message.receive_v1`, bot availability, group mentions, and the `allowFrom` entry.
- The bot receives but cannot reply: confirm message-send permissions and that the app version containing those permissions is published.
- The live conversation count remains above `maxConversationHandles`: wait for running commands and turns to become idle, then check for durability or cleanup warnings. The setting is a steady-state target; busy or non-durable handles are retained rather than cancelled or discarded.
- `/project` reports that projects are unavailable or rejects a selection: use the Web profile, confirm the Workspace is registered and its directory still exists, and use its full ID when titles are ambiguous. The command never accepts a raw path.
- Project registration management is unavailable: confirm the sender passes ordinary authorization and appears in `projectManageFrom`, the command is a direct message, the active Session cwd is an existing directory, and the mutable Registry exposes `create`, `delete`, and `resolveByPath`. After an ambiguous Registry mutation, remount the Workspace service before retrying; never infer success from a stale in-memory list.
- `/project` says the current transcript could not be confirmed durable: the switch was rejected and the old live session remains current. Repair session persistence and retry; do not restart on the assumption that its newest tail was saved.
- `/project` or `/new` reports that a fresh session could not be started safely: the candidate was not committed and the old binding remains current. Wait for accepted work to finish, confirm both session persistence and `storage-domain` are mounted, then retry. A partially published candidate transcript is an orphan and is ignored on restart. Repeated `conversation binding write is unconfirmed` warnings instead mean that conversation is fail-stopped while the same atomic value is retried. Repair durable storage; after shutdown interrupts an ambiguous confirmation, construct a fresh Bridge and remount storage rather than restarting the old instance.
- `/model` cannot list or resolve a route: confirm the Harness LLM service and intended provider adapter are mounted, then copy the exact provider and model IDs. Catalog membership is advisory, so an exact dynamic model can still resolve; a provider that is absent or rejects the exact model cannot. A successful switch does not test credentials or provider reachability, so diagnose authentication, quota, endpoint, and upstream failures from the first later model turn instead.
- The loading image is static: grant `im:resource` if animation is required; this cosmetic fallback does not fail the smoke run.
- A Lark app is tested with `domain: feishu` (or the reverse): fix the overlay before diagnosing credentials or permissions.
