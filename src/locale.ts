export const LARK_LOCALES = ['zh-CN', 'en-US'] as const
export type LarkLocale = typeof LARK_LOCALES[number]

interface LocaleCopy {
  readonly bridge: {
    readonly help: string
    readonly denied: string
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
    readonly inputTokens: string
    readonly outputTokens: string
    readonly tokenUnit: string
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
      unknownCommand: (command) => `未知命令 ${command}，发送 /help 查看帮助。`,
      unknownTurnEnd: (kind) => `无法识别的执行结果：${kind}`,
    },
    card: {
      executionTitle: '🧠 **执行过程**',
      running: '正在处理',
      completed: '已完成',
      failed: '执行失败',
      blocked: '执行受阻',
      cancelled: '已取消',
      limited: '达到输出上限',
      earlierTools: '个更早的工具调用已折叠',
      inputTokens: '输入',
      outputTokens: '输出',
      tokenUnit: 'Token',
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
      inputTokens: 'Input',
      outputTokens: 'Output',
      tokenUnit: 'tokens',
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
