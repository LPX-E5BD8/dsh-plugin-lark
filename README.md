# dsh-plugin-lark

English | [简体中文](./README.zh-CN.md)

Feishu/Lark long-connection bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Incoming text becomes an agent follow-up; each turn, tool lifecycle, approval, and structured question is rendered back into the originating chat with Card 2.0.

## Features

- **No inbound public endpoint:** receives Feishu/Lark events through the official SDK WebSocket long connection.
- **Isolated, resumable conversations:** direct chats, group reply trees, and native threads keep separate durable Harness sessions; an explicit global session remains available when desired.
- **Bounded session navigation:** lists eligible history in the exact conversation scope with stored titles, timestamps, project labels, and opaque references, then atomically resumes one selected transcript without accepting raw Session IDs or paths.
- **Project registration and selection:** project managers can register the active Session directory or remove a registration from a direct chat; every authorized conversation can list and select registered Workspaces without accepting arbitrary paths from chat.
- **Conversation model selection:** lists live providers and their advertised models, accepts exact adapter-resolved provider/model routes, and preserves each conversation's choice across fresh generations and recovery.
- **Image-aware routing safety:** detects images on the exact compacted model surface and prevents model switches, Session resumes, or ordinary prompts from sending that history to a text-only or capability-unknown route.
- **Opt-in direct-chat images:** validates one bounded static PNG or JPEG, stores it through the Harness attachment service, and submits only its content-addressed reference to an explicitly image-capable model.
- **Structured human input:** renders the official `ask_user_question` tool as a bounded native single-choice, multiple-choice, or free-text Card and returns the authorized answer to the same running turn.
- **Opt-in direct-chat text attachments:** admits one bounded UTF-8 `.txt`, `.log`, `.patch`, or `.diff` message through strict authorization, filename, MIME, byte, and content gates, without URLs or temporary files.
- **Approved outbound Workspace artifacts:** exposes an opt-in Agent-scoped tool that can send one bounded text file or static PNG/JPEG only after the originating Lark user approves the exact live turn.
- **Reliable proactive delivery:** admits one completion or attention Card to the conversation already registered for this turn, with a durable outbox so restarts neither drop nor duplicate an admitted send.
- **Live execution cards:** streams reasoning, todos, retries, compaction, hooks, workflows, tool calls, results, token usage, and the final answer into one bounded Card 2.0 message, then makes a bounded attempt to remove live controls if service shutdown interrupts it.
- **Safe tool approval and cancellation:** approval and stop actions are bound to the originating session, chat, and user, with stale or cross-chat actions failing closed.
- **Reliable reply delivery:** keeps cards and fallbacks attached to the triggering message or native thread, continues long answers in full, and durably suppresses normal WebSocket redelivery duplicates.
- **Bounded process residency:** releases durably checkpointed least-recently-used idle Agents and cold-resumes their exact session without deleting transcripts.
- **Localized and observable:** includes `zh-CN` and `en-US` UI copy plus an optional, sanitized WebSocket readiness endpoint.
- **Operator status and diagnostics:** `/status` and `/diag` give operators a Card 2.0 snapshot of version, uptime, connection, conversation scope, project, model, and work — plus sanitized remediation — without platform IDs or secrets.
- **Conversation-scoped policy:** operators can narrow one chat or group to extra authorized users, required mentions, visible Workspaces, selectable models, and allowed approval or outbound tool classes. Local rules only intersect the global fail-closed configuration.
- **Explicit parallel tasks (optional):** `/task run` starts one bounded task with its own session, opaque reference, reply target, and lifecycle Card. Ordinary consecutive messages stay serialized and are never reinterpreted as parallel work, and two live tasks cannot claim one project unless sharing is configured.
- **Supervised runtime (optional):** claims cross-process ownership of the bot before connecting, publishes a status document an external probe can read without loading the Harness profile, and ships reviewable systemd and readiness templates.
- **Fail-closed boundaries:** authorization defaults to deny, Lark app credentials stay launch-environment-only, media ingestion is opt-in and bounded, and approval failures never grant access.

## Requirements

- Node.js 22.x, or Node.js 24.x with plugin v0.8.5 or newer
- One coherent DeepSeek Harness `0.1.0-rc.6` package cohort
- The Harness `agents` and `sessions` services; the stock Web profile mounts both
- The Harness `tools` service, Session persistence, and the compatible rc.6 `ask_user_question` definition for structured Lark input; the stock Web profile mounts them
- A durable `storageDomain` service; the stock Web profile supplies its JSON-backed storage stack
- Session navigation additionally requires `sessionPersistence`, `sessionQuery`, and `workspaceRegistry`; the stock rc.6 Web profile supplies them
- Inbound images additionally require the Harness `attachments` service; the stock rc.6 Web profile supplies its local content-addressed store
- Outbound artifacts additionally require `sessionPersistence`, `workspaceRegistry`, `approval`, `attachments` for images, and the stock local filesystem-backed Workspace runtime
- A self-built Feishu or Lark app with a bot

### Supported Harness matrix

Each supported row is an exact release-tested baseline. A version accepted by a broad semver range is not automatically a supported combination.

| Plugin release | DeepSeek Harness cohort | Host libraries | Node.js | Verification |
| --- | --- | --- | --- | --- |
| `0.9.0`–`0.9.x` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Same Linux and macOS package/runtime gates as v0.8.7. v0.9.0 adds the real rc.6 Workspace Registry lifecycle; v0.9.1 adds owner-context service-dependency and first-command cold-recovery coverage; v0.9.2 corrects Feishu Card 2.0 element compatibility and sanitizes classified SDK failures; v0.9.3 adds bounded exact-scope Session navigation; v0.9.4 adds direct Native structured human input; v0.9.5 makes Cordis own the async disposer and bounds terminal Card shutdown; v0.9.6 adds opt-in bounded inbound UTF-8 text files; v0.9.7 makes model and Session routing fail closed around image history; v0.9.8 terminalizes known running execution Cards during graceful shutdown; v0.9.9 adds opt-in bounded static inbound images; v0.9.10 adds approved outbound Workspace artifacts on the supported Linux descriptor boundary, failing closed elsewhere; v0.9.11 adds opt-in reliable notifications to a previously registered conversation; v0.9.12 makes later admits and backoff retries drain on the same process; v0.9.13 adds operator `/status` and `/diag`; v0.9.14 adds conversation-scoped policy; v0.9.15 gates Card callbacks by that policy and stops inferring bot health from a missing probe; v0.9.16 adds optional runtime supervision with cross-process channel ownership; v0.9.17 adds explicit bounded parallel tasks. |
| `0.8.7`–`0.8.x` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Supported on GitHub-hosted Ubuntu x64. Node 22 produces the canonical archive; Node 22 and 24 run adjacent-upgrade profile gates. GitHub-hosted macOS 26 arm64 additionally verifies Node 22 and 24 package/runtime compatibility, not Web-profile deployment. |
| `0.8.6` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Same Ubuntu support; macOS 26 arm64 package/runtime evidence covers Node 22 only. |
| `0.8.5` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Supported on GitHub-hosted Ubuntu x64. Node 22 runs the canonical release and adjacent-upgrade gate; Node 24 repeats the source/Harness and packed-consumer gates, then clean-installs the exact canonical archive into a stock rc.6 Web profile. |
| `0.8.0`–`0.8.4` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x` | Supported on the original Node 22/Linux baseline; v0.8.4 adds the boot-free Web-profile package lifecycle gate. |

The required tests assemble the real rc.6 Cordis, Agent, Agent Loop, LLM, Session, semantic checkpoint policy, Session Title, SQLite Session Query exact-read path, JSONL persistence, JSON storage-domain, local Attachment Store, Tools, User Questions, Approval, and Workspace services. Platform connection, model provider, and browser behavior use controlled doubles; project mutation and approved artifact delivery also have real Registry/persistence lifecycle tests. CI pins the official Lark SDK to `1.73.0`, packs the canonical candidate on Node 22, clean-installs it into an isolated stock rc.6 Web profile, and upgrades a second isolated profile from the strictly verified v0.9.12 Release package while preserving its user patch. Both paths require the installed package version, a single bundle registration, and exactly one composed Lark configuration layer.

The profile gate also pins npm resolution to the registry snapshot immediately after the rc.6 cohort was published. Harness prerelease packages use caret ranges internally, so an exact top-level `dsh@0.1.0-rc.6` alone can otherwise drift to a later prerelease in a clean npm-exec environment; every resolved DSH package is still checked as exactly rc.6.

Starting with v0.8.5, that same Linux release gate then switches to Node 24, recreates `node_modules` with engine-strict enabled, repeats the complete source/Harness and independent packed-consumer gates, and consumes the already packed canonical candidate in an isolated stock profile. The v0.8.5 gate used a clean install because its v0.8.4 baseline supported only Node 22; starting with v0.8.6, Node 24 also verifies the adjacent upgrade from the now-compatible v0.8.5 baseline.

Starting with v0.8.6, a separate required gate runs engine-strict Node 22 on GitHub-hosted macOS 26 arm64. Starting with v0.8.7, it runs the same isolated flow for Node 22 and 24. Each runtime repeats the complete source/Harness tests, audit, and an independent packed-consumer installation, then downloads and consumes the exact Ubuntu-built canonical archive after Actions artifact-digest verification. Neither runtime runs `dsh plugin`, composes a stock Web profile, or validates app startup and stateful operations on macOS.

That Web-profile gate is deliberately boot-free: it validates package installation, upgrade, bundle resolution, and configuration composition, but does not start the Web app or exercise credentials, the SDK WebSocket connection, `/api/lark/health`, the Feishu/Lark network path, or persisted-state migration. Those remain deployment and credential-backed smoke checks.

Direct host peers are pinned to this baseline, and every DSH package in the resolved graph must stay in the same rc.6 cohort. Mixed DSH releases, Node.js 23.x or 25 and newer, Node.js 24 with plugin v0.8.4 or older, later Cordis or Schemastery releases, other Harness cohorts, Ubuntu architectures outside x64, and a host with the optional Approval service completely absent are unverified. Starting with v0.8.7, the macOS evidence is limited to macOS 26 arm64 with Node 22 or 24 package/runtime consumption; Intel Macs, other macOS releases, stock Web-profile operation, and state migration on macOS remain unverified. Alternative persistence stacks are also unverified. Custom profiles are supported only when they provide the services documented in [Config](#config); missing `agents`, `sessions`, `tools`, or durable `storageDomain` support is unsupported.

## Install

Clone the repository, build it, and add the checkout to a Harness profile:

```sh
git clone https://github.com/LPX-E5BD8/dsh-plugin-lark.git
cd dsh-plugin-lark
npm ci --ignore-scripts
npm run build
dsh plugin --profile web add .
```

The `dsh plugin` installation and operational procedures in this README remain verified on the Ubuntu/Linux gate. The macOS gate verifies the packaged module only; it does not establish stock Web-profile deployment support.

Keep the checkout in place while the profile uses it. An npm registry release is not required.

Before replacing that checkout or rolling back a state-bearing release, follow the cold-snapshot and schema boundaries in [UPGRADING.md](./UPGRADING.md). A plugin downgrade is not automatically a durable-state downgrade.

In the Feishu/Lark developer console:

1. Select **long connection** for event delivery.
2. Subscribe to `im.message.receive_v1`.
3. Register the `card.action.trigger` callback.
4. Grant the bot `im:message` send/receive access.
5. Grant `im:resource` when `inboundTextFiles`, `inboundImages`, or `outboundArtifacts` is enabled. Without those features, the scope remains optional and only enables the bundled animated loading indicator; the card otherwise uses a static icon.

## Release provenance

Starting with v0.8.3, each GitHub Release includes the exact npm-format `.tgz` that passed the packed-consumer smoke test, plus a GitHub-hosted SLSA build-provenance attestation for that file. This workflow does not publish to the npm registry, and the automatically generated **Source code** archives are not the attested package.

Download and verify a release package with GitHub CLI:

```sh
set -eu

version='0.9.17'
repository='LPX-E5BD8/dsh-plugin-lark'
archive="dsh-plugin-lark-${version}.tgz"
tag="v${version}"

tag_object="$(gh api "repos/${repository}/git/ref/tags/${tag}" --jq '.object.type + ":" + .object.sha')"
object_type="${tag_object%%:*}"
object_sha="${tag_object#*:}"
if [ "$object_type" != 'tag' ]; then
  printf 'remote %s is not an annotated tag\n' "$tag" >&2
  exit 1
fi

peel_depth=0
while [ "$object_type" = 'tag' ]; do
  peel_depth=$((peel_depth + 1))
  if [ "$peel_depth" -gt 8 ]; then
    printf 'remote %s exceeds the tag peel limit\n' "$tag" >&2
    exit 1
  fi
  tag_object="$(gh api "repos/${repository}/git/tags/${object_sha}" --jq '.object.type + ":" + .object.sha')"
  object_type="${tag_object%%:*}"
  object_sha="${tag_object#*:}"
done
if [ "$object_type" != 'commit' ]; then
  printf 'remote %s resolves to %s, not a commit\n' "$tag" "$object_type" >&2
  exit 1
fi
tag_commit="$object_sha"

release_target="$(gh release view "$tag" --repo "$repository" --json targetCommitish --jq .targetCommitish)"
if [ "$release_target" != "$tag_commit" ]; then
  printf 'release target %s does not match tag commit %s\n' "$release_target" "$tag_commit" >&2
  exit 1
fi

gh release download "$tag" --repo "$repository" --pattern "$archive"
gh attestation verify "$archive" \
  --repo "$repository" \
  --signer-workflow "$repository/.github/workflows/ci.yml" \
  --source-ref refs/heads/main \
  --source-digest "$tag_commit" \
  --deny-self-hosted-runners
```

The attestation binds the archive digest to this repository, workflow, ref, and release commit. It establishes origin and integrity, not that the code or its dependencies are vulnerability-free.

## Run

Start DSH from the project that the Lark Agent should work on:

```sh
cd /path/to/target-project
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
dsh --profile web --host 127.0.0.1 --port 3080
```

The invocation directory becomes the workspace for each fresh Lark session. A persisted session resumes its stored workspace instead. `/project register <title>` can register that active Session directory, and `/project` can move one conversation to any registered Workspace. Binding the Web UI beyond loopback is deployment-specific; Feishu/Lark event delivery itself uses the outbound long connection and needs no inbound public listener.

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
    projectManageFrom: []        # open_id values allowed to register/remove in direct chats
    operatorFrom: []            # open_id values allowed to run /status, /diag, and /policy
    runtimeDir: ''               # absolute path enabling supervision; empty = off
    parallelTasks: false         # enable /task
    maxParallelTasks: 2          # live tasks per conversation
    taskWorkspaces: exclusive    # or shared, to allow one project per several tasks
    runtimeOwnerTtlMs: 30000     # ownership heartbeat budget
    defaultSessionId: ''         # empty = scoped private/group conversations
    provider: deepseek-official # default when the conversation has no saved choice
    model: deepseek-v4-flash    # default when the conversation has no saved choice
    streamUpdateIntervalMs: 1000
    maxConversationHandles: 32  # steady-state live conversation-handle target
    inboundTextFiles: false     # opt in to bounded UTF-8 text-file messages
    maxInboundTextFileBytes: 131072 # default 128 KiB; hard maximum 256 KiB
    inboundImages: false        # opt in to one static PNG/JPEG direct message
    maxInboundImageBytes: 5242880 # default/hard maximum 5 MiB
    maxInboundImagePixels: 20000000 # default/hard maximum 20M pixels
    maxConversationImages: 4   # default 4; hard maximum 20
    maxConversationImageBytes: 20971520 # default/hard maximum 20 MiB
    outboundArtifacts: false    # opt in to the approved Agent-scoped send tool
    maxOutboundTextFileBytes: 131072 # default 128 KiB; hard maximum 256 KiB
    maxOutboundImageBytes: 5242880 # default/hard maximum 5 MiB
    maxOutboundImagePixels: 20000000 # default/hard maximum 20M pixels
    proactiveDelivery: false    # opt in to durable Agent notifications
```

The baseline requires `agents`, `sessions`, `tools`, and durable `storageDomain` services. Durable reset, project/model/session selection, cold recovery, and structured Lark questions also require `sessionPersistence`; `/project` requires `workspaceRegistry`, `/session` additionally requires `sessionQuery` plus durable conversation bindings, and `/model` requires the Harness `llm` service. An image-bearing Session additionally requires that service to expose exact `resolveModelInfo` modality metadata; inbound image admission also requires a compatible `attachments` service. Either absence leaves image work fail-closed without affecting text-only Sessions. Structured input requires the exact compatible rc.6 `ask_user_question` definition to remain visible to the Agent. A missing or incompatible definition is diagnosed and delegated rather than replaced by a second provider. A missing Session Query or Workspace capability makes session navigation return an unavailable result; a plain `/session` listing does not create an Agent. Approval cards and the readiness route depend on the optional `approval` and `webServer` services. The verified matrix uses the stock JSON/JSONL, local attachment, and SQLite exact-read implementations; alternative implementations remain unverified.

`allowFrom` is fail-closed: an empty list with `allowAllUsers: false` denies everyone. Use `allowAllUsers: true` only for an intentionally public bot. Use `domain: lark` for apps hosted on `open.larksuite.com`.

`operatorFrom` is a separate, fail-closed operator allowlist and defaults to empty. Listed operators must still pass ordinary authorization. `/status`, `/diag`, and `/policy` reply with the same Card 2.0 schema as execution cards and never include credentials, chat/message/session IDs, private paths, hashes, or raw errors.

`/policy` is operator-only and persists one hashed per-chat document in the `lark_policy` storage-domain unit. One document covers a direct chat or a whole group, including every reply tree and native thread inside it, so a new thread cannot escape a narrowed group. With `defaultSessionId` set, every chat shares one conversation and therefore one policy document. A local rule can only narrow the global fail-closed configuration: extra hashed user allowlists intersect `allowFrom`, `mention always` requires a group @mention even for commands, Workspace and model lists hide disallowed names before listing or switching, and approvals/`send_lark_artifact`/`notify_lark` stay off when either the global flag or the local flag is off. Clearing a local list restores the global default; it cannot grant a globally disabled tool. A later narrowing hides a Workspace or model from listing and selection without evicting the conversation's existing choice. Operators remain able to recover a conversation they have locked down. The stored document never contains plaintext open IDs or secrets.

`parallelTasks` is off by default. When enabled, `/task run <instruction>` starts one task in its own conversation scope, with its own Session, opaque reference, reply target, and lifecycle Card; `/task`, `/task <reference>`, and `/task stop <reference>` list, inspect, and stop them. Only this vocabulary creates parallel work: an ordinary message, whatever it says, is always served by the conversation itself in order. `maxParallelTasks` bounds live tasks per conversation, and `taskWorkspaces: exclusive` refuses a second live task in a project another task already holds -- identified by the registered Workspace when there is one and otherwise by the working directory, so the guard applies before any project is registered. Set `taskWorkspaces: shared` only when concurrent writes to one directory are safe for your work. When neither a registered Workspace nor a working directory can be identified, every such task shares one claim rather than losing the guard, so an exclusive deployment runs at most one of them at a time. The stored row keeps a bounded title derived from the instruction, never the instruction body, a filesystem path, or a credential. A process that dies mid-task leaves rows that the next start retires and whose projects it frees.

`runtimeDir` is empty by default, which leaves supervision off. When it names an existing absolute directory, the plugin claims cross-process ownership of the bot there before its first connection and refuses to start while another live instance holds it, so two processes cannot serve one bot from the same host. Ownership is claimed by exclusive file creation, so a starting instance never removes another record: a live one refuses the start, and a record abandoned past `runtimeOwnerTtlMs` refuses it too, because a contender that deleted stale records would race every other contender doing the same. Clearing an abandoned record is a single-actor recovery step -- `contrib/systemd/lark-clear-stale-owner.sh`, run from `ExecStartPre` or by hand -- which refuses to touch a record whose heartbeat is still inside its ttl. An instance that loses ownership anyway stops serving instead of competing. The same directory holds a `status.json` document with the component, instance, pid, version, state, readiness, and heartbeat — no credential, platform identifier, conversation scope, or other path — so an external probe can judge the channel without loading the Harness profile graph. This bounds ownership per host directory; two deployments with separate runtime directories pointed at one bot remain an unsupported configuration. Reviewable systemd and readiness templates ship in `contrib/systemd/`.

`projectManageFrom` is a separate, fail-closed management allowlist and defaults to empty. A listed manager must still pass ordinary `allowFrom`/`allowAllUsers` authorization, and register/remove commands are accepted only in a direct chat. `allowAllUsers: true` never grants project-management authority. Management requires the stock mutable Workspace Registry capabilities (`create`, `delete`, and `resolveByPath`); a read-only custom Registry remains list/select-only.

`inboundTextFiles` is deliberately off by default. When enabled, `maxInboundTextFileBytes` accepts a positive integer up to the hard 256 KiB ceiling; its default is 128 KiB. The feature requires the bot's `im:resource` scope and accepts files only in a direct chat. Authorization, durable message deduplication, and a safe filename/extension check all run before download. The client then reads only the exact file key attached to that authenticated message from the configured Feishu/Lark OpenAPI domain, disables redirects, enforces both declared and streamed byte counts, and never accepts a URL or local path.

`inboundImages` is also deliberately off by default and direct-chat-only. Admission requires authorization, deduplication, a truly idle Agent, the single global no-wait image slot, exact `resolveModelInfo` metadata explicitly containing `image`, and a stable attachment service before download. The plugin accepts one structurally valid, single-image PNG or baseline/progressive JPEG; it rejects APNG, MPO, concatenated/trailing images, GIF, WebP, MIME mismatch, malformed structure, and limit overflow. Effective limits are the minimum of the plugin configuration and attachment-service limits. Plugin hard ceilings are 5 MiB encoded bytes, 20 million pixels, 20 images and 20 MiB across the exact current model-visible conversation; defaults are 5 MiB, 20 million pixels, four images and 20 MiB. Downloads use the authenticated message's exact image key on the fixed OpenAPI domain with redirects disabled.

`outboundArtifacts` is deliberately off by default. When enabled on the stock local Linux Web profile, the Agent-scoped `send_lark_artifact` tool accepts one bounded Workspace-relative `.txt`, `.log`, `.patch`, `.diff`, `.png`, `.jpg`, or `.jpeg` path. Text defaults to 128 KiB with a 256 KiB hard ceiling; images default to and cannot exceed 5 MiB/20 million pixels, and either image edge is capped at the platform's 12,000-pixel limit. URLs, URI schemes, absolute/traversing/backslash/hidden/reserved paths, final symlinks, intermediate symlinks that escape the Workspace or resolve through an unsafe canonical segment, hardlinks, directories, devices, FIFOs, cross-device targets, unsafe text, animation, and disguised formats fail closed. A stable intermediate symlink to a safe canonical target inside the same Workspace is allowed. The tool exists only when Approval, Session persistence, Workspace Registry, and platform upload/reply seams are mounted; Web-originated, subagent, stale-turn, and nested Code Mode calls cannot use its Lark authority.

Approval is not inferred from the generic `allowed-once` outcome alone. The exact originating Lark user must act on the exact confirmed Card in the same chat and running turn; the approval audit must then flush durably before upload. The plugin reads and hashes a descriptor-verified snapshot before approval, discards those bytes, and after approval reopens and revalidates the same root/file identities, digest, type, and limits. rc.6 cannot prove which process originally generated an ordinary Workspace file, so approval—not a “generated by Agent” claim—is the final source decision. This local descriptor boundary is verified for the supported Linux deployment; a same-device privileged bind mount is outside its non-privileged threat model. On any host without that Linux `/proc` descriptor boundary the tool is not registered and inspect/send fail closed.

`proactiveDelivery` is off by default. When enabled, the Agent-scoped `notify_lark` tool admits one completion or attention card to the conversation already registered by this Lark turn. The model cannot pass a chat, user, or message ID. Mentions are a bounded list of the token `initiator` only. Admitted items persist in a durable outbox (hashed keys; destination chat/user/message IDs stored only in the destination table) with idempotency, retry, expiry, and a per-conversation rate limit; a restart neither drops nor duplicates an already-admitted send. Scheduling stays outside the channel. Delivery uses the same Card 2.0 schema, padding, and typography as execution and approval cards.

The `0.1.0` release was credential-smoke-tested against Feishu. The Lark domain path uses the official SDK domain switch and automated coverage. The release runbook covers credential-backed checks for both domains; a recorded Lark run is still required before claiming that domain as credential-smoke-tested.

Leave `defaultSessionId` empty for conversation isolation. Direct chats retain the compatible `lark:<chatId>` session. In group chats, each ordinary reply tree uses its root message as a resumable scope, while each native Lark thread uses its chat and thread IDs. `parent_id` never selects a session. Set `defaultSessionId` only when every authorized direct chat, reply tree, and thread should share one Harness session, project, model choice, session catalog, and resume authority. In that explicit shared mode, every authorized user can see the same bounded session-title/time/project/reference metadata and can resume an eligible entry.

With a Harness session-persistence backend, the bridge resumes the committed generation for the exact conversation scope after restart. `/new` and `/clear` reset only that direct chat, reply tree, or thread; with `defaultSessionId`, they intentionally reset the global shared session. New generations and `/session resume` checkpoint the current and candidate Sessions, then atomically commit the exact active binding in durable storage before replying. Rejected creation, resume, or checkpoint work leaves the old binding current, and any partially published candidate is ignored as an orphan on restart. An ambiguous binding-write error fail-stops only that conversation and retries the same value until read-back confirms it, rather than reporting an uncertain result. Ordinary process-local chat with no committed binding can run without `sessionPersistence`; `/new`, `/clear`, project, session, and model selection require both session persistence and the durable conversation-binding sidecar, and cold recovery of an existing committed binding also fails closed without session persistence.

`maxConversationHandles` is the per-plugin steady-state target for live conversation handles, not a hard concurrency limit. When the total rises above the target, the bridge releases least-recently-used handles only after the conversation has no active turn, pending inbox work, or bridge-owned operation, and `sessions.flush()` confirms that a durability listener participated. The bridge never cancels or refuses those workloads merely to make room. Missing durability or a failed checkpoint keeps the handle resident and can leave the live total temporarily above the target. Once terminal cleanup starts, that retired handle is never reused; cleanup failures are logged, and later access cold-resumes the durable session.

Set `maxConversationHandles: 0` to keep no durably checkpointed idle handle warm. A later message cold-resumes the exact persisted session generation with its selected model, Agent preset, and scoped tools. Eviction removes only the process-local Agent and Session; it never deletes the durable transcript. Cold resume can add latency, and custom profiles without session persistence retain their handles rather than discard conversation history.

Group sessions created before `0.3.0` were chat-wide and cannot be assigned safely to one reply root. They remain in storage for rollback or export, but `0.3.0` does not auto-attach them to a new reply-tree or thread session. Direct-chat and explicit `defaultSessionId` sessions keep their existing identities.

Successfully handled inbound messages are remembered in a durable 1,024-receipt window, so WebSocket redelivery after a normal restart does not repeat a follow-up or command. The receipt medium (normally `$DSH_HOME/storages/lark_inbound.json` in the Web profile) stores only SHA-256 digests, not plaintext app, chat, or message IDs. The active-generation sidecar (`lark_conversations.json`) likewise hashes the app and conversation identity. Its minimal versioned value contains the generation number, suffix, optional selected provider/model IDs, and a bounded history of up to 1,024 SHA-256 message-mutation digests; that history keeps a replayed `/new`, `/clear`, `/project`, `/session resume`, or `/model` mutation idempotent when its commit succeeded but its inbound receipt was lost. It stores no plaintext app, conversation, chat, message, filesystem identity, separately configured provider endpoint, or credential; selected route IDs are stored verbatim, so do not encode secrets in them. Custom profiles must mount the Harness storage hub, one durable KV backend, and `storage-domain` before this plugin.

Delivery remains at-least-once: a hard process failure after an external side effect but before its receipt commit can still repeat that side effect. Binding mutations are additionally protected by their per-conversation 1,024-digest history; a replay older than that bounded history can execute again. Project register/remove precommits that digest before changing the separate host Workspace domain, which prevents an old register delivery from recreating a later-removed project. This is intentionally at-most-once across the two stores: a crash after the digest commit but before the Registry call leaves no Registry effect, and the same platform message is suppressed; inspect `/project` and send a new command. If a Registry call or postcondition is ambiguous, all Lark-side Workspace mutations and attachment-index writes fail closed until the Workspace service is remounted; other host consumers enforce their own recovery policy. If a receipt write fails while the window is full, an older receipt may already have been evicted; the callback still rejects, but the effective replay window can temporarily shrink. Do not share one JSON storage root between Harness processes; the backend has no cross-process writer lock. Multiple processes connected to one bot are not an exactly-once configuration even when they use separate roots.

Bridge commands: `/start` (an alias for `/help`), `/help`, `/new`, `/clear`, `/project`, `/project [workspace title or full ID]`, `/project register <title>`, `/project remove <full ID>`, `/session`, `/session list [page]`, `/session resume <full reference>`, `/model`, `/model <provider-id> <model-id>`, `/task`, `/task run <instruction>`, `/task <reference>`, `/task stop <reference>`, and operator-only `/status`, `/diag`, and `/policy`. Session resume never accepts a title, raw Session ID, or filesystem path. `/project` lists the current and available registrations without exposing filesystem paths. Registration takes its path only from the active Session header, canonicalizes it, requires an existing directory, normalizes a bounded title, and never resets or immediately indexes the Session. Re-registering the same path is idempotent and does not rename it. Removal accepts only an exact full ID and deletes only Registry metadata: the directory, files, Agent, Session, binding, and transcript remain; an active Session becomes ungrouped. Selecting one starts a blank session generation in that Workspace; the old transcript remains stored but its chat history is not carried across the project boundary. Before creating that generation, the bridge requires a confirmed checkpoint of the old transcript and then revalidates the Workspace. If either check fails, the old live binding remains unchanged. An unknown, ambiguous, missing, or unregistered Workspace is rejected without changing the current session.

`/session` and `/session list [page]` expose at most 200 eligible candidates, 10 per page. A row contains an opaque full reference, a stored title capped to 80 displayed Unicode code points, a project label capped to 120, and an ISO creation time when the Session timestamp is representable. The stored Session Title may be the deterministic fallback derived from the first human prompt; sanitizing and truncating it prevents platform-markup injection but is not content redaction. Everyone authorized for that exact scope can see the displayed title. The list does not include raw Session IDs, filesystem paths, complete messages, assistant answers, or tool bodies.

Historical candidates must be persisted, top-level, unarchived, detached, uniquely indexed by one currently available registered Workspace, and have a working directory that still canonicalizes to that Workspace. Orphans, blank or otherwise unindexed history, removed-Workspace history, subagents, parented/delegated Sessions, externally or bridge-retained live history, and another conversation scope are hidden. The current persisted Session is the only unindexed exception and can appear as an unregistered project; a new current Session that exists only in memory may be absent until it becomes durable. The catalog scans at most 1,000 entries across available Workspace indexes. If that authority scan would be incomplete, historical navigation fails closed and only an otherwise eligible current Session may remain visible.

The `s_…` reference is a deterministic SHA-256 label scoped to the application, exact conversation base, and Session. It remains stable across restart only while those inputs remain the same; changing the app, `defaultSessionId`, or reply-tree/thread scope makes it non-portable. It is not an authorization credential, and stale references should be replaced by running `/session` again. Resume checkpoints the old transcript, revalidates the target and Workspace, restores the target's persisted project, model, Agent preset, scoped tools, and transcript, confirms target durability, and atomically moves the existing version-2 binding with replay protection. If the target's exact compacted model surface contains an image, its persisted exact model route must explicitly advertise image input through `resolveModelInfo`; text-only, missing, malformed, or temporarily unavailable capability leaves the old binding current. Historical route recovery comes from that Session's latest request header: a model selected but never used before leaving the Session has no header snapshot there, so an image-incompatible target may require repair from the other trusted surface that wrote it. It does not copy, archive, delete, or rewrite either transcript. Work admitted before final commit aborts the Lark selection; if another surface admitted work to the resumed target, that Handle is retained until the work becomes idle and durable instead of being discarded. Work admitted during the final binding write commits forward. The selected binding survives restart and idle eviction. Archive, unarchive, delete, and search commands are not provided.

When the DSH command runtime is mounted, `/help` also discovers the commands available to the exact Agent. A standard DSH Base profile exposes `/compact`, `/goal`, `/permission`, and `/plan`; channel-incompatible commands are omitted.

Project choice follows the same conversation scope as history: direct chats, group reply trees, and native threads do not affect one another, and ordinary followups in unrelated conversations remain available during a project mutation. Lark switch/register/remove mutations share one global Workspace ordering barrier; this prevents a switch/remove race from committing an invalid ordering, while network replies are sent only after releasing the barrier. The bridge claims the old Agent's true idle phase before switching. Work accepted by another surface before commit aborts the candidate; work accepted during the final atomic binding write keeps the old Handle alive until that work reaches idle. Lark reply routes bind to the claimed message identity, so a concurrent Web turn cannot consume a Lark reply target. With `defaultSessionId`, the Session and project choice are shared, but management authority is still checked from each message sender. Registry metadata is profile-global: once a manager registers a directory, every user authorized to select projects—including every user under `allowAllUsers: true`—can see its title and ID and enter that directory; `/project` can also expose those fields in a group. Removal is likewise global but is not an access revocation for already-running Agents. Custom profiles without `workspaceRegistry` or session persistence can still list an available Registry, but project selection and management fail closed.

A newly selected generation is deliberately absent from the Workspace session index while it is blank. This prevents Web **New Session** and startup selection from reusing a Lark-owned blank generation. After the first Lark `turn/start` is appended and its exact session checkpoint is confirmed, the bridge adds it to the Workspace index. A failed indexing checkpoint leaves it unindexed and retries on a later turn; restart and idle eviction preserve this boundary.

A confirmed fresh-generation checkpoint plus the atomic binding write produces the success reply. If creation, checkpointing, or revalidation fails, the bridge disposes the candidate and retains the old live and durable binding. A backend may still contain a partially published candidate transcript, but it has no commit authority and restart ignores it. If the atomic binding acknowledgement is ambiguous, the same binding value is retried without releasing that conversation until it can be read back; unrelated conversations remain available. Graceful plugin shutdown closes inbound admission, interrupts this fail-stop retry, rejects the affected platform callback, and does not commit its receipt. That Bridge instance then refuses to restart: the plugin must construct a fresh Bridge and remount storage so recovery follows the binding actually present in the sidecar. Failure to checkpoint the old transcript also rejects the switch safely.

The configured `provider` and `model` are defaults for a conversation that has no persisted model choice. `/model` reports the current route and a bounded, possibly truncated catalog grouped from live Harness providers: at most 32 providers and 128 models, with each displayed field capped at 120 Unicode code points. `/model <provider-id> <model-id>` selects that exact route without resetting the transcript, project, Agent preset, scoped tools, or live Handle. The command first claims true-idle maintenance, so work already running or pending makes it fail closed as busy. Work admitted during the final durable write remains queued. Only after the same Session is checkpointed and its route plus mutation receipt are atomically committed does the bridge update the Agent-scoped selection; prompt assembly snapshots it, so an already assembled step stays intact and the next model step uses the new route.

When the exact current model-visible surface contains an image—including an image nested in a tool result—`/model` additionally resolves the target's exact adapter metadata and requires `inputModalities` to explicitly contain `image`. A catalog entry, model name, successful generic route resolution, or absent modality metadata never substitutes for this check. Compaction replacements are authoritative: an image shadowed off the current surface no longer constrains routing even though its immutable event remains in the log. Surface or inbox changes during capability lookup make the mutation busy; a failed or incompatible check changes neither the durable binding nor the live selection ref.

A cold Session whose current route has become text-only or capability-unknown remains recoverable rather than being made impossible to open. `/help`, `/model`, `/new`, `/clear`, and Session navigation stay available when their ordinary maintenance preconditions hold, but ordinary prompts and every dynamic runtime command are rejected before Agent/provider execution until `/model` selects an explicitly image-capable route or a fresh image-free generation is created. If cold recovery finds a durable pending inbox, reset/navigation commands remain busy; a compatible `/model` switch is allowed to commit over that unchanged queue and uses a transient wake notice that is inserted and immediately removed so pending work starts under the repaired route. A crash between binding commit and wake is eligible for repair only when the exact mutation remains the latest route change; replay first performs a detached durable-inbox preflight and attempts the repair, while a replay older than any later route never opens, wakes, or rolls anything back. If maintenance or capability inspection is temporarily unavailable, send a new `/model` command after recovery instead of relying on the old delivery to retry. The two inbox splice events are not transactional: a torn durable prefix can retain the provider-valid, fixed plugin notice, which may later enter model context but contains no user data or identifier. Exact capability metadata is a point-in-time guard, not a pinned future adapter registration: adapter replacement after commit can still make the later provider call fail closed. Input admitted by another surface during the final binding write follows the existing commit-forward boundary; the bridge cannot atomically inspect work owned by that other surface.

Harness model catalogs are advisory discovery, not routing allowlists. An exact provider/model pair can therefore select a dynamic model absent from `/model` when the live provider's adapter resolves it. Conversely, appearing in the list or resolving successfully does not prove that credentials are configured or make a test model request: provider credentials still belong to Harness, and authentication, quota, endpoint, or upstream failures surface only when a later turn calls the model.

The selected route follows the same conversation scope as history and projects. It survives a normal restart and idle LRU eviction, and `/new`, `/clear`, and `/project` carry it into the new generation. Direct chats, group reply trees, and native threads do not change one another's model; with `defaultSessionId`, the model choice is intentionally global and a switch affects every bound chat. A model switch never changes the Harness-wide default used by unrelated conversations.

In Harness rc.6, the Web model chooser does not expose a shared per-Agent selection seam. For an Agent created by this bridge, the durable Lark selection is therefore authoritative over a model selector installed later by another surface; Web prompts on that same live Session use the Lark route, while the Web chooser can temporarily display its own unconsumed choice. Do not use both model choosers for the same Session. This limitation does not affect unrelated Web sessions or change their default model.

Every authorized user can select any exact provider/model route that a mounted adapter resolves. In a group, `/model` may reveal advertised provider display names, provider IDs, model names, and model IDs to other members; a switch acknowledgement can also reveal the exact dynamic route submitted by the user. Configure and name routes accordingly. The command does not read separately configured endpoints or credentials, but user-controlled names and IDs are displayed verbatim within documented bounds.

## Cards and approvals

One turn owns one Card 2.0 message. Proactive completion and attention notices reuse that same schema, padding, and typography rather than a second card style. Reasoning, todos, retries, compaction, hooks, nested code tools, workflows, tool calls, results, and the final answer update that card in serialized order. Streaming updates are throttled, and every payload stays within the plugin's conservative 28 KiB safety budget below the platform's 30 KB cap. A final answer longer than the card preview is also delivered in complete, platform-sized text messages.

Command results and each turn's initial cards, approval cards, text fallbacks, and long-answer continuations reply to the Lark message that triggered them. Later card changes patch the bot message returned by that reply, so concurrent chats sharing one Harness session keep independent reply targets.

For a native Lark thread, every initial text or card reply also carries `reply_in_thread: true`, so delivery remains inside that thread. Ordinary group reply trees keep replying to the current inbound message without being converted into native threads.

The execution panel bounds visible reasoning and recent tool calls. Running cards use an animated loading indicator when `im:resource` is available, replace it with a terminal status icon on completion, and provide a stop action bound to the originating session, chat, and user. The compact footer reports elapsed time, context-window occupancy, cache hits, input, output, and reasoning usage on one line.

Graceful shutdown synchronously freezes every known running execution Card before Session listeners and REST delivery are removed. It aborts older Card writes, marks running tools as failed and in-progress todos as pending, removes Stop, and attempts one final PATCH behind the old delivery chain with a two-second whole-close deadline below the rc.6 five-second host grace. This Card says only that live execution was interrupted and its durable result is unconfirmed; it does not append a Session `turn/end`, send a partial long-answer continuation, or prove whether concurrent Agent teardown committed an ending. A crash, forced second signal, ambiguous create before a message ID is known, or ambiguous terminal PATCH can still leave a stale remote Card.

Ordinary replies have no attention header. Failed, blocked, cancelled, and token-limited turns use semantic headers. If Card APIs are unavailable, final assistant text still falls back to text delivery.

For a Lark-originated direct Native `ask_user_question` call, the bridge renders at most three questions in one Card: single choice, multiple choice, and bounded free text. A custom answer supplements a multiple choice and overrides a single choice. Model-authored headings, prompts, option labels, and descriptions are rendered as literal plain text, while internal option tokens keep model identifiers out of callback routing. The terminal Card contains no questions, answers, form fields, request token, or buttons. Do not enter credentials or other secrets: the tool-call questions and a successfully committed tool result become part of the Harness Session transcript.

The pending tool call is explicitly checkpointed before the question Card is sent. The 30-minute answer window starts only after Card delivery succeeds. The exact live Agent, turn, Session, conversation scope, chat, Card message, and initiating user must still match when an action arrives; first valid answer or cancellation wins. `/new`, `/clear`, project, session, and model changes stay busy while the question is pending. User cancellation, Stop, reset, delivery failure, timeout, shutdown, and restart all fail closed; immediate action responses replace the Card, with one delayed bounded PATCH as a best-effort lost-response repair. Terminal delivery is registered synchronously at settlement when the message ID is known, or immediately when a late create response supplies it; shutdown shortens its deadline to two seconds—below the rc.6 CLI's five-second whole-process grace—before REST is stopped. Because rc.6 disposes owner-bound Agent handles concurrently with the plugin, restart can still cold-repair the open tool call as interrupted even when graceful shutdown already closed the platform Card. A Web-originated turn with no claimed Lark route continues to the stock Web provider.

On Harness rc.6 this interception supports direct Native calls in `native` mode and direct Native calls in `both` mode. A nested `ask_user_question` inside `run_code` fails quickly without creating a Card: the rc.6 Code Runtime exposes no public way to pause its worker wall-clock budget while waiting for a human. Code-only presets therefore cannot use structured Lark input in this release.

“Answer received” means the running process accepted the answer; it is not a cross-crash durability receipt. Stop or root shutdown can still cancel the turn before its `tool/result` commits. A hard crash, or graceful SIGTERM after the Card closes but before that result commits, repairs the durable incomplete call as `TOOL_OUTCOME_UNKNOWN` and discards the uncommitted answer; ask again in a new or recovered turn. This boundary avoids claiming an atomic Card callback/Session commit that rc.6 does not provide.

When `@deepseek-ai/dsh-user-approval` is mounted, protected tool calls show Allow once / Deny. A decision is bound to the originating session, chat, user, and confirmed Card message; duplicate, expired, malformed, copied-Card, or cross-chat actions fail closed. Cancellation and card-delivery failure also close without granting access. The outbound-artifact tool additionally requires a Bridge-private claim from this exact Lark action, so another approval answerer cannot authorize a platform write.

Every event in the installed DSH session catalog has an explicit render, consume, or ignore policy. A dependency upgrade that adds a catalog event fails the test gate until a policy is selected. Unknown runtime extension events are warned once and ignored.

## Scope

The bridge normally sends text blocks to the Agent and can additionally submit opted-in attachment blocks. With both `inboundTextFiles` and `inboundImages` disabled, every non-text message remains a metadata-only classification: the plugin does not parse serialized platform content or retain resource keys, names, or metadata. An authorized direct message, or a group message that explicitly mentions the bot, receives a generic localized notice; other group attachments remain silent.

With `inboundTextFiles: true`, one authenticated direct-chat platform `file` message may carry `.txt`, `.log`, `.patch`, or `.diff` content. The basename is limited to 120 Unicode code points and 255 UTF-8 bytes; paths, hidden/reserved names, controls, standalone active HTML/SVG markup, binary signatures (also after one UTF-8 BOM and leading text whitespace, with PDF headers checked throughout their valid first-1,024-byte window), unsafe control/bidi content, empty files, MIME/extension mismatches, invalid UTF-8, and data above the configured limit are rejected before Agent admission. Markup in `.patch`/`.diff` is preserved as code only when a recognizable unified-diff `---`/`+++`/`@@` envelope is present. Only `text/plain`, format-specific text MIME values, or the platform's `application/octet-stream` fallback are accepted. Bytes stay in bounded memory—no temporary file or cleanup timer is created—and shutdown aborts an open stream without committing its inbound receipt.

An accepted file becomes an explicitly framed, untrusted user-data text block. Its safe basename, verified media type, byte count, and content intentionally enter the ordinary Harness Session transcript and therefore follow that backend's retention, export, fork, and access policy. They do not enter plugin logs, hashed receipt storage, conversation bindings, or error replies. The attachment path adds no platform resource key, file-message ID, sender ID, credential, raw header beyond the normalized media type, raw SDK error, or plugin/host-derived private path to the Session. The Session's pre-existing conversation identity follows the documented scope contract—compatible direct-chat Session IDs may already derive from the chat ID independently of attachments. User-supplied content itself is not redacted and may of course contain path-like text. A hard crash after Agent admission but before the receipt commit can cause platform redelivery, like any other inbound prompt.

An accepted image is durably committed through the captured attachment service before one `{ type: "image", attachment: ref }` block is admitted. The Session stores only the validated content-addressed reference, normalized PNG/JPEG type, encoded byte count, width, and height—not the platform image key, downloaded bytes/base64, backend path, header, raw SDK error, or synthesized filename. The same immutable object remains readable after cold resume and can be shared by forks. Model requests may repeatedly read and encode every image still visible after compaction, which is why both per-image and exact-surface aggregate limits are enforced.

Harness rc.6 has no attachment delete, reference count, or garbage-collection API. Published objects—including a save that becomes orphaned because shutdown, route/service mutation, a crash, follow-up failure, or receipt failure wins afterward—may be retained indefinitely. Session deletion, archival, compaction, plugin rollback, or loss of a reference does not delete the object, and the plugin must not guess that an object is unshared. `saveImage()` is non-cancellable once entered, so graceful shutdown waits for it to settle and then refuses late Session admission. Put `$DSH_HOME/attachments` (or the configured backend) under explicit capacity, access, backup, and retention policy. Content-addressed attachment IDs also reveal content equality to principals who can read Session references; missing, corrupt, or mismatched objects fail closed on later provider reads.

Outbound upload and reply are two separate platform writes with no transaction, upload deletion, or rollback. Each is attempted exactly once; artifact replies require the triggering message, preserve native-thread delivery, carry one execution-scoped UUID, and never fall back to creating a chat message. Losing route/Workspace authority after upload leaves a possible platform orphan and sends nothing. A send timeout, cancellation, malformed response, or crash can mean delivery is unknown, while a crash after confirmed delivery but before `tool/result` commits cold-repairs as `TOOL_OUTCOME_UNKNOWN`; neither case is automatically retried. Platform keys, destination/message IDs, absolute paths, file contents, credentials, and raw SDK/filesystem failures never enter tool content, plugin logs, receipts, bindings, or sidecars. The relative model-authored path already appears in the ordinary `tool/call` transcript, and the approval Card intentionally shows only its validated basename, type, and size.

URLs, archives, generic binaries, audio, video, GIF, WebP, animated/multi-image PNG/JPEG, and every inbound group image remain unsupported in v0.9.11. Group inbound attachments remain fail-closed: ordinary standalone media messages cannot carry the bot mention required by the channel, so unmentioned files stay silent and a synthetic/explicitly mentioned non-text event receives only the generic notice. Approved outbound artifacts may reply inside a group turn because the exact route and approving user remain bound. An administration UI and generic card framework remain intentionally out of scope.

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
