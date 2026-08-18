# Credential-backed smoke checks

Use these checks when a release changes the SDK client, authentication, event delivery, cards, or domain routing. Run a domain's full checklist before claiming that domain as credential-smoke-tested; use separate self-built apps for Feishu and Lark.

## Prepare the app

In the matching developer console (`open.feishu.cn` or `open.larksuite.com`):

1. Select long connection for event delivery.
2. Subscribe to `im.message.receive_v1`.
3. Register the `card.action.trigger` callback.
4. Grant the bot permission to receive and send messages. Grant `im:resource` when inbound text files, inbound images, outbound artifacts, or the animated loading image are being checked.
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
    inboundTextFiles: true
    maxInboundTextFileBytes: 131072
    inboundImages: true
    maxInboundImageBytes: 5242880
    maxInboundImagePixels: 20000000
    maxConversationImages: 4
    maxConversationImageBytes: 20971520
    outboundArtifacts: true
    maxOutboundTextFileBytes: 131072
    maxOutboundImageBytes: 5242880
    maxOutboundImagePixels: 20000000
    proactiveDelivery: true
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

Before exercising inbound images, select a disposable exact model whose adapter metadata explicitly contains the `image` input modality and confirm the stock local attachment service is mounted. Use only disposable raster content: accepted bytes are retained by the attachment backend indefinitely, and content-addressed IDs expose equality to principals who can inspect the Session reference.

Before exercising outbound artifacts, use a disposable registered local Workspace and create disposable `.txt`, `.log`, `.patch`, `.diff`, `.png`, and `.jpg` files containing no secret. The relative path enters the ordinary tool-call transcript and the safe basename/type/size enter the Approval Card. A successful upload or send is an external side effect that no state snapshot can undo; use a chat where test messages and possible uploaded orphans are acceptable.

Before exercising session navigation, use only disposable prompts and registered Workspaces. `/session` can display the stored bounded Session title, and the stock title fallback can derive that title from the first words of the first human prompt. Treat the title, creation timestamp, registered Workspace title, and opaque reference as visible to every user sharing that exact conversation scope. Never put credentials, private paths, customer data, or other secrets in the test title or prompts.

Before exercising structured input, use a direct Native `ask_user_question` call under a `native` or `both` tool presentation; `run_code` nesting is intentionally unsupported on rc.6. Use disposable prompts and answers only. Questions and committed answers enter the Session transcript, while the terminal Card deliberately hides both. The CLI can trigger and inspect messages but cannot emulate a real Card form action, so submission, `form_value`, toast, and immediate raw replacement require a real Feishu/Lark client click.

## Exercise the deployment

Perform the same checks in a direct chat on each domain:

1. Send `/help`; verify one localized help reply and the mounted Agent's compatible commands.
2. Send a task that requires a repository tool. Verify one Card 2.0 message is updated in place, shows reasoning, no more than the latest three tools, and reaches a terminal status.
3. Send `/new`, then a follow-up. Verify the acknowledgement arrives and the follow-up runs in the fresh session.
4. Trigger a protected tool when approval is mounted. Verify the initial Approval Card 2.0 is accepted by the configured platform, only the initiating user in the original chat can Allow once or Deny, the callback returns the expected toast, and the decided card update succeeds. A rejected create must resolve unavailable without running the tool; a rejected update must not reverse or repeat an admitted decision. The v0.9.2 release blocker requires this path on Feishu; an international Lark claim still requires a separate Lark app and the domain's complete checklist.
5. Request a response longer than 6,000 Unicode code points. When the model produces one, verify the card keeps a preview and subsequent text messages include the final tail without loss.
6. While an ordinary execution Card is visibly running with at least one active tool or todo, stop the process cleanly exactly once. Verify the same Card becomes a control-free interrupted/cancelled terminal state before REST stops and within the five-second host grace: no Stop button, loading icon, running tool, in-progress todo, partial long-answer continuation, or fallback text may remain or be emitted. The Card must say that durable completion is unconfirmed. Start the process again and verify the next message resumes the prior chat session with the same Agent preset and tools. A hard crash, second force signal, create without a confirmed message ID, or ambiguous terminal PATCH remains outside this graceful guarantee.
7. Send one disposable UTF-8 `.txt`, `.log`, `.patch`, or `.diff` file below 128 KiB. Verify it produces one Agent turn whose input is framed as untrusted user data and whose reply targets the file message. Inspect only sanitized counters to confirm one fixed-domain resource download and no temporary file. Verify the Session transcript contains the safe basename, verified MIME, byte count, and disposable content, while plugin logs, `lark_inbound.json`, and `lark_conversations.json` contain none of the resource key, content, platform identifiers, headers, or raw SDK error. Then send an oversized file, invalid UTF-8, a path-like/hidden filename, MIME/extension mismatch, archive, active HTML/SVG, audio, and unsupported extension; each must return only a bounded localized category or generic unsupported notice and create no Agent for a fresh scope. In a controlled fixture, redeliver the same accepted event and verify it is not downloaded or submitted twice. Finally restart once with `inboundTextFiles: false` and verify even a supported file is metadata-only and never downloaded.
8. With an explicitly image-capable model selected, send one disposable static PNG and one baseline or progressive JPEG below every configured limit. Verify each image is downloaded once from its exact authenticated message, saved once, reaches the model as one image block, and replies to the image message. Inspect the Session JSONL and the local attachment store: the log must contain only a validated content-addressed reference and metadata, the stored object must be readable after restart/cold resume, and logs, receipts, bindings, replies, and JSONL must contain no platform image key, downloaded bytes/base64, backend path, header, identifier, or raw failure. A text-only, missing-modality, or missing-attachment-service fixture must reject before download. Reject APNG, MPO/concatenated JPEG, GIF, WebP, MIME mismatch, malformed, oversized, over-pixel, and aggregate-overflow fixtures without Agent admission; simultaneous chats must permit only the global slot holder to download. In a controlled save/shutdown race, wait for the non-cancellable save to settle but admit no late image block or receipt. Redelivery after a post-save follow-up failure may save the same content-addressed object again and must remain retryable. Finally restart with `inboundImages: false` and verify an image is metadata-only and never downloaded.
9. Ask the Agent to call `send_lark_artifact` for one disposable text file and one static PNG/JPEG in the exact current registered Linux Workspace. Verify the exact initiating user must Allow once on the exact confirmed Card, the approval audit becomes durable before upload, and one file/image reply lands on the triggering message or native thread. The tool result must contain only fixed confirmation—not path, basename, bytes, key, destination, or content—and no platform key/raw failure may enter logs, Session result metadata, receipts, or bindings. Deny once, then test a wrong user/chat/Card, Web-originated call, subagent/nested Code Mode, extra destination field, absolute/URL/traversal/hidden path, final/outside/hidden-canonical symlink, hardlink/FIFO/directory, changed file while approval waits, invalid UTF-8, archive, APNG/GIF/WebP, either edge above 12000 pixels, other oversize, and missing Approval/Workspace/persistence/attachment service; all must perform zero upload. Also verify a stable safe intermediate symlink inside the Workspace succeeds. In controlled fault injection, remount image validation or remove/re-register the Workspace after upload and verify zero send with a possible orphan warning; make the upload token/reply acknowledgement malformed or ambiguous and verify exactly one request, no create fallback/retry, and an unknown-outcome warning. Stop during approval/read/upload/send and verify shutdown aborts the platform signal immediately, drains admitted work, and performs no late second write. Finally restart with `outboundArtifacts: false` and verify the tool is absent.
10. Ask the Agent to call `notify_lark` with `kind: completion` and a disposable summary, then once with `kind: attention` and `mentions: ["initiator"]`. Verify each call admits without accepting a destination ID, one Card 2.0 notice replies to the originating conversation, and a repeated `idempotency_key` does not create a second platform message. Restart once with a pending/inflight item and verify it is neither dropped nor duplicated. Extra `chat_id`/`destination` fields, an unregistered/Web-originated call, and a fourth notice inside the rate window must perform zero send. Finally restart with `proactiveDelivery: false` and verify the tool is absent.
11. Send `/project`; with an empty current registration, verify the manager-only guidance points to `/project register <title>` without revealing a path. Register the active Session directory, verify the Session/Agent/model/preset/tools do not reset, and repeat with another title to confirm the existing title is not renamed. From another authorized non-manager, verify the registration is globally visible/selectable but register/remove are denied. Remove it by the full ID and verify the marker file, active Agent, cwd, binding, and transcript remain while the Session becomes ungrouped; restart, confirm the Registry stays empty and the transcript resumes, then re-register and verify a fresh ID with no inherited session index. Switch to the separately registered Workspace by unique title and verify the acknowledgement, blank chat history, selected directory, retained preset/tools, and preserved old transcript. Before the first Lark prompt, create a Web session there and verify Web receives a different blank session and cannot write into the Lark generation. Send the first Lark turn and verify that generation becomes visible/indexed only after it is non-blank and durable. Restart while blank, then repeat after the first turn and after idle LRU eviction; every case must resume the selected project without Web history mixing.
12. While one conversation is running, verify `/project` refuses to switch it, then start a project lookup in another conversation and confirm unrelated chats still accept prompts. Force one candidate checkpoint failure and verify the old conversation remains current before and after restart; do not record the Workspace path or message contents.
13. Send `/model`; verify it marks the configured or persisted current route, groups only advertised model names and IDs under live providers, bounds an oversized catalog with an explicit truncation notice, and shows no separately configured endpoint or credential material. While a turn is running and again with pending inbox work, send `/model <provider-id> <model-id>` and verify it reports busy without changing the route or Handle. Retry at true idle; verify the acknowledgement, unchanged transcript/project/preset/tools, Session ID, and Handle, then verify the next assembled model step uses the exact selected route. In a fault-injection run, admit input during the final sidecar write and verify it remains queued and uses the committed route rather than being dropped. On a disposable shared Session whose exact current surface contains an image from the Web UI, verify an exact vision-to-vision switch succeeds, text-only and missing-modality routes fail without changing the binding/ref, and a compaction replacement that shadows the image permits a later text-only switch.
14. Select the prepared adapter-resolvable but unadvertised model by its exact provider and model IDs. Verify the switch succeeds even though that model is absent from `/model`. Make one other provider's catalog lookup fail and verify usable provider groups remain selectable with only a sanitized partial-failure notice. Instrument the disposable provider or inspect sanitized request counters to confirm that listing and selection perform no model request or credential probe; the next ordinary turn must be the first provider call.
15. After selecting a model, restart the process and then force idle LRU eviction; verify `/model` reports the same route after each recovery. Run `/new`, `/clear`, and `/project` in turn and verify each fresh generation inherits that route. A fresh unrelated direct conversation must still start from its own persisted choice or the configured default rather than inheriting this switch.
16. Create at least two non-blank, durably indexed Sessions in one disposable registered Workspace, using `/new`, `/clear`, or `/project` between them. Send `/session`; when using a prepared fixture with a second page, also send `/session list 2`. Verify pages contain at most 10 entries, the persisted current Session is marked when eligible, entries are ordered deterministically, and each row contains only a bounded stored title, registered project title (or the fixed unregistered label for an eligible current Session), ISO creation time, and a full `s_` opaque reference. A title may reflect the first human prompt. The list must not expose a raw Session/app/chat/message ID, filesystem path, full prompt, assistant/tool body, endpoint, or credential. An in-memory Session that is not yet persisted need not appear.
17. Resume one historical entry with `/session resume <full reference>`. Verify the next prompt continues the selected transcript and restores its project, model, Agent preset, and scoped tools; the Session just left remains durable and can be selected later. Restart and repeat, then force LRU eviction and repeat again. A raw Session ID, title, malformed/truncated/stale reference, reference copied from another direct chat, reply root, native thread, app, or an intentionally archived, unindexed/orphaned, subagent/child, non-persisted, ambiguous-Workspace, or externally live Session must be rejected without changing the current binding. A target whose current surface contains an image must also retain an exact route that explicitly supports image input; make its adapter metadata text-only, verify resume is rejected with the old binding current, restore vision metadata, and verify a newly delivered resume succeeds. The command must never change `archivedSessionIds`, and `/session archive`, `/session unarchive`, `/session delete`, and `/session search` are unsupported.
18. Trigger one batch containing a single choice, a multiple choice, and free text. Verify the real client shows one root form, lets custom text override a single selection and supplement a multiple selection, returns the exact labels/text to the same turn, immediately shows the localized answer-received terminal state (“Answer received” / “回答已接收”), and leaves no answer, form, button, or request token in the terminal Card. Repeat with Cancel. While another question waits, verify `/new`, project, Session, and model changes report busy; then use the execution-card Stop and verify the question closes without waiting for a deliberately stalled command reply. Let one disposable question reach its 30-minute timeout, and verify the turn receives a typed timeout failure. With a fresh pending question, send exactly one SIGTERM to the stock DSH process; verify the exported plugin disposer runs and the Card becomes a control-free cancelled terminal state within the five-second host grace. Restart and verify rc.6 cold-repairs any still-open tool call as interrupted, expires the old action, and continues the Session. A second signal would force immediate exit and is not a graceful-shutdown test. Treat the answer-received state as process-local: Stop or a hard crash before `tool/result` commits may still discard that answer and require a new question.
19. In a controlled local boundary run, seed more than 10 eligible Sessions to prove pagination, more than 200 to prove candidate truncation, and more than 1,000 entries across available Workspace indexes to prove the bounded authority scan. Once that index scan is incomplete, verify all historical candidates fail closed while an otherwise eligible current Session may remain, and verify a duplicate target beyond the bound cannot be resumed. The truncation notice must say only that additional Sessions were omitted; it must not claim every omitted Session is older. An oversized missing-directory Workspace must not suppress history from an available Workspace. These high-cardinality checks may use the assembled Harness rather than sending hundreds of credential-backed platform messages.
20. In a disposable fault-injection run, let a `/new`, session resume, project switch/register/remove, or `/model` mutation commit while suppressing its inbound receipt, restart, and redeliver the exact platform message. Verify it is acknowledged without another mutation and cannot roll back a later reset or selection. Register, remove with a later message, then replay the old register and verify it cannot recreate the project. Also stop after the register/remove mutation digest commits but before the Registry call: the same message must remain suppressed under the documented at-most-once boundary, and a newly sent command must be required after inspecting `/project`.
21. Inspect the disposable `lark_inbound.json`, `lark_conversations.json`, `lark_notify.json`, and Workspace archive state. Verify app/conversation keys, mutation receipts, and notify outbox/destination keys are digests. Selected provider/model route IDs in conversation bindings, and notify destination values (`chatId`, `openId`, `lastMessageId`), are intentionally stored in plaintext because restart delivery needs them. Session references must not be persisted, and session resume must reuse schema-v2 bindings without adding a durable catalog or changing `archivedSessionIds`. Inbound receipts, conversation bindings, outbox rows, and Workspace media must never contain a prompt value, separately configured endpoint, or credential; do not encode secrets in route IDs. Session headers and transcripts have their separately documented identity/content contract and are not part of this sidecar assertion.

Repeat these group-chat checks:

1. Ordinary unmentioned text is ignored, while a bot mention or slash command is handled.
2. A root message and its ordinary replies retain one conversation; a second root does not inherit that context.
3. A native thread keeps command, card, approval, fallback, and long-answer delivery inside that thread.
4. `/new` in one reply tree does not reset another tree. With an explicit `defaultSessionId`, verify that the same command intentionally resets the shared session instead.
5. Every group attachment remains fail-closed. A normal unmentioned file or image stays silent and is never downloaded; if a controlled event fixture supplies an explicit mention on a non-text event, it receives only the generic notice and still performs no download. Credential-backed text-file and static-image success is claimed only for direct chats.
6. With `maxConversationHandles: 1`, complete one turn in reply root A, then one in root B, and return to A with a question that requires A's earlier context. Verify A cold-resumes its prior history without inheriting B, losing its Agent preset or tools, duplicating the prompt, or interrupting either in-flight turn.
7. Switch the project in reply root A and verify root B and a native thread keep their own projects. With an explicit `defaultSessionId`, verify that the same command intentionally changes the globally shared session instead.
8. Switch the model in reply root A and verify root B and a native thread keep their own routes. Confirm the group response exposes advertised provider/model display names and IDs—and the exact selected dynamic route in an acknowledgement—but never separately configured endpoints or credentials. With an explicit `defaultSessionId`, verify that the same command intentionally changes the globally shared model choice instead.
9. As a configured project manager, send project register/remove commands in a group with and without a mention. Both must return the direct-chat-only boundary and perform no Registry mutation.
10. Create separate committed Sessions in reply root A, reply root B, and a native thread. Verify each `/session` list and reference stays inside its own lineage and cannot resume either peer. With an explicit disposable `defaultSessionId`, verify the list, bounded title metadata, references, and resume choice are intentionally shared with every authorized chat using that global scope.
11. Approve one disposable outbound artifact in reply root A and one in a native thread. Verify each artifact replies only to its own triggering message/thread, another group member cannot approve it, and no model-supplied destination can redirect either upload.

## Record and clean up

Record only sanitized facts:

- plugin version and commit;
- the exact compatibility-matrix row (Harness cohort, Cordis, Schemastery, and Node.js), plus the SDK version;
- whether every resolved DSH package matched the recorded cohort;
- `feishu` or `lark` domain;
- UTC timestamp;
- pass/fail for startup, direct chat, group chat, bounded text attachments, bounded static images, approved outbound artifacts, image-history routing, cards, structured input, commands, approvals, long reply, restart, project switching, session navigation, model switching, and bounded-cache cold resume;
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
- A supported text file is rejected or never reaches the Agent: confirm `inboundTextFiles: true`, the bot's `im:resource` scope and published app version, the configured byte limit, a safe `.txt`/`.log`/`.patch`/`.diff` basename, accepted MIME, and strict UTF-8 content. Do not work around the gate with a URL, renamed archive, or raw resource API call.
- A supported image is rejected or never reaches the Agent: confirm `inboundImages: true`, `im:resource`, a mounted `attachments` service, an exact current model whose `resolveModelInfo` metadata includes `image`, a direct chat, and every byte/pixel/count/aggregate limit. Only one static PNG or baseline/progressive JPEG is accepted; do not rename APNG, MPO, GIF, WebP, an archive, or a URL to bypass the gate. A busy notice requires sending a new image message after the active slot or Agent work finishes.
- `send_lark_artifact` is absent or refuses a file: confirm the host is Linux (the tool is not registered elsewhere), `outboundArtifacts: true`, `im:resource`, the stock local Workspace/Approval/Session-persistence/attachment services, one currently registered Workspace whose canonical path equals the Agent cwd, a safe supported relative path, and the configured limits. Only the initiating Lark user on the exact approval Card can grant one send. After an upload-or-delivery unknown warning, inspect the chat manually and do not retry automatically; an orphaned upload has no channel-side delete API.
- `notify_lark` is absent or refuses a send: confirm `proactiveDelivery: true`, a prior authorized inbound in this conversation registered the destination, and the call used only `kind`/`summary`/`mentions`/`idempotency_key`. Extra destination IDs are rejected. After a rate-limit or unknown-delivery warning, inspect the chat and do not mint a new idempotency key for the same notice.
- The live conversation count remains above `maxConversationHandles`: wait for running commands and turns to become idle, then check for durability or cleanup warnings. The setting is a steady-state target; busy or non-durable handles are retained rather than cancelled or discarded.
- `/project` reports that projects are unavailable or rejects a selection: use the Web profile, confirm the Workspace is registered and its directory still exists, and use its full ID when titles are ambiguous. The command never accepts a raw path.
- Project registration management is unavailable: confirm the sender passes ordinary authorization and appears in `projectManageFrom`, the command is a direct message, the active Session cwd is an existing directory, and the mutable Registry exposes `create`, `delete`, and `resolveByPath`. After an ambiguous Registry mutation, remount the Workspace service before retrying; never infer success from a stale in-memory list.
- `/project` says the current transcript could not be confirmed durable: the switch was rejected and the old live session remains current. Repair session persistence and retry; do not restart on the assumption that its newest tail was saved.
- `/project` or `/new` reports that a fresh session could not be started safely: the candidate was not committed and the old binding remains current. Wait for accepted work to finish, confirm both session persistence and `storage-domain` are mounted, then retry. A partially published candidate transcript is an orphan and is ignored on restart. Repeated `conversation binding write is unconfirmed` warnings instead mean that conversation is fail-stopped while the same atomic value is retried. Repair durable storage; after shutdown interrupts an ambiguous confirmation, construct a fresh Bridge and remount storage rather than restarting the old instance.
- `/session` is unavailable or omits expected history: confirm `sessionQuery`, session persistence, and the Workspace Registry are mounted. Historical candidates must be persisted, top-level, unarchived, not externally live, and uniquely indexed by an available registered Workspace in the exact app/conversation lineage. The current Session may be shown with a fixed unregistered-project label, but historical unregistered Sessions are not resumable. Re-run `/session` after fixing the services; never substitute a raw Session ID or edit the binding/archive files.
- `/model` cannot list or resolve a route: confirm the Harness LLM service and intended provider adapter are mounted, then copy the exact provider and model IDs. Catalog membership is advisory, so an exact dynamic model can still resolve; a provider that is absent or rejects the exact model cannot. A successful switch does not test credentials or provider reachability, so diagnose authentication, quota, endpoint, and upstream failures from the first later model turn instead.
- A prompt or Session resume says image-history compatibility cannot be confirmed: keep the current binding, confirm `llm.resolveModelInfo` is available for the exact persisted provider/model route, and require `inputModalities` to explicitly contain `image`. Do not infer capability from `/model` catalog membership or a model name. `/model` to a confirmed vision route, or `/new`/`/clear` to an image-free generation, remains the recovery path.
- The loading image is static: grant `im:resource` if animation is required; this cosmetic fallback does not fail the smoke run.
- A Lark app is tested with `domain: feishu` (or the reverse): fix the overlay before diagnosing credentials or permissions.
