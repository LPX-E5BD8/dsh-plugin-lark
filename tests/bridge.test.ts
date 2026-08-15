import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
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

function fakeCtx(followups: unknown[]) {
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
            followup(msg: unknown) { followups.push(msg) },
          },
        }
      },
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

test('splitText chunks long replies', () => {
  const chunks = splitText('abcdefghij', 4)
  assert.deepEqual(chunks, ['abcd', 'efgh', 'ij'])
  assert.deepEqual(splitText('ab😀cd', 3), ['ab😀', 'cd'])
  assert.throws(() => splitText('text', 0), RangeError)
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

test('Cordis plugin loading rejects a failed WebSocket connection', async () => {
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
  const plugin = {
    name: 'lark-startup-test',
    inject: [],
    apply: (pluginCtx: Context) => apply(pluginCtx, {}),
  }
  const fiber = ctx.plugin(plugin as never, {})
  try {
    await assert.rejects(fiber.await(), /startup unavailable/)
  } finally {
    await fiber.dispose()
    prototype.request = request
    Lark.WSClient.prototype.start = start
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
