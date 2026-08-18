import { createHash, randomUUID } from 'node:crypto'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const NOTIFY_LARK_TOOL_NAME = 'notify_lark'
export const DEFAULT_PROACTIVE_DELIVERY = false
export const MAX_NOTIFY_SUMMARY_RUNES = 500
export const MAX_NOTIFY_MENTIONS = 3
export const DEFAULT_NOTIFY_OUTBOX_LIMIT = 64
export const MAX_NOTIFY_OUTBOX_LIMIT = 256
export const DEFAULT_NOTIFY_TTL_MS = 15 * 60 * 1_000
export const MAX_NOTIFY_TTL_MS = 60 * 60 * 1_000
export const DEFAULT_NOTIFY_RATE_LIMIT = 3
export const MAX_NOTIFY_RATE_LIMIT = 20
export const DEFAULT_NOTIFY_RATE_WINDOW_MS = 10 * 60 * 1_000
export const MAX_NOTIFY_ATTEMPTS = 5

export type NotifyKind = 'completion' | 'attention'
export type NotifyMention = 'initiator'
export type NotifyStatus = 'pending' | 'inflight' | 'delivered' | 'expired' | 'failed' | 'rate_limited'

export class NotifyOutboxError extends Error {
  constructor(
    readonly code:
      | 'INVALID'
      | 'UNREGISTERED'
      | 'RATE_LIMITED'
      | 'EXPIRED'
      | 'UNAVAILABLE',
    message: string,
  ) {
    super(message)
    this.name = 'NotifyOutboxError'
  }
}

export interface NotifyDestination {
  readonly chatId: string
  readonly chatType: string
  readonly openId: string
  readonly lastMessageId: string
  readonly replyInThread?: true
}

export interface NotifyAdmitInput {
  readonly scopeId: string
  readonly kind: NotifyKind
  readonly summary: string
  readonly mentions: readonly NotifyMention[]
  readonly idempotencyKey: string
}

export interface NotifyOutboxRecord {
  readonly id: string
  readonly idempotencyKey: string
  readonly scopeId: string
  readonly kind: NotifyKind
  readonly summary: string
  readonly mentions: readonly NotifyMention[]
  readonly status: NotifyStatus
  readonly attemptCount: number
  readonly nextAttemptAt: number
  readonly expiresAt: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface NotifyLimits {
  readonly outboxLimit: number
  readonly ttlMs: number
  readonly rateLimit: number
  readonly rateWindowMs: number
}

export interface ParsedNotifyToolArgs {
  readonly kind: NotifyKind
  readonly summary: string
  readonly mentions: readonly NotifyMention[]
  readonly idempotencyKey?: string
}

const HASH_DOMAIN = 'dsh-plugin-lark/notify-outbox/v1'
const KEY_PATTERN = /^[0-9a-f]{64}$/u
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{8,50}$/u
const DESTINATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u
const FORBIDDEN_ARG_KEYS = new Set([
  'destination',
  'destination_id',
  'chat_id',
  'chatId',
  'open_id',
  'openId',
  'message_id',
  'messageId',
  'receive_id',
  'receiveId',
  'user_id',
  'userId',
])
const KINDS = new Set<NotifyKind>(['completion', 'attention'])
const MENTIONS = new Set<NotifyMention>(['initiator'])
const ACTIVE_STATUSES = new Set<NotifyStatus>(['pending', 'inflight'])
const TERMINAL_STATUSES = new Set<NotifyStatus>(['delivered', 'expired', 'failed', 'rate_limited'])

const destinationSchema = z.object({
  chatId: z.string().regex(DESTINATION_ID_PATTERN),
  chatType: z.string().min(1).max(32),
  openId: z.string().regex(DESTINATION_ID_PATTERN),
  lastMessageId: z.string().regex(DESTINATION_ID_PATTERN),
  replyInThread: z.literal(true).optional(),
}).strict()

const outboxSchema = z.object({
  id: z.string().regex(IDEMPOTENCY_PATTERN),
  idempotencyKey: z.string().regex(IDEMPOTENCY_PATTERN),
  scopeId: z.string().regex(KEY_PATTERN),
  kind: z.enum(['completion', 'attention']),
  summary: z.string().min(1).max(MAX_NOTIFY_SUMMARY_RUNES * 4),
  mentions: z.array(z.literal('initiator')).max(MAX_NOTIFY_MENTIONS).readonly(),
  status: z.enum(['pending', 'inflight', 'delivered', 'expired', 'failed', 'rate_limited']),
  attemptCount: z.number().int().nonnegative().max(MAX_NOTIFY_ATTEMPTS),
  nextAttemptAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

type StoredDestination = z.infer<typeof destinationSchema>
type StoredOutbox = z.infer<typeof outboxSchema>
type HashedKey = string & { readonly __notifyKey: unique symbol }

export const larkNotifyDomainSpec = defineDomain({
  name: 'lark_notify',
  version: 0,
  tables: {
    destinations: domainTable<HashedKey, StoredDestination>(destinationSchema),
    outbox: domainTable<HashedKey, StoredOutbox>(outboxSchema),
  },
})

type NotifyDomain = Domain<typeof larkNotifyDomainSpec>
type DestinationTable = KvTable<HashedKey, StoredDestination>
type OutboxTable = KvTable<HashedKey, StoredOutbox>

function hashedKey(parts: readonly string[]): HashedKey {
  const hash = createHash('sha256').update(HASH_DOMAIN)
  for (const part of parts) {
    hash.update('\0')
    hash.update(String(Buffer.byteLength(part, 'utf8')))
    hash.update(':')
    hash.update(part, 'utf8')
  }
  return hash.digest('hex') as HashedKey
}

function validLimit(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max
}

function validateLimits(limits: NotifyLimits): NotifyLimits {
  if (!validLimit(limits.outboxLimit, MAX_NOTIFY_OUTBOX_LIMIT)
    || !validLimit(limits.ttlMs, MAX_NOTIFY_TTL_MS)
    || !validLimit(limits.rateLimit, MAX_NOTIFY_RATE_LIMIT)
    || !validLimit(limits.rateWindowMs, MAX_NOTIFY_TTL_MS * 24)) {
    throw new RangeError('lark: notify limits are invalid')
  }
  return limits
}

function validDestinationId(value: unknown): value is string {
  return typeof value === 'string'
    && DESTINATION_ID_PATTERN.test(value)
    && value.isWellFormed()
    && value.trim() === value
}

function validSummary(value: unknown): value is string {
  return typeof value === 'string'
    && value !== ''
    && value.trim() === value
    && value.isWellFormed()
    && [...value].length <= MAX_NOTIFY_SUMMARY_RUNES
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)
}

function publicRecord(record: StoredOutbox): NotifyOutboxRecord {
  return Object.freeze({
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    scopeId: record.scopeId,
    kind: record.kind,
    summary: record.summary,
    mentions: Object.freeze([...record.mentions]),
    status: record.status,
    attemptCount: record.attemptCount,
    nextAttemptAt: record.nextAttemptAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })
}

export function notifyConversationScopeId(namespace: string, baseId: string): string {
  if (typeof namespace !== 'string' || namespace.trim() === '' || !namespace.isWellFormed()) {
    throw new TypeError('lark: notify namespace is invalid')
  }
  if (typeof baseId !== 'string' || baseId.trim() === '' || !baseId.isWellFormed()) {
    throw new TypeError('lark: notify conversation scope is invalid')
  }
  return hashedKey(['scope', namespace, baseId])
}

export function parseNotifyToolArgs(args: unknown): ParsedNotifyToolArgs | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  const keys = Reflect.ownKeys(args)
  if (keys.some((key) => typeof key !== 'string')) return undefined
  const record = args as Record<string, unknown>
  for (const key of keys) {
    if (FORBIDDEN_ARG_KEYS.has(String(key))) return undefined
  }
  const allowed = new Set(['kind', 'summary', 'mentions', 'idempotency_key'])
  if (keys.some((key) => !allowed.has(String(key)))) return undefined
  if (typeof record.kind !== 'string' || !KINDS.has(record.kind as NotifyKind)) return undefined
  if (!validSummary(record.summary)) return undefined
  let mentions: NotifyMention[] = []
  if (record.mentions !== undefined) {
    if (!Array.isArray(record.mentions) || record.mentions.length > MAX_NOTIFY_MENTIONS) return undefined
    const unique = new Set<NotifyMention>()
    for (const item of record.mentions) {
      if (typeof item !== 'string' || !MENTIONS.has(item as NotifyMention) || unique.has(item as NotifyMention)) {
        return undefined
      }
      unique.add(item as NotifyMention)
    }
    mentions = [...unique]
  }
  const parsed: ParsedNotifyToolArgs = {
    kind: record.kind as NotifyKind,
    summary: record.summary,
    mentions: Object.freeze(mentions),
  }
  if (record.idempotency_key === undefined) return parsed
  if (typeof record.idempotency_key !== 'string' || !IDEMPOTENCY_PATTERN.test(record.idempotency_key)) {
    return undefined
  }
  return { ...parsed, idempotencyKey: record.idempotency_key }
}

export function notifyMentionMarkup(openId: string): string {
  if (!validDestinationId(openId)) {
    throw new NotifyOutboxError('INVALID', 'Notify mention target is invalid.')
  }
  return `<at id="${openId}"></at>`
}

export function notifyRetryDelayMs(attemptCount: number): number {
  const exponent = Math.min(Math.max(0, attemptCount - 1), 4)
  return 1_000 * (2 ** exponent)
}

export class DurableNotifyOutbox {
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined

  private constructor(
    private readonly domain: NotifyDomain,
    private readonly destinations: DestinationTable,
    private readonly outbox: OutboxTable,
    private readonly namespace: string,
    private readonly limits: NotifyLimits,
  ) {}

  static async open(
    facility: DomainFacility,
    namespace: string,
    limits: NotifyLimits = {
      outboxLimit: DEFAULT_NOTIFY_OUTBOX_LIMIT,
      ttlMs: DEFAULT_NOTIFY_TTL_MS,
      rateLimit: DEFAULT_NOTIFY_RATE_LIMIT,
      rateWindowMs: DEFAULT_NOTIFY_RATE_WINDOW_MS,
    },
  ): Promise<DurableNotifyOutbox> {
    if (typeof namespace !== 'string' || namespace.trim() === '') {
      throw new TypeError('lark: notify outbox namespace must not be empty')
    }
    const validated = validateLimits(limits)
    const domain = await facility.open(larkNotifyDomainSpec)
    try {
      const store = new DurableNotifyOutbox(
        domain,
        domain.table('destinations'),
        domain.table('outbox'),
        namespace,
        validated,
      )
      store.validateStoredKeys()
      await store.recoverInflight(Date.now())
      return store
    } catch (error) {
      try {
        await domain.close()
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'lark: notify outbox open and cleanup failed')
      }
      throw error
    }
  }

  get size(): number {
    return this.outbox.size
  }

  earliestPendingAt(now: number): number | undefined {
    let soonest: number | undefined
    for (const [, record] of this.outbox.entries()) {
      if (record.status !== 'pending') continue
      if (record.expiresAt <= now) continue
      if (soonest === undefined || record.nextAttemptAt < soonest) soonest = record.nextAttemptAt
    }
    return soonest
  }

  destination(scopeId: string): NotifyDestination | undefined {
    const stored = this.destinations.get(this.destinationKey(scopeId))
    return stored === undefined ? undefined : Object.freeze({ ...stored })
  }

  registerDestination(scopeId: string, destination: NotifyDestination): Promise<void> {
    this.assertOpen()
    const record = destinationSchema.parse(destination)
    const key = this.destinationKey(scopeId)
    return this.enqueue(async () => {
      await this.destinations.put(key, record)
    })
  }

  admit(input: NotifyAdmitInput, now: number): Promise<NotifyOutboxRecord> {
    this.assertOpen()
    if (!KEY_PATTERN.test(input.scopeId) || !IDEMPOTENCY_PATTERN.test(input.idempotencyKey)) {
      return Promise.reject(new NotifyOutboxError('INVALID', 'Notify admission identifiers are invalid.'))
    }
    if (!KINDS.has(input.kind) || !validSummary(input.summary)) {
      return Promise.reject(new NotifyOutboxError('INVALID', 'Notify admission payload is invalid.'))
    }
    if (input.mentions.length > MAX_NOTIFY_MENTIONS
      || new Set(input.mentions).size !== input.mentions.length
      || input.mentions.some((mention) => !MENTIONS.has(mention))) {
      return Promise.reject(new NotifyOutboxError('INVALID', 'Notify mention list is invalid.'))
    }
    if (this.destination(input.scopeId) === undefined) {
      return Promise.reject(new NotifyOutboxError('UNREGISTERED', 'Conversation scope is not registered.'))
    }
    if (!Number.isSafeInteger(now) || now < 0) {
      return Promise.reject(new NotifyOutboxError('INVALID', 'Notify admission time is invalid.'))
    }
    const idempotencyKey = this.idempotencyKey(input.idempotencyKey)
    return this.enqueue(async () => {
      const existing = this.outbox.get(idempotencyKey)
      if (existing !== undefined) return publicRecord(existing)
      await this.expireLocked(now)
      const recent = [...this.outbox.entries()].map(([, record]) => record).filter((record) => (
        record.scopeId === input.scopeId
        && record.createdAt >= now - this.limits.rateWindowMs
        && record.status !== 'failed'
      ))
      if (recent.length >= this.limits.rateLimit) {
        throw new NotifyOutboxError('RATE_LIMITED', 'Notify rate limit exceeded for this conversation.')
      }
      await this.trimLocked(this.limits.outboxLimit - 1)
      const record: StoredOutbox = {
        id: input.idempotencyKey,
        idempotencyKey: input.idempotencyKey,
        scopeId: input.scopeId,
        kind: input.kind,
        summary: input.summary,
        mentions: [...input.mentions],
        status: 'pending',
        attemptCount: 0,
        nextAttemptAt: now,
        expiresAt: now + this.limits.ttlMs,
        createdAt: now,
        updatedAt: now,
      }
      await this.outbox.put(idempotencyKey, record)
      return publicRecord(record)
    })
  }

  claimDue(now: number, limit = 8): Promise<NotifyOutboxRecord[]> {
    this.assertOpen()
    const take = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 32) : 8
    return this.enqueue(async () => {
      await this.expireLocked(now)
      const due = [...this.outbox.entries()]
        .filter(([, record]) => record.status === 'pending' && record.nextAttemptAt <= now)
        .sort((left, right) => left[1].createdAt - right[1].createdAt || left[0].localeCompare(right[0]))
        .slice(0, take)
      const claimed: NotifyOutboxRecord[] = []
      for (const [key, record] of due) {
        const next: StoredOutbox = {
          ...record,
          status: 'inflight',
          attemptCount: record.attemptCount + 1,
          updatedAt: now,
        }
        await this.outbox.put(key, next)
        claimed.push(publicRecord(next))
      }
      return claimed
    })
  }

  complete(id: string, status: Extract<NotifyStatus, 'delivered' | 'failed' | 'expired'>, now: number): Promise<void> {
    this.assertOpen()
    if (!IDEMPOTENCY_PATTERN.test(id) || !TERMINAL_STATUSES.has(status)) {
      return Promise.reject(new NotifyOutboxError('INVALID', 'Notify completion is invalid.'))
    }
    return this.enqueue(async () => {
      const key = this.idempotencyKey(id)
      const current = this.outbox.get(key)
      if (current === undefined) throw new NotifyOutboxError('UNAVAILABLE', 'Notify record is missing.')
      if (TERMINAL_STATUSES.has(current.status)) return
      await this.outbox.put(key, { ...current, status, updatedAt: now })
    })
  }

  retryOrFail(id: string, now: number): Promise<NotifyOutboxRecord> {
    this.assertOpen()
    return this.enqueue(async () => {
      const key = this.idempotencyKey(id)
      const current = this.outbox.get(key)
      if (current === undefined) throw new NotifyOutboxError('UNAVAILABLE', 'Notify record is missing.')
      if (TERMINAL_STATUSES.has(current.status)) return publicRecord(current)
      if (current.expiresAt <= now || current.attemptCount >= MAX_NOTIFY_ATTEMPTS) {
        const expired: StoredOutbox = {
          ...current,
          status: current.expiresAt <= now ? 'expired' : 'failed',
          updatedAt: now,
        }
        await this.outbox.put(key, expired)
        return publicRecord(expired)
      }
      const pending: StoredOutbox = {
        ...current,
        status: 'pending',
        nextAttemptAt: now + notifyRetryDelayMs(current.attemptCount),
        updatedAt: now,
      }
      await this.outbox.put(key, pending)
      return publicRecord(pending)
    })
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.operationTail.then(() => this.domain.close())
    return this.closePromise
  }

  private assertOpen(): void {
    if (this.closing) throw new NotifyOutboxError('UNAVAILABLE', 'Notify outbox is closing.')
  }

  private destinationKey(scopeId: string): HashedKey {
    if (!KEY_PATTERN.test(scopeId)) {
      throw new NotifyOutboxError('INVALID', 'Notify scope is invalid.')
    }
    return hashedKey(['destination', this.namespace, scopeId])
  }

  private idempotencyKey(value: string): HashedKey {
    return hashedKey(['idempotency', this.namespace, value])
  }

  private validateStoredKeys(): void {
    for (const key of this.destinations.keys()) {
      if (!KEY_PATTERN.test(key)) throw new TypeError('lark: persisted notify destination key is invalid')
    }
    for (const key of this.outbox.keys()) {
      if (!KEY_PATTERN.test(key)) throw new TypeError('lark: persisted notify outbox key is invalid')
    }
  }

  private async recoverInflight(now: number): Promise<void> {
    await this.expireLocked(now)
    for (const [key, record] of this.outbox.entries()) {
      if (record.status !== 'inflight') continue
      const recovered: StoredOutbox = {
        ...record,
        status: record.expiresAt <= now || record.attemptCount >= MAX_NOTIFY_ATTEMPTS
          ? (record.expiresAt <= now ? 'expired' : 'failed')
          : 'pending',
        nextAttemptAt: now,
        updatedAt: now,
      }
      await this.outbox.put(key, recovered)
    }
  }

  private async expireLocked(now: number): Promise<void> {
    for (const [key, record] of this.outbox.entries()) {
      if (!ACTIVE_STATUSES.has(record.status) || record.expiresAt > now) continue
      await this.outbox.put(key, { ...record, status: 'expired', updatedAt: now })
    }
  }

  private async trimLocked(targetSize: number): Promise<void> {
    const excess = this.outbox.size - targetSize
    if (excess <= 0) return
    const removable = [...this.outbox.entries()]
      .filter(([, record]) => TERMINAL_STATUSES.has(record.status))
      .sort((left, right) => left[1].updatedAt - right[1].updatedAt || left[0].localeCompare(right[0]))
    if (removable.length < excess) {
      throw new NotifyOutboxError('UNAVAILABLE', 'Notify outbox is full of in-flight work.')
    }
    for (const [key] of removable.slice(0, excess)) await this.outbox.delete(key)
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.operationTail.then(work)
    this.operationTail = operation.then(() => {}, () => {})
    return operation
  }
}

export function newNotifyIdempotencyKey(): string {
  return `n_${randomUUID().replaceAll('-', '')}`
}
