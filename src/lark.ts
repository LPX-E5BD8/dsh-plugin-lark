import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import type { HttpInstance, HttpRequestOptions } from '@larksuiteoapi/node-sdk'
import { DEFAULT_CONFIG } from './config.ts'
import { MAX_INBOUND_IMAGE_BYTES } from './inbound-image.ts'
import { MAX_INBOUND_TEXT_RESOURCE_BYTES } from './inbound-resource.ts'
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
  resource?: LarkInboundResource
}

export type LarkInboundResource = {
  kind: 'file'
  key: string
  name: string
} | {
  kind: 'image'
  key: string
}

export interface LarkDownloadedResource {
  data: Uint8Array
  mediaType: string
}

export interface LarkResourceDownloadOptions {
  maxBytes: number
  signal: AbortSignal
}

export type LarkArtifactKind = 'file' | 'image'

export interface LarkArtifactUploadInput {
  readonly kind: LarkArtifactKind
  readonly data: Uint8Array
  readonly name?: string
}

export interface LarkUploadedArtifact {
  readonly kind: LarkArtifactKind
}

export interface LarkArtifactUploadOptions {
  readonly signal: AbortSignal
}

export interface LarkArtifactDeliveryOptions extends LarkDeliveryOptions {
  readonly replyToMessageId: string
  readonly signal: AbortSignal
  readonly idempotencyKey: string
}

export type LarkResourceErrorCode = 'aborted' | 'invalid' | 'too_large' | 'unavailable'

export class LarkResourceError extends Error {
  constructor(
    readonly code: LarkResourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LarkResourceError'
  }
}

export interface LarkCardAction {
  openId: string
  chatId: string
  messageId: string
  value: Record<string, unknown>
  tag?: string
  name?: string
  formValue?: Record<string, unknown>
  inputValue?: string
  option?: string
  options?: readonly string[]
}

export type LarkToastType = 'success' | 'error' | 'warning' | 'info'

export interface LarkCardActionResult {
  toast: {
    type: LarkToastType
    content: string
  }
  card?: {
    type: 'raw'
    data: Record<string, unknown>
  }
}

export interface LarkDeliveryOptions {
  replyToMessageId?: string
  replyInThread?: boolean
  signal?: AbortSignal
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
  downloadMessageResource?(
    messageId: string,
    resource: LarkInboundResource,
    options: LarkResourceDownloadOptions,
  ): Promise<LarkDownloadedResource>
  uploadArtifact?(
    input: LarkArtifactUploadInput,
    options: LarkArtifactUploadOptions,
  ): Promise<LarkUploadedArtifact>
  sendArtifact?(
    chatId: string,
    artifact: LarkUploadedArtifact,
    options: LarkArtifactDeliveryOptions,
  ): Promise<string>
  onMessage(handler: (msg: LarkInbound) => Promise<void>): void
  sendCard?(chatId: string, card: unknown, options?: LarkDeliveryOptions): Promise<string | void>
  updateCard?(messageId: string, card: unknown, options?: Pick<LarkDeliveryOptions, 'signal'>): Promise<void>
  onCardAction?(handler: (action: LarkCardAction) => Promise<LarkCardActionResult>): void
}

export interface LarkSdkOptions {
  appId: string
  appSecret: string
  /** feishu = open.feishu.cn, lark = open.larksuite.com */
  domain?: 'feishu' | 'lark'
  locale?: LarkLocale
  inboundTextFiles?: boolean
  inboundImages?: boolean
}

const TEXT_LIMIT = 4000
const START_TIMEOUT_MS = 15_000
const REST_REQUEST_TIMEOUT_MS = 15_000
const RESOURCE_ID_CONTROL_PATTERN = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const ARTIFACT_NAME_UNSAFE_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/:*?"<>|]/u
const ARTIFACT_IDEMPOTENCY_PATTERN = /^[A-Za-z0-9_-]{1,50}$/u

const discardSdkLog = (..._messages: unknown[]): void => {}
const PRIVATE_SDK_LOGGER = Object.freeze({
  error: discardSdkLog,
  warn: discardSdkLog,
  info: discardSdkLog,
  debug: discardSdkLog,
  trace: discardSdkLog,
})

type SignalHttpRequestOptions<D = unknown> = HttpRequestOptions<D> & {
  readonly signal?: AbortSignal
}

const larkHttpSignal = new AsyncLocalStorage<AbortSignal>()

function boundedHttpTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.max(1, Math.trunc(value)), REST_REQUEST_TIMEOUT_MS)
    : REST_REQUEST_TIMEOUT_MS
}

function boundedHttpOptions<D>(
  options: HttpRequestOptions<D> | undefined,
): HttpRequestOptions<D> {
  const input = (options ?? {}) as SignalHttpRequestOptions<D>
  const ambient = larkHttpSignal.getStore()
  const explicit = input.signal instanceof AbortSignal ? input.signal : undefined
  const signal = ambient === undefined
    ? explicit
    : explicit === undefined || explicit === ambient
      ? ambient
      : AbortSignal.any([ambient, explicit])
  return {
    ...input,
    timeout: boundedHttpTimeout(input.timeout),
    ...(signal === undefined ? {} : { signal }),
  } as HttpRequestOptions<D>
}

function boundedLarkHttpInstance(http: HttpInstance): HttpInstance {
  return Object.freeze({
    request: <T = unknown, R = T, D = unknown>(options: HttpRequestOptions<D>) => (
      http.request<T, R, D>(boundedHttpOptions(options))
    ),
    get: <T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>) => (
      http.get<T, R, D>(url, boundedHttpOptions(options))
    ),
    delete: <T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>) => (
      http.delete<T, R, D>(url, boundedHttpOptions(options))
    ),
    head: <T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>) => (
      http.head<T, R, D>(url, boundedHttpOptions(options))
    ),
    options: <T = unknown, R = T, D = unknown>(url: string, options?: HttpRequestOptions<D>) => (
      http.options<T, R, D>(url, boundedHttpOptions(options))
    ),
    post: <T = unknown, R = T, D = unknown>(
      url: string,
      data?: D,
      options?: HttpRequestOptions<D>,
    ) => http.post<T, R, D>(url, data, boundedHttpOptions(options)),
    put: <T = unknown, R = T, D = unknown>(
      url: string,
      data?: D,
      options?: HttpRequestOptions<D>,
    ) => http.put<T, R, D>(url, data, boundedHttpOptions(options)),
    patch: <T = unknown, R = T, D = unknown>(
      url: string,
      data?: D,
      options?: HttpRequestOptions<D>,
    ) => http.patch<T, R, D>(url, data, boundedHttpOptions(options)),
  })
}

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

function validResourceId(value: string): boolean {
  return value !== ''
    && value !== '.'
    && value !== '..'
    && value.length <= 512
    && value.isWellFormed()
    && !value.includes('/')
    && !value.includes('\\')
    && !RESOURCE_ID_CONTROL_PATTERN.test(value)
}

function validArtifactName(value: unknown): value is string {
  return typeof value === 'string'
    && value !== ''
    && value.trim() === value
    && value.isWellFormed()
    && [...value].length <= 120
    && new TextEncoder().encode(value).byteLength <= 255
    && !value.startsWith('.')
    && !value.endsWith('.')
    && !ARTIFACT_NAME_UNSAFE_PATTERN.test(value)
}

function parseInboundFileResource(content: string): LarkInboundResource | undefined {
  try {
    const parsed = asRecord(JSON.parse(content))
    const key = parsed.file_key
    const name = parsed.file_name
    if (typeof key !== 'string' || !validResourceId(key)) return undefined
    if (typeof name !== 'string' || name === '' || name.length > 1_024) return undefined
    return { kind: 'file', key, name }
  } catch {
    return undefined
  }
}

function parseInboundImageResource(content: string): LarkInboundResource | undefined {
  try {
    const key = asRecord(JSON.parse(content)).image_key
    return typeof key === 'string' && validResourceId(key)
      ? { kind: 'image', key }
      : undefined
  } catch {
    return undefined
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

function optionalActionString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function parseActionOptions(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return Object.freeze([...value] as string[])
  }
  if (typeof value !== 'string' || value === '') return undefined
  return Object.freeze(value.split(',').filter((item) => item !== ''))
}

/** Normalize card.action.trigger payloads (wrapped or SDK-unwrapped). */
export function unwrapCardAction(data: unknown): LarkCardAction {
  const root = asRecord(data)
  const event = 'action' in root || 'operator' in root ? root : asRecord(root.event)
  const operator = asRecord(event.operator)
  const action = asRecord(event.action)
  const context = asRecord(event.context)
  const openId = optionalActionString(operator.open_id) ?? ''
  const chatId = optionalActionString(context.open_chat_id) ?? ''
  const messageId = optionalActionString(context.open_message_id) ?? ''
  const inputValue = optionalActionString(action.input_value)
  const option = optionalActionString(action.option)
  const options = parseActionOptions(action.options)
  return {
    openId,
    chatId,
    messageId,
    value: parseActionValue(action.value),
    tag: optionalActionString(action.tag) ?? '',
    name: optionalActionString(action.name) ?? '',
    formValue: parseActionValue(action.form_value),
    ...(inputValue === undefined ? {} : { inputValue }),
    ...(option === undefined ? {} : { option }),
    ...(options === undefined ? {} : { options }),
  }
}

type LarkRest = {
  request: (opts: unknown) => Promise<unknown>
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
  | 'message.resource'
  | 'message.reply'
  | 'message.patch'
  | 'message.update'
  | 'artifact.upload'
  | 'artifact.reply'

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

async function callSignalBoundLarkApi(
  operation: LarkApiOperation,
  callerSignal: AbortSignal,
  call: (signal: AbortSignal) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([callerSignal, deadline.signal])
  let rejectAbort: ((error: Error) => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = (): void => {
    rejectAbort?.(new Error(`lark: ${operation} request aborted`))
  }
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    deadline.abort(new Error(`lark: ${operation} request timed out`))
  }, REST_REQUEST_TIMEOUT_MS)
  const request = signal.aborted
    ? Promise.reject(new Error(`lark: ${operation} request aborted`))
    : Promise.resolve().then(() => larkHttpSignal.run(signal, () => call(signal)))
  try {
    // The outer race also bounds SDK token acquisition, which happens before
    // Axios observes its own signal/timeout. A late SDK continuation sees the
    // already-aborted combined signal and cannot issue the message write.
    return await callLarkApi(operation, () => Promise.race([request, aborted]))
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

async function callQuiescentSignalBoundLarkApi(
  operation: LarkApiOperation,
  callerSignal: AbortSignal,
  call: (signal: AbortSignal) => Promise<unknown>,
): Promise<Record<string, unknown>> {
  const deadline = new AbortController()
  const signal = AbortSignal.any([callerSignal, deadline.signal])
  const timer = setTimeout(() => {
    deadline.abort(new Error(`lark: ${operation} request timed out`))
  }, REST_REQUEST_TIMEOUT_MS)
  try {
    if (signal.aborted) throw new Error(`lark: ${operation} request aborted`)
    const response = await callLarkApi(
      operation,
      () => Promise.resolve().then(() => larkHttpSignal.run(signal, () => call(signal))),
    )
    if (signal.aborted) throw new Error(`lark: ${operation} request aborted`)
    return response
  } finally {
    clearTimeout(timer)
  }
}

function resourceHeader(headers: unknown, name: string): unknown {
  if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) return undefined
  const getter = (headers as { get?: unknown }).get
  if (typeof getter === 'function') {
    try {
      return getter.call(headers, name)
    } catch {
      return undefined
    }
  }
  const lowerName = name.toLowerCase()
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)
  return match?.[1]
}

function resourceContentLength(headers: unknown): number | undefined {
  const raw = resourceHeader(headers, 'content-length')
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(text)) {
    throw new LarkResourceError('invalid', 'lark: message.resource returned an invalid byte length')
  }
  const length = Number(text)
  if (!Number.isSafeInteger(length)) {
    throw new LarkResourceError('invalid', 'lark: message.resource returned an invalid byte length')
  }
  return length
}

function resourceMediaType(headers: unknown): string {
  const raw = resourceHeader(headers, 'content-type')
  const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
  if (value === undefined || value === null || value === '') return 'application/octet-stream'
  if (typeof value !== 'string') {
    throw new LarkResourceError('invalid', 'lark: message.resource returned an invalid media type')
  }
  const mediaType = value.trim()
  const base = mediaType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (mediaType === ''
    || mediaType.length > 200
    || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(mediaType)
    || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(base)) {
    throw new LarkResourceError('invalid', 'lark: message.resource returned an invalid media type')
  }
  return mediaType
}

function readableResource(value: unknown): Readable | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<Readable> & { [Symbol.asyncIterator]?: unknown }
  return typeof candidate.destroy === 'function'
    && typeof candidate[Symbol.asyncIterator] === 'function'
    ? candidate as Readable
    : undefined
}

function resourceChunk(value: unknown): Buffer | undefined {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  return undefined
}

async function readResourceStream(
  stream: Readable,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let bytes = 0
  const abort = (): void => {
    stream.destroy()
  }
  if (signal.aborted) {
    abort()
    throw new LarkResourceError('aborted', 'lark: message.resource request aborted')
  }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  try {
    for await (const raw of stream) {
      if (signal.aborted) throw new LarkResourceError('aborted', 'lark: message.resource request aborted')
      const chunk = resourceChunk(raw)
      if (chunk === undefined) {
        throw new LarkResourceError('invalid', 'lark: message.resource returned invalid bytes')
      }
      if (chunk.byteLength > maxBytes - bytes) {
        stream.destroy()
        throw new LarkResourceError('too_large', 'lark: message.resource exceeds the configured byte limit')
      }
      chunks.push(chunk)
      bytes += chunk.byteLength
    }
    if (signal.aborted) throw new LarkResourceError('aborted', 'lark: message.resource request aborted')
    return new Uint8Array(Buffer.concat(chunks, bytes))
  } finally {
    signal.removeEventListener('abort', abort)
  }
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
  private readonly uploadedArtifacts = new WeakMap<
    LarkUploadedArtifact,
    { readonly kind: LarkArtifactKind; readonly key: string }
  >()
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
      httpInstance: boundedLarkHttpInstance(Lark.defaultHttpInstance as unknown as HttpInstance),
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
            const resource = self.options.inboundTextFiles === true && messageType === 'file'
              ? parseInboundFileResource(message.content ?? '')
              : self.options.inboundImages === true
                && messageType === 'image'
                && message.chat_type === 'p2p'
                ? parseInboundImageResource(message.content ?? '')
                : undefined
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
              ...(resource === undefined ? {} : { resource }),
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

  async downloadMessageResource(
    messageId: string,
    resource: LarkInboundResource,
    options: LarkResourceDownloadOptions,
  ): Promise<LarkDownloadedResource> {
    if ((resource.kind !== 'file' && resource.kind !== 'image')
      || !validResourceId(messageId)
      || !validResourceId(resource.key)) {
      throw new LarkResourceError('invalid', 'lark: message.resource reference is invalid')
    }
    const hardMaxBytes = resource.kind === 'image'
      ? MAX_INBOUND_IMAGE_BYTES
      : MAX_INBOUND_TEXT_RESOURCE_BYTES
    if (!Number.isSafeInteger(options.maxBytes)
      || options.maxBytes <= 0
      || options.maxBytes > hardMaxBytes) {
      throw new RangeError('lark: message.resource byte limit is invalid')
    }
    if (this.rest === undefined) {
      throw new LarkResourceError('unavailable', 'lark: message.resource client is unavailable')
    }

    const deadline = new AbortController()
    const signal = AbortSignal.any([options.signal, deadline.signal])
    let rejectAbort: ((error: LarkResourceError) => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
    })
    const onAbort = (): void => {
      rejectAbort?.(new LarkResourceError('aborted', 'lark: message.resource request aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      deadline.abort(new Error('lark: message.resource request timed out'))
    }, REST_REQUEST_TIMEOUT_MS)
    const rawRequest = signal.aborted
      ? Promise.reject(new LarkResourceError('aborted', 'lark: message.resource request aborted'))
      : Promise.resolve().then(() => larkHttpSignal.run(signal, () => this.rest!.request({
            url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}`,
            method: 'GET',
            params: { type: resource.kind },
            responseType: 'stream',
            maxRedirects: 0,
            signal,
            timeout: REST_REQUEST_TIMEOUT_MS,
            $return_headers: true,
          })))
    const request = rawRequest.then((response) => {
      if (!signal.aborted) return response
      readableResource(asRecord(response).data)?.destroy()
      throw new LarkResourceError('aborted', 'lark: message.resource request aborted')
    })
    let stream: Readable | undefined
    let consumed = false
    try {
      let response: unknown
      try {
        response = await Promise.race([request, aborted])
      } catch (error) {
        if (error instanceof LarkResourceError) throw error
        readableResource(asRecord(asRecord(error).response).data)?.destroy()
        if (signal.aborted) {
          throw new LarkResourceError('aborted', 'lark: message.resource request aborted')
        }
        throw new LarkResourceError(
          'unavailable',
          'lark: message.resource request failed',
          { cause: rejectedLarkApiCall('message.resource', error) },
        )
      }
      const record = asRecord(response)
      stream = readableResource(record.data)
      if (stream === undefined) {
        throw new LarkResourceError('invalid', 'lark: message.resource returned a malformed response')
      }
      const contentLength = resourceContentLength(record.headers)
      if (contentLength !== undefined && contentLength > options.maxBytes) {
        stream.destroy()
        throw new LarkResourceError('too_large', 'lark: message.resource exceeds the configured byte limit')
      }
      const mediaType = resourceMediaType(record.headers)
      const data = await readResourceStream(stream, signal, options.maxBytes)
      consumed = true
      return { data, mediaType }
    } catch (error) {
      if (error instanceof LarkResourceError) throw error
      if (signal.aborted) {
        throw new LarkResourceError('aborted', 'lark: message.resource request aborted')
      }
      throw new LarkResourceError('unavailable', 'lark: message.resource read failed')
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (!consumed || signal.aborted) stream?.destroy()
    }
  }

  async uploadArtifact(
    input: LarkArtifactUploadInput,
    options: LarkArtifactUploadOptions,
  ): Promise<LarkUploadedArtifact> {
    if ((input.kind !== 'file' && input.kind !== 'image')
      || !(input.data instanceof Uint8Array)
      || input.data.byteLength === 0
      || input.data.byteLength > (input.kind === 'image'
        ? MAX_INBOUND_IMAGE_BYTES
        : MAX_INBOUND_TEXT_RESOURCE_BYTES)
      || (input.kind === 'file' && !validArtifactName(input.name))
      || (input.kind === 'image' && input.name !== undefined)) {
      throw new TypeError('lark: outbound artifact upload input is invalid')
    }
    if (this.rest === undefined) throw new Error('lark: outbound artifact client is unavailable')
    const data = input.kind === 'image'
      ? { image_type: 'message', image: Buffer.from(input.data) }
      : { file_type: 'stream', file_name: input.name, file: Buffer.from(input.data) }
    const endpoint = input.kind === 'image'
      ? '/open-apis/im/v1/images'
      : '/open-apis/im/v1/files'
    const response = await callQuiescentSignalBoundLarkApi(
      'artifact.upload',
      options.signal,
      (signal) => this.rest!.request({
        url: endpoint,
        method: 'POST',
        data,
        headers: { 'Content-Type': 'multipart/form-data' },
        maxRedirects: 0,
        signal,
        timeout: REST_REQUEST_TIMEOUT_MS,
      }),
    )
    const nested = asRecord(response.data)
    const key = input.kind === 'image'
      ? nested.image_key ?? response.image_key
      : nested.file_key ?? response.file_key
    if (typeof key !== 'string' || !validResourceId(key)) {
      throw new Error('lark: artifact.upload returned an invalid resource key')
    }
    const artifact = Object.freeze({ kind: input.kind })
    this.uploadedArtifacts.set(artifact, { kind: input.kind, key })
    return artifact
  }

  async sendArtifact(
    chatId: string,
    artifact: LarkUploadedArtifact,
    options: LarkArtifactDeliveryOptions,
  ): Promise<string> {
    if (!validResourceId(chatId)
      || (artifact.kind !== 'file' && artifact.kind !== 'image')
      || !validResourceId(options.replyToMessageId)
      || !ARTIFACT_IDEMPOTENCY_PATTERN.test(options.idempotencyKey)) {
      throw new TypeError('lark: outbound artifact delivery input is invalid')
    }
    if (this.rest === undefined) throw new Error('lark: outbound artifact client is unavailable')
    const staged = this.uploadedArtifacts.get(artifact)
    if (staged === undefined || staged.kind !== artifact.kind || !validResourceId(staged.key)) {
      throw new TypeError('lark: outbound artifact token is invalid or already consumed')
    }
    // Consume before the ambiguous external write so one process can never
    // retry the same staged upload after an unknown reply outcome.
    this.uploadedArtifacts.delete(artifact)
    const content = artifact.kind === 'image'
      ? JSON.stringify({ image_key: staged.key })
      : JSON.stringify({ file_key: staged.key })
    const response = asRecord(await callQuiescentSignalBoundLarkApi(
      'artifact.reply',
      options.signal,
      (signal) => this.rest!.request({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(options.replyToMessageId)}/reply`,
        method: 'POST',
        data: {
          msg_type: artifact.kind,
          content,
          uuid: options.idempotencyKey,
          ...(options.replyInThread === true ? { reply_in_thread: true } : {}),
        },
        maxRedirects: 0,
        signal,
        timeout: REST_REQUEST_TIMEOUT_MS,
      }),
    ))
    const messageId = asRecord(response.data).message_id
    if (typeof messageId !== 'string' || !validResourceId(messageId)) {
      throw new Error('lark: artifact.reply returned an invalid message id')
    }
    return messageId
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
    if (options?.signal !== undefined) {
      const res = asRecord(await callSignalBoundLarkApi(operation, options.signal, (signal) => this.rest!.request(
        replyToMessageId !== undefined && replyToMessageId !== ''
          ? {
              url: `/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`,
              method: 'POST',
              data: {
                msg_type: msgType,
                content,
                ...(options.replyInThread === true ? { reply_in_thread: true } : {}),
              },
              signal,
              timeout: REST_REQUEST_TIMEOUT_MS,
            }
          : {
              url: '/open-apis/im/v1/messages',
              method: 'POST',
              params: { receive_id_type: 'chat_id' },
              data: { receive_id: chatId, msg_type: msgType, content },
              signal,
              timeout: REST_REQUEST_TIMEOUT_MS,
            },
      )))
      const id = asRecord(res.data).message_id
      if (typeof id !== 'string' || id === '') {
        throw new Error('lark: message delivery response is missing message_id')
      }
      return id
    }
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

  async updateCard(
    messageId: string,
    card: unknown,
    options?: Pick<LarkDeliveryOptions, 'signal'>,
  ): Promise<void> {
    if (this.rest === undefined) throw new Error('lark client not started')
    if (options?.signal !== undefined) {
      await callSignalBoundLarkApi('message.patch', options.signal, (signal) => this.rest!.request({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`,
        method: 'PATCH',
        data: { content: JSON.stringify(card) },
        signal,
        timeout: REST_REQUEST_TIMEOUT_MS,
      }))
      return
    }
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
