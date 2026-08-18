# dsh-plugin-lark

[English](./README.md) | 简体中文

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的飞书/Lark 长连接桥接插件。收到的文本会转为 Agent follow-up；每轮对话、工具生命周期、审批过程和结构化问题都会通过 Card 2.0 返回到原始会话。

## 功能概览

- **无需入站公网地址：** 通过官方 SDK 的 WebSocket 长连接接收飞书/Lark 事件。
- **隔离且可恢复的会话：** 私聊、群聊回复树和原生话题分别使用独立的持久化 Harness 会话；需要时也可显式绑定到一个全局共享会话。
- **有界会话导航：** 在精确会话范围内用已存标题、时间、项目标签和不透明引用列出合格历史，并原子恢复所选 transcript；不接受原始 Session ID 或路径。
- **项目注册与按会话选择：** 项目管理员可在私聊中注册当前 Session 目录或移除注册；所有已授权会话都能列出和选择已注册 Workspace，聊天参数不能指定任意路径。
- **按会话选择模型：** 列出已挂载 provider 及其公布的模型，接受 adapter 可解析的精确 provider/model 路由，并在新 generation 与恢复过程中保留每个会话的选择。
- **图片历史路由安全：** 只按精确压缩后的模型可见 surface 检测图片，阻止模型切换、Session 恢复或普通 prompt 把这段历史发送给纯文本或能力未知路由。
- **可选私聊图片：** 严格验证一个有界的静态 PNG 或 JPEG，通过 Harness 附件服务持久化，并只向明确支持图片的模型提交内容寻址引用。
- **结构化人工输入：** 把官方 `ask_user_question` 工具渲染为有界的原生单选、多选或自由文本卡片，并把已授权回答返回同一个运行中 turn。
- **可选私聊文本附件：** 通过严格的鉴权、文件名、MIME、字节数与内容检查，接收一个有界的 UTF-8 `.txt`、`.log`、`.patch` 或 `.diff` 消息，不接受 URL，也不创建临时文件。
- **经审批的 Workspace 产物发送：** 提供默认关闭的 Agent 作用域工具；只有原 Lark 用户批准精确实时 turn 后，才能发送一个有界文本文件或静态 PNG/JPEG。
- **可靠的主动通知：** 把一条完成或关注卡片受理到本轮已经注册的会话，并通过持久化发件箱保证重启既不丢也不重复投递已受理通知。
- **实时执行卡片：** 将思考过程、待办、重试、上下文压缩、Hook、工作流、工具调用与结果、Token 用量和最终答案持续更新到一张有大小上限的 Card 2.0 卡片中；服务停机打断执行时会有界尝试移除失效的实时控件。
- **安全的工具审批与停止：** 审批和停止操作绑定到发起它们的会话、聊天和用户；过期或跨聊天操作默认拒绝。
- **可靠的回复投递：** 卡片及降级文本始终回复触发消息或原生话题；长答案会完整续发，并通过持久化回执避免常规 WebSocket 重投造成重复执行。
- **有界的进程内驻留：** 释放已完成持久化检查点的最近最少使用空闲 Agent；再次访问时精确冷恢复原会话，且不会删除历史记录。
- **本地化与可观测性：** 内置 `zh-CN`、`en-US` 界面文案，并可选提供脱敏的 WebSocket readiness 接口。
- **运维状态与诊断：** `/status` 和 `/diag` 用 Card 2.0 向运维展示版本、运行时间、连接、会话范围、项目、模型与工作状态，以及脱敏修复建议，不含平台 ID 或秘密。
- **会话级策略：** 运维可以为单个聊天或群单独收窄额外授权用户、提及要求、可见 Workspace、可选模型，以及允许的审批或出站工具类别。本地规则只与全局默认拒绝配置取交集。
- **失败时默认拒绝：** 授权默认拒绝、Lark 应用凭据仅允许来自启动环境；媒体摄入必须显式开启且全程有界，审批失败也绝不会放行。

## 环境要求

- Node.js 22.x，或在插件 v0.8.5 及更高版本中使用 Node.js 24.x
- 一组版本一致的 DeepSeek Harness `0.1.0-rc.6` 软件包
- Harness `agents` 与 `sessions` 服务；标准 Web profile 已挂载两者
- 结构化 Lark 输入还需要 Harness `tools`、Session 持久化与兼容的 rc.6 `ask_user_question` 定义；标准 Web profile 已挂载它们
- 持久化的 `storageDomain` 服务；标准 Web profile 已提供基于 JSON 的完整存储栈
- 会话导航还要求 `sessionPersistence`、`sessionQuery` 与 `workspaceRegistry`；标准 rc.6 Web profile 已提供这些服务
- 入站图片还要求 Harness `attachments` 服务；标准 rc.6 Web profile 已提供本地内容寻址存储
- 出站产物还要求 `sessionPersistence`、`workspaceRegistry`、`approval`、图片所需的 `attachments`，以及标准本地文件系统 Workspace runtime
- 一个带机器人的飞书或 Lark 自建应用

### 支持的 Harness 兼容矩阵

下表中的支持状态只对应经过发布门禁验证的精确基线；某个版本仅仅满足宽泛的 semver 范围，并不代表该组合已受支持。

| 插件版本 | DeepSeek Harness 版本组 | 宿主库 | Node.js | 验证状态 |
| --- | --- | --- | --- | --- |
| `0.9.0`–`0.9.x` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | 沿用 v0.8.7 的 Linux 与 macOS package/runtime 门禁。v0.9.0 增加真实 rc.6 Workspace Registry 生命周期测试；v0.9.1 增加 owner context 服务依赖与首条命令冷恢复覆盖；v0.9.2 修正飞书 Card 2.0 元素兼容性并脱敏分类 SDK 失败；v0.9.3 增加有界精确范围 Session 导航；v0.9.4 增加直接 Native 结构化人工输入；v0.9.5 让 Cordis 真正拥有异步 disposer 并限制终态 Card 的停机预算；v0.9.6 增加可选、有界的入站 UTF-8 文本文件；v0.9.7 让模型与 Session 路由对图片历史默认拒绝不兼容目标；v0.9.8 在优雅停机时终态化已知的运行中执行卡；v0.9.9 增加可选、有界的静态入站图片；v0.9.10 在受支持的 Linux descriptor 边界上增加经审批的 Workspace 产物发送，其他平台失败关闭；v0.9.11 增加对已注册会话的可靠主动通知；v0.9.12 让同一进程内后续受理与退避重试继续排空发件箱；v0.9.13 增加运维 `/status` 与 `/diag`；v0.9.14 增加会话级策略；v0.9.15 让卡片回调也走同一策略，并且不再因为缺少健康探针就判定机器人正常。 |
| `0.8.7`–`0.8.x` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | 支持 GitHub 托管的 Ubuntu x64。Node 22 生成 canonical archive；Node 22 与 24 都执行相邻版本升级 profile 门禁。GitHub 托管的 macOS 26 arm64 还验证 Node 22 和 24 的 package/runtime 兼容性，但不验证 Web profile 部署。 |
| `0.8.6` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | Ubuntu 支持范围相同；macOS 26 arm64 的 package/runtime 证据只覆盖 Node 22。 |
| `0.8.5` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x`；`24.x` | 支持 GitHub 托管的 Ubuntu x64。Node 22 执行 canonical Release 与相邻版本升级门禁；Node 24 重跑源码/Harness 和 packed-consumer 门禁，再把同一份 canonical archive 全新安装到标准 rc.6 Web profile。 |
| `0.8.0`–`0.8.4` | 所有已解析的 `@deepseek-ai/dsh-*` 软件包均为 `0.1.0-rc.6` | Cordis `4.0.1`；Schemastery `3.18.1` | `22.x` | 支持原有 Node 22/Linux 基线；v0.8.4 新增不启动应用的 Web profile package lifecycle 门禁。 |

必需测试会组装真实的 rc.6 Cordis、Agent、Agent Loop、LLM、Session、语义 checkpoint policy、Session Title、SQLite Session Query 精确读取路径、JSONL 持久化、JSON storage-domain、本地 Attachment Store、Tools、User Questions、Approval 与 Workspace 服务；平台连接、模型 provider 和浏览器行为使用受控替身，项目变更和经审批产物投递另有真实 Registry/持久化生命周期测试。CI 把官方 Lark SDK 精确固定为 `1.73.0`，在 Node 22 上打出 canonical 候选包，把它全新安装到隔离的标准 rc.6 Web profile，并把第二个隔离 profile 从经过严格验证的 v0.9.12 Release package 升级到候选版本，同时保持用户 patch 不变。两条路径都必须匹配已安装 package 版本、唯一 bundle 注册和唯一组合后的 Lark 配置层。

Profile 门禁还会把 npm 解析固定在 rc.6 版本组发布完成后的 registry 时间快照。Harness 预发布包内部使用 caret 范围，因此只把顶层写成精确 `dsh@0.1.0-rc.6`，在全新 npm-exec 环境中仍可能漂移到更晚的预发布版本；门禁仍会逐一要求所有已解析 DSH 包精确为 rc.6。

从 v0.8.5 起，同一个 Linux Release 门禁随后会切到 Node 24，以 engine-strict 重新创建 `node_modules`，重跑完整源码/Harness 和独立 packed-consumer 门禁，再在隔离的标准 profile 中消费前面已经打好的同一份 canonical 候选包。v0.8.5 的基线 v0.8.4 只支持 Node 22，因此当时执行的是全新安装；从 v0.8.6 起，Node 24 还会验证从已经兼容的 v0.8.5 基线相邻升级。

从 v0.8.6 起，另一个必需门禁会在 GitHub 托管的 macOS 26 arm64 上运行 engine-strict Node 22；从 v0.8.7 起，同一隔离流程同时覆盖 Node 22 与 24。每条 runtime 都会重跑完整源码/Harness 测试、audit 和独立 packed-consumer 安装，然后在 Actions artifact digest 校验后下载并消费由 Ubuntu 生成的同一份 canonical archive。两条 runtime 都不会在 macOS 上执行 `dsh plugin`、组合标准 Web profile，也不验证应用启动和有状态操作。

该 Web profile 门禁刻意不启动应用：它验证 package 安装、升级、bundle 解析与配置组合，但不会启动 Web app，也不覆盖凭据、SDK WebSocket 连接、`/api/lark/health`、飞书/Lark 网络链路或持久化状态迁移；这些仍属于部署和真实凭据冒烟检查。

插件会把直接宿主 peer 固定在这组基线上，解析图中的所有 DSH 软件包也必须来自同一个 rc.6 版本组。混用 DSH 版本、Node.js 23.x 或 25 及更高版本、在 v0.8.4 及更早插件上使用 Node.js 24、更高版本的 Cordis 或 Schemastery、其他 Harness 版本组、Ubuntu x64 以外的 Ubuntu 架构，以及完全缺少可选 Approval 服务的宿主都尚未验证。从 v0.8.7 起，macOS 证据仅限 macOS 26 arm64/Node 22 或 24 的 package/runtime 消费；Intel Mac、其他 macOS 版本、标准 Web profile 运行和状态迁移仍未验证。替代持久化栈也未验证。自定义 profile 只有在提供[配置](#配置)章节所述服务时才受支持；缺少 `agents`、`sessions`、`tools` 或持久化 `storageDomain` 明确不受支持。

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
5. 开启 `inboundTextFiles`、`inboundImages` 或 `outboundArtifacts` 时必须授予 `im:resource`。这些功能都未开启时该权限仍为可选，仅用于启用内置动态加载图；缺少它时卡片会使用静态图标。

## Release 来源证明

从 v0.8.3 开始，每个 GitHub Release 都会包含通过 packed-consumer 冒烟测试的同一份 npm 格式 `.tgz`，以及 GitHub 托管、针对该文件生成的 SLSA build provenance attestation。本工作流不会发布到 npm registry；GitHub 自动生成的 **Source code** 压缩包也不是被证明的 package。

可以使用 GitHub CLI 下载并验证 Release package：

```sh
set -eu

version='0.9.15'
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

启动目录会成为每个新 Lark 会话的 workspace；持久化会话恢复时则沿用其已存储的 workspace。`/project register <名称>` 可以注册当前 Session 目录，`/project` 可以把单个会话切换到任意已注册 Workspace。是否让 Web UI 监听非回环地址属于具体部署配置；飞书/Lark 事件本身通过出站长连接投递，不需要入站公网监听器。

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
    projectManageFrom: []        # 允许在私聊中注册/移除项目的 open_id
    operatorFrom: []            # 允许使用 /status、/diag 和 /policy 的 open_id
    defaultSessionId: ''         # 留空 = 按私聊/群聊范围隔离
    provider: deepseek-official # 会话没有已保存选择时的默认 provider
    model: deepseek-v4-flash    # 会话没有已保存选择时的默认 model
    streamUpdateIntervalMs: 1000
    maxConversationHandles: 32  # 进程内活跃会话句柄的稳态目标
    inboundTextFiles: false     # 显式开启有界 UTF-8 文本文件消息
    maxInboundTextFileBytes: 131072 # 默认 128 KiB；硬上限 256 KiB
    inboundImages: false        # 显式开启一个静态 PNG/JPEG 私聊消息
    maxInboundImageBytes: 5242880 # 默认值/硬上限 5 MiB
    maxInboundImagePixels: 20000000 # 默认值/硬上限 2000 万像素
    maxConversationImages: 4   # 默认 4；硬上限 20
    maxConversationImageBytes: 20971520 # 默认值/硬上限 20 MiB
    outboundArtifacts: false    # 显式开启经审批的 Agent 作用域发送工具
    maxOutboundTextFileBytes: 131072 # 默认 128 KiB；硬上限 256 KiB
    maxOutboundImageBytes: 5242880 # 默认值/硬上限 5 MiB
    maxOutboundImagePixels: 20000000 # 默认值/硬上限 2000 万像素
    proactiveDelivery: false    # 显式开启可靠的 Agent 通知
```

这组基线要求宿主提供 `agents`、`sessions`、`tools` 和持久化 `storageDomain` 服务。需要持久化的重置、项目/会话/模型选择、冷恢复与结构化 Lark 问题还要求 `sessionPersistence`；`/project` 依赖 `workspaceRegistry`，`/session` 还依赖 `sessionQuery` 与持久化会话绑定，`/model` 依赖 Harness `llm` 服务。含图片的 Session 还要求该服务公开精确 `resolveModelInfo` modality 元数据；摄入图片还要求兼容的 `attachments` 服务。任一能力缺失时图片工作默认拒绝，但纯文本 Session 不受影响。结构化输入要求 Agent 仍能看到精确兼容的 rc.6 `ask_user_question` 定义；缺失或不兼容时会记录诊断并委派，而不会注册第二个 provider。缺少 Session Query 或 Workspace 能力时，会话导航会返回不可用；单独执行 `/session` 列表不会创建 Agent。审批卡片和 readiness 路由分别依赖可选的 `approval` 与 `webServer` 服务。已验证矩阵使用标准 JSON/JSONL、本地附件和 SQLite 精确读取实现，替代实现仍未验证。

`allowFrom` 默认拒绝：当列表为空且 `allowAllUsers: false` 时，所有用户都无权访问。仅当机器人明确需要公开使用时才设置 `allowAllUsers: true`。托管在 `open.larksuite.com` 的应用应使用 `domain: lark`。

`operatorFrom` 是独立且默认拒绝的运维 allowlist，默认值为空。列出的运维人员仍必须通过普通鉴权。`/status`、`/diag` 和 `/policy` 使用与执行卡相同的 Card 2.0 schema，且绝不包含凭据、聊天/消息/会话 ID、私有路径、哈希值或原始错误。

`/policy` 仅限运维，并在 `lark_policy` storage-domain 单元中持久化一份以哈希为键的单聊天文档。一份文档覆盖一个单聊或一整个群（含群内所有回复串与原生话题），因此新开话题串无法绕过已收紧的群策略。设置 `defaultSessionId` 后所有聊天共享同一会话，也就共享同一份策略文档。本地规则只能收窄全局默认拒绝配置：额外的哈希用户名单与 `allowFrom` 取交集；`mention always` 让群里的命令也必须 @ 机器人；Workspace 与模型名单在列出和切换之前就过滤掉不允许的名称；审批、`send_lark_artifact` 与 `notify_lark` 只要全局开关或本地开关有一个关闭就保持关闭。清空某个本地名单会恢复全局默认，但无法开启全局已禁用的能力。名单收窄不会驱逐会话已经选中的项目或模型，只是不再展示被隐藏的名称。运维始终可以恢复自己锁紧的会话。存储的文档不含明文 open ID，也不含任何密钥。

`projectManageFrom` 是独立且默认拒绝的项目管理 allowlist，默认值为空。管理员仍必须通过普通 `allowFrom`/`allowAllUsers` 鉴权，注册与移除命令只接受私聊；`allowAllUsers: true` 绝不会自动授予项目管理权限。项目管理要求标准可写 Workspace Registry 同时提供 `create`、`delete` 和 `resolveByPath`；只读自定义 Registry 仍只能列出和选择。

`inboundTextFiles` 默认关闭。开启后，`maxInboundTextFileBytes` 可设为不超过 256 KiB 硬上限的正整数，默认 128 KiB；机器人必须具备 `im:resource` 权限，且只在私聊中接收文件。鉴权、持久化消息去重及安全文件名/扩展名检查都会在下载前完成。客户端只会从当前配置的飞书/Lark OpenAPI 域名读取这条已认证消息携带的精确 file key，禁用重定向，同时限制声明长度与实际流长度；它不接受 URL 或本地路径。

`inboundImages` 同样默认关闭，且只接受私聊。下载前必须依次通过鉴权、去重、Agent 真正空闲、全局唯一且满时立即拒绝的图片槽、精确 `resolveModelInfo` 元数据明确包含 `image`，以及稳定附件服务检查。插件只接收一幅结构合法的 PNG 或 baseline/progressive JPEG；APNG、MPO、拼接/尾随图片、GIF、WebP、MIME 不匹配、畸形结构与越界数据全部拒绝。有效限制取插件配置与附件服务限制的较小值。插件硬上限为单图 5 MiB 编码字节、2000 万像素，以及精确当前模型可见会话内 20 张/20 MiB；默认分别为 5 MiB、2000 万像素、4 张/20 MiB。下载只使用已认证消息携带的精确 image key、固定 OpenAPI 域名，并禁用重定向。

`outboundArtifacts` 同样默认关闭。标准本地 Linux Web profile 开启后，Agent 作用域的 `send_lark_artifact` 工具只接受当前注册 Workspace 内一个有界的相对 `.txt`、`.log`、`.patch`、`.diff`、`.png`、`.jpg` 或 `.jpeg` 路径。文本默认 128 KiB、硬上限 256 KiB；图片默认值和硬上限均为 5 MiB/2000 万像素，且任一边都不能超过平台的 12000 像素限制。URL、URI scheme、绝对/穿越/反斜杠/隐藏/保留路径、最终 symlink、逃出 Workspace 或解析到不安全 canonical 路径段的中间 symlink、hardlink、目录、设备、FIFO、跨设备目标、不安全文本、动画与伪装格式全部默认拒绝；稳定指向同一 Workspace 内安全 canonical 目标的中间 symlink 可以使用。只有 Approval、Session 持久化、Workspace Registry 与平台上传/回复 seam 都存在时才注册工具；Web 来源、subagent、过期 turn 与嵌套 Code Mode 调用均无 Lark 发送权。

审批不能仅根据通用 `allowed-once` 推断。原 Lark 用户必须在同一聊天、同一运行中 turn 的精确已确认 Card 上操作，之后 approval audit 还必须持久 flush，才能开始上传。插件会在审批前通过 descriptor 校验读取并哈希快照后丢弃字节；审批后重新打开，并重新校验相同 root/file 身份、digest、类型与限制。rc.6 无法证明普通 Workspace 文件最初由哪个进程生成，因此最终来源决策依赖人工审批，而不是“由 Agent 生成”的虚假声明。该本地 descriptor 边界只在受支持的 Linux 部署上验证；同设备特权 bind mount 不在非特权威胁模型内。缺少 Linux `/proc` descriptor 边界的宿主不会注册该工具，inspect/send 一律失败关闭。

`proactiveDelivery` 默认关闭。开启后，Agent 作用域的 `notify_lark` 工具只会把一条完成或关注通知受理到本轮已经注册的 Lark 会话。模型不能传入聊天、用户或消息 ID；提及列表最多接受有界的 `initiator` token。已受理项写入持久化发件箱（键哈希；聊天/用户/消息 ID 只存在 destination 表），带幂等键、重试、过期和每会话速率限制；进程重启既不会静默丢失也不会重复投递已受理通知。调度仍由 Harness 或外部调度器负责。投递卡片沿用执行卡/审批卡同一套 Card 2.0 schema、内边距和字体。

`0.1.0` 已使用真实飞书凭据完成冒烟测试。Lark 域名路径通过官方 SDK 的域名切换和自动化测试覆盖；在宣称 Lark 已完成真实凭据测试前，仍需按发布手册记录一次 Lark 实测。

保持 `defaultSessionId` 为空即可隔离会话。私聊沿用兼容的 `lark:<chatId>` 会话；在群聊中，普通回复树按根消息划分可恢复范围，原生 Lark 话题则按聊天 ID 和话题 ID 划分。`parent_id` 不会用于选择会话。仅当所有已授权私聊、回复树和话题都应共享同一个 Harness 会话、项目、模型选择、会话目录和恢复权限时，才设置 `defaultSessionId`。在这种显式共享模式下，所有已授权用户都能看到同一组有界的会话标题、时间、项目和引用元数据，并能恢复其中合格的条目。

存在 Harness 会话持久化后端时，桥接器会在重启后恢复精确会话范围中已提交的 generation。`/new` 和 `/clear` 只重置当前私聊、回复树或话题；配置了 `defaultSessionId` 时，它们会有意重置全局共享会话。新 generation 与 `/session resume` 会先分别确认当前和候选 Session 的检查点，再把精确的活跃绑定原子提交到持久化存储，然后才回复。创建、恢复或检查点工作被拒绝时，旧绑定仍保持当前状态；后端中可能已部分发布的候选只会成为 orphan，重启时会被忽略。绑定写入出现歧义错误时，只会 fail-stop 当前会话并持续重试同一个值，直到读回确认，而不会报告不确定结果。尚无已提交绑定的普通进程内聊天可以在没有 `sessionPersistence` 时运行；`/new`、`/clear`、项目、会话和模型选择都要求会话持久化与持久化会话绑定 sidecar 同时可用，已有提交绑定的会话在冷恢复时缺少会话持久化也会默认拒绝。

`maxConversationHandles` 是单个插件实例中活跃会话句柄数量的稳态目标，并非硬并发上限。数量超出目标后，桥接器仅在会话没有活跃 turn、待处理 inbox 工作或桥接器操作，且 `sessions.flush()` 确认有持久化监听器参与后，才释放最近最少使用的句柄。它不会为了腾出空间取消或拒绝这些工作。缺少持久化或检查点失败时会保留句柄，因此活跃数量可以暂时高于目标。一旦终止清理开始，已退役句柄不会被重新使用；清理失败会记录日志，之后的访问会从持久化会话冷恢复。

设置 `maxConversationHandles: 0` 后，不会让任何已完成持久化检查点的空闲句柄保持热状态。下次收到消息时，会精确恢复对应 generation、已选模型、Agent preset 和作用域工具。淘汰只移除进程内 Agent 和 Session，不会删除持久化 transcript。冷恢复可能增加延迟；没有会话持久化的自定义 profile 会保留句柄，以免丢失上下文。

`0.3.0` 以前创建的群聊会话以整个聊天为范围，无法安全归属到某个回复根节点。这些数据仍保留用于回滚或导出，但 `0.3.0` 不会自动把它们绑定到新的回复树或话题。私聊会话和显式 `defaultSessionId` 的身份保持兼容。

成功处理的入站消息会记录在一个持久化的 1,024 条回执窗口中，因此正常重启后的 WebSocket 重投不会重复执行 follow-up 或命令。回执介质（Web profile 中通常为 `$DSH_HOME/storages/lark_inbound.json`）只存储 SHA-256 摘要，不保存明文 app、chat 或 message ID。活跃 generation sidecar（`lark_conversations.json`）同样会哈希 app 与会话身份；其最小化版本值只包含 generation 编号、后缀、可选的已选 provider/model ID，以及最多 1,024 个 SHA-256 消息变更摘要的有界历史。当变更已提交但入站回执丢失时，该历史可确保重放的 `/new`、`/clear`、`/project`、`/session resume` 或 `/model` 变更保持幂等。它不保存明文 app、会话、chat、message、文件系统身份、单独配置的 provider endpoint 或凭据；已选路由 ID 会按原值存储，因此不要把秘密编码进 ID。自定义 profile 必须先挂载 Harness storage hub、一个持久化 KV 后端以及 `storage-domain`。

投递仍属于至少一次：如果进程在外部副作用完成后、回执提交前硬退出，该副作用仍可能重复。绑定变更还会受到每会话 1,024 条摘要历史的额外保护；早于该有界历史的重放仍可能再次执行。项目注册/移除会先在 binding 中提交该摘要，再修改独立的宿主 Workspace domain，从而阻止旧注册消息在之后已移除项目后重建注册。两个存储之间采用明确的 at-most-once 边界：若摘要提交后、Registry 调用前崩溃，Registry 不产生效果，相同平台消息会被抑制；应先查看 `/project`，再发送一条新命令。Registry 调用或后置条件存在歧义时，所有 Lark 侧 Workspace 变更与附件索引写入默认拒绝，直到重新挂载 Workspace 服务；其他宿主消费者遵循各自的恢复策略。回执窗口已满时若写入失败，较旧回执可能已被淘汰；回调仍会失败，但有效防重窗口可能暂时缩小。不要让多个 Harness 进程共享同一个 JSON 存储根目录，该后端没有跨进程写锁。即使使用不同存储根，多个进程同时连接同一个机器人也不构成精确一次配置。

桥接器命令包括 `/start`（`/help` 的别名）、`/help`、`/new`、`/clear`、`/project`、`/project [Workspace 标题或完整 ID]`、`/project register <名称>`、`/project remove <完整 ID>`、`/session`、`/session list [页码]`、`/session resume <完整引用>`、`/model`、`/model <provider-id> <model-id>`，以及仅限运维的 `/status`、`/diag` 和 `/policy`。会话恢复不接受标题、原始 Session ID 或文件系统路径。直接发送 `/project` 会列出当前及可用注册，但不会泄露文件系统路径。注册路径只能取自当前 Session header，经 canonical 化且必须是现存目录；名称会归一化并限制长度，注册不会重置 Session，也不会立即把它加入 Workspace 索引。同一路径重复注册保持幂等且不会重命名。移除只接受精确完整 ID，也只删除 Registry 元数据：目录、文件、Agent、Session、binding 和 transcript 都保留，仍在运行的 Session 只会变成未分组。选中 Workspace 后会启动空白会话 generation；旧 transcript 继续保留，但聊天历史不会跨项目带入。创建新 generation 前，桥接器必须先确认旧 transcript 的检查点，再重新校验 Workspace；任一检查失败都会保留旧的实时绑定。未知、歧义、目录缺失或未注册的 Workspace 都会被拒绝，当前会话保持不变。

`/session` 与 `/session list [页码]` 最多展示 200 个合格候选，每页 10 个。每行包含不透明完整引用、最多显示 80 个 Unicode 码点的已存标题、最多 120 个码点的项目标签，以及在 Session 时间戳可表示时生成的 ISO 创建时间。已存 Session Title 可能是由首条人类 prompt 生成的确定性 fallback；清洗和截断只能防止平台标记注入，并不等于内容脱敏。同一精确范围内的所有已授权用户都能看到该标题。列表不会包含原始 Session ID、文件系统路径、完整消息、助手答案或工具正文。

历史候选必须已持久化、属于顶层、未归档、当前不处于 live 状态、被唯一索引到一个当前可用的已注册 Workspace，且其工作目录仍能 canonical 化到该 Workspace。orphan、空白或其他未索引历史、已移除 Workspace 的历史、subagent、有父级或 delegation 的 Session、外部或桥接器保留的 live 历史，以及其他会话范围都会被隐藏。当前已持久化 Session 是唯一允许未索引的例外，也可能显示为未注册项目；仅存在于内存中的新当前 Session 在持久化前可能不会出现在列表。目录最多扫描当前可用 Workspace 索引中的 1,000 个条目；如果无法完整建立这份权限索引，历史导航会默认拒绝，列表最多只保留其他条件合格的当前 Session。

`s_…` 引用是由应用、精确会话 base 和 Session 生成的确定性 SHA-256 标签。只有这些输入保持不变时，它才会跨重启稳定；更换应用、`defaultSessionId` 或回复树/话题范围后不能移植。它不是授权凭据；引用过期时应重新执行 `/session`。恢复会先检查点旧 transcript，重新验证目标与 Workspace，按持久化状态恢复目标的项目、模型、Agent preset、作用域工具和 transcript，确认目标持久化后，再带重放保护原子移动现有 version-2 binding。若目标精确压缩后的模型可见 surface 含有图片，其持久化精确模型路由必须通过 `resolveModelInfo` 明确公布图片输入；纯文本、缺失、格式错误或暂时不可查的能力都会保留旧 binding。历史路由来自该 Session 最新 request header；若离开 Session 前只切换模型却从未使用，新选择不会在那里形成 header snapshot，因此图片不兼容目标可能需要由写入它的其他可信 surface 修复。它不会复制、归档、删除或改写任何 transcript。最终提交前进入的工作会让 Lark 选择回滚；若其他入口已经向恢复目标接纳工作，该 Handle 会保留到工作空闲且持久化，而不会被丢弃。在最终 binding 写入期间进入的工作会向前提交。所选 binding 会在重启和空闲淘汰后保留。当前不提供 archive、unarchive、delete 或 search 命令。

挂载 DSH 命令运行时后，`/help` 还会发现该 Agent 实际可用的命令。标准 DSH Base profile 会提供 `/compact`、`/goal`、`/permission`、`/plan`；与当前通道不兼容的命令不会展示。

项目选择与聊天历史使用相同会话范围：私聊、群聊回复树和原生话题互不影响，项目变更期间无关会话的普通 followup 仍可继续。Lark 的切换、注册和移除共用一条全局 Workspace 顺序屏障，以免 switch/remove 竞态提交无效顺序；网络回复只会在释放屏障后发送。切换前，桥接器会先占有旧 Agent 真正的 idle 阶段；其他入口在提交前接受的新工作会让候选回滚，若工作恰好在最终原子绑定写入期间被接受，则旧 Handle 会保留到该工作恢复 idle。Lark 回复路由按实际领取的消息身份绑定，因此并发 Web turn 不会消耗 Lark 的回复目标。配置 `defaultSessionId` 后，Session 与项目选择会共享，但管理权限仍按每条消息的发送者检查。Registry 元数据是 profile 全局状态：管理员注册目录后，所有获准选择项目的用户——包括 `allowAllUsers: true` 下的所有用户——都能看到标题和 ID 并进入该目录；群聊 `/project` 也可能展示这些字段。移除同样是全局操作，但不会撤销已运行 Agent 的目录访问。缺少 `workspaceRegistry` 或会话持久化的自定义 profile 仍可列出已有 Registry，但项目选择和管理会默认拒绝。

刚选中的 generation 只要仍为空白，就会有意保持在 Workspace 会话索引之外，避免 Web 的“新建会话”或启动初选复用这个由 Lark 独占的空白 generation。首个 Lark `turn/start` 追加完成，且该精确会话的检查点确认后，桥接器才把它加入 Workspace 索引。索引检查点失败时会继续保持未索引，并在后续 turn 重试；重启和空闲淘汰也遵守同一边界。

新 generation 的检查点和原子绑定写入都确认成功后，桥接器才发送成功回复。创建、检查点或重新校验失败时，候选会被处置，旧的实时绑定与持久化绑定都保持不变。后端中即使残留已部分发布的候选 transcript，它也没有提交权限，重启时会被忽略。原子绑定确认出现歧义时，会在不释放当前会话的情况下持续重试相同绑定，直到可以读回确认；无关会话仍可继续使用。插件优雅关闭会先停止入站，再中断这项 fail-stop 重试，让受影响的平台回调失败且不提交其回执。此后同一个 Bridge 实例会拒绝重启；插件必须创建全新 Bridge 并重新挂载存储，使恢复结果遵循 sidecar 中实际存在的绑定。旧 transcript 的检查点失败同样会安全拒绝切换。

配置中的 `provider` 和 `model` 是会话尚无持久化模型选择时使用的默认值。`/model` 会报告当前路由，并按已挂载的 Harness provider 分组展示有界且可能被截断的 catalog：最多展示 32 个 provider 和 128 个模型，每个显示字段最多 120 个 Unicode 码点。`/model <provider-id> <model-id>` 会选择该精确路由，但不会重置 transcript、项目、Agent preset、作用域工具或实时 Handle。命令会先占有真正空闲阶段的维护权，因此已有运行中工作或待处理 inbox 时会默认拒绝并提示忙碌；最终持久写入期间才进入的工作仍留在队列中。只有同一 Session 已确认检查点，且路由与变更回执都原子提交后，桥接器才更新 Agent 作用域内的选择；prompt assembly 会对其做快照，所以已经完成组装的 step 不受影响，下一个模型 step 才使用新路由。

当精确的当前模型可见 surface 含有图片——包括 tool result 内嵌图片——`/model` 还会解析目标的精确 adapter 元数据，并要求 `inputModalities` 明确包含 `image`。catalog 条目、模型名称、普通路由解析成功或缺失的 modality 元数据都不能替代该检查。compaction replacement 具有权威性：图片一旦被 shadow 出当前 surface，即使不可变事件仍在日志中，也不再约束路由。能力查询期间 surface 或 inbox 发生变化会把 mutation 判为 busy；检查失败或不兼容不会修改持久 binding 与实时 selection ref。

若冷恢复 Session 的当前路由后来变成纯文本或能力未知，会话仍可打开自救，而不是永久无法访问。`/help`、`/model`、`/new`、`/clear` 与 Session 导航会在各自正常 maintenance 前提满足时保持可用；但普通 prompt 与所有动态 runtime command 都会在 Agent/provider 执行前被拒绝，直到 `/model` 选中明确支持图片的路由，或创建一条不含图片的新 generation。若冷恢复发现持久化 pending inbox，重置/导航命令仍会返回 busy；兼容的 `/model` 可以在队列未变化时提交，并插入后立即移除一条瞬态 wake notice，让 pending 工作在修复后的路由上启动。binding 已提交、wake 尚未发生时若崩溃，只有精确 mutation 仍是最后一次路由变更时才具备修复资格；重放会先离线预检持久化 inbox，再尝试修复，而早于任意后续路由的旧重放绝不会打开 Agent、唤醒或回滚。maintenance 或能力检查暂时不可用时，应在恢复后发送一条新的 `/model`，不能依赖旧投递自动重试。两条 inbox splice 事件不构成事务：撕裂的持久前缀可能保留这条 provider-valid 固定插件 notice，之后它可能进入模型上下文，但不含用户数据或标识。精确能力元数据只是时间点 guard，并不会固定未来 adapter registration：提交后若 adapter 被替换，后续 provider 调用仍可能默认拒绝。其他 surface 在最终 binding 写入期间接纳的输入遵循既有 commit-forward 边界；桥接器无法原子检查由其他 surface 拥有的工作。

Harness 模型 catalog 只用于建议性发现，并非路由 allowlist。因此，只要已挂载 provider 的 adapter 能解析精确 provider/model 对，即使某个动态模型没有出现在 `/model` 列表中，也可以选择。反过来，出现在列表中或解析成功都不能证明凭据已经配置，也不会触发模型试请求：provider 凭据仍由 Harness 管理，鉴权、配额、endpoint 或上游错误只会在后续 turn 真正调用模型时出现。

模型选择与历史和项目使用相同的会话范围。它会在正常重启与空闲 LRU 淘汰后恢复；`/new`、`/clear` 和 `/project` 也会把它带入新的 generation。私聊、群聊回复树和原生话题不会互相修改模型；配置 `defaultSessionId` 后，模型选择会有意全局共享，一次切换会影响所有绑定聊天。模型切换绝不会修改供无关会话使用的 Harness 全局默认模型。

Harness rc.6 的 Web 模型选择器尚未公开可供多个入口共享的 per-Agent selection seam。因此，对于本桥接器创建的 Agent，持久化 Lark 选择会优先于其他入口之后安装的模型选择器；同一实时 Session 上的 Web prompt 会使用 Lark 路由，而 Web 选择器可能暂时显示它自己尚未被消费的选择。不要在同一个 Session 上混用两套模型选择器。该限制不影响其他 Web Session，也不会修改其默认模型。

每个已授权用户都能选择已挂载 adapter 可以解析的任意精确 provider/model 路由。在群聊中，`/model` 可能向其他成员展示已公布的 provider 显示名、provider ID、模型名和模型 ID；切换成功回复还可能显示用户提交的精确动态路由。请据此配置并命名路由。该命令不会读取单独配置的 endpoint 或凭据，但用户控制的名称与 ID 会在文档约定的长度范围内按原值展示。

## 卡片与审批

每个 turn 独占一条 Card 2.0 消息。主动完成/关注通知沿用同一套 schema、内边距和字体，而不是另一套卡片样式。思考过程、待办、重试、上下文压缩、Hook、嵌套代码工具、工作流、工具调用与结果以及最终答案都会按串行顺序更新到该卡片。流式更新会被节流，每个 payload 都遵守插件保守的 28 KiB 安全预算，低于平台 30 KB 上限。最终答案超出卡片预览时，还会使用符合平台长度限制的多条文本完整续发。

命令结果、每轮的初始卡片、审批卡片、降级文本和长答案续发都会回复触发它们的 Lark 消息。后续卡片更新会修改该回复返回的机器人消息，因此即使多个聊天共享同一个 Harness 会话，也能保持各自的回复目标。

在原生 Lark 话题中，每条初始文本或卡片回复还会携带 `reply_in_thread: true`，确保投递留在该话题内。普通群聊回复树只回复当前入站消息，不会被转为原生话题。

执行区域会限制可见思考内容和近期工具调用数量。运行中卡片在具备 `im:resource` 权限时使用动态加载图，结束后替换为终态图标，并提供绑定到原始会话、聊天和用户的停止按钮。紧凑页脚在一行中展示耗时、上下文窗口占用、缓存命中、输入、输出和思考 Token 用量。

优雅停机会在移除 Session listener 与 REST 投递能力前，同步冻结每一张已知的运行中执行卡：先中断旧卡片写入，把仍在运行的工具标为失败、进行中待办退回待处理，移除“停止执行”，再排在旧投递链后尝试一次最终 PATCH；整个关闭窗口上限为 2 秒，低于 rc.6 的 5 秒宿主 grace。这张卡只声明实时执行已被服务停机打断、持久化结果尚未确认；它不会伪造 Session `turn/end`、续发 partial 长答案，也不能证明并发 Agent teardown 是否提交了终态。硬崩溃、第二次强制信号、取得 message ID 前 create 结果不明或最终 PATCH 结果不明时，远端仍可能残留 stale 卡片。

普通成功回复不带醒目标题；失败、阻塞、取消和达到 Token 上限时使用语义化标题。如果 Card API 不可用，最终助手文本仍会降级为普通文本投递。

对于源自 Lark 的直接 Native `ask_user_question` 调用，桥接器会在一张卡片中渲染最多三个问题：单选、多选和有界自由文本。自定义答案会补充多选，并覆盖单选。模型生成的标题、问题、选项标签和说明全部按纯文本字面量渲染；回调路由只使用内部选项 token，不使用模型 ID。终态卡片不包含问题、答案、表单字段、请求 token 或按钮。不要输入凭据或其他秘密：工具调用中的问题，以及成功提交后的工具结果，都会进入 Harness Session transcript。

发送问题卡片前，插件会显式确认待处理工具调用已完成持久化 checkpoint。30 分钟回答窗口只从卡片成功投递后开始。处理操作时，精确的实时 Agent、turn、Session、会话范围、聊天、卡片消息和发起用户都必须继续匹配；首个有效回答或取消获胜。问题等待期间，`/new`、`/clear`、项目、Session 和模型变更都会返回忙碌。用户取消、停止、重置、投递失败、超时、停机和重启均默认拒绝；操作回包会即时替换卡片，并使用一次延迟且有界的 PATCH 尽力修复丢失的回包。已知 message ID 时，终态投递会在 settlement 中同步登记；若 create 回包稍后才返回，则在取得该 ID 时立即登记。停机时其 deadline 会缩短到 2 秒，低于 rc.6 CLI 的全进程 5 秒 grace，并在 REST 停止前 drain。由于 rc.6 会把 owner-bound Agent Handle 与插件并发销毁，即使优雅停机已经关闭平台卡片，重启后仍可能把开放中的工具调用冷修复为 interrupted。没有已认领 Lark 路由的 Web turn 会继续交给标准 Web provider。

在 Harness rc.6 上，本拦截只支持 `native` 模式中的直接 Native 调用，以及 `both` 模式中的直接 Native 调用。`run_code` 内嵌的 `ask_user_question` 会快速失败且不创建卡片，因为 rc.6 Code Runtime 没有可在等待人工输入时暂停 worker 墙钟预算的公开接口。因此，本版本的 code-only preset 不能使用结构化 Lark 输入。

“回答已接收”只表示当前进程接纳了答案，并不是跨崩溃的持久化回执。在 `tool/result` 提交前，停止或 root shutdown 仍可取消该 turn；若进程硬崩溃，或优雅 SIGTERM 已关闭卡片但结果尚未提交，持久化层会把未完成调用修复为 `TOOL_OUTCOME_UNKNOWN` 并丢弃未提交答案。此时应在恢复后的新 turn 中重新提问。该边界不会虚假声称 rc.6 能提供 Card 回调与 Session 提交的原子事务。

挂载 `@deepseek-ai/dsh-user-approval` 后，受保护的工具调用会显示“允许一次 / 拒绝”。决定绑定到原始会话、聊天、用户与已确认 Card message；重复、过期、格式错误、复制 Card 或跨聊天操作默认拒绝。取消或卡片投递失败同样会关闭请求且不授予权限。出站产物工具还要求来自这次精确 Lark 操作的 Bridge 私有 claim，因此其他 approval answerer 不能授权平台写入。

已安装 DSH session catalog 中的每个事件都有明确的渲染、消费或忽略策略。依赖升级一旦新增 catalog 事件，测试门禁会失败，直到明确选择处理策略。未知的运行时扩展事件只告警一次并忽略。

## 范围与边界

桥接器通常向 Agent 发送文本 block，也可提交显式开启的附件 block。`inboundTextFiles` 与 `inboundImages` 都关闭时，所有非文本消息仍只做元数据级分类：插件不会解析平台序列化内容，也不会保留资源 key、名称或元数据。已授权私聊或明确 @ 机器人的群聊会收到通用本地化提示；其他群聊附件保持静默。

`inboundTextFiles: true` 时，一条已认证的私聊平台 `file` 消息可携带 `.txt`、`.log`、`.patch` 或 `.diff`。basename 最多 120 个 Unicode 码点和 255 个 UTF-8 字节；路径、隐藏名/保留名、控制字符、独立的主动 HTML/SVG 文档、二进制签名（包括单个 UTF-8 BOM 与前导文本空白之后的签名，并会在 PDF 合法的前 1,024 字节窗口内查找 header）、不安全控制/双向文本、空文件、MIME/扩展名不匹配、无效 UTF-8 及超限内容都会在提交给 Agent 前被拒绝。`.patch`/`.diff` 中的标记只有处于可识别的 unified-diff `---`/`+++`/`@@` envelope 内时才按代码保留。只接受 `text/plain`、格式专用文本 MIME 或平台常见的 `application/octet-stream` fallback。字节始终留在有界内存中，不创建临时文件或清理定时器；停机会取消开放中的下载流，且不提交该消息的入站回执。

接收成功的文件会变成显式标记的“不可信用户数据”文本 block。安全 basename、已验证 MIME、字节数与内容会按设计进入普通 Harness Session transcript，因此遵循该 backend 的保留、导出、fork 与访问策略。它们不会进入插件日志、哈希回执存储、conversation binding 或错误回复。附件链路不会向 Session 新增平台 resource key、文件 message ID、发送者 ID、凭据、除归一化 MIME 外的原始 headers、原始 SDK 错误或插件/宿主派生的私有路径。Session 原本的会话身份仍遵循已记录的范围契约——兼容的私聊 Session ID 可能独立于附件而由 chat ID 派生。用户提供的正文不会被自动脱敏，当然可能自行包含类似路径的文字。与其他入站 prompt 一样，Agent 接收后、回执提交前若硬崩溃，平台重投仍可能再次提交。

接收成功的图片会先通过捕获的附件服务持久提交，再向 Agent 接纳一个 `{ type: "image", attachment: ref }` block。Session 只保存经过验证的内容寻址引用、标准化 PNG/JPEG 类型、编码字节数、宽和高；平台 image key、下载字节/base64、后端路径、header、原始 SDK 错误与合成文件名都不会进入 Session。同一不可变对象会在冷恢复后继续可读，也可由 fork 共享。每次模型请求都可能再次读取并编码 compaction 后仍可见的全部图片，因此单图限制与精确 surface 聚合限制缺一不可。

Harness rc.6 没有附件删除、引用计数或垃圾回收 API。已发布对象可能无限期保留；如果保存后被停机、路由/服务变化、硬崩溃、followup 失败或回执失败抢先，留下的 orphan 也一样。Session 删除、归档、compaction、插件回滚或引用丢失都不会删除对象，插件不能猜测某对象已不再共享。`saveImage()` 一旦进入就不可取消，因此优雅停机会等待它真正结束，再拒绝迟到的 Session 接纳。必须把 `$DSH_HOME/attachments`（或自定义后端）纳入容量、访问、备份与保留策略。内容寻址 attachment ID 还会向能读取 Session 引用的主体暴露“内容相同”这一事实；对象缺失、损坏或元数据不符时，后续 provider 读取默认拒绝。

出站 upload 与 reply 是两个独立平台写入，不存在事务、上传删除或状态回滚；每一步都只尝试一次。产物回复强制绑定触发消息、保留原生话题，并携带每次 execution 独立 UUID，绝不会降级为新建聊天消息。上传后若路由/Workspace authority 丢失，只留下可能的平台注册 orphan，不会发送。send timeout、取消、畸形响应或崩溃可能意味着投递结果未知；确认发送后、`tool/result` 提交前崩溃则会冷修复为 `TOOL_OUTCOME_UNKNOWN`，两者都不会自动重试。平台 key、目标/message ID、绝对路径、文件内容、凭据与原始 SDK/文件系统错误都不会进入工具 content、插件日志、回执、binding 或 sidecar。模型生成的相对路径已经按普通 `tool/call` 契约进入 transcript；审批 Card 只显示已验证 basename、类型与大小。

v0.9.11 仍不支持 URL、压缩包、通用二进制、音频、视频、GIF、WebP、动画/多图 PNG/JPEG 与任何入站群聊图片。群入站附件继续默认拒绝：普通独立媒体消息无法携带本通道要求的机器人 @，因此未 @ 文件保持静默，人为构造或显式带 @ 的非文本事件也只收到通用提示。经审批的出站产物可以回复群聊 turn，因为精确路由与审批用户始终绑定。管理界面和通用卡片框架同样不在当前范围内。

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
