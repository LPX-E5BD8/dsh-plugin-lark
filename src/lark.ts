import { readFile } from 'node:fs/promises'
import { DEFAULT_CONFIG } from './config.ts'
import { localeCopy } from './locale.ts'
import type { LarkLocale } from './locale.ts'

/** Lark/Feishu client seam. Tests substitute a fake. */

export interface LarkInbound {
  chatId: string
  chatType: 'p2p' | 'group' | string
  openId: string
  text: string
  messageType?: string
  messageId: string
  rootId?: string
  parentId?: string
  threadId?: string
  mentioned: boolean
}

export interface LarkCardAction {
  openId: string
  chatId: string
  messageId: string
  value: Record<string, unknown>
}

export type LarkToastType = 'success' | 'error' | 'warning' | 'info'

export interface LarkCardActionResult {
  toast: {
    type: LarkToastType
    content: string
  }
}

export interface LarkDeliveryOptions {
  replyToMessageId?: string
  replyInThread?: boolean
}

export type LarkConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'stopped'
  | 'unknown'

export interface LarkConnectionHealth {
  state: LarkConnectionState
  ready: boolean
  reconnectAttempts: number
  lastAttemptAt?: string
  nextAttemptAt?: string
}

export interface LarkClientLike {
  readonly loadingImageKey?: string
  connectionHealth?(): LarkConnectionHealth
  start(): Promise<void>
  stopReceiving?(): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string, options?: LarkDeliveryOptions): Promise<void>
  onMessage(handler: (msg: LarkInbound) => Promise<void>): void
  sendCard?(chatId: string, card: unknown, options?: LarkDeliveryOptions): Promise<string | void>
  updateCard?(messageId: string, card: unknown): Promise<void>
  onCardAction?(handler: (action: LarkCardAction) => Promise<LarkCardActionResult>): void
}

export interface LarkSdkOptions {
  appId: string
  appSecret: string
  /** feishu = open.feishu.cn, lark = open.larksuite.com */
  domain?: 'feishu' | 'lark'
  locale?: LarkLocale
}

const TEXT_LIMIT = 4000
const START_TIMEOUT_MS = 15_000

const discardSdkLog = (..._messages: unknown[]): void => {}
const PRIVATE_SDK_LOGGER = Object.freeze({
  error: discardSdkLog,
  warn: discardSdkLog,
  info: discardSdkLog,
  debug: discardSdkLog,
  trace: discardSdkLog,
})

interface LarkMention {
  key?: string
  id?: { open_id?: string }
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), START_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function cardActionUnavailable(locale: LarkLocale): LarkCardActionResult {
  return {
    toast: { type: 'error', content: localeCopy(locale).bridge.cardUnavailable },
  }
}

export function splitText(text: string, limit = TEXT_LIMIT): string[] {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('lark: text limit must be a positive integer')
  const runes = [...text]
  if (runes.length <= limit) return [text]
  const chunks: string[] = []
  for (let i = 0; i < runes.length; i += limit) chunks.push(runes.slice(i, i + limit).join(''))
  return chunks
}

export function neutralizeTextMentions(text: string): string {
  return text.replace(/<(?=\/?at(?:\s|>))/gi, '&lt;')
}

function parseTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    return typeof parsed.text === 'string' ? parsed.text : ''
  } catch {
    return ''
  }
}

export function normalizeInboundText(
  content: string,
  mentions: readonly LarkMention[],
  botOpenId: string,
): { text: string; mentioned: boolean } {
  const botMentions = mentions.filter((mention) => mention.id?.open_id === botOpenId)
  let text = parseTextContent(content)
  for (const mention of botMentions) {
    if (mention.key !== undefined && mention.key !== '') text = text.replaceAll(mention.key, '')
  }
  return { text: text.trim(), mentioned: botMentions.length > 0 }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseActionValue(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value))
    } catch {
      return { raw: value }
    }
  }
  return asRecord(value)
}

/** Normalize card.action.trigger payloads (wrapped or SDK-unwrapped). */
export function unwrapCardAction(data: unknown): LarkCardAction {
  const root = asRecord(data)
  const event = 'action' in root || 'operator' in root ? root : asRecord(root.event)
  const operator = asRecord(event.operator)
  const action = asRecord(event.action)
  const context = asRecord(event.context)
  return {
    openId: String(operator.open_id ?? ''),
    chatId: String(context.open_chat_id ?? ''),
    messageId: String(context.open_message_id ?? ''),
    value: parseActionValue(action.value),
  }
}

type LarkRest = {
  request: (opts: unknown) => Promise<{ bot?: { open_id?: string } }>
  im: {
    v1: {
      message: {
        create: (opts: unknown) => Promise<LarkMessageResponse>
        reply: (opts: unknown) => Promise<LarkMessageResponse>
        patch?: (opts: unknown) => Promise<unknown>
        update?: (opts: unknown) => Promise<unknown>
      }
      image?: {
        create: (opts: unknown) => Promise<{ image_key?: string } | null>
      }
    }
  }
}

interface LarkMessageResponse {
  code?: number
  msg?: string
  data?: { message_id?: string }
}

type LarkApiOperation =
  | 'bot.info'
  | 'message.create'
  | 'message.reply'
  | 'message.patch'
  | 'message.update'

function apiInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function rejectedLarkApiCall(operation: LarkApiOperation, error: unknown): Error {
  const response = asRecord(asRecord(error).response)
  const status = apiInteger(response.status)
  const code = apiInteger(asRecord(response.data).code)
  if (status !== undefined && code !== undefined) {
    return new Error(`lark: ${operation} http failure (status ${status}, code ${code})`)
  }
  if (status !== undefined) return new Error(`lark: ${operation} http failure (status ${status})`)
  if (code !== undefined) return new Error(`lark: ${operation} transport failure (code ${code})`)
  return new Error(`lark: ${operation} transport failure`)
}

async function callLarkApi(
  operation: LarkApiOperation,
  call: () => Promise<unknown>,
): Promise<Record<string, unknown>> {
  let response: unknown
  try {
    response = await call()
  } catch (error) {
    throw rejectedLarkApiCall(operation, error)
  }
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error(`lark: ${operation} returned a malformed response`)
  }
  const record = response as Record<string, unknown>
  if (record.code !== undefined && apiInteger(record.code) === undefined) {
    throw new Error(`lark: ${operation} returned a malformed response code`)
  }
  const code = apiInteger(record.code)
  if (code !== undefined && code !== 0) {
    throw new Error(`lark: ${operation} business failure (code ${code})`)
  }
  return record
}

interface LarkConnectionStatus {
  state?: unknown
  reconnectAttempts?: unknown
  lastConnectTime?: unknown
  nextConnectTime?: unknown
}

type LarkWs = {
  close?: (params?: { force?: boolean }) => void
  getConnectionStatus?: () => unknown
}

function connectionState(value: unknown): Exclude<LarkConnectionState, 'stopped' | 'unknown'> | undefined {
  switch (value) {
    case 'idle':
    case 'connecting':
    case 'connected':
    case 'reconnecting':
    case 'failed':
      return value
    default:
      return undefined
  }
}

function safeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined
}

function safeTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  try {
    return new Date(value).toISOString()
  } catch {
    return undefined
  }
}

function basicConnectionHealth(state: LarkConnectionState): LarkConnectionHealth {
  return { state, ready: state === 'connected', reconnectAttempts: 0 }
}

function normalizeConnectionHealth(value: unknown): LarkConnectionHealth {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return basicConnectionHealth('unknown')
  }
  const status = value as LarkConnectionStatus
  const state = connectionState(status.state)
  if (state === undefined) return basicConnectionHealth('unknown')
  const reconnectAttempts = safeCount(status.reconnectAttempts) ?? 0
  const lastAttemptAt = safeTimestamp(status.lastConnectTime)
  const nextAttemptAt = safeTimestamp(status.nextConnectTime)
  return {
    state,
    ready: state === 'connected',
    reconnectAttempts,
    ...(lastAttemptAt === undefined ? {} : { lastAttemptAt }),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
  }
}

/** Real WS long-connection client via official Node SDK. */
export class LarkSdkClient implements LarkClientLike {
  loadingImageKey: string | undefined
  private handler: ((msg: LarkInbound) => Promise<void>) | undefined
  private cardHandler: ((action: LarkCardAction) => Promise<LarkCardActionResult>) | undefined
  private ws: LarkWs | undefined
  private rest: LarkRest | undefined
  private cancelStart: ((error: Error) => void) | undefined
  private receivingStopped = false

  constructor(private readonly options: LarkSdkOptions) {}

  onMessage(handler: (msg: LarkInbound) => Promise<void>): void {
    this.handler = handler
  }

  onCardAction(handler: (action: LarkCardAction) => Promise<LarkCardActionResult>): void {
    this.cardHandler = handler
  }

  connectionHealth(): LarkConnectionHealth {
    if (this.receivingStopped) return basicConnectionHealth('stopped')
    try {
      const getConnectionStatus = this.ws?.getConnectionStatus
      if (typeof getConnectionStatus !== 'function') return basicConnectionHealth('unknown')
      return normalizeConnectionHealth(getConnectionStatus.call(this.ws))
    } catch {
      return basicConnectionHealth('unknown')
    }
  }

  async start(): Promise<void> {
    this.receivingStopped = false
    const Lark = await import('@larksuiteoapi/node-sdk')
    if (this.receivingStopped) throw new Error('lark: client stopped during startup')
    const cancelled = Promise.withResolvers<never>()
    this.cancelStart = cancelled.reject
    const domain = this.options.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu
    const client = new Lark.Client({
      appId: this.options.appId,
      appSecret: this.options.appSecret,
      appType: Lark.AppType.SelfBuild,
      domain,
      logger: PRIVATE_SDK_LOGGER,
    })
    const rest = client as unknown as LarkRest
    try {
      const identity = callLarkApi('bot.info', () => (
        rest.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
      ))
      const bot = asRecord((await withTimeout(
        Promise.race([identity, cancelled.promise]),
        'lark: bot identity lookup timed out',
      )).bot)
      const botOpenId = bot?.open_id
      if (typeof botOpenId !== 'string' || botOpenId === '') {
        throw new Error('lark: bot identity response is missing open_id')
      }
      const ready = Promise.withResolvers<void>()
      const wsClient = new Lark.WSClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        domain,
        logger: PRIVATE_SDK_LOGGER,
        handshakeTimeoutMs: START_TIMEOUT_MS,
        onReady: ready.resolve,
        onError: ready.reject,
      })
      this.ws = wsClient
      const self = this
      const start = wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({ logger: PRIVATE_SDK_LOGGER }).register({
          'im.message.receive_v1': async (data: {
            message?: {
              chat_id?: string
              chat_type?: string
              content?: string
              message_id?: string
              message_type?: string
              mentions?: LarkMention[]
              root_id?: string
              parent_id?: string
              thread_id?: string
            }
            sender?: { sender_type?: string; sender_id?: { open_id?: string } }
          }) => {
            if (data.sender?.sender_type !== 'user') return
            const message = data.message
            if (message === undefined) return
            const openId = data.sender?.sender_id?.open_id ?? ''
            const chatId = message.chat_id ?? ''
            const messageId = message.message_id ?? ''
            const messageType = message.message_type ?? ''
            if (openId === '' || chatId === '' || messageId === '' || messageType === '') return
            const mentions = message.mentions ?? []
            const mentioned = mentions.some((mention) => mention.id?.open_id === botOpenId)
            const normalized = messageType === 'text'
              ? normalizeInboundText(message.content ?? '', mentions, botOpenId)
              : { text: '', mentioned }
            if (messageType === 'text' && normalized.text === '') return
            if (self.handler === undefined) return
            await self.handler({
              chatId,
              chatType: message.chat_type ?? 'p2p',
              openId,
              text: normalized.text,
              ...(messageType === 'text' ? {} : { messageType }),
              messageId,
              rootId: message.root_id,
              parentId: message.parent_id,
              threadId: message.thread_id,
              mentioned: normalized.mentioned,
            })
          },
          'card.action.trigger': async (data: unknown) => {
            if (self.cardHandler === undefined) {
              return cardActionUnavailable(self.options.locale ?? DEFAULT_CONFIG.locale)
            }
            return self.cardHandler(unwrapCardAction(data))
          },
        }),
      })
      void start.catch(ready.reject)
      await withTimeout(
        Promise.race([ready.promise, cancelled.promise]),
        'lark: WebSocket startup timed out',
      )
      if (this.receivingStopped) throw new Error('lark: client stopped during startup')
      this.rest = rest
      await this.prepareLoadingImage(rest)
      if (this.receivingStopped) throw new Error('lark: client stopped during startup')
    } catch (error) {
      this.ws?.close?.({ force: true })
      this.ws = undefined
      this.rest = undefined
      throw error
    } finally {
      this.cancelStart = undefined
    }
  }

  async sendText(chatId: string, text: string, options?: LarkDeliveryOptions): Promise<void> {
    for (const chunk of splitText(neutralizeTextMentions(text))) {
      await this.deliver(chatId, 'text', JSON.stringify({ text: chunk }), options)
    }
  }

  private async prepareLoadingImage(rest: LarkRest): Promise<void> {
    if (this.loadingImageKey !== undefined || rest.im.v1.image === undefined) return
    try {
      const image = await readFile(new URL('../assets/loading.gif', import.meta.url))
      const uploaded = await withTimeout(
        rest.im.v1.image.create({ data: { image_type: 'message', image } }),
        'lark: loading image upload timed out',
      )
      if (uploaded?.image_key !== undefined && uploaded.image_key !== '') {
        this.loadingImageKey = uploaded.image_key
      }
    } catch {
      // Cosmetic asset: keep the native static loading icon when upload is unavailable.
    }
  }

  async sendCard(
    chatId: string,
    card: unknown,
    options?: LarkDeliveryOptions,
  ): Promise<string | undefined> {
    return this.deliver(chatId, 'interactive', JSON.stringify(card), options)
  }

  private async deliver(
    chatId: string,
    msgType: string,
    content: string,
    options?: LarkDeliveryOptions,
  ): Promise<string> {
    if (this.rest === undefined) throw new Error('lark client not started')
    const replyToMessageId = options?.replyToMessageId
    const operation: LarkApiOperation = replyToMessageId !== undefined && replyToMessageId !== ''
      ? 'message.reply'
      : 'message.create'
    const message = this.rest.im.v1.message
    const res = await callLarkApi(operation, () => (
      replyToMessageId !== undefined && replyToMessageId !== ''
        ? message.reply({
          path: { message_id: replyToMessageId },
          data: {
            msg_type: msgType,
            content,
            ...(options?.replyInThread === true ? { reply_in_thread: true } : {}),
          },
        })
        : message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: msgType, content },
        })
    ))
    const id = asRecord(res.data).message_id
    if (typeof id !== 'string' || id === '') {
      throw new Error('lark: message delivery response is missing message_id')
    }
    return id
  }

  async updateCard(messageId: string, card: unknown): Promise<void> {
    if (this.rest === undefined) throw new Error('lark client not started')
    const patch = this.rest.im.v1.message.patch
    if (patch !== undefined) {
      await callLarkApi('message.patch', () => patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      }))
      return
    }
    const update = this.rest.im.v1.message.update
    if (update === undefined) throw new Error('lark client cannot update cards')
    await callLarkApi('message.update', () => update({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    }))
  }

  async stopReceiving(): Promise<void> {
    this.receivingStopped = true
    this.cancelStart?.(new Error('lark: client stopped during startup'))
    const ws = this.ws
    this.ws = undefined
    ws?.close?.({ force: true })
  }

  async stop(): Promise<void> {
    try {
      await this.stopReceiving()
    } finally {
      this.rest = undefined
    }
  }
}
