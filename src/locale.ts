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
    readonly denied: string
    readonly unsupportedInput: string
    readonly followupFailure: string
    readonly cardUnavailable: string
    readonly approvalUnauthorized: string
    readonly approvalMalformed: string
    readonly approvalExpired: string
    readonly approvalWrongContext: string
    readonly approvalAllowed: string
    readonly approvalRejected: string
    readonly interrupted: string
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
    readonly sessionResumeFailed: string
    readonly sessionMutationReplayed: string
    readonly modelUnavailable: string
    readonly modelUnknown: string
    readonly modelBusy: string
    readonly modelSwitchFailed: string
    readonly modelMutationReplayed: string
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
    readonly planTitle: string
    readonly earlierTodos: string
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
      denied: '没有权限。',
      unsupportedInput: '暂不支持图片、文件或其他非文本消息，请改用文字发送。',
      followupFailure: '消息提交失败，请重试。',
      cardUnavailable: '卡片操作暂不可用。',
      approvalUnauthorized: '无权执行此操作。',
      approvalMalformed: '审批操作无效。',
      approvalExpired: '审批已处理或过期。',
      approvalWrongContext: '只能由发起用户在原会话中处理。',
      approvalAllowed: '已允许一次。',
      approvalRejected: '已拒绝。',
      interrupted: '执行被运行时中断。',
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
      sessionResumeFailed: '会话恢复失败，当前会话保持不变；请稍后重试。',
      sessionMutationReplayed: '该会话恢复操作已处理；当前会话保持最新状态。',
      modelUnavailable: '模型列表暂不可用，请稍后重试。',
      modelUnknown: '未找到该模型路由。发送 /model 查看可发现模型，或使用完整的提供方 ID 和模型 ID。',
      modelBusy: '当前会话仍有执行或待处理消息，请等待完成后重试。',
      modelSwitchFailed: '无法确认模型选择已保存，当前模型保持不变；请检查持久化存储后重试。',
      modelMutationReplayed: '该模型切换已处理；当前会话保持最新状态。',
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
      planTitle: '📋 **计划**',
      earlierTodos: '个更早的计划项已折叠',
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
      denied: "You don't have permission.",
      unsupportedInput: 'Images, files, and other non-text messages are not supported yet. Please send text.',
      followupFailure: 'Message submission failed. Please try again.',
      cardUnavailable: 'Card actions are temporarily unavailable.',
      approvalUnauthorized: 'You cannot perform this action.',
      approvalMalformed: 'Invalid approval action.',
      approvalExpired: 'This approval was already handled or expired.',
      approvalWrongContext: 'Only the initiating user can decide in the original chat.',
      approvalAllowed: 'Allowed once.',
      approvalRejected: 'Denied.',
      interrupted: 'Execution was interrupted by the runtime.',
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
      sessionResumeFailed: 'Session resume failed. The current session was left unchanged; try again later.',
      sessionMutationReplayed: 'That session resume was already handled. The conversation remains at its latest state.',
      modelUnavailable: 'The model list is unavailable. Please try again later.',
      modelUnknown: 'No model route matched. Send /model to list discoverable models, or use the full provider ID and model ID.',
      modelBusy: 'This conversation still has running or pending work. Wait for it to finish and try again.',
      modelSwitchFailed: 'The model selection could not be confirmed durable. The current model was left unchanged; check session storage and try again.',
      modelMutationReplayed: 'That model switch was already handled. The conversation remains at its latest state.',
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
      planTitle: '📋 **Plan**',
      earlierTodos: 'earlier plan items folded',
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
