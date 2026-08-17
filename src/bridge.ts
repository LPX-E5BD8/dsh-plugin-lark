import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { foldRequestHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { CARD_ACTIONS, CARD_LIMITS, renderApprovalCard, renderApprovalDecisionCard, renderTurnCardWithMeta } from './cards.ts'
import type { ToolCardItem, TurnCard, TurnCardStatus, TurnCardTodo, TurnCardUsage } from './cards.ts'
import { DEFAULT_CONFIG, MIN_STREAM_UPDATE_INTERVAL_MS } from './config.ts'
import { CONVERSATION_MUTATION_HISTORY_LIMIT } from './conversation-binding.ts'
import type {
  ConversationBinding,
  ConversationBindingStore,
  ConversationModelSelection,
} from './conversation-binding.ts'
import { projectActivity, sessionEventPolicy } from './events.ts'
import type { ActivityProjection, CatalogSessionEvent } from './events.ts'
import type { InboundDeduplicator } from './inbound-dedup.ts'
import type {
  LarkCardAction,
  LarkCardActionResult,
  LarkClientLike,
  LarkDeliveryOptions,
  LarkInbound,
} from './lark.ts'
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
  maxConversationHandles?: number
  cwd?: string
  client: LarkClientLike
  inboundDeduplicator?: InboundDeduplicator
  conversationBindings?: ConversationBindingStore
}

interface ConversationSession {
  readonly baseId: string
  handle: AgentHandle
  sessionId: string
  modelSelection: ConversationModelSelection
  modelSelectionRef: ModelSelectionRef
  lastAccess: number
  workspaceId?: string
}

type ConversationEvictionResult = 'evicted' | 'retained' | 'busy' | 'not-durable'
type ConversationCheckpointResult = 'ready' | 'stale' | 'pending' | 'not-durable'

interface SessionBinding {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly persisted: boolean
  readonly generation: number
  readonly agentPreset?: string
  readonly modelSelection: ConversationModelSelection | null
}

interface SessionPersistenceLike {
  list(): Promise<ReadonlyArray<{
    id: ReturnType<typeof SessionId>
    agentPreset?: string
  }>>
  inspect?(id: ReturnType<typeof SessionId>): Promise<{
    readonly meta: { readonly agentPreset?: string }
    readonly events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  }>
}

interface AgentPresetsLike {
  resolve(id?: string): Promise<{ readonly id: string }>
  mount(agentCtx: Context, id?: string): Promise<{ readonly id: string }>
}

interface AgentComposition {
  readonly agentPreset?: string
  readonly setup?: (agentCtx: Context) => Promise<void>
}

interface LlmProviderInfoLike {
  readonly id: string
  readonly name: string
}

interface LlmModelInfoLike {
  readonly provider: string
  readonly id: string
  readonly name: string
}

interface LlmRuntimeLike {
  listProviders(): LlmProviderInfoLike[]
  listModels(provider: string): Promise<LlmModelInfoLike[]>
  resolveCallConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<LlmCallConfig>
}

interface ListedModel {
  readonly provider: string
  readonly id: string
  readonly displayId: string
  readonly name: string
}

interface ListedModelGroup {
  readonly id: string
  readonly displayId: string
  readonly name: string
  readonly models: readonly ListedModel[]
}

interface ModelCatalog {
  readonly groups: readonly ListedModelGroup[]
  readonly providerIds: ReadonlySet<string>
  readonly partial: boolean
  readonly truncated: boolean
}

interface RegisteredWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds?: ReadonlyArray<ReturnType<typeof SessionId>>
  status(): Promise<'ok' | 'missing-dir'>
  attachSession(sessionId: ReturnType<typeof SessionId>): Promise<void>
}

interface WorkspaceRegistryLike {
  list(): ReadonlyArray<RegisteredWorkspace>
  get(id: string): RegisteredWorkspace | undefined
  resolveByPath?(path: string): Promise<RegisteredWorkspace | undefined>
}

interface ProjectSelection {
  readonly registry: WorkspaceRegistryLike
  readonly workspaces: readonly RegisteredWorkspace[]
  readonly workspace: RegisteredWorkspace
}

interface PendingWorkspaceAttachment {
  readonly workspaceId: string
  readonly workspacePath: string
}

type ProjectSwitchMaintenanceResult = {
  readonly kind: 'committed'
  readonly workspace: RegisteredWorkspace
  readonly previousSessionId: string
  readonly previousHandle: AgentHandle
} | {
  readonly kind: 'busy' | 'history-failed' | 'unavailable' | 'unknown' | 'missing' | 'failed'
}

type CurrentProjectMutationResult = 'recorded' | 'busy' | 'failed'

type ModelSwitchMaintenanceResult = 'committed' | 'already-current' | 'busy' | 'unavailable' | 'failed'

type ResetMaintenanceResult = {
  readonly kind: 'committed'
  readonly previousSessionId: string
  readonly previousHandle: AgentHandle
} | {
  readonly kind: 'failed'
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
  readonly replyToMessageId: string
  readonly sessionBaseId: string
  readonly mutationHash?: string
  readonly replyInThread?: true
}

interface PendingMessageRoute {
  readonly sessionId: string
  readonly route: MessageRoute
}

interface TurnState {
  readonly route: MessageRoute
  readonly tools: ToolCardItem[]
  readonly toolIndexes: Map<string, number>
  readonly startedAt: number
  status: TurnCardStatus
  answer?: string
  fullAnswer?: string
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
  longAnswerSent?: boolean
  textFallbackSent?: boolean
  streamTimer?: ReturnType<typeof setTimeout>
  lastStreamUpdateAt?: number
}

interface PendingApproval {
  settle: (outcome: ApprovalOutcome, messageId?: string) => Promise<void>
  readonly sessionId: string
  readonly baseId: string
  readonly chatId: string
  readonly openId: string
}

interface PendingStop {
  readonly sessionId: string
  readonly baseId: string
  readonly chatId: string
  readonly openId: string
  stopping: boolean
}

const SESSION_RESET_SEPARATOR = ':'
const GROUP_SESSION_SCOPE_VERSION = 'group-v1'
const RECENT_INBOUND_LIMIT = 1024
const RESET_SESSION_SUFFIX = /^(\d+)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INBOUND_MUTATION_HASH_DOMAIN = 'dsh-plugin-lark/conversation-mutation/v1'
const BRIDGE_COMMANDS = new Set(['start', 'help', 'new', 'clear', 'project', 'model'])
const UNSUPPORTED_RUNTIME_COMMANDS = new Set(['feedback', 'export'])
const MODEL_CATALOG_PROVIDER_LIMIT = 32
const MODEL_CATALOG_ENTRY_LIMIT = 128
const MODEL_DISPLAY_FIELD_LIMIT = 120
const MODEL_PROVIDER_ID_LIMIT = 256
const MODEL_ID_LIMIT = 512
const MODEL_CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const MODEL_CONTROL_CHARACTER_TEST_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

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

class BindingConfirmationInterruptedError extends Error {
  constructor(cause?: unknown) {
    super('lark: conversation binding confirmation was interrupted by shutdown', { cause })
    this.name = 'BindingConfirmationInterruptedError'
  }
}

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
  return current === undefined || current === '' ? next : `${current}\n\n${next}`
}

function answerPreview(answer: string): string {
  const runes = [...answer]
  if (runes.length <= CARD_LIMITS.maxAnswerRunes) return answer
  return `${runes.slice(0, CARD_LIMITS.maxAnswerRunes - 1).join('')}…`
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

function modelFailureTag(error: unknown): string {
  if (error instanceof TypeError) return 'invalid-metadata'
  if (error instanceof DOMException && error.name === 'AbortError') return 'aborted'
  return 'adapter-error'
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

function routeDeliveryOptions(route: MessageRoute): LarkDeliveryOptions {
  return {
    replyToMessageId: route.replyToMessageId,
    ...(route.replyInThread === true ? { replyInThread: true } : {}),
  }
}

function inboundCommand(text: string): string | undefined {
  const stripped = text.trim().replace(/^@_user_\d+\s+/, '').trim()
  return stripped.startsWith('/') ? stripped : undefined
}

function hasPlatformId(value: string | undefined): value is string {
  return value !== undefined && value !== ''
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

function conversationBinding(
  baseId: string,
  sessionId: string,
  modelSelection: ConversationModelSelection | null = null,
  mutationHashes: readonly string[] = [],
): ConversationBinding {
  const generation = sessionGeneration(baseId, sessionId)
  if (generation === undefined) {
    throw new TypeError('lark: active session id is outside its conversation lineage')
  }
  return {
    generation,
    suffix: generation === 0
      ? null
      : sessionId.slice(baseId.length + SESSION_RESET_SEPARATOR.length),
    modelSelection: modelSelection === null
      ? null
      : Object.freeze({ provider: modelSelection.provider, model: modelSelection.model }),
    mutationHashes: Object.freeze([...mutationHashes]),
  }
}

function appendMutationHash(
  mutationHashes: readonly string[],
  mutationHash: string | undefined,
): readonly string[] {
  if (mutationHash === undefined) return mutationHashes
  const next = mutationHashes.filter((hash) => hash !== mutationHash)
  next.push(mutationHash)
  return Object.freeze(next.slice(-CONVERSATION_MUTATION_HISTORY_LIMIT))
}

function inboundMutationHash(chatId: string, messageId: string): string | undefined {
  if (messageId === '') return undefined
  return createHash('sha256')
    .update(INBOUND_MUTATION_HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(chatId, 'utf8')))
    .update(':')
    .update(chatId, 'utf8')
    .update(String(Buffer.byteLength(messageId, 'utf8')))
    .update(':')
    .update(messageId, 'utf8')
    .digest('hex')
}

function boundSessionId(baseId: string, binding: ConversationBinding): ReturnType<typeof SessionId> {
  const sessionId = binding.suffix === null
    ? baseId
    : `${baseId}${SESSION_RESET_SEPARATOR}${binding.suffix}`
  if (sessionGeneration(baseId, sessionId) !== binding.generation) {
    throw new TypeError('lark: persisted conversation binding is invalid')
  }
  return SessionId(sessionId)
}

function sameConversationBinding(left: ConversationBinding | undefined, right: ConversationBinding): boolean {
  return left?.generation === right.generation
    && left.suffix === right.suffix
    && left.modelSelection?.provider === right.modelSelection?.provider
    && left.modelSelection?.model === right.modelSelection?.model
    && left.mutationHashes.length === right.mutationHashes.length
    && left.mutationHashes.every((hash, index) => hash === right.mutationHashes[index])
}

function sameModelSelection(
  left: ConversationModelSelection | null | undefined,
  right: ConversationModelSelection | null | undefined,
): boolean {
  return left?.provider === right?.provider && left?.model === right?.model
}

function validModelIdentifier(value: string, maxLength: number): boolean {
  return value !== ''
    && value.length <= maxLength
    && value.trim() === value
    && value.isWellFormed()
    && !MODEL_CONTROL_CHARACTER_TEST_PATTERN.test(value)
}

function modelSelectionFromConfig(
  config: Pick<LlmCallConfig, 'provider' | 'model'> | undefined,
): ConversationModelSelection | undefined {
  if (config === undefined
    || !validModelIdentifier(config.provider, MODEL_PROVIDER_ID_LIMIT)
    || !validModelIdentifier(config.model, MODEL_ID_LIMIT)) return undefined
  return Object.freeze({ provider: config.provider, model: config.model })
}

function safeModelDisplay(value: string, fallback: string): { readonly text: string; readonly truncated: boolean } {
  const normalized = value.replace(MODEL_CONTROL_CHARACTER_PATTERN, ' ').replace(/\s+/gu, ' ').trim()
  const source = normalized === '' ? fallback : normalized
  const runes = [...source]
  if (runes.length <= MODEL_DISPLAY_FIELD_LIMIT) return { text: source, truncated: false }
  return { text: `${runes.slice(0, MODEL_DISPLAY_FIELD_LIMIT - 1).join('')}…`, truncated: true }
}

function modelTarget(input: string): ConversationModelSelection | undefined {
  const match = /^(\S+)\s+(.+)$/u.exec(input.trim())
  if (match === null) return undefined
  const provider = match[1]
  const model = match[2]?.trim()
  if (provider === undefined || model === undefined || model === '') return undefined
  return { provider, model }
}

function bindingReadBackAfterError(
  store: ConversationBindingStore,
  baseId: string,
  binding: ConversationBinding,
  writeError: unknown,
): { readonly confirmed: true } | { readonly confirmed: false; readonly error: unknown } {
  try {
    if (sameConversationBinding(store.read(baseId), binding)) return { confirmed: true }
    return { confirmed: false, error: writeError }
  } catch (readError) {
    return {
      confirmed: false,
      error: new AggregateError(
        [writeError, readError],
        'conversation binding write and read-back failed',
      ),
    }
  }
}

function optionalAgentPreset(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function selectedAgentPreset(
  headerPreset: string | undefined,
  events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'agent-preset/selected') continue
    const data = event.data
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new TypeError('lark: persisted agent preset selection is invalid')
    }
    const preset = optionalAgentPreset((data as { agentPreset?: unknown }).agentPreset)
    if (preset === undefined) throw new TypeError('lark: persisted agent preset selection is invalid')
    return preset
  }
  return optionalAgentPreset(headerPreset)
}

function activeSessionComposition(session: Session): {
  readonly cwd?: string
  readonly agentPreset?: string
} {
  const candidate = session as unknown as {
    readonly header?: { readonly cwd?: unknown; readonly agentPreset?: unknown }
    readonly events?: unknown
  }
  const cwd = candidate.header?.cwd
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) {
    throw new TypeError('lark: active session cwd is invalid')
  }
  const events = candidate.events === undefined
    ? []
    : candidate.events
  if (!Array.isArray(events)) throw new TypeError('lark: active session events are invalid')
  const agentPreset = selectedAgentPreset(
    optionalAgentPreset(candidate.header?.agentPreset),
    events as ReadonlyArray<{ readonly type: string; readonly data: unknown }>,
  )
  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
  }
}

function agentPresetsOf(ctx: Context): AgentPresetsLike | undefined {
  const service = ctx.get('agentPresets') as unknown
  if (service === undefined) return undefined
  if (service === null || typeof service !== 'object') {
    throw new TypeError('lark: agentPresets service is invalid')
  }
  const candidate = service as Partial<AgentPresetsLike>
  if (typeof candidate.resolve !== 'function' || typeof candidate.mount !== 'function') {
    throw new TypeError('lark: agentPresets service is invalid')
  }
  return candidate as AgentPresetsLike
}

function sessionPersistenceOf(ctx: Context): SessionPersistenceLike | undefined {
  const service = ctx.get('sessionPersistence') as unknown
  if (service === undefined) return undefined
  if (service === null || typeof service !== 'object') {
    throw new TypeError('lark: sessionPersistence service is invalid')
  }
  const candidate = service as Partial<SessionPersistenceLike>
  if (typeof candidate.list !== 'function'
    || (candidate.inspect !== undefined && typeof candidate.inspect !== 'function')) {
    throw new TypeError('lark: sessionPersistence service is invalid')
  }
  return candidate as SessionPersistenceLike
}

function conversationBindingsOf(ctx: Context): ConversationBindingStore | undefined {
  if (typeof ctx.get !== 'function') return undefined
  const service = ctx.get('larkConversationBindings') as unknown
  if (service === undefined) return undefined
  if (service === null || typeof service !== 'object') {
    throw new TypeError('lark: conversation binding service is invalid')
  }
  const candidate = service as Partial<ConversationBindingStore>
  if (typeof candidate.read !== 'function'
    || typeof candidate.put !== 'function'
    || typeof candidate.close !== 'function') {
    throw new TypeError('lark: conversation binding service is invalid')
  }
  return candidate as ConversationBindingStore
}

function llmRuntimeOf(ctx: Context): LlmRuntimeLike | undefined {
  const service = ctx.get('llm') as unknown
  if (service === undefined) return undefined
  if (service === null || typeof service !== 'object') {
    throw new TypeError('lark: llm service is invalid')
  }
  const candidate = service as Partial<LlmRuntimeLike>
  if (typeof candidate.listProviders !== 'function'
    || typeof candidate.listModels !== 'function'
    || typeof candidate.resolveCallConfig !== 'function') {
    throw new TypeError('lark: llm service is invalid')
  }
  return candidate as LlmRuntimeLike
}

function listedProvider(value: unknown): LlmProviderInfoLike {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('lark: llm provider catalog is invalid')
  }
  const candidate = value as Partial<LlmProviderInfoLike>
  if (typeof candidate.id !== 'string' || candidate.id === '' || !candidate.id.isWellFormed()
    || typeof candidate.name !== 'string' || !candidate.name.isWellFormed()) {
    throw new TypeError('lark: llm provider catalog is invalid')
  }
  return candidate as LlmProviderInfoLike
}

function listedModel(value: unknown, provider: string): LlmModelInfoLike {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('lark: llm model catalog is invalid')
  }
  const candidate = value as Partial<LlmModelInfoLike>
  if (candidate.provider !== provider
    || typeof candidate.id !== 'string' || candidate.id === '' || !candidate.id.isWellFormed()
    || typeof candidate.name !== 'string' || !candidate.name.isWellFormed()) {
    throw new TypeError('lark: llm model catalog is invalid')
  }
  return candidate as LlmModelInfoLike
}

function registeredWorkspace(value: unknown): RegisteredWorkspace {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('lark: workspaceRegistry returned an invalid workspace')
  }
  const candidate = value as Partial<RegisteredWorkspace>
  if (typeof candidate.id !== 'string'
    || candidate.id === ''
    || /\s/.test(candidate.id)
    || typeof candidate.path !== 'string'
    || !isAbsolute(candidate.path)
    || typeof candidate.title !== 'string'
    || typeof candidate.status !== 'function'
    || typeof candidate.attachSession !== 'function'
    || (candidate.sessionIds !== undefined
      && (!Array.isArray(candidate.sessionIds)
        || candidate.sessionIds.some((sessionId) => typeof sessionId !== 'string')))) {
    throw new TypeError('lark: workspaceRegistry returned an invalid workspace')
  }
  return candidate as RegisteredWorkspace
}

function workspaceRegistryOf(ctx: Context): WorkspaceRegistryLike | undefined {
  const service = ctx.get('workspaceRegistry') as unknown
  if (service === undefined) return undefined
  if (service === null || typeof service !== 'object') {
    throw new TypeError('lark: workspaceRegistry service is invalid')
  }
  const candidate = service as Partial<WorkspaceRegistryLike>
  if (typeof candidate.list !== 'function'
    || typeof candidate.get !== 'function'
    || (candidate.resolveByPath !== undefined && typeof candidate.resolveByPath !== 'function')) {
    throw new TypeError('lark: workspaceRegistry service is invalid')
  }
  return candidate as WorkspaceRegistryLike
}

function listedWorkspaces(registry: WorkspaceRegistryLike): RegisteredWorkspace[] {
  const listed = registry.list()
  if (!Array.isArray(listed)) {
    throw new TypeError('lark: workspaceRegistry.list returned an invalid value')
  }
  const ids = new Set<string>()
  return listed.map((value) => {
    const workspace = registeredWorkspace(value)
    if (ids.has(workspace.id)) {
      throw new TypeError('lark: workspaceRegistry.list returned a duplicate id')
    }
    ids.add(workspace.id)
    return workspace
  })
}

function latestSessionBinding(
  baseId: string,
  headers: ReadonlyArray<{
    id: ReturnType<typeof SessionId>
    agentPreset?: string
  }>,
): SessionBinding | undefined {
  let latest: SessionBinding | undefined
  for (const header of headers) {
    const sessionId = String(header.id)
    const generation = sessionGeneration(baseId, sessionId)
    if (generation === undefined || generation <= (latest?.generation ?? -1)) continue
    const agentPreset = optionalAgentPreset(header.agentPreset)
    latest = {
      sessionId: SessionId(sessionId),
      persisted: true,
      generation,
      modelSelection: null,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    }
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
  private readonly maxConversationHandles: number
  private readonly cwd: string
  private readonly conversations = new Map<string, ConversationSession>()
  private readonly conversationOpenings = new Map<string, Promise<ConversationSession>>()
  private readonly conversationLeases = new Map<string, number>()
  private readonly conversationLru = new Map<string, ConversationSession>()
  private readonly conversationEvictions = new Map<string, Promise<void>>()
  private readonly conversationIdleWatchers = new Map<string, Promise<void>>()
  private readonly handles = new Map<string, Promise<AgentHandle>>()
  private readonly modelSelections = new WeakMap<Agent, ModelSelectionRef>()
  private readonly handleRetirements = new Set<Promise<void>>()
  private readonly messageRoutes = new Map<string, PendingMessageRoute>()
  private readonly turnStarts = new Map<string, Map<number, number>>()
  private readonly turns = new Map<string, Map<number, TurnState>>()
  private readonly activeRoutes = new Map<string, MessageRoute>()
  private readonly contextWindows = new Map<string, number>()
  private readonly pending = new Map<string, PendingApproval>()
  private readonly pendingStops = new Map<string, PendingStop>()
  private readonly deliveryTasks = new Set<Promise<void>>()
  private readonly warnedEventTypes = new Set<string>()
  private readonly inboundTasks = new Map<string, Promise<void>>()
  private readonly activeInboundTasks = new Set<Promise<void>>()
  private readonly completedInboundKeys: string[] = []
  private readonly inboundDeduplicator: InboundDeduplicator | undefined
  private readonly conversationBindings: ConversationBindingStore | undefined
  private readonly sessionOperations = new Map<string, Promise<void>>()
  private readonly conversationBarriers = new Map<string, Promise<void>>()
  private readonly pendingWorkspaceAttachments = new Map<string, PendingWorkspaceAttachment>()
  private readonly workspaceAttachmentTasks = new Map<string, Promise<void>>()
  private readonly workspaceAttachmentRetries = new Set<string>()
  private readonly lastSessionGenerations = new Map<string, number>()
  private disposeEvents: (() => void) | undefined
  private disposeInboxClaimed: (() => void) | undefined
  private disposeInboxDiscarded: (() => void) | undefined
  private disposeApproval: (() => void) | undefined
  private approvalWaterfallBound = false
  private startPromise: Promise<void> | undefined
  private stopPromise: Promise<void> | undefined
  private conversationEvictionWorker: Promise<void> | undefined
  private clientStarted = false
  private stopping = false
  private conversationEvictionRequested = false
  private conversationAccessSequence = 0
  private bindingRecoveryRequired = false
  private commandAbort = new AbortController()

  constructor(ctx: Context, options: LarkBridgeOptions) {
    this.ctx = ctx
    this.client = options.client
    this.inboundDeduplicator = options.inboundDeduplicator
    this.conversationBindings = options.conversationBindings ?? conversationBindingsOf(ctx)
    this.locale = options.locale ?? DEFAULT_CONFIG.locale
    this.text = localeCopy(this.locale).bridge
    this.allowFrom = new Set((options.allowFrom ?? []).map((openId) => openId.trim()).filter(Boolean))
    this.allowAllUsers = options.allowAllUsers ?? DEFAULT_CONFIG.allowAllUsers
    const defaultSessionId = (options.defaultSessionId ?? '').trim()
    this.sharedSessionBaseId = defaultSessionId === '' ? undefined : defaultSessionId
    this.provider = options.provider ?? DEFAULT_CONFIG.provider
    this.model = options.model ?? DEFAULT_CONFIG.model
    if (!validModelIdentifier(this.provider, MODEL_PROVIDER_ID_LIMIT)) {
      throw new TypeError('lark: provider must be a bounded, trimmed model route id')
    }
    if (!validModelIdentifier(this.model, MODEL_ID_LIMIT)) {
      throw new TypeError('lark: model must be a bounded, trimmed model route id')
    }
    this.streamUpdateIntervalMs = options.streamUpdateIntervalMs ?? DEFAULT_CONFIG.streamUpdateIntervalMs
    if (!Number.isSafeInteger(this.streamUpdateIntervalMs)
      || this.streamUpdateIntervalMs < MIN_STREAM_UPDATE_INTERVAL_MS) {
      throw new RangeError(`lark: streamUpdateIntervalMs must be an integer >= ${MIN_STREAM_UPDATE_INTERVAL_MS}`)
    }
    this.maxConversationHandles = options.maxConversationHandles ?? DEFAULT_CONFIG.maxConversationHandles
    if (!Number.isSafeInteger(this.maxConversationHandles) || this.maxConversationHandles < 0) {
      throw new RangeError('lark: maxConversationHandles must be a non-negative safe integer')
    }
    this.cwd = options.cwd ?? process.cwd()
  }

  start(): Promise<void> {
    if (this.bindingRecoveryRequired) {
      return Promise.reject(new Error(
        'lark: bridge requires a full storage remount after an interrupted binding confirmation',
      ))
    }
    if (this.stopPromise !== undefined) {
      return Promise.reject(new Error('lark: bridge is stopping'))
    }
    if (this.disposeEvents !== undefined) return this.startPromise ?? Promise.resolve()
    this.stopping = false
    this.clientStarted = false
    this.commandAbort = new AbortController()
    this.disposeEvents = this.ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.handleSessionEvent(session, event)
    })
    this.disposeInboxClaimed = this.ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      this.claimMessageRoute(String(agent.id), String(message.id), turn)
    })
    this.disposeInboxDiscarded = this.ctx.on('agent/inbox/discarded', ({ agent, message }) => {
      this.discardMessageRoute(String(agent.id), String(message.id))
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

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise
    let stop: Promise<void>
    stop = this.stopOnce().finally(() => {
      if (this.stopPromise === stop) this.stopPromise = undefined
    })
    this.stopPromise = stop
    return stop
  }

  private async stopOnce(): Promise<void> {
    const failures: unknown[] = []
    this.stopping = true
    this.commandAbort.abort()
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    if (this.disposeInboxClaimed !== undefined) {
      this.disposeInboxClaimed()
      this.disposeInboxClaimed = undefined
    }
    if (this.disposeInboxDiscarded !== undefined) {
      this.disposeInboxDiscarded()
      this.disposeInboxDiscarded = undefined
    }
    if (this.disposeApproval !== undefined) {
      this.disposeApproval()
      this.disposeApproval = undefined
    }
    this.approvalWaterfallBound = false
    for (const pending of this.pending.values()) void pending.settle(APPROVAL_OUTCOME.cancelled)
    this.pending.clear()
    this.pendingStops.clear()
    const start = this.startPromise
    this.startPromise = undefined
    const stopReceiving = this.client.stopReceiving
    if (stopReceiving !== undefined) {
      await collectSettled([
        Promise.resolve().then(() => stopReceiving.call(this.client)),
      ], failures)
    } else if (!this.clientStarted) {
      await collectSettled([Promise.resolve().then(() => this.client.stop())], failures)
    }
    if (start !== undefined) await Promise.allSettled([start])
    const inboundResults = await Promise.allSettled([...this.activeInboundTasks])
    for (const result of inboundResults) {
      if (result.status === 'rejected'
        && !(result.reason instanceof BindingConfirmationInterruptedError)) {
        failures.push(result.reason)
      }
    }
    this.pendingWorkspaceAttachments.clear()
    this.workspaceAttachmentRetries.clear()
    await collectSettled([...this.workspaceAttachmentTasks.values()], failures)
    this.workspaceAttachmentTasks.clear()
    const evictionWorker = this.conversationEvictionWorker
    if (evictionWorker !== undefined) await collectSettled([evictionWorker], failures)
    if (this.conversationEvictionWorker === evictionWorker) {
      this.conversationEvictionWorker = undefined
    }
    this.conversationEvictionRequested = false
    this.clearAllStreamTimers()
    await this.drainDeliveries(failures)
    await collectSettled([Promise.resolve().then(() => this.client.stop())], failures)
    const agents = await collectSettled(this.handles.values(), failures)
    this.conversations.clear()
    this.conversationOpenings.clear()
    this.conversationLeases.clear()
    this.conversationLru.clear()
    this.conversationEvictions.clear()
    this.conversationIdleWatchers.clear()
    this.handles.clear()
    this.inboundTasks.clear()
    this.activeInboundTasks.clear()
    this.conversationBarriers.clear()
    this.completedInboundKeys.length = 0
    this.clearRoutes()
    await collectSettled([...new Set(agents)].map((handle) => handle.dispose()), failures)
    await collectSettled([...this.handleRetirements], failures)
    this.handleRetirements.clear()
    this.conversationAccessSequence = 0
    this.clientStarted = false
    if (failures.length > 0) throw new AggregateError(failures, 'lark: bridge teardown failed')
  }

  async handleInbound(msg: LarkInbound): Promise<void> {
    if (this.stopping) throw new Error('lark: bridge is stopping')
    const key = msg.messageId === '' ? undefined : `${msg.chatId}\0${msg.messageId}`
    if (key !== undefined) {
      const existing = this.inboundTasks.get(key)
      if (existing !== undefined) {
        await existing
        return
      }
      if (this.inboundDeduplicator?.has(key) === true) return
    }
    const task = this.runInboundTask(msg, key)
    if (key !== undefined) this.inboundTasks.set(key, task)
    this.activeInboundTasks.add(task)
    await task
  }

  private runInboundTask(msg: LarkInbound, key: string | undefined): Promise<void> {
    const work = this.handleInboundOnce(msg).then(async () => {
      if (key !== undefined) await this.inboundDeduplicator?.complete(key)
    })
    let task: Promise<void>
    task = work.then(
      () => {
        this.activeInboundTasks.delete(task)
        if (key === undefined) return
        this.completedInboundKeys.push(key)
        if (this.completedInboundKeys.length <= RECENT_INBOUND_LIMIT) return
        const oldest = this.completedInboundKeys.shift()
        if (oldest !== undefined) this.inboundTasks.delete(oldest)
      },
      (error: unknown) => {
        this.activeInboundTasks.delete(task)
        if (key !== undefined && this.inboundTasks.get(key) === task) {
          this.inboundTasks.delete(key)
        }
        throw error
      },
    )
    return task
  }

  private async handleInboundOnce(msg: LarkInbound): Promise<void> {
    const isTextMessage = msg.messageType === undefined || msg.messageType === 'text'
    const command = isTextMessage ? inboundCommand(msg.text) : undefined
    if (msg.chatType === 'group' && !msg.mentioned && command === undefined) return
    const replyInThread = msg.chatType === 'group' && hasPlatformId(msg.threadId)
    const mutationHash = inboundMutationHash(msg.chatId, msg.messageId)
    const route: MessageRoute = {
      chatId: msg.chatId,
      openId: msg.openId,
      replyToMessageId: msg.messageId,
      sessionBaseId: this.sessionBaseId(msg),
      ...(mutationHash === undefined ? {} : { mutationHash }),
      ...(replyInThread ? { replyInThread: true } : {}),
    }
    if (!this.authorized(msg.openId)) {
      await this.safeSend(route.chatId, this.text.denied, routeDeliveryOptions(route))
      return
    }
    if (!isTextMessage) {
      await this.safeSend(route.chatId, this.text.unsupportedInput, routeDeliveryOptions(route))
      return
    }
    if (command !== undefined) {
      await this.handleCommand(route, command)
      return
    }
    await this.enqueueConversationOperation(route.sessionBaseId, () => (
      this.withConversation(route.sessionBaseId, async (conversation) => {
        await this.sessionOperations.get(conversation.baseId)
        this.prepareWorkspaceAttachment(conversation)
        const message = createUserMessage({
          content: [{ type: 'text', text: msg.text.trim() }],
          source: { kind: 'user' },
        })
        this.enqueueMessageRoute(conversation.sessionId, String(message.id), route)
        try {
          conversation.handle.agent.followup(message)
        } catch (error) {
          this.removeMessageRoute(String(message.id), route)
          this.ctx.logger.error('[lark] followup failed: %s', messageOf(error))
          await this.safeSend(route.chatId, this.text.followupFailure, routeDeliveryOptions(route))
          throw error
        }
      })
    ))
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
    const candidate = this.pending.get(requestId)
    if (candidate === undefined) return actionToast('info', this.text.approvalExpired)
    if (candidate.chatId !== action.chatId || candidate.openId !== action.openId) {
      this.ctx.logger.warn('[lark] rejected approval from a different chat or user')
      return actionToast('error', this.text.approvalWrongContext)
    }
    await this.conversationBarriers.get(candidate.baseId)
    const pending = this.pending.get(requestId)
    if (pending !== candidate) return actionToast('info', this.text.approvalExpired)
    const messageId = action.messageId !== '' ? action.messageId : undefined
    await pending.settle(outcome, messageId)
    const content = outcome === APPROVAL_OUTCOME.allowedOnce
      ? this.text.approvalAllowed
      : this.text.approvalRejected
    return actionToast('success', content)
  }

  private async handleStopAction(action: LarkCardAction): Promise<LarkCardActionResult> {
    const requestId = String(action.value.request_id ?? '')
    if (requestId === '') return actionToast('error', this.text.stopUnavailable)
    const candidate = this.pendingStops.get(requestId)
    if (candidate === undefined) return actionToast('info', this.text.stopExpired)
    if (candidate.chatId !== action.chatId || candidate.openId !== action.openId) {
      this.ctx.logger.warn('[lark] rejected stop from a different chat or user')
      return actionToast('error', this.text.stopWrongContext)
    }
    await this.conversationBarriers.get(candidate.baseId)
    const pending = this.pendingStops.get(requestId)
    if (pending !== candidate) return actionToast('info', this.text.stopExpired)
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
      resolved.agent.cancel({ kind: 'user' }, { keepInbox: true })
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
    if (this.stopping) return Promise.resolve(APPROVAL_OUTCOME.unavailable)
    if (this.client.sendCard === undefined) {
      this.ctx.logger.warn('[lark] sendCard missing; skip approval card')
      return next()
    }
    if (this.client.updateCard === undefined) {
      this.ctx.logger.warn('[lark] updateCard missing; skip approval card')
      return next()
    }
    const sendCard = this.client.sendCard
    const requestId = randomUUID()
    const toolName = req.toolName
    const card = renderApprovalCard({ requestId, toolName, reason: req.reason, locale: this.locale })
    return new Promise((resolve) => {
      let settledOutcome: ApprovalOutcome | undefined
      let deliveredMessageId: string | undefined
      let closePromise: Promise<void> | undefined
      const closeCard = (messageId: string, outcome: ApprovalOutcome): Promise<void> => {
        if (closePromise !== undefined) return closePromise
        closePromise = this.updateApprovalCard(messageId, outcome, toolName)
        this.trackDelivery(closePromise)
        return closePromise
      }
      const settle = (outcome: ApprovalOutcome, messageId?: string): Promise<void> => {
        if (settledOutcome === undefined) {
          settledOutcome = outcome
          req.signal?.removeEventListener('abort', onAbort)
          this.pending.delete(requestId)
          resolve(outcome)
        }
        const targetMessageId = messageId ?? deliveredMessageId
        return targetMessageId === undefined
          ? Promise.resolve()
          : closeCard(targetMessageId, settledOutcome)
      }
      const onAbort = (): void => {
        void settle(APPROVAL_OUTCOME.cancelled)
      }
      const pending: PendingApproval = {
        settle,
        sessionId,
        baseId: route.sessionBaseId,
        chatId: route.chatId,
        openId: route.openId,
      }
      this.pending.set(requestId, pending)
      if (req.signal !== undefined) {
        if (req.signal.aborted) {
          onAbort()
          return
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
      }
      let sending: Promise<string | void>
      try {
        sending = Promise.resolve(
          sendCard.call(this.client, route.chatId, card, routeDeliveryOptions(route)),
        )
      } catch (error) {
        this.ctx.logger.error('[lark] approval card send failed: %s', messageOf(error))
        void settle(APPROVAL_OUTCOME.unavailable)
        return
      }
      const delivery = sending.then((messageId) => {
        if (typeof messageId === 'string' && messageId !== '') {
          deliveredMessageId = messageId
          return settledOutcome === undefined
            ? undefined
            : settle(settledOutcome, messageId)
        }
        this.ctx.logger.error('[lark] approval card send failed: missing message id')
        return settle(APPROVAL_OUTCOME.unavailable)
      }).catch((error: unknown) => {
        this.ctx.logger.error('[lark] approval card send failed: %s', messageOf(error))
        return settle(APPROVAL_OUTCOME.unavailable)
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

  private async handleCommand(route: MessageRoute, text: string): Promise<void> {
    const command = text.split(/\s+/)[0] ?? ''
    switch (command) {
      case '/start':
      case '/help':
        await this.enqueueConversationOperation(route.sessionBaseId, () => (
          this.withConversation(route.sessionBaseId, async (conversation) => {
            await this.safeSend(
              route.chatId,
              this.commandHelp(conversation.handle.agent),
              routeDeliveryOptions(route),
            )
          })
        ))
        break
      case '/new':
      case '/clear':
        await this.scheduleReset(route)
        break
      case '/project': {
        const target = text.slice(command.length).trim()
        if (target === '') await this.showProjects(route)
        else await this.scheduleProjectSwitch(route, target)
        break
      }
      case '/model': {
        const target = text.slice(command.length).trim()
        if (target === '') await this.showModels(route)
        else await this.scheduleModelSwitch(route, target)
        break
      }
      default:
        await this.executeRuntimeCommand(route, text, command)
    }
  }

  private showProjects(route: MessageRoute): Promise<void> {
    return this.enqueueConversationOperation(
      route.sessionBaseId,
      () => this.showProjectsNow(route),
    )
  }

  private async showProjectsNow(route: MessageRoute): Promise<void> {
    try {
      const registry = workspaceRegistryOf(this.ctx)
      if (registry === undefined) {
        await this.safeSend(route.chatId, this.text.projectUnavailable, routeDeliveryOptions(route))
        return
      }
      const workspaces = listedWorkspaces(registry)
      await this.withConversation(route.sessionBaseId, async (conversation) => {
        const current = await this.currentWorkspace(conversation, registry, workspaces)
        await this.safeSend(
          route.chatId,
          this.text.projectList(current?.id, workspaces),
          routeDeliveryOptions(route),
        )
      })
    } catch (error) {
      this.ctx.logger.warn('[lark] project listing failed: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.projectUnavailable, routeDeliveryOptions(route))
    }
  }

  private async currentWorkspace(
    conversation: ConversationSession,
    registry: WorkspaceRegistryLike,
    workspaces: readonly RegisteredWorkspace[],
  ): Promise<RegisteredWorkspace | undefined> {
    const activeSessionId = conversation.sessionId
    const activeHandle = conversation.handle
    const cwd = activeHandle.agent.session.header.cwd
    const cached = conversation.workspaceId === undefined
      ? undefined
      : workspaces.find((workspace) => workspace.id === conversation.workspaceId)
    if (cached !== undefined && (
      cached.path === cwd
      || cached.sessionIds?.some((sessionId) => String(sessionId) === activeSessionId) === true
    )) return cached
    conversation.workspaceId = undefined

    const sessionMatches = workspaces.filter((workspace) => (
      workspace.sessionIds?.some((sessionId) => String(sessionId) === activeSessionId) === true
    ))
    if (sessionMatches.length === 1) {
      conversation.workspaceId = sessionMatches[0]?.id
      return sessionMatches[0]
    }

    if (cwd === undefined) return undefined
    const pathMatches = workspaces.filter((workspace) => workspace.path === cwd)
    if (pathMatches.length === 1) {
      conversation.workspaceId = pathMatches[0]?.id
      return pathMatches[0]
    }
    if (registry.resolveByPath === undefined) return undefined
    try {
      const resolved = await registry.resolveByPath(cwd)
      if (resolved === undefined) return undefined
      const workspace = registeredWorkspace(resolved)
      const listed = workspaces.find((candidate) => (
        candidate.id === workspace.id && candidate.path === workspace.path
      ))
      if (conversation.sessionId !== activeSessionId || conversation.handle !== activeHandle) return undefined
      if (listed !== undefined) conversation.workspaceId = listed.id
      return listed
    } catch (error) {
      this.ctx.logger.warn('[lark] current project resolution failed: %s', messageOf(error))
      return undefined
    }
  }

  private scheduleProjectSwitch(route: MessageRoute, target: string): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, async () => {
      if (route.mutationHash !== undefined
        && this.conversationBindings?.read(route.sessionBaseId)?.mutationHashes.includes(
          route.mutationHash,
        )) {
        await this.withConversation(route.sessionBaseId, async () => {
          await this.safeSend(
            route.chatId,
            this.text.projectMutationReplayed,
            routeDeliveryOptions(route),
          )
        })
        return
      }
      const selection = await this.resolveProjectSelection(route, target)
      if (selection === undefined) return
      await this.withConversation(route.sessionBaseId, async (conversation) => {
        await this.sessionOperations.get(conversation.baseId)
        await this.switchProject(route, conversation, selection)
      })
    })
  }

  private async resolveProjectSelection(
    route: MessageRoute,
    target: string,
  ): Promise<ProjectSelection | undefined> {
    const deliveryOptions = routeDeliveryOptions(route)
    let registry: WorkspaceRegistryLike | undefined
    let workspaces: RegisteredWorkspace[]
    try {
      registry = workspaceRegistryOf(this.ctx)
      if (registry === undefined) {
        await this.safeSend(route.chatId, this.text.projectUnavailable, deliveryOptions)
        return
      }
      if (sessionPersistenceOf(this.ctx) === undefined || this.conversationBindings === undefined) {
        await this.safeSend(route.chatId, this.text.projectUnavailable, deliveryOptions)
        return
      }
      workspaces = listedWorkspaces(registry)
    } catch (error) {
      this.ctx.logger.warn('[lark] project registry lookup failed: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.projectUnavailable, deliveryOptions)
      return
    }

    const idMatch = workspaces.find((workspace) => workspace.id === target)
    const titleMatches = idMatch === undefined
      ? workspaces.filter((workspace) => workspace.title === target)
      : []
    if (idMatch === undefined && titleMatches.length === 0) {
      await this.safeSend(route.chatId, this.text.projectUnknown, deliveryOptions)
      return
    }
    if (idMatch === undefined && titleMatches.length > 1) {
      await this.safeSend(route.chatId, this.text.projectAmbiguous, deliveryOptions)
      return
    }
    const selected = idMatch ?? titleMatches[0]
    if (selected === undefined) {
      await this.safeSend(route.chatId, this.text.projectUnknown, deliveryOptions)
      return
    }

    try {
      if (await selected.status() !== 'ok') {
        await this.safeSend(route.chatId, this.text.projectMissingDirectory(selected), deliveryOptions)
        return
      }
      const resolved = registry.get(selected.id)
      if (resolved === undefined) {
        await this.safeSend(route.chatId, this.text.projectUnknown, deliveryOptions)
        return
      }
      const workspace = registeredWorkspace(resolved)
      if (workspace.id !== selected.id || workspace.path !== selected.path) {
        await this.safeSend(route.chatId, this.text.projectUnavailable, deliveryOptions)
        return
      }
      return { registry, workspaces, workspace }
    } catch (error) {
      this.ctx.logger.warn('[lark] project validation failed: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.projectSwitchFailed, deliveryOptions)
      return
    }
  }

  private async switchProject(
    route: MessageRoute,
    conversation: ConversationSession,
    selection: ProjectSelection,
  ): Promise<void> {
    const deliveryOptions = routeDeliveryOptions(route)
    const { registry, workspaces, workspace: selected } = selection

    const current = await this.currentWorkspace(conversation, registry, workspaces)
    if (current?.id === selected.id) {
      const mutation = await this.recordCurrentProjectMutation(route, conversation)
      if (mutation === 'busy') {
        await this.safeSend(route.chatId, this.text.projectBusy, deliveryOptions)
        return
      }
      if (mutation === 'failed') {
        await this.safeSend(route.chatId, this.text.projectHistoryCheckpointFailed, deliveryOptions)
        return
      }
      await this.safeSend(route.chatId, this.text.projectAlreadyCurrent(selected), deliveryOptions)
      return
    }
    const previousSessionId = conversation.sessionId
    const previousHandle = conversation.handle
    const baseId = conversation.baseId
    let maintenance: Promise<ProjectSwitchMaintenanceResult>
    try {
      maintenance = previousHandle.agent.runMaintenance(async (signal) => {
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'busy' }
        try {
          if (sessionPersistenceOf(this.ctx) === undefined || this.conversationBindings === undefined) {
            return { kind: 'unavailable' }
          }
          const durable = await this.ctx.sessions.flush(previousHandle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
          await this.putConversationBinding(
            baseId,
            this.currentConversationBinding(baseId, previousSessionId, conversation.modelSelection),
          )
        } catch (error) {
          if (error instanceof BindingConfirmationInterruptedError) throw error
          this.ctx.logger.error('[lark] previous project session checkpoint failed: %s', messageOf(error))
          return { kind: 'history-failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'busy' }

        let workspace: RegisteredWorkspace
        try {
          if (sessionPersistenceOf(this.ctx) === undefined) return { kind: 'unavailable' }
          const resolved = registry.get(selected.id)
          if (resolved === undefined) return { kind: 'unknown' }
          workspace = registeredWorkspace(resolved)
          if (workspace.id !== selected.id || workspace.path !== selected.path) {
            return { kind: 'unavailable' }
          }
          if (await workspace.status() !== 'ok') return { kind: 'missing' }
        } catch (error) {
          this.ctx.logger.warn('[lark] project revalidation failed: %s', messageOf(error))
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'busy' }

        let sessionId: ReturnType<typeof SessionId>
        let handle: AgentHandle
        let modelSelectionRef: ModelSelectionRef
        try {
          const { agentPreset } = activeSessionComposition(previousHandle.agent.session)
          const generation = Math.max(Date.now(), (this.lastSessionGenerations.get(baseId) ?? 0) + 1)
          this.lastSessionGenerations.set(baseId, generation)
          sessionId = SessionId(`${baseId}${SESSION_RESET_SEPARATOR}${generation}-${randomUUID()}`)
          handle = await this.ensureHandle(
            sessionId,
            false,
            false,
            agentPreset,
            selected.path,
            conversation.modelSelection,
          )
          modelSelectionRef = this.modelSelectionFor(handle)
        } catch (error) {
          this.ctx.logger.error('[lark] project session creation failed: %s', messageOf(error))
          return { kind: 'failed' }
        }

        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.abandonFreshHandle(String(sessionId), handle)
          return { kind: 'busy' }
        }
        try {
          this.materializeFreshHandle(handle)
          const durable = await this.ctx.sessions.flush(handle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
        } catch (error) {
          this.ctx.logger.error('[lark] project session checkpoint failed: %s', messageOf(error))
          await this.abandonFreshHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.abandonFreshHandle(String(sessionId), handle)
          return { kind: 'busy' }
        }
        try {
          await this.putConversationBinding(
            baseId,
            this.mutatedConversationBinding(
              baseId,
              String(sessionId),
              conversation.modelSelection,
              route.mutationHash,
            ),
          )
        } catch (error) {
          this.ctx.logger.error('[lark] project binding commit failed: %s', messageOf(error))
          await this.abandonFreshHandle(String(sessionId), handle)
          if (error instanceof BindingConfirmationInterruptedError) throw error
          return { kind: 'failed' }
        }

        conversation.handle = handle
        conversation.sessionId = String(sessionId)
        conversation.modelSelectionRef = modelSelectionRef
        conversation.workspaceId = workspace.id
        this.deferWorkspaceAttachment(String(sessionId), workspace.id, workspace.path)
        this.clearSessionState(previousSessionId)
        return {
          kind: 'committed',
          workspace,
          previousSessionId,
          previousHandle,
        }
      })
    } catch {
      await this.safeSend(route.chatId, this.text.projectBusy, deliveryOptions)
      return
    }

    let result: ProjectSwitchMaintenanceResult
    try {
      result = await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.error('[lark] project switch maintenance failed: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.projectSwitchFailed, deliveryOptions)
      return
    }
    switch (result.kind) {
      case 'committed':
        this.retireHandleAfterIdle(result.previousSessionId, result.previousHandle, 'project')
        await this.safeSend(route.chatId, this.text.projectSwitched(result.workspace), deliveryOptions)
        return
      case 'busy':
        await this.safeSend(route.chatId, this.text.projectBusy, deliveryOptions)
        return
      case 'history-failed':
        await this.safeSend(route.chatId, this.text.projectHistoryCheckpointFailed, deliveryOptions)
        return
      case 'unavailable':
        await this.safeSend(route.chatId, this.text.projectUnavailable, deliveryOptions)
        return
      case 'unknown':
        await this.safeSend(route.chatId, this.text.projectUnknown, deliveryOptions)
        return
      case 'missing':
        await this.safeSend(route.chatId, this.text.projectMissingDirectory(selected), deliveryOptions)
        return
      case 'failed':
        await this.safeSend(route.chatId, this.text.projectSwitchFailed, deliveryOptions)
    }
  }

  private async recordCurrentProjectMutation(
    route: MessageRoute,
    conversation: ConversationSession,
  ): Promise<CurrentProjectMutationResult> {
    if (route.mutationHash === undefined) return 'recorded'
    const store = this.conversationBindings
    if (store === undefined) return 'failed'
    try {
      const committed = store.read(conversation.baseId)
      if (committed !== undefined) {
        if (String(boundSessionId(conversation.baseId, committed)) !== conversation.sessionId) {
          this.ctx.logger.error('[lark] current project binding does not match the live conversation')
          return 'failed'
        }
        await this.putConversationBinding(
          conversation.baseId,
          this.mutatedConversationBinding(
            conversation.baseId,
            conversation.sessionId,
            conversation.modelSelection,
            route.mutationHash,
          ),
        )
        return 'recorded'
      }
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.error('[lark] current project mutation lookup failed: %s', messageOf(error))
      return 'failed'
    }

    let maintenance: Promise<CurrentProjectMutationResult>
    try {
      maintenance = conversation.handle.agent.runMaintenance(async (signal) => {
        if (signal.aborted || conversation.handle.agent.inbox.hasPending) return 'busy'
        try {
          if (sessionPersistenceOf(this.ctx) === undefined) return 'failed'
          const durable = await this.ctx.sessions.flush(conversation.handle.agent.session)
          if (durable !== true) return 'failed'
          if (signal.aborted || conversation.handle.agent.inbox.hasPending) return 'busy'
          await this.putConversationBinding(
            conversation.baseId,
            this.mutatedConversationBinding(
              conversation.baseId,
              conversation.sessionId,
              conversation.modelSelection,
              route.mutationHash,
            ),
          )
          return 'recorded'
        } catch (error) {
          if (error instanceof BindingConfirmationInterruptedError) throw error
          this.ctx.logger.error('[lark] current project mutation checkpoint failed: %s', messageOf(error))
          return 'failed'
        }
      })
    } catch {
      return 'busy'
    }
    try {
      return await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.error('[lark] current project mutation maintenance failed: %s', messageOf(error))
      return 'failed'
    }
  }

  private showModels(route: MessageRoute): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, () => (
      this.withConversation(route.sessionBaseId, async (conversation) => {
        const deliveryOptions = routeDeliveryOptions(route)
        try {
          const llm = llmRuntimeOf(this.ctx)
          if (llm === undefined) {
            await this.safeSend(route.chatId, this.text.modelUnavailable, deliveryOptions)
            return
          }
          const catalog = await this.modelCatalog(llm)
          await this.safeSend(
            route.chatId,
            this.text.modelList(
              conversation.modelSelection,
              catalog.groups,
              catalog.providerIds.has(conversation.modelSelection.provider),
              catalog.partial,
              catalog.truncated,
            ),
            deliveryOptions,
          )
        } catch (error) {
          this.ctx.logger.warn('[lark] model catalog failed (%s)', modelFailureTag(error))
          await this.safeSend(route.chatId, this.text.modelUnavailable, deliveryOptions)
        }
      })
    ))
  }

  private async modelCatalog(llm: LlmRuntimeLike): Promise<ModelCatalog> {
    const rawProviders = llm.listProviders()
    if (!Array.isArray(rawProviders)) throw new TypeError('lark: llm provider catalog is invalid')
    const providers = rawProviders.map(listedProvider)
    const providerIds = new Set<string>()
    for (const provider of providers) {
      if (providerIds.has(provider.id)) throw new TypeError('lark: llm provider catalog contains duplicate ids')
      providerIds.add(provider.id)
    }

    let truncated = providers.length > MODEL_CATALOG_PROVIDER_LIMIT
    const visibleProviders = providers.slice(0, MODEL_CATALOG_PROVIDER_LIMIT)
    const loaded = await Promise.all(visibleProviders.map(async (provider) => {
      try {
        const rawModels = await llm.listModels(provider.id)
        if (!Array.isArray(rawModels)) throw new TypeError('lark: llm model catalog is invalid')
        const models = rawModels.slice(0, MODEL_CATALOG_ENTRY_LIMIT)
          .map((model) => listedModel(model, provider.id))
        return { provider, models, truncated: models.length < rawModels.length }
      } catch (error) {
        this.ctx.logger.warn(
          '[lark] model catalog provider "%s" failed (%s)',
          safeModelDisplay(provider.id, 'provider').text,
          modelFailureTag(error),
        )
        return { provider, failure: true as const }
      }
    }))

    let remaining = MODEL_CATALOG_ENTRY_LIMIT
    let partial = false
    const groups: ListedModelGroup[] = []
    for (const entry of loaded) {
      if ('failure' in entry) {
        partial = true
        continue
      }
      truncated ||= entry.truncated
      if (entry.models.length === 0) continue
      if (remaining === 0) {
        truncated = true
        continue
      }
      const providerId = safeModelDisplay(entry.provider.id, 'provider')
      const providerName = safeModelDisplay(entry.provider.name, providerId.text)
      truncated ||= providerId.truncated || providerName.truncated
      const visibleModels = entry.models.slice(0, remaining).map((model) => {
        const modelId = safeModelDisplay(model.id, 'model')
        const modelName = safeModelDisplay(model.name, modelId.text)
        truncated ||= modelId.truncated || modelName.truncated
        return {
          provider: model.provider,
          id: model.id,
          displayId: modelId.text,
          name: modelName.text,
        }
      })
      if (visibleModels.length < entry.models.length) truncated = true
      remaining -= visibleModels.length
      groups.push({
        id: entry.provider.id,
        displayId: providerId.text,
        name: providerName.text,
        models: visibleModels,
      })
    }
    return {
      groups: Object.freeze(groups),
      providerIds,
      partial,
      truncated,
    }
  }

  private scheduleModelSwitch(route: MessageRoute, input: string): Promise<void> {
    return this.enqueueConversationBarrier(route.sessionBaseId, async () => {
      const deliveryOptions = routeDeliveryOptions(route)
      const requested = modelTarget(input)
      if (requested === undefined) {
        await this.safeSend(route.chatId, this.text.modelUnknown, deliveryOptions)
        return
      }
      const store = this.conversationBindings
      if (store === undefined || sessionPersistenceOf(this.ctx) === undefined) {
        await this.safeSend(route.chatId, this.text.modelSwitchFailed, deliveryOptions)
        return
      }
      if (route.mutationHash !== undefined
        && store.read(route.sessionBaseId)?.mutationHashes.includes(route.mutationHash)) {
        await this.safeSend(route.chatId, this.text.modelMutationReplayed, deliveryOptions)
        return
      }

      let llm: LlmRuntimeLike
      let selected: ConversationModelSelection
      try {
        const runtime = llmRuntimeOf(this.ctx)
        if (runtime === undefined) {
          await this.safeSend(route.chatId, this.text.modelUnavailable, deliveryOptions)
          return
        }
        llm = runtime
        selected = await this.resolveModelSelection(runtime, requested, this.commandAbort.signal)
      } catch (error) {
        this.ctx.logger.warn('[lark] model selection validation failed (%s)', modelFailureTag(error))
        await this.safeSend(route.chatId, this.text.modelUnknown, deliveryOptions)
        return
      }

      await this.withConversation(route.sessionBaseId, async (conversation) => {
        await this.sessionOperations.get(conversation.baseId)
        await this.switchModel(route, conversation, llm, selected)
      })
    })
  }

  private async resolveModelSelection(
    llm: LlmRuntimeLike,
    requested: ConversationModelSelection,
    signal: AbortSignal,
  ): Promise<ConversationModelSelection> {
    const resolved = await llm.resolveCallConfig({
      provider: requested.provider,
      model: requested.model,
    }, signal)
    const selection = modelSelectionFromConfig(resolved)
    if (selection === undefined) throw new TypeError('lark: resolved model selection is invalid')
    return selection
  }

  private async switchModel(
    route: MessageRoute,
    conversation: ConversationSession,
    llm: LlmRuntimeLike,
    selected: ConversationModelSelection,
  ): Promise<void> {
    const deliveryOptions = routeDeliveryOptions(route)
    const previousHandle = conversation.handle
    const previousSessionId = conversation.sessionId
    const alreadyCurrent = sameModelSelection(conversation.modelSelection, selected)
    let maintenance: Promise<ModelSwitchMaintenanceResult>
    try {
      maintenance = previousHandle.agent.runMaintenance(async (signal) => {
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return 'busy'
        try {
          this.materializeFreshHandle(previousHandle)
          const durable = await this.ctx.sessions.flush(previousHandle.agent.session)
          if (durable !== true) return 'failed'
          const revalidated = await this.resolveModelSelection(llm, selected, signal)
          if (!sameModelSelection(revalidated, selected)) return 'unavailable'
          if (signal.aborted || previousHandle.agent.inbox.hasPending) return 'busy'
          await this.putConversationBinding(
            conversation.baseId,
            this.modelConversationBinding(
              conversation.baseId,
              previousSessionId,
              selected,
              route.mutationHash,
            ),
          )
          conversation.modelSelection = selected
          conversation.modelSelectionRef.current = {
            provider: selected.provider,
            model: selected.model,
          }
          return alreadyCurrent ? 'already-current' : 'committed'
        } catch (error) {
          if (error instanceof BindingConfirmationInterruptedError) throw error
          this.ctx.logger.warn('[lark] model switch checkpoint failed (%s)', modelFailureTag(error))
          return 'failed'
        }
      })
    } catch {
      await this.safeSend(route.chatId, this.text.modelBusy, deliveryOptions)
      return
    }

    let result: ModelSwitchMaintenanceResult
    try {
      result = await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.warn('[lark] model switch maintenance failed (%s)', modelFailureTag(error))
      await this.safeSend(route.chatId, this.text.modelSwitchFailed, deliveryOptions)
      return
    }
    if (result === 'busy') {
      await this.safeSend(route.chatId, this.text.modelBusy, deliveryOptions)
      return
    }
    if (result === 'unavailable') {
      await this.safeSend(route.chatId, this.text.modelUnknown, deliveryOptions)
      return
    }
    if (result === 'failed') {
      await this.safeSend(route.chatId, this.text.modelSwitchFailed, deliveryOptions)
      return
    }
    if (result === 'already-current') {
      await this.safeSend(route.chatId, this.text.modelAlreadyCurrent(selected), deliveryOptions)
      return
    }
    await this.safeSend(route.chatId, this.text.modelSwitched(selected), deliveryOptions)
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

  private executeRuntimeCommand(route: MessageRoute, text: string, command: string): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, async () => {
      await this.enqueueSessionOperation(
        route.sessionBaseId,
        () => this.withConversation(
          route.sessionBaseId,
          (conversation) => this.executeRuntimeCommandNow(conversation, route, text, command),
        ),
      )
    })
  }

  private async executeRuntimeCommandNow(
    conversation: ConversationSession,
    route: MessageRoute,
    text: string,
    command: string,
  ): Promise<void> {
    const deliveryOptions = routeDeliveryOptions(route)
    if (UNSUPPORTED_RUNTIME_COMMANDS.has(command.slice(1).toLowerCase())) {
      await this.safeSend(route.chatId, this.text.unknownCommand(command), deliveryOptions)
      return
    }
    const runtime = this.commandRuntime()
    if (runtime === undefined) {
      await this.safeSend(route.chatId, this.text.unknownCommand(command), deliveryOptions)
      return
    }
    try {
      const execution = await runtime.execute(conversation.handle.agent, text, this.commandAbort.signal)
      if (execution === undefined) {
        await this.safeSend(route.chatId, this.text.unknownCommand(command), deliveryOptions)
      } else if (execution.result.text !== undefined && execution.result.text !== '') {
        await this.safeSend(route.chatId, execution.result.text, deliveryOptions)
      } else if (execution.result.kind === 'error') {
        await this.safeSend(route.chatId, this.text.commandFailed, deliveryOptions)
      }
    } catch (error) {
      this.ctx.logger.error('[lark] command failed: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.commandFailed, deliveryOptions)
    }
  }

  private enqueueSessionOperation<T>(baseId: string, task: () => Promise<T>): Promise<T> {
    this.acquireConversationLease(baseId)
    const operation = (this.sessionOperations.get(baseId) ?? Promise.resolve()).then(async () => {
      try {
        return await task()
      } finally {
        this.releaseConversationLease(baseId)
      }
    })
    const tail = operation.then(() => {}, () => {})
    this.sessionOperations.set(baseId, tail)
    void tail.then(() => {
      if (this.sessionOperations.get(baseId) === tail) this.sessionOperations.delete(baseId)
    })
    return operation
  }

  private enqueueConversationBarrier<T>(baseId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.conversationBarriers.get(baseId)
    let operation: Promise<T>
    if (previous === undefined) {
      try {
        operation = task()
      } catch (error) {
        operation = Promise.reject(error)
      }
    } else {
      operation = previous.then(task)
    }
    const tail = operation.then(() => {}, () => {})
    this.conversationBarriers.set(baseId, tail)
    void tail.then(() => {
      if (this.conversationBarriers.get(baseId) === tail) this.conversationBarriers.delete(baseId)
    })
    return operation
  }

  private enqueueConversationOperation<T>(baseId: string, task: () => Promise<T>): Promise<T> {
    return this.enqueueConversationBarrier(baseId, task)
  }

  private scheduleReset(route: MessageRoute): Promise<void> {
    return this.enqueueConversationBarrier(route.sessionBaseId, () => (
      this.withConversation(route.sessionBaseId, async (conversation) => {
        await this.sessionOperations.get(conversation.baseId)
        await this.resetConversation(route, conversation)
      })
    ))
  }

  private async resetConversation(
    route: MessageRoute,
    conversation: ConversationSession,
  ): Promise<void> {
    if (this.conversationBindings === undefined) {
      await this.safeSend(route.chatId, this.text.freshSessionFailed, routeDeliveryOptions(route))
      return
    }
    if (route.mutationHash !== undefined
      && this.conversationBindings.read(conversation.baseId)?.mutationHashes.includes(route.mutationHash)) {
      await this.safeSend(route.chatId, this.text.freshSession, routeDeliveryOptions(route))
      return
    }
    await this.resetConversationDurably(route, conversation)
  }

  private async resetConversationDurably(
    route: MessageRoute,
    conversation: ConversationSession,
  ): Promise<void> {
    await this.restoreConversationWorkspace(conversation)
    const previousSessionId = conversation.sessionId
    const previousHandle = conversation.handle
    const baseId = conversation.baseId
    let maintenance: Promise<ResetMaintenanceResult>
    try {
      maintenance = previousHandle.agent.runMaintenance(async (signal) => {
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'failed' }
        try {
          if (sessionPersistenceOf(this.ctx) === undefined) throw new Error('session persistence unavailable')
          const durable = await this.ctx.sessions.flush(previousHandle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
          await this.putConversationBinding(
            baseId,
            this.currentConversationBinding(baseId, previousSessionId, conversation.modelSelection),
          )
        } catch (error) {
          if (error instanceof BindingConfirmationInterruptedError) throw error
          this.ctx.logger.error('[lark] previous reset session checkpoint failed: %s', messageOf(error))
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'failed' }

        let sessionId: ReturnType<typeof SessionId>
        let handle: AgentHandle
        let modelSelectionRef: ModelSelectionRef
        try {
          const composition = activeSessionComposition(previousHandle.agent.session)
          const generation = Math.max(Date.now(), (this.lastSessionGenerations.get(baseId) ?? 0) + 1)
          this.lastSessionGenerations.set(baseId, generation)
          sessionId = SessionId(`${baseId}${SESSION_RESET_SEPARATOR}${generation}-${randomUUID()}`)
          handle = await this.ensureHandle(
            sessionId,
            false,
            false,
            composition.agentPreset,
            composition.cwd ?? this.cwd,
            conversation.modelSelection,
          )
          modelSelectionRef = this.modelSelectionFor(handle)
        } catch (error) {
          this.ctx.logger.error('[lark] fresh session creation failed: %s', messageOf(error))
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.abandonFreshHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        try {
          this.materializeFreshHandle(handle)
          const durable = await this.ctx.sessions.flush(handle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
        } catch (error) {
          this.ctx.logger.error('[lark] fresh session checkpoint failed: %s', messageOf(error))
          await this.abandonFreshHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.abandonFreshHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        try {
          await this.putConversationBinding(
            baseId,
            this.mutatedConversationBinding(
              baseId,
              String(sessionId),
              conversation.modelSelection,
              route.mutationHash,
            ),
          )
        } catch (error) {
          this.ctx.logger.error('[lark] fresh session binding commit failed: %s', messageOf(error))
          await this.abandonFreshHandle(String(sessionId), handle)
          if (error instanceof BindingConfirmationInterruptedError) throw error
          return { kind: 'failed' }
        }

        conversation.handle = handle
        conversation.sessionId = String(sessionId)
        conversation.modelSelectionRef = modelSelectionRef
        this.clearSessionState(previousSessionId)
        return {
          kind: 'committed',
          previousSessionId,
          previousHandle,
        }
      })
    } catch (error) {
      this.ctx.logger.warn('[lark] reset could not claim the active session: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.freshSessionFailed, routeDeliveryOptions(route))
      return
    }

    let result: ResetMaintenanceResult
    try {
      result = await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.error('[lark] reset maintenance failed: %s', messageOf(error))
      await this.safeSend(route.chatId, this.text.freshSessionFailed, routeDeliveryOptions(route))
      return
    }
    if (result.kind !== 'committed') {
      await this.safeSend(route.chatId, this.text.freshSessionFailed, routeDeliveryOptions(route))
      return
    }
    this.retireHandleAfterIdle(result.previousSessionId, result.previousHandle, 'reset')
    await this.safeSend(route.chatId, this.text.freshSession, routeDeliveryOptions(route))
  }

  private async restoreConversationWorkspace(conversation: ConversationSession): Promise<void> {
    if (conversation.workspaceId !== undefined) return
    try {
      const registry = workspaceRegistryOf(this.ctx)
      if (registry === undefined) return
      await this.currentWorkspace(conversation, registry, listedWorkspaces(registry))
    } catch (error) {
      this.ctx.logger.warn('[lark] fresh session project resolution failed: %s', messageOf(error))
    }
  }

  private deferWorkspaceAttachment(
    sessionId: string,
    workspaceId: string | undefined,
    workspacePath: string,
  ): void {
    if (workspaceId === undefined) return
    const pending = this.pendingWorkspaceAttachments.get(sessionId)
    if (pending?.workspaceId === workspaceId && pending.workspacePath === workspacePath) return
    this.pendingWorkspaceAttachments.set(sessionId, { workspaceId, workspacePath })
  }

  private prepareWorkspaceAttachment(conversation: ConversationSession): void {
    try {
      const registry = workspaceRegistryOf(this.ctx)
      if (registry === undefined) return
      const workspaces = listedWorkspaces(registry)
      const sessionId = conversation.sessionId
      const cwd = conversation.handle.agent.session.header.cwd
      const cached = conversation.workspaceId === undefined
        ? undefined
        : workspaces.find((workspace) => workspace.id === conversation.workspaceId)
      const sessionMatches = cached === undefined
        ? workspaces.filter((workspace) => (
            workspace.sessionIds?.some((id) => String(id) === sessionId) === true
          ))
        : []
      const pathMatches = cached === undefined && sessionMatches.length !== 1 && cwd !== undefined
        ? workspaces.filter((workspace) => workspace.path === cwd)
        : []
      const workspace = cached
        ?? (sessionMatches.length === 1 ? sessionMatches[0] : undefined)
        ?? (pathMatches.length === 1 ? pathMatches[0] : undefined)
      if (workspace === undefined) return
      conversation.workspaceId = workspace.id
      this.deferWorkspaceAttachment(conversation.sessionId, workspace.id, workspace.path)
    } catch (error) {
      this.ctx.logger.warn('[lark] workspace attachment preparation failed: %s', messageOf(error))
    }
  }

  private scheduleWorkspaceAttachment(session: Session): void {
    if (this.stopping) return
    const sessionId = String(session.id)
    const pending = this.pendingWorkspaceAttachments.get(sessionId)
    if (pending === undefined) return
    if (this.workspaceAttachmentTasks.has(sessionId)) {
      this.workspaceAttachmentRetries.add(sessionId)
      return
    }
    let task: Promise<void>
    task = Promise.resolve().then(() => this.attachWorkspaceSession(session, pending)).finally(() => {
      if (this.workspaceAttachmentTasks.get(sessionId) === task) {
        this.workspaceAttachmentTasks.delete(sessionId)
      }
      const retry = this.workspaceAttachmentRetries.delete(sessionId)
      if (retry && this.pendingWorkspaceAttachments.has(sessionId)) {
        this.scheduleWorkspaceAttachment(session)
      }
      this.requestConversationEviction()
    })
    this.workspaceAttachmentTasks.set(sessionId, task)
  }

  private async attachWorkspaceSession(
    session: Session,
    pending: PendingWorkspaceAttachment,
  ): Promise<void> {
    const sessionId = String(session.id)
    try {
      const durable = await this.ctx.sessions.flush(session)
      if (durable !== true) {
        throw new Error('no durability listener participated')
      }
      if (this.stopping || this.pendingWorkspaceAttachments.get(sessionId) !== pending) return
      const registry = workspaceRegistryOf(this.ctx)
      const resolved = registry?.get(pending.workspaceId)
      if (resolved === undefined) return
      const workspace = registeredWorkspace(resolved)
      if (workspace.id !== pending.workspaceId || workspace.path !== pending.workspacePath) return
      if (await workspace.status() !== 'ok') return
      if (this.stopping || this.pendingWorkspaceAttachments.get(sessionId) !== pending) return
      await workspace.attachSession(session.id)
      if (this.pendingWorkspaceAttachments.get(sessionId) === pending) {
        this.pendingWorkspaceAttachments.delete(sessionId)
      }
    } catch (error) {
      this.ctx.logger.warn(
        '[lark] durable workspace session attachment failed; leaving it unindexed: %s',
        messageOf(error),
      )
    }
  }

  private async withConversation<T>(
    baseId: string,
    task: (conversation: ConversationSession) => Promise<T> | T,
  ): Promise<T> {
    this.acquireConversationLease(baseId)
    try {
      while (true) {
        const eviction = this.conversationEvictions.get(baseId)
        if (eviction !== undefined) {
          await eviction
          continue
        }
        const conversation = await this.ensureConversation(baseId)
        const laterEviction = this.conversationEvictions.get(baseId)
        if (laterEviction !== undefined) {
          await laterEviction
          continue
        }
        if (this.conversations.get(baseId) !== conversation) continue
        this.touchConversation(conversation)
        return await task(conversation)
      }
    } finally {
      this.releaseConversationLease(baseId)
    }
  }

  private acquireConversationLease(baseId: string): void {
    this.conversationLeases.set(baseId, (this.conversationLeases.get(baseId) ?? 0) + 1)
  }

  private releaseConversationLease(baseId: string): void {
    const leases = this.conversationLeases.get(baseId) ?? 0
    if (leases <= 1) this.conversationLeases.delete(baseId)
    else this.conversationLeases.set(baseId, leases - 1)
    this.requestConversationEviction()
  }

  private touchConversation(conversation: ConversationSession): void {
    if (this.conversations.get(conversation.baseId) !== conversation) return
    conversation.lastAccess = ++this.conversationAccessSequence
    this.conversationLru.delete(conversation.baseId)
    this.conversationLru.set(conversation.baseId, conversation)
  }

  private requestConversationEviction(): void {
    if (this.stopping || this.conversations.size <= this.maxConversationHandles) return
    this.conversationEvictionRequested = true
    if (this.conversationEvictionWorker !== undefined) return
    const work = Promise.resolve().then(() => this.runConversationEvictionWorker())
    const worker = work.catch((error: unknown) => {
      this.ctx.logger.error('[lark] conversation eviction worker failed: %s', messageOf(error))
    })
    this.conversationEvictionWorker = worker
    const cleanup = (): void => {
      if (this.conversationEvictionWorker !== worker) return
      this.conversationEvictionWorker = undefined
      if (this.conversationEvictionRequested
        && !this.stopping
        && this.conversations.size > this.maxConversationHandles) {
        this.requestConversationEviction()
      }
    }
    void worker.then(cleanup, cleanup)
  }

  private async runConversationEvictionWorker(): Promise<void> {
    while (this.conversationEvictionRequested
      && !this.stopping
      && this.conversations.size > this.maxConversationHandles) {
      this.conversationEvictionRequested = false
      await this.evictConversationOverflow()
    }
    if (this.stopping || this.conversations.size <= this.maxConversationHandles) {
      this.conversationEvictionRequested = false
    }
  }

  private async evictConversationOverflow(): Promise<void> {
    const candidates = [...this.conversationLru].map(([baseId, conversation]) => ({
      baseId,
      conversation,
      lastAccess: conversation.lastAccess,
    }))
    for (const candidate of candidates) {
      if (this.stopping || this.conversations.size <= this.maxConversationHandles) return
      const result = await this.tryEvictConversation(
        candidate.baseId,
        candidate.conversation,
        candidate.lastAccess,
      )
      if (result === 'not-durable') return
    }
  }

  private async tryEvictConversation(
    baseId: string,
    conversation: ConversationSession,
    lastAccess: number,
  ): Promise<ConversationEvictionResult> {
    if (!this.isConversationEvictionCandidate(baseId, conversation, lastAccess)) return 'retained'
    const gate = Promise.withResolvers<void>()
    this.conversationEvictions.set(baseId, gate.promise)
    try {
      if (!this.isConversationEvictionCandidate(baseId, conversation, lastAccess)) return 'retained'
      return await this.evictConversation(baseId, conversation, lastAccess)
    } finally {
      if (this.conversationEvictions.get(baseId) === gate.promise) {
        this.conversationEvictions.delete(baseId)
      }
      gate.resolve()
    }
  }

  private isConversationEvictionCandidate(
    baseId: string,
    conversation: ConversationSession,
    lastAccess: number,
  ): boolean {
    return !this.stopping
      && this.conversations.get(baseId) === conversation
      && this.conversationLru.get(baseId) === conversation
      && conversation.lastAccess === lastAccess
      && (this.conversationLeases.get(baseId) ?? 0) === 0
      && !this.workspaceAttachmentTasks.has(conversation.sessionId)
      && this.handles.has(conversation.sessionId)
  }

  private async evictConversation(
    baseId: string,
    conversation: ConversationSession,
    lastAccess: number,
  ): Promise<ConversationEvictionResult> {
    let maintenance: Promise<ConversationCheckpointResult>
    try {
      maintenance = conversation.handle.agent.runMaintenance(async (signal) => {
        if (!this.isConversationEvictionCandidate(baseId, conversation, lastAccess)
          || signal.aborted) return 'stale'
        if (conversation.handle.agent.inbox.hasPending) return 'pending'
        if (this.ctx.get('sessionPersistence') === undefined) return 'not-durable'
        const durable = await this.ctx.sessions.flush(conversation.handle.agent.session)
        if (durable !== true) return 'not-durable'
        if (!this.isConversationEvictionCandidate(baseId, conversation, lastAccess)
          || signal.aborted) return 'stale'
        return conversation.handle.agent.inbox.hasPending ? 'pending' : 'ready'
      })
    } catch {
      this.watchConversationIdle(conversation)
      return 'busy'
    }

    let checkpoint: ConversationCheckpointResult
    try {
      checkpoint = await maintenance
    } catch (error) {
      this.ctx.logger.warn(
        '[lark] conversation eviction checkpoint failed; retaining handle: %s',
        messageOf(error),
      )
      return 'not-durable'
    }
    if (checkpoint === 'not-durable') return 'not-durable'
    if (checkpoint !== 'ready') {
      if (checkpoint === 'pending' && conversation.handle.agent.status === 'running') {
        this.watchConversationIdle(conversation)
      }
      return 'retained'
    }
    if (!this.isConversationEvictionCandidate(baseId, conversation, lastAccess)) return 'retained'
    if (conversation.handle.agent.inbox.hasPending) {
      if (conversation.handle.agent.status === 'running') this.watchConversationIdle(conversation)
      return 'retained'
    }
    if (conversation.handle.agent.status !== 'idle') {
      this.watchConversationIdle(conversation)
      return 'busy'
    }

    let disposeError: unknown
    try {
      await conversation.handle.dispose()
    } catch (error) {
      disposeError = error
    }
    this.finalizeConversationEviction(conversation)
    if (disposeError !== undefined) {
      this.ctx.logger.error('[lark] evicted conversation disposal failed: %s', messageOf(disposeError))
    }
    return 'evicted'
  }

  private watchConversationIdle(conversation: ConversationSession): void {
    const baseId = conversation.baseId
    if (this.stopping
      || this.conversations.get(baseId) !== conversation
      || this.conversationIdleWatchers.has(baseId)) return
    let idle: Promise<void>
    try {
      idle = conversation.handle.agent.whenIdle()
    } catch (error) {
      this.ctx.logger.warn('[lark] conversation idle wait failed: %s', messageOf(error))
      return
    }
    this.conversationIdleWatchers.set(baseId, idle)
    const clear = (): boolean => {
      if (this.conversationIdleWatchers.get(baseId) !== idle) return false
      this.conversationIdleWatchers.delete(baseId)
      return true
    }
    void idle.then(
      () => {
        if (clear() && this.conversations.get(baseId) === conversation) {
          this.requestConversationEviction()
        }
      },
      (error: unknown) => {
        if (!clear()) return
        this.ctx.logger.warn('[lark] conversation idle wait failed: %s', messageOf(error))
      },
    )
  }

  private finalizeConversationEviction(conversation: ConversationSession): void {
    const { baseId, sessionId } = conversation
    if (this.conversations.get(baseId) !== conversation) return
    this.conversations.delete(baseId)
    this.conversationOpenings.delete(baseId)
    if (this.conversationLru.get(baseId) === conversation) this.conversationLru.delete(baseId)
    this.conversationIdleWatchers.delete(baseId)
    this.handles.delete(sessionId)
    this.lastSessionGenerations.delete(baseId)
    this.clearSessionState(sessionId)
  }

  private async ensureConversation(baseId: string): Promise<ConversationSession> {
    const existing = this.conversations.get(baseId)
    if (existing !== undefined) return existing
    const pending = this.conversationOpenings.get(baseId)
    if (pending !== undefined) return pending
    const opening = this.openConversation(baseId)
    this.conversationOpenings.set(baseId, opening)
    try {
      return await opening
    } finally {
      if (this.conversationOpenings.get(baseId) === opening) {
        this.conversationOpenings.delete(baseId)
      }
    }
  }

  private async openConversation(baseId: string): Promise<ConversationSession> {
    const binding = await this.resolveSessionBinding(baseId)
    const modelSelection = binding.modelSelection ?? this.defaultModelSelection()
    const handle = await this.ensureHandle(
      binding.sessionId,
      binding.persisted,
      false,
      binding.agentPreset,
      this.cwd,
      modelSelection,
    )
    const sessionId = binding.sessionId
    const modelSelectionRef = this.modelSelectionFor(handle)
    this.lastSessionGenerations.set(
      baseId,
      Math.max(this.lastSessionGenerations.get(baseId) ?? 0, binding.generation),
    )
    const entry: ConversationSession = {
      baseId,
      handle,
      sessionId: String(sessionId),
      modelSelection,
      modelSelectionRef,
      lastAccess: 0,
    }
    this.conversations.set(baseId, entry)
    this.touchConversation(entry)
    return entry
  }

  private sessionBaseId(msg: Pick<
    LarkInbound,
    'chatId' | 'chatType' | 'messageId' | 'rootId' | 'threadId'
  >): string {
    if (this.sharedSessionBaseId !== undefined) return this.sharedSessionBaseId
    if (msg.chatType !== 'group') {
      return `${DEFAULT_CONFIG.sessionPrefix}${SESSION_RESET_SEPARATOR}${msg.chatId}`
    }
    const chatId = encodeURIComponent(msg.chatId)
    if (hasPlatformId(msg.threadId)) {
      return `${DEFAULT_CONFIG.sessionPrefix}:${GROUP_SESSION_SCOPE_VERSION}:${chatId}:thread:${encodeURIComponent(msg.threadId)}`
    }
    const rootId = hasPlatformId(msg.rootId) ? msg.rootId : msg.messageId
    return `${DEFAULT_CONFIG.sessionPrefix}:${GROUP_SESSION_SCOPE_VERSION}:${chatId}:root:${encodeURIComponent(rootId)}`
  }

  private async resolveSessionBinding(baseId: string): Promise<SessionBinding> {
    const persistence = sessionPersistenceOf(this.ctx)
    const committed = this.conversationBindings?.read(baseId)
    if (committed !== undefined) {
      if (persistence === undefined) {
        throw new Error('lark: committed conversation binding requires session persistence')
      }
      const sessionId = boundSessionId(baseId, committed)
      const matches = (await persistence.list()).filter((header) => String(header.id) === String(sessionId))
      if (matches.length !== 1) {
        throw new Error(`lark: committed session "${String(sessionId)}" is not uniquely persisted`)
      }
      const agentPreset = optionalAgentPreset(matches[0]?.agentPreset)
      const modelSelection = committed.modelSelection
        ?? await this.persistedModelSelection(persistence, sessionId)
      return {
        sessionId,
        persisted: true,
        generation: committed.generation,
        modelSelection,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      }
    }
    if (persistence === undefined) {
      return { sessionId: SessionId(baseId), persisted: false, generation: 0, modelSelection: null }
    }
    if (typeof persistence.list !== 'function') {
      throw new TypeError('lark: sessionPersistence.list is unavailable')
    }
    const latest = latestSessionBinding(baseId, await persistence.list())
    if (latest === undefined) {
      return { sessionId: SessionId(baseId), persisted: false, generation: 0, modelSelection: null }
    }
    return {
      ...latest,
      modelSelection: await this.persistedModelSelection(persistence, latest.sessionId),
    }
  }

  private async persistedModelSelection(
    persistence: SessionPersistenceLike,
    sessionId: ReturnType<typeof SessionId>,
  ): Promise<ConversationModelSelection | null> {
    if (persistence.inspect === undefined) return null
    const inspected = await persistence.inspect(sessionId)
    const header = foldRequestHeader(inspected.events as readonly SessionEvent[])
    return modelSelectionFromConfig(header?.config) ?? null
  }

  private async putConversationBinding(
    baseId: string,
    binding: ConversationBinding,
  ): Promise<void> {
    const store = this.conversationBindings
    if (store === undefined) throw new Error('lark: conversation binding store is unavailable')
    const stopSignal = this.commandAbort.signal
    let attempt = 0
    while (true) {
      this.throwIfBindingConfirmationInterrupted(stopSignal.reason)
      attempt += 1
      try {
        await store.put(baseId, binding)
        const confirmed = store.read(baseId)
        if (!sameConversationBinding(confirmed, binding)) {
          throw new Error('conversation binding read-after-write confirmation failed')
        }
        return
      } catch (writeError) {
        const readBack = bindingReadBackAfterError(store, baseId, binding, writeError)
        if (readBack.confirmed) return
        const error = readBack.error
        this.throwIfBindingConfirmationInterrupted(error)
        if (attempt <= 3 || (attempt & (attempt - 1)) === 0) {
          this.ctx.logger.warn(
            '[lark] conversation binding write is unconfirmed; fail-stopping this conversation and retrying the same atomic value (attempt %s): %s',
            attempt,
            messageOf(error),
          )
        }
        await this.waitForBindingRetry(attempt, stopSignal)
      }
    }
  }

  private throwIfBindingConfirmationInterrupted(cause?: unknown): void {
    if (!this.stopping && !this.commandAbort.signal.aborted) return
    this.bindingRecoveryRequired = true
    throw new BindingConfirmationInterruptedError(cause)
  }

  private async waitForBindingRetry(attempt: number, signal: AbortSignal): Promise<void> {
    if (attempt <= 3) return
    const retryDelay = Math.min(1_000, 25 * (2 ** Math.min(attempt - 4, 6)))
    try {
      await delay(retryDelay, undefined, { signal })
    } catch (error) {
      this.throwIfBindingConfirmationInterrupted(error)
      throw error
    }
  }

  private currentConversationBinding(
    baseId: string,
    sessionId: string,
    modelSelection: ConversationModelSelection,
  ): ConversationBinding {
    const current = this.conversationBindings?.read(baseId)
    const binding = conversationBinding(baseId, sessionId, modelSelection)
    if (current?.generation === binding.generation && current.suffix === binding.suffix) {
      return { ...binding, mutationHashes: current.mutationHashes }
    }
    return binding
  }

  private mutatedConversationBinding(
    baseId: string,
    sessionId: string,
    modelSelection: ConversationModelSelection,
    mutationHash: string | undefined,
  ): ConversationBinding {
    const mutationHashes = appendMutationHash(
      this.conversationBindings?.read(baseId)?.mutationHashes ?? [],
      mutationHash,
    )
    return conversationBinding(baseId, sessionId, modelSelection, mutationHashes)
  }

  private modelConversationBinding(
    baseId: string,
    sessionId: string,
    modelSelection: ConversationModelSelection,
    mutationHash: string | undefined,
  ): ConversationBinding {
    const mutationHashes = appendMutationHash(
      this.conversationBindings?.read(baseId)?.mutationHashes ?? [],
      mutationHash,
    )
    return conversationBinding(baseId, sessionId, modelSelection, mutationHashes)
  }

  private defaultModelSelection(): ConversationModelSelection {
    return Object.freeze({ provider: this.provider, model: this.model })
  }

  private modelSelectionFor(handle: AgentHandle): ModelSelectionRef {
    const selection = this.modelSelections.get(handle.agent)
    if (selection === undefined) throw new Error('lark: conversation model selection was not installed')
    return selection
  }

  private async ensureHandle(
    sessionId: ReturnType<typeof SessionId>,
    persisted = false,
    materialize = false,
    persistedAgentPreset?: string,
    cwd = this.cwd,
    modelSelection: ConversationModelSelection | null = null,
  ): Promise<AgentHandle> {
    const key = String(sessionId)
    const existing = this.handles.get(key)
    if (existing !== undefined) return existing
    const opened = this.openHandle(
      sessionId,
      persisted,
      materialize,
      persistedAgentPreset,
      cwd,
      modelSelection,
    )
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

  private async openHandle(
    sessionId: ReturnType<typeof SessionId>,
    persisted: boolean,
    materialize: boolean,
    persistedAgentPreset?: string,
    cwd = this.cwd,
    modelSelection: ConversationModelSelection | null = null,
  ): Promise<AgentHandle> {
    const agentOptions = modelSelection ?? this.defaultModelSelection()
    const modelSelectionRef: ModelSelectionRef = {
      current: { provider: agentOptions.provider, model: agentOptions.model },
      assembled: undefined,
    }
    const presets = agentPresetsOf(this.ctx)
    const requestedPreset = persisted
      ? (presets === undefined
          ? undefined
          : await this.persistedAgentPreset(sessionId, persistedAgentPreset))
      : optionalAgentPreset(persistedAgentPreset)
    const composition = await this.agentComposition(presets, requestedPreset)
    const setup = async (agentCtx: Context): Promise<void> => {
      installModelSelection(agentCtx, modelSelectionRef)
      await composition.setup?.(agentCtx)
    }
    const handle = persisted
      ? await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        setup,
      })
      : await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions,
        setup,
      })
    this.modelSelections.set(handle.agent, modelSelectionRef)
    if (!materialize) return handle
    try {
      this.materializeFreshHandle(handle)
      return handle
    } catch (error) {
      try {
        await handle.dispose()
      } catch (disposeError) {
        throw new AggregateError(
          [error, disposeError],
          'lark: fresh session materialization and cleanup failed',
        )
      }
      throw error
    }
  }

  private materializeFreshHandle(handle: AgentHandle): void {
    if (handle.agent.session.events.length === 0) {
      handle.agent.session.append('todo/write', { todos: [] })
    }
  }

  private async abandonFreshHandle(sessionId: string, handle: AgentHandle): Promise<void> {
    this.clearSessionState(sessionId)
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger.error('[lark] abandoned fresh session disposal failed: %s', messageOf(error))
    } finally {
      this.handles.delete(sessionId)
    }
  }

  private async disposeReplacedHandle(
    sessionId: string,
    handle: AgentHandle,
    reason: 'project' | 'reset',
  ): Promise<void> {
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger.error(`[lark] previous ${reason} session disposal failed: %s`, messageOf(error))
    } finally {
      this.handles.delete(sessionId)
    }
  }

  private retireHandleAfterIdle(
    sessionId: string,
    handle: AgentHandle,
    reason: 'project' | 'reset',
  ): void {
    let retirement: Promise<void>
    try {
      retirement = handle.agent.whenIdle().then(async () => {
        if (this.stopping) return
        if (handle.agent.status !== 'idle') {
          this.retireHandleAfterIdle(sessionId, handle, reason)
          return
        }
        if (handle.agent.inbox.hasPending) {
          this.ctx.logger.warn(
            `[lark] previous ${reason} session still has non-waking inbox work; retaining its handle`,
          )
          return
        }
        this.handles.delete(sessionId)
        await this.disposeReplacedHandle(sessionId, handle, reason)
      })
    } catch (error) {
      this.ctx.logger.error(`[lark] previous ${reason} session retirement failed: %s`, messageOf(error))
      return
    }
    this.handleRetirements.add(retirement)
    const cleanup = (): void => {
      this.handleRetirements.delete(retirement)
    }
    void retirement.then(cleanup, (error: unknown) => {
      cleanup()
      this.ctx.logger.error(`[lark] previous ${reason} session retirement failed: %s`, messageOf(error))
    })
  }

  private async persistedAgentPreset(
    sessionId: ReturnType<typeof SessionId>,
    headerPreset?: string,
  ): Promise<string | undefined> {
    const persistence = sessionPersistenceOf(this.ctx)
    if (persistence?.inspect === undefined) return optionalAgentPreset(headerPreset)
    const inspected = await persistence.inspect(sessionId)
    return selectedAgentPreset(inspected.meta.agentPreset ?? headerPreset, inspected.events)
  }

  private async agentComposition(
    presets: AgentPresetsLike | undefined,
    requestedPreset?: string,
  ): Promise<AgentComposition> {
    if (presets === undefined) {
      if (requestedPreset !== undefined) {
        throw new Error(`lark: cannot preserve agent preset "${requestedPreset}" without agentPresets`)
      }
      return {}
    }
    const resolved = await presets.resolve(requestedPreset)
    const agentPreset = optionalAgentPreset(resolved.id)
    if (agentPreset === undefined) throw new TypeError('lark: resolved agent preset id is invalid')
    return {
      agentPreset,
      setup: async (agentCtx) => {
        const mounted = await presets.mount(agentCtx, agentPreset)
        if (mounted.id !== agentPreset) {
          throw new Error(`lark: mounted agent preset "${mounted.id}" does not match "${agentPreset}"`)
        }
      },
    }
  }

  private handleSessionEvent(session: Session, event: SessionEvent): void {
    if (!this.approvalWaterfallBound && isApprovalAsked(event)) {
      this.ctx.logger.warn('[lark] approval-like session event without user-approval seam; skip cards')
      return
    }
    switch (event.type) {
      case 'turn/start':
        this.recordTurnStart(String(session.id), event.data.turn, event.time)
        this.scheduleWorkspaceAttachment(session)
        return
      case 'turn/end':
        this.removeTurnStart(String(session.id), event.data.turn)
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

  private enqueueMessageRoute(sessionId: string, messageId: string, route: MessageRoute): void {
    if (this.messageRoutes.has(messageId)) {
      throw new Error(`lark: duplicate pending message id "${messageId}"`)
    }
    this.messageRoutes.set(messageId, { sessionId, route })
  }

  private removeMessageRoute(messageId: string, route: MessageRoute): void {
    if (this.messageRoutes.get(messageId)?.route === route) this.messageRoutes.delete(messageId)
  }

  private recordTurnStart(sessionId: string, turn: number, time: number): void {
    const turns = this.turnStarts.get(sessionId) ?? new Map<number, number>()
    turns.set(turn, eventTime(time))
    this.turnStarts.set(sessionId, turns)
  }

  private removeTurnStart(sessionId: string, turn: number): void {
    const starts = this.turnStarts.get(sessionId)
    if (starts === undefined) return
    starts.delete(turn)
    if (starts.size === 0) this.turnStarts.delete(sessionId)
  }

  private claimMessageRoute(sessionId: string, messageId: string, turn: number): void {
    const pending = this.messageRoutes.get(messageId)
    if (pending === undefined) return
    this.messageRoutes.delete(messageId)
    if (pending.sessionId !== sessionId) {
      this.ctx.logger.warn(
        '[lark] claimed message route session mismatch; dropping route for message %s',
        messageId,
      )
      return
    }
    const startedAt = this.turnStarts.get(sessionId)?.get(turn) ?? Date.now()
    this.bindTurn(sessionId, turn, startedAt, pending.route)
  }

  private discardMessageRoute(sessionId: string, messageId: string): void {
    const pending = this.messageRoutes.get(messageId)
    if (pending?.sessionId === sessionId) this.messageRoutes.delete(messageId)
  }

  private bindTurn(sessionId: string, turn: number, startedAt: number, route: MessageRoute): void {
    if (this.turns.get(sessionId)?.has(turn) === true) {
      this.ctx.logger.warn('[lark] duplicate Lark route claimed for session %s turn %s', sessionId, turn)
      return
    }
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
      baseId: route.sessionBaseId,
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
      else {
        state.fullAnswer = appendAnswer(state.fullAnswer, text)
        state.answer = answerPreview(state.fullAnswer)
      }
    }
    state.streamingAnswer = undefined
    if (this.canRenderTurnCards()) {
      if (state.deliveryDisabled !== true) this.queueTurnCard(state)
      return
    }
    if (text !== undefined && !callsTool) {
      this.trackDelivery(this.safeSend(
        state.route.chatId,
        text,
        routeDeliveryOptions(state.route),
      ))
    }
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
    let rendered: ReturnType<typeof renderTurnCardWithMeta>
    const turnCard = this.turnCard(state)
    try {
      rendered = renderTurnCardWithMeta(turnCard)
    } catch (error) {
      this.ctx.logger.error('[lark] card render failed: %s', messageOf(error))
      return
    }
    const completeAnswer = state.fullAnswer ?? turnCard.answer
    const answerTruncated = rendered.answerTruncated || completeAnswer !== turnCard.answer
    const deliveredAnswer = answerTruncated ? undefined : completeAnswer
    const longAnswer = turnCard.status === 'running' || !answerTruncated ? undefined : completeAnswer
    const delivery = state.delivery
      .then(() => this.deliverTurnCard(state, rendered.payload, deliveredAnswer, longAnswer))
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
    longAnswer: string | undefined,
  ): Promise<void> {
    if (state.deliveryDisabled === true) return
    if (state.messageId !== undefined) {
      await this.client.updateCard!(state.messageId, card)
      if (answer !== undefined) state.deliveredAnswer = answer
      await this.deliverLongAnswer(state, longAnswer)
      return
    }
    const messageId = await this.client.sendCard!(
      state.route.chatId,
      card,
      routeDeliveryOptions(state.route),
    )
    if (typeof messageId === 'string' && messageId !== '') {
      state.messageId = messageId
      if (answer !== undefined) state.deliveredAnswer = answer
      await this.deliverLongAnswer(state, longAnswer)
      return
    }
    state.deliveryDisabled = true
    this.ctx.logger.warn('[lark] sendCard returned no message id; turn card updates disabled')
    this.fallbackFailedCard(state)
  }

  private fallbackFailedCard(state: TurnState): void {
    if (state.deliveryDisabled !== true || state.status === 'running') return
    const answer = state.fullAnswer ?? state.answer
    if (state.deliveredAnswer === answer || state.textFallbackSent === true) return
    if (answer === undefined || answer === '') return
    state.textFallbackSent = true
    this.trackDelivery(this.safeSend(
      state.route.chatId,
      answer,
      routeDeliveryOptions(state.route),
    ))
  }

  private async deliverLongAnswer(state: TurnState, answer: string | undefined): Promise<void> {
    if (answer === undefined || state.longAnswerSent === true) return
    state.longAnswerSent = true
    await this.client.sendText(
      state.route.chatId,
      `${this.text.longAnswer}\n\n${answer}`,
      routeDeliveryOptions(state.route),
    )
    state.deliveredAnswer = answer
  }

  private trackDelivery(delivery: Promise<void>): void {
    this.deliveryTasks.add(delivery)
    const cleanup = (): void => {
      this.deliveryTasks.delete(delivery)
    }
    void delivery.then(cleanup, cleanup)
  }

  private async drainDeliveries(failures: unknown[]): Promise<void> {
    while (this.deliveryTasks.size > 0) {
      await collectSettled([...this.deliveryTasks], failures)
    }
  }

  private approvalRoute(sessionId: string): MessageRoute | undefined {
    return this.activeRoutes.get(sessionId)
  }

  private clearSessionState(sessionId: string): void {
    this.pendingWorkspaceAttachments.delete(sessionId)
    this.workspaceAttachmentRetries.delete(sessionId)
    for (const [messageId, pending] of this.messageRoutes) {
      if (pending.sessionId === sessionId) this.messageRoutes.delete(messageId)
    }
    this.turnStarts.delete(sessionId)
    for (const state of this.turns.get(sessionId)?.values() ?? []) this.clearStreamTimer(state)
    this.turns.delete(sessionId)
    this.activeRoutes.delete(sessionId)
    this.contextWindows.delete(sessionId)
    for (const [requestId, pending] of this.pendingStops) {
      if (pending.sessionId === sessionId) this.pendingStops.delete(requestId)
    }
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId) continue
      void pending.settle(APPROVAL_OUTCOME.cancelled)
    }
  }

  private clearRoutes(): void {
    this.messageRoutes.clear()
    this.turnStarts.clear()
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

  private async safeSend(
    chatId: string,
    text: string,
    deliveryOptions?: LarkDeliveryOptions,
  ): Promise<void> {
    try {
      await this.client.sendText(chatId, text, deliveryOptions)
    } catch (error) {
      this.ctx.logger.error('[lark] delivery failed: %s', messageOf(error))
    }
  }
}
