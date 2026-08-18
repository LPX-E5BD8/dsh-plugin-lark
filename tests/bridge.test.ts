import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as Lark from '@larksuiteoapi/node-sdk'
import { LarkBridge } from '../src/bridge.ts'
import type { ConversationBinding } from '../src/conversation-binding.ts'
import { LARK_HEALTH_PATH } from '../src/health.ts'
import type { WebServerLike } from '../src/health.ts'
import { apply } from '../src/index.ts'
import * as LarkPlugin from '../src/index.ts'
import {
  LarkSdkClient,
  neutralizeTextMentions,
  normalizeInboundText,
  splitText,
  unwrapCardAction,
} from '../src/lark.ts'
import type { LarkCardAction, LarkCardActionResult, LarkClientLike, LarkInbound } from '../src/lark.ts'

type FakeClient = LarkClientLike & {
  sent: string[]
  cards: Array<{ chatId: string; card: unknown; messageId: string }>
  updated: Array<{ messageId: string; card: unknown }>
  handler?: (m: LarkInbound) => Promise<void>
  cardHandler?: (a: LarkCardAction) => Promise<LarkCardActionResult>
}

function fakeClient(): FakeClient {
  const sent: string[] = []
  const cards: Array<{ chatId: string; card: unknown; messageId: string }> = []
  const updated: Array<{ messageId: string; card: unknown }> = []
  const c: FakeClient = {
    sent,
    cards,
    updated,
    async start() {},
    async stop() {},
    async sendText(_chatId, text) { sent.push(text) },
    async sendCard(chatId, card) {
      const messageId = `card_${cards.length + 1}`
      cards.push({ chatId, card, messageId })
      return messageId
    },
    async updateCard(messageId, card) { updated.push({ messageId, card }) },
    onMessage(handler) { c.handler = handler },
    onCardAction(handler) { c.cardHandler = handler },
  }
  return c
}

function requestIdOf(card: unknown): string {
  const parsed = card as {
    body?: {
      elements?: Array<{
        element_id?: string
        columns?: Array<{
          elements?: Array<{
            behaviors?: Array<{ value?: { request_id?: string } }>
          }>
        }>
      }>
    }
  }
  const buttons = parsed.body?.elements?.find((element) => element.element_id === 'approval_buttons')
  return buttons?.columns?.[0]?.elements?.[0]?.behaviors?.[0]?.value?.request_id ?? ''
}

function fakeCtx(
  followups: unknown[],
  commands?: {
    list(agent: unknown): ReadonlyArray<{ name: string; description: string; input?: { hint: string } }>
    execute(agent: unknown, line: string, signal: AbortSignal): Promise<unknown>
  },
  onFollowup?: (message: unknown) => void,
) {
  let creates = 0
  const persisted = new Set<string>()
  const bindings = new Map<string, ConversationBinding>()
  const sessionListeners: Array<(s: { id: string }, e: unknown) => void> = []
  const claimedListeners: Array<(payload: {
    agent: { id: string }
    message: unknown
    turn: number
  }) => void> = []
  const pendingMessages = new Map<string, unknown[]>()
  const approvalListeners: Array<(
    req: unknown,
    next: () => Promise<string>,
  ) => Promise<string>> = []
  return {
    logger: { error() {}, warn() {} },
    on(name: string, fn: (...args: never[]) => unknown) {
      if (name === 'session/event') sessionListeners.push(fn as (s: { id: string }, e: unknown) => void)
      if (name === 'approval/request') {
        approvalListeners.push(fn as (req: unknown, next: () => Promise<string>) => Promise<string>)
      }
      if (name === 'agent/inbox/claimed') {
        claimedListeners.push(fn as unknown as (payload: {
          agent: { id: string }
          message: unknown
          turn: number
        }) => void)
      }
      return () => {}
    },
    get(name: string) {
      if (name === 'approval') return { present: true }
      if (name === 'commands') return commands
      if (name === 'sessionPersistence') {
        return { list: async () => [...persisted].map((id) => ({ id })) }
      }
      if (name === 'larkConversationBindings') {
        return {
          read: (baseId: string) => bindings.get(baseId),
          async put(baseId: string, binding: ConversationBinding) {
            bindings.set(baseId, { ...binding })
          },
          async close() {},
        }
      }
      return undefined
    },
    approval: { present: true },
    agents: {
      async create(opts: { sessionId: unknown }) {
        creates += 1
        const id = String(opts.sessionId)
        return {
          sessionId: id,
          dispose: async () => {},
          agent: {
            session: { id, events: [], append() {}, requestContext: () => undefined },
            status: 'idle',
            inbox: { hasPending: false },
            followup(msg: unknown) {
              persisted.add(id)
              const pending = pendingMessages.get(id) ?? []
              pending.push(msg)
              pendingMessages.set(id, pending)
              if (onFollowup === undefined) followups.push(msg)
              else onFollowup(msg)
            },
            runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
              return task(new AbortController().signal)
            },
            whenIdle() { return Promise.resolve() },
          },
        }
      },
    },
    sessions: {
      async flush(session: { id: string }) {
        persisted.add(session.id)
        return true
      },
    },
    emit(sessionId: string, event: unknown) {
      for (const fn of sessionListeners) fn({ id: sessionId }, event)
      const turn = (event as { type?: unknown; data?: { turn?: unknown } }).type === 'turn/start'
        ? (event as { data?: { turn?: unknown } }).data?.turn
        : undefined
      if (typeof turn !== 'number') return
      const message = pendingMessages.get(sessionId)?.shift()
      if (message === undefined) return
      for (const listener of claimedListeners) {
        listener({ agent: { id: sessionId }, message, turn })
      }
    },
    async requestApproval(req: unknown) {
      const next = async () => 'unavailable'
      if (approvalListeners.length === 0) return 'unavailable'
      return approvalListeners[0](req, next)
    },
    createCount: () => creates,
  }
}

function inbound(partial: Partial<LarkInbound> & Pick<LarkInbound, 'chatId' | 'text'>): LarkInbound {
  return {
    chatType: 'p2p',
    openId: 'ou_ok',
    messageId: 'm1',
    mentioned: false,
    ...partial,
  }
}

interface SdkMessageCall {
  params?: { receive_id_type?: string }
  path?: { message_id?: string }
  data?: {
    receive_id?: string
    msg_type?: string
    content?: string
    reply_in_thread?: boolean
  }
}

interface SdkMessageResponse {
  code?: number
  msg?: string
  data?: { message_id?: string }
}

function setSdkMessageApi(
  client: LarkSdkClient,
  api: {
    create: (call: SdkMessageCall) => Promise<SdkMessageResponse>
    reply: (call: SdkMessageCall) => Promise<SdkMessageResponse>
    patch?: (call: SdkMessageCall) => Promise<SdkMessageResponse>
    update?: (call: SdkMessageCall) => Promise<SdkMessageResponse>
  },
): void {
  const internals = client as unknown as { rest: unknown }
  internals.rest = { im: { v1: { message: api } } }
}

test('splitText chunks long replies', () => {
  const chunks = splitText('abcdefghij', 4)
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij'])
  assert.deepEqual(splitText('ab😀cd', 3), ['ab😀', 'cd'])
  assert.throws(() => splitText('text', 0), RangeError)
})

test('SDK sendText delivers every long reply chunk in order', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const replies: SdkMessageCall[] = []
  let creates = 0
  setSdkMessageApi(client, {
    async create() {
      creates += 1
      return { data: { message_id: 'om_unexpected' } }
    },
    async reply(call) {
      replies.push(call)
      return { data: { message_id: `om_reply_${replies.length}` } }
    },
  })
  const answer = `start-${'答'.repeat(8_000)}-end`

  await client.sendText('chat-a', answer, { replyToMessageId: 'om_inbound' })

  const chunks = replies.map((call) => {
    assert.equal(call.path?.message_id, 'om_inbound')
    assert.equal(call.data?.msg_type, 'text')
    assert.equal('reply_in_thread' in (call.data ?? {}), false)
    return (JSON.parse(call.data?.content ?? '{}') as { text?: string }).text ?? ''
  })
  assert.equal(creates, 0)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => [...chunk].length <= 4_000))
  assert.equal(chunks.join(''), answer)
})

test('SDK thread replies mark every text chunk and card', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const replies: SdkMessageCall[] = []
  let creates = 0
  setSdkMessageApi(client, {
    async create() {
      creates += 1
      return { data: { message_id: 'om_unexpected' } }
    },
    async reply(call) {
      replies.push(call)
      return { data: { message_id: `om_reply_${replies.length}` } }
    },
  })
  const answer = `start-${'答'.repeat(8_000)}-end`
  const options = { replyToMessageId: 'om_thread_message', replyInThread: true }

  await client.sendText('oc_chat', answer, options)
  const cardId = await client.sendCard('oc_chat', { schema: '2.0' }, options)

  const textReplies = replies.slice(0, -1)
  assert.ok(textReplies.length > 1)
  assert.equal(textReplies.map((call) => {
    assert.equal(call.path?.message_id, 'om_thread_message')
    assert.equal(call.data?.msg_type, 'text')
    assert.equal(call.data?.reply_in_thread, true)
    return (JSON.parse(call.data?.content ?? '{}') as { text?: string }).text ?? ''
  }).join(''), answer)
  assert.deepEqual(replies.at(-1), {
    path: { message_id: 'om_thread_message' },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify({ schema: '2.0' }),
      reply_in_thread: true,
    },
  })
  assert.equal(cardId, `om_reply_${replies.length}`)
  assert.equal(creates, 0)
})

test('SDK delivery creates without a reply target and replies cards with one', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const creates: SdkMessageCall[] = []
  const replies: SdkMessageCall[] = []
  setSdkMessageApi(client, {
    async create(call) {
      creates.push(call)
      return { data: { message_id: 'om_created' } }
    },
    async reply(call) {
      replies.push(call)
      return { data: { message_id: 'om_reply' } }
    },
  })

  await client.sendText('oc_chat', 'plain', { replyToMessageId: '', replyInThread: true })
  const cardId = await client.sendCard(
    'oc_chat',
    { schema: '2.0', body: { elements: [] } },
    { replyToMessageId: 'om_inbound' },
  )

  assert.equal(cardId, 'om_reply')
  assert.deepEqual(creates, [{
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: 'oc_chat',
      msg_type: 'text',
      content: JSON.stringify({ text: 'plain' }),
    },
  }])
  assert.deepEqual(replies, [{
    path: { message_id: 'om_inbound' },
    data: {
      msg_type: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
    },
  }])
})

test('SDK signal-bound Card creation uses one cancellable bounded raw request', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const requests: Array<Record<string, unknown>> = []
  const internals = client as unknown as { rest?: unknown }
  internals.rest = {
    async request(options: Record<string, unknown>) {
      requests.push(options)
      return { data: { message_id: 'om_signal_card' } }
    },
    im: { v1: { message: {} } },
  }
  const controller = new AbortController()

  const messageId = await client.sendCard(
    'oc_chat',
    { schema: '2.0' },
    { replyToMessageId: 'om_inbound', replyInThread: true, signal: controller.signal },
  )

  assert.equal(messageId, 'om_signal_card')
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.method, 'POST')
  assert.equal(requests[0]?.url, '/open-apis/im/v1/messages/om_inbound/reply')
  const requestSignal = requests[0]?.signal
  assert.ok(requestSignal instanceof AbortSignal)
  assert.notEqual(requestSignal, controller.signal)
  assert.equal(requestSignal.aborted, false)
  assert.equal(requests[0]?.timeout, 15_000)
  assert.deepEqual(requests[0]?.data, {
    msg_type: 'interactive',
    content: JSON.stringify({ schema: '2.0' }),
    reply_in_thread: true,
  })
  controller.abort(new Error('late caller cancellation'))
  assert.equal(requestSignal.aborted, true)
})

test('SDK signal-bound Card creation aborts without retrying an ambiguous write', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const controller = new AbortController()
  let calls = 0
  const internals = client as unknown as { rest?: unknown }
  internals.rest = {
    request(options: { signal?: AbortSignal }) {
      calls += 1
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => { reject(options.signal?.reason) }, { once: true })
      })
    },
    im: { v1: { message: {} } },
  }
  const sending = client.sendCard(
    'oc_chat',
    { schema: '2.0' },
    { replyToMessageId: 'om_inbound', signal: controller.signal },
  )
  controller.abort(new Error('test cancellation'))

  await assert.rejects(sending, /message\.reply transport failure/u)
  assert.equal(calls, 1)
})

test('SDK signal-bound Card creation settles while token acquisition is stalled and suppresses the late write', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const controller = new AbortController()
  const token = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let writes = 0
  let requestSignal: AbortSignal | undefined
  const internals = client as unknown as { rest?: unknown }
  internals.rest = {
    async request(options: { signal?: AbortSignal }) {
      requestSignal = options.signal
      entered.resolve()
      await token.promise
      options.signal?.throwIfAborted()
      writes += 1
      return { data: { message_id: 'om_must_not_write' } }
    },
    im: { v1: { message: {} } },
  }

  const sending = client.sendCard('oc_chat', { schema: '2.0' }, { signal: controller.signal })
  await entered.promise
  controller.abort(new Error('stop during token acquisition'))
  await assert.rejects(sending, /message\.create transport failure/u)
  assert.equal(requestSignal?.aborted, true)
  assert.equal(writes, 0)

  token.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(writes, 0)
})

test('SDK signal-bound Card creation applies its total deadline before a stalled request settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const entered = Promise.withResolvers<void>()
  let requestSignal: AbortSignal | undefined
  const internals = client as unknown as { rest?: unknown }
  internals.rest = {
    request(options: { signal?: AbortSignal }) {
      requestSignal = options.signal
      entered.resolve()
      return new Promise(() => {})
    },
    im: { v1: { message: {} } },
  }

  const sending = client.sendCard(
    'oc_chat',
    { schema: '2.0' },
    { signal: new AbortController().signal },
  )
  await entered.promise
  t.mock.timers.tick(15_000)

  await assert.rejects(sending, /message\.create transport failure/u)
  assert.equal(requestSignal?.aborted, true)
})

test('SDK signal-bound Card patch uses one raw request and never falls back or retries', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const controller = new AbortController()
  const requests: Array<Record<string, unknown>> = []
  let generatedPatches = 0
  let generatedUpdates = 0
  const internals = client as unknown as { rest?: unknown }
  internals.rest = {
    async request(options: Record<string, unknown>) {
      requests.push(options)
      return { code: 0 }
    },
    im: { v1: { message: {
      async patch() { generatedPatches += 1 },
      async update() { generatedUpdates += 1 },
    } } },
  }

  await client.updateCard('om_card', { schema: '2.0' }, { signal: controller.signal })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.method, 'PATCH')
  assert.equal(requests[0]?.url, '/open-apis/im/v1/messages/om_card')
  assert.equal(requests[0]?.timeout, 15_000)
  const requestSignal = requests[0]?.signal
  assert.ok(requestSignal instanceof AbortSignal)
  assert.notEqual(requestSignal, controller.signal)
  assert.equal(generatedPatches, 0)
  assert.equal(generatedUpdates, 0)
})

test('SDK reply failures do not fall back to chat delivery', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  let creates = 0
  setSdkMessageApi(client, {
    async create() {
      creates += 1
      return { data: { message_id: 'om_unexpected' } }
    },
    async reply() {
      throw new Error('reply unavailable')
    },
  })

  await assert.rejects(
    client.sendText('oc_chat', 'answer', { replyToMessageId: 'om_inbound' }),
    /message\.reply transport failure/,
  )
  assert.equal(creates, 0)
})

test('SDK resolved delivery errors and missing message ids reject without fallback', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  let creates = 0
  let response: SdkMessageResponse = { code: 230_071, msg: 'reply target unavailable' }
  setSdkMessageApi(client, {
    async create() {
      creates += 1
      return { data: { message_id: 'om_unexpected' } }
    },
    async reply() { return response },
  })

  await assert.rejects(
    client.sendText('oc_chat', 'answer', { replyToMessageId: 'om_inbound' }),
    /message\.reply business failure \(code 230071\)/,
  )
  response = { code: 0, data: {} }
  await assert.rejects(
    client.sendCard('oc_chat', { schema: '2.0' }, { replyToMessageId: 'om_inbound' }),
    /missing message_id/,
  )
  assert.equal(creates, 0)
})

test('SDK card updates validate patch responses and never retry an ambiguous failure', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const patches: SdkMessageCall[] = []
  let updates = 0
  let response: SdkMessageResponse = { code: 0 }
  setSdkMessageApi(client, {
    async create() { return { data: { message_id: 'om_created' } } },
    async reply() { return { data: { message_id: 'om_reply' } } },
    async patch(call) {
      patches.push(call)
      return response
    },
    async update() {
      updates += 1
      return { code: 0 }
    },
  })

  await client.updateCard('om_card', { schema: '2.0' })
  assert.deepEqual(patches, [{
    path: { message_id: 'om_card' },
    data: { content: JSON.stringify({ schema: '2.0' }) },
  }])
  response = { code: 230_099, msg: 'private payload must not escape' }
  await assert.rejects(
    client.updateCard('om_card', { schema: '2.0' }),
    /message\.patch business failure \(code 230099\)/,
  )
  assert.equal(updates, 0)
})

test('SDK card updates fall back only when patch is absent and sanitize HTTP failures', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const updates: SdkMessageCall[] = []
  setSdkMessageApi(client, {
    async create() { return { data: { message_id: 'om_created' } } },
    async reply() { return { data: { message_id: 'om_reply' } } },
    async update(call) {
      updates.push(call)
      return { code: 0 }
    },
  })

  await client.updateCard('om_card', { schema: '2.0' })
  assert.equal(updates.length, 1)
  setSdkMessageApi(client, {
    async create() { return { data: { message_id: 'om_created' } } },
    async reply() { return { data: { message_id: 'om_reply' } } },
    async update() { return { code: 230_099, msg: 'private payload must not escape' } },
  })
  await assert.rejects(
    client.updateCard('om_card', { schema: '2.0' }),
    /message\.update business failure \(code 230099\)/,
  )
  setSdkMessageApi(client, {
    async create() { return { data: { message_id: 'om_created' } } },
    async reply() { return { data: { message_id: 'om_reply' } } },
    async patch() {
      throw {
        response: { status: 400, data: { code: 230_099, msg: 'secret-card-payload' } },
        config: { headers: { authorization: 'test-secret' } },
      }
    },
    async update() {
      assert.fail('update must not retry a rejected patch')
    },
  })

  const error = await client.updateCard('om_card', { secret: 'card-payload' }).catch((reason: unknown) => reason)
  assert.match(String(error), /message\.patch http failure \(status 400, code 230099\)/)
  assert.doesNotMatch(String(error), /secret|payload|authorization/u)
})

test('SDK message creation sanitizes HTTP failures and rejects malformed responses', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  setSdkMessageApi(client, {
    async create() {
      throw {
        response: { status: 503, data: { code: 230_099, msg: 'secret-card-payload' } },
        config: { headers: { authorization: 'test-secret' } },
      }
    },
    async reply() { return { data: { message_id: 'om_reply' } } },
  })

  const failure = await client.sendText('oc_chat', 'answer').catch((reason: unknown) => reason)
  assert.match(String(failure), /message\.create http failure \(status 503, code 230099\)/)
  assert.doesNotMatch(String(failure), /secret|payload|authorization/u)
  setSdkMessageApi(client, {
    async create() { return { code: '0' } as never },
    async reply() { return { data: { message_id: 'om_reply' } } },
  })
  await assert.rejects(
    client.sendCard('oc_chat', { schema: '2.0' }),
    /message\.create returned a malformed response code/,
  )
})

test('SDK stopReceiving closes WebSocket but preserves REST sending until stop', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const sent: string[] = []
  let closes = 0
  const internals = client as unknown as {
    ws?: { close: () => void; getConnectionStatus: () => unknown }
  }
  internals.ws = {
    close() { closes += 1 },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 }
    },
  }
  setSdkMessageApi(client, {
    async create(call) {
      sent.push((JSON.parse(call.data?.content ?? '{}') as { text?: string }).text ?? '')
      return { data: { message_id: 'om_created' } }
    },
    async reply() { return { data: { message_id: 'om_reply' } } },
  })

  assert.deepEqual(client.connectionHealth(), {
    state: 'connected',
    ready: true,
    reconnectAttempts: 0,
  })
  await client.stopReceiving()
  await client.sendText('chat-a', 'still deliverable')

  assert.equal(closes, 1)
  assert.deepEqual(client.connectionHealth(), {
    state: 'stopped',
    ready: false,
    reconnectAttempts: 0,
  })
  assert.deepEqual(sent, ['still deliverable'])
  await client.stop()
  await assert.rejects(client.sendText('chat-a', 'too late'), /not started/)
})

test('SDK connection health maps every SDK lifecycle state and valid metadata', () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const internals = client as unknown as { ws?: { getConnectionStatus: () => unknown } }
  const lastConnectTime = Date.UTC(2026, 7, 16, 10, 20, 30)
  const nextConnectTime = lastConnectTime + 5_000

  for (const state of ['idle', 'connecting', 'connected', 'reconnecting', 'failed'] as const) {
    internals.ws = {
      getConnectionStatus: () => ({
        state,
        reconnectAttempts: 3,
        lastConnectTime,
        nextConnectTime,
      }),
    }
    assert.deepEqual(client.connectionHealth(), {
      state,
      ready: state === 'connected',
      reconnectAttempts: 3,
      lastAttemptAt: '2026-08-16T10:20:30.000Z',
      nextAttemptAt: '2026-08-16T10:20:35.000Z',
    })
  }
})

test('SDK connection health rejects malformed snapshots and filters invalid metadata', () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const internals = client as unknown as {
    ws?: { getConnectionStatus?: () => unknown }
  }
  const unknown = { state: 'unknown', ready: false, reconnectAttempts: 0 }

  assert.deepEqual(client.connectionHealth(), unknown)
  internals.ws = {}
  assert.deepEqual(client.connectionHealth(), unknown)
  internals.ws = { getConnectionStatus: () => { throw new Error('SDK status unavailable') } }
  assert.deepEqual(client.connectionHealth(), unknown)
  for (const status of [undefined, null, [], 'connected', {}, { state: 'other' }]) {
    internals.ws = { getConnectionStatus: () => status }
    assert.deepEqual(client.connectionHealth(), unknown)
  }

  internals.ws = {
    getConnectionStatus: () => ({
      state: 'reconnecting',
      reconnectAttempts: -1,
      lastConnectTime: Number.MAX_SAFE_INTEGER,
      nextConnectTime: 'soon',
    }),
  }
  assert.deepEqual(client.connectionHealth(), {
    state: 'reconnecting',
    ready: false,
    reconnectAttempts: 0,
  })
})

test('plain-text fallback neutralizes platform mentions', () => {
  assert.equal(
    neutralizeTextMentions('before <at user_id="all">all</at> after'),
    'before &lt;at user_id="all">all&lt;/at> after',
  )
})

test('unwrapCardAction reads operator and button value', () => {
  const action = unwrapCardAction({
    operator: { open_id: 'ou_ok' },
    action: { value: { decision: 'allowed-once', request_id: 'r1' } },
    context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
  })
  assert.equal(action.openId, 'ou_ok')
  assert.equal(action.chatId, 'oc_1')
  assert.equal(action.messageId, 'om_1')
  assert.equal(action.value.decision, 'allowed-once')
})

test('the public Card action type remains source-compatible with pre-form consumers', () => {
  const legacyAction: LarkCardAction = {
    openId: 'user',
    chatId: 'chat',
    messageId: 'message',
    value: { action: 'turn_stop' },
  }
  assert.equal(legacyAction.value.action, 'turn_stop')
})

test('SDK inbound maps text and keeps unsupported content metadata-only', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  let receiveMessage: ((data: unknown) => Promise<void>) | undefined
  let dispatcherLogger: unknown
  const received: LarkInbound[] = []
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function captureDispatcher({ eventDispatcher }) {
    const dispatcher = eventDispatcher as unknown as {
      handles: Map<string, (data: unknown) => Promise<void>>
      logger?: { logger?: unknown }
    }
    receiveMessage = dispatcher.handles.get('im.message.receive_v1')
    dispatcherLogger = dispatcher.logger?.logger
    const client = this as unknown as { onReady?: () => void }
    client.onReady?.()
  }
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const internals = client as unknown as { prepareLoadingImage: () => Promise<void> }
  internals.prepareLoadingImage = async () => {}
  client.onMessage(async (message) => { received.push(message) })
  try {
    await client.start()
    const sdkInternals = client as unknown as {
      rest?: { logger?: { logger?: unknown } }
      ws?: { logger?: { logger?: unknown } }
    }
    const privateLogger = sdkInternals.rest?.logger?.logger
    assert.ok(privateLogger !== undefined)
    assert.equal(sdkInternals.ws?.logger?.logger, privateLogger)
    assert.equal(dispatcherLogger, privateLogger)
    assert.notEqual(privateLogger, Lark.defaultLogger)
    assert.ok(receiveMessage)
    await receiveMessage({
      message: {
        chat_id: 'oc_thread_chat',
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 continue here' }),
        message_id: 'om_current',
        message_type: 'text',
        mentions: [{ key: '@_user_1', id: { open_id: 'test-bot' } }],
        root_id: 'om_root',
        parent_id: 'om_parent',
        thread_id: 'omt_thread',
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_sender' },
      },
    })

    assert.deepEqual(received[0], {
      chatId: 'oc_thread_chat',
      chatType: 'group',
      openId: 'ou_sender',
      text: 'continue here',
      messageId: 'om_current',
      rootId: 'om_root',
      parentId: 'om_parent',
      threadId: 'omt_thread',
      mentioned: true,
    })
    await receiveMessage({
      message: {
        chat_id: 'oc_thread_chat',
        chat_type: 'group',
        content: JSON.stringify({ image_key: 'private-image-key', file_name: 'private.png' }),
        message_id: 'om_image',
        message_type: 'image',
        mentions: [{ key: '@_user_1', id: { open_id: 'test-bot' } }],
        root_id: 'om_root',
        parent_id: 'om_current',
        thread_id: 'omt_thread',
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_sender' },
      },
    })
    assert.deepEqual(received[1], {
      chatId: 'oc_thread_chat',
      chatType: 'group',
      openId: 'ou_sender',
      text: '',
      messageType: 'image',
      messageId: 'om_image',
      rootId: 'om_root',
      parentId: 'om_current',
      threadId: 'omt_thread',
      mentioned: true,
    })
    assert.doesNotMatch(JSON.stringify(received[1]), /private-image-key|private\.png/)

    await receiveMessage({
      message: {
        chat_id: 'oc_thread_chat',
        chat_type: 'group',
        content: JSON.stringify({ file_key: 'bot-file-key' }),
        message_id: 'om_bot_file',
        message_type: 'file',
      },
      sender: {
        sender_type: 'bot',
        sender_id: { open_id: 'ou_bot' },
      },
    })
    assert.equal(received.length, 2)

    await receiveMessage({
      message: {
        chat_id: 'oc_thread_chat',
        chat_type: 'group',
        content: JSON.stringify({ file_key: 'missing-id-key' }),
        message_id: '',
        message_type: 'file',
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_sender' },
      },
    })
    assert.equal(received.length, 2)
  } finally {
    await client.stop()
    prototype.request = request
    Lark.WSClient.prototype.start = start
  }
})

test('SDK Card callback preserves form values and returns a raw terminal Card unchanged', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  let receiveAction: ((data: unknown) => Promise<unknown>) | undefined
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function captureDispatcher({ eventDispatcher }) {
    const dispatcher = eventDispatcher as unknown as {
      handles: Map<string, (data: unknown) => Promise<unknown>>
    }
    receiveAction = dispatcher.handles.get('card.action.trigger')
    ;(this as unknown as { onReady?: () => void }).onReady?.()
  }
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  ;(client as unknown as { prepareLoadingImage: () => Promise<void> }).prepareLoadingImage = async () => {}
  const terminal = { schema: '2.0', body: { elements: [{ tag: 'div' }] } }
  client.onCardAction(async (action) => {
    assert.equal(action.tag, 'button')
    assert.equal(action.name, 'human_input_submit')
    assert.deepEqual(action.formValue, { q0: 'q0_o1', c1: 'text' })
    return {
      toast: { type: 'success', content: 'submitted' },
      card: { type: 'raw', data: terminal },
    }
  })
  try {
    await client.start()
    assert.ok(receiveAction !== undefined)
    const result = await receiveAction({
      operator: { open_id: 'owner' },
      action: {
        tag: 'button',
        name: 'human_input_submit',
        value: {},
        form_value: { q0: 'q0_o1', c1: 'text' },
      },
      context: { open_chat_id: 'chat', open_message_id: 'message' },
    })
    assert.deepEqual(result, {
      toast: { type: 'success', content: 'submitted' },
      card: { type: 'raw', data: terminal },
    })
  } finally {
    await client.stop()
    prototype.request = request
    Lark.WSClient.prototype.start = start
  }
})

test('SDK lark domain maps both REST and WebSocket clients to open.larksuite.com', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function startReady() {
    const client = this as unknown as { onReady?: () => void }
    client.onReady?.()
  }
  const client = new LarkSdkClient({
    appId: 'test-app-id',
    appSecret: 'test-only-secret',
    domain: 'lark',
  })
  const internals = client as unknown as {
    rest?: { domain?: string }
    ws?: { wsConfig?: { client?: { domain?: string } } }
    prepareLoadingImage: () => Promise<void>
  }
  internals.prepareLoadingImage = async () => {}
  try {
    await client.start()
    assert.equal(internals.rest?.domain, 'https://open.larksuite.com')
    assert.equal(internals.ws?.wsConfig?.client?.domain, 'https://open.larksuite.com')
  } finally {
    await client.stop()
    prototype.request = request
    Lark.WSClient.prototype.start = start
  }
})

test('SDK startup failures reject client startup', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async () => { throw new Error('startup unavailable') }
  try {
    const client = new LarkSdkClient({
      appId: 'test-app-id',
      appSecret: 'test-only-secret',
    })
    await assert.rejects(client.start(), /startup unavailable/)
  } finally {
    prototype.request = request
    Lark.WSClient.prototype.start = start
  }
})

test('SDK bot identity failures discard raw credentials before startup rejects', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  prototype.request = async () => {
    throw {
      response: { status: 503, data: { code: 99_999, msg: 'private identity response' } },
      config: {
        data: { app_secret: 'test-private-secret' },
        headers: { authorization: 'Bearer test-private-token' },
      },
    }
  }
  try {
    const client = new LarkSdkClient({
      appId: 'test-app-id',
      appSecret: 'test-only-secret',
    })
    const error = await client.start().catch((reason: unknown) => reason)
    assert.match(String(error), /bot\.info http failure \(status 503, code 99999\)/)
    assert.doesNotMatch(
      `${String(error)} ${JSON.stringify(error)}`,
      /identity response|app_secret|private-secret|authorization|private-token/u,
    )
    await client.stop()
  } finally {
    prototype.request = request
  }
})

test('SDK client can reply while the optional loading image is still uploading', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  const loading = Promise.withResolvers<void>()
  const loadingStarted = Promise.withResolvers<void>()
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function startReady() {
    const client = this as unknown as { onReady?: () => void }
    client.onReady?.()
  }
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const internals = client as unknown as {
    prepareLoadingImage: () => Promise<void>
    rest?: unknown
  }
  internals.prepareLoadingImage = async () => {
    loadingStarted.resolve()
    await loading.promise
  }
  try {
    const starting = client.start()
    await loadingStarted.promise
    assert.notEqual(internals.rest, undefined)
    loading.resolve()
    await starting
  } finally {
    loading.resolve()
    await client.stop()
    prototype.request = request
    Lark.WSClient.prototype.start = start
  }
})

test('SDK startup rejects when the client stops during loading image preparation', async () => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  const loading = Promise.withResolvers<void>()
  const loadingStarted = Promise.withResolvers<void>()
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function startReady() {
    const client = this as unknown as { onReady?: () => void }
    client.onReady?.()
  }
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const internals = client as unknown as { prepareLoadingImage: () => Promise<void> }
  internals.prepareLoadingImage = async () => {
    loadingStarted.resolve()
    await loading.promise
  }
  try {
    const starting = client.start()
    await loadingStarted.promise
    await client.stop()
    loading.resolve()

    await assert.rejects(starting, /client stopped during startup/)
    await assert.rejects(client.sendText('chat-a', 'too late'), /not started/)
  } finally {
    loading.resolve()
    await client.stop()
    prototype.request = request
    Lark.WSClient.prototype.start = start
  }
})

test('Cordis plugin loading rejects a failed WebSocket connection', async (t) => {
  const prototype = Lark.Client.prototype as unknown as {
    request: (options: unknown) => Promise<unknown>
  }
  const request = prototype.request
  const start = Lark.WSClient.prototype.start
  const previousAppId = process.env.DSH_LARK_APP_ID
  const previousAppSecret = process.env.DSH_LARK_APP_SECRET
  const wsStarted = Promise.withResolvers<void>()
  const failWs = Promise.withResolvers<void>()
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function startWithError() {
    wsStarted.resolve()
    await failWs.promise
    const client = this as unknown as { onError?: (error: Error) => void }
    client.onError?.(new Error('startup unavailable'))
  }
  process.env.DSH_LARK_APP_ID = ['cli', '0'.repeat(16)].join('_')
  process.env.DSH_LARK_APP_SECRET = 'test-only-secret'
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-startup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  let activeRoute: Parameters<WebServerLike['register']>[0] | undefined
  let healthDisposals = 0
  await ctx.plugin((providerCtx: Context) => {
    providerCtx.provide('webServer', {
      register(route) {
        activeRoute = route
        return () => {
          activeRoute = undefined
          healthDisposals += 1
        }
      },
    } satisfies WebServerLike)
  })
  const plugin = {
    name: 'lark-startup-test',
    inject: ['storageDomain'],
    apply: (pluginCtx: Context) => apply(pluginCtx, {}),
  }
  const fiber = ctx.plugin(plugin as never, {})
  try {
    const failure = assert.rejects(fiber.await(), /startup unavailable/)
    await wsStarted.promise
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(activeRoute?.path, LARK_HEALTH_PATH)
    let healthStatus = 0
    await activeRoute.handler(
      { method: 'GET' } as never,
      {
        writeHead(status: number) {
          healthStatus = status
          return this
        },
        end() { return this },
      } as never,
    )
    assert.equal(healthStatus, 503)

    failWs.resolve()
    await failure
    assert.equal(activeRoute, undefined)
    assert.equal(healthDisposals, 1)
    assert.equal(ctx.storageDomain.get('lark_inbound'), undefined)
    assert.equal(ctx.storageDomain.get('lark_conversations'), undefined)
  } finally {
    failWs.resolve()
    await fiber.dispose()
    await ctx.fiber.dispose()
    prototype.request = request
    Lark.WSClient.prototype.start = start
    if (previousAppId === undefined) delete process.env.DSH_LARK_APP_ID
    else process.env.DSH_LARK_APP_ID = previousAppId
    if (previousAppSecret === undefined) delete process.env.DSH_LARK_APP_SECRET
    else process.env.DSH_LARK_APP_SECRET = previousAppSecret
  }
})

test('plugin construction failure releases its durable Lark domains', async (t) => {
  const previousAppId = process.env.DSH_LARK_APP_ID
  const previousAppSecret = process.env.DSH_LARK_APP_SECRET
  process.env.DSH_LARK_APP_ID = ['cli', '1'.repeat(16)].join('_')
  process.env.DSH_LARK_APP_SECRET = 'test-only-secret'
  const ctx = new Context()
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-construction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })

    await assert.rejects(apply(ctx, { streamUpdateIntervalMs: 99 }), /streamUpdateIntervalMs/)
    assert.equal(ctx.storageDomain.get('lark_inbound'), undefined)
    assert.equal(ctx.storageDomain.get('lark_conversations'), undefined)
  } finally {
    await ctx.fiber.dispose()
    if (previousAppId === undefined) delete process.env.DSH_LARK_APP_ID
    else process.env.DSH_LARK_APP_ID = previousAppId
    if (previousAppSecret === undefined) delete process.env.DSH_LARK_APP_SECRET
    else process.env.DSH_LARK_APP_SECRET = previousAppSecret
  }
})

test('the exported plugin entry is non-constructible and root disposal awaits its async teardown', async (t) => {
  assert.equal(Object.hasOwn(apply, 'prototype'), false)
  const previousAppId = process.env.DSH_LARK_APP_ID
  const previousAppSecret = process.env.DSH_LARK_APP_SECRET
  process.env.DSH_LARK_APP_ID = ['cli', '2'.repeat(16)].join('_')
  process.env.DSH_LARK_APP_SECRET = 'test-only-secret'
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-root-disposer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  const clientPrototype = Lark.Client.prototype as unknown as {
    request(options: unknown): Promise<unknown>
  }
  const wsPrototype = Lark.WSClient.prototype as unknown as {
    start(options: unknown): Promise<void>
    close(options?: unknown): void
  }
  const sdkPrototype = LarkSdkClient.prototype as unknown as {
    prepareLoadingImage(rest: unknown): Promise<void>
    stop(): Promise<void>
  }
  const request = clientPrototype.request
  const wsStart = wsPrototype.start
  const wsClose = wsPrototype.close
  const prepareLoadingImage = sdkPrototype.prepareLoadingImage
  const sdkStop = sdkPrototype.stop
  let wsCloses = 0
  let stopCompleted = false
  clientPrototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  wsPrototype.start = async function startForRootDisposal() {
    const client = this as unknown as { onReady?: () => void }
    client.onReady?.()
  }
  wsPrototype.close = () => { wsCloses += 1 }
  sdkPrototype.prepareLoadingImage = async () => {}
  sdkPrototype.stop = async function delayedStop() {
    await new Promise((resolve) => setTimeout(resolve, 40))
    await sdkStop.call(this)
    stopCompleted = true
  }
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    ctx.provide('agents', {} as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('tools', {} as never)

    const fiber = ctx.plugin(LarkPlugin as never, {})
    await fiber.await()
    const storageDomain = ctx.storageDomain
    assert.ok(storageDomain.get('lark_inbound') !== undefined)
    assert.ok(storageDomain.get('lark_conversations') !== undefined)

    const startedAt = Date.now()
    await ctx.fiber.dispose()
    assert.ok(Date.now() - startedAt >= 35)
    assert.equal(stopCompleted, true)
    assert.equal(wsCloses, 1)
    assert.equal(storageDomain.get('lark_inbound'), undefined)
    assert.equal(storageDomain.get('lark_conversations'), undefined)
  } finally {
    await ctx.fiber.dispose()
    clientPrototype.request = request
    wsPrototype.start = wsStart
    wsPrototype.close = wsClose
    sdkPrototype.prepareLoadingImage = prepareLoadingImage
    sdkPrototype.stop = sdkStop
    if (previousAppId === undefined) delete process.env.DSH_LARK_APP_ID
    else process.env.DSH_LARK_APP_ID = previousAppId
    if (previousAppSecret === undefined) delete process.env.DSH_LARK_APP_SECRET
    else process.env.DSH_LARK_APP_SECRET = previousAppSecret
  }
})

test('inbound text recognizes and removes only the bot mention', () => {
  const normalized = normalizeInboundText(
    JSON.stringify({ text: '@_user_1 ask @_user_2' }),
    [
      { key: '@_user_1', id: { open_id: 'bot-id' } },
      { key: '@_user_2', id: { open_id: 'other-id' } },
    ],
    'bot-id',
  )
  assert.deepEqual(normalized, { text: 'ask @_user_2', mentioned: true })
  assert.equal(normalizeInboundText(
    JSON.stringify({ text: '@_user_2 ask' }),
    [{ key: '@_user_2', id: { open_id: 'other-id' } }],
    'bot-id',
  ).mentioned, false)
})

test('deny unauthorized', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, {
    client,
    allowFrom: ['ou_ok'],
    allowAllUsers: false,
  })
  bridge.start()
  await bridge.handleInbound(inbound({
    chatId: 'oc_1',
    openId: 'ou_stranger',
    text: 'hi',
  }))
  assert.deepEqual(client.sent, ['没有权限。'])
  assert.equal(followups.length, 0)
  await bridge.stop()
})

test('empty allowFrom + allowAllUsers false denies all', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, {
    client,
    allowFrom: [],
    allowAllUsers: false,
  })
  bridge.start()
  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: 'hi' }))
  assert.deepEqual(client.sent, ['没有权限。'])
  assert.equal(followups.length, 0)
  await bridge.stop()
})

test('p2p text becomes followup', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, {
    client,
    allowAllUsers: true,
  })
  bridge.start()
  await bridge.handleInbound(inbound({
    chatId: 'oc_1',
    text: 'hello agent',
  }))
  assert.equal(followups.length, 1)
  await bridge.stop()
})

test('duplicate inbound message becomes one followup', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, {
    client,
    allowAllUsers: true,
  })
  bridge.start()
  const message = inbound({ chatId: 'oc_1', text: 'hello once' })
  await Promise.all([
    bridge.handleInbound(message),
    bridge.handleInbound(message),
  ])
  assert.equal(followups.length, 1)
  await bridge.stop()
})

test('durable inbound receipt skips an already completed message', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const checked: string[] = []
  const bridge = new LarkBridge(fakeCtx(followups) as never, {
    client,
    allowAllUsers: true,
    inboundDeduplicator: {
      has(key) {
        checked.push(key)
        return true
      },
      async complete() {
        assert.fail('a durable hit must not be completed again')
      },
    },
  })
  await bridge.start()

  await client.handler?.(inbound({ chatId: 'oc_1', text: 'already handled' }))

  assert.deepEqual(checked, ['oc_1\0m1'])
  assert.equal(followups.length, 0)
  await bridge.stop()
})

test('a failed durable completion rejects the handler and permits retry', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  let checks = 0
  let completions = 0
  const bridge = new LarkBridge(fakeCtx(followups) as never, {
    client,
    allowAllUsers: true,
    inboundDeduplicator: {
      has() {
        checks += 1
        return false
      },
      async complete() {
        completions += 1
        if (completions === 1) throw new Error('receipt unavailable')
      },
    },
  })
  await bridge.start()
  const message = inbound({ chatId: 'oc_1', text: 'retry me' })

  await assert.rejects(client.handler!(message), /receipt unavailable/)
  await client.handler!(message)

  assert.equal(checks, 2)
  assert.equal(completions, 2)
  assert.equal(followups.length, 2)
  await bridge.stop()
})

test('a failed agent followup is not durably completed and permits retry', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  let attempts = 0
  let completions = 0
  const ctx = fakeCtx(followups, undefined, (message) => {
    attempts += 1
    if (attempts === 1) throw new Error('followup unavailable')
    followups.push(message)
  })
  const bridge = new LarkBridge(ctx as never, {
    client,
    allowAllUsers: true,
    inboundDeduplicator: {
      has: () => false,
      async complete() { completions += 1 },
    },
  })
  await bridge.start()
  const message = inbound({ chatId: 'oc_1', text: 'admit me' })

  await assert.rejects(client.handler!(message), /followup unavailable/)
  assert.equal(completions, 0)
  assert.deepEqual(client.sent, ['消息提交失败，请重试。'])
  await client.handler!(message)

  assert.equal(attempts, 2)
  assert.equal(completions, 1)
  assert.equal(followups.length, 1)
  await bridge.stop()
})

test('stop closes inbound admission before draining receipts and fully stopping', async () => {
  const client = fakeClient()
  const events: string[] = []
  const receiptStarted = Promise.withResolvers<void>()
  const receipt = Promise.withResolvers<void>()
  client.stopReceiving = async () => { events.push('stop-receiving') }
  client.stop = async () => { events.push('stop') }
  const bridge = new LarkBridge(fakeCtx([]) as never, {
    client,
    allowAllUsers: true,
    inboundDeduplicator: {
      has: () => false,
      async complete() {
        events.push('receipt-start')
        receiptStarted.resolve()
        await receipt.promise
        events.push('receipt-complete')
      },
    },
  })
  await bridge.start()
  const handling = client.handler!(inbound({ chatId: 'oc_1', text: 'in progress' }))
  await receiptStarted.promise

  const stopping = bridge.stop()
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(events, ['receipt-start', 'stop-receiving'])
  await assert.rejects(
    client.handler!(inbound({ chatId: 'oc_1', text: 'too late', messageId: 'm2' })),
    /bridge is stopping/,
  )
  assert.equal(events.includes('stop'), false)

  receipt.resolve()
  await handling
  await stopping
  assert.deepEqual(events, ['receipt-start', 'stop-receiving', 'receipt-complete', 'stop'])
})

test('start rejects during teardown and can restart after teardown settles', async () => {
  const client = fakeClient()
  const stopReceivingStarted = Promise.withResolvers<void>()
  const releaseStopReceiving = Promise.withResolvers<void>()
  let starts = 0
  let stops = 0
  client.start = async () => { starts += 1 }
  client.stopReceiving = async () => {
    stopReceivingStarted.resolve()
    await releaseStopReceiving.promise
  }
  client.stop = async () => { stops += 1 }
  const bridge = new LarkBridge(fakeCtx([]) as never, { client, allowAllUsers: true })
  await bridge.start()

  const stopping = bridge.stop()
  await stopReceivingStarted.promise
  assert.equal(bridge.stop(), stopping)
  await assert.rejects(bridge.start(), /bridge is stopping/)

  releaseStopReceiving.resolve()
  await stopping
  await bridge.start()
  await bridge.stop()
  assert.equal(starts, 2)
  assert.equal(stops, 2)
})

test('group text without mention is ignored', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  bridge.start()
  await bridge.handleInbound(inbound({
    chatId: 'oc_g',
    chatType: 'group',
    text: 'noise',
    mentioned: false,
  }))
  assert.equal(followups.length, 0)
  await bridge.stop()
})

test('bind-session reuses one agents.create across chats', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, {
    client,
    allowAllUsers: true,
    defaultSessionId: 'shared-session',
  })
  bridge.start()
  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: 'from chat 1' }))
  await bridge.handleInbound(inbound({ chatId: 'oc_2', text: 'from chat 2' }))
  assert.equal(ctx.createCount(), 1)
  assert.equal(followups.length, 2)
  await bridge.stop()
})

test('approval card approve', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  bridge.start()
  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: 'do a thing' }))
  ctx.emit('lark:oc_1', { type: 'turn/start', data: { turn: 1 } })
  const outcomeP = ctx.requestApproval({
    agent: { session: { id: 'lark:oc_1' } },
    toolName: 'bash',
    reason: 'run a command',
  })
  await Promise.resolve()
  const approvalCards = client.cards.filter(({ card }) => requestIdOf(card) !== '')
  assert.equal(approvalCards.length, 1)
  const approvalCard = approvalCards[0]
  assert.ok(approvalCard !== undefined)
  const requestId = requestIdOf(approvalCard.card)
  assert.ok(requestId !== '')
  await bridge.handleCardAction({
    openId: 'ou_ok',
    chatId: 'oc_1',
    messageId: approvalCard.messageId,
    value: { decision: 'allowed-once', request_id: requestId },
  })
  assert.equal(await outcomeP, 'allowed-once')
  assert.equal(client.updated.length, 1)
  await bridge.stop()
})

test('approval card deny', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, { client, allowFrom: ['ou_ok'] })
  bridge.start()
  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: 'do a thing' }))
  ctx.emit('lark:oc_1', { type: 'turn/start', data: { turn: 1 } })
  const outcomeP = ctx.requestApproval({
    agent: { session: { id: 'lark:oc_1' } },
    toolName: 'bash',
    reason: 'run a command',
  })
  await Promise.resolve()
  const approvalCard = client.cards.find(({ card }) => requestIdOf(card) !== '')
  assert.ok(approvalCard !== undefined)
  const requestId = requestIdOf(approvalCard.card)
  await bridge.handleCardAction({
    openId: 'ou_ok',
    chatId: 'oc_1',
    messageId: approvalCard.messageId,
    value: { decision: 'rejected', request_id: requestId },
  })
  assert.equal(await outcomeP, 'rejected')
  assert.equal(client.updated.length, 1)
  await bridge.stop()
})

test('/help does not followup', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  bridge.start()
  await bridge.handleInbound(inbound({
    chatId: 'oc_1',
    text: '/help',
  }))
  assert.equal(followups.length, 0)
  assert.ok(client.sent.some((s) => s.includes('/new')))
  await bridge.stop()
})

test('registered DSH slash commands appear in help and execute natively', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const executed: string[] = []
  const ctx = fakeCtx(followups, {
    list: () => [
      {
        name: 'feedback',
        description: 'record feedback about this session',
        input: { hint: '<text>' },
      },
      {
        name: 'goal',
        description: 'set or view the goal for a long-running task',
        input: { hint: '[<objective>|clear]' },
      },
    ],
    async execute(_agent, line) {
      executed.push(line)
      if (line === '/broken') return { commandId: 'command-2', result: { kind: 'error' } }
      return { commandId: 'command-1', result: { kind: 'success', text: 'Goal updated.' } }
    },
  })
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  bridge.start()

  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/help', messageId: 'help' }))
  assert.match(client.sent.at(-1) ?? '', /\/goal \[<objective>\|clear\] — 查看或设置长任务目标/)
  assert.doesNotMatch(client.sent.at(-1) ?? '', /feedback/)

  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/goal edit ship it', messageId: 'goal' }))
  assert.deepEqual(executed, ['/goal edit ship it'])
  assert.equal(client.sent.at(-1), 'Goal updated.')

  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/feedback private', messageId: 'feedback' }))
  assert.deepEqual(executed, ['/goal edit ship it'])
  assert.match(client.sent.at(-1) ?? '', /未知命令 \/feedback/)

  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/broken', messageId: 'broken' }))
  assert.equal(client.sent.at(-1), '命令执行失败，请重试。')
  assert.equal(followups.length, 0)
  await bridge.stop()
})

test('runtime slash commands block only their own concurrent session reset', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const ctx = fakeCtx(followups, {
    list: () => [{ name: 'compact', description: 'compact history' }],
    async execute() {
      entered.resolve()
      await release.promise
      return { commandId: 'command-1', result: { kind: 'success', text: 'Compacted.' } }
    },
  })
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  bridge.start()

  const command = bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/compact', messageId: 'compact' }))
  await entered.promise
  const otherChat = bridge.handleInbound(inbound({ chatId: 'oc_2', text: 'hello', messageId: 'hello' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(followups.length, 1)
  await otherChat

  const reset = bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/new', messageId: 'new' }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ctx.createCount(), 2)

  release.resolve()
  await Promise.all([command, reset])
  assert.equal(ctx.createCount(), 3)
  await bridge.stop()
})

test('/new fails closed when a direct bridge embedding omits conversation bindings', async () => {
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const get = ctx.get.bind(ctx)
  ctx.get = (name: string) => (
    name === 'larkConversationBindings' ? undefined : get(name)
  )
  const client = fakeClient()
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  await bridge.start()

  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/new', messageId: 'new-without-sidecar' }))
  assert.equal(ctx.createCount(), 1)
  assert.equal(followups.length, 0)
  assert.match(client.sent.at(-1) ?? '', /当前会话保持不变/)
  await bridge.stop()
})

test('/new fails closed when conversation bindings exist without session persistence', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const get = ctx.get.bind(ctx)
  ctx.get = (name: string) => name === 'sessionPersistence' ? undefined : get(name)
  const bridge = new LarkBridge(ctx as never, { client, allowAllUsers: true })
  await bridge.start()

  await bridge.handleInbound(inbound({ chatId: 'oc_1', text: '/new' }))

  assert.equal(ctx.createCount(), 1)
  assert.equal(followups.length, 0)
  assert.match(client.sent.at(-1) ?? '', /新会话|fresh session/i)
  await bridge.stop()
})

test('en-US localizes authorization and help messages', async () => {
  const client = fakeClient()
  const followups: unknown[] = []
  const ctx = fakeCtx(followups)
  const bridge = new LarkBridge(ctx as never, {
    client,
    locale: 'en-US',
    allowFrom: ['owner'],
  })
  bridge.start()
  await bridge.handleInbound(inbound({
    chatId: 'oc_1', openId: 'stranger', text: 'hi', messageId: 'denied-message',
  }))
  await bridge.handleInbound(inbound({
    chatId: 'oc_1', openId: 'owner', text: '/help', messageId: 'help-message',
  }))
  await bridge.handleInbound(inbound({
    chatId: 'oc_1', openId: 'owner', text: '', messageId: 'file-message', messageType: 'file',
  }))

  assert.equal(client.sent[0], "You don't have permission.")
  assert.match(client.sent[1] ?? '', /start a fresh session/)
  assert.match(client.sent[2] ?? '', /non-text messages are not supported/)
  await bridge.stop()
})
