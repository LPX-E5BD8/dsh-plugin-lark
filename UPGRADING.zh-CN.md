# 升级、回滚与持久化状态

[English](./UPGRADING.md) | 简体中文

本手册适用于受支持的 DeepSeek Harness `0.1.0-rc.6` 基线：Node.js 22.x，或从插件 v0.8.5 起使用 Node.js 24.x。默认使用标准 Web profile 的 JSONL 会话持久化与 JSON storage-domain 后端。自定义后端必须使用自身提供的一致性快照与恢复机制，但仍需把下文列出的逻辑单元作为同一个时间点处理。现有部署必须先在 Node.js 22 上升级插件，再通过单独的冷重启切换到 Node.js 24；绝不能把 runtime 变更与 Harness 版本组或状态迁移放进同一个窗口。下文所有流程仍只适用于 Linux：macOS 门禁从 v0.8.6 起验证 Node.js 22 package/runtime 消费，从 v0.8.7 起验证 Node.js 22/24 消费，但不验证 Web profile 运行、升级、回滚或状态迁移。

## 安全规则

- 同一个状态根目录只能由一个 Harness 进程写入；JSON 后端没有跨进程 writer lock。
- 复制或恢复状态前必须优雅停止 Harness，并等待进程完全退出。在线执行 `cp`/`tar` 不构成一致性快照，也不能把 `kill -9` 当作备份边界。
- 除非迁移明确要求，否则必须保持相同的 Lark app ID、状态根目录、启动 workspace、`defaultSessionId`、JSONL 压缩格式、canonical Workspace 路径、profile 配置与凭据来源。app ID 会参与存储 key 的哈希；更换后旧回执和绑定会像不存在一样。
- Sessions、storage domains 与 Web profile 必须按同一时间点做快照。绝不能只恢复 `lark_conversations.json`、手工合并新旧 JSON，或编辑哈希/schema 字段。
- 所有快照都应视为敏感数据。Session 日志可能包含 prompt、工具结果和仓库数据；Workspace 状态包含路径；已选模型路由 ID 是明文。快照必须放在检出目录之外并限制访问，绝不能附到 issue。
- 状态回滚不会撤销已经发送的消息、模型/provider 用量、工具副作用或 Workspace 中已修改的文件。项目目录必须使用自己的版本控制或备份保护。

## 一个完整的冷备份单元

标准 rc.6 Web profile 使用以下路径：

| 单元 | 标准位置 | 必须保持一致的原因 |
| --- | --- | --- |
| 会话持久化 | `$DSH_HOME/sessions` | JSONL header、event、generation、cwd、preset 与 request header |
| Storage domains | `$DSH_HOME/storages` | `lark_inbound.json`、`lark_conversations.json`、`workspace.json` 以及其他宿主 domain 状态 |
| Web profile 安装 | `$DSH_HOME/profiles/web` | 插件规格、profile 依赖图与本地检出目录引用 |
| 插件检出目录 | 传给 `dsh plugin --profile web add` 的绝对路径 | 本地安装可能持续链接该目录；回滚窗口关闭前必须保留旧检出目录 |

overlay 可以覆盖任意标准路径，因此应以本机组合后的配置为准。配置只能在本机检查，不要粘贴到工单。凭据和项目目录不属于上述三目录状态快照；请分别保留服务管理器/secret store 配置与仓库备份。

## 持久化状态历史

| 版本边界 | 前向行为 | 回滚后果 |
| --- | --- | --- |
| `0.1.3` | 新增 `lark_inbound` domain（domain version 0）和有界的哈希回执窗口；不会回填历史消息。 | `0.1.2` 及更早版本会忽略回执，平台重投可能再次执行已经完成的副作用。 |
| `0.3.0` | 群回复树与原生话题使用新的作用域 session ID。旧的群级 session 会保留，但不会被自动分配给新作用域。 | `0.2.2` 及更早版本会回到群级身份，无法看到新版本的群作用域上下文；较新的日志仍保留，可供之后前滚恢复。 |
| `0.3.0`–`0.6.1` | 没有进一步的插件自有持久化格式变化；v0.6 改变的是进程内驻留，而非已存 transcript。 | 该范围内状态格式兼容，但仍须遵守 v0.3 的群作用域边界。 |
| `0.7.0` | 新增 `lark_conversations` record schema v1，作为活跃 generation 与 mutation replay 历史的提交权威。 | `0.6.1` 及更早版本会忽略 sidecar，改为选择已持久化的最大 generation，而它可能是未提交 orphan；原地回滚不安全。 |
| `0.8.0` | 可读取 v1/v2 绑定，并写入包含 `modelSelection` 的严格 v2 record。v1 只会在下一次绑定写入时惰性升级，不会在启动时批量改写。 | `0.7.0` 只接受严格 v1；任意一条 v2 record 都会让它的全表启动校验失败。必须恢复 v0.8 前的冷备份。 |
| `0.8.1`–`0.8.8` | 与 v0.8.0 相比没有插件自有持久化 schema 变化。 | 在精确 rc.6 版本组上可与 v0.8.0 共用 v2 状态，但仍应遵守冷备份规则。插件 v0.8.1–v0.8.4 要求 Node.js 22。 |
| `0.9.0` | 插件自有 conversation binding 仍为 v2，但允许已授权 Lark 管理员在 Harness 自有的 `workspace` domain v2 中创建和删除 record。 | 回滚插件代码不会撤销快照后新增或移除的注册。命令绝不会删除目录与 transcript，但必须显式核对 Registry 可见性/顺序，或恢复完整冷快照。 |
| `0.9.1` | Schema 保持不变；在提交项目 Registry mutation binding 前，先实体化首条命令对应的 Session。 | 状态与 v0.9.0 兼容。回滚代码会重新引入项目 Registry 服务依赖缺陷，并移除首条命令所需的检查点实体化；应保留完整冷快照并优先前滚。 |
| `0.9.2` | 所有持久化 schema 保持不变；修正 Card 2.0 payload 字段，并对 SDK 消息投递失败进行脱敏分类。 | 状态与 v0.9.1 兼容。回滚代码可能再次让受保护工具的审批卡不可用；旧路径仍默认拒绝，绝不会授权工具调用。 |
| `0.9.3` | Conversation binding schema v2 与 Workspace domain v2 均保持不变。`/session resume` 会先检查点当前 transcript，再把现有 binding 原子指向一条已持久化且在当前作用域可见的 Session，并沿用现有 mutation-hash 窗口。不透明引用由运行时派生而非持久化；命令不会写入归档状态，也不会复制或删除 transcript。 | v0.9.2 会读取同一 binding，并继续使用 v0.9.3 选中的 Session，但没有 `/session` 列出/恢复命令。回滚不会撤销这次选择；归档状态与 Session log 均无需转换。 |

DSH JSONL 格式和 Workspace domain 属于 Harness rc.6，而不是本插件。本项目不声明跨 Harness 版本的迁移支持；插件升级与 Harness 版本组升级必须拆成两个变更，不能放进同一个恢复窗口。

已停止的部署可以在同一受支持 Harness 版本组上，从任意历史插件版本直接升级到当前版本；无需依次运行中间版本，也无需改写 JSONL。没有 `lark_conversations` record 时，恢复逻辑只会在精确的当前 base-ID lineage 内选择数值最大的 generation；这是旧版 heuristic，并非提交权威。v0.3 以前的群级 generation 不会被重新分配给较新的回复树/话题作用域 lineage，之后的持久绑定 mutation 才会建立提交权威。回执、群 transcript 和 binding 都不会批量回填，因此表中的边界在直接升级后仍然可见。

源自 v0.1.3 以前的自定义 profile 必须先挂载当前的 storage hub、持久化 KV backend 和 `storage-domain`，才能启动新插件；仅创建空 `storages` 目录不够。v0.7 以前的状态没有绑定权威，旧版 heuristic 也无法区分部分发布的候选。执行任何绑定 mutation 前必须核对已知会话；恢复错误或有歧义时，应停止并恢复完整的已知良好快照。操作员绝不能手选或删除单个 JSONL artifact。

## 准备目标检出目录

在停机前准备并验证一个并列的新检出目录。请把示例路径和 tag 换成精确值；不要直接更新正在服务的目录。

```bash
(
set -Eeuo pipefail

target_checkout_input='/srv/dsh-plugin-lark-next'
target_tag='v0.9.3'

case "$target_checkout_input" in /*) ;; *) exit 1 ;; esac
test ! -e "$target_checkout_input"
test ! -L "$target_checkout_input"
[[ "$target_tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
git clone https://github.com/LPX-E5BD8/dsh-plugin-lark.git "$target_checkout_input"
target_checkout="$(realpath -e -- "$target_checkout_input")"
test "$target_checkout" = "$target_checkout_input"
git -C "$target_checkout" switch --detach "$target_tag"
target_commit="$(git -C "$target_checkout" rev-parse HEAD)"
test "$target_commit" = "$(git -C "$target_checkout" rev-list -n 1 "$target_tag")"
manifest_version="$(node -e 'const fs = require("node:fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' "$target_checkout/package.json")"
test "v$manifest_version" = "$target_tag"
npm --prefix "$target_checkout" ci --ignore-scripts
npm --prefix "$target_checkout" run check
npm --prefix "$target_checkout" run test:pack
)
```

确认 tag 指向预期的 GitHub Release，且兼容矩阵与已安装 Harness 版本组一致。Web profile 快照只会保留当前本地 checkout 的绝对 link，不会冻结 link target。停机前必须识别这个精确路径，并要求它是位于已部署 commit 的 clean、detached checkout，已经按已提交 lockfile 执行 `npm ci --ignore-scripts` 且通过该版本检查。回滚窗口关闭前不能对它执行 pull、switch、install 或 rebuild。如果 profile 当前引用可变开发 checkout，必须先在独立变更窗口把它迁到 immutable checkout，并完成重启/验证，再开始本次升级。

## 停机并创建快照

先通过服务管理器或前台进程停止入站，发起正常的 SIGINT/SIGTERM 关闭，并等待所有使用该 root 的 DSH 进程退出。如果关闭时报告 conversation binding 写入被中断或未确认，应重新启动当前版本，让它恢复 sidecar 的权威值，核对受影响会话后再次优雅停止。不能从一次歧义关闭直接升级。

标准 Linux 文件系统后端可以使用以下保守模板。请导出已停止进程实际使用的精确绝对路径 `DSH_HOME`，并替换示例备份路径。模板会拒绝位于状态根目录内的备份目录和顶层 symlink 单元；如果检查结果与部署不符，必须改用 overlay/后端原生流程。

```bash
(
set -Eeuo pipefail

: "${DSH_HOME:?set DSH_HOME to the active absolute state root}"
backup_parent_input='/srv/private-backups'

case "$DSH_HOME" in /*) ;; *) exit 1 ;; esac
case "$backup_parent_input" in /*) ;; *) exit 1 ;; esac
dsh_state_root="$(realpath -e -- "$DSH_HOME")"
backup_parent="$(realpath -e -- "$backup_parent_input")"
test "$dsh_state_root" != '/'
test "$backup_parent" != '/'
test "$dsh_state_root" = "$DSH_HOME"
test "$backup_parent" = "$backup_parent_input"
case "$backup_parent" in
  "$dsh_state_root"|"$dsh_state_root"/*) exit 1 ;;
esac
test -d "$dsh_state_root/sessions"
test -d "$dsh_state_root/storages"
test -d "$dsh_state_root/profiles/web"
test -d "$backup_parent"
test ! -L "$dsh_state_root/sessions"
test ! -L "$dsh_state_root/storages"
test ! -L "$dsh_state_root/profiles"
test ! -L "$dsh_state_root/profiles/web"
command -v mountpoint >/dev/null
! mountpoint -q -- "$dsh_state_root/sessions"
! mountpoint -q -- "$dsh_state_root/storages"
! mountpoint -q -- "$dsh_state_root/profiles"
! mountpoint -q -- "$dsh_state_root/profiles/web"
root_device="$(stat -c '%d' -- "$dsh_state_root")"
root_mount="$(stat -c '%m' -- "$dsh_state_root")"
for active_unit in "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/profiles" "$dsh_state_root/profiles/web"; do
  test "$(stat -c '%d' -- "$active_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$active_unit")" = "$root_mount"
done

required_kib="$(du -sk -- "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/profiles/web" | awk '{ total += $1 } END { print total }')"
available_kib="$(df -Pk -- "$backup_parent" | awk 'NR == 2 { print $4 }')"
[[ "$required_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
test "$available_kib" -gt "$required_kib"

umask 077
upgrade_snapshot="$(mktemp -d -- "$backup_parent/dsh-lark-pre-upgrade.XXXXXX")"
test -d "$upgrade_snapshot"
test ! -L "$upgrade_snapshot"
test "$(realpath -e -- "$upgrade_snapshot")" = "$upgrade_snapshot"
test "$(dirname -- "$upgrade_snapshot")" = "$backup_parent"
case "$(basename -- "$upgrade_snapshot")" in dsh-lark-pre-upgrade.*) ;; *) exit 1 ;; esac
cp -a -- "$dsh_state_root/sessions" "$upgrade_snapshot/sessions"
cp -a -- "$dsh_state_root/storages" "$upgrade_snapshot/storages"
cp -a -- "$dsh_state_root/profiles/web" "$upgrade_snapshot/web-profile"
test -d "$upgrade_snapshot/sessions"
test -d "$upgrade_snapshot/storages"
test -d "$upgrade_snapshot/web-profile"
tree_digest() {
  tar --sort=name --format=posix \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --numeric-owner -C "$1" -cf - sessions storages web-profile |
    sha256sum | awk '{ print $1 }'
}
snapshot_digest="$(tree_digest "$upgrade_snapshot")"
[[ "$snapshot_digest" =~ ^[0-9a-f]{64}$ ]]
printf '%s\n' "$snapshot_digest" > "$upgrade_snapshot/SNAPSHOT_SHA256"
test "$(tree_digest "$upgrade_snapshot")" = "$snapshot_digest"
touch -- "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test ! -L "$upgrade_snapshot/SNAPSHOT_SHA256"
test ! -L "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test -f "$upgrade_snapshot/SNAPSHOT_SHA256"
test -f "$upgrade_snapshot/SNAPSHOT_COMPLETE"
printf 'completed snapshot: %s\n' "$upgrade_snapshot"
)
```

只有在三个目录复制完成后同时带有 `SNAPSHOT_SHA256` 与 `SNAPSHOT_COMPLETE` 的私有快照，才允许用于本恢复模板。checksum 用于发现意外损坏，受保护目录则构成它的信任边界；能够同时改写数据与 checksum 的攻击者不受它防护。修改 profile 前必须验证快照；不要移动或删除源状态。如果自定义后端横跨数据库、volume、mountpoint 或顶层 symlink，应改用能够建立共同一致时间点的后端原生快照。

## 升级与验证

保持旧进程停止，并显式把 profile 检查与修改绑定到刚完成备份的状态根目录。把下方字面量检出路径设为之前验证过的同一个 canonical 路径；该代码块会独立 canonicalize 两个路径，不会静默继承其他 profile root。

```bash
(
set -Eeuo pipefail
: "${DSH_HOME:?set DSH_HOME to the snapshotted absolute state root}"
target_checkout_input='/srv/dsh-plugin-lark-next'
dsh_state_root="$(realpath -e -- "$DSH_HOME")"
target_checkout="$(realpath -e -- "$target_checkout_input")"
test "$dsh_state_root" = "$DSH_HOME"
test "$target_checkout" = "$target_checkout_input"
DSH_HOME="$dsh_state_root" dsh --profile web --dump-config >/dev/null
DSH_HOME="$dsh_state_root" dsh plugin --profile web add "$target_checkout"
DSH_HOME="$dsh_state_root" dsh --profile web --dump-config >/dev/null
)
```

然后：

1. 使用相同的 app ID、`defaultSessionId`、存储 root、JSONL 压缩格式、canonical Workspace 路径、配置 overlay 与继承凭据，从相同 workspace 启动同一个 Harness `0.1.0-rc.6` profile。DSH rc.6 会拒绝 `.env` 中的 `DSH_*` 应用凭据；请按 README 使用启动进程/服务环境。
2. 挂载 `webServer` 时，必须确认 `/api/lark/health` 返回 HTTP 200 且 `state: connected`。
3. 先检查 `/help`，再列出 `/project`、`/session` 和 `/model`。在可丢弃的已注册 Workspace 中，用完整不透明引用恢复一条列表中的历史 Session，并核对预期 transcript、项目、模型、preset 与工具。列表可能显示由首条人类 prompt 派生的有界持久标题，因此只能使用非敏感测试内容。
4. 验证无关私聊和群回复根无法使用该引用。再重启一次、重新列出并重复恢复检查，确认后才能接受迁移。
5. 执行 `SMOKE_TESTS.md` 中与此次变更相关的真实凭据检查，包括 `/new`、会话导航、项目/模型继承、重启和 LRU 冷恢复；回滚窗口关闭前持续保留快照和旧检出目录。

每条已处理的验证消息都会推进入站回执。之后若恢复旧快照，这些回执会倒退并可能允许平台重投；请使用可丢弃的检查并核对外部副作用。

## 冷迁移到另一台机器

主机迁移属于冷迁移，不是蓝绿发布。必须先停止源端并保持停止；源端与目标端不能同时让 Harness 共享这份状态或连接同一个 Lark app。该标准流程只适用于迁移到空状态根目录的同 Linux 冷迁移，并且必须保留 numeric owner、mode、symlink target 以及完全相同的绝对 `DSH_HOME`、checkout、启动和 Workspace 路径。其他布局和 backend 尚未验证，必须使用其原生流程。

目标端必须准备完全相同的 rc.6 版本组、源与目标插件版本共同支持的同一条 Node.js 版本线、目标与回滚插件 tag/commit、app ID、`defaultSessionId`、JSONL 压缩格式、启动 workspace 与凭据来源；本次状态传输期间不能切换 Node.js 版本线。通过认证通道传输一个已完成的三目录快照和所需的 immutable checkout，并在安装前重新计算和验证 `SNAPSHOT_SHA256`。Workspace 仓库不在状态快照内，必须单独复制并保持相同 canonical 路径和 commit。绝不能把目标端已有的 JSONL/JSON 与快照合并。验证目标端期间源端必须继续停止；任何源端回滚或重试之前也必须先停止目标端。

## 回滚决策表

回滚到任意早于 v0.9.2 的版本都会恢复旧 Card payload 契约。飞书可能在创建阶段拒绝其中的审批卡，使受保护调用不可用但仍保持默认拒绝；这一共同影响叠加在下表各目标版本的状态后果之上。

| 从 v0.9.3 回滚到 | 状态处理方式 |
| --- | --- |
| v0.9.2 | 使用相同的 v2 conversation binding、Workspace domain 与 Session log。v0.9.3 选中的 Session 会继续保持 active，因为 v0.9.2 会遵循该已提交 binding；但 `/session` 列出/恢复命令会消失，回滚也不会恢复先前 active 的 Session。v0.9.3 没有引入归档、取消归档、删除或搜索状态。 |
| v0.9.1 | 无需转换持久化状态。旧版 Card payload 可能被飞书拒绝，因此审批可能不可用，但仍保持默认拒绝；必须保留完整快照，并优先通过前滚恢复。 |
| v0.9.0 | 使用相同的 v2 binding 与 Workspace schema；v0.9.1 已实体化的 Session 仍可读取，但 v0.9.0 会重新引入项目 Registry 检查点失败，并缺少安全的首条命令实体化。必须保留完整快照，并优先通过前滚恢复。 |
| v0.8.8、v0.8.7、v0.8.6 或 v0.8.5 | 使用相同 v2 binding schema 和 Node.js 22/24 engine contract。旧插件会忽略项目管理命令，但回滚不会恢复 v0.9.x 期间移除的注册，也不会删除 v0.9.x 期间新增的注册。恢复服务前必须保留完整快照并核对 Harness `workspace` domain；项目目录、文件和 transcript 都会保留。 |
| v0.8.4、v0.8.3、v0.8.2、v0.8.1 或 v0.8.0 | 使用相同 v2 binding schema。在精确 rc.6 版本组上，优雅停机并保留快照后可以原地回滚代码。本手册只支持这些目标运行在 Node.js 22 上：v0.8.1–v0.8.4 会通过 `engines` 强制该边界；v0.8.0 历史上的宽范围也没有建立 Node.js 24 支持。已经运行 Node.js 24 的部署必须先在单独的冷步骤中恢复 runtime，再启动旧插件。 |
| v0.7.0 | 不能让它读取可能已被 v0.8.x 写过的状态。v0.7 无法读取任何 v2 binding，必须恢复完整的 v0.8 前快照。 |
| v0.3.0–v0.6.1 | 必须恢复 v0.7 前的快照；这些版本会忽略提交权威 binding，并可能选择更新的 orphan generation。 |
| v0.1.3–v0.2.2 | 还要预期群会话回到群级身份；群作用域历史不会被向下迁移。 |
| v0.1.0–v0.1.2 | 还要预期持久化入站去重消失；平台重复投递可能重复副作用。 |

如果不存在目标版本所需的兼容快照，应前滚到能够读取当前状态的最新版本。故障期间绝不能临时发明 v2 到 v1 的 JSON 转换，也不能手选或删除看似 orphan 的 generation。

## 恢复标准文件系统快照

停止失败/新版本进程，并再次核对源与目标的精确绝对路径。这个标准 Linux 模板会先把快照复制到状态文件系统上的 staging 目录，再把当前状态移到同一文件系统内的可恢复 hold 中；它不会删除当前状态。模板会拒绝 symlink 单元和单独挂载的顶层单元。状态文件系统必须同时容纳 staging 恢复副本与当前状态。

```bash
(
set -Eeuo pipefail

: "${DSH_HOME:?set DSH_HOME to the active absolute state root}"
backup_parent_input='/srv/private-backups'
upgrade_snapshot_input='/srv/private-backups/dsh-lark-pre-upgrade.REPLACE_ME'

case "$DSH_HOME" in /*) ;; *) exit 1 ;; esac
case "$backup_parent_input" in /*) ;; *) exit 1 ;; esac
case "$upgrade_snapshot_input" in /*) ;; *) exit 1 ;; esac
dsh_state_root="$(realpath -e -- "$DSH_HOME")"
backup_parent="$(realpath -e -- "$backup_parent_input")"
upgrade_snapshot="$(realpath -e -- "$upgrade_snapshot_input")"
test "$dsh_state_root" != '/'
test "$backup_parent" != '/'
test "$dsh_state_root" = "$DSH_HOME"
test "$backup_parent" = "$backup_parent_input"
case "$backup_parent" in
  "$dsh_state_root"|"$dsh_state_root"/*) exit 1 ;;
esac
test "$(dirname -- "$upgrade_snapshot")" = "$backup_parent"
case "$(basename -- "$upgrade_snapshot")" in dsh-lark-pre-upgrade.?*) ;; *) exit 1 ;; esac
case "$upgrade_snapshot" in "$dsh_state_root"|"$dsh_state_root"/*) exit 1 ;; esac
case "$dsh_state_root" in "$upgrade_snapshot"|"$upgrade_snapshot"/*) exit 1 ;; esac
test -d "$upgrade_snapshot/sessions"
test -d "$upgrade_snapshot/storages"
test -d "$upgrade_snapshot/web-profile"
test -f "$upgrade_snapshot/SNAPSHOT_SHA256"
test -f "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test -d "$dsh_state_root/sessions"
test -d "$dsh_state_root/storages"
test -d "$dsh_state_root/profiles/web"
test ! -L "$upgrade_snapshot/sessions"
test ! -L "$upgrade_snapshot/storages"
test ! -L "$upgrade_snapshot/web-profile"
test ! -L "$upgrade_snapshot/SNAPSHOT_SHA256"
test ! -L "$upgrade_snapshot/SNAPSHOT_COMPLETE"
test ! -L "$dsh_state_root/sessions"
test ! -L "$dsh_state_root/storages"
test ! -L "$dsh_state_root/profiles"
test ! -L "$dsh_state_root/profiles/web"

root_device="$(stat -c '%d' -- "$dsh_state_root")"
root_mount="$(stat -c '%m' -- "$dsh_state_root")"
command -v mountpoint >/dev/null
for active_unit in "$dsh_state_root/sessions" "$dsh_state_root/storages" "$dsh_state_root/profiles" "$dsh_state_root/profiles/web"; do
  ! mountpoint -q -- "$active_unit"
  test "$(stat -c '%d' -- "$active_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$active_unit")" = "$root_mount"
done

tree_digest() {
  tar --sort=name --format=posix \
    --pax-option=exthdr.name=%d/PaxHeaders/%f,delete=atime,delete=ctime \
    --numeric-owner -C "$1" -cf - sessions storages web-profile |
    sha256sum | awk '{ print $1 }'
}
expected_digest="$(< "$upgrade_snapshot/SNAPSHOT_SHA256")"
[[ "$expected_digest" =~ ^[0-9a-f]{64}$ ]]
test "$(tree_digest "$upgrade_snapshot")" = "$expected_digest"
required_kib="$(du -sk -- "$upgrade_snapshot/sessions" "$upgrade_snapshot/storages" "$upgrade_snapshot/web-profile" | awk '{ total += $1 } END { print total }')"
available_kib="$(df -Pk -- "$dsh_state_root" | awk 'NR == 2 { print $4 }')"
[[ "$required_kib" =~ ^[0-9]+$ && "$available_kib" =~ ^[0-9]+$ ]]
test "$available_kib" -gt "$required_kib"

umask 077
restore_stage="$(mktemp -d -- "$dsh_state_root/.dsh-lark-restore-stage.XXXXXX")"
test -d "$restore_stage"
test ! -L "$restore_stage"
test "$(realpath -e -- "$restore_stage")" = "$restore_stage"
test "$(dirname -- "$restore_stage")" = "$dsh_state_root"
case "$(basename -- "$restore_stage")" in .dsh-lark-restore-stage.?*) ;; *) exit 1 ;; esac
test "$(stat -c '%d' -- "$restore_stage")" = "$root_device"
test "$(stat -c '%m' -- "$restore_stage")" = "$root_mount"
cp -a -- "$upgrade_snapshot/sessions" "$restore_stage/sessions"
cp -a -- "$upgrade_snapshot/storages" "$restore_stage/storages"
cp -a -- "$upgrade_snapshot/web-profile" "$restore_stage/web-profile"
for staged_unit in "$restore_stage/sessions" "$restore_stage/storages" "$restore_stage/web-profile"; do
  test -d "$staged_unit"
  test ! -L "$staged_unit"
  test "$(stat -c '%d' -- "$staged_unit")" = "$root_device"
  test "$(stat -c '%m' -- "$staged_unit")" = "$root_mount"
done
test "$(tree_digest "$restore_stage")" = "$expected_digest"

rollback_hold="$(mktemp -d -- "$dsh_state_root/.dsh-lark-rollback-hold.XXXXXX")"
test -d "$rollback_hold"
test ! -L "$rollback_hold"
test "$(realpath -e -- "$rollback_hold")" = "$rollback_hold"
test "$(dirname -- "$rollback_hold")" = "$dsh_state_root"
case "$(basename -- "$rollback_hold")" in .dsh-lark-rollback-hold.?*) ;; *) exit 1 ;; esac
test "$(stat -c '%d' -- "$rollback_hold")" = "$root_device"
test "$(stat -c '%m' -- "$rollback_hold")" = "$root_mount"

path_present() { test -e "$1" || test -L "$1"; }
plain_dir() { test -d "$1" && test ! -L "$1"; }
dir_id() { stat -c '%d:%i' -- "$1"; }
rename_empty_target() {
  plain_dir "$1" || return 1
  test "$(dir_id "$1")" = "$3" || return 1
  if path_present "$2"; then return 1; fi
  mv -nT -- "$1" "$2" || return 1
  if path_present "$1"; then return 1; fi
  plain_dir "$2" || return 1
  test "$(dir_id "$2")" = "$3"
}
rollback_one() {
  if path_present "$2"; then
    plain_dir "$2" && test "$(dir_id "$2")" = "$4" || return 1
    if path_present "$1"; then
      plain_dir "$1" && test "$(dir_id "$1")" = "$5" || return 1
      if path_present "$3"; then return 1; fi
      rename_empty_target "$1" "$3" "$5" || return 1
    fi
    if path_present "$1"; then return 1; fi
    rename_empty_target "$2" "$1" "$4" || return 1
  else
    plain_dir "$1" && test "$(dir_id "$1")" = "$4" || return 1
  fi
}
rollback_all() {
  rollback_failed=0
  rollback_one "$dsh_state_root/profiles/web" "$rollback_hold/web-profile" "$restore_stage/web-profile" "$original_web_id" "$staged_web_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile profiles/web'; rollback_failed=1; }
  rollback_one "$dsh_state_root/storages" "$rollback_hold/storages" "$restore_stage/storages" "$original_storages_id" "$staged_storages_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile storages'; rollback_failed=1; }
  rollback_one "$dsh_state_root/sessions" "$rollback_hold/sessions" "$restore_stage/sessions" "$original_sessions_id" "$staged_sessions_id" || { printf >&2 '%s\n' 'automatic rollback could not reconcile sessions'; rollback_failed=1; }
  return "$rollback_failed"
}
on_exit() {
  restore_rc=$1
  trap '' HUP INT QUIT TERM
  trap - ERR EXIT
  set +e
  if test "$rename_active" -eq 1 && test "$rename_committed" -eq 0; then
    test "$restore_rc" -ne 0 || restore_rc=1
    printf >&2 'active root: %s\nrollback hold: %s\nrestore stage: %s\n' "$dsh_state_root" "$rollback_hold" "$restore_stage"
    if rollback_all; then
      printf >&2 '%s\n' 'rename failed; original state was restored; keep Harness stopped until paths are verified'
    else
      printf >&2 '%s\n' 'automatic rollback stopped without overwriting; keep Harness stopped and inspect active, hold, and stage'
      restore_rc=1
    fi
  fi
  exit "$restore_rc"
}

original_sessions_id="$(dir_id "$dsh_state_root/sessions")"
original_storages_id="$(dir_id "$dsh_state_root/storages")"
original_web_id="$(dir_id "$dsh_state_root/profiles/web")"
staged_sessions_id="$(dir_id "$restore_stage/sessions")"
staged_storages_id="$(dir_id "$restore_stage/storages")"
staged_web_id="$(dir_id "$restore_stage/web-profile")"
rename_active=0
rename_committed=0
trap 'on_exit "$?"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 131' QUIT
trap 'exit 143' TERM
rename_active=1
rename_empty_target "$dsh_state_root/sessions" "$rollback_hold/sessions" "$original_sessions_id" || exit 1
rename_empty_target "$dsh_state_root/storages" "$rollback_hold/storages" "$original_storages_id" || exit 1
rename_empty_target "$dsh_state_root/profiles/web" "$rollback_hold/web-profile" "$original_web_id" || exit 1
rename_empty_target "$restore_stage/sessions" "$dsh_state_root/sessions" "$staged_sessions_id" || exit 1
rename_empty_target "$restore_stage/storages" "$dsh_state_root/storages" "$staged_storages_id" || exit 1
rename_empty_target "$restore_stage/web-profile" "$dsh_state_root/profiles/web" "$staged_web_id" || exit 1
test "$(dir_id "$dsh_state_root/sessions")" = "$staged_sessions_id"
test "$(dir_id "$dsh_state_root/storages")" = "$staged_storages_id"
test "$(dir_id "$dsh_state_root/profiles/web")" = "$staged_web_id"
test "$(dir_id "$rollback_hold/sessions")" = "$original_sessions_id"
test "$(dir_id "$rollback_hold/storages")" = "$original_storages_id"
test "$(dir_id "$rollback_hold/web-profile")" = "$original_web_id"
if path_present "$restore_stage/sessions" || path_present "$restore_stage/storages" || path_present "$restore_stage/web-profile"; then exit 1; fi
rename_committed=1
trap - ERR EXIT HUP INT QUIT TERM
printf 'active root: %s\nrollback hold: %s\nrestore stage: %s\n' "$dsh_state_root" "$rollback_hold" "$restore_stage"
)
```

该 subshell 会在校验、复制、checksum 或 rename 错误时 fail closed。rename 阶段的 `EXIT`/`HUP`/`INT`/`QUIT`/`TERM` trap 会使用不覆盖的移动和 device/inode 校验恢复原来的三个单元。SIGKILL、主机掉电和内核故障无法触发 trap。任何中断或不完整结果出现后，都必须让 Harness 保持停止，并根据记录的 invariant 核对输出的 active、hold 与 stage 路径；绝不能覆盖或合并它们。

恢复后的 profile 必须在停机前记录的同一绝对路径找到 immutable 原 checkout，且 commit 必须精确匹配。不能把它指向另一个目录，也不能用 `plugin add` 替代。使用相同 rc.6 版本组启动精确旧插件。`/api/lark/health` 只存在于 v0.5.0 及更高版本；v0.1.0–v0.4.0 必须使用历史 `[ws] ws client ready` gate，再完成一条可丢弃的端到端回复与会话恢复检查，不能仅因 HTTP 404 就判定插件失败。事件关闭前应保留 `rollback_hold`、`restore_stage`、快照以及 old/target 两个 immutable checkout。

恢复快照会把 transcript、回执、Workspace 注册/排序、项目/模型绑定和 mutation 历史全部倒退到快照时间；磁盘上的 Workspace 与外部副作用仍停留在当前时间。允许新 turn 前必须显式检查这种时间分裂。

## 故障恢复

- 降级后启动拒绝 `lark_conversations`，通常表示执行了不受支持的 v2 到 v1 回滚；应停止并恢复快照或前滚。
- 降到 v0.7 以下后打开错误 generation，表示旧版本忽略了提交权威；应在接收更多工作前停止，并恢复 v0.7 前快照。
- 降到 v0.3 以下后群上下文消失属于预期的作用域差异；不要删除或自动选择新版本 JSONL 日志。
- 恢复旧快照或降到 v0.1.3 以下后，可能在“至少一次”边界内重复处理；重试前先核对平台与工具副作用。
- 绝不能通过删除单个 storage-domain 文件解决状态错误。保留失败状态，只收集脱敏的版本/错误事实；没有已知良好快照时优先选择兼容前滚。
