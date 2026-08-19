export const LARK_LOCALES = ['zh-CN', 'en-US'] as const
export type LarkLocale = typeof LARK_LOCALES[number]

const PROJECT_DISPLAY_CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

function neutralizeProjectMarkup(value: string): string {
  return value.replaceAll('<', '＜').replaceAll('>', '＞')
}

interface ProjectListItem {
  readonly id: string
  readonly title: string
}

interface ModelSelectionItem {
  readonly provider: string
  readonly model: string
}

interface SessionListItem {
  readonly reference: string
  readonly title?: string
  readonly project?: string
  readonly createdAt?: string
  readonly current: boolean
}

interface ModelListItem {
  readonly provider: string
  readonly id: string
  readonly displayId: string
  readonly name: string
}

interface ModelListGroup {
  readonly id: string
  readonly displayId: string
  readonly name: string
  readonly models: readonly ModelListItem[]
}

function projectTitle(title: string, fallback: string): string {
  const normalized = title
    .replace(PROJECT_DISPLAY_CONTROL_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized === '') return fallback
  const safe = neutralizeProjectMarkup(normalized)
  const runes = [...safe]
  return runes.length <= 120 ? safe : `${runes.slice(0, 119).join('')}…`
}

function projectLabel(project: ProjectListItem, unnamed: string): string {
  return `${projectTitle(project.title, unnamed)} (${neutralizeProjectMarkup(project.id)})`
}

function sessionDisplay(value: string | undefined, fallback: string, limit = 80): string {
  if (value === undefined) return fallback
  const normalized = value
    .replace(PROJECT_DISPLAY_CONTROL_PATTERN, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (normalized === '') return fallback
  const safe = neutralizeProjectMarkup(normalized)
  const runes = [...safe]
  return runes.length <= limit ? safe : `${runes.slice(0, limit - 1).join('')}…`
}

function modelRouteLabel(selection: ModelSelectionItem): string {
  return `${selection.provider} / ${selection.model}`
}

function byteLimit(bytes: number, byteUnit: string): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} ${byteUnit}`
}

function currentModelLabel(
  current: ModelSelectionItem,
  groups: readonly ModelListGroup[],
  locale: LarkLocale,
): string {
  const group = groups.find((candidate) => candidate.id === current.provider)
  const model = group?.models.find((candidate) => candidate.id === current.model)
  if (model === undefined || group === undefined) return modelRouteLabel(current)
  return locale === 'zh-CN'
    ? `${model.name}（${group.name}；${group.displayId} / ${model.displayId}）`
    : `${model.name} (${group.name}; ${group.displayId} / ${model.displayId})`
}

function modelCatalogRows(
  current: ModelSelectionItem,
  groups: readonly ModelListGroup[],
  locale: LarkLocale,
): string[] {
  return groups.flatMap((group) => {
    const heading = locale === 'zh-CN'
      ? `${group.name}（${group.displayId}）`
      : `${group.name} (${group.displayId})`
    const models = group.models.map((item) => {
      const selected = item.provider === current.provider && item.id === current.model
      if (locale === 'zh-CN') {
        return `- ${item.name}（${item.displayId}）${selected ? ' [当前]' : ''}`
      }
      return `- ${item.name} (${item.displayId})${selected ? ' [current]' : ''}`
    })
    return [heading, ...models]
  })
}

function zhModelList(
  current: ModelSelectionItem,
  groups: readonly ModelListGroup[],
  routable: boolean,
  partial: boolean,
  truncated: boolean,
): string {
  const currentLabel = currentModelLabel(current, groups, 'zh-CN')
  const lines = [`当前模型：${currentLabel}${routable ? '' : ' [提供方不可用]'}`]
  lines.push(groups.length === 0 ? '当前可发现模型：无' : '当前可发现模型：')
  lines.push(...modelCatalogRows(current, groups, 'zh-CN'))
  if (partial) lines.push('部分提供方的模型列表加载失败；其余模型仍可切换。')
  if (truncated) lines.push('模型列表过长，已截断；仍可使用完整的提供方 ID 和模型 ID 切换。')
  lines.push('用法：/model <提供方 ID> <模型 ID>')
  return lines.join('\n')
}

function enModelList(
  current: ModelSelectionItem,
  groups: readonly ModelListGroup[],
  routable: boolean,
  partial: boolean,
  truncated: boolean,
): string {
  const currentLabel = currentModelLabel(current, groups, 'en-US')
  const lines = [`Current model: ${currentLabel}${routable ? '' : ' [provider unavailable]'}`]
  lines.push(groups.length === 0 ? 'Currently discoverable models: none' : 'Currently discoverable models:')
  lines.push(...modelCatalogRows(current, groups, 'en-US'))
  if (partial) lines.push('Some provider catalogs failed to load; the remaining models can still be selected.')
  if (truncated) lines.push('The model list was truncated; a full provider ID and model ID can still be selected.')
  lines.push('Usage: /model <provider ID> <model ID>')
  return lines.join('\n')
}

interface LocaleCopy {
  readonly bridge: {
    readonly help: string
    readonly operatorHelp: string
    readonly taskHelp: string
    readonly operatorOnly: string
    readonly policyUpdated: string
    readonly policyUsage: string
    readonly policyUnavailable: string
    readonly policyFull: string
    readonly taskUnavailable: string
    readonly taskUsage: string
    readonly taskAtCapacity: string
    readonly taskWorkspaceBusy: string
    readonly taskUnknown: string
    readonly taskNotLive: string
    readonly taskEmpty: string
    readonly taskStopped: string
    readonly taskListTruncated: (hidden: number) => string
    readonly documentReadCallTitle: string
    readonly documentPublishCallTitle: string
    readonly documentUntitled: string
    readonly documentPublished: string
    readonly denied: string
    readonly unsupportedInput: string
    readonly inboundTextFileInvalid: string
    readonly inboundTextFileUnavailable: string
    inboundTextFileTooLarge(maxBytes: number): string
    readonly inboundImageInvalid: string
    readonly inboundImageUnavailable: string
    readonly inboundImageBusy: string
    readonly inboundImageModelUnsupported: string
    inboundImageTooLarge(maxBytes: number): string
    inboundImageTooManyPixels(maxPixels: number): string
    readonly inboundImageAggregateLimit: string
    readonly outboundArtifactCallTitle: string
    readonly outboundArtifactSentTitle: string
    readonly outboundArtifactFailedTitle: string
    readonly outboundArtifactConfirmed: string
    readonly outboundArtifactNotConfirmed: string
    readonly outboundArtifactNotSent: string
    readonly outboundArtifactUploadUnknown: string
    readonly outboundArtifactDeliveryUnknown: string
    readonly outboundArtifactSentBeforeInterrupt: string
    outboundArtifactApprovalReason(kind: 'file' | 'image', name: string, bytes: number): string
    readonly notifyCallTitle: string
    readonly notifyAdmittedTitle: string
    readonly notifyFailedTitle: string
    readonly notifyAdmitted: string
    readonly notifyNotAdmitted: string
    readonly followupFailure: string
    readonly cardUnavailable: string
    readonly approvalUnauthorized: string
    readonly approvalMalformed: string
    readonly approvalExpired: string
    readonly approvalWrongContext: string
    readonly approvalAllowed: string
    readonly approvalRejected: string
    readonly humanInputUnauthorized: string
    readonly humanInputMalformed: string
    readonly humanInputExpired: string
    readonly humanInputWrongContext: string
    readonly humanInputSubmitted: string
    readonly humanInputCancelled: string
    readonly humanInputIncomplete: string
    readonly interrupted: string
    readonly shutdownInterrupted: string
    readonly maxTokens: string
    readonly blocked: string
    readonly cancelled: string
    readonly freshSession: string
    readonly freshSessionFailed: string
    readonly stopRequested: string
    readonly stopExpired: string
    readonly stopUnavailable: string
    readonly stopWrongContext: string
    readonly commandFailed: string
    readonly longAnswer: string
    readonly projectUnavailable: string
    readonly projectUnknown: string
    readonly projectAmbiguous: string
    readonly projectBusy: string
    readonly projectHistoryCheckpointFailed: string
    readonly projectSwitchFailed: string
    readonly projectMutationReplayed: string
    readonly projectManagementDenied: string
    readonly projectManagementDirectOnly: string
    readonly projectRegisterUsage: string
    readonly projectRemoveUsage: string
    readonly projectRegistrationUnavailable: string
    readonly projectRegistrationFailed: string
    readonly projectRemovalFailed: string
    readonly projectRegistryMutationReplayed: string
    readonly sessionUnavailable: string
    readonly sessionUsage: string
    readonly sessionUnknown: string
    readonly sessionBusy: string
    readonly sessionHistoryCheckpointFailed: string
    readonly sessionImageHistoryUnsupported: string
    readonly sessionResumeFailed: string
    readonly sessionMutationReplayed: string
    readonly modelUnavailable: string
    readonly modelUnknown: string
    readonly modelBusy: string
    readonly modelImageHistoryUnsupported: string
    readonly modelSwitchFailed: string
    readonly modelMutationReplayed: string
    readonly imageHistoryModelUnsupported: string
    readonly imageHistoryUnavailable: string
    readonly imageHistoryBusy: string
    projectList(
      currentId: string | undefined,
      projects: readonly ProjectListItem[],
      canRegisterCurrent: boolean,
    ): string
    projectMissingDirectory(project: ProjectListItem): string
    projectAlreadyCurrent(project: ProjectListItem): string
    projectSwitched(project: ProjectListItem): string
    projectRegistered(project: ProjectListItem): string
    projectAlreadyRegistered(project: ProjectListItem): string
    projectRemoved(project: ProjectListItem): string
    sessionList(
      page: number,
      totalPages: number,
      sessions: readonly SessionListItem[],
      truncated: boolean,
    ): string
    sessionAlreadyCurrent(): string
    sessionResumed(): string
    modelList(
      current: ModelSelectionItem,
      groups: readonly ModelListGroup[],
      routable: boolean,
      partial: boolean,
      truncated: boolean,
    ): string
    modelAlreadyCurrent(selection: ModelSelectionItem): string
    modelSwitched(selection: ModelSelectionItem): string
    commandDescription(name: string, fallback: string): string
    unknownCommand(command: string): string
    unknownTurnEnd(kind: string): string
  }
  readonly card: {
    readonly executionTitle: string
    readonly running: string
    readonly completed: string
    readonly failed: string
    readonly blocked: string
    readonly cancelled: string
    readonly limited: string
    readonly earlierTools: string
    readonly seconds: string
    readonly context: string
    readonly inputTokens: string
    readonly outputTokens: string
    readonly cacheReadTokens: string
    readonly cacheWriteTokens: string
    readonly reasoningTokens: string
    readonly stop: string
    readonly approvalTitle: string
    readonly approvalSummary: string
    readonly approvalTool: string
    readonly approvalReason: string
    readonly approvalRule: string
    readonly allowOnce: string
    readonly deny: string
    readonly approved: string
    readonly rejected: string
    readonly approvalCancelled: string
    readonly approvalUnavailable: string
    readonly humanInputTitle: string
    readonly humanInputSummary: string
    readonly humanInputSafety: string
    readonly humanInputSubmit: string
    readonly humanInputCancel: string
    readonly humanInputSelectPlaceholder: string
    readonly humanInputCustomPlaceholder: string
    readonly humanInputTextPlaceholder: string
    readonly humanInputSubmitted: string
    readonly humanInputCancelled: string
    readonly humanInputTimedOut: string
    readonly humanInputUnavailable: string
    readonly planTitle: string
    readonly earlierTodos: string
    readonly notifyCompletionTitle: string
    readonly notifyAttentionTitle: string
    readonly statusTitle: string
    readonly diagTitle: string
    readonly policyTitle: string
    readonly taskTitle: string
    readonly taskCreatedTitle: string
    readonly taskSettledTitle: string
  }
  readonly event: {
    readonly command: string
    readonly compaction: string
    readonly prune: string
    readonly goal: string
    readonly hook: string
    readonly retry: string
    readonly workflow: string
    readonly workflowAgent: string
  }
}

const COPY: Record<LarkLocale, LocaleCopy> = {
  'zh-CN': {
    bridge: {
      help: [
        '/new — 开始新会话',
        '/clear — 重置当前会话',
        '/project [项目名或 ID] — 查看或切换项目',
        '/project register <名称> — 注册当前项目（仅项目管理员私聊）',
        '/project remove <完整 ID> — 移除项目注册（仅项目管理员私聊）',
        '/session [list [页码]] — 列出当前范围内可恢复的会话',
        '/session resume <会话引用> — 继续一条已有会话',
        '/model [提供方 ID] [模型 ID] — 查看或切换模型',
        '/help — 显示帮助',
      ].join('\n'),
      taskHelp: [
        '/task [list] — 列出本会话的并行任务',
        '/task run <指令> — 新建一个并行任务',
        '/task <编号> — 查看某个任务',
        '/task stop <编号> — 停止某个任务',
      ].join('\n'),
      operatorHelp: [
        '/status — 查看当前通道状态（仅运维）',
        '/diag — 运行脱敏诊断（仅运维）',
        '/policy — 查看本会话策略（仅运维）',
        '/policy set … — 收紧本会话授权、提及、项目、模型与工具策略（仅运维）',
      ].join('\n'),
      operatorOnly: '该命令仅限运维人员。',
      policyUpdated: '已更新本会话策略。',
      policyUsage: [
        '用法：/policy',
        '/policy set approvals|artifacts|notify on|off',
        '/policy set mention always|default',
        '/policy set users add|remove <open_id>',
        '/policy set users clear',
        '/policy set projects add|remove <id>',
        '/policy set projects all',
        '/policy set models add|remove <provider> <model>',
        '/policy set models all',
      ].join('\n'),
      policyUnavailable: '会话策略暂不可用。',
      policyFull: '该策略列表已满，请先移除条目。',
      taskUnavailable: '并行任务未启用。',
      taskUsage: [
        '用法：/task 或 /task list — 列出本会话的并行任务',
        '/task run <指令> — 新建一个并行任务',
        '/task <编号> — 查看某个任务',
        '/task stop <编号> — 停止某个任务',
      ].join('\n'),
      taskAtCapacity: '本会话的并行任务已达上限，请先停止一个。',
      taskWorkspaceBusy: '已有并行任务占用该项目。请等它结束，或改为共享项目配置。',
      taskUnknown: '找不到该任务编号。',
      taskNotLive: '该任务已经结束。',
      taskEmpty: '本会话还没有并行任务。',
      taskStopped: '已停止该任务。',
      taskListTruncated: (hidden) => `…另有 ${hidden} 个较早的任务未显示。`,
      documentReadCallTitle: '读取云文档',
      documentPublishCallTitle: '发布云文档',
      documentUntitled: '未命名文档',
      documentPublished: '已发布文档。',
      denied: '没有权限。',
      unsupportedInput: '暂不支持图片、文件或其他非文本消息，请改用文字发送。',
      inboundTextFileInvalid: '无法读取该附件。仅支持安全文件名的 UTF-8 .txt、.log、.patch 和 .diff 文本文件。',
      inboundTextFileUnavailable: '附件下载暂不可用，请重新发送或改用文字。',
      inboundTextFileTooLarge: (maxBytes) => `文本附件过大（上限 ${byteLimit(maxBytes, '字节')}）。`,
      inboundImageInvalid: '无法安全读取该图片。仅支持单幅静态 PNG 或 JPEG。',
      inboundImageUnavailable: '图片暂时无法安全接收，请稍后重试或改用文字。',
      inboundImageBusy: '正在处理另一张图片，请稍后重新发送。',
      inboundImageModelUnsupported: '当前模型未明确支持图片输入，请先用 /model 选择支持图片的模型。',
      inboundImageTooLarge: (maxBytes) => `图片过大（上限 ${byteLimit(maxBytes, '字节')}）。`,
      inboundImageTooManyPixels: (maxPixels) => `图片像素过多（上限 ${maxPixels} 像素）。`,
      inboundImageAggregateLimit: '当前会话的图片数量或总字节数已达到上限；请先开始新会话或压缩历史。',
      outboundArtifactCallTitle: '发送经审批的 Lark 产物',
      outboundArtifactSentTitle: '产物已发送',
      outboundArtifactFailedTitle: '产物未发送',
      outboundArtifactConfirmed: '已确认产物发送到发起本轮的 Lark 会话。',
      outboundArtifactNotConfirmed: '产物发送未确认，请勿自动重试。',
      outboundArtifactNotSent: '产物因校验、审批或权限变化而未发送。',
      outboundArtifactUploadUnknown: '产物未投递；平台可能保留了已上传对象，请勿自动重试。',
      outboundArtifactDeliveryUnknown: '产物投递结果未知，请勿自动重试。',
      outboundArtifactSentBeforeInterrupt: '产物在中断前已确认投递，请勿再次发送。',
      outboundArtifactApprovalReason: (kind, name, bytes) => (
        `将已审批的 Workspace ${kind === 'image' ? '图片' : '文件'}“${name}”（${bytes} 字节）发送到发起本轮的 Lark 会话。`
      ),
      notifyCallTitle: '发送 Lark 通知',
      notifyAdmittedTitle: '通知已受理',
      notifyFailedTitle: '通知未受理',
      notifyAdmitted: '已将通知写入当前注册会话的可靠发件箱。',
      notifyNotAdmitted: '通知未受理：会话未注册、参数无效或已达速率上限。',
      followupFailure: '消息提交失败，请重试。',
      cardUnavailable: '卡片操作暂不可用。',
      approvalUnauthorized: '无权执行此操作。',
      approvalMalformed: '审批操作无效。',
      approvalExpired: '审批已处理或过期。',
      approvalWrongContext: '只能由发起用户在原会话中处理。',
      approvalAllowed: '已允许一次。',
      approvalRejected: '已拒绝。',
      humanInputUnauthorized: '无权提交这份回答。',
      humanInputMalformed: '回答格式无效，请检查后重试。',
      humanInputExpired: '这份问题已处理或过期。',
      humanInputWrongContext: '只能由发起用户在原会话中回答。',
      humanInputSubmitted: '回答已接收。',
      humanInputCancelled: '已取消回答。',
      humanInputIncomplete: '请完成每个问题后再提交。',
      interrupted: '执行被运行时中断。',
      shutdownInterrupted: '服务关闭已中断此卡片的实时执行；持久化结果未确认，请重启后检查会话并按需重试。',
      maxTokens: '模型达到输出上限。',
      blocked: '执行被阻塞。',
      cancelled: '执行已取消。',
      freshSession: '已开始新会话。',
      freshSessionFailed: '无法安全开始新会话，当前会话保持不变；请等待现有任务完成后重试。',
      stopRequested: '正在停止。',
      stopExpired: '该执行已结束或停止。',
      stopUnavailable: '暂时无法停止。',
      stopWrongContext: '只能由发起用户在原会话中停止。',
      commandFailed: '命令执行失败，请重试。',
      longAnswer: '回复较长，以下为完整内容：',
      projectUnavailable: '项目列表暂不可用，请稍后重试。',
      projectUnknown: '未找到该已注册项目。发送 /project 查看可用项目。',
      projectAmbiguous: '有多个项目使用该名称，请改用 /project 列出的完整 ID。',
      projectBusy: '当前会话仍有执行或待处理消息，请等待完成后重试。',
      projectHistoryCheckpointFailed: '无法确认当前会话历史已保存，项目未切换；请检查持久化存储后重试。',
      projectSwitchFailed: '项目切换失败，当前会话保持不变，请重试。',
      projectMutationReplayed: '该项目切换已处理；当前会话保持最新状态。',
      projectManagementDenied: '你没有项目注册管理权限。',
      projectManagementDirectOnly: '项目注册管理只能在与机器人的私聊中执行。',
      projectRegisterUsage: '用法：/project register <项目名称>。该命令只注册当前会话正在使用的目录。',
      projectRemoveUsage: '用法：/project remove <完整 Workspace ID>。',
      projectRegistrationUnavailable: '项目注册管理暂不可用，请检查 Workspace、会话持久化与项目管理员配置。',
      projectRegistrationFailed: '项目注册失败；未接受新的项目管理操作，请检查存储后重启服务。',
      projectRemovalFailed: '项目注册移除失败；未接受新的项目管理操作，请检查存储后重启服务。',
      projectRegistryMutationReplayed: '该项目注册管理操作已处理；发送 /project 查看当前列表。',
      sessionUnavailable: '会话导航暂不可用，请检查 Session Query、Workspace 与会话持久化。',
      sessionUsage: '用法：/session、/session list [页码] 或 /session resume <完整会话引用>。',
      sessionUnknown: '当前会话范围内没有该可恢复会话引用。请重新发送 /session 获取列表。',
      sessionBusy: '当前会话仍有执行或待处理消息，未恢复其他会话；请等待完成后重试。',
      sessionHistoryCheckpointFailed: '无法确认当前会话历史已保存，未恢复其他会话；请检查持久化存储后重试。',
      sessionImageHistoryUnsupported: '目标会话包含图片，但其保存模型未明确支持图片输入；当前会话保持不变。',
      sessionResumeFailed: '会话恢复失败，当前会话保持不变；请稍后重试。',
      sessionMutationReplayed: '该会话恢复操作已处理；当前会话保持最新状态。',
      modelUnavailable: '模型列表暂不可用，请稍后重试。',
      modelUnknown: '未找到该模型路由。发送 /model 查看可发现模型，或使用完整的提供方 ID 和模型 ID。',
      modelBusy: '当前会话仍有执行或待处理消息，请等待完成后重试。',
      modelImageHistoryUnsupported: '当前会话包含图片，不能切换到未明确支持图片输入的模型。',
      modelSwitchFailed: '无法确认模型选择已保存，当前模型保持不变；请检查持久化存储后重试。',
      modelMutationReplayed: '该模型切换已处理；当前会话保持最新状态。',
      imageHistoryModelUnsupported: '当前会话包含图片，但当前模型未明确支持图片输入。请先使用 /model 切换到兼容模型。',
      imageHistoryUnavailable: '暂时无法确认图片历史与模型是否兼容，请检查模型服务后重试。',
      imageHistoryBusy: '会话图片历史正在变化，请稍后重试。',
      projectList: (currentId, projects, canRegisterCurrent) => {
        const current = projects.find((project) => project.id === currentId)
        const currentLine = current === undefined
          ? '当前项目：未关联已注册项目'
          : `当前项目：${projectLabel(current, '未命名项目')}`
        if (projects.length === 0) {
          const guidance = canRegisterCurrent
            ? '\n发送 /project register <名称> 注册当前会话正在使用的目录。'
            : ''
          return `${currentLine}\n已注册项目：无${guidance}`
        }
        const items = projects.map((project) => (
          `- ${projectLabel(project, '未命名项目')}${project.id === currentId ? ' [当前]' : ''}`
        ))
        return `${currentLine}\n已注册项目：\n${items.join('\n')}`
      },
      projectMissingDirectory: (project) => (
        `项目 ${projectLabel(project, '未命名项目')} 的目录不存在，未切换会话。`
      ),
      projectAlreadyCurrent: (project) => (
        `当前已是项目 ${projectLabel(project, '未命名项目')}。`
      ),
      projectSwitched: (project) => (
        `已切换到项目 ${projectLabel(project, '未命名项目')}，并开始新会话。`
      ),
      projectRegistered: (project) => (
        `已注册当前项目：${projectLabel(project, '未命名项目')}。当前会话保持不变。`
      ),
      projectAlreadyRegistered: (project) => (
        `当前目录已注册为项目 ${projectLabel(project, '未命名项目')}；未修改原名称。`
      ),
      projectRemoved: (project) => (
        `已移除项目注册 ${projectLabel(project, '未命名项目')}；目录、文件、会话和历史记录均未删除。`
      ),
      sessionList: (page, totalPages, sessions, truncated) => {
        const lines = [`可恢复会话 ${page}/${totalPages}：`]
        if (sessions.length === 0) lines.push('当前范围内没有可恢复会话。')
        for (const session of sessions) {
          const title = sessionDisplay(session.title, '未命名会话')
          const project = sessionDisplay(session.project, '未注册项目', 120)
          lines.push(`- ${title} · 项目：${project} · 创建：${session.createdAt ?? '时间未知'} · ${session.reference}${session.current ? ' [当前]' : ''}`)
        }
        if (truncated) lines.push('还有更多会话未显示。')
        lines.push('使用 /session resume <完整会话引用> 继续已有对话记录。')
        return lines.join('\n')
      },
      sessionAlreadyCurrent: () => '该引用已是当前会话。',
      sessionResumed: () => '已恢复所选会话；后续消息将继续其已有对话记录。',
      modelList: zhModelList,
      modelAlreadyCurrent: (selection) => `当前已是模型 ${modelRouteLabel(selection)}。`,
      modelSwitched: (selection) => (
        `已切换到模型 ${modelRouteLabel(selection)}；从下一个模型步骤起生效。`
      ),
      commandDescription: (name, fallback) => ({
        compact: '整理较早的会话上下文',
        goal: '查看或设置长任务目标',
        permission: '查看或切换权限预设',
        plan: '进入或退出计划模式',
      } satisfies Record<string, string>)[name] ?? fallback,
      unknownCommand: (command) => `未知命令 ${command}，发送 /help 查看帮助。`,
      unknownTurnEnd: (kind) => `无法识别的执行结果：${kind}`,
    },
    card: {
      executionTitle: '🧠 **执行过程**',
      running: '运行',
      completed: '完成',
      failed: '执行失败',
      blocked: '执行受阻',
      cancelled: '已取消',
      limited: '达到输出上限',
      earlierTools: '个更早的工具调用已折叠',
      seconds: 's',
      context: 'Ctx',
      inputTokens: 'In',
      outputTokens: 'Out',
      cacheReadTokens: 'Hit',
      cacheWriteTokens: 'Wr',
      reasoningTokens: 'Rsn',
      stop: '停止执行',
      approvalTitle: '需要你的确认',
      approvalSummary: '需要确认',
      approvalTool: '工具',
      approvalReason: '原因',
      approvalRule: '仅授权这一次调用。',
      allowOnce: '允许一次',
      deny: '拒绝',
      approved: '已批准',
      rejected: '已拒绝',
      approvalCancelled: '审批已取消',
      approvalUnavailable: '审批不可用',
      humanInputTitle: '需要你的输入',
      humanInputSummary: '等待回答',
      humanInputSafety: '不要在此输入凭据、密钥、Token 或其他秘密。',
      humanInputSubmit: '提交回答',
      humanInputCancel: '取消',
      humanInputSelectPlaceholder: '请选择',
      humanInputCustomPlaceholder: '其他回答（会覆盖已选项）',
      humanInputTextPlaceholder: '请输入回答',
      humanInputSubmitted: '回答已接收',
      humanInputCancelled: '问题已取消',
      humanInputTimedOut: '问题已超时',
      humanInputUnavailable: '问题不可用',
      planTitle: '📋 **计划**',
      earlierTodos: '个更早的计划项已折叠',
      notifyCompletionTitle: '任务完成',
      notifyAttentionTitle: '需要关注',
      statusTitle: '通道状态',
      diagTitle: '通道诊断',
      policyTitle: '会话策略',
      taskTitle: '并行任务',
      taskCreatedTitle: '任务已启动',
      taskSettledTitle: '任务已结束',
    },
    event: {
      command: '命令',
      compaction: '压缩上下文',
      prune: '整理上下文',
      goal: '目标',
      hook: 'Hook',
      retry: '模型重试',
      workflow: '工作流',
      workflowAgent: '子任务',
    },
  },
  'en-US': {
    bridge: {
      help: [
        '/new — start a fresh session',
        '/clear — reset the current session',
        '/project [name or ID] — list or switch projects',
        '/project register <title> — register the current project (project-manager DM only)',
        '/project remove <full ID> — remove a registration (project-manager DM only)',
        '/session [list [page]] — list resumable sessions in this conversation scope',
        '/session resume <reference> — continue an existing session',
        '/model [provider ID] [model ID] — list or switch models',
        '/help — show this help',
      ].join('\n'),
      taskHelp: [
        '/task [list] — list this conversation\'s parallel tasks',
        '/task run <instruction> — start one parallel task',
        '/task <reference> — inspect one task',
        '/task stop <reference> — stop one task',
      ].join('\n'),
      operatorHelp: [
        '/status — show channel status (operators only)',
        '/diag — run a sanitized diagnostic (operators only)',
        '/policy — show this conversation policy (operators only)',
        '/policy set … — narrow this conversation user, mention, project, model, and tool policy (operators only)',
      ].join('\n'),
      operatorOnly: 'This command is limited to operators.',
      policyUpdated: 'Updated this conversation policy.',
      policyUsage: [
        'Usage: /policy',
        '/policy set approvals|artifacts|notify on|off',
        '/policy set mention always|default',
        '/policy set users add|remove <open_id>',
        '/policy set users clear',
        '/policy set projects add|remove <id>',
        '/policy set projects all',
        '/policy set models add|remove <provider> <model>',
        '/policy set models all',
      ].join('\n'),
      policyUnavailable: 'Conversation policy is unavailable.',
      policyFull: 'This policy list is full. Remove an entry first.',
      taskUnavailable: 'Parallel tasks are not enabled.',
      taskUsage: [
        'Usage: /task or /task list — list this conversation\'s parallel tasks',
        '/task run <instruction> — start one parallel task',
        '/task <reference> — inspect one task',
        '/task stop <reference> — stop one task',
      ].join('\n'),
      taskAtCapacity: 'This conversation is at its parallel task limit. Stop one first.',
      taskWorkspaceBusy: 'Another parallel task holds this project. Wait for it, or configure shared projects.',
      taskUnknown: 'No task matches that reference.',
      taskNotLive: 'That task has already finished.',
      taskEmpty: 'This conversation has no parallel tasks yet.',
      taskStopped: 'Stopped that task.',
      taskListTruncated: (hidden) => `…and ${hidden} older task${hidden === 1 ? '' : 's'} not shown.`,
      documentReadCallTitle: 'Read a document',
      documentPublishCallTitle: 'Publish a document',
      documentUntitled: 'Untitled document',
      documentPublished: 'Published the document.',
      denied: "You don't have permission.",
      unsupportedInput: 'Images, files, and other non-text messages are not supported yet. Please send text.',
      inboundTextFileInvalid: 'This attachment cannot be read. Only UTF-8 .txt, .log, .patch, and .diff files with safe names are accepted.',
      inboundTextFileUnavailable: 'Attachment download is temporarily unavailable. Send it again or use text.',
      inboundTextFileTooLarge: (maxBytes) => `The text attachment is too large (limit: ${byteLimit(maxBytes, 'bytes')}).`,
      inboundImageInvalid: 'This image cannot be read safely. Only one static PNG or JPEG is accepted.',
      inboundImageUnavailable: 'The image cannot be admitted safely right now. Try again later or use text.',
      inboundImageBusy: 'Another image is being processed. Resend this image later.',
      inboundImageModelUnsupported: 'The current model does not explicitly support image input. Select an image-capable model with /model first.',
      inboundImageTooLarge: (maxBytes) => `The image is too large (limit: ${byteLimit(maxBytes, 'bytes')}).`,
      inboundImageTooManyPixels: (maxPixels) => `The image has too many pixels (limit: ${maxPixels} pixels).`,
      inboundImageAggregateLimit: 'This conversation reached its image count or byte limit. Start a fresh Session or compact its history first.',
      outboundArtifactCallTitle: 'Send approved Lark artifact',
      outboundArtifactSentTitle: 'Artifact sent',
      outboundArtifactFailedTitle: 'Artifact not sent',
      outboundArtifactConfirmed: 'Artifact delivery to the originating Lark conversation was confirmed.',
      outboundArtifactNotConfirmed: 'Artifact delivery was not confirmed. Do not retry automatically.',
      outboundArtifactNotSent: 'Artifact was not sent because validation, approval, or authority failed.',
      outboundArtifactUploadUnknown: 'Artifact was not delivered; an uploaded platform object may remain. Do not retry automatically.',
      outboundArtifactDeliveryUnknown: 'Artifact delivery outcome is unknown. Do not retry automatically.',
      outboundArtifactSentBeforeInterrupt: 'Artifact delivery was confirmed before interruption. Do not send it again.',
      outboundArtifactApprovalReason: (kind, name, bytes) => (
        `Send approved Workspace ${kind} "${name}" (${bytes} bytes) to the originating Lark conversation.`
      ),
      notifyCallTitle: 'Send Lark notification',
      notifyAdmittedTitle: 'Notification admitted',
      notifyFailedTitle: 'Notification not admitted',
      notifyAdmitted: 'The notification was admitted to the registered conversation outbox.',
      notifyNotAdmitted: 'The notification was not admitted because the conversation is unregistered, the arguments are invalid, or the rate limit was reached.',
      followupFailure: 'Message submission failed. Please try again.',
      cardUnavailable: 'Card actions are temporarily unavailable.',
      approvalUnauthorized: 'You cannot perform this action.',
      approvalMalformed: 'Invalid approval action.',
      approvalExpired: 'This approval was already handled or expired.',
      approvalWrongContext: 'Only the initiating user can decide in the original chat.',
      approvalAllowed: 'Allowed once.',
      approvalRejected: 'Denied.',
      humanInputUnauthorized: 'You cannot submit this answer.',
      humanInputMalformed: 'The answer format is invalid. Check it and try again.',
      humanInputExpired: 'This question was already handled or expired.',
      humanInputWrongContext: 'Only the initiating user can answer in the original chat.',
      humanInputSubmitted: 'Answer received.',
      humanInputCancelled: 'Answer cancelled.',
      humanInputIncomplete: 'Complete every question before submitting.',
      interrupted: 'Execution was interrupted by the runtime.',
      shutdownInterrupted: 'Service shutdown interrupted this live execution Card. Its durable result is unconfirmed; check the Session after restart and retry if needed.',
      maxTokens: 'The model reached its output limit.',
      blocked: 'Execution was blocked.',
      cancelled: 'Execution was cancelled.',
      freshSession: 'Started a fresh session.',
      freshSessionFailed: 'A fresh session could not be started safely. The current session was left unchanged; wait for existing work to finish and try again.',
      stopRequested: 'Stopping.',
      stopExpired: 'This run has already ended or stopped.',
      stopUnavailable: 'Unable to stop this run.',
      stopWrongContext: 'Only the initiating user can stop this run in the original chat.',
      commandFailed: 'Command execution failed. Please try again.',
      longAnswer: 'The reply is long. Here is the complete content:',
      projectUnavailable: 'The project list is unavailable. Please try again later.',
      projectUnknown: 'No registered project matched. Send /project to list available projects.',
      projectAmbiguous: 'More than one project uses that name. Use a full ID from /project.',
      projectBusy: 'This conversation still has running or pending work. Wait for it to finish and try again.',
      projectHistoryCheckpointFailed: 'The current transcript could not be confirmed durable, so the project was not switched. Check session storage and try again.',
      projectSwitchFailed: 'Project switch failed. The current session was left unchanged. Please try again.',
      projectMutationReplayed: 'That project switch was already handled. The conversation remains at its latest state.',
      projectManagementDenied: 'You do not have project registration management permission.',
      projectManagementDirectOnly: 'Project registration management is available only in a direct chat with the bot.',
      projectRegisterUsage: 'Usage: /project register <project title>. This registers only the directory already used by the current session.',
      projectRemoveUsage: 'Usage: /project remove <full Workspace ID>.',
      projectRegistrationUnavailable: 'Project registration management is unavailable. Check Workspace, session persistence, and project-manager configuration.',
      projectRegistrationFailed: 'Project registration failed. No new project-management operations are accepted until storage is checked and the service restarts.',
      projectRemovalFailed: 'Removing the project registration failed. No new project-management operations are accepted until storage is checked and the service restarts.',
      projectRegistryMutationReplayed: 'That project registration operation was already handled. Send /project to inspect the current list.',
      sessionUnavailable: 'Session navigation is unavailable. Check Session Query, Workspace, and session persistence.',
      sessionUsage: 'Usage: /session, /session list [page], or /session resume <full session reference>.',
      sessionUnknown: 'No resumable session with that reference is visible in this conversation. Run /session again.',
      sessionBusy: 'This conversation still has running or pending work. No other session was resumed; wait and try again.',
      sessionHistoryCheckpointFailed: 'The current transcript could not be confirmed durable, so no other session was resumed. Check session storage and try again.',
      sessionImageHistoryUnsupported: 'The target Session contains images, but its saved model does not explicitly support image input. The current Session is unchanged.',
      sessionResumeFailed: 'Session resume failed. The current session was left unchanged; try again later.',
      sessionMutationReplayed: 'That session resume was already handled. The conversation remains at its latest state.',
      modelUnavailable: 'The model list is unavailable. Please try again later.',
      modelUnknown: 'No model route matched. Send /model to list discoverable models, or use the full provider ID and model ID.',
      modelBusy: 'This conversation still has running or pending work. Wait for it to finish and try again.',
      modelImageHistoryUnsupported: 'This conversation contains images and cannot switch to a model that does not explicitly support image input.',
      modelSwitchFailed: 'The model selection could not be confirmed durable. The current model was left unchanged; check session storage and try again.',
      modelMutationReplayed: 'That model switch was already handled. The conversation remains at its latest state.',
      imageHistoryModelUnsupported: 'This conversation contains images, but the current model does not explicitly support image input. Use /model to select a compatible model first.',
      imageHistoryUnavailable: 'Image-history compatibility cannot be confirmed right now. Check the model service and try again.',
      imageHistoryBusy: 'The conversation image surface is changing. Try again shortly.',
      projectList: (currentId, projects, canRegisterCurrent) => {
        const current = projects.find((project) => project.id === currentId)
        const currentLine = current === undefined
          ? 'Current project: no registered project'
          : `Current project: ${projectLabel(current, 'Untitled project')}`
        if (projects.length === 0) {
          const guidance = canRegisterCurrent
            ? '\nSend /project register <title> to register the directory already used by this session.'
            : ''
          return `${currentLine}\nRegistered projects: none${guidance}`
        }
        const items = projects.map((project) => (
          `- ${projectLabel(project, 'Untitled project')}${project.id === currentId ? ' [current]' : ''}`
        ))
        return `${currentLine}\nRegistered projects:\n${items.join('\n')}`
      },
      projectMissingDirectory: (project) => (
        `The directory for ${projectLabel(project, 'Untitled project')} is missing. The session was not switched.`
      ),
      projectAlreadyCurrent: (project) => (
        `${projectLabel(project, 'Untitled project')} is already the current project.`
      ),
      projectSwitched: (project) => (
        `Switched to ${projectLabel(project, 'Untitled project')} and started a fresh session.`
      ),
      projectRegistered: (project) => (
        `Registered the current project as ${projectLabel(project, 'Untitled project')}. The current session is unchanged.`
      ),
      projectAlreadyRegistered: (project) => (
        `The current directory is already registered as ${projectLabel(project, 'Untitled project')}; its existing title was not changed.`
      ),
      projectRemoved: (project) => (
        `Removed the registration for ${projectLabel(project, 'Untitled project')}. No directory, file, session, or transcript was deleted.`
      ),
      sessionList: (page, totalPages, sessions, truncated) => {
        const lines = [`Resumable sessions ${page}/${totalPages}:`]
        if (sessions.length === 0) lines.push('No resumable sessions are available in this conversation.')
        for (const session of sessions) {
          const title = sessionDisplay(session.title, 'Untitled session')
          const project = sessionDisplay(session.project, 'Unregistered project', 120)
          lines.push(`- ${title} · Project: ${project} · Created: ${session.createdAt ?? 'unknown'} · ${session.reference}${session.current ? ' [current]' : ''}`)
        }
        if (truncated) lines.push('Additional sessions were omitted from this bounded list.')
        lines.push('Use /session resume <full session reference> to continue an existing transcript.')
        return lines.join('\n')
      },
      sessionAlreadyCurrent: () => 'That reference is already the current session.',
      sessionResumed: () => 'Resumed the selected session. New messages will continue its existing transcript.',
      modelList: enModelList,
      modelAlreadyCurrent: (selection) => `${modelRouteLabel(selection)} is already the current model.`,
      modelSwitched: (selection) => (
        `Switched to ${modelRouteLabel(selection)}; it takes effect from the next model step.`
      ),
      commandDescription: (_name, fallback) => fallback,
      unknownCommand: (command) => `Unknown command ${command}. Send /help.`,
      unknownTurnEnd: (kind) => `Unknown execution result: ${kind}`,
    },
    card: {
      executionTitle: '🧠 **Execution**',
      running: 'Running',
      completed: 'Completed',
      failed: 'Execution failed',
      blocked: 'Execution blocked',
      cancelled: 'Cancelled',
      limited: 'Output limit reached',
      earlierTools: 'earlier tool calls folded',
      seconds: 's',
      context: 'Ctx',
      inputTokens: 'In',
      outputTokens: 'Out',
      cacheReadTokens: 'Hit',
      cacheWriteTokens: 'Wr',
      reasoningTokens: 'Rsn',
      stop: 'Stop',
      approvalTitle: 'Your confirmation is required',
      approvalSummary: 'Confirmation required',
      approvalTool: 'Tool',
      approvalReason: 'Reason',
      approvalRule: 'This grants access for this call only.',
      allowOnce: 'Allow once',
      deny: 'Deny',
      approved: 'Approved',
      rejected: 'Denied',
      approvalCancelled: 'Approval cancelled',
      approvalUnavailable: 'Approval unavailable',
      humanInputTitle: 'Your input is needed',
      humanInputSummary: 'Waiting for an answer',
      humanInputSafety: 'Do not enter credentials, keys, tokens, or other secrets.',
      humanInputSubmit: 'Submit answer',
      humanInputCancel: 'Cancel',
      humanInputSelectPlaceholder: 'Select an option',
      humanInputCustomPlaceholder: 'Other answer (overrides the selection)',
      humanInputTextPlaceholder: 'Enter your answer',
      humanInputSubmitted: 'Answer received',
      humanInputCancelled: 'Question cancelled',
      humanInputTimedOut: 'Question timed out',
      humanInputUnavailable: 'Question unavailable',
      planTitle: '📋 **Plan**',
      earlierTodos: 'earlier plan items folded',
      notifyCompletionTitle: 'Task complete',
      notifyAttentionTitle: 'Needs attention',
      statusTitle: 'Channel status',
      diagTitle: 'Channel diagnostic',
      policyTitle: 'Conversation policy',
      taskTitle: 'Parallel tasks',
      taskCreatedTitle: 'Task started',
      taskSettledTitle: 'Task finished',
    },
    event: {
      command: 'Command',
      compaction: 'Compact context',
      prune: 'Prune context',
      goal: 'Goal',
      hook: 'Hook',
      retry: 'Model retry',
      workflow: 'Workflow',
      workflowAgent: 'Subtask',
    },
  },
}

export function localeCopy(locale: LarkLocale): LocaleCopy {
  return COPY[locale]
}
