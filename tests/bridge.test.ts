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
import { apply } from '../src/index.ts'
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
  const sessionListeners: Array<(s: { id: string }, e: unknown) => void> = []
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
      return () => {}
    },
    get(name: string) {
      if (name === 'approval') return { present: true }
      if (name === 'commands') return commands
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
            session: { id, requestContext: () => undefined },
            followup(msg: unknown) {
              if (onFollowup === undefined) followups.push(msg)
              else onFollowup(msg)
            },
          },
        }
      },
    },
    sessions: {
      async flush() { return true },
    },
    emit(sessionId: string, event: unknown) {
      for (const fn of sessionListeners) fn({ id: sessionId }, event)
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
    return (JSON.parse(call.data?.content ?? '{}') as { text?: string }).text ?? ''
  })
  assert.equal(creates, 0)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => [...chunk].length <= 4_000))
  assert.equal(chunks.join(''), answer)
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

  await client.sendText('oc_chat', 'plain', { replyToMessageId: '' })
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
    /reply unavailable/,
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
    /230071.*reply target unavailable/,
  )
  response = { code: 0, data: {} }
  await assert.rejects(
    client.sendCard('oc_chat', { schema: '2.0' }, { replyToMessageId: 'om_inbound' }),
    /missing message_id/,
  )
  assert.equal(creates, 0)
})

test('SDK stopReceiving closes WebSocket but preserves REST sending until stop', async () => {
  const client = new LarkSdkClient({ appId: 'test-app-id', appSecret: 'test-only-secret' })
  const sent: string[] = []
  let closes = 0
  const internals = client as unknown as { ws?: { close: () => void } }
  internals.ws = { close() { closes += 1 } }
  setSdkMessageApi(client, {
    async create(call) {
      sent.push((JSON.parse(call.data?.content ?? '{}') as { text?: string }).text ?? '')
      return { data: { message_id: 'om_created' } }
    },
    async reply() { return { data: { message_id: 'om_reply' } } },
  })

  await client.stopReceiving()
  await client.sendText('chat-a', 'still deliverable')

  assert.equal(closes, 1)
  assert.deepEqual(sent, ['still deliverable'])
  await client.stop()
  await assert.rejects(client.sendText('chat-a', 'too late'), /not started/)
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
  prototype.request = async () => ({ bot: { open_id: 'test-bot' } })
  Lark.WSClient.prototype.start = async function startWithError() {
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
  const plugin = {
    name: 'lark-startup-test',
    inject: ['storageDomain'],
    apply: (pluginCtx: Context) => apply(pluginCtx, {}),
  }
  const fiber = ctx.plugin(plugin as never, {})
  try {
    await assert.rejects(fiber.await(), /startup unavailable/)
    assert.equal(ctx.storageDomain.get('lark_inbound'), undefined)
  } finally {
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

test('plugin construction failure releases its inbound domain', async (t) => {
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
  } finally {
    await ctx.fiber.dispose()
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
  const outcomeP = ctx.requestApproval({
    agent: { session: { id: 'lark:oc_1' } },
    toolName: 'bash',
    reason: 'run a command',
  })
  await Promise.resolve()
  assert.equal(client.cards.length, 1)
  const requestId = requestIdOf(client.cards[0]?.card)
  assert.ok(requestId !== '')
  await bridge.handleCardAction({
    openId: 'ou_ok',
    chatId: 'oc_1',
    messageId: client.cards[0]?.messageId ?? '',
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
  const outcomeP = ctx.requestApproval({
    agent: { session: { id: 'lark:oc_1' } },
    toolName: 'bash',
    reason: 'run a command',
  })
  await Promise.resolve()
  const requestId = requestIdOf(client.cards[0]?.card)
  await bridge.handleCardAction({
    openId: 'ou_ok',
    chatId: 'oc_1',
    messageId: client.cards[0]?.messageId ?? '',
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

  assert.equal(client.sent[0], "You don't have permission.")
  assert.match(client.sent[1] ?? '', /start a fresh session/)
  await bridge.stop()
})
