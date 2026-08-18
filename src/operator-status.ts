import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LarkConnectionState } from './lark.ts'

export const OPERATOR_STATUS_COMMAND = '/status'
export const OPERATOR_DIAG_COMMAND = '/diag'
export const MAX_RECENT_FAILURES = 8

export type OperatorConversationKind = 'direct' | 'group' | 'thread' | 'shared'
export type OperatorWorkState = 'idle' | 'running' | 'awaiting-input' | 'awaiting-approval'
export type OperatorCheckState = 'ok' | 'warn' | 'fail'

export interface OperatorStatusSnapshot {
  readonly version: string
  readonly uptimeMs: number
  readonly connection: LarkConnectionState
  readonly conversation: OperatorConversationKind
  readonly project: 'registered' | 'none'
  readonly modelProvider: string
  readonly model: string
  readonly work: OperatorWorkState
  readonly contextLabel?: string
}

export interface OperatorDiagInput {
  readonly botReady: boolean
  readonly workspaceCount: number | undefined
  readonly persistenceMounted: boolean
  readonly storageFlushOk: boolean | undefined
  readonly providerConfigured: boolean
  readonly recentFailures: readonly OperatorFailureCategory[]
}

export interface OperatorDiagCheck {
  readonly id: 'bot' | 'workspaces' | 'persistence' | 'storage' | 'provider' | 'failures'
  readonly state: OperatorCheckState
  readonly hint: string
}

export type OperatorFailureCategory =
  | 'delivery'
  | 'persistence'
  | 'workspace'
  | 'approval'
  | 'notify'
  | 'internal'

const PLUGIN_MANIFEST_VERSION = readPluginVersion()
const CONTROL_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

function readPluginVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../package.json'),
      'utf8',
    )) as { version?: unknown }
    return typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/u.test(manifest.version)
      ? manifest.version
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

export function pluginReleaseVersion(): string {
  return PLUGIN_MANIFEST_VERSION
}

export function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const totalSeconds = Math.floor(ms / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function classifyConversation(input: {
  readonly shared: boolean
  readonly chatType: string
  readonly threaded: boolean
}): OperatorConversationKind {
  if (input.shared) return 'shared'
  if (input.chatType === 'group' && input.threaded) return 'thread'
  if (input.chatType === 'group') return 'group'
  return 'direct'
}

export function sanitizeOperatorLabel(value: string, fallback: string): string {
  const normalized = value.replace(CONTROL_PATTERN, ' ').replace(/\s+/gu, ' ').trim()
  if (normalized === '') return fallback
  const runes = [...normalized]
  return runes.length <= 80 ? normalized : `${runes.slice(0, 79).join('')}…`
}

export function formatStatusBody(snapshot: OperatorStatusSnapshot, locale: 'zh-CN' | 'en-US'): string {
  const lines = locale === 'zh-CN'
    ? [
        `版本：${snapshot.version}`,
        `运行时间：${formatUptime(snapshot.uptimeMs)}`,
        `连接：${connectionLabel(snapshot.connection, locale)}`,
        `会话范围：${conversationLabel(snapshot.conversation, locale)}`,
        `项目：${snapshot.project === 'registered' ? '已注册' : '未注册'}`,
        `模型：${sanitizeOperatorLabel(`${snapshot.modelProvider} / ${snapshot.model}`, '未设置')}`,
        `工作：${workLabel(snapshot.work, locale)}`,
      ]
    : [
        `Version: ${snapshot.version}`,
        `Uptime: ${formatUptime(snapshot.uptimeMs)}`,
        `Connection: ${connectionLabel(snapshot.connection, locale)}`,
        `Conversation: ${conversationLabel(snapshot.conversation, locale)}`,
        `Project: ${snapshot.project === 'registered' ? 'registered' : 'none'}`,
        `Model: ${sanitizeOperatorLabel(`${snapshot.modelProvider} / ${snapshot.model}`, 'unset')}`,
        `Work: ${workLabel(snapshot.work, locale)}`,
      ]
  if (snapshot.contextLabel !== undefined) {
    lines.push(locale === 'zh-CN'
      ? `上下文：${sanitizeOperatorLabel(snapshot.contextLabel, '未知')}`
      : `Context: ${sanitizeOperatorLabel(snapshot.contextLabel, 'unknown')}`)
  }
  return lines.join('\n')
}

export function buildDiagChecks(input: OperatorDiagInput, locale: 'zh-CN' | 'en-US'): readonly OperatorDiagCheck[] {
  const zh = locale === 'zh-CN'
  const checks: OperatorDiagCheck[] = [
    {
      id: 'bot',
      state: input.botReady ? 'ok' : 'fail',
      hint: input.botReady
        ? (zh ? '机器人 REST 身份可用。' : 'Bot REST identity is available.')
        : (zh ? '机器人身份不可用。检查应用凭证与长连接。' : 'Bot identity is unavailable. Check app credentials and the long connection.'),
    },
    {
      id: 'workspaces',
      state: input.workspaceCount === undefined ? 'fail' : input.workspaceCount === 0 ? 'warn' : 'ok',
      hint: input.workspaceCount === undefined
        ? (zh ? 'Workspace 注册表不可用。' : 'Workspace registry is unavailable.')
        : input.workspaceCount === 0
          ? (zh ? '尚未注册 Workspace；项目切换不可用。' : 'No Workspaces are registered; project switching is unavailable.')
          : (zh ? `已注册 ${input.workspaceCount} 个 Workspace。` : `${input.workspaceCount} Workspaces are registered.`),
    },
    {
      id: 'persistence',
      state: input.persistenceMounted ? 'ok' : 'fail',
      hint: input.persistenceMounted
        ? (zh ? '会话持久化已挂载。' : 'Session persistence is mounted.')
        : (zh ? '会话持久化未挂载；重启无法恢复会话。' : 'Session persistence is not mounted; restarts cannot restore Sessions.'),
    },
    {
      id: 'storage',
      state: input.storageFlushOk === true ? 'ok' : input.storageFlushOk === false ? 'fail' : 'warn',
      hint: input.storageFlushOk === true
        ? (zh ? '存储域写入检查通过。' : 'Storage-domain write check succeeded.')
        : input.storageFlushOk === false
          ? (zh ? '存储域写入检查失败。检查 storage-domain 与磁盘。' : 'Storage-domain write check failed. Inspect storage-domain and disk.')
          : (zh ? '当前没有可刷新的会话，无法验证存储写入。' : 'No Session is available to verify a storage write.'),
    },
    {
      id: 'provider',
      state: input.providerConfigured ? 'ok' : 'warn',
      hint: input.providerConfigured
        ? (zh ? '已配置默认模型路由。' : 'A default model route is configured.')
        : (zh ? '未配置默认模型路由。' : 'No default model route is configured.'),
    },
  ]
  if (input.recentFailures.length === 0) {
    checks.push({
      id: 'failures',
      state: 'ok',
      hint: zh ? '近期没有已分类失败。' : 'No recent categorized failures.',
    })
    return Object.freeze(checks)
  }
  const labels = input.recentFailures
    .map((category) => failureLabel(category, locale))
    .join(zh ? '、' : ', ')
  checks.push({
    id: 'failures',
    state: 'warn',
    hint: zh
      ? `近期失败类别：${labels}。先处理最新一类，不要根据原始日志推断。`
      : `Recent failure classes: ${labels}. Handle the newest class; do not infer from raw logs.`,
  })
  return Object.freeze(checks)
}

export function formatDiagBody(checks: readonly OperatorDiagCheck[], locale: 'zh-CN' | 'en-US'): string {
  return checks.map((check) => {
    const mark = check.state === 'ok' ? 'OK' : check.state === 'warn' ? 'WARN' : 'FAIL'
    return `${mark} ${check.hint}`
  }).join('\n')
}

export function classifyOperatorFailure(message: string): OperatorFailureCategory {
  const text = message.toLowerCase()
  if (text.includes('notify') || text.includes('artifact')) return 'notify'
  if (text.includes('flush') || text.includes('durable') || text.includes('persistence')) return 'persistence'
  if (text.includes('workspace') || text.includes('registry')) return 'workspace'
  if (text.includes('approval')) return 'approval'
  if (text.includes('deliver') || text.includes('card') || text.includes('reply')) return 'delivery'
  return 'internal'
}

function connectionLabel(state: LarkConnectionState, locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'zh-CN') {
    switch (state) {
      case 'connected': return '已连接'
      case 'connecting': return '连接中'
      case 'reconnecting': return '重连中'
      case 'failed': return '失败'
      case 'stopped': return '已停止'
      case 'idle': return '空闲'
      default: return '未知'
    }
  }
  return state
}

function conversationLabel(kind: OperatorConversationKind, locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'zh-CN') {
    switch (kind) {
      case 'direct': return '私聊'
      case 'group': return '群聊回复树'
      case 'thread': return '群聊话题'
      case 'shared': return '显式共享会话'
    }
  }
  switch (kind) {
    case 'direct': return 'direct chat'
    case 'group': return 'group reply tree'
    case 'thread': return 'native thread'
    case 'shared': return 'shared session'
  }
}

function workLabel(work: OperatorWorkState, locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'zh-CN') {
    switch (work) {
      case 'idle': return '空闲'
      case 'running': return '执行中'
      case 'awaiting-input': return '等待结构化输入'
      case 'awaiting-approval': return '等待审批'
    }
  }
  switch (work) {
    case 'idle': return 'idle'
    case 'running': return 'running'
    case 'awaiting-input': return 'awaiting structured input'
    case 'awaiting-approval': return 'awaiting approval'
  }
}

function failureLabel(category: OperatorFailureCategory, locale: 'zh-CN' | 'en-US'): string {
  if (locale === 'zh-CN') {
    switch (category) {
      case 'delivery': return '投递'
      case 'persistence': return '持久化'
      case 'workspace': return '项目'
      case 'approval': return '审批'
      case 'notify': return '通知'
      case 'internal': return '内部'
    }
  }
  return category
}
