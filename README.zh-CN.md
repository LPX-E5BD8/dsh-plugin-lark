# dsh-plugin-lark

[English](./README.md) | 简体中文

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的飞书/Lark 长连接桥接插件。收到的文本会转为 Agent follow-up；每轮对话、工具生命周期和审批过程都会通过 Card 2.0 返回到原始会话。

## 功能概览

- **无需入站公网地址：** 通过官方 SDK 的 WebSocket 长连接接收飞书/Lark 事件。
- **隔离且可恢复的会话：** 私聊、群聊回复树和原生话题分别使用独立的持久化 Harness 会话；需要时也可显式绑定到一个全局共享会话。
- **按会话选择项目：** 仅列出 Web profile 已注册的 Workspace，在选中的项目中新建空白且可持久化的会话 generation，不接受聊天中提供的任意路径。
- **按会话选择模型：** 列出已挂载 provider 及其公布的模型，接受 adapter 可解析的精确 provider/model 路由，并在新 generation 与恢复过程中保留每个会话的选择。
- **实时执行卡片：** 将思考过程、待办、重试、上下文压缩、Hook、工作流、工具调用与结果、Token 用量和最终答案持续更新到一张有大小上限的 Card 2.0 卡片中。
- **安全的工具审批与停止：** 审批和停止操作绑定到发起它们的会话、聊天和用户；过期或跨聊天操作默认拒绝。
- **可靠的回复投递：** 卡片及降级文本始终回复触发消息或原生话题；长答案会完整续发，并通过持久化回执避免常规 WebSocket 重投造成重复执行。
- **有界的进程内驻留：** 释放已完成持久化检查点的最近最少使用空闲 Agent；再次访问时精确冷恢复原会话，且不会删除历史记录。
- **本地化与可观测性：** 内置 `zh-CN`、`en-US` 界面文案，并可选提供脱敏的 WebSocket readiness 接口。
- **失败时默认拒绝：** 授权默认拒绝、Lark 应用凭据仅允许来自启动环境、不摄入非文本内容，审批失败也绝不会放行。

## 环境要求

- Node.js 22.x，或在插件 v0.8.5 及更高版本中使用 Node.js 24.x
- 一组版本一致的 DeepSeek Harness `0.1.0-rc.6` 软件包
- 持久化的 `storageDomain` 服务；标准 Web profile 已提供基于 JSON 的完整存储栈
- 一个带机器人的飞书或 Lark 自建应用

### 支持的 Harness 兼容矩阵

下表中的支持状态只对应经过发布门禁验证的精确基线；某个版本仅仅满足宽泛的 semver 范围，并不代表该组合已受支持。

| 插件版本 | DeepSeek Harness 版本组 | 宿主库 | Node.js | 验证状态 |
| --- | --- | --- | --- | --- |
| `0.8.7`–`0.8.x` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | 支持 GitHub 托管的 Ubuntu x64。Node 22 生成 canonical archive；Node 22 与 24 都执行相邻版本升级 profile 门禁。GitHub 托管的 macOS 26 arm64 还验证 Node 22 和 24 的 package/runtime 兼容性，但不验证 Web profile 部署。 |
| `0.8.6` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | Ubuntu 支持范围相同；macOS 26 arm64 的 package/runtime 证据只覆盖 Node 22。 |
| `0.8.5` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | 支持 GitHub 托管的 Ubuntu x64。Node 22 执行 canonical Release 与相邻版本升级门禁；Node 24 重跑源码/Harness 和 packed-consumer 门禁，再把同一份 canonical archive 全新安装到标准 rc.6 Web profile。 |
| `0.8.0`–`0.8.4` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x` | 支持原有 Node 22/Linux 基线；v0.8.4 新增不启动应用的 Web profile package lifecycle 门禁。 |

必需测试会组装真实的 rc.6 Cordis、Agent、Agent Loop、LLM、Session、JSONL 持久化、JSON storage-domain、Tools 与 Approval 服务；平台连接、模型 provider、Workspace registry 和浏览器入口则使用受控替身。CI 会在 Node 22 上打出 canonical 候选包，把它全新安装到隔离的标准 rc.6 Web profile，并把第二个隔离 profile 从经过严格验证的 v0.8.6 Release package 升级到候选版本，同时保持用户 patch 不变。两条路径都必须匹配已安装 package 版本、唯一 bundle 注册和唯一组合后的 Lark 配置层。

从 v0.8.5 起，同一个 Linux Release 门禁随后会切到 Node 24，以 engine-strict 重新创建 `node_modules`，重跑完整源码/Harness 和独立 packed-consumer 门禁，再在隔离的标准 profile 中消费前面已经打好的同一份 canonical 候选包。v0.8.5 的基线 v0.8.4 只支持 Node 22，因此当时执行的是全新安装；从 v0.8.6 起，Node 24 还会验证从已经兼容的 v0.8.5 基线相邻升级。

从 v0.8.6 起，另一个必需门禁会在 GitHub 托管的 macOS 26 arm64 上运行 engine-strict Node 22；从 v0.8.7 起，同一隔离流程同时覆盖 Node 22 与 24。每条 runtime 都会重跑完整源码/Harness 测试、audit 和独立 packed-consumer 安装，然后在 Actions artifact digest 校验后下载并消费由 Ubuntu 生成的同一份 canonical archive。两条 runtime 都不会在 macOS 上执行 `dsh plugin`、组合标准 Web profile，也不验证应用启动和有状态操作。

该 Web profile 门禁刻意不启动应用：它验证 package 安装、升级、bundle 解析与配置组合，但不会启动 Web app，也不覆盖凭据、SDK WebSocket 连接、`/api/lark/health`、飞书/Lark 网络链路或持久化状态迁移；这些仍属于部署和真实凭据冒烟检查。

插件会把直接宿主 peer 固定在这组基线上，解析图中的所有 DSH 软件包也必须来自同一个 rc.6 版本组。混用 DSH 版本、Node.js 23.x 或 25 及更高版本、在 v0.8.4 及更早插件上使用 Node.js 24、更高版本的 Cordis 或 Schemastery、其他 Harness 版本组、Ubuntu x64 以外的 Ubuntu 架构，以及完全缺少可选 Approval 服务的宿主都尚未验证。从 v0.8.7 起，macOS 证据仅限 macOS 26 arm64/Node 22 或 24 的 package/runtime 消费；Intel Mac、其他 macOS 版本、标准 Web profile 运行和状态迁移仍未验证。替代持久化栈也未验证。自定义 profile 只有在提供[配置](#配置)章节所述服务时才受支持；缺少 `agents` 或持久化 `storageDomain` 明确不受支持。

## 安装

克隆仓库、构建，然后将检出目录添加到 Harness profile：

```sh
git clone https://github.com/LPX-E5BD8/dsh-plugin-lark.git
cd dsh-plugin-lark
npm ci --ignore-scripts
npm run build
dsh plugin --profile web add .
```

本 README 中的 `dsh plugin` 安装与运维流程仍只由 Ubuntu/Linux 门禁验证。macOS 门禁只验证打包模块，不代表标准 Web profile 部署已受支持。

profile 使用该插件期间请保留检出目录，无需等待 npm registry 发布。

替换该检出目录或回滚带持久化状态的版本前，请遵循 [UPGRADING.zh-CN.md](./UPGRADING.zh-CN.md) 中的冷备份流程和 schema 边界。插件代码降级并不等于持久化状态可以自动降级。

在飞书/Lark 开发者后台中：

1. 选择以**长连接**接收事件。
2. 订阅 `im.message.receive_v1`。
3. 注册 `card.action.trigger` 回调。
4. 为机器人授予 `im:message` 消息收发权限。
5. 可选授予 `im:resource`，以启用内置动态加载图；缺少该权限时卡片会使用静态图标。

## Release 来源证明

从 v0.8.3 开始，每个 GitHub Release 都会包含通过 packed-consumer 冒烟测试的同一份 npm 格式 `.tgz`，以及 GitHub 托管、针对该文件生成的 SLSA build provenance attestation。本工作流不会发布到 npm registry；GitHub 自动生成的 **Source code** 压缩包也不是被证明的 package。

可以使用 GitHub CLI 下载并验证 Release package：

```sh
set -eu

version='0.8.7'
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

该 attestation 会把压缩包 digest 绑定到本仓库、workflow、ref 与 Release commit。它证明来源和完整性，并不表示代码或依赖一定没有漏洞。

## 运行

请从 Lark Agent 要操作的目标项目目录启动 DSH：

```sh
cd /path/to/target-project
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
dsh --profile web --host 127.0.0.1 --port 3080
```

启动目录会成为每个新 Lark 会话的 workspace；持久化会话恢复时则沿用其已存储的 workspace。使用 `/project` 可以把单个会话切换到 Web profile 中已经注册的 Workspace。是否让 Web UI 监听非回环地址属于具体部署配置；飞书/Lark 事件本身通过出站长连接投递，不需要入站公网监听器。

## 凭据

插件只从环境变量读取应用凭据，不接受在插件配置中写入凭据。

```sh
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
```

这些 `DSH_*` 值必须由 DSH 启动进程继承。DSH `0.1.0-rc.6` 会拒绝调用目录 `.env` 和 `$DSH_HOME/.env` 中的所有 `DSH_*` 项；请在启动 shell 中 `export`，或通过服务管理器/容器环境注入。为兼容已有部署，`FEISHU_APP_SECRET` 仍可作为仅限启动环境的后备项。

模型凭据属于 Harness provider，不属于本插件。使用默认 provider 时，推荐通过 Web profile 的 Models 页面配置；也可以在权限为 `0600` 的 `$DSH_HOME/.credentials.yaml` 中保存以下映射：

```yaml
DEEPSEEK_API_KEY: <provider-api-key>
```

如需仅覆盖本次运行，请在启动 DSH 前导出：

```sh
export DEEPSEEK_API_KEY='<provider-api-key>'
```

标准 Web profile 每次请求按以下顺序解析该密钥：启动进程继承环境、受管 `.credentials.yaml`、调用目录 `.env`、`$DSH_HOME/.env`。后两个 `.env` 层可作为该 provider key 的低优先级后备，但所有包含密钥的文件都必须保持未跟踪状态。绝不要把解析后的密钥写入 `cordis.patch.yml` 或提交到仓库。

可重复执行的飞书和 Lark 凭据冒烟测试见 [SMOKE_TESTS.md](./SMOKE_TESTS.md)。

## 配置

仓库内置 Cordis patch 的默认值如下：

```yaml
- id: lark
  name: dsh-plugin-lark
  config:
    domain: feishu               # feishu / lark
    locale: zh-CN                # zh-CN / en-US
    allowAllUsers: false
    allowFrom: []                # 已授权的飞书/Lark open_id
    defaultSessionId: ''         # 留空 = 按私聊/群聊范围隔离
    provider: deepseek-official # 会话没有已保存选择时的默认 provider
    model: deepseek-v4-flash    # 会话没有已保存选择时的默认 model
    streamUpdateIntervalMs: 1000
    maxConversationHandles: 32  # 进程内活跃会话句柄的稳态目标
```

这组基线要求宿主提供 `agents` 和持久化 `storageDomain` 服务。需要持久化的重置、项目/模型选择与冷恢复还要求 `sessionPersistence`；`/project` 依赖 `workspaceRegistry`，`/model` 依赖 Harness `llm` 服务。审批卡片和 readiness 路由分别依赖可选的 `approval` 与 `webServer` 服务。已验证矩阵使用标准 JSON/JSONL 实现，替代实现仍未验证。

`allowFrom` 默认拒绝：当列表为空且 `allowAllUsers: false` 时，所有用户都无权访问。仅当机器人明确需要公开使用时才设置 `allowAllUsers: true`。托管在 `open.larksuite.com` 的应用应使用 `domain: lark`。

`0.1.0` 已使用真实飞书凭据完成冒烟测试。Lark 域名路径通过官方 SDK 的域名切换和自动化测试覆盖；在宣称 Lark 已完成真实凭据测试前，仍需按发布手册记录一次 Lark 实测。

保持 `defaultSessionId` 为空即可隔离会话。私聊沿用兼容的 `lark:<chatId>` 会话；在群聊中，普通回复树按根消息划分可恢复范围，原生 Lark 话题则按聊天 ID 和话题 ID 划分。`parent_id` 不会用于选择会话。仅当所有已授权私聊、回复树和话题都应共享同一个 Harness 会话、项目和模型选择时，才设置 `defaultSessionId`。

存在 Harness 会话持久化后端时，桥接器会在重启后恢复精确会话范围中已提交的 generation。`/new` 和 `/clear` 只重置当前私聊、回复树或话题；配置了 `defaultSessionId` 时，它们会有意重置全局共享会话。桥接器先分别确认当前 generation 和候选 generation 的检查点，再把精确的活跃绑定原子提交到持久化存储，然后才回复。创建或检查点工作被拒绝时，旧绑定仍保持当前状态；后端中可能已部分发布的候选只会成为 orphan，重启时会被忽略。绑定写入出现歧义错误时，只会 fail-stop 当前会话并持续重试同一个值，直到读回确认，而不会报告不确定结果。尚无已提交绑定的普通进程内聊天可以在没有 `sessionPersistence` 时运行；`/new`、`/clear`、项目选择和模型选择都要求会话持久化与持久化会话绑定 sidecar 同时可用，已有提交绑定的会话在冷恢复时缺少会话持久化也会默认拒绝。

`maxConversationHandles` 是单个插件实例中活跃会话句柄数量的稳态目标，并非硬并发上限。数量超出目标后，桥接器仅在会话没有活跃 turn、待处理 inbox 工作或桥接器操作，且 `sessions.flush()` 确认有持久化监听器参与后，才释放最近最少使用的句柄。它不会为了腾出空间取消或拒绝这些工作。缺少持久化或检查点失败时会保留句柄，因此活跃数量可以暂时高于目标。一旦终止清理开始，已退役句柄不会被重新使用；清理失败会记录日志，之后的访问会从持久化会话冷恢复。

设置 `maxConversationHandles: 0` 后，不会让任何已完成持久化检查点的空闲句柄保持热状态。下次收到消息时，会精确恢复对应 generation、已选模型、Agent preset 和作用域工具。淘汰只移除进程内 Agent 和 Session，不会删除持久化 transcript。冷恢复可能增加延迟；没有会话持久化的自定义 profile 会保留句柄，以免丢失上下文。

`0.3.0` 以前创建的群聊会话以整个聊天为范围，无法安全归属到某个回复根节点。这些数据仍保留用于回滚或导出，但 `0.3.0` 不会自动把它们绑定到新的回复树或话题。私聊会话和显式 `defaultSessionId` 的身份保持兼容。

成功处理的入站消息会记录在一个持久化的 1,024 条回执窗口中，因此正常重启后的 WebSocket 重投不会重复执行 follow-up 或命令。回执介质（Web profile 中通常为 `$DSH_HOME/storages/lark_inbound.json`）只存储 SHA-256 摘要，不保存明文 app、chat 或 message ID。活跃 generation sidecar（`lark_conversations.json`）同样会哈希 app 与会话身份；其最小化版本值只包含 generation 编号、后缀、可选的已选 provider/model ID，以及最多 1,024 个 SHA-256 消息变更摘要的有界历史。当变更已提交但入站回执丢失时，该历史可确保重放的 `/new`、`/clear`、`/project` 或 `/model` 变更保持幂等。它不保存明文 app、会话、chat、message、文件系统身份、单独配置的 provider endpoint 或凭据；已选路由 ID 会按原值存储，因此不要把秘密编码进 ID。自定义 profile 必须先挂载 Harness storage hub、一个持久化 KV 后端以及 `storage-domain`。

投递仍属于至少一次：如果进程在外部副作用完成后、回执提交前硬退出，该副作用仍可能重复。绑定变更还会受到每会话 1,024 条摘要历史的额外保护；早于该有界历史的重放仍可能再次执行。回执窗口已满时若写入失败，较旧回执可能已被淘汰；回调仍会失败，但有效防重窗口可能暂时缩小。不要让多个 Harness 进程共享同一个 JSON 存储根目录，该后端没有跨进程写锁。即使使用不同存储根，多个进程同时连接同一个机器人也不构成精确一次配置。

桥接器命令包括 `/start`（`/help` 的别名）、`/help`、`/new`、`/clear`、`/project [Workspace 标题或 ID]`、`/model` 和 `/model <provider-id> <model-id>`。直接发送 `/project` 会列出当前及可用的已注册 Workspace，但不会泄露文件系统路径。选中后会在该 Workspace 中启动空白会话 generation；旧 transcript 继续保留，但聊天历史不会跨项目带入。创建新 generation 前，桥接器必须先确认旧 transcript 的检查点，再重新校验 Workspace；任一检查失败都会保留旧的实时绑定。未知、歧义、目录缺失或未注册的 Workspace 都会被拒绝，当前会话保持不变。

挂载 DSH 命令运行时后，`/help` 还会发现该 Agent 实际可用的命令。标准 DSH Base profile 会提供 `/compact`、`/goal`、`/permission`、`/plan`；与当前通道不兼容的命令不会展示。

项目选择与聊天历史使用相同会话范围：私聊、群聊回复树和原生话题互不影响，一个缓慢的项目操作也不会阻塞无关会话。切换前，桥接器会先占有旧 Agent 真正的 idle 阶段；其他入口在提交前接受的新工作会让候选回滚，若工作恰好在最终原子绑定写入期间被接受，则旧 Handle 会保留到该工作恢复 idle。Lark 回复路由按实际领取的消息身份绑定，因此并发 Web turn 不会消耗 Lark 的回复目标。配置 `defaultSessionId` 后，会话和项目都会有意全局共享，因此一次切换会影响所有绑定聊天。每个已授权用户都能选择当前 DSH Web profile 注册的任意 Workspace，群聊中的 `/project` 也可能向群成员展示 Workspace 标题；请据此注册和命名 Workspace。缺少 `workspaceRegistry` 或会话持久化的自定义 profile 仍可列出已有 registry，但项目选择会默认拒绝。

刚选中的 generation 只要仍为空白，就会有意保持在 Workspace 会话索引之外，避免 Web 的“新建会话”或启动初选复用这个由 Lark 独占的空白 generation。首个 Lark `turn/start` 追加完成，且该精确会话的检查点确认后，桥接器才把它加入 Workspace 索引。索引检查点失败时会继续保持未索引，并在后续 turn 重试；重启和空闲淘汰也遵守同一边界。

新 generation 的检查点和原子绑定写入都确认成功后，桥接器才发送成功回复。创建、检查点或重新校验失败时，候选会被处置，旧的实时绑定与持久化绑定都保持不变。后端中即使残留已部分发布的候选 transcript，它也没有提交权限，重启时会被忽略。原子绑定确认出现歧义时，会在不释放当前会话的情况下持续重试相同绑定，直到可以读回确认；无关会话仍可继续使用。插件优雅关闭会先停止入站，再中断这项 fail-stop 重试，让受影响的平台回调失败且不提交其回执。此后同一个 Bridge 实例会拒绝重启；插件必须创建全新 Bridge 并重新挂载存储，使恢复结果遵循 sidecar 中实际存在的绑定。旧 transcript 的检查点失败同样会安全拒绝切换。

配置中的 `provider` 和 `model` 是会话尚无持久化模型选择时使用的默认值。`/model` 会报告当前路由，并按已挂载的 Harness provider 分组展示有界且可能被截断的 catalog：最多展示 32 个 provider 和 128 个模型，每个显示字段最多 120 个 Unicode 码点。`/model <provider-id> <model-id>` 会选择该精确路由，但不会重置 transcript、项目、Agent preset、作用域工具或实时 Handle。命令会先占有真正空闲阶段的维护权，因此已有运行中工作或待处理 inbox 时会默认拒绝并提示忙碌；最终持久写入期间才进入的工作仍留在队列中。只有同一 Session 已确认检查点，且路由与变更回执都原子提交后，桥接器才更新 Agent 作用域内的选择；prompt assembly 会对其做快照，所以已经完成组装的 step 不受影响，下一个模型 step 才使用新路由。

Harness 模型 catalog 只用于建议性发现，并非路由 allowlist。因此，只要已挂载 provider 的 adapter 能解析精确 provider/model 对，即使某个动态模型没有出现在 `/model` 列表中，也可以选择。反过来，出现在列表中或解析成功都不能证明凭据已经配置，也不会触发模型试请求：provider 凭据仍由 Harness 管理，鉴权、配额、endpoint 或上游错误只会在后续 turn 真正调用模型时出现。

模型选择与历史和项目使用相同的会话范围。它会在正常重启与空闲 LRU 淘汰后恢复；`/new`、`/clear` 和 `/project` 也会把它带入新的 generation。私聊、群聊回复树和原生话题不会互相修改模型；配置 `defaultSessionId` 后，模型选择会有意全局共享，一次切换会影响所有绑定聊天。模型切换绝不会修改供无关会话使用的 Harness 全局默认模型。

Harness rc.6 的 Web 模型选择器尚未公开可供多个入口共享的 per-Agent selection seam。因此，对于本桥接器创建的 Agent，持久化 Lark 选择会优先于其他入口之后安装的模型选择器；同一实时 Session 上的 Web prompt 会使用 Lark 路由，而 Web 选择器可能暂时显示它自己尚未被消费的选择。不要在同一个 Session 上混用两套模型选择器。该限制不影响其他 Web Session，也不会修改其默认模型。

每个已授权用户都能选择已挂载 adapter 可以解析的任意精确 provider/model 路由。在群聊中，`/model` 可能向其他成员展示已公布的 provider 显示名、provider ID、模型名和模型 ID；切换成功回复还可能显示用户提交的精确动态路由。请据此配置并命名路由。该命令不会读取单独配置的 endpoint 或凭据，但用户控制的名称与 ID 会在文档约定的长度范围内按原值展示。

## 卡片与审批

每个 turn 独占一条 Card 2.0 消息。思考过程、待办、重试、上下文压缩、Hook、嵌套代码工具、工作流、工具调用与结果以及最终答案都会按串行顺序更新到该卡片。流式更新会被节流，每个 payload 都限制在 Lark 的 28 KiB 卡片上限内。最终答案超出卡片预览时，还会使用符合平台长度限制的多条文本完整续发。

命令结果、每轮的初始卡片、审批卡片、降级文本和长答案续发都会回复触发它们的 Lark 消息。后续卡片更新会修改该回复返回的机器人消息，因此即使多个聊天共享同一个 Harness 会话，也能保持各自的回复目标。

在原生 Lark 话题中，每条初始文本或卡片回复还会携带 `reply_in_thread: true`，确保投递留在该话题内。普通群聊回复树只回复当前入站消息，不会被转为原生话题。

执行区域会限制可见思考内容和近期工具调用数量。运行中卡片在具备 `im:resource` 权限时使用动态加载图，结束后替换为终态图标，并提供绑定到原始会话、聊天和用户的停止按钮。紧凑页脚在一行中展示耗时、上下文窗口占用、缓存命中、输入、输出和思考 Token 用量。

普通成功回复不带醒目标题；失败、阻塞、取消和达到 Token 上限时使用语义化标题。如果 Card API 不可用，最终助手文本仍会降级为普通文本投递。

挂载 `@deepseek-ai/dsh-user-approval` 后，受保护的工具调用会显示“允许一次 / 拒绝”。决定绑定到原始会话、聊天和用户；重复、过期、格式错误或跨聊天操作默认拒绝。取消或卡片投递失败同样会关闭请求且不授予权限。

已安装 DSH session catalog 中的每个事件都有明确的渲染、消费或忽略策略。依赖升级一旦新增 catalog 事件，测试门禁会失败，直到明确选择处理策略。未知的运行时扩展事件只告警一次并忽略。

## 范围与边界

桥接器只向 Agent 发送文本。图片、文件、音频及其他非文本消息只按平台消息类型分类；插件不会解析它们的序列化内容，也不会把资源 key、名称或资源元数据复制到日志、存储或 Agent 输入。已授权的私聊消息，或明确 @ 机器人的群聊消息，会收到通用的本地化纯文本提示；其他群聊附件保持静默。这个边界不需要媒体下载权限。

群聊消息必须 @ 机器人或使用斜杠命令。附件摄入、管理界面和通用卡片框架明确不在当前范围内。

## 运维

挂载 Harness `webServer` 服务后，插件会注册 `GET /api/lark/health`（探针也可使用 `HEAD`）。HTTP `200` 表示官方 Lark SDK WebSocket 已连接；启动中、重连中、已停止、失败、格式异常和不可用状态均返回 `503`。JSON 只包含组件名、readiness、归一化连接状态、重连次数及可选的重连时间戳，不会测试 REST 权限、模型 provider、存储或端到端聊天 turn。

自定义 headless profile 不需要 `webServer`，缺少该接口也不影响聊天。响应包含 `Cache-Control: no-store`；其他方法返回 `405 Method Not Allowed` 和 `Allow: GET, HEAD`。

## 路线图

后续可靠性、会话和发布计划见 [ROADMAP.md](./ROADMAP.md)。

## 开发

```sh
npm ci --ignore-scripts
npm run check
npm run test:pack
```

`npm run check` 会执行单元/集成测试、真实组装的 Harness E2E、类型检查和构建。`npm run test:pack` 会将生成的 tarball 安装到隔离的消费项目并导入公开 API。

## 发布

每个用户可见功能单独使用一个 pull request，并在 `package.json` 和 `package-lock.json` 中推进稳定版本。CI 会拒绝版本不高于最新 `v*` Release 的 PR。

仓库所有者创建的非草稿 PR 会在必需的 `test` 检查通过后自动设置为 rebase merge。合并后的 `main` 构建会为已测试提交打 tag，并创建对应 GitHub Release。其他作者创建的 PR 仍需维护者显式合并。

自动合并使用仓库 Actions secret `AUTO_MERGE_TOKEN`，其所有者 token 具备 `repo` 和 `workflow` scope。工作流不会退回使用 `GITHUB_TOKEN`，因为它的防递归行为会阻止合并后的 `main` 发布工作流。替换或撤销所有者 token 时应同步轮换该 secret。

## 许可证

Apache-2.0

## 安全

受支持版本和私密漏洞报告方式见 [SECURITY.md](./SECURITY.md)。
