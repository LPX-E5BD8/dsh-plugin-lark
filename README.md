# dsh-plugin-lark

English | [简体中文](./README.zh-CN.md)

Feishu/Lark long-connection bridge for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Incoming text becomes an agent follow-up; each turn, tool lifecycle, and approval is rendered back into the originating chat with Card 2.0.

## Features

- **No inbound public endpoint:** receives Feishu/Lark events through the official SDK WebSocket long connection.
- **Isolated, resumable conversations:** direct chats, group reply trees, and native threads keep separate durable Harness sessions; an explicit global session remains available when desired.
- **Project registration and selection:** project managers can register the active Session directory or remove a registration from a direct chat; every authorized conversation can list and select registered Workspaces without accepting arbitrary paths from chat.
- **Conversation model selection:** lists live providers and their advertised models, accepts exact adapter-resolved provider/model routes, and preserves each conversation's choice across fresh generations and recovery.
- **Live execution cards:** streams reasoning, todos, retries, compaction, hooks, workflows, tool calls, results, token usage, and the final answer into one bounded Card 2.0 message.
- **Safe tool approval and cancellation:** approval and stop actions are bound to the originating session, chat, and user, with stale or cross-chat actions failing closed.
- **Reliable reply delivery:** keeps cards and fallbacks attached to the triggering message or native thread, continues long answers in full, and durably suppresses normal WebSocket redelivery duplicates.
- **Bounded process residency:** releases durably checkpointed least-recently-used idle Agents and cold-resumes their exact session without deleting transcripts.
- **Localized and observable:** includes `zh-CN` and `en-US` UI copy plus an optional, sanitized WebSocket readiness endpoint.
- **Fail-closed boundaries:** authorization defaults to deny, Lark app credentials stay launch-environment-only, non-text payloads are never ingested, and approval failures never grant access.

## Requirements

- Node.js 22.x, or Node.js 24.x with plugin v0.8.5 or newer
- One coherent DeepSeek Harness `0.1.0-rc.6` package cohort
- The Harness `agents` and `sessions` services; the stock Web profile mounts both
- A durable `storageDomain` service; the stock Web profile supplies its JSON-backed storage stack
- A self-built Feishu or Lark app with a bot

### Supported Harness matrix

Each supported row is an exact release-tested baseline. A version accepted by a broad semver range is not automatically a supported combination.

| Plugin release | DeepSeek Harness cohort | Host libraries | Node.js | Verification |
| --- | --- | --- | --- | --- |
| `0.9.0`–`0.9.x` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Same Linux and macOS package/runtime gates as v0.8.7. v0.9.0 adds the real rc.6 Workspace Registry lifecycle; v0.9.1 adds owner-context service-dependency and first-command cold-recovery coverage. |
| `0.8.7`–`0.8.x` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Supported on GitHub-hosted Ubuntu x64. Node 22 produces the canonical archive; Node 22 and 24 run adjacent-upgrade profile gates. GitHub-hosted macOS 26 arm64 additionally verifies Node 22 and 24 package/runtime compatibility, not Web-profile deployment. |
| `0.8.6` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Same Ubuntu support; macOS 26 arm64 package/runtime evidence covers Node 22 only. |
| `0.8.5` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x`; `24.x` | Supported on GitHub-hosted Ubuntu x64. Node 22 runs the canonical release and adjacent-upgrade gate; Node 24 repeats the source/Harness and packed-consumer gates, then clean-installs the exact canonical archive into a stock rc.6 Web profile. |
| `0.8.0`–`0.8.4` | every resolved `@deepseek-ai/dsh-*` package at `0.1.0-rc.6` | Cordis `4.0.1`; Schemastery `3.18.1` | `22.x` | Supported on the original Node 22/Linux baseline; v0.8.4 adds the boot-free Web-profile package lifecycle gate. |

The required tests assemble the real rc.6 Cordis, Agent, Agent Loop, LLM, Session, JSONL persistence, JSON storage-domain, Tools, Approval, and Workspace services. Platform connection, model provider, and browser behavior use controlled doubles; project mutation also has a real Registry persistence lifecycle test. CI packs the canonical candidate on Node 22, clean-installs it into an isolated stock rc.6 Web profile, and upgrades a second isolated profile from the strictly verified v0.9.0 Release package while preserving its user patch. Both paths require the installed package version, a single bundle registration, and exactly one composed Lark configuration layer.

The profile gate also pins npm resolution to the registry snapshot immediately after the rc.6 cohort was published. Harness prerelease packages use caret ranges internally, so an exact top-level `dsh@0.1.0-rc.6` alone can otherwise drift to a later prerelease in a clean npm-exec environment; every resolved DSH package is still checked as exactly rc.6.

Starting with v0.8.5, that same Linux release gate then switches to Node 24, recreates `node_modules` with engine-strict enabled, repeats the complete source/Harness and independent packed-consumer gates, and consumes the already packed canonical candidate in an isolated stock profile. The v0.8.5 gate used a clean install because its v0.8.4 baseline supported only Node 22; starting with v0.8.6, Node 24 also verifies the adjacent upgrade from the now-compatible v0.8.5 baseline.

Starting with v0.8.6, a separate required gate runs engine-strict Node 22 on GitHub-hosted macOS 26 arm64. Starting with v0.8.7, it runs the same isolated flow for Node 22 and 24. Each runtime repeats the complete source/Harness tests, audit, and an independent packed-consumer installation, then downloads and consumes the exact Ubuntu-built canonical archive after Actions artifact-digest verification. Neither runtime runs `dsh plugin`, composes a stock Web profile, or validates app startup and stateful operations on macOS.

That Web-profile gate is deliberately boot-free: it validates package installation, upgrade, bundle resolution, and configuration composition, but does not start the Web app or exercise credentials, the SDK WebSocket connection, `/api/lark/health`, the Feishu/Lark network path, or persisted-state migration. Those remain deployment and credential-backed smoke checks.

Direct host peers are pinned to this baseline, and every DSH package in the resolved graph must stay in the same rc.6 cohort. Mixed DSH releases, Node.js 23.x or 25 and newer, Node.js 24 with plugin v0.8.4 or older, later Cordis or Schemastery releases, other Harness cohorts, Ubuntu architectures outside x64, and a host with the optional Approval service completely absent are unverified. Starting with v0.8.7, the macOS evidence is limited to macOS 26 arm64 with Node 22 or 24 package/runtime consumption; Intel Macs, other macOS releases, stock Web-profile operation, and state migration on macOS remain unverified. Alternative persistence stacks are also unverified. Custom profiles are supported only when they provide the services documented in [Config](#config); missing `agents`, `sessions`, or durable `storageDomain` support is unsupported.

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
5. Optionally grant `im:resource` to enable the bundled animated loading indicator; without it, the card uses a static icon.

## Release provenance

Starting with v0.8.3, each GitHub Release includes the exact npm-format `.tgz` that passed the packed-consumer smoke test, plus a GitHub-hosted SLSA build-provenance attestation for that file. This workflow does not publish to the npm registry, and the automatically generated **Source code** archives are not the attested package.

Download and verify a release package with GitHub CLI:

```sh
set -eu

version='0.9.1'
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
    defaultSessionId: ''         # empty = scoped private/group conversations
    provider: deepseek-official # default when the conversation has no saved choice
    model: deepseek-v4-flash    # default when the conversation has no saved choice
    streamUpdateIntervalMs: 1000
    maxConversationHandles: 32  # steady-state live conversation-handle target
```

The baseline requires `agents`, `sessions`, and durable `storageDomain` services. Durable reset, project/model selection, and cold recovery also require `sessionPersistence`; `/project` requires `workspaceRegistry`, and `/model` requires the Harness `llm` service. Approval cards and the readiness route depend on the optional `approval` and `webServer` services. The verified matrix uses the stock JSON/JSONL implementations; alternative implementations remain unverified.

`allowFrom` is fail-closed: an empty list with `allowAllUsers: false` denies everyone. Use `allowAllUsers: true` only for an intentionally public bot. Use `domain: lark` for apps hosted on `open.larksuite.com`.

`projectManageFrom` is a separate, fail-closed management allowlist and defaults to empty. A listed manager must still pass ordinary `allowFrom`/`allowAllUsers` authorization, and register/remove commands are accepted only in a direct chat. `allowAllUsers: true` never grants project-management authority. Management requires the stock mutable Workspace Registry capabilities (`create`, `delete`, and `resolveByPath`); a read-only custom Registry remains list/select-only.

The `0.1.0` release was credential-smoke-tested against Feishu. The Lark domain path uses the official SDK domain switch and automated coverage. The release runbook covers credential-backed checks for both domains; a recorded Lark run is still required before claiming that domain as credential-smoke-tested.

Leave `defaultSessionId` empty for conversation isolation. Direct chats retain the compatible `lark:<chatId>` session. In group chats, each ordinary reply tree uses its root message as a resumable scope, while each native Lark thread uses its chat and thread IDs. `parent_id` never selects a session. Set `defaultSessionId` only when every authorized direct chat, reply tree, and thread should share one Harness session, project, and model choice.

With a Harness session-persistence backend, the bridge resumes the committed generation for the exact conversation scope after restart. `/new` and `/clear` reset only that direct chat, reply tree, or thread; with `defaultSessionId`, they intentionally reset the global shared session. The bridge checkpoints the current and candidate generations, then atomically commits the exact active binding in durable storage before replying. Rejected creation or checkpoint work leaves the old binding current, and any partially published candidate is ignored as an orphan on restart. An ambiguous binding-write error fail-stops only that conversation and retries the same value until read-back confirms it, rather than reporting an uncertain result. Ordinary process-local chat with no committed binding can run without `sessionPersistence`; `/new`, `/clear`, project selection, and model selection require both session persistence and the durable conversation-binding sidecar, and cold recovery of an existing committed binding also fails closed without session persistence.

`maxConversationHandles` is the per-plugin steady-state target for live conversation handles, not a hard concurrency limit. When the total rises above the target, the bridge releases least-recently-used handles only after the conversation has no active turn, pending inbox work, or bridge-owned operation, and `sessions.flush()` confirms that a durability listener participated. The bridge never cancels or refuses those workloads merely to make room. Missing durability or a failed checkpoint keeps the handle resident and can leave the live total temporarily above the target. Once terminal cleanup starts, that retired handle is never reused; cleanup failures are logged, and later access cold-resumes the durable session.

Set `maxConversationHandles: 0` to keep no durably checkpointed idle handle warm. A later message cold-resumes the exact persisted session generation with its selected model, Agent preset, and scoped tools. Eviction removes only the process-local Agent and Session; it never deletes the durable transcript. Cold resume can add latency, and custom profiles without session persistence retain their handles rather than discard conversation history.

Group sessions created before `0.3.0` were chat-wide and cannot be assigned safely to one reply root. They remain in storage for rollback or export, but `0.3.0` does not auto-attach them to a new reply-tree or thread session. Direct-chat and explicit `defaultSessionId` sessions keep their existing identities.

Successfully handled inbound messages are remembered in a durable 1,024-receipt window, so WebSocket redelivery after a normal restart does not repeat a follow-up or command. The receipt medium (normally `$DSH_HOME/storages/lark_inbound.json` in the Web profile) stores only SHA-256 digests, not plaintext app, chat, or message IDs. The active-generation sidecar (`lark_conversations.json`) likewise hashes the app and conversation identity. Its minimal versioned value contains the generation number, suffix, optional selected provider/model IDs, and a bounded history of up to 1,024 SHA-256 message-mutation digests; that history keeps a replayed `/new`, `/clear`, `/project`, or `/model` mutation idempotent when its commit succeeded but its inbound receipt was lost. It stores no plaintext app, conversation, chat, message, filesystem identity, separately configured provider endpoint, or credential; selected route IDs are stored verbatim, so do not encode secrets in them. Custom profiles must mount the Harness storage hub, one durable KV backend, and `storage-domain` before this plugin.

Delivery remains at-least-once: a hard process failure after an external side effect but before its receipt commit can still repeat that side effect. Binding mutations are additionally protected by their per-conversation 1,024-digest history; a replay older than that bounded history can execute again. Project register/remove precommits that digest before changing the separate host Workspace domain, which prevents an old register delivery from recreating a later-removed project. This is intentionally at-most-once across the two stores: a crash after the digest commit but before the Registry call leaves no Registry effect, and the same platform message is suppressed; inspect `/project` and send a new command. If a Registry call or postcondition is ambiguous, all Lark-side Workspace mutations and attachment-index writes fail closed until the Workspace service is remounted; other host consumers enforce their own recovery policy. If a receipt write fails while the window is full, an older receipt may already have been evicted; the callback still rejects, but the effective replay window can temporarily shrink. Do not share one JSON storage root between Harness processes; the backend has no cross-process writer lock. Multiple processes connected to one bot are not an exactly-once configuration even when they use separate roots.

Bridge commands: `/start` (an alias for `/help`), `/help`, `/new`, `/clear`, `/project`, `/project [workspace title or full ID]`, `/project register <title>`, `/project remove <full ID>`, `/model`, and `/model <provider-id> <model-id>`. `/project` lists the current and available registrations without exposing filesystem paths. Registration takes its path only from the active Session header, canonicalizes it, requires an existing directory, normalizes a bounded title, and never resets or immediately indexes the Session. Re-registering the same path is idempotent and does not rename it. Removal accepts only an exact full ID and deletes only Registry metadata: the directory, files, Agent, Session, binding, and transcript remain; an active Session becomes ungrouped. Selecting one starts a blank session generation in that Workspace; the old transcript remains stored but its chat history is not carried across the project boundary. Before creating that generation, the bridge requires a confirmed checkpoint of the old transcript and then revalidates the Workspace. If either check fails, the old live binding remains unchanged. An unknown, ambiguous, missing, or unregistered Workspace is rejected without changing the current session.

When the DSH command runtime is mounted, `/help` also discovers the commands available to the exact Agent. A standard DSH Base profile exposes `/compact`, `/goal`, `/permission`, and `/plan`; channel-incompatible commands are omitted.

Project choice follows the same conversation scope as history: direct chats, group reply trees, and native threads do not affect one another, and ordinary followups in unrelated conversations remain available during a project mutation. Lark switch/register/remove mutations share one global Workspace ordering barrier; this prevents a switch/remove race from committing an invalid ordering, while network replies are sent only after releasing the barrier. The bridge claims the old Agent's true idle phase before switching. Work accepted by another surface before commit aborts the candidate; work accepted during the final atomic binding write keeps the old Handle alive until that work reaches idle. Lark reply routes bind to the claimed message identity, so a concurrent Web turn cannot consume a Lark reply target. With `defaultSessionId`, the Session and project choice are shared, but management authority is still checked from each message sender. Registry metadata is profile-global: once a manager registers a directory, every user authorized to select projects—including every user under `allowAllUsers: true`—can see its title and ID and enter that directory; `/project` can also expose those fields in a group. Removal is likewise global but is not an access revocation for already-running Agents. Custom profiles without `workspaceRegistry` or session persistence can still list an available Registry, but project selection and management fail closed.

A newly selected generation is deliberately absent from the Workspace session index while it is blank. This prevents Web **New Session** and startup selection from reusing a Lark-owned blank generation. After the first Lark `turn/start` is appended and its exact session checkpoint is confirmed, the bridge adds it to the Workspace index. A failed indexing checkpoint leaves it unindexed and retries on a later turn; restart and idle eviction preserve this boundary.

A confirmed fresh-generation checkpoint plus the atomic binding write produces the success reply. If creation, checkpointing, or revalidation fails, the bridge disposes the candidate and retains the old live and durable binding. A backend may still contain a partially published candidate transcript, but it has no commit authority and restart ignores it. If the atomic binding acknowledgement is ambiguous, the same binding value is retried without releasing that conversation until it can be read back; unrelated conversations remain available. Graceful plugin shutdown closes inbound admission, interrupts this fail-stop retry, rejects the affected platform callback, and does not commit its receipt. That Bridge instance then refuses to restart: the plugin must construct a fresh Bridge and remount storage so recovery follows the binding actually present in the sidecar. Failure to checkpoint the old transcript also rejects the switch safely.

The configured `provider` and `model` are defaults for a conversation that has no persisted model choice. `/model` reports the current route and a bounded, possibly truncated catalog grouped from live Harness providers: at most 32 providers and 128 models, with each displayed field capped at 120 Unicode code points. `/model <provider-id> <model-id>` selects that exact route without resetting the transcript, project, Agent preset, scoped tools, or live Handle. The command first claims true-idle maintenance, so work already running or pending makes it fail closed as busy. Work admitted during the final durable write remains queued. Only after the same Session is checkpointed and its route plus mutation receipt are atomically committed does the bridge update the Agent-scoped selection; prompt assembly snapshots it, so an already assembled step stays intact and the next model step uses the new route.

Harness model catalogs are advisory discovery, not routing allowlists. An exact provider/model pair can therefore select a dynamic model absent from `/model` when the live provider's adapter resolves it. Conversely, appearing in the list or resolving successfully does not prove that credentials are configured or make a test model request: provider credentials still belong to Harness, and authentication, quota, endpoint, or upstream failures surface only when a later turn calls the model.

The selected route follows the same conversation scope as history and projects. It survives a normal restart and idle LRU eviction, and `/new`, `/clear`, and `/project` carry it into the new generation. Direct chats, group reply trees, and native threads do not change one another's model; with `defaultSessionId`, the model choice is intentionally global and a switch affects every bound chat. A model switch never changes the Harness-wide default used by unrelated conversations.

In Harness rc.6, the Web model chooser does not expose a shared per-Agent selection seam. For an Agent created by this bridge, the durable Lark selection is therefore authoritative over a model selector installed later by another surface; Web prompts on that same live Session use the Lark route, while the Web chooser can temporarily display its own unconsumed choice. Do not use both model choosers for the same Session. This limitation does not affect unrelated Web sessions or change their default model.

Every authorized user can select any exact provider/model route that a mounted adapter resolves. In a group, `/model` may reveal advertised provider display names, provider IDs, model names, and model IDs to other members; a switch acknowledgement can also reveal the exact dynamic route submitted by the user. Configure and name routes accordingly. The command does not read separately configured endpoints or credentials, but user-controlled names and IDs are displayed verbatim within documented bounds.

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
