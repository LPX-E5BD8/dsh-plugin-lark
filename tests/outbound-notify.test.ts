import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import {
  DurableNotifyOutbox,
  NotifyOutboxError,
  parseNotifyToolArgs,
  notifyConversationScopeId,
  notifyMentionMarkup,
  notifyRetryDelayMs,
  newNotifyIdempotencyKey,
} from '../src/outbound-notify.ts'

const DESTINATION = Object.freeze({
  chatId: 'oc_registered_chat',
  chatType: 'p2p',
  openId: 'ou_initiator',
  lastMessageId: 'om_last',
})

const LIMITS = Object.freeze({
  outboxLimit: 8,
  ttlMs: 60_000,
  rateLimit: 2,
  rateWindowMs: 10_000,
})

async function openOutbox(root: string, namespace: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const outbox = await DurableNotifyOutbox.open(ctx.storageDomain, namespace, LIMITS)
  return {
    ctx,
    outbox,
    async dispose() {
      await outbox.close().catch(() => {})
      await ctx.fiber.dispose()
    },
  }
}

async function mount(t: { after(callback: () => Promise<void>): void }, namespace = 'cli_testnotify0001') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-notify-'))
  const mounted = await openOutbox(root, namespace)
  t.after(async () => {
    await mounted.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { root, ...mounted, namespace }
}

test('notify tool args reject destination IDs and extra fields', () => {
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    chat_id: 'oc_injected',
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'attention',
    summary: 'look',
    destination: 'oc_injected',
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    receive_id: 'oc_injected',
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    extra: true,
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    idempotency_key: 'n_' + 'a'.repeat(60),
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'other',
    summary: 'done',
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: '  padded  ',
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    mentions: ['ou_someone'],
  }), undefined)
})

test('notify tool args accept only bounded registered mention tokens', () => {
  const parsed = parseNotifyToolArgs({
    kind: 'attention',
    summary: 'Please review the finished report.',
    mentions: ['initiator'],
    idempotency_key: 'n_abc12345',
  })
  assert.deepEqual(parsed, {
    kind: 'attention',
    summary: 'Please review the finished report.',
    mentions: ['initiator'],
    idempotencyKey: 'n_abc12345',
  })
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    mentions: ['initiator', 'initiator'],
  }), undefined)
  assert.equal(parseNotifyToolArgs({
    kind: 'completion',
    summary: 'done',
    mentions: ['initiator', 'initiator', 'initiator', 'initiator'],
  }), undefined)
})

test('notify mention markup only wraps a validated initiator id', () => {
  assert.equal(notifyMentionMarkup('ou_initiator'), '<at id="ou_initiator"></at>')
  assert.throws(
    () => notifyMentionMarkup('ou_bad/id'),
    (error) => error instanceof NotifyOutboxError && error.code === 'INVALID',
  )
})

test('admit rejects an unregistered conversation scope', async (t) => {
  const { outbox, namespace } = await mount(t)
  const scopeId = notifyConversationScopeId(namespace, 'lark:oc_missing')
  await assert.rejects(
    outbox.admit({
      scopeId,
      kind: 'completion',
      summary: 'done',
      mentions: [],
      idempotencyKey: newNotifyIdempotencyKey(),
    }, 1_000),
    (error) => error instanceof NotifyOutboxError && error.code === 'UNREGISTERED',
  )
})

test('admit honors only a registered scope and is idempotent across reopen', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-notify-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const namespace = 'cli_testnotify0001'
  const firstMount = await openOutbox(root, namespace)
  t.after(() => firstMount.dispose())
  const scopeId = notifyConversationScopeId(namespace, 'lark:oc_registered_chat')
  await firstMount.outbox.registerDestination(scopeId, DESTINATION)
  const idempotencyKey = 'n_same_notification_key'
  const now = Date.now()
  const first = await firstMount.outbox.admit({
    scopeId,
    kind: 'completion',
    summary: 'Task finished.',
    mentions: ['initiator'],
    idempotencyKey,
  }, now)
  assert.equal(first.status, 'pending')
  const replay = await firstMount.outbox.admit({
    scopeId,
    kind: 'completion',
    summary: 'Task finished.',
    mentions: ['initiator'],
    idempotencyKey,
  }, now + 500)
  assert.deepEqual(replay, first)
  const claimed = await firstMount.outbox.claimDue(now + 500)
  assert.equal(claimed.length, 1)
  assert.equal(claimed[0]?.status, 'inflight')
  assert.equal(claimed[0]?.id, idempotencyKey)
  await firstMount.dispose()

  const restarted = await openOutbox(root, namespace)
  t.after(() => restarted.dispose())
  const recovered = await restarted.outbox.claimDue(now + 1_000)
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0]?.status, 'inflight')
  assert.equal(recovered[0]?.idempotencyKey, idempotencyKey)
  assert.equal(restarted.outbox.destination(scopeId)?.chatId, DESTINATION.chatId)
  await restarted.outbox.complete(idempotencyKey, 'delivered', now + 1_000)
  assert.deepEqual(await restarted.outbox.claimDue(now + 2_000), [])
  const afterDelivery = await restarted.outbox.admit({
    scopeId,
    kind: 'completion',
    summary: 'Task finished.',
    mentions: ['initiator'],
    idempotencyKey,
  }, now + 2_000)
  assert.equal(afterDelivery.status, 'delivered')
})

test('rate limit, expiry, and retry reach terminal outcomes without duplicating sends', async (t) => {
  const { outbox, namespace } = await mount(t)
  const scopeId = notifyConversationScopeId(namespace, 'lark:oc_rate')
  await outbox.registerDestination(scopeId, { ...DESTINATION, chatId: 'oc_rate' })
  const first = await outbox.admit({
    scopeId,
    kind: 'attention',
    summary: 'Need a look.',
    mentions: [],
    idempotencyKey: 'n_rate_one_______',
  }, 20_000)
  const second = await outbox.admit({
    scopeId,
    kind: 'attention',
    summary: 'Need another look.',
    mentions: [],
    idempotencyKey: 'n_rate_two_______',
  }, 20_100)
  assert.equal(first.status, 'pending')
  assert.equal(second.status, 'pending')
  await assert.rejects(
    outbox.admit({
      scopeId,
      kind: 'attention',
      summary: 'Too many.',
      mentions: [],
      idempotencyKey: 'n_rate_three_____',
    }, 20_200),
    (error) => error instanceof NotifyOutboxError && error.code === 'RATE_LIMITED',
  )

  const [claimed] = await outbox.claimDue(20_300, 1)
  assert.equal(claimed?.id, first.id)
  assert.equal(claimed?.attemptCount, 1)
  const retried = await outbox.retryOrFail(claimed.id, 20_300)
  assert.equal(retried.status, 'pending')
  assert.equal(retried.nextAttemptAt, 20_300 + notifyRetryDelayMs(1))
  const stillDue = await outbox.claimDue(20_300)
  assert.equal(stillDue.length, 1)
  assert.equal(stillDue[0]?.id, second.id)
  await outbox.complete(stillDue[0].id, 'delivered', 20_300)
  assert.deepEqual(await outbox.claimDue(20_300), [])
  const later = await outbox.claimDue(retried.nextAttemptAt)
  assert.equal(later[0]?.id, claimed.id)
  await outbox.complete(claimed.id, 'failed', retried.nextAttemptAt)
  assert.deepEqual(await outbox.claimDue(retried.nextAttemptAt + 1), [])
})

test('backoff leaves a future pending wake time that claim skips until due', async (t) => {
  const { outbox, namespace } = await mount(t)
  const scopeId = notifyConversationScopeId(namespace, 'lark:oc_backoff')
  await outbox.registerDestination(scopeId, { ...DESTINATION, chatId: 'oc_backoff' })
  const now = Date.now()
  const admitted = await outbox.admit({
    scopeId,
    kind: 'completion',
    summary: 'Will retry.',
    mentions: [],
    idempotencyKey: 'n_backoff_key____',
  }, now)
  const [claimed] = await outbox.claimDue(now)
  assert.equal(claimed?.id, admitted.id)
  const retried = await outbox.retryOrFail(claimed!.id, now)
  assert.equal(retried.status, 'pending')
  assert.equal(outbox.earliestPendingAt(now), retried.nextAttemptAt)
  assert.deepEqual(await outbox.claimDue(now), [])
  const later = await outbox.claimDue(retried.nextAttemptAt)
  assert.equal(later[0]?.id, admitted.id)
})

test('expiry marks due pending items terminal and claim skips them', async (t) => {
  const { outbox, namespace } = await mount(t)
  const scopeId = notifyConversationScopeId(namespace, 'lark:oc_expire')
  await outbox.registerDestination(scopeId, { ...DESTINATION, chatId: 'oc_expire' })
  const record = await outbox.admit({
    scopeId,
    kind: 'completion',
    summary: 'Will expire.',
    mentions: [],
    idempotencyKey: 'n_will_expire____',
  }, 1_000)
  assert.equal(record.expiresAt, 1_000 + LIMITS.ttlMs)
  assert.deepEqual(await outbox.claimDue(1_000 + LIMITS.ttlMs), [])
  const after = await outbox.admit({
    scopeId,
    kind: 'completion',
    summary: 'Will expire.',
    mentions: [],
    idempotencyKey: 'n_will_expire____',
  }, 1_000 + LIMITS.ttlMs)
  assert.equal(after.status, 'expired')
})
