import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { DurableInboundDeduplicator } from '../src/inbound-dedup.ts'

interface MountedDeduplicator {
  readonly ctx: Context
  readonly deduplicator: DurableInboundDeduplicator
  dispose(): Promise<void>
}

function faultInjectingFacility(): {
  readonly facility: never
  failNextPut(): void
} {
  const records = new Map<string, { completedAt: number }>()
  let rejectNextPut = false
  const table = {
    get(key: string) { return records.get(key) },
    entries() { return records.entries() },
    keys() { return records.keys() },
    get size() { return records.size },
    async put(key: string, value: { completedAt: number }) {
      if (rejectNextPut) {
        rejectNextPut = false
        throw new Error('injected receipt put failure')
      }
      records.set(key, value)
    },
    async delete(key: string) { return records.delete(key) },
  }
  const domain = {
    name: 'lark_inbound',
    global: undefined,
    table(name: string) {
      assert.equal(name, 'messages')
      return table
    },
    async close() {},
  }
  return {
    facility: { async open() { return domain } } as never,
    failNextPut() { rejectNextPut = true },
  }
}

async function mountDeduplicator(
  root: string,
  namespace: string,
  maxEntries = 1_024,
): Promise<MountedDeduplicator> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const deduplicator = await DurableInboundDeduplicator.open(
      ctx.storageDomain,
      namespace,
      maxEntries,
    )
    let disposed = false
    return {
      ctx,
      deduplicator,
      async dispose() {
        if (disposed) return
        disposed = true
        try {
          await deduplicator.close()
        } finally {
          await ctx.fiber.dispose()
        }
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

test('durable inbound dedup survives a fresh facility and context', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-inbound-dedup-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await mountDeduplicator(root, 'app:tenant-a')
  t.after(() => first.dispose())
  assert.equal(first.deduplicator.has('chat-a\0message-a'), false)
  await first.deduplicator.complete('chat-a\0message-a')
  assert.equal(first.deduplicator.has('chat-a\0message-a'), true)
  await first.dispose()

  const second = await mountDeduplicator(root, 'app:tenant-a')
  t.after(() => second.dispose())
  assert.equal(second.deduplicator.has('chat-a\0message-a'), true)
  assert.equal(second.deduplicator.has('chat-a\0message-b'), false)
})

test('a failed durable commit can be retried', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-inbound-dedup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mounted = await mountDeduplicator(root, 'app:tenant-b')
  t.after(() => mounted.dispose())
  const unitPath = join(root, 'lark_inbound.json')

  // A directory at the unit-file path makes the atomic rename fail without
  // replacing the real backend or bypassing the domain write chain.
  await mkdir(unitPath)
  await assert.rejects(mounted.deduplicator.complete('chat-b\0message-a'))
  assert.equal(mounted.deduplicator.has('chat-b\0message-a'), false)

  await rm(unitPath, { recursive: true })
  await mounted.deduplicator.complete('chat-b\0message-a')
  assert.equal(mounted.deduplicator.has('chat-b\0message-a'), true)
})

test('a failed full-window replacement never records the new receipt', async (t) => {
  const injected = faultInjectingFacility()
  const deduplicator = await DurableInboundDeduplicator.open(
    injected.facility,
    'app:tenant-f',
    2,
  )
  t.after(() => deduplicator.close())
  await deduplicator.complete('chat-f\0message-oldest')
  await deduplicator.complete('chat-f\0message-current')

  injected.failNextPut()
  await assert.rejects(
    deduplicator.complete('chat-f\0message-new'),
    /injected receipt put failure/,
  )
  assert.equal(deduplicator.has('chat-f\0message-new'), false)
  assert.ok(deduplicator.size <= 2)

  await deduplicator.complete('chat-f\0message-new')
  assert.equal(deduplicator.has('chat-f\0message-new'), true)
  assert.equal(deduplicator.size, 2)
})

test('retention stays bounded after reopen and evicts the oldest receipt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-inbound-dedup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  let now = 1_000
  t.mock.method(Date, 'now', () => now++)

  const first = await mountDeduplicator(root, 'app:tenant-c', 2)
  t.after(() => first.dispose())
  await first.deduplicator.complete('chat-c\0oldest')
  await first.deduplicator.complete('chat-c\0middle')
  await first.deduplicator.complete('chat-c\0newest')
  assert.equal(first.deduplicator.size, 2)
  assert.equal(first.deduplicator.has('chat-c\0oldest'), false)
  assert.equal(first.deduplicator.has('chat-c\0middle'), true)
  assert.equal(first.deduplicator.has('chat-c\0newest'), true)
  await first.dispose()

  const second = await mountDeduplicator(root, 'app:tenant-c', 2)
  t.after(() => second.dispose())
  assert.equal(second.deduplicator.size, 2)
  assert.equal(second.deduplicator.has('chat-c\0oldest'), false)
  assert.equal(second.deduplicator.has('chat-c\0middle'), true)
  assert.equal(second.deduplicator.has('chat-c\0newest'), true)
})

test('the JSON medium exposes neither the namespace nor the inbound key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-inbound-dedup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const namespace = 'private-app-namespace'
  const inboundKey = 'private-chat-id\0private-message-id'
  const mounted = await mountDeduplicator(root, namespace)
  t.after(() => mounted.dispose())

  await mounted.deduplicator.complete(inboundKey)
  const medium = await readFile(join(root, 'lark_inbound.json'), 'utf8')
  assert.doesNotMatch(medium, new RegExp(namespace))
  assert.doesNotMatch(medium, /private-chat-id|private-message-id/)

  const document = JSON.parse(medium) as {
    tables?: { messages?: Record<string, unknown> }
  }
  const storedKeys = Object.keys(document.tables?.messages ?? {})
  assert.equal(storedKeys.length, 1)
  assert.match(storedKeys[0] ?? '', /^[0-9a-f]{64}$/)
})

test('close is idempotent and drains operations already admitted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-inbound-dedup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const keys = Array.from({ length: 16 }, (_, index) => `chat-e\0message-${index}`)
  const first = await mountDeduplicator(root, 'app:tenant-e', keys.length)
  t.after(() => first.dispose())

  const commits = keys.map((key) => first.deduplicator.complete(key))
  const closes = [first.deduplicator.close(), first.deduplicator.close()]
  await Promise.all([...commits, ...closes])
  await first.ctx.fiber.dispose()

  const second = await mountDeduplicator(root, 'app:tenant-e', keys.length)
  t.after(() => second.dispose())
  assert.equal(second.deduplicator.size, keys.length)
  for (const key of keys) assert.equal(second.deduplicator.has(key), true)
})
