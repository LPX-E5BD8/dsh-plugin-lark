# dsh-plugin-lark

[English](./README.md) | 简体中文

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的飞书/Lark 长连接桥接插件。收到的文本会转为 Agent follow-up；每轮对话、工具生命周期和审批过程都会通过 Card 2.0 返回到原始会话。

## 功能概览

- **无需入站公网地址：** 通过官方 SDK 的 WebSocket 长连接接收飞书/Lark 事件。
- **隔离且可恢复的会话：** 私聊、群聊回复树和原生话题分别使用独立的持久化 Harness 会话；需要时也可显式绑定到一个全局共享会话。
- **实时执行卡片：** 将思考过程、待办、重试、上下文压缩、Hook、工作流、工具调用与结果、Token 用量和最终答案持续更新到一张有大小上限的 Card 2.0 卡片中。
- **安全的工具审批与停止：** 审批和停止操作绑定到发起它们的会话、聊天和用户；过期或跨聊天操作默认拒绝。
- **可靠的回复投递：** 卡片及降级文本始终回复触发消息或原生话题；长答案会完整续发，并通过持久化回执避免常规 WebSocket 重投造成重复执行。
- **有界的进程内驻留：** 释放已完成持久化检查点的最近最少使用空闲 Agent；再次访问时精确冷恢复原会话，且不会删除历史记录。
- **本地化与可观测性：** 内置 `zh-CN`、`en-US` 界面文案，并可选提供脱敏的 WebSocket readiness 接口。
- **失败时默认拒绝：** 授权默认拒绝、Lark 应用凭据仅允许来自启动环境、不摄入非文本内容，审批失败也绝不会放行。

## 环境要求

- Node.js 22 或更高版本
- 与 DeepSeek Harness `0.1.0-rc.6` 兼容的软件包
- 持久化的 `storageDomain` 服务；标准 Web profile 已提供基于 JSON 的完整存储栈
- 一个带机器人的飞书或 Lark 自建应用

## 安装

克隆仓库、构建，然后将检出目录添加到 Harness profile：

```sh
git clone https://github.com/LPX-E5BD8/dsh-plugin-lark.git
cd dsh-plugin-lark
npm ci --ignore-scripts
npm run build
dsh plugin --profile web add .
```

profile 使用该插件期间请保留检出目录，无需等待 npm registry 发布。

在飞书/Lark 开发者后台中：

1. 选择以**长连接**接收事件。
2. 订阅 `im.message.receive_v1`。
3. 注册 `card.action.trigger` 回调。
4. 为机器人授予 `im:message` 消息收发权限。
5. 可选授予 `im:resource`，以启用内置动态加载图；缺少该权限时卡片会使用静态图标。

## 运行

请从 Lark Agent 要操作的目标项目目录启动 DSH：

```sh
cd /path/to/target-project
export DSH_LARK_APP_ID='<app-id>'
export DSH_LARK_APP_SECRET='<app-secret>'
dsh --profile web --host 127.0.0.1 --port 3080
```

启动目录会成为每个新 Lark 会话的 workspace；持久化会话恢复时则沿用其已存储的 workspace。在支持按会话切换项目之前，如需更换某个会话的项目，应从新目录重启 DSH，然后在该会话中执行 `/new`。是否让 Web UI 监听非回环地址属于具体部署配置；飞书/Lark 事件本身通过出站长连接投递，不需要入站公网监听器。

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
    provider: deepseek-official
    model: deepseek-v4-flash
    streamUpdateIntervalMs: 1000
    maxConversationHandles: 32  # 进程内活跃会话句柄的稳态目标
```

`allowFrom` 默认拒绝：当列表为空且 `allowAllUsers: false` 时，所有用户都无权访问。仅当机器人明确需要公开使用时才设置 `allowAllUsers: true`。托管在 `open.larksuite.com` 的应用应使用 `domain: lark`。

`0.1.0` 已使用真实飞书凭据完成冒烟测试。Lark 域名路径通过官方 SDK 的域名切换和自动化测试覆盖；在宣称 Lark 已完成真实凭据测试前，仍需按发布手册记录一次 Lark 实测。

保持 `defaultSessionId` 为空即可隔离会话。私聊沿用兼容的 `lark:<chatId>` 会话；在群聊中，普通回复树按根消息划分可恢复范围，原生 Lark 话题则按聊天 ID 和话题 ID 划分。`parent_id` 不会用于选择会话。仅当所有已授权私聊、回复树和话题都应共享同一个 Harness 会话时，才设置 `defaultSessionId`。

存在 Harness 会话持久化后端时，桥接器会在重启后恢复精确会话范围的最新 generation。`/new` 和 `/clear` 只重置当前私聊、回复树或话题；配置了 `defaultSessionId` 时，它们会有意重置全局共享会话。只有新 generation 完成持久化检查点后才会发送确认；存储或恢复失败时绝不会退回一个空会话。

`maxConversationHandles` 是单个插件实例中活跃会话句柄数量的稳态目标，并非硬并发上限。数量超出目标后，桥接器仅在会话没有活跃 turn、待处理 inbox 工作或桥接器操作，且 `sessions.flush()` 确认有持久化监听器参与后，才释放最近最少使用的句柄。它不会为了腾出空间取消或拒绝这些工作。缺少持久化或检查点失败时会保留句柄，因此活跃数量可以暂时高于目标。一旦终止清理开始，已退役句柄不会被重新使用；清理失败会记录日志，之后的访问会从持久化会话冷恢复。

设置 `maxConversationHandles: 0` 后，不会让任何已完成持久化检查点的空闲句柄保持热状态。下次收到消息时，会精确恢复对应 generation、Agent preset 和作用域工具。淘汰只移除进程内 Agent 和 Session，不会删除持久化 transcript。冷恢复可能增加延迟；没有会话持久化的自定义 profile 会保留句柄，以免丢失上下文。

`0.3.0` 以前创建的群聊会话以整个聊天为范围，无法安全归属到某个回复根节点。这些数据仍保留用于回滚或导出，但 `0.3.0` 不会自动把它们绑定到新的回复树或话题。私聊会话和显式 `defaultSessionId` 的身份保持兼容。

成功处理的入站消息会记录在一个持久化的 1,024 条回执窗口中，因此正常重启后的 WebSocket 重投不会重复执行 follow-up 或命令。回执介质（Web profile 中通常为 `$DSH_HOME/storages/lark_inbound.json`）只存储 SHA-256 摘要，不保存明文 app、chat 或 message ID。自定义 profile 必须先挂载 Harness storage hub、一个持久化 KV 后端以及 `storage-domain`。

投递仍属于至少一次：如果进程在外部副作用完成后、回执提交前硬退出，该副作用仍可能重复。回执窗口已满时若写入失败，较旧回执可能已被淘汰；回调仍会失败，但有效防重窗口可能暂时缩小。不要让多个 Harness 进程共享同一个 JSON 存储根目录，该后端没有跨进程写锁。即使使用不同存储根，多个进程同时连接同一个机器人也不构成精确一次配置。

桥接器命令包括 `/start`（`/help` 的别名）、`/help`、`/new`、`/clear`。挂载 DSH 命令运行时后，`/help` 还会发现该 Agent 实际可用的命令。标准 DSH Base profile 会提供 `/compact`、`/goal`、`/permission`、`/plan`；与当前通道不兼容的命令不会展示。

`provider` 和 `model` 目前来自插件配置；新会话使用调用目录作为 workspace，持久化会话则恢复已存储的 workspace。按会话切换项目/workspace 及 provider/model 已进入 roadmap，但 `0.6.x` 尚未提供。

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
