import { createHash, randomUUID } from 'node:crypto'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const PARALLEL_TASK_COMMAND = '/task'
export const DEFAULT_PARALLEL_TASKS = false
export const DEFAULT_MAX_PARALLEL_TASKS = 2
export const MAX_PARALLEL_TASKS_LIMIT = 8
export const MAX_TASK_PROMPT_RUNES = 2_000
export const MAX_TASK_TITLE_RUNES = 60
export const MAX_TASKS_LISTED = 10

export type TaskWorkspacePolicy = 'exclusive' | 'shared'
export type TaskStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'orphaned'

const LIVE_STATUS: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['running'])

export class ParallelTaskError extends Error {
  constructor(
    readonly code: 'INVALID' | 'AT_CAPACITY' | 'WORKSPACE_BUSY' | 'UNKNOWN' | 'NOT_LIVE',
    message: string,
  ) {
    super(message)
    this.name = 'ParallelTaskError'
  }
}

const REFERENCE_PATTERN = /^[0-9a-f]{12}$/u
const KEY_PATTERN = /^[0-9a-f]{64}$/u
const KEY_HASH_DOMAIN = 'dsh-plugin-lark/parallel-task/v1'
const WORKSPACE_HASH_DOMAIN = 'dsh-plugin-lark/parallel-task/workspace/v1'

const taskSchema = z.object({
  reference: z.string().regex(REFERENCE_PATTERN),
  scopeId: z.string().min(1).max(256),
  parentBaseId: z.string().min(1).max(256),
  taskBaseId: z.string().min(1).max(320),
  chatId: z.string().min(1).max(128),
  replyToMessageId: z.string().min(1).max(128),
  replyInThread: z.boolean().optional(),
  workspaceKey: z.string().regex(KEY_PATTERN).optional(),
  title: z.string().min(1).max(MAX_TASK_TITLE_RUNES * 4),
  status: z.enum(['running', 'completed', 'failed', 'stopped', 'orphaned']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

export type ParallelTaskRecord = z.infer<typeof taskSchema>
type TaskKey = string & { readonly __taskKey: unique symbol }

export const larkTaskDomainSpec = defineDomain({
  name: 'lark_tasks',
  version: 0,
  tables: {
    tasks: domainTable<TaskKey, ParallelTaskRecord>(taskSchema),
  },
})

type TaskDomain = Domain<typeof larkTaskDomainSpec>
type TaskTable = KvTable<TaskKey, ParallelTaskRecord>

export type TaskCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'run'; readonly prompt: string }
  | { readonly kind: 'inspect'; readonly reference: string }
  | { readonly kind: 'stop'; readonly reference: string }

/**
 * Parse the explicit task vocabulary. Only these forms create parallel work:
 * an ordinary message is never reinterpreted as a task.
 */
export function parseTaskCommand(text: string): TaskCommand | undefined {
  const trimmed = text.trim()
  if (trimmed === PARALLEL_TASK_COMMAND) return { kind: 'list' }
  if (!trimmed.startsWith(`${PARALLEL_TASK_COMMAND} `)) return undefined
  const rest = trimmed.slice(PARALLEL_TASK_COMMAND.length + 1).trim()
  if (rest === 'list') return { kind: 'list' }
  if (rest.startsWith('run ')) {
    const prompt = rest.slice(4).trim()
    if (prompt === '' || [...prompt].length > MAX_TASK_PROMPT_RUNES) return undefined
    return { kind: 'run', prompt }
  }
  if (rest.startsWith('stop ')) {
    const reference = rest.slice(5).trim()
    return REFERENCE_PATTERN.test(reference) ? { kind: 'stop', reference } : undefined
  }
  return REFERENCE_PATTERN.test(rest) ? { kind: 'inspect', reference: rest } : undefined
}

export function newTaskReference(): string {
  return randomUUID().replace(/-/gu, '').slice(0, 12)
}

/** A task lives in its own conversation scope so it never shares a barrier with
 * the chat that started it, while keeping the chat resolvable for policy. */
export function taskBaseId(sessionPrefix: string, scopeVersion: string, chatId: string, reference: string): string {
  return `${sessionPrefix}:${scopeVersion}:${encodeURIComponent(chatId)}:task:${reference}`
}

export function taskTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/gu, ' ').trim()
  const runes = [...collapsed]
  if (runes.length <= MAX_TASK_TITLE_RUNES) return collapsed
  return `${runes.slice(0, MAX_TASK_TITLE_RUNES - 1).join('')}…`
}

export function taskIsLive(record: ParallelTaskRecord): boolean {
  return LIVE_STATUS.has(record.status)
}

/**
 * Decide whether one more task may start. Capacity is per conversation scope,
 * and an exclusive Workspace policy refuses a second live task in the same
 * Workspace so parallel work cannot silently modify it.
 */
export function admitTask(
  live: readonly ParallelTaskRecord[],
  input: {
    readonly scopeId: string
    readonly workspaceKey?: string
    readonly maxParallelTasks: number
    readonly workspacePolicy: TaskWorkspacePolicy
  },
): void {
  const scoped = live.filter((record) => record.scopeId === input.scopeId)
  if (scoped.length >= input.maxParallelTasks) {
    throw new ParallelTaskError('AT_CAPACITY', 'lark: this conversation is at its parallel task limit')
  }
  if (input.workspacePolicy !== 'exclusive' || input.workspaceKey === undefined) return
  if (live.some((record) => record.workspaceKey === input.workspaceKey)) {
    throw new ParallelTaskError(
      'WORKSPACE_BUSY',
      'lark: another live task already holds this project',
    )
  }
}

export function validateMaxParallelTasks(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_PARALLEL_TASKS_LIMIT) {
    throw new RangeError(`lark: maxParallelTasks must be an integer between 1 and ${MAX_PARALLEL_TASKS_LIMIT}`)
  }
  return value
}

/**
 * Collision identity for the directory a task will write to. A registered
 * Workspace id and a bare working directory both hash here, so exclusivity holds
 * even before a project is registered and no path reaches durable storage.
 */
export function workspaceCollisionKey(namespace: string, workspace: string): string {
  return createHash('sha256')
    .update(WORKSPACE_HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(namespace, 'utf8')))
    .update(':')
    .update(namespace, 'utf8')
    .update(String(Buffer.byteLength(workspace, 'utf8')))
    .update(':')
    .update(workspace, 'utf8')
    .digest('hex')
}

function taskKey(namespace: string, reference: string): TaskKey {
  return createHash('sha256')
    .update(KEY_HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(namespace, 'utf8')))
    .update(':')
    .update(namespace, 'utf8')
    .update(String(Buffer.byteLength(reference, 'utf8')))
    .update(':')
    .update(reference, 'utf8')
    .digest('hex') as TaskKey
}

export class DurableParallelTaskStore {
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined

  private constructor(
    private readonly domain: TaskDomain,
    private readonly table: TaskTable,
    private readonly namespace: string,
  ) {}

  static async open(facility: DomainFacility, namespace: string): Promise<DurableParallelTaskStore> {
    if (typeof namespace !== 'string' || namespace.trim() === '') {
      throw new TypeError('lark: parallel task namespace must not be empty')
    }
    const domain = await facility.open(larkTaskDomainSpec)
    try {
      const store = new DurableParallelTaskStore(domain, domain.table('tasks'), namespace)
      store.validateStoredKeys()
      return store
    } catch (error) {
      try {
        await domain.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'lark: parallel task store open and cleanup failed')
      }
      throw error
    }
  }

  private validateStoredKeys(): void {
    for (const [key] of this.table.entries()) {
      if (!KEY_PATTERN.test(String(key))) {
        throw new TypeError('lark: persisted parallel task key is invalid')
      }
    }
  }

  read(reference: string): ParallelTaskRecord | undefined {
    if (!REFERENCE_PATTERN.test(reference)) return undefined
    return this.table.get(taskKey(this.namespace, reference))
  }

  /** Live tasks first, then newest first. Callers bound what they display. */
  list(scopeId?: string): readonly ParallelTaskRecord[] {
    const rows: ParallelTaskRecord[] = []
    for (const [, record] of this.table.entries()) {
      if (scopeId !== undefined && record.scopeId !== scopeId) continue
      rows.push(record)
    }
    rows.sort((left, right) => {
      const liveDelta = Number(taskIsLive(right)) - Number(taskIsLive(left))
      return liveDelta !== 0 ? liveDelta : right.createdAt - left.createdAt
    })
    return Object.freeze(rows)
  }

  liveTasks(): readonly ParallelTaskRecord[] {
    return this.list().filter(taskIsLive)
  }

  put(record: ParallelTaskRecord): Promise<void> {
    if (this.closing) return Promise.reject(new Error('lark: parallel task store is closing'))
    let parsed: ParallelTaskRecord
    try {
      parsed = taskSchema.parse(record)
    } catch (error) {
      // Validation is part of the write, so it fails the same way a write does.
      return Promise.reject(error)
    }
    const operation = this.operationTail.then(() => (
      this.table.put(taskKey(this.namespace, parsed.reference), parsed)
    ))
    this.operationTail = operation.catch(() => {})
    return operation
  }

  settle(reference: string, status: TaskStatus, now: number): Promise<void> {
    const current = this.read(reference)
    if (current === undefined) {
      return Promise.reject(new ParallelTaskError('UNKNOWN', 'lark: unknown task reference'))
    }
    if (!taskIsLive(current)) return Promise.resolve()
    return this.put({ ...current, status, updatedAt: now })
  }

  /**
   * A process that dies mid-task leaves a running row with no live Agent behind
   * it. Retiring those on open keeps the list honest and frees their Workspace.
   */
  async reconcileOrphans(now: number): Promise<number> {
    const orphans = this.liveTasks()
    for (const record of orphans) {
      await this.put({ ...record, status: 'orphaned', updatedAt: now })
    }
    return orphans.length
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.operationTail.then(() => this.domain.close())
    return this.closePromise
  }
}
