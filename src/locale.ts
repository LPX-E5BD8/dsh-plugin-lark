export const LARK_LOCALES = ['zh-CN', 'en-US'] as const
export type LarkLocale = typeof LARK_LOCALES[number]

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
    readonly stopRequested: string
    readonly stopExpired: string
    readonly stopUnavailable: string
    readonly stopWrongContext: string
    readonly commandFailed: string
    readonly longAnswer: string
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
      stopRequested: '正在停止。',
      stopExpired: '该执行已结束或停止。',
      stopUnavailable: '暂时无法停止。',
      stopWrongContext: '只能由发起用户在原会话中停止。',
      commandFailed: '命令执行失败，请重试。',
      longAnswer: '回复较长，以下为完整内容：',
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
      stopRequested: 'Stopping.',
      stopExpired: 'This run has already ended or stopped.',
      stopUnavailable: 'Unable to stop this run.',
      stopWrongContext: 'Only the initiating user can stop this run in the original chat.',
      commandFailed: 'Command execution failed. Please try again.',
      longAnswer: 'The reply is long. Here is the complete content:',
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
