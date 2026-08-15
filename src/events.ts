import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { ToolCardStatus } from './cards.ts'
import { DEFAULT_CONFIG } from './config.ts'
import { localeCopy } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export type SessionEventPolicy = 'render' | 'consume' | 'ignore'

export const SESSION_EVENT_POLICIES: Readonly<Record<string, SessionEventPolicy>> = {
  'agent-preset/selected': 'ignore',
  'agent/inbox/spliced': 'ignore',
  'approval/asked': 'consume',
  'approval/decided': 'consume',
  'approval/policy': 'consume',
  'assistant/chunk': 'render',
  'assistant/message': 'render',
  'command/done': 'render',
  'command/run': 'render',
  'compaction/end': 'render',
  'compaction/prune': 'render',
  'compaction/start': 'render',
  'compaction/summary': 'render',
  'feedback/record': 'ignore',
  'goal/change': 'render',
  'hook/invoked': 'render',
  'hook/result': 'render',
  'llm/retry': 'render',
  'llm/retry-started': 'render',
  'permission/preset': 'ignore',
  'plan/mode': 'ignore',
  'request/context': 'consume',
  'request/header': 'consume',
  'sandbox/mode': 'ignore',
  'schedule/change': 'ignore',
  'session/end-seed': 'consume',
  'session/title': 'ignore',
  'session/title-llm-request': 'ignore',
  'step/end': 'consume',
  'step/start': 'consume',
  'subagent/descriptor': 'ignore',
  'todo/write': 'render',
  'tool-workflow/agent-end': 'render',
  'tool-workflow/agent-start': 'render',
  'tool-workflow/run-end': 'render',
  'tool-workflow/run-start': 'render',
  'tool/call': 'render',
  'tool/code-dispatch': 'render',
  'tool/code-dispatch-start': 'render',
  'tool/result': 'render',
  'turn/end': 'render',
  'turn/start': 'render',
  'user/message': 'consume',
  'web/deepseek-search-llm-request': 'ignore',
}

const FAILED_OUTCOMES = new Set(['aborted', 'cancelled', 'error', 'failed'])

export interface CatalogSessionEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

export interface ActivityProjection {
  readonly id: string
  readonly name?: string
  readonly detail?: string
  readonly status: ToolCardStatus
  readonly turn?: number | null
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function number(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function turn(record: Record<string, unknown>): number | null | undefined {
  return record.turn === null ? null : number(record, 'turn')
}

function eventId(event: CatalogSessionEvent, field: string): string {
  return text(asRecord(event.data), field) ?? `${event.type}:${event.seq}`
}

function jsonDetail(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return undefined
  }
}

function outcomeStatus(value: unknown): ToolCardStatus {
  const kind = text(asRecord(value), 'kind') ?? (typeof value === 'string' ? value : '')
  return FAILED_OUTCOMES.has(kind) ? 'failed' : 'completed'
}

function commandActivity(
  event: CatalogSessionEvent,
  data: Record<string, unknown>,
  locale: LarkLocale,
): ActivityProjection {
  const running = event.type === 'command/run'
  const name = text(data, 'name')
  return {
    id: `command:${eventId(event, 'commandId')}`,
    name: name === undefined ? undefined : `${localeCopy(locale).event.command} /${name}`,
    detail: text(data, running ? 'args' : 'text'),
    status: running ? 'running' : (text(data, 'kind') === 'error' ? 'failed' : 'completed'),
  }
}

function compactionActivity(
  event: CatalogSessionEvent,
  data: Record<string, unknown>,
  locale: LarkLocale,
): ActivityProjection {
  const copy = localeCopy(locale).event
  if (event.type === 'compaction/prune') {
    return { id: `compaction:prune:${event.seq}`, name: copy.prune, status: 'completed' }
  }
  const error = text(data, 'error')
  const status = event.type === 'compaction/end'
    ? (error === undefined ? 'completed' : 'failed')
    : 'running'
  return {
    id: `compaction:${eventId(event, 'compactionId')}`,
    name: copy.compaction,
    detail: error,
    status,
    turn: turn(data),
  }
}

function hookActivity(
  event: CatalogSessionEvent,
  data: Record<string, unknown>,
  locale: LarkLocale,
): ActivityProjection {
  const result = event.type === 'hook/result'
  const exitCode = number(data, 'exitCode')
  return {
    id: `hook:${eventId(event, 'handlerId')}`,
    name: result ? undefined : `${localeCopy(locale).event.hook} ${text(data, 'point') ?? ''}`.trim(),
    detail: text(data, result ? 'stderrSummary' : 'matcher'),
    status: result ? (exitCode === undefined || exitCode === 0 ? 'completed' : 'failed') : 'running',
    turn: turn(data),
  }
}

function retryActivity(
  event: CatalogSessionEvent,
  data: Record<string, unknown>,
  locale: LarkLocale,
): ActivityProjection {
  const retry = number(data, 'retry')
  const failure = asRecord(data.failure)
  const copy = localeCopy(locale).event
  return {
    id: `retry:${eventId(event, 'retryId')}`,
    name: retry === undefined ? copy.retry : `${copy.retry} ${retry}`,
    detail: text(failure, 'message'),
    status: event.type === 'llm/retry' ? 'running' : 'completed',
    turn: turn(data),
  }
}

function codeDispatchActivity(event: CatalogSessionEvent, data: Record<string, unknown>): ActivityProjection {
  const settled = event.type === 'tool/code-dispatch'
  return {
    id: `code:${eventId(event, 'subCallId')}`,
    name: text(data, 'name'),
    detail: jsonDetail(data.arguments),
    status: settled ? (data.isError === true ? 'failed' : 'completed') : 'running',
  }
}

function workflowActivity(
  event: CatalogSessionEvent,
  data: Record<string, unknown>,
  locale: LarkLocale,
): ActivityProjection {
  const runId = eventId(event, 'runId')
  const copy = localeCopy(locale).event
  if (event.type === 'tool-workflow/run-start') {
    return {
      id: `workflow:${runId}`,
      name: `${copy.workflow} ${text(data, 'name') ?? ''}`.trim(),
      status: 'running',
    }
  }
  if (event.type === 'tool-workflow/run-end') {
    return {
      id: `workflow:${runId}`,
      detail: jsonDetail(data.stopReason),
      status: outcomeStatus(data.stopReason),
    }
  }
  const seq = number(data, 'seq') ?? event.seq
  const started = event.type === 'tool-workflow/agent-start'
  return {
    id: `workflow:${runId}:agent:${seq}`,
    name: started ? `${copy.workflowAgent} ${text(data, 'label') ?? seq}` : undefined,
    detail: started ? text(data, 'phase') : jsonDetail(data.outcome),
    status: started ? 'running' : outcomeStatus(data.outcome),
  }
}

function goalActivity(
  event: CatalogSessionEvent,
  data: Record<string, unknown>,
  locale: LarkLocale,
): ActivityProjection {
  const goal = asRecord(data.goal)
  const operation = text(data, 'operation') ?? 'change'
  return {
    id: `goal:${text(goal, 'id') ?? event.seq}`,
    name: `${localeCopy(locale).event.goal} ${operation}`,
    detail: text(goal, 'objective'),
    status: operation === 'block' ? 'failed' : 'completed',
  }
}

export function projectActivity(
  event: CatalogSessionEvent,
  locale: LarkLocale = DEFAULT_CONFIG.locale,
): ActivityProjection | undefined {
  const data = asRecord(event.data)
  switch (event.type) {
    case 'command/run':
    case 'command/done':
      return commandActivity(event, data, locale)
    case 'compaction/start':
    case 'compaction/summary':
    case 'compaction/end':
    case 'compaction/prune':
      return compactionActivity(event, data, locale)
    case 'goal/change':
      return goalActivity(event, data, locale)
    case 'hook/invoked':
    case 'hook/result':
      return hookActivity(event, data, locale)
    case 'llm/retry':
    case 'llm/retry-started':
      return retryActivity(event, data, locale)
    case 'tool/code-dispatch-start':
    case 'tool/code-dispatch':
      return codeDispatchActivity(event, data)
    case 'tool-workflow/run-start':
    case 'tool-workflow/run-end':
    case 'tool-workflow/agent-start':
    case 'tool-workflow/agent-end':
      return workflowActivity(event, data, locale)
    default:
      return undefined
  }
}

export function sessionEventPolicy(type: string): SessionEventPolicy | undefined {
  return SESSION_EVENT_POLICIES[type]
}

export function unclassifiedKnownEventTypes(): string[] {
  return [...KNOWN_SESSION_EVENT_TYPES]
    .filter((type) => SESSION_EVENT_POLICIES[type] === undefined)
    .sort()
}

export function nonCatalogPolicyTypes(): string[] {
  return Object.keys(SESSION_EVENT_POLICIES)
    .filter((type) => !KNOWN_SESSION_EVENT_TYPES.has(type))
    .sort()
}
