import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { CARD_ACTIONS, CARD_LIMITS, renderApprovalCard, renderApprovalDecisionCard, renderTurnCard } from './cards.ts'
import type { ToolCardItem, TurnCard, TurnCardStatus, TurnCardTodo, TurnCardUsage } from './cards.ts'
import { DEFAULT_CONFIG, MIN_STREAM_UPDATE_INTERVAL_MS } from './config.ts'
import { projectActivity, sessionEventPolicy } from './events.ts'
import type { ActivityProjection, CatalogSessionEvent } from './events.ts'
import type { LarkCardAction, LarkCardActionResult, LarkClientLike, LarkInbound } from './lark.ts'
import { localeCopy } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export interface LarkBridgeOptions {
  locale?: LarkLocale
  allowFrom?: string[]
  allowAllUsers?: boolean
  defaultSessionId?: string
  provider?: string
  model?: string
  streamUpdateIntervalMs?: number
  cwd?: string
  client: LarkClientLike
}

interface ChatSession {
  readonly chatId: string
  handle: AgentHandle
  sessionId: string
}

interface SessionBinding {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly persisted: boolean
  readonly generation: number
}

interface SessionPersistenceLike {
  list(): Promise<ReadonlyArray<{ id: ReturnType<typeof SessionId> }>>
}

interface CommandRuntimeLike {
  list(agent: Agent): ReadonlyArray<{
    readonly name: string
    readonly description: string
    readonly input?: { readonly hint: string }
  }>
  execute(
    agent: Agent,
    line: string,
    signal: AbortSignal,
  ): Promise<{ readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined>
}

interface MessageRoute {
  readonly chatId: string
  readonly openId: string
}

interface RouteQueue {
  readonly items: MessageRoute[]
  head: number
}

interface TurnState {
  readonly route: MessageRoute
  readonly tools: ToolCardItem[]
  readonly toolIndexes: Map<string, number>
  readonly startedAt: number
  status: TurnCardStatus
  answer?: string
  error?: string
  updatedAt: number
  usage?: TurnCardUsage
  contextWindow?: number
  readonly stopRequestId: string
  reasoning?: string
  streamingAnswer?: string
  todos?: TurnCardTodo[]
  messageId?: string
  delivery: Promise<void>
  deliveryDisabled?: boolean
  deliveredAnswer?: string
  textFallbackSent?: boolean
  streamTimer?: ReturnType<typeof setTimeout>
  lastStreamUpdateAt?: number
}

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void
  readonly sessionId: string
  readonly chatId: string
  readonly openId: string
  messageId?: string
  readonly toolName: string
}

interface PendingStop {
  readonly sessionId: string
  readonly chatId: string
  readonly openId: string
  stopping: boolean
}

const SESSION_RESET_SEPARATOR = ':'
const RECENT_INBOUND_LIMIT = 1024
const RESET_SESSION_SUFFIX = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BRIDGE_COMMANDS = new Set(['start', 'help', 'new', 'clear'])
const UNSUPPORTED_RUNTIME_COMMANDS = new Set(['feedback', 'export'])

const APPROVAL_DECISION = {
  allowOnce: 'allowed-once',
  reject: 'rejected',
} as const

const APPROVAL_OUTCOME = {
  allowedOnce: 'allowed-once',
  rejected: 'rejected',
  cancelled: 'cancelled',
  unavailable: 'unavailable',
} as const

function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.flatMap((block) => (
    block.type === 'text' ? [block.text] : []
  ))
  return blocks.length === 0 ? undefined : blocks.join('')
}

function eventTime(time: number): number {
  return Number.isSafeInteger(time) && time >= 0 ? time : Date.now()
}

function validContextWindow(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function boundedText(value: string, limit: number): string {
  const runes = [...value]
  return runes.length <= limit ? value : runes.slice(0, limit).join('')
}

function tailBoundedText(value: string, limit: number): string {
  const runes = [...value]
  return runes.length <= limit ? value : runes.slice(-limit).join('')
}

function appendAnswer(current: string | undefined, next: string): string {
  const combined = current === undefined || current === '' ? next : `${current}\n\n${next}`
  return boundedText(combined, CARD_LIMITS.maxAnswerRunes)
}

function appendDelta(current: string | undefined, delta: string, limit: number): string {
  return tailBoundedText(`${current ?? ''}${delta}`, limit)
}

function appendProcessText(current: string | undefined, next: string): string {
  const combined = current === undefined || current === '' ? next : `${current}\n\n${next}`
  return tailBoundedText(combined, CARD_LIMITS.maxReasoningRunes)
}

function compactJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value))
  } catch {
    return value.trim()
  }
}

function contentText(content: readonly ContentBlock[]): string | undefined {
  const stack = [...content].reverse()
  const text: string[] = []
  while (stack.length > 0) {
    const block = stack.pop()
    if (block === undefined) continue
    if (block.type === 'text') text.push(block.text)
    if (block.type === 'tool-result') stack.push(...[...block.content].reverse())
  }
  const joined = text.join('').trim()
  return joined === '' ? undefined : joined
}

function mergedUsage(current: TurnCardUsage | undefined, usage: TokenUsage | undefined): TurnCardUsage | undefined {
  if (usage === undefined) return current
  const cacheReadTokens = usage.cacheReadTokens ?? 0
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0
  return {
    inputTokens: (current?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + cacheWriteTokens,
    reasoningTokens: (current?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
    contextTokens: usage.inputTokens + cacheReadTokens + cacheWriteTokens + usage.outputTokens,
  }
}

function turnEndCard(
  event: Extract<SessionEvent, { type: 'turn/end' }>,
  locale: LarkLocale,
): {
  status: TurnCardStatus
  error?: string
} {
  const reason = event.data.reason
  const copy = localeCopy(locale).bridge
  switch (reason.kind) {
    case 'completed':
      return { status: 'completed' }
    case 'blocked':
      return { status: 'blocked', error: copy.blocked }
    case 'max-tokens':
      return { status: 'limited', error: copy.maxTokens }
    case 'aborted':
      return { status: 'cancelled', error: copy.cancelled }
    case 'error':
      return { status: 'failed', error: reason.error.message }
    case 'interrupted':
      return { status: 'failed', error: copy.interrupted }
    default:
      return {
        status: 'failed',
        error: copy.unknownTurnEnd(String((reason as unknown as { kind?: unknown }).kind ?? 'unknown')),
      }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function collectSettled<T>(
  promises: Iterable<PromiseLike<T>>,
  failures: unknown[],
): Promise<T[]> {
  const values: T[] = []
  for (const result of await Promise.allSettled(promises)) {
    if (result.status === 'fulfilled') values.push(result.value)
    else failures.push(result.reason)
  }
  return values
}

function approvalOutcome(decision: string): ApprovalOutcome | undefined {
  if (decision === APPROVAL_DECISION.allowOnce) {
    return APPROVAL_OUTCOME.allowedOnce
  }
  return decision === APPROVAL_DECISION.reject ? APPROVAL_OUTCOME.rejected : undefined
}

function actionToast(type: 'success' | 'error' | 'info', content: string): LarkCardActionResult {
  return { toast: { type, content } }
}

function inboundCommand(text: string): string | undefined {
  const stripped = text.trim().replace(/^@_user_\d+\s+/, '').trim()
  return stripped.startsWith('/') ? stripped : undefined
}

function isApprovalAsked(event: SessionEvent): boolean {
  return event.type === 'approval/asked'
}

function sessionGeneration(baseId: string, sessionId: string): number | undefined {
  if (sessionId === baseId) return 0
  if (!sessionId.startsWith(`${baseId}${SESSION_RESET_SEPARATOR}`)) return undefined
  const suffix = sessionId.slice(baseId.length + SESSION_RESET_SEPARATOR.length)
  const match = RESET_SESSION_SUFFIX.exec(suffix)
  if (match === null) return undefined
  const generation = Number(match[1])
  return Number.isSafeInteger(generation) && generation > 0 ? generation : undefined
}

function latestSessionBinding(
  baseId: string,
  headers: ReadonlyArray<{ id: ReturnType<typeof SessionId> }>,
): SessionBinding | undefined {
  let latest: SessionBinding | undefined
  for (const header of headers) {
    const sessionId = String(header.id)
    const generation = sessionGeneration(baseId, sessionId)
    if (generation === undefined || generation <= (latest?.generation ?? -1)) continue
    latest = { sessionId: SessionId(sessionId), persisted: true, generation }
  }
  return latest
}

export class LarkBridge {
  private readonly ctx: Context
  private readonly client: LarkClientLike
  private readonly locale: LarkLocale
  private readonly text: ReturnType<typeof localeCopy>['bridge']
  private readonly allowFrom: ReadonlySet<string>
  private readonly allowAllUsers: boolean
  private readonly sharedSessionBaseId: string | undefined
  private readonly provider: string
  private readonly model: string
  private readonly streamUpdateIntervalMs: number
  private readonly cwd: string
  private readonly chats = new Map<string, ChatSession>()
  private readonly handles = new Map<string, Promise<AgentHandle>>()
  private readonly queuedRoutes = new Map<string, RouteQueue>()
  private readonly turns = new Map<string, Map<number, TurnState>>()
  private readonly activeRoutes = new Map<string, MessageRoute>()
  private readonly contextWindows = new Map<string, number>()
  private readonly pending = new Map<string, PendingApproval>()
  private readonly pendingStops = new Map<string, PendingStop>()
  private readonly deliveryTasks = new Set<Promise<void>>()
  private readonly warnedEventTypes = new Set<string>()
  private readonly inboundTasks = new Map<string, Promise<void>>()
  private readonly completedInboundKeys: string[] = []
  private readonly sessionOperations = new Map<string, Promise<void>>()
  private sharedSessionId: string | undefined
  private lastSessionGeneration = 0
  private disposeEvents: (() => void) | undefined
  private disposeApproval: (() => void) | undefined
  private approvalWaterfallBound = false
  private startPromise: Promise<void> | undefined
  private clientStarted = false
  private stopping = false
  private commandAbort = new AbortController()
  // Resets are rare; use per-session barriers only if contention is measured.
  private resetBarrier: Promise<void> = Promise.resolve()

  constructor(ctx: Context, options: LarkBridgeOptions) {
    this.ctx = ctx
    this.client = options.client
    this.locale = options.locale ?? DEFAULT_CONFIG.locale
    this.text = localeCopy(this.locale).bridge
    this.allowFrom = new Set((options.allowFrom ?? []).map((openId) => openId.trim()).filter(Boolean))
    this.allowAllUsers = options.allowAllUsers ?? DEFAULT_CONFIG.allowAllUsers
    const defaultSessionId = (options.defaultSessionId ?? '').trim()
    this.sharedSessionBaseId = defaultSessionId === '' ? undefined : defaultSessionId
    this.provider = options.provider ?? DEFAULT_CONFIG.provider
    this.model = options.model ?? DEFAULT_CONFIG.model
    this.streamUpdateIntervalMs = options.streamUpdateIntervalMs ?? DEFAULT_CONFIG.streamUpdateIntervalMs
    if (!Number.isSafeInteger(this.streamUpdateIntervalMs)
      || this.streamUpdateIntervalMs < MIN_STREAM_UPDATE_INTERVAL_MS) {
      throw new RangeError(`lark: streamUpdateIntervalMs must be an integer >= ${MIN_STREAM_UPDATE_INTERVAL_MS}`)
    }
    this.cwd = options.cwd ?? process.cwd()
  }

  start(): Promise<void> {
    if (this.disposeEvents !== undefined) return this.startPromise ?? Promise.resolve()
    this.stopping = false
    this.clientStarted = false
    this.commandAbort = new AbortController()
    this.disposeEvents = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.handleSessionEvent(session, event)
    })
    this.bindApprovalSeam()
    this.client.onMessage((msg) => this.handleInbound(msg))
    this.client.onCardAction?.((action) => this.handleCardAction(action))
    const start = this.client.start().then(() => {
      this.clientStarted = true
    })
    this.startPromise = start
    return start
  }

  async stop(): Promise<void> {
    const failures: unknown[] = []
    this.stopping = true
    this.commandAbort.abort()
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    if (this.disposeApproval !== undefined) {
      this.disposeApproval()
      this.disposeApproval = undefined
    }
    this.approvalWaterfallBound = false
    for (const pending of this.pending.values()) pending.resolve(APPROVAL_OUTCOME.cancelled)
    this.pending.clear()
    this.pendingStops.clear()
    const start = this.startPromise
    this.startPromise = undefined
    if (!this.clientStarted) {
      await collectSettled([Promise.resolve().then(() => this.client.stop())], failures)
    }
    if (start !== undefined) await Promise.allSettled([start])
    await collectSettled(this.inboundTasks.values(), failures)
    this.clearAllStreamTimers()
    await this.drainDeliveries(failures)
    await collectSettled([Promise.resolve().then(() => this.client.stop())], failures)
    const agents = await collectSettled(this.handles.values(), failures)
    this.chats.clear()
    this.handles.clear()
    this.inboundTasks.clear()
    this.completedInboundKeys.length = 0
    this.clearRoutes()
    await collectSettled([...new Set(agents)].map((handle) => handle.dispose()), failures)
    this.clientStarted = false
    if (failures.length > 0) throw new AggregateError(failures, 'lark: bridge teardown failed')
  }

  async handleInbound(msg: LarkInbound): Promise<void> {
    if (this.stopping) return
    const key = msg.messageId === '' ? undefined : `${msg.chatId}\0${msg.messageId}`
    if (key === undefined) {
      await this.handleInboundOnce(msg)
      return
    }
    const existing = this.inboundTasks.get(key)
    if (existing !== undefined) {
      await existing
      return
    }
    const task = this.handleInboundOnce(msg)
    this.inboundTasks.set(key, task)
    try {
      await task
    } catch (error) {
      if (this.inboundTasks.get(key) === task) this.inboundTasks.delete(key)
      throw error
    }
    this.completedInboundKeys.push(key)
    // In-memory replay window; persist message ids only if cross-restart replay is observed.
    if (this.completedInboundKeys.length > RECENT_INBOUND_LIMIT) {
      const oldest = this.completedInboundKeys.shift()
      if (oldest !== undefined) this.inboundTasks.delete(oldest)
    }
  }

  private async handleInboundOnce(msg: LarkInbound): Promise<void> {
    const command = inboundCommand(msg.text)
    if (msg.chatType === 'group' && !msg.mentioned && command === undefined) return
    if (!this.authorized(msg.openId)) {
      await this.safeSend(msg.chatId, this.text.denied)
      return
    }
    if (command !== undefined) {
      await this.handleCommand(msg.chatId, command)
      return
    }
    await this.resetBarrier
    const chat = await this.ensureChat(msg.chatId)
    const route = { chatId: msg.chatId, openId: msg.openId }
    this.enqueueRoute(chat.sessionId, route)
    try {
      chat.handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: msg.text.trim() }],
        source: { kind: 'user' },
      }))
    } catch (error) {
      this.removeQueuedRoute(chat.sessionId, route)
      this.ctx.logger.error('[lark] followup failed: %s', messageOf(error))
      await this.safeSend(msg.chatId, this.text.followupFailure)
    }
  }

  async handleCardAction(action: LarkCardAction): Promise<LarkCardActionResult> {
    if (!this.authorized(action.openId)) {
      if (action.chatId !== '') await this.safeSend(action.chatId, this.text.denied)
      return actionToast('error', this.text.approvalUnauthorized)
    }
    if (action.value.action === CARD_ACTIONS.turnStop) return this.handleStopAction(action)
    const requestId = String(action.value.request_id ?? '')
    const decision = String(action.value.decision ?? '')
    const outcome = approvalOutcome(decision)
    if (requestId === '' || outcome === undefined) {
      return actionToast('error', this.text.approvalMalformed)
    }
    await this.resetBarrier
    const pending = this.pending.get(requestId)
    if (pending === undefined) return actionToast('info', this.text.approvalExpired)
    if (pending.chatId !== action.chatId || pending.openId !== action.openId) {
      this.ctx.logger.warn('[lark] rejected approval from a different chat or user')
      return actionToast('error', this.text.approvalWrongContext)
    }
    const messageId = action.messageId !== '' ? action.messageId : pending.messageId
    pending.resolve(outcome)
    if (messageId !== undefined) await this.updateApprovalCard(messageId, outcome, pending.toolName)
    const content = outcome === APPROVAL_OUTCOME.allowedOnce
      ? this.text.approvalAllowed
      : this.text.approvalRejected
    return actionToast('success', content)
  }

  private async handleStopAction(action: LarkCardAction): Promise<LarkCardActionResult> {
    const requestId = String(action.value.request_id ?? '')
    if (requestId === '') return actionToast('error', this.text.stopUnavailable)
    await this.resetBarrier
    const pending = this.pendingStops.get(requestId)
    if (pending === undefined) return actionToast('info', this.text.stopExpired)
    if (pending.chatId !== action.chatId || pending.openId !== action.openId) {
      this.ctx.logger.warn('[lark] rejected stop from a different chat or user')
      return actionToast('error', this.text.stopWrongContext)
    }
    if (pending.stopping) return actionToast('info', this.text.stopRequested)
    const handle = this.handles.get(pending.sessionId)
    if (handle === undefined) {
      this.pendingStops.delete(requestId)
      return actionToast('info', this.text.stopExpired)
    }
    pending.stopping = true
    try {
      const resolved = await handle
      if (resolved.agent.status !== 'running') {
        this.pendingStops.delete(requestId)
        return actionToast('info', this.text.stopExpired)
      }
      resolved.agent.cancel({ kind: 'user' })
      return actionToast('success', this.text.stopRequested)
    } catch (error) {
      this.pendingStops.delete(requestId)
      this.ctx.logger.error('[lark] stop failed: %s', messageOf(error))
      return actionToast('error', this.text.stopUnavailable)
    }
  }

  private authorized(openId: string): boolean {
    if (openId === '') return false
    return this.allowAllUsers || this.allowFrom.has(openId)
  }

  private hasApprovalSeam(): boolean {
    if (typeof this.ctx.get !== 'function') return false
    try {
      return this.ctx.get('approval') !== undefined
    } catch {
      return false
    }
  }

  private bindApprovalSeam(): void {
    const listen = (): void => {
      this.disposeApproval = this.ctx.on(
        'approval/request',
        (req, next) => this.handleApprovalRequest(req, next),
      )
      this.approvalWaterfallBound = true
    }
    const available = this.hasApprovalSeam()
    try {
      listen()
    } catch (error) {
      const message = available
        ? '[lark] user-approval listen failed; approval cards disabled: %s'
        : '[lark] user-approval not available; approval cards disabled: %s'
      this.ctx.logger.warn(message, messageOf(error))
      return
    }
    if (!available) {
      this.ctx.logger.warn('[lark] user-approval not available; approval cards disabled')
    }
  }

  private handleApprovalRequest(
    req: ApprovalRequest,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const sessionId = String(req.agent.session.id)
    const route = this.approvalRoute(sessionId)
    if (route === undefined) return next()
    if (this.client.sendCard === undefined) {
      this.ctx.logger.warn('[lark] sendCard missing; skip approval card')
      return next()
    }
    const requestId = randomUUID()
    const toolName = req.toolName
    const card = renderApprovalCard({ requestId, toolName, reason: req.reason, locale: this.locale })
    return new Promise((resolve) => {
      const finish = (outcome: ApprovalOutcome): void => {
        req.signal?.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
        resolve(outcome)
      }
      const onAbort = (): void => {
        const pending = this.pending.get(requestId)
        finish(APPROVAL_OUTCOME.cancelled)
        if (pending?.messageId !== undefined) {
          this.trackDelivery(this.updateApprovalCard(
            pending.messageId,
            APPROVAL_OUTCOME.cancelled,
            toolName,
          ))
        }
      }
      this.pending.set(requestId, {
        resolve: finish,
        sessionId,
        chatId: route.chatId,
        openId: route.openId,
        toolName,
      })
      if (req.signal !== undefined) {
        if (req.signal.aborted) {
          onAbort()
          return
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
      }
      const delivery = this.client.sendCard!(route.chatId, card).then((messageId) => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        if (typeof messageId === 'string' && messageId !== '') {
          pending.messageId = messageId
          return
        }
        this.ctx.logger.error('[lark] approval card send failed: missing message id')
        finish(APPROVAL_OUTCOME.unavailable)
      }).catch((error: unknown) => {
        this.ctx.logger.error('[lark] approval card send failed: %s', messageOf(error))
        finish(APPROVAL_OUTCOME.unavailable)
      })
      this.trackDelivery(delivery)
    })
  }

  private async updateApprovalCard(
    messageId: string,
    outcome: ApprovalOutcome,
    toolName: string,
  ): Promise<void> {
    if (this.client.updateCard === undefined) return
    try {
      await this.client.updateCard(messageId, renderApprovalDecisionCard(outcome, toolName, this.locale))
    } catch (error) {
      this.ctx.logger.error('[lark] approval card update failed: %s', messageOf(error))
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    const command = text.split(/\s+/)[0] ?? ''
    switch (command) {
      case '/start':
      case '/help':
        await this.resetBarrier
        await this.safeSend(chatId, this.commandHelp((await this.ensureChat(chatId)).handle.agent))
        break
      case '/new':
      case '/clear':
        await this.scheduleReset(chatId)
        break
      default:
        await this.executeRuntimeCommand(chatId, text, command)
    }
  }

  private commandRuntime(): CommandRuntimeLike | undefined {
    try {
      const runtime = this.ctx.get('commands') as CommandRuntimeLike | undefined
      return runtime !== undefined && typeof runtime.list === 'function' && typeof runtime.execute === 'function'
        ? runtime
        : undefined
    } catch {
      return undefined
    }
  }

  private commandHelp(agent: Agent): string {
    const runtime = this.commandRuntime()
    if (runtime === undefined) return this.text.help
    const commands = runtime.list(agent).filter(({ name }) => (
      !BRIDGE_COMMANDS.has(name) && !UNSUPPORTED_RUNTIME_COMMANDS.has(name)
    )).map((descriptor) => {
      const input = descriptor.input === undefined ? '' : ` ${descriptor.input.hint}`
      return `/${descriptor.name}${input} — ${this.text.commandDescription(descriptor.name, descriptor.description)}`
    })
    return commands.length === 0 ? this.text.help : `${this.text.help}\n${commands.join('\n')}`
  }

  private executeRuntimeCommand(chatId: string, text: string, command: string): Promise<void> {
    let operation: Promise<void> = Promise.resolve()
    const admission = this.resetBarrier.then(async () => {
      const chat = await this.ensureChat(chatId)
      operation = this.enqueueSessionOperation(
        chat.sessionId,
        () => this.executeRuntimeCommandNow(chat, text, command),
      )
    })
    this.resetBarrier = admission.catch(() => {})
    return admission.then(() => operation)
  }

  private async executeRuntimeCommandNow(chat: ChatSession, text: string, command: string): Promise<void> {
    if (UNSUPPORTED_RUNTIME_COMMANDS.has(command.slice(1).toLowerCase())) {
      await this.safeSend(chat.chatId, this.text.unknownCommand(command))
      return
    }
    const runtime = this.commandRuntime()
    if (runtime === undefined) {
      await this.safeSend(chat.chatId, this.text.unknownCommand(command))
      return
    }
    try {
      const execution = await runtime.execute(chat.handle.agent, text, this.commandAbort.signal)
      if (execution === undefined) {
        await this.safeSend(chat.chatId, this.text.unknownCommand(command))
      } else if (execution.result.text !== undefined && execution.result.text !== '') {
        await this.safeSend(chat.chatId, execution.result.text)
      } else if (execution.result.kind === 'error') {
        await this.safeSend(chat.chatId, this.text.commandFailed)
      }
    } catch (error) {
      this.ctx.logger.error('[lark] command failed: %s', messageOf(error))
      await this.safeSend(chat.chatId, this.text.commandFailed)
    }
  }

  private enqueueSessionOperation<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const operation = (this.sessionOperations.get(sessionId) ?? Promise.resolve()).then(task)
    const tail = operation.then(() => {}, () => {})
    this.sessionOperations.set(sessionId, tail)
    void tail.then(() => {
      if (this.sessionOperations.get(sessionId) === tail) this.sessionOperations.delete(sessionId)
    })
    return operation
  }

  private scheduleReset(chatId: string): Promise<void> {
    const reset = this.resetBarrier.then(async () => {
      const chat = await this.ensureChat(chatId)
      await this.sessionOperations.get(chat.sessionId)
      await this.resetChat(chatId)
    })
    this.resetBarrier = reset.catch(() => {})
    return reset
  }

  private async resetChat(chatId: string): Promise<void> {
    const chat = await this.ensureChat(chatId)
    const previousSessionId = chat.sessionId
    const previousHandle = chat.handle
    const baseId = this.sessionBaseId(chatId)
    const generation = Math.max(Date.now(), this.lastSessionGeneration + 1)
    this.lastSessionGeneration = generation
    const sessionId = SessionId(`${baseId}${SESSION_RESET_SEPARATOR}${generation}-${randomUUID()}`)
    const handle = await this.ensureHandle(sessionId, false, true)
    try {
      await this.ctx.sessions.flush(handle.agent.session)
    } catch (flushError) {
      try {
        await handle.dispose()
        this.handles.delete(String(sessionId))
      } catch (disposeError) {
        throw new AggregateError(
          [flushError, disposeError],
          'lark: fresh session durability and cleanup failed',
        )
      }
      throw flushError
    }
    if (this.sharedSessionBaseId !== undefined) this.sharedSessionId = String(sessionId)
    for (const entry of this.chats.values()) {
      if (entry.sessionId !== previousSessionId) continue
      entry.handle = handle
      entry.sessionId = String(sessionId)
    }
    this.clearSessionState(previousSessionId)
    try {
      await previousHandle.dispose()
      this.handles.delete(previousSessionId)
    } catch (error) {
      this.ctx.logger.error('[lark] previous session disposal failed: %s', messageOf(error))
    }
    await this.safeSend(chatId, this.text.freshSession)
  }

  private async ensureChat(chatId: string): Promise<ChatSession> {
    const existing = this.chats.get(chatId)
    if (existing !== undefined) return existing
    const binding = this.sharedSessionId === undefined
      ? await this.resolveSessionBinding(this.sessionBaseId(chatId))
      : { sessionId: SessionId(this.sharedSessionId), persisted: false, generation: this.lastSessionGeneration }
    const handle = await this.ensureHandle(binding.sessionId, binding.persisted)
    const sessionId = binding.sessionId
    this.lastSessionGeneration = Math.max(this.lastSessionGeneration, binding.generation)
    if (this.sharedSessionBaseId !== undefined) this.sharedSessionId = String(sessionId)
    const entry: ChatSession = { chatId, handle, sessionId: String(sessionId) }
    this.chats.set(chatId, entry)
    return entry
  }

  private sessionBaseId(chatId: string): string {
    return this.sharedSessionBaseId
      ?? `${DEFAULT_CONFIG.sessionPrefix}${SESSION_RESET_SEPARATOR}${chatId}`
  }

  private async resolveSessionBinding(baseId: string): Promise<SessionBinding> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistenceLike | undefined
    if (persistence === undefined) {
      return { sessionId: SessionId(baseId), persisted: false, generation: 0 }
    }
    if (typeof persistence.list !== 'function') {
      throw new TypeError('lark: sessionPersistence.list is unavailable')
    }
    return latestSessionBinding(baseId, await persistence.list())
      ?? { sessionId: SessionId(baseId), persisted: false, generation: 0 }
  }

  private async ensureHandle(
    sessionId: ReturnType<typeof SessionId>,
    persisted = false,
    materialize = false,
  ): Promise<AgentHandle> {
    const key = String(sessionId)
    const existing = this.handles.get(key)
    if (existing !== undefined) return existing
    const agentOptions = { provider: this.provider, model: this.model }
    const opened = persisted
      ? this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
      : this.ctx.agents.create({
          sessionId,
          meta: { cwd: this.cwd },
          agentOptions,
          ...(materialize ? { seed: [] } : {}),
        })
    this.handles.set(key, opened)
    try {
      const handle = await opened
      const contextWindow = validContextWindow(handle.agent.session.requestContext()?.contextWindow)
      if (contextWindow === undefined) this.contextWindows.delete(key)
      else this.contextWindows.set(key, contextWindow)
      return handle
    } catch (error) {
      if (this.handles.get(key) === opened) this.handles.delete(key)
      throw error
    }
  }

  private handleSessionEvent(session: Session, event: SessionEvent): void {
    if (!this.approvalWaterfallBound && isApprovalAsked(event)) {
      this.ctx.logger.warn('[lark] approval-like session event without user-approval seam; skip cards')
      return
    }
    switch (event.type) {
      case 'turn/start':
        this.bindTurn(session.id, event.data.turn, event.time)
        return
      case 'turn/end':
        this.finishTurn(session.id, event)
        return
      case 'assistant/chunk':
        this.handleAssistantChunk(session.id, event)
        return
      case 'tool/call':
        this.handleToolCall(session.id, event)
        return
      case 'tool/result':
        this.handleToolResult(session.id, event)
        return
      case 'assistant/message':
        this.handleAssistantMessage(session.id, event)
        return
      case 'todo/write':
        this.handleTodoWrite(session.id, event)
        return
      case 'request/context':
        this.handleRequestContext(session.id, event)
        return
      default:
        this.handleCatalogEvent(session.id, event as unknown as CatalogSessionEvent)
    }
  }

  private enqueueRoute(sessionId: string, route: MessageRoute): void {
    const queue = this.queuedRoutes.get(sessionId)
    if (queue !== undefined) {
      queue.items.push(route)
      return
    }
    this.queuedRoutes.set(sessionId, { items: [route], head: 0 })
  }

  private removeQueuedRoute(sessionId: string, route: MessageRoute): void {
    const queue = this.queuedRoutes.get(sessionId)
    if (queue === undefined || queue.items.at(-1) !== route) return
    queue.items.pop()
    if (queue.head === queue.items.length) this.queuedRoutes.delete(sessionId)
  }

  private dequeueRoute(sessionId: string): MessageRoute | undefined {
    const queue = this.queuedRoutes.get(sessionId)
    if (queue === undefined) return undefined
    const route = queue.items[queue.head]
    queue.head += 1
    if (queue.head === queue.items.length) this.queuedRoutes.delete(sessionId)
    return route
  }

  private bindTurn(sessionId: string, turn: number, time: number): void {
    const route = this.dequeueRoute(sessionId)
    if (route === undefined) return
    const startedAt = eventTime(time)
    const stopRequestId = randomUUID()
    const state: TurnState = {
      route,
      tools: [],
      toolIndexes: new Map(),
      startedAt,
      updatedAt: startedAt,
      status: 'running',
      stopRequestId,
      delivery: Promise.resolve(),
      ...(this.contextWindows.get(sessionId) === undefined
        ? {}
        : { contextWindow: this.contextWindows.get(sessionId) }),
    }
    const turns = this.turns.get(sessionId) ?? new Map<number, TurnState>()
    turns.set(turn, state)
    this.turns.set(sessionId, turns)
    this.pendingStops.set(stopRequestId, {
      sessionId,
      chatId: route.chatId,
      openId: route.openId,
      stopping: false,
    })
    this.activeRoutes.set(sessionId, route)
    this.queueTurnCard(state)
  }

  private finishTurn(sessionId: string, event: Extract<SessionEvent, { type: 'turn/end' }>): void {
    const turns = this.turns.get(sessionId)
    const state = turns?.get(event.data.turn)
    if (state === undefined) return
    const terminal = turnEndCard(event, this.locale)
    this.clearStreamTimer(state)
    state.status = terminal.status
    state.error = terminal.error
    this.pendingStops.delete(state.stopRequestId)
    state.updatedAt = eventTime(event.time)
    this.queueTurnCard(state)
    this.fallbackFailedCard(state)
    turns?.delete(event.data.turn)
    if (turns?.size === 0) this.turns.delete(sessionId)
    if (this.activeRoutes.get(sessionId) === state.route) {
      this.activeRoutes.delete(sessionId)
    }
  }

  private handleToolCall(sessionId: string, event: Extract<SessionEvent, { type: 'tool/call' }>): void {
    const state = this.turnState(sessionId, event.data.turn)
    if (state === undefined) return
    const id = String(event.data.callId)
    const index = state.toolIndexes.get(id)
    const previous = index === undefined ? undefined : state.tools[index]
    const time = eventTime(event.time)
    const tool: ToolCardItem = {
      id,
      name: event.data.name,
      detail: compactJson(event.data.arguments),
      status: 'running',
      startedAt: previous?.startedAt ?? time,
      updatedAt: time,
    }
    if (index === undefined) {
      state.toolIndexes.set(id, state.tools.length)
      state.tools.push(tool)
    } else {
      state.tools[index] = tool
    }
    state.updatedAt = eventTime(event.time)
    this.queueTurnCard(state)
  }

  private handleToolResult(sessionId: string, event: Extract<SessionEvent, { type: 'tool/result' }>): void {
    const state = this.turnState(sessionId, event.data.turn)
    if (state === undefined) return
    const id = String(event.data.message.source.callId)
    const index = state.toolIndexes.get(id)
    if (index === undefined) return
    const previous = state.tools[index]
    const result = contentText(event.data.message.content)
    const failed = event.data.error !== undefined || event.data.message.content[0].isError === true
    state.tools[index] = {
      ...previous,
      detail: failed ? (result ?? previous?.detail) : previous?.detail,
      status: failed ? 'failed' : 'completed',
      updatedAt: eventTime(event.time),
    }
    state.updatedAt = eventTime(event.time)
    this.queueTurnCard(state)
  }

  private handleAssistantMessage(
    sessionId: string,
    event: Extract<SessionEvent, { type: 'assistant/message' }>,
  ): void {
    const state = this.turnState(sessionId, event.data.turn)
    if (state === undefined) return
    this.clearStreamTimer(state)
    const text = assistantText(event)
    if (event.data.usage !== undefined) {
      const contextWindow = this.contextWindows.get(sessionId)
      if (contextWindow === undefined) delete state.contextWindow
      else state.contextWindow = contextWindow
    }
    state.usage = mergedUsage(state.usage, event.data.usage)
    state.updatedAt = eventTime(event.time)
    const callsTool = event.data.message.content.some((block) => block.type === 'tool-call')
    if (text !== undefined) {
      if (callsTool) state.reasoning = appendProcessText(state.reasoning, text)
      else state.answer = appendAnswer(state.answer, text)
    }
    state.streamingAnswer = undefined
    if (this.canRenderTurnCards()) {
      if (state.deliveryDisabled !== true) this.queueTurnCard(state)
      return
    }
    if (text !== undefined && !callsTool) this.trackDelivery(this.safeSend(state.route.chatId, text))
  }

  private turnState(sessionId: string, turn: number): TurnState | undefined {
    return this.turns.get(sessionId)?.get(turn)
  }

  private activeTurnState(sessionId: string): TurnState | undefined {
    return this.turns.get(sessionId)?.values().next().value
  }

  private handleAssistantChunk(
    sessionId: string,
    event: Extract<SessionEvent, { type: 'assistant/chunk' }>,
  ): void {
    const state = this.turnState(sessionId, event.data.turn)
    if (state === undefined) return
    const chunk = event.data.chunk
    if (chunk.type === 'text-delta') {
      state.streamingAnswer = appendDelta(state.streamingAnswer, chunk.text, CARD_LIMITS.maxReasoningRunes)
    } else if (chunk.type === 'reasoning-delta') {
      state.reasoning = appendDelta(state.reasoning, chunk.text, CARD_LIMITS.maxReasoningRunes)
    } else {
      return
    }
    state.updatedAt = eventTime(event.time)
    this.scheduleStreamUpdate(state)
  }

  private scheduleStreamUpdate(state: TurnState): void {
    const now = Date.now()
    const elapsed = now - (state.lastStreamUpdateAt ?? 0)
    if (state.lastStreamUpdateAt === undefined || elapsed >= this.streamUpdateIntervalMs) {
      this.flushStreamUpdate(state)
      return
    }
    if (state.streamTimer !== undefined) return
    state.streamTimer = setTimeout(() => this.flushStreamUpdate(state), this.streamUpdateIntervalMs - elapsed)
    state.streamTimer.unref()
  }

  private flushStreamUpdate(state: TurnState): void {
    state.streamTimer = undefined
    state.lastStreamUpdateAt = Date.now()
    this.queueTurnCard(state)
  }

  private clearStreamTimer(state: TurnState): void {
    if (state.streamTimer === undefined) return
    clearTimeout(state.streamTimer)
    state.streamTimer = undefined
  }

  private handleTodoWrite(sessionId: string, event: Extract<SessionEvent, { type: 'todo/write' }>): void {
    const state = this.activeTurnState(sessionId)
    if (state === undefined) return
    state.todos = event.data.todos.slice(-CARD_LIMITS.maxVisibleTodos).map((todo) => ({
      content: boundedText(todo.content, CARD_LIMITS.maxTodoRunes),
      status: todo.status,
    }))
    state.updatedAt = eventTime(event.time)
    this.queueTurnCard(state)
  }

  private handleRequestContext(
    sessionId: string,
    event: Extract<SessionEvent, { type: 'request/context' }>,
  ): void {
    const contextWindow = validContextWindow(event.data.contextWindow)
    if (contextWindow === undefined) {
      this.contextWindows.delete(sessionId)
    } else {
      this.contextWindows.set(sessionId, contextWindow)
    }
    const state = this.activeTurnState(sessionId)
    if (state === undefined || state.usage !== undefined) return
    if (contextWindow === undefined) delete state.contextWindow
    else state.contextWindow = contextWindow
    state.updatedAt = eventTime(event.time)
    this.queueTurnCard(state)
  }

  private handleCatalogEvent(sessionId: string, event: CatalogSessionEvent): void {
    const policy = sessionEventPolicy(event.type)
    if (policy === undefined) {
      this.warnUnknownEvent(event.type)
      return
    }
    if (policy !== 'render') return
    const activity = projectActivity(event, this.locale)
    if (activity === undefined) return
    const state = this.activityTurnState(sessionId, activity)
    if (state === undefined) return
    this.applyActivity(state, activity, event.time)
  }

  private activityTurnState(sessionId: string, activity: ActivityProjection): TurnState | undefined {
    if (activity.turn === null) return undefined
    return activity.turn === undefined
      ? this.activeTurnState(sessionId)
      : this.turnState(sessionId, activity.turn)
  }

  private applyActivity(state: TurnState, activity: ActivityProjection, time: number): void {
    const index = state.toolIndexes.get(activity.id)
    const previous = index === undefined ? undefined : state.tools[index]
    const timestamp = eventTime(time)
    const item: ToolCardItem = {
      id: activity.id,
      name: activity.name ?? previous?.name ?? activity.id,
      detail: activity.detail ?? previous?.detail,
      status: activity.status,
      startedAt: previous?.startedAt ?? timestamp,
      updatedAt: timestamp,
    }
    if (index === undefined) {
      state.toolIndexes.set(activity.id, state.tools.length)
      state.tools.push(item)
    } else {
      state.tools[index] = item
    }
    state.updatedAt = eventTime(time)
    this.queueTurnCard(state)
  }

  private warnUnknownEvent(type: string): void {
    if (this.warnedEventTypes.has(type)) return
    this.warnedEventTypes.add(type)
    this.ctx.logger.warn('[lark] unclassified session event ignored: %s', type)
  }

  private canRenderTurnCards(): boolean {
    return this.client.sendCard !== undefined && this.client.updateCard !== undefined
  }

  private turnCard(state: TurnState): TurnCard {
    return {
      locale: this.locale,
      status: state.status,
      answer: state.answer,
      error: state.error,
      tools: state.tools,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      usage: state.usage,
      contextWindow: state.contextWindow,
      loadingImageKey: this.client.loadingImageKey,
      stopRequestId: state.stopRequestId,
      reasoning: state.streamingAnswer === undefined
        ? state.reasoning
        : appendProcessText(state.reasoning, state.streamingAnswer),
      todos: state.todos,
    }
  }

  private queueTurnCard(state: TurnState): void {
    if (!this.canRenderTurnCards() || state.deliveryDisabled === true) return
    this.clearStreamTimer(state)
    state.lastStreamUpdateAt = Date.now()
    let card: Record<string, unknown>
    const turnCard = this.turnCard(state)
    try {
      card = renderTurnCard(turnCard)
    } catch (error) {
      this.ctx.logger.error('[lark] card render failed: %s', messageOf(error))
      return
    }
    const answer = turnCard.answer === undefined || turnCard.answer === '' ? undefined : turnCard.answer
    const delivery = state.delivery
      .then(() => this.deliverTurnCard(state, card, answer))
      .catch((error: unknown) => {
        state.deliveryDisabled = true
        this.ctx.logger.error('[lark] turn card delivery failed: %s', messageOf(error))
        this.fallbackFailedCard(state)
      })
    state.delivery = delivery
    this.trackDelivery(delivery)
  }

  private async deliverTurnCard(
    state: TurnState,
    card: Record<string, unknown>,
    answer: string | undefined,
  ): Promise<void> {
    if (state.deliveryDisabled === true) return
    if (state.messageId !== undefined) {
      await this.client.updateCard!(state.messageId, card)
      if (answer !== undefined) state.deliveredAnswer = answer
      return
    }
    const messageId = await this.client.sendCard!(state.route.chatId, card)
    if (typeof messageId === 'string' && messageId !== '') {
      state.messageId = messageId
      if (answer !== undefined) state.deliveredAnswer = answer
      return
    }
    state.deliveryDisabled = true
    this.ctx.logger.warn('[lark] sendCard returned no message id; turn card updates disabled')
    this.fallbackFailedCard(state)
  }

  private fallbackFailedCard(state: TurnState): void {
    if (state.deliveryDisabled !== true || state.status === 'running') return
    if (state.deliveredAnswer === state.answer || state.textFallbackSent === true) return
    if (state.answer === undefined || state.answer === '') return
    state.textFallbackSent = true
    this.trackDelivery(this.safeSend(state.route.chatId, state.answer))
  }

  private trackDelivery(delivery: Promise<void>): void {
    this.deliveryTasks.add(delivery)
    void delivery.finally(() => this.deliveryTasks.delete(delivery))
  }

  private async drainDeliveries(failures: unknown[]): Promise<void> {
    while (this.deliveryTasks.size > 0) {
      await collectSettled([...this.deliveryTasks], failures)
    }
  }

  private approvalRoute(sessionId: string): MessageRoute | undefined {
    const active = this.activeRoutes.get(sessionId)
    if (active !== undefined) return active
    const queued = this.queuedRoutes.get(sessionId)
    return queued?.items[queued.head]
  }

  private clearSessionState(sessionId: string): void {
    this.queuedRoutes.delete(sessionId)
    for (const state of this.turns.get(sessionId)?.values() ?? []) this.clearStreamTimer(state)
    this.turns.delete(sessionId)
    this.activeRoutes.delete(sessionId)
    this.contextWindows.delete(sessionId)
    for (const [requestId, pending] of this.pendingStops) {
      if (pending.sessionId === sessionId) this.pendingStops.delete(requestId)
    }
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId) continue
      const messageId = pending.messageId
      pending.resolve(APPROVAL_OUTCOME.cancelled)
      if (messageId !== undefined) {
        this.trackDelivery(this.updateApprovalCard(
          messageId,
          APPROVAL_OUTCOME.cancelled,
          pending.toolName,
        ))
      }
    }
  }

  private clearRoutes(): void {
    this.queuedRoutes.clear()
    this.turns.clear()
    this.activeRoutes.clear()
    this.contextWindows.clear()
    this.pendingStops.clear()
    this.sessionOperations.clear()
  }

  private clearAllStreamTimers(): void {
    for (const turns of this.turns.values()) {
      for (const state of turns.values()) this.clearStreamTimer(state)
    }
  }

  private async safeSend(chatId: string, text: string): Promise<void> {
    try {
      await this.client.sendText(chatId, text)
    } catch (error) {
      this.ctx.logger.error('[lark] delivery failed: %s', messageOf(error))
    }
  }
}
