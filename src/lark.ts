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
  messageId: string
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

export interface LarkClientLike {
  readonly loadingImageKey?: string
  start(): Promise<void>
  stopReceiving?(): Promise<void>
  stop(): Promise<void>
  sendText(chatId: string, text: string): Promise<void>
  onMessage(handler: (msg: LarkInbound) => Promise<void>): void
  sendCard?(chatId: string, card: unknown): Promise<string | void>
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
        create: (opts: unknown) => Promise<{ data?: { message_id?: string } }>
        patch?: (opts: unknown) => Promise<unknown>
        update?: (opts: unknown) => Promise<unknown>
      }
      image?: {
        create: (opts: unknown) => Promise<{ image_key?: string } | null>
      }
    }
  }
}

/** Real WS long-connection client via official Node SDK. */
export class LarkSdkClient implements LarkClientLike {
  loadingImageKey: string | undefined
  private handler: ((msg: LarkInbound) => Promise<void>) | undefined
  private cardHandler: ((action: LarkCardAction) => Promise<LarkCardActionResult>) | undefined
  private ws: { close?: (params?: { force?: boolean }) => void } | undefined
  private rest: LarkRest | undefined
  private sendImpl: ((chatId: string, text: string) => Promise<void>) | undefined
  private cancelStart: ((error: Error) => void) | undefined
  private receivingStopped = false

  constructor(private readonly options: LarkSdkOptions) {}

  onMessage(handler: (msg: LarkInbound) => Promise<void>): void {
    this.handler = handler
  }

  onCardAction(handler: (action: LarkCardAction) => Promise<LarkCardActionResult>): void {
    this.cardHandler = handler
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
    })
    const rest = client as unknown as LarkRest
    try {
      const identity = rest.request({ url: '/open-apis/bot/v3/info', method: 'GET' })
      const bot = (await withTimeout(
        Promise.race([identity, cancelled.promise]),
        'lark: bot identity lookup timed out',
      )).bot
      const botOpenId = bot?.open_id
      if (botOpenId === undefined || botOpenId === '') {
        throw new Error('lark: bot identity response is missing open_id')
      }
      const ready = Promise.withResolvers<void>()
      const wsClient = new Lark.WSClient({
        appId: this.options.appId,
        appSecret: this.options.appSecret,
        domain,
        handshakeTimeoutMs: START_TIMEOUT_MS,
        onReady: ready.resolve,
        onError: ready.reject,
      })
      this.ws = wsClient
      const self = this
      const start = wsClient.start({
        eventDispatcher: new Lark.EventDispatcher({}).register({
          'im.message.receive_v1': async (data: {
            message?: {
              chat_id?: string
              chat_type?: string
              content?: string
              message_id?: string
              message_type?: string
              mentions?: LarkMention[]
            }
            sender?: { sender_type?: string; sender_id?: { open_id?: string } }
          }) => {
            if (data.sender?.sender_type === 'app') return
            const message = data.message
            if (message === undefined || message.message_type !== 'text') return
            const openId = data.sender?.sender_id?.open_id ?? ''
            const chatId = message.chat_id ?? ''
            const messageId = message.message_id ?? ''
            const normalized = normalizeInboundText(message.content ?? '', message.mentions ?? [], botOpenId)
            if (normalized.text === '' || openId === '' || chatId === '' || messageId === '') return
            if (self.handler === undefined) return
            await self.handler({
              chatId,
              chatType: message.chat_type ?? 'p2p',
              openId,
              text: normalized.text,
              messageId,
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
      this.sendImpl = async (chatId, text) => {
        await client.im.v1.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        })
      }
      await this.prepareLoadingImage(rest)
    } catch (error) {
      this.ws?.close?.({ force: true })
      this.ws = undefined
      this.rest = undefined
      this.sendImpl = undefined
      throw error
    } finally {
      this.cancelStart = undefined
    }
  }

  async sendText(chatId: string, text: string): Promise<void> {
    if (this.sendImpl === undefined) throw new Error('lark client not started')
    for (const chunk of splitText(neutralizeTextMentions(text))) await this.sendImpl(chatId, chunk)
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

  async sendCard(chatId: string, card: unknown): Promise<string | undefined> {
    if (this.rest === undefined) throw new Error('lark client not started')
    const res = await this.rest.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
    const id = res?.data?.message_id
    return typeof id === 'string' ? id : undefined
  }

  async updateCard(messageId: string, card: unknown): Promise<void> {
    if (this.rest === undefined) throw new Error('lark client not started')
    const patch = this.rest.im.v1.message.patch
    if (patch !== undefined) {
      await patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      })
      return
    }
    const update = this.rest.im.v1.message.update
    if (update === undefined) throw new Error('lark client cannot update cards')
    await update({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    })
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
      this.sendImpl = undefined
    }
  }
}
