import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { LarkBridge } from '../src/bridge.ts'
import type { LarkClientLike, LarkDeliveryOptions, LarkInbound } from '../src/lark.ts'
import { DurableNotifyOutbox } from '../src/outbound-notify.ts'

interface DrainClient extends LarkClientLike {
  readonly cards: Array<{
    readonly chatId: string
    readonly card: unknown
    readonly options?: LarkDeliveryOptions
  }>
  failNext: boolean
  messageHandler?: (message: LarkInbound) => Promise<void>
}

interface RegisteredTool {
  readonly name: string
  execute(args: unknown, exec: {
    readonly token: object
    readonly signal: AbortSignal
    readonly parent?: unknown
    readonly callId: string
  }): Promise<unknown>
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return
    await yieldImmediate()
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  assert.fail(message)
}

function createClient(): DrainClient {
  const client: DrainClient = {
    cards: [],
    failNext: false,
    async start() {},
    async stop() {},
    async sendText() {},
    async sendCard(chatId, card, options) {
      if (client.failNext) {
        client.failNext = false
        throw new Error('transient notify delivery failure')
      }
      const entry = { chatId, card, options }
      ;(client.cards as Array<typeof entry>).push(entry)
      return `om_notify_${client.cards.length}`
    },
    onMessage(handler) { client.messageHandler = handler },
  }
  return client
}

function createHost(tools: RegisteredTool[]) {
  const sessionListeners: Array<(session: { id: string }, event: unknown) => void> = []
  const inboxClaimedListeners: Array<(payload: {
    agent: { id: string }
    message: unknown
    turn: number
  }) => void> = []
  const pending = new Map<string, unknown[]>()
  return {
    logger: { error() {}, warn() {} },
    on(name: string, listener: (...args: never[]) => unknown) {
      if (name === 'session/event') {
        sessionListeners.push(listener as (session: { id: string }, event: unknown) => void)
      }
      if (name === 'agent/inbox/claimed') {
        inboxClaimedListeners.push(listener as (payload: {
          agent: { id: string }
          message: unknown
          turn: number
        }) => void)
      }
      return () => {}
    },
    get() { return undefined },
    agents: {
      async create(options: {
        sessionId: unknown
        setup?: (agentCtx: {
          tools: { register(tool: RegisteredTool): void }
          on(): () => void
        }) => Promise<void> | void
      }) {
        const sessionId = String(options.sessionId)
        const agent = {
          id: sessionId,
          session: {
            id: sessionId,
            events: [],
            header: {},
            append() {},
            requestContext() { return undefined },
          },
          status: 'idle' as const,
          inbox: { hasPending: false },
          cancel() {},
          followup(message: unknown) {
            const queued = pending.get(sessionId) ?? []
            queued.push(message)
            pending.set(sessionId, queued)
          },
          runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) {
            return task(new AbortController().signal)
          },
          whenIdle() { return Promise.resolve() },
        }
        await options.setup?.({
          tools: { register(tool) { tools.push(tool) } },
          on: () => () => {},
        })
        return { agent, dispose: async () => {} }
      },
      get() { return undefined },
      list() { return [] },
      roots() { return [] },
    },
    sessions: {
      async flush() { return true },
    },
    emit(sessionId: string, event: { type: string; data?: { turn?: number } }) {
      for (const listener of sessionListeners) listener({ id: sessionId }, event)
      if (event.type !== 'turn/start' || typeof event.data?.turn !== 'number') return
      const queued = pending.get(sessionId)
      const message = queued?.shift()
      if (message === undefined) return
      for (const listener of inboxClaimedListeners) {
        listener({ agent: { id: sessionId }, message, turn: event.data.turn })
      }
    },
  }
}

async function mount(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-notify-drain-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const outbox = await DurableNotifyOutbox.open(ctx.storageDomain, 'cli_testdrain0001')
  const tools: RegisteredTool[] = []
  const host = createHost(tools)
  const client = createClient()
  const bridge = new LarkBridge(host as never, {
    client,
    allowFrom: ['ou_owner'],
    proactiveDelivery: true,
    notifyOutbox: outbox,
    sessionReferenceNamespace: 'cli_testdrain0001',
  })
  await bridge.start()
  t.after(async () => {
    await bridge.stop()
    await outbox.close().catch(() => {})
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { client, host, tools, outbox }
}

function notifyTool(tools: readonly RegisteredTool[]): RegisteredTool {
  const tool = tools.find((entry) => entry.name === 'notify_lark')
  assert.ok(tool !== undefined, 'notify_lark was not registered on the Lark Agent')
  return tool
}

test('LarkBridge drain delivers a later admit after the first worker settles', async (t) => {
  const { client, host, tools } = await mount(t)
  assert.ok(client.messageHandler !== undefined)
  await client.messageHandler({
    chatId: 'oc_chat_a',
    chatType: 'p2p',
    openId: 'ou_owner',
    text: 'start work',
    messageId: 'om_start',
    mentioned: false,
  })
  host.emit('lark:oc_chat_a', { type: 'turn/start', data: { turn: 1 } })
  const tool = notifyTool(tools)

  await tool.execute({
    kind: 'completion',
    summary: 'First notice.',
    idempotency_key: 'n_drain_first',
  }, { token: { id: 'token-1' }, signal: new AbortController().signal, callId: 'call-1' })
  await waitFor(() => client.cards.length === 1, 'first admitted notification was not sent')
  assert.equal(client.cards[0]?.chatId, 'oc_chat_a')
  assert.equal(client.cards[0]?.options?.idempotencyKey, 'n_drain_first')

  await tool.execute({
    kind: 'attention',
    summary: 'Second notice.',
    idempotency_key: 'n_drain_second',
  }, { token: { id: 'token-2' }, signal: new AbortController().signal, callId: 'call-2' })
  await waitFor(() => client.cards.length === 2, 'second admit after the drain worker settled did not send')
  assert.equal(client.cards[1]?.options?.idempotencyKey, 'n_drain_second')
})

test('LarkBridge drain wakes a backoff retry without remounting the bridge', async (t) => {
  const { client, host, tools } = await mount(t)
  assert.ok(client.messageHandler !== undefined)
  await client.messageHandler({
    chatId: 'oc_chat_b',
    chatType: 'p2p',
    openId: 'ou_owner',
    text: 'need a ping',
    messageId: 'om_ping',
    mentioned: false,
  })
  host.emit('lark:oc_chat_b', { type: 'turn/start', data: { turn: 1 } })
  const tool = notifyTool(tools)
  client.failNext = true

  await tool.execute({
    kind: 'attention',
    summary: 'Retry after a blip.',
    idempotency_key: 'n_drain_retry',
  }, { token: { id: 'token-retry' }, signal: new AbortController().signal, callId: 'call-retry' })
  assert.equal(client.cards.length, 0)
  await waitFor(() => client.cards.length === 1, 'backoff retry did not wake the drain worker')
  assert.equal(client.cards[0]?.options?.idempotencyKey, 'n_drain_retry')
})
