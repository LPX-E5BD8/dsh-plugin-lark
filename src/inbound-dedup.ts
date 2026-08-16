import { createHash } from 'node:crypto'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export interface InboundDeduplicator {
  has(key: string): boolean
  complete(key: string): Promise<void>
}

export const INBOUND_DEDUP_LIMIT = 1_024

type ReceiptKey = string & { readonly __receiptKey: unique symbol }

const receiptSchema = z.object({
  completedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

type Receipt = z.infer<typeof receiptSchema>

const RECEIPT_KEY_PATTERN = /^[0-9a-f]{64}$/u
const RECEIPT_HASH_DOMAIN = 'dsh-plugin-lark/inbound-receipt/v1'

export const larkInboundDomainSpec = defineDomain({
  name: 'lark_inbound',
  version: 0,
  tables: {
    messages: domainTable<ReceiptKey, Receipt>(receiptSchema),
  },
})

type InboundDomain = Domain<typeof larkInboundDomainSpec>
type ReceiptTable = KvTable<ReceiptKey, Receipt>

function receiptKey(namespace: string, key: string): ReceiptKey {
  if (typeof key !== 'string' || key === '') {
    throw new TypeError('lark: inbound dedup key must not be empty')
  }
  return createHash('sha256')
    .update(RECEIPT_HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(namespace, 'utf8')))
    .update(':')
    .update(namespace, 'utf8')
    .update(String(Buffer.byteLength(key, 'utf8')))
    .update(':')
    .update(key, 'utf8')
    .digest('hex') as ReceiptKey
}

function compareReceipts(
  left: readonly [ReceiptKey, Receipt],
  right: readonly [ReceiptKey, Receipt],
): number {
  if (left[1].completedAt < right[1].completedAt) return -1
  if (left[1].completedAt > right[1].completedAt) return 1
  return left[0] < right[0] ? -1 : left[0] === right[0] ? 0 : 1
}

export class DurableInboundDeduplicator implements InboundDeduplicator {
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined
  private lastCompletedAt: number

  private constructor(
    private readonly domain: InboundDomain,
    private readonly table: ReceiptTable,
    private readonly namespace: string,
    private readonly maxEntries: number,
  ) {
    this.lastCompletedAt = 0
    for (const [, receipt] of table.entries()) {
      this.lastCompletedAt = Math.max(this.lastCompletedAt, receipt.completedAt)
    }
  }

  static async open(
    facility: DomainFacility,
    namespace: string,
    maxEntries = INBOUND_DEDUP_LIMIT,
  ): Promise<DurableInboundDeduplicator> {
    if (typeof namespace !== 'string' || namespace === '') {
      throw new TypeError('lark: inbound dedup namespace must not be empty')
    }
    if (
      !Number.isSafeInteger(maxEntries)
      || maxEntries < 1
      || maxEntries > INBOUND_DEDUP_LIMIT
    ) {
      throw new TypeError(`lark: inbound dedup limit must be between 1 and ${INBOUND_DEDUP_LIMIT}`)
    }
    const domain = await facility.open(larkInboundDomainSpec)
    try {
      const deduplicator = new DurableInboundDeduplicator(
        domain,
        domain.table('messages'),
        namespace,
        maxEntries,
      )
      deduplicator.validateStoredKeys()
      await deduplicator.trim()
      return deduplicator
    } catch (error) {
      try {
        await domain.close()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'lark: inbound dedup open and cleanup failed',
        )
      }
      throw error
    }
  }

  get size(): number {
    return this.table.size
  }

  has(key: string): boolean {
    return this.table.get(receiptKey(this.namespace, key)) !== undefined
  }

  complete(key: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('lark: inbound dedup is closing'))
    const hashed = receiptKey(this.namespace, key)
    const operation = this.operationTail.then(async () => {
      if (this.table.get(hashed) !== undefined) return
      const completedAt = this.nextCompletedAt()
      const receipt = Object.freeze({ completedAt })

      // storage-domain makes each record mutation durable and atomic, but it
      // has no transaction spanning a put and the FIFO deletions. Make room
      // first so a successful put is the operation's final fallible step: a
      // rejection can forget an older receipt, but can never leave the new
      // receipt committed while reporting this completion as failed.
      await this.trim(this.maxEntries - 1)
      await this.table.put(hashed, receipt)
      this.lastCompletedAt = completedAt
    })
    this.operationTail = operation.catch(() => {})
    return operation
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.operationTail.then(() => this.domain.close())
    return this.closePromise
  }

  private validateStoredKeys(): void {
    for (const key of this.table.keys()) {
      if (!RECEIPT_KEY_PATTERN.test(key)) {
        throw new TypeError('lark: persisted inbound dedup receipt key is invalid')
      }
    }
  }

  private nextCompletedAt(): number {
    if (this.lastCompletedAt >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('lark: inbound dedup completion sequence is exhausted')
    }
    const completedAt = Math.max(Date.now(), this.lastCompletedAt + 1)
    if (!Number.isSafeInteger(completedAt) || completedAt < 0) {
      throw new RangeError('lark: inbound dedup completion time is invalid')
    }
    return completedAt
  }

  private async trim(targetSize = this.maxEntries): Promise<void> {
    const excess = this.table.size - targetSize
    if (excess <= 0) return
    const oldest = [...this.table.entries()].sort(compareReceipts).slice(0, excess)
    for (const [key] of oldest) await this.table.delete(key)
  }
}
