import { createHash, randomUUID } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmCallConfig, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { foldRequestHeader, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import {
  CARD_ACTIONS,
  CARD_LIMITS,
  HUMAN_INPUT_CARD_FIELDS,
  humanInputCustomFieldName,
  humanInputSelectionFieldName,
  renderApprovalCard,
  renderApprovalDecisionCard,
  renderHumanInputCard,
  renderHumanInputTerminalCard,
  renderTurnCardWithMeta,
} from './cards.ts'
import type {
  HumanInputCardOutcome,
  ToolCardItem,
  TurnCard,
  TurnCardStatus,
  TurnCardTodo,
  TurnCardUsage,
} from './cards.ts'
import { DEFAULT_CONFIG, MIN_STREAM_UPDATE_INTERVAL_MS } from './config.ts'
import { CONVERSATION_MUTATION_HISTORY_LIMIT } from './conversation-binding.ts'
import type {
  ConversationBinding,
  ConversationBindingStore,
  ConversationModelSelection,
} from './conversation-binding.ts'
import { projectActivity, sessionEventPolicy } from './events.ts'
import type { ActivityProjection, CatalogSessionEvent } from './events.ts'
import {
  ASK_USER_QUESTION_NAME,
  HUMAN_INPUT_LIMITS,
  isCompatibleAskUserQuestionDefinition,
  normalizeHumanInputRequest,
  validateHumanInputAnswer,
} from './human-input.ts'
import type { HumanInputAnswer, HumanInputRequest } from './human-input.ts'
import {
  InboundTextResourceError,
  prepareInboundTextResource,
  resolveInboundTextResourceMaxBytes,
  validateInboundTextResourceName,
} from './inbound-resource.ts'
import type { InboundDeduplicator } from './inbound-dedup.ts'
import type {
  LarkCardAction,
  LarkCardActionResult,
  LarkClientLike,
  LarkDeliveryOptions,
  LarkInbound,
} from './lark.ts'
import { LarkResourceError } from './lark.ts'
import { localeCopy } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export interface LarkBridgeOptions {
  locale?: LarkLocale
  allowFrom?: string[]
  allowAllUsers?: boolean
  projectManageFrom?: string[]
  defaultSessionId?: string
  provider?: string
  model?: string
  streamUpdateIntervalMs?: number
  maxConversationHandles?: number
  inboundTextFiles?: boolean
  maxInboundTextFileBytes?: number
  humanInputTimeoutMs?: number
  humanInputCardCloseTimeoutMs?: number
  cwd?: string
  sessionReferenceNamespace?: string
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
  readonly maxGeneration: number
  readonly agentPreset?: string
  readonly modelSelection: ConversationModelSelection | null
}

interface SessionPersistenceLike {
  list(signal?: AbortSignal): Promise<ReadonlyArray<{
    id: ReturnType<typeof SessionId>
    agentPreset?: string
  }>>
  inspect?(id: ReturnType<typeof SessionId>, signal?: AbortSignal): Promise<{
    readonly meta: { readonly agentPreset?: string }
    readonly events: ReadonlyArray<{ readonly type: string; readonly data: unknown }>
  }>
}

interface SessionQueryRecordLike {
  readonly header: SessionHeader
  readonly live: boolean
  readonly persisted: boolean
}

type SessionTitleResultLike = {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly status: 'fulfilled'
  readonly value: {
    readonly session: SessionQueryRecordLike['header']
    readonly title?: { readonly title: string }
  }
} | {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly status: 'rejected'
  readonly reason: unknown
}

interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionQueryRecordLike[]>
  readTitleSnapshots(
    sessionIds: readonly ReturnType<typeof SessionId>[],
    signal?: AbortSignal,
  ): Promise<readonly SessionTitleResultLike[]>
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
  create?(path: string, title: string): Promise<RegisteredWorkspace>
  delete?(id: string): Promise<boolean>
  readonly archivedSessionIds?: ReadonlyArray<ReturnType<typeof SessionId>>
}

interface SessionWorkspaceIndex {
  readonly workspaces: readonly RegisteredWorkspace[]
  readonly bySession: ReadonlyMap<string, RegisteredWorkspace | null>
  readonly archived: ReadonlySet<string>
  readonly truncated: boolean
}

interface SynchronousSessionAuthority {
  readonly registry: WorkspaceRegistryLike
  readonly index: SessionWorkspaceIndex
}

interface ConversationSessionCandidate {
  readonly sessionId: ReturnType<typeof SessionId>
  readonly sourceHeader: SessionHeader
  readonly generation: number
  readonly reference: string
  readonly createdAt: number
  readonly cwd?: string
  readonly agentPreset?: string
  readonly workspace?: RegisteredWorkspace
  readonly current: boolean
}

interface ListedConversationSession extends ConversationSessionCandidate {
  readonly title?: string
}

interface ConversationSessionCandidates {
  readonly items: readonly ConversationSessionCandidate[]
  readonly truncated: boolean
}

type SessionSwitchCommandResult = {
  readonly kind: 'resumed' | 'already-current'
  readonly candidate: ConversationSessionCandidate
} | {
  readonly kind: 'busy' | 'history-failed' | 'unavailable' | 'unknown' | 'failed'
}

type SessionSwitchMaintenanceResult = {
  readonly kind: 'committed'
  readonly candidate: ConversationSessionCandidate
  readonly previousSessionId: string
  readonly previousHandle: AgentHandle
} | {
  readonly kind: 'busy' | 'history-failed' | 'unavailable' | 'unknown' | 'failed'
}

type SessionCandidateCommitResult = {
  readonly kind: 'committed'
  readonly candidate: ConversationSessionCandidate
  readonly workspace: RegisteredWorkspace
} | {
  readonly kind: 'busy' | 'unavailable' | 'unknown' | 'failed'
}

interface ProjectSelection {
  readonly registry: WorkspaceRegistryLike
  readonly workspaces: readonly RegisteredWorkspace[]
  readonly workspace: RegisteredWorkspace
}

type ProjectSelectionResult = {
  readonly kind: 'selected'
  readonly selection: ProjectSelection
} | {
  readonly kind: 'missing'
  readonly workspace: RegisteredWorkspace
} | {
  readonly kind: 'ambiguous' | 'failed' | 'unavailable' | 'unknown'
}

type ProjectSwitchCommandResult = {
  readonly kind: 'switched' | 'already-current' | 'missing'
  readonly workspace: RegisteredWorkspace
} | {
  readonly kind: 'ambiguous' | 'busy' | 'history-failed' | 'unavailable' | 'unknown' | 'failed'
}

type ProjectRegistryCommandResult = {
  readonly kind: 'registered' | 'already-registered' | 'removed'
  readonly workspace: RegisteredWorkspace
} | {
  readonly kind: 'busy' | 'unavailable' | 'unknown' | 'replayed' | 'register-failed' | 'remove-failed'
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
  readonly chatType: LarkInbound['chatType']
  readonly mentioned: boolean
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

type HumanInputSettlement = {
  readonly kind: 'answered'
  readonly answer: HumanInputAnswer
  readonly immediateCard: true
} | {
  readonly kind: 'cancelled'
  readonly immediateCard: boolean
} | {
  readonly kind: 'timed-out' | 'unavailable'
  readonly immediateCard: false
}

interface PendingHumanInput {
  readonly requestId: string
  readonly sessionId: string
  readonly baseId: string
  readonly chatId: string
  readonly openId: string
  readonly agent: Agent
  readonly turnState: TurnState
  readonly request: HumanInputRequest
  state: 'sending' | 'awaiting' | 'settled'
  messageId?: string
  settlement?: HumanInputSettlement
  cardCloseStarted: boolean
  claim(settlement: HumanInputSettlement): boolean
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
const BRIDGE_COMMANDS = new Set(['start', 'help', 'new', 'clear', 'project', 'session', 'model'])
const UNSUPPORTED_RUNTIME_COMMANDS = new Set(['feedback', 'export'])
const MODEL_CATALOG_PROVIDER_LIMIT = 32
const MODEL_CATALOG_ENTRY_LIMIT = 128
const MODEL_DISPLAY_FIELD_LIMIT = 120
const MODEL_PROVIDER_ID_LIMIT = 256
const MODEL_ID_LIMIT = 512
const MODEL_CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const MODEL_CONTROL_CHARACTER_TEST_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const PROJECT_TITLE_LIMIT = 120
const PROJECT_ID_LIMIT = 256
const PROJECT_CONTROL_CHARACTER_TEST_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const PROJECT_PATH_LIKE_TITLE_PATTERN = /^(?:[A-Za-z]:\S|file:(?:[/\\]|$)|[/\\]{1,2}|~(?:[/\\]|$)|\.{1,2}(?:[/\\]|$))/iu
const PROJECT_PLATFORM_TAG_TEST_PATTERN = /<[^>]*>/u
const SESSION_REFERENCE_HASH_DOMAIN = 'dsh-plugin-lark/session-reference/v1'
const SESSION_REFERENCE_PATTERN = /^s_[A-Za-z0-9_-]{43}$/u
const SESSION_LIST_PAGE_SIZE = 10
const SESSION_CANDIDATE_LIMIT = 200
const SESSION_WORKSPACE_INDEX_LIMIT = 1_000
const SESSION_CREATED_AT_MAX = 8_640_000_000_000_000
const SESSION_TITLE_SOURCE_CODE_UNIT_LIMIT = 4_096
const WORKSPACE_REGISTRIES_REQUIRING_REMOUNT = new WeakSet<object>()
const HUMAN_INPUT_CARD_CLOSE_TIMEOUT_MS = 15_000
const HUMAN_INPUT_SHUTDOWN_CLOSE_TIMEOUT_MS = 2_000
const HUMAN_INPUT_CARD_REPAIR_DELAY_MS = 250

type HumanInputFailureCode =
  | 'LARK_HUMAN_INPUT_INVALID_REQUEST'
  | 'LARK_HUMAN_INPUT_UNAVAILABLE'
  | 'LARK_HUMAN_INPUT_BUSY'
  | 'LARK_HUMAN_INPUT_CANCELLED'
  | 'LARK_HUMAN_INPUT_TIMEOUT'
  | 'LARK_HUMAN_INPUT_STALE'
  | 'LARK_HUMAN_INPUT_CODE_MODE_UNSUPPORTED'
  | 'LARK_HUMAN_INPUT_INTERNAL'

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

class InboundResourceInterruptedError extends Error {
  constructor(cause?: unknown) {
    super('lark: inbound resource handling was interrupted by shutdown', { cause })
    this.name = 'InboundResourceInterruptedError'
  }
}

class HumanInputExpectedError extends Error {
  constructor(readonly code: HumanInputFailureCode, message: string) {
    super(message)
    this.name = 'HumanInputExpectedError'
  }
}

function humanInputFailure(code: HumanInputFailureCode, message: string): ToolExecutionResult {
  return {
    isError: true,
    error: {
      message,
      info: { name: 'LarkHumanInputError', code },
    },
    content: [{ type: 'text', text: `Error: ${message}` }],
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

function actionCard(
  type: 'success' | 'error' | 'info',
  content: string,
  card: Record<string, unknown>,
): LarkCardActionResult {
  return { toast: { type, content }, card: { type: 'raw', data: card } }
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

function sessionReference(namespace: string, baseId: string, sessionId: string): string {
  const hash = createHash('sha256').update(SESSION_REFERENCE_HASH_DOMAIN)
  for (const value of [namespace, baseId, sessionId]) {
    hash.update('\0').update(String(Buffer.byteLength(value, 'utf8'))).update(':').update(value, 'utf8')
  }
  return `s_${hash.digest('base64url')}`
}

function sessionListPage(input: string): number | undefined {
  if (input === '') return 1
  if (!/^[1-9]\d{0,5}$/u.test(input)) return undefined
  const page = Number(input)
  return Number.isSafeInteger(page) ? page : undefined
}

function sessionCreatedAt(value: number): string | undefined {
  if (value > SESSION_CREATED_AT_MAX) return undefined
  return new Date(value).toISOString()
}

function maximumSessionGeneration(
  baseId: string,
  headers: ReadonlyArray<{ readonly id: ReturnType<typeof SessionId> }>,
): number {
  let maximum = 0
  for (const header of headers) {
    const generation = sessionGeneration(baseId, String(header.id))
    if (generation !== undefined) maximum = Math.max(maximum, generation)
  }
  return maximum
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

function projectRegistrationTitle(input: string): string | undefined {
  if (!input.isWellFormed()
    || PROJECT_CONTROL_CHARACTER_TEST_PATTERN.test(input)
    || PROJECT_PLATFORM_TAG_TEST_PATTERN.test(input)) return undefined
  const normalized = input.replace(/\s+/gu, ' ').trim()
  if (normalized === ''
    || [...normalized].length > PROJECT_TITLE_LIMIT
    || PROJECT_PATH_LIKE_TITLE_PATTERN.test(normalized)) return undefined
  return normalized
}

async function canonicalProjectDirectory(value: unknown): Promise<string | undefined> {
  if (typeof value !== 'string' || !isAbsolute(value) || !value.isWellFormed()) return undefined
  try {
    const canonical = await realpath(value)
    return (await stat(canonical)).isDirectory() ? canonical : undefined
  } catch {
    return undefined
  }
}

async function workspaceContainsSessionCwd(
  workspace: RegisteredWorkspace,
  cwd: string | undefined,
): Promise<boolean> {
  if (cwd === workspace.path) return true
  return await canonicalProjectDirectory(cwd) === workspace.path
}

function workspaceContainsSessionCwdNow(
  workspace: RegisteredWorkspace,
  cwd: string | undefined,
): boolean {
  if (typeof cwd !== 'string' || !isAbsolute(cwd) || !cwd.isWellFormed()) return false
  try {
    const canonical = realpathSync(cwd)
    return canonical === workspace.path && statSync(canonical).isDirectory()
  } catch {
    return false
  }
}

function validProjectIdInput(input: string): boolean {
  return input !== ''
    && input.length <= PROJECT_ID_LIMIT
    && input.isWellFormed()
    && !/\s/u.test(input)
    && !PROJECT_CONTROL_CHARACTER_TEST_PATTERN.test(input)
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

function sessionQueryOf(ctx: Context): SessionQueryLike | undefined {
  const service = ctx.get('sessionQuery') as unknown
  if (service === undefined) return undefined
  if (service === null || typeof service !== 'object') {
    throw new TypeError('lark: sessionQuery service is invalid')
  }
  const candidate = service as Partial<SessionQueryLike>
  if (typeof candidate.listSessions !== 'function'
    || typeof candidate.readTitleSnapshots !== 'function') {
    throw new TypeError('lark: sessionQuery service is invalid')
  }
  return candidate as SessionQueryLike
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
    || !validProjectIdInput(candidate.id)
    || PROJECT_PLATFORM_TAG_TEST_PATTERN.test(candidate.id)
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
    || (candidate.resolveByPath !== undefined && typeof candidate.resolveByPath !== 'function')
    || (candidate.create !== undefined && typeof candidate.create !== 'function')
    || (candidate.delete !== undefined && typeof candidate.delete !== 'function')
    || (candidate.archivedSessionIds !== undefined
      && (!Array.isArray(candidate.archivedSessionIds)
        || candidate.archivedSessionIds.some((id) => typeof id !== 'string')))) {
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

function sessionWorkspaceIndex(
  workspaces: readonly RegisteredWorkspace[],
  archivedSessionIds: readonly ReturnType<typeof SessionId>[],
): SessionWorkspaceIndex {
  const bySession = new Map<string, RegisteredWorkspace | null>()
  let indexed = 0
  let truncated = false
  for (const workspace of workspaces) {
    const sessionIds = workspace.sessionIds ?? []
    const available = Math.max(0, SESSION_WORKSPACE_INDEX_LIMIT - indexed)
    const visible = sessionIds.slice(0, available)
    if (visible.length < sessionIds.length) truncated = true
    for (const rawId of visible) {
      indexed += 1
      const id = String(rawId)
      const previous = bySession.get(id)
      if (previous === undefined) bySession.set(id, workspace)
      else if (previous !== null && previous.id !== workspace.id) bySession.set(id, null)
    }
  }
  return {
    workspaces,
    bySession,
    archived: new Set(archivedSessionIds.map(String)),
    truncated,
  }
}

function sessionQueryRecord(value: unknown): SessionQueryRecordLike {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('lark: sessionQuery returned an invalid record')
  }
  const candidate = value as Partial<SessionQueryRecordLike>
  const header = candidate.header as Partial<SessionQueryRecordLike['header']> | undefined
  if (header === undefined
    || header.version !== SESSION_FORMAT_VERSION
    || typeof header.id !== 'string'
    || !header.id.isWellFormed()
    || !Number.isSafeInteger(header.createdAt)
    || (header.createdAt ?? -1) < 0
    || (header.cwd !== undefined
      && (typeof header.cwd !== 'string' || !header.cwd.isWellFormed() || !isAbsolute(header.cwd)))
    || (header.parentSession !== undefined
      && (typeof header.parentSession !== 'string' || !header.parentSession.isWellFormed()))
    || (header.seedLength !== undefined
      && (!Number.isSafeInteger(header.seedLength) || header.seedLength < 0))
    || (header.origin !== undefined && header.origin !== 'subagent')
    || (header.delegationDepth !== undefined
      && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0))
    || (header.agentPreset !== undefined
      && (typeof header.agentPreset !== 'string' || !header.agentPreset.isWellFormed()))
    || typeof candidate.live !== 'boolean'
    || typeof candidate.persisted !== 'boolean') {
    throw new TypeError('lark: sessionQuery returned an invalid record')
  }
  const snapshot: SessionHeader = Object.freeze({
    version: header.version as number,
    id: SessionId(header.id),
    createdAt: header.createdAt as number,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
    ...(header.parentSession === undefined
      ? {}
      : { parentSession: SessionId(header.parentSession) }),
    ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  })
  return Object.freeze({
    header: snapshot,
    live: candidate.live as boolean,
    persisted: candidate.persisted as boolean,
  })
}

function sameSessionSourceHeader(left: SessionHeader, right: SessionHeader): boolean {
  return left.version === right.version
    && String(left.id) === String(right.id)
    && left.createdAt === right.createdAt
    && left.cwd === right.cwd
    && left.parentSession === right.parentSession
    && left.seedLength === right.seedLength
    && left.origin === right.origin
    && (left.delegationDepth ?? 0) === (right.delegationDepth ?? 0)
    && left.agentPreset === right.agentPreset
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
      maxGeneration: generation,
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
  private readonly projectManageFrom: ReadonlySet<string>
  private readonly sharedSessionBaseId: string | undefined
  private readonly provider: string
  private readonly model: string
  private readonly streamUpdateIntervalMs: number
  private readonly maxConversationHandles: number
  private readonly inboundTextFiles: boolean
  private readonly maxInboundTextFileBytes: number
  private readonly humanInputTimeoutMs: number
  private readonly humanInputCardCloseTimeoutMs: number
  private readonly cwd: string
  private readonly sessionReferenceNamespace: string
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
  private readonly pendingHumanInputs = new Map<string, PendingHumanInput>()
  private readonly pendingHumanInputMessages = new Map<string, PendingHumanInput>()
  private readonly pendingHumanInputSessions = new Map<string, PendingHumanInput>()
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
  private workspaceMutationTail: Promise<void> = Promise.resolve()
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
  private workspaceMutationRecoveryRequired = false
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
    this.projectManageFrom = new Set(
      (options.projectManageFrom ?? []).map((openId) => openId.trim()).filter(Boolean),
    )
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
    this.inboundTextFiles = options.inboundTextFiles === true
    this.maxInboundTextFileBytes = resolveInboundTextResourceMaxBytes(
      options.maxInboundTextFileBytes ?? DEFAULT_CONFIG.maxInboundTextFileBytes,
    )
    this.humanInputTimeoutMs = options.humanInputTimeoutMs ?? HUMAN_INPUT_LIMITS.timeoutMs
    if (!Number.isSafeInteger(this.humanInputTimeoutMs)
      || this.humanInputTimeoutMs <= 0
      || this.humanInputTimeoutMs > HUMAN_INPUT_LIMITS.timeoutMs) {
      throw new RangeError('lark: humanInputTimeoutMs must be a positive bounded safe integer')
    }
    this.humanInputCardCloseTimeoutMs = options.humanInputCardCloseTimeoutMs
      ?? HUMAN_INPUT_CARD_CLOSE_TIMEOUT_MS
    if (!Number.isSafeInteger(this.humanInputCardCloseTimeoutMs)
      || this.humanInputCardCloseTimeoutMs <= 0
      || this.humanInputCardCloseTimeoutMs > HUMAN_INPUT_CARD_CLOSE_TIMEOUT_MS) {
      throw new RangeError('lark: humanInputCardCloseTimeoutMs must be a positive bounded safe integer')
    }
    this.cwd = options.cwd ?? process.cwd()
    this.sessionReferenceNamespace = options.sessionReferenceNamespace ?? 'direct-bridge'
    if (!validModelIdentifier(this.sessionReferenceNamespace, MODEL_PROVIDER_ID_LIMIT)) {
      throw new TypeError('lark: sessionReferenceNamespace must be a bounded, trimmed identifier')
    }
  }

  start(): Promise<void> {
    try {
      const registry = workspaceRegistryOf(this.ctx)
      if (registry !== undefined && WORKSPACE_REGISTRIES_REQUIRING_REMOUNT.has(registry)) {
        this.workspaceMutationRecoveryRequired = true
      }
    } catch {
      // Service validation remains command-scoped, as before.
    }
    if (this.bindingRecoveryRequired) {
      return Promise.reject(new Error(
        'lark: bridge requires a full storage remount after an interrupted binding confirmation',
      ))
    }
    if (this.workspaceMutationRecoveryRequired) {
      return Promise.reject(new Error(
        'lark: bridge requires a full storage remount after an interrupted workspace mutation',
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
    for (const pending of [...this.pendingHumanInputs.values()]) {
      pending.agent.cancel({ kind: 'disposed' })
      pending.claim({ kind: 'cancelled', immediateCard: false })
    }
    this.pendingHumanInputs.clear()
    this.pendingHumanInputMessages.clear()
    this.pendingHumanInputSessions.clear()
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
        && !(result.reason instanceof BindingConfirmationInterruptedError)
        && !(result.reason instanceof InboundResourceInterruptedError)) {
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
    const agents = await collectSettled(this.handles.values(), failures)
    const agentCleanup = collectSettled(
      [...new Set(agents)].map((handle) => Promise.resolve().then(() => handle.dispose())),
      failures,
    )
    const retirementCleanup = collectSettled([...this.handleRetirements], failures)
    // Keep REST available while terminal Card delivery and Agent/Session
    // quiescence advance together. A second drain after every producer has
    // settled closes the admission window before the client is stopped.
    await Promise.all([
      this.drainDeliveries(failures),
      agentCleanup,
      retirementCleanup,
    ])
    await this.drainDeliveries(failures)
    await collectSettled([Promise.resolve().then(() => this.client.stop())], failures)
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
      chatType: msg.chatType,
      mentioned: msg.mentioned,
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
      if (msg.messageType === 'file' && msg.chatType === 'p2p' && this.inboundTextFiles) {
        await this.handleInboundTextFile(route, msg)
        return
      }
      await this.safeSend(route.chatId, this.text.unsupportedInput, routeDeliveryOptions(route))
      return
    }
    if (command !== undefined) {
      await this.handleCommand(route, command)
      return
    }
    await this.enqueueConversationOperation(route.sessionBaseId, () => (
      this.followupConversation(route, [{ type: 'text', text: msg.text.trim() }])
    ))
  }

  private async handleInboundTextFile(route: MessageRoute, msg: LarkInbound): Promise<void> {
    const resource = msg.resource
    const download = this.client.downloadMessageResource
    if (resource === undefined || download === undefined) {
      await this.sendInboundTextFileReply(route, this.text.inboundTextFileInvalid)
      return
    }
    try {
      validateInboundTextResourceName(resource.name)
    } catch (error) {
      await this.replyForInboundTextFileError(route, error)
      return
    }
    await this.enqueueConversationOperation(route.sessionBaseId, async () => {
      let prepared: ReturnType<typeof prepareInboundTextResource>
      try {
        const downloaded = await download.call(this.client, msg.messageId, resource, {
          maxBytes: this.maxInboundTextFileBytes,
          signal: this.commandAbort.signal,
        })
        prepared = prepareInboundTextResource({
          name: resource.name,
          mediaType: downloaded.mediaType,
          data: downloaded.data,
        }, this.maxInboundTextFileBytes)
      } catch (error) {
        if (this.stopping || this.commandAbort.signal.aborted) {
          throw new InboundResourceInterruptedError(error)
        }
        await this.replyForInboundTextFileError(route, error)
        return
      }
      if (this.stopping || this.commandAbort.signal.aborted) {
        throw new InboundResourceInterruptedError()
      }
      await this.followupConversation(route, [prepared.block])
    })
  }

  private async replyForInboundTextFileError(route: MessageRoute, error: unknown): Promise<void> {
    const tooLarge = (error instanceof LarkResourceError && error.code === 'too_large')
      || (error instanceof InboundTextResourceError && error.code === 'RESOURCE_TOO_LARGE')
    const invalid = error instanceof InboundTextResourceError
      || (error instanceof LarkResourceError && error.code === 'invalid')
    const reply = tooLarge
      ? this.text.inboundTextFileTooLarge(this.maxInboundTextFileBytes)
      : invalid
        ? this.text.inboundTextFileInvalid
        : this.text.inboundTextFileUnavailable
    await this.sendInboundTextFileReply(route, reply)
  }

  private async sendInboundTextFileReply(route: MessageRoute, text: string): Promise<void> {
    try {
      await this.client.sendText(route.chatId, text, routeDeliveryOptions(route))
    } catch {
      throw new Error('lark: inbound text file notice delivery failed')
    }
  }

  private async followupConversation(
    route: MessageRoute,
    content: ContentBlock[],
  ): Promise<void> {
    await this.withConversation(route.sessionBaseId, async (conversation) => {
      await this.sessionOperations.get(conversation.baseId)
      this.prepareWorkspaceAttachment(conversation)
      const message = createUserMessage({
        content,
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
  }

  async handleCardAction(action: LarkCardAction): Promise<LarkCardActionResult> {
    if (!this.authorized(action.openId)) {
      if (action.chatId !== '') await this.safeSend(action.chatId, this.text.denied)
      return actionToast('error', this.text.approvalUnauthorized)
    }
    if (action.value.action === CARD_ACTIONS.turnStop) return this.handleStopAction(action)
    if (action.value.action === CARD_ACTIONS.humanInputCancel
      || (action.tag === 'button' && action.name === HUMAN_INPUT_CARD_FIELDS.submit)) {
      return this.handleHumanInputAction(action)
    }
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
    const activeConversation = this.conversations.get(candidate.baseId)
    if (activeConversation?.sessionId === candidate.sessionId
      && this.pendingStops.get(requestId) === candidate) {
      if (candidate.stopping) return actionToast('info', this.text.stopRequested)
      if (activeConversation.handle.agent.status !== 'running') {
        this.pendingStops.delete(requestId)
        return actionToast('info', this.text.stopExpired)
      }
      candidate.stopping = true
      this.pendingHumanInputSessions.get(candidate.sessionId)?.claim({
        kind: 'cancelled',
        immediateCard: false,
      })
      activeConversation.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return actionToast('success', this.text.stopRequested)
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
    const conversation = this.conversations.get(pending.baseId)
    if (conversation?.sessionId === pending.sessionId) {
      if (conversation.handle.agent.status !== 'running') {
        this.pendingStops.delete(requestId)
        return actionToast('info', this.text.stopExpired)
      }
      conversation.handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      return actionToast('success', this.text.stopRequested)
    }
    this.pendingHumanInputSessions.get(pending.sessionId)?.claim({ kind: 'cancelled', immediateCard: false })
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

  private humanInputPendingIsCurrent(pending: PendingHumanInput): boolean {
    const sessionId = pending.sessionId
    const route = this.activeRoutes.get(sessionId)
    const conversation = this.conversations.get(pending.baseId)
    return !this.stopping
      && this.ctx.agents.get(pending.agent.id) === pending.agent
      && this.ctx.agents.roots().some((agent) => agent === pending.agent)
      && conversation?.sessionId === sessionId
      && conversation.handle.agent === pending.agent
      && this.activeTurnState(sessionId) === pending.turnState
      && route?.sessionBaseId === pending.baseId
      && route.chatId === pending.chatId
      && route.openId === pending.openId
  }

  private humanInputAnswerFromAction(
    pending: PendingHumanInput,
    action: LarkCardAction,
  ): { readonly kind: 'valid'; readonly answer: HumanInputAnswer } | { readonly kind: 'incomplete' | 'invalid' } {
    const formValue = action.formValue ?? {}
    const expectedFields = new Set<string>()
    for (const [index, question] of pending.request.questions.entries()) {
      expectedFields.add(humanInputCustomFieldName(index))
      if (question.options.length > 0) expectedFields.add(humanInputSelectionFieldName(index))
    }
    if (Object.keys(formValue).some((key) => !expectedFields.has(key))) return { kind: 'invalid' }
    const answers = pending.request.questions.map((question, index) => {
      const selectionValue = formValue[humanInputSelectionFieldName(index)]
      const customValue = formValue[humanInputCustomFieldName(index)]
      let selectedTokens: string[] = []
      if (question.options.length > 0) {
        if (question.multiSelect) {
          if (selectionValue !== undefined
            && (!Array.isArray(selectionValue)
              || selectionValue.some((value) => typeof value !== 'string'))) return undefined
          selectedTokens = selectionValue === undefined ? [] : [...selectionValue] as string[]
        } else {
          if (selectionValue !== undefined && typeof selectionValue !== 'string') return undefined
          selectedTokens = selectionValue === undefined || selectionValue === '' ? [] : [selectionValue]
        }
      } else if (selectionValue !== undefined) return undefined
      const selected: string[] = []
      const tokenIndexes = new Set<number>()
      for (const token of selectedTokens) {
        const match = new RegExp(`^q${index}_o(0|[1-9]\\d*)$`, 'u').exec(token)
        const optionIndex = match === null ? -1 : Number(match[1])
        const option = question.options[optionIndex]
        if (option === undefined || tokenIndexes.has(optionIndex)) return undefined
        tokenIndexes.add(optionIndex)
        selected.push(option.label)
      }
      if (!question.multiSelect && selected.length > 1) return undefined
      if (customValue !== undefined && typeof customValue !== 'string') return undefined
      const custom = typeof customValue === 'string' && customValue.trim() !== ''
        ? customValue
        : undefined
      return {
        id: question.id,
        selected: !question.multiSelect && custom !== undefined ? [] : selected,
        ...(custom === undefined ? {} : { custom }),
      }
    })
    if (answers.some((answer) => answer === undefined)) return { kind: 'invalid' }
    try {
      return {
        kind: 'valid',
        answer: validateHumanInputAnswer(
          pending.request,
          { answers },
          { requireEveryAnswer: true },
        ),
      }
    } catch (error) {
      return error instanceof TypeError && /requires an answer/u.test(error.message)
        ? { kind: 'incomplete' }
        : { kind: 'invalid' }
    }
  }

  private async handleHumanInputAction(action: LarkCardAction): Promise<LarkCardActionResult> {
    const cancelRequestId = action.value.action === CARD_ACTIONS.humanInputCancel
      && typeof action.value.request_id === 'string'
      ? action.value.request_id
      : undefined
    const candidate = cancelRequestId === undefined
      ? this.pendingHumanInputMessages.get(action.messageId)
      : this.pendingHumanInputs.get(cancelRequestId)
    if (candidate === undefined) return actionToast('info', this.text.humanInputExpired)
    if (candidate.state !== 'awaiting'
      || candidate.messageId !== action.messageId
      || candidate.chatId !== action.chatId
      || candidate.openId !== action.openId) {
      this.ctx.logger.warn('[lark] rejected human input from a different card, chat, or user')
      return actionToast('error', this.text.humanInputWrongContext)
    }
    const pending = cancelRequestId === undefined
      ? this.pendingHumanInputMessages.get(action.messageId)
      : this.pendingHumanInputs.get(cancelRequestId)
    if (pending !== candidate || !this.humanInputPendingIsCurrent(candidate)) {
      return actionToast('info', this.text.humanInputExpired)
    }
    if (cancelRequestId !== undefined) {
      if (!candidate.claim({ kind: 'cancelled', immediateCard: true })) {
        return actionToast('info', this.text.humanInputExpired)
      }
      return actionCard(
        'success',
        this.text.humanInputCancelled,
        renderHumanInputTerminalCard('cancelled', this.locale),
      )
    }
    if (action.tag !== 'button' || action.name !== HUMAN_INPUT_CARD_FIELDS.submit) {
      return actionToast('error', this.text.humanInputMalformed)
    }
    const parsed = this.humanInputAnswerFromAction(candidate, action)
    if (parsed.kind !== 'valid') {
      return actionToast(
        'error',
        parsed.kind === 'incomplete' ? this.text.humanInputIncomplete : this.text.humanInputMalformed,
      )
    }
    if (!candidate.claim({ kind: 'answered', answer: parsed.answer, immediateCard: true })) {
      return actionToast('info', this.text.humanInputExpired)
    }
    return actionCard(
      'success',
      this.text.humanInputSubmitted,
      renderHumanInputTerminalCard('answered', this.locale),
    )
  }

  private trackHumanInputCardClose(
    messageId: string,
    outcome: HumanInputCardOutcome,
    delayMs = 0,
  ): void {
    if (this.client.updateCard === undefined) return
    const closing = (async () => {
      if (delayMs > 0) await delay(delayMs)
      const deadline = new AbortController()
      const shutdownSignal = this.commandAbort.signal
      let rejectAbort: ((error: Error) => void) | undefined
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject
      })
      const onAbort = (): void => {
        rejectAbort?.(new Error('lark: human-input card update timed out'))
      }
      deadline.signal.addEventListener('abort', onAbort, { once: true })
      let timer: ReturnType<typeof setTimeout> | undefined
      const armDeadline = (timeoutMs: number): void => {
        if (timer !== undefined) clearTimeout(timer)
        timer = setTimeout(() => {
          deadline.abort(new Error('lark: human-input card update timed out'))
        }, timeoutMs)
      }
      const onShutdown = (): void => {
        armDeadline(Math.min(
          this.humanInputCardCloseTimeoutMs,
          HUMAN_INPUT_SHUTDOWN_CLOSE_TIMEOUT_MS,
        ))
      }
      shutdownSignal.addEventListener('abort', onShutdown, { once: true })
      if (shutdownSignal.aborted) onShutdown()
      else armDeadline(this.humanInputCardCloseTimeoutMs)
      const updating = Promise.resolve().then(() => this.client.updateCard!(
        messageId,
        renderHumanInputTerminalCard(outcome, this.locale),
        { signal: deadline.signal },
      ))
      try {
        await Promise.race([updating, aborted])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        shutdownSignal.removeEventListener('abort', onShutdown)
        deadline.signal.removeEventListener('abort', onAbort)
      }
    })()
      .catch(() => { this.ctx.logger.error('[lark] human-input card update failed') })
    this.trackDelivery(closing)
  }

  private closePendingHumanInputCard(pending: PendingHumanInput): void {
    if (pending.cardCloseStarted
      || pending.messageId === undefined
      || pending.settlement === undefined) return
    pending.cardCloseStarted = true
    this.closeHumanInputCard(pending.messageId, pending.settlement)
  }

  private closeHumanInputCard(
    messageId: string,
    settlement: HumanInputSettlement,
  ): void {
    if (settlement.immediateCard === false) {
      this.trackHumanInputCardClose(messageId, settlement.kind)
      return
    }
    // The callback response replaces the Card immediately. One delayed,
    // tracked PATCH repairs a response lost between the callback server and
    // Lark without racing the platform's action-response lock or retrying it.
    this.trackHumanInputCardClose(
      messageId,
      settlement.kind,
      HUMAN_INPUT_CARD_REPAIR_DELAY_MS,
    )
  }

  private async askLarkUser(
    request: HumanInputRequest,
    exec: ToolDispatchExecution,
    agent: Agent,
    route: MessageRoute,
    turnState: TurnState,
  ): Promise<HumanInputAnswer> {
    if (this.client.sendCard === undefined || this.client.updateCard === undefined) {
      throw new HumanInputExpectedError(
        'LARK_HUMAN_INPUT_UNAVAILABLE',
        'ask_user_question is unavailable on this Lark client',
      )
    }
    const sessionId = String(agent.id)
    if (this.pendingHumanInputSessions.has(sessionId)) {
      throw new HumanInputExpectedError(
        'LARK_HUMAN_INPUT_BUSY',
        'ask_user_question already has a pending question in this session',
      )
    }
    const requestId = randomUUID()
    let card: Record<string, unknown>
    try {
      card = renderHumanInputCard({ requestId, request, locale: this.locale })
    } catch {
      throw new HumanInputExpectedError(
        'LARK_HUMAN_INPUT_INVALID_REQUEST',
        'ask_user_question exceeds the supported Lark Card limits',
      )
    }
    const settled = Promise.withResolvers<HumanInputSettlement>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      pending.claim({ kind: 'cancelled', immediateCard: false })
    }
    const pending: PendingHumanInput = {
      requestId,
      sessionId,
      baseId: route.sessionBaseId,
      chatId: route.chatId,
      openId: route.openId,
      agent,
      turnState,
      request,
      state: 'sending',
      cardCloseStarted: false,
      claim: (settlement) => {
        if (pending.state === 'settled') return false
        pending.state = 'settled'
        pending.settlement = settlement
        if (timer !== undefined) clearTimeout(timer)
        exec.signal.removeEventListener('abort', onAbort)
        this.pendingHumanInputs.delete(requestId)
        this.pendingHumanInputSessions.delete(sessionId)
        if (pending.messageId !== undefined) this.pendingHumanInputMessages.delete(pending.messageId)
        // Register terminal delivery before resolving the tool wait. Root-fiber
        // teardown may otherwise drain an empty delivery set and close REST
        // before the await continuation gets a chance to enqueue this PATCH.
        this.closePendingHumanInputCard(pending)
        settled.resolve(settlement)
        return true
      },
    }
    this.pendingHumanInputs.set(requestId, pending)
    this.pendingHumanInputSessions.set(sessionId, pending)
    exec.signal.addEventListener('abort', onAbort, { once: true })
    if (exec.signal.aborted) onAbort()

    const acceptDelivery = (delivered: string | void): void => {
      if (typeof delivered !== 'string' || delivered === '') {
        pending.claim({ kind: 'unavailable', immediateCard: false })
        return
      }
      pending.messageId = delivered
      if (pending.state !== 'sending') {
        this.closePendingHumanInputCard(pending)
        return
      }
      pending.state = 'awaiting'
      this.pendingHumanInputMessages.set(delivered, pending)
      timer = setTimeout(() => {
        pending.claim({ kind: 'timed-out', immediateCard: false })
      }, this.humanInputTimeoutMs)
    }
    if (pending.state === 'sending') {
      let sending: Promise<string | void> | undefined
      try {
        sending = Promise.resolve(this.client.sendCard(
          route.chatId,
          card,
          { ...routeDeliveryOptions(route), signal: exec.signal },
        ))
      } catch {
        pending.claim({ kind: 'unavailable', immediateCard: false })
      }
      if (sending !== undefined) {
        this.trackDelivery(sending.then(() => {}, () => {}))
        try {
          acceptDelivery(await sending)
        } catch {
          pending.claim({ kind: 'unavailable', immediateCard: false })
        }
      }
    }
    const settlement = await settled.promise
    switch (settlement.kind) {
      case 'answered': return settlement.answer
      case 'cancelled': throw new HumanInputExpectedError(
        'LARK_HUMAN_INPUT_CANCELLED',
        'ask_user_question was cancelled before the user answered',
      )
      case 'timed-out': throw new HumanInputExpectedError(
        'LARK_HUMAN_INPUT_TIMEOUT',
        'ask_user_question timed out before the user answered',
      )
      case 'unavailable': throw new HumanInputExpectedError(
        'LARK_HUMAN_INPUT_UNAVAILABLE',
        'ask_user_question is unavailable in this Lark conversation',
      )
    }
  }

  private async handleAskUserQuestionTool(
    sessionId: ReturnType<typeof SessionId>,
    exec: ToolDispatchExecution,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    if (exec.name !== ASK_USER_QUESTION_NAME) return next()
    const definition = this.ctx.tools.get(exec.name, exec.agent)
    if (!isCompatibleAskUserQuestionDefinition(definition)) return next()
    const key = String(sessionId)
    const route = this.activeRoutes.get(key)
    const turnState = this.activeTurnState(key)
    if (route === undefined || turnState === undefined) return next()
    const activityId = exec.parent === undefined ? String(exec.callId) : `code:${String(exec.callId)}`
    const activityIndex = turnState.toolIndexes.get(activityId)
    const activity = activityIndex === undefined ? undefined : turnState.tools[activityIndex]
    if (activity?.name !== ASK_USER_QUESTION_NAME || activity.status !== 'running') return next()
    if (exec.agent === undefined) return next()
    let initiator: Agent | undefined
    try {
      initiator = this.ctx.agents.currentInitiator()
    } catch {
      return next()
    }
    if (initiator !== exec.agent) return next()
    if (exec.parent !== undefined) {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_CODE_MODE_UNSUPPORTED',
        'ask_user_question is not supported inside run_code on this Harness runtime',
      )
    }
    if (exec.signal.aborted) {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_STALE',
        'ask_user_question Lark turn is no longer active',
      )
    }
    const handle = await this.handles.get(key)
    if (handle === undefined
      || handle.agent !== exec.agent
      || this.ctx.agents.get(sessionId) !== exec.agent
      || !this.ctx.agents.roots().some((agent) => agent === exec.agent)
      || this.activeRoutes.get(key) !== route
      || this.activeTurnState(key) !== turnState
      || exec.signal.aborted) {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_STALE',
        'ask_user_question Lark ownership changed before presentation',
      )
    }
    let request: HumanInputRequest
    try {
      request = normalizeHumanInputRequest(
        (exec.arguments as { questions?: unknown } | undefined)?.questions,
      )
    } catch {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_INVALID_REQUEST',
        'ask_user_question arguments exceed the supported Lark input limits',
      )
    }
    if (sessionPersistenceOf(this.ctx) === undefined) {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_UNAVAILABLE',
        'ask_user_question requires durable Session persistence before presenting a Lark Card',
      )
    }
    let durable = false
    try {
      durable = await this.ctx.sessions.flush(exec.agent.session)
    } catch {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_UNAVAILABLE',
        'ask_user_question could not durably checkpoint the pending call',
      )
    }
    if (!durable) {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_UNAVAILABLE',
        'ask_user_question has no active Session durability participant',
      )
    }
    let currentInitiator: Agent | undefined
    try {
      currentInitiator = this.ctx.agents.currentInitiator()
    } catch {
      currentInitiator = undefined
    }
    if (currentInitiator !== exec.agent
      || this.ctx.agents.get(sessionId) !== exec.agent
      || this.activeRoutes.get(key) !== route
      || this.activeTurnState(key) !== turnState
      || exec.signal.aborted) {
      return humanInputFailure(
        'LARK_HUMAN_INPUT_STALE',
        'ask_user_question Lark ownership changed before presentation',
      )
    }
    let answer: HumanInputAnswer
    try {
      answer = await this.askLarkUser(request, exec, exec.agent, route, turnState)
    } catch (error) {
      if (error instanceof HumanInputExpectedError) {
        return humanInputFailure(error.code, error.message)
      }
      return humanInputFailure(
        'LARK_HUMAN_INPUT_INTERNAL',
        'ask_user_question could not complete in Lark',
      )
    }
    return {
      isError: false,
      value: {
        answers: answer.answers.map((item) => ({
          id: item.id,
          selected: [...item.selected],
          ...(item.custom === undefined ? {} : { custom: item.custom }),
        })),
      },
      content: [],
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
        const separator = target.search(/\s/u)
        const action = separator < 0 ? target : target.slice(0, separator)
        const actionInput = separator < 0 ? '' : target.slice(separator).trim()
        if (target === '' || target === 'list') {
          await this.showProjects(route)
        } else if (action === 'register') {
          await this.scheduleProjectRegistration(route, actionInput)
        } else if (action === 'remove') {
          await this.scheduleProjectRemoval(route, actionInput)
        } else {
          await this.scheduleProjectSwitch(route, target)
        }
        break
      }
      case '/session': {
        const target = text.slice(command.length).trim()
        const [action = '', input = '', ...extra] = target.split(/\s+/u)
        if (target === '') {
          await this.showSessions(route, 1)
        } else if (action === 'list' && extra.length === 0) {
          const page = sessionListPage(input)
          if (page === undefined) await this.safeSend(route.chatId, this.text.sessionUsage, routeDeliveryOptions(route))
          else await this.showSessions(route, page)
        } else if (action === 'resume' && SESSION_REFERENCE_PATTERN.test(input) && extra.length === 0) {
          await this.scheduleSessionResume(route, input)
        } else {
          await this.safeSend(route.chatId, this.text.sessionUsage, routeDeliveryOptions(route))
        }
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
        const canRegisterCurrent = this.canManageProjects(route)
          && !this.workspaceMutationRecoveryRequired
          && registry.create !== undefined
          && registry.delete !== undefined
          && registry.resolveByPath !== undefined
          && sessionPersistenceOf(this.ctx) !== undefined
          && this.conversationBindings !== undefined
          && route.mutationHash !== undefined
          && await canonicalProjectDirectory(conversation.handle.agent.session.header.cwd) !== undefined
        await this.safeSend(
          route.chatId,
          this.text.projectList(
            current?.id,
            workspaces,
            canRegisterCurrent,
          ),
          routeDeliveryOptions(route),
        )
      })
    } catch {
      this.ctx.logger.warn('[lark] project listing failed')
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
    } catch {
      this.ctx.logger.warn('[lark] current project resolution failed')
      return undefined
    }
  }

  private canManageProjects(route: MessageRoute): boolean {
    return route.chatType === 'p2p' && this.projectManageFrom.has(route.openId)
  }

  private async requireProjectManager(route: MessageRoute): Promise<boolean> {
    if (!this.projectManageFrom.has(route.openId)) {
      await this.safeSend(
        route.chatId,
        this.text.projectManagementDenied,
        routeDeliveryOptions(route),
      )
      return false
    }
    if (route.chatType !== 'p2p') {
      await this.safeSend(
        route.chatId,
        this.text.projectManagementDirectOnly,
        routeDeliveryOptions(route),
      )
      return false
    }
    return true
  }

  private scheduleProjectRegistration(route: MessageRoute, input: string): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, async () => {
      if (!await this.requireProjectManager(route)) return
      const title = projectRegistrationTitle(input)
      if (title === undefined) {
        await this.safeSend(route.chatId, this.text.projectRegisterUsage, routeDeliveryOptions(route))
        return
      }
      const result = await this.enqueueWorkspaceMutation(() => (
        this.withConversation(route.sessionBaseId, async (conversation) => {
          await this.sessionOperations.get(conversation.baseId)
          return this.registerCurrentProject(route, conversation, title)
        })
      ))
      await this.sendProjectRegistryResult(route, result)
    })
  }

  private async registerCurrentProject(
    route: MessageRoute,
    conversation: ConversationSession,
    title: string,
  ): Promise<ProjectRegistryCommandResult> {
    if (this.stopping || this.workspaceMutationRecoveryRequired) return { kind: 'unavailable' }
    const registry = workspaceRegistryOf(this.ctx)
    if (registry?.create === undefined
      || registry.delete === undefined
      || registry.resolveByPath === undefined
      || sessionPersistenceOf(this.ctx) === undefined
      || this.conversationBindings === undefined
      || route.mutationHash === undefined) return { kind: 'unavailable' }
    if (this.conversationBindings.read(conversation.baseId)?.mutationHashes.includes(
      route.mutationHash,
    )) return { kind: 'replayed' }

    const handle = conversation.handle
    const sessionId = conversation.sessionId
    const cwd = handle.agent.session.header.cwd
    const canonical = await canonicalProjectDirectory(cwd)

    const precommit = await this.precommitProjectRegistryMutation(route, conversation)
    if (precommit !== 'recorded') return { kind: precommit }
    if (this.stopping || this.commandAbort.signal.aborted) return { kind: 'unavailable' }
    if (canonical === undefined) return { kind: 'unavailable' }
    if (conversation.handle !== handle
      || conversation.sessionId !== sessionId
      || handle.agent.session.header.cwd !== cwd
      || await canonicalProjectDirectory(cwd) !== canonical) return { kind: 'unavailable' }

    let existingRaw: RegisteredWorkspace | undefined
    try {
      const resolved = await registry.resolveByPath(canonical)
      existingRaw = resolved === undefined ? undefined : registeredWorkspace(resolved)
    } catch {
      return { kind: 'register-failed' }
    }

    if (existingRaw !== undefined) {
      try {
        const workspace = await this.confirmWorkspaceRegistration(registry, existingRaw, canonical)
        if (conversation.handle !== handle
          || conversation.sessionId !== sessionId
          || handle.agent.session.header.cwd !== cwd
          || await canonicalProjectDirectory(cwd) !== canonical) return { kind: 'register-failed' }
        conversation.workspaceId = workspace.id
        return { kind: 'already-registered', workspace }
      } catch {
        return { kind: 'register-failed' }
      }
    }

    if (this.stopping || this.commandAbort.signal.aborted) return { kind: 'unavailable' }

    let created: unknown
    try {
      created = await registry.create(canonical, title)
    } catch {
      this.requireWorkspaceRemount(registry, 'project registration is unconfirmed')
      return { kind: 'register-failed' }
    }

    let workspace: RegisteredWorkspace
    try {
      workspace = await this.confirmWorkspaceRegistration(registry, created, canonical)
    } catch {
      const observed = await this.inspectWorkspaceRegistration(registry, canonical)
      if (observed.kind !== 'confirmed') {
        this.requireWorkspaceRemount(registry, 'project registration postcondition is unconfirmed')
        return { kind: 'register-failed' }
      }
      workspace = observed.workspace
    }
    if (conversation.handle !== handle
      || conversation.sessionId !== sessionId
      || handle.agent.session.header.cwd !== cwd
      || await canonicalProjectDirectory(cwd) !== canonical) {
      this.requireWorkspaceRemount(registry, 'project registration cwd changed during commit')
      return { kind: 'register-failed' }
    }
    conversation.workspaceId = workspace.id
    return {
      kind: workspace.title === title ? 'registered' : 'already-registered',
      workspace,
    }
  }

  private async inspectWorkspaceRegistration(
    registry: WorkspaceRegistryLike,
    canonical: string,
  ): Promise<{
    readonly kind: 'confirmed'
    readonly workspace: RegisteredWorkspace
  } | {
    readonly kind: 'absent'
  } | {
    readonly kind: 'ambiguous'
  }> {
    try {
      const resolved = await registry.resolveByPath?.(canonical)
      if (resolved !== undefined) {
        return {
          kind: 'confirmed',
          workspace: await this.confirmWorkspaceRegistration(registry, resolved, canonical),
        }
      }
      return listedWorkspaces(registry).some((workspace) => workspace.path === canonical)
        ? { kind: 'ambiguous' }
        : { kind: 'absent' }
    } catch {
      return { kind: 'ambiguous' }
    }
  }

  private async confirmWorkspaceRegistration(
    registry: WorkspaceRegistryLike,
    value: unknown,
    canonical: string,
  ): Promise<RegisteredWorkspace> {
    const workspace = registeredWorkspace(value)
    if (workspace.path !== canonical || await workspace.status() !== 'ok') {
      throw new Error('workspace registration postcondition failed')
    }
    const byId = registry.get(workspace.id)
    if (byId === undefined) throw new Error('workspace registration is absent by id')
    const confirmed = registeredWorkspace(byId)
    if (confirmed.id !== workspace.id || confirmed.path !== canonical) {
      throw new Error('workspace registration id/path mismatch')
    }
    const listed = listedWorkspaces(registry).filter((candidate) => candidate.id === workspace.id)
    if (listed.length !== 1 || listed[0]?.path !== canonical) {
      throw new Error('workspace registration list mismatch')
    }
    const resolved = registry.resolveByPath === undefined
      ? undefined
      : await registry.resolveByPath(canonical)
    if (resolved === undefined) throw new Error('workspace registration path resolution failed')
    const pathMatch = registeredWorkspace(resolved)
    if (pathMatch.id !== workspace.id || pathMatch.path !== canonical) {
      throw new Error('workspace registration path mismatch')
    }
    if (await realpath(canonical) !== canonical) {
      throw new Error('workspace registration canonical path changed')
    }
    return workspace
  }

  private scheduleProjectRemoval(route: MessageRoute, input: string): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, async () => {
      if (!await this.requireProjectManager(route)) return
      const id = input.trim()
      if (!validProjectIdInput(id)) {
        await this.safeSend(route.chatId, this.text.projectRemoveUsage, routeDeliveryOptions(route))
        return
      }
      const result = await this.enqueueWorkspaceMutation(() => (
        this.withConversation(route.sessionBaseId, async (conversation) => {
          await this.sessionOperations.get(conversation.baseId)
          return this.removeProjectRegistration(route, conversation, id)
        })
      ))
      await this.sendProjectRegistryResult(route, result)
    })
  }

  private async removeProjectRegistration(
    route: MessageRoute,
    conversation: ConversationSession,
    id: string,
  ): Promise<ProjectRegistryCommandResult> {
    if (this.stopping || this.workspaceMutationRecoveryRequired) return { kind: 'unavailable' }
    const registry = workspaceRegistryOf(this.ctx)
    if (registry?.create === undefined
      || registry.delete === undefined
      || registry.resolveByPath === undefined
      || sessionPersistenceOf(this.ctx) === undefined
      || this.conversationBindings === undefined
      || route.mutationHash === undefined) return { kind: 'unavailable' }
    if (this.conversationBindings.read(conversation.baseId)?.mutationHashes.includes(
      route.mutationHash,
    )) return { kind: 'replayed' }

    const precommit = await this.precommitProjectRegistryMutation(route, conversation)
    if (precommit !== 'recorded') return { kind: precommit }
    if (this.stopping || this.commandAbort.signal.aborted) return { kind: 'unavailable' }

    let workspace: RegisteredWorkspace | undefined
    try {
      workspace = listedWorkspaces(registry).find((candidate) => candidate.id === id)
      if (workspace === undefined) return { kind: 'unknown' }
      const current = registry.get(id)
      if (current === undefined) return { kind: 'unknown' }
      const confirmed = registeredWorkspace(current)
      if (confirmed.id !== workspace.id || confirmed.path !== workspace.path) {
        return { kind: 'unavailable' }
      }
    } catch {
      return { kind: 'unavailable' }
    }

    await this.quiesceWorkspaceAttachments(workspace.id)
    if (this.stopping || this.commandAbort.signal.aborted) return { kind: 'unavailable' }
    let deletionResult: boolean | undefined
    try {
      deletionResult = await registry.delete(workspace.id)
    } catch {
      this.requireWorkspaceRemount(registry, 'project registration removal is unconfirmed')
      return { kind: 'remove-failed' }
    }
    const removalState = this.inspectWorkspaceRemoval(registry, workspace)
    if (removalState === 'ambiguous') {
      this.requireWorkspaceRemount(registry, 'project registration removal is unconfirmed')
      return { kind: 'remove-failed' }
    }
    if (removalState === 'present') {
      if (deletionResult === false) return { kind: 'remove-failed' }
      this.requireWorkspaceRemount(registry, 'project registration removal postcondition failed')
      return { kind: 'remove-failed' }
    }
    this.invalidateWorkspaceRegistration(workspace.id)
    return { kind: 'removed', workspace }
  }

  private inspectWorkspaceRemoval(
    registry: WorkspaceRegistryLike,
    workspace: RegisteredWorkspace,
  ): 'absent' | 'present' | 'ambiguous' {
    try {
      const byIdRaw = registry.get(workspace.id)
      const listed = listedWorkspaces(registry).filter((candidate) => candidate.id === workspace.id)
      if (byIdRaw === undefined && listed.length === 0) return 'absent'
      if (byIdRaw === undefined || listed.length !== 1) return 'ambiguous'
      const byId = registeredWorkspace(byIdRaw)
      const fromList = listed[0]
      return byId.id === workspace.id
        && byId.path === workspace.path
        && fromList?.path === workspace.path
        ? 'present'
        : 'ambiguous'
    } catch {
      return 'ambiguous'
    }
  }

  private requireWorkspaceRemount(registry: WorkspaceRegistryLike, reason: string): void {
    this.workspaceMutationRecoveryRequired = true
    WORKSPACE_REGISTRIES_REQUIRING_REMOUNT.add(registry)
    this.pendingWorkspaceAttachments.clear()
    this.workspaceAttachmentRetries.clear()
    this.ctx.logger.error(`[lark] ${reason}; remount required`)
  }

  private async precommitProjectRegistryMutation(
    route: MessageRoute,
    conversation: ConversationSession,
  ): Promise<'recorded' | 'busy' | 'unavailable'> {
    const mutationHash = route.mutationHash
    if (this.stopping
      || this.commandAbort.signal.aborted
      || mutationHash === undefined
      || sessionPersistenceOf(this.ctx) === undefined
      || this.conversationBindings === undefined) return 'unavailable'
    const handle = conversation.handle
    const sessionId = conversation.sessionId
    let maintenance: Promise<'recorded' | 'busy' | 'unavailable'>
    try {
      maintenance = handle.agent.runMaintenance(async (signal) => {
        if (signal.aborted || handle.agent.inbox.hasPending) return 'busy'
        this.materializeFreshHandle(handle)
        const durable = await this.ctx.sessions.flush(handle.agent.session)
        if (durable !== true) return 'unavailable'
        if (signal.aborted
          || handle.agent.inbox.hasPending
          || conversation.handle !== handle
          || conversation.sessionId !== sessionId) return 'busy'
        const committed = this.conversationBindings?.read(conversation.baseId)
        if (committed !== undefined
          && String(boundSessionId(conversation.baseId, committed)) !== sessionId) {
          return 'unavailable'
        }
        await this.putConversationBinding(
          conversation.baseId,
          this.mutatedConversationBinding(
            conversation.baseId,
            sessionId,
            conversation.modelSelection,
            mutationHash,
          ),
        )
        if (this.stopping || this.commandAbort.signal.aborted) return 'unavailable'
        return 'recorded'
      })
    } catch {
      return 'busy'
    }
    try {
      return await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.error('[lark] project registry mutation precommit failed')
      return 'unavailable'
    }
  }

  private async quiesceWorkspaceAttachments(workspaceId: string): Promise<void> {
    const tasks = new Set<Promise<void>>()
    for (const [sessionId, pending] of this.pendingWorkspaceAttachments) {
      if (pending.workspaceId !== workspaceId) continue
      this.pendingWorkspaceAttachments.delete(sessionId)
      this.workspaceAttachmentRetries.delete(sessionId)
      const task = this.workspaceAttachmentTasks.get(sessionId)
      if (task !== undefined) tasks.add(task)
    }
    await Promise.all(tasks)
  }

  private invalidateWorkspaceRegistration(workspaceId: string): void {
    for (const conversation of this.conversations.values()) {
      if (conversation.workspaceId === workspaceId) conversation.workspaceId = undefined
    }
    for (const [sessionId, pending] of this.pendingWorkspaceAttachments) {
      if (pending.workspaceId !== workspaceId) continue
      this.pendingWorkspaceAttachments.delete(sessionId)
      this.workspaceAttachmentRetries.delete(sessionId)
    }
  }

  private async sendProjectRegistryResult(
    route: MessageRoute,
    result: ProjectRegistryCommandResult,
  ): Promise<void> {
    const options = routeDeliveryOptions(route)
    switch (result.kind) {
      case 'registered':
        await this.safeSend(route.chatId, this.text.projectRegistered(result.workspace), options)
        return
      case 'already-registered':
        await this.safeSend(route.chatId, this.text.projectAlreadyRegistered(result.workspace), options)
        return
      case 'removed':
        await this.safeSend(route.chatId, this.text.projectRemoved(result.workspace), options)
        return
      case 'busy':
        await this.safeSend(route.chatId, this.text.projectBusy, options)
        return
      case 'unknown':
        await this.safeSend(route.chatId, this.text.projectUnknown, options)
        return
      case 'replayed':
        await this.safeSend(route.chatId, this.text.projectRegistryMutationReplayed, options)
        return
      case 'unavailable':
        await this.safeSend(route.chatId, this.text.projectRegistrationUnavailable, options)
        return
      case 'register-failed':
        await this.safeSend(route.chatId, this.text.projectRegistrationFailed, options)
        return
      case 'remove-failed':
        await this.safeSend(route.chatId, this.text.projectRemovalFailed, options)
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
      const result = await this.enqueueWorkspaceMutation<ProjectSwitchCommandResult>(async () => {
        const resolved = await this.resolveProjectSelection(target)
        if (resolved.kind !== 'selected') return resolved
        return this.withConversation(route.sessionBaseId, async (conversation) => {
          await this.sessionOperations.get(conversation.baseId)
          return this.switchProject(route, conversation, resolved.selection)
        })
      })
      await this.sendProjectSwitchResult(route, result)
    })
  }

  private async resolveProjectSelection(
    target: string,
  ): Promise<ProjectSelectionResult> {
    let registry: WorkspaceRegistryLike | undefined
    let workspaces: RegisteredWorkspace[]
    try {
      if (this.stopping || this.workspaceMutationRecoveryRequired) {
        return { kind: 'unavailable' }
      }
      registry = workspaceRegistryOf(this.ctx)
      if (registry === undefined) {
        return { kind: 'unavailable' }
      }
      if (sessionPersistenceOf(this.ctx) === undefined || this.conversationBindings === undefined) {
        return { kind: 'unavailable' }
      }
      workspaces = listedWorkspaces(registry)
    } catch {
      this.ctx.logger.warn('[lark] project registry lookup failed')
      return { kind: 'unavailable' }
    }

    const idMatch = workspaces.find((workspace) => workspace.id === target)
    const titleMatches = idMatch === undefined
      ? workspaces.filter((workspace) => workspace.title === target)
      : []
    if (idMatch === undefined && titleMatches.length === 0) {
      return { kind: 'unknown' }
    }
    if (idMatch === undefined && titleMatches.length > 1) {
      return { kind: 'ambiguous' }
    }
    const selected = idMatch ?? titleMatches[0]
    if (selected === undefined) return { kind: 'unknown' }

    try {
      if (await selected.status() !== 'ok') {
        return { kind: 'missing', workspace: selected }
      }
      const resolved = registry.get(selected.id)
      if (resolved === undefined) return { kind: 'unknown' }
      const workspace = registeredWorkspace(resolved)
      if (workspace.id !== selected.id || workspace.path !== selected.path) {
        return { kind: 'unavailable' }
      }
      return { kind: 'selected', selection: { registry, workspaces, workspace } }
    } catch {
      this.ctx.logger.warn('[lark] project validation failed')
      return { kind: 'failed' }
    }
  }

  private async switchProject(
    route: MessageRoute,
    conversation: ConversationSession,
    selection: ProjectSelection,
  ): Promise<ProjectSwitchCommandResult> {
    const { registry, workspaces, workspace: selected } = selection

    const current = await this.currentWorkspace(conversation, registry, workspaces)
    if (current?.id === selected.id) {
      const mutation = await this.recordCurrentConversationMutation(route, conversation)
      if (mutation === 'busy') return { kind: 'busy' }
      if (mutation === 'failed') return { kind: 'history-failed' }
      return { kind: 'already-current', workspace: selected }
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
          this.ctx.logger.error('[lark] previous project session checkpoint failed')
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
        } catch {
          this.ctx.logger.warn('[lark] project revalidation failed')
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'busy' }

        let sessionId: ReturnType<typeof SessionId>
        let handle: AgentHandle
        let modelSelectionRef: ModelSelectionRef
        try {
          const { agentPreset } = activeSessionComposition(previousHandle.agent.session)
          const generation = this.nextSessionGeneration(baseId)
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
        } catch {
          this.ctx.logger.error('[lark] project session creation failed')
          return { kind: 'failed' }
        }

        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.disposeCandidateHandle(String(sessionId), handle)
          return { kind: 'busy' }
        }
        try {
          this.materializeFreshHandle(handle)
          const durable = await this.ctx.sessions.flush(handle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
        } catch {
          this.ctx.logger.error('[lark] project session checkpoint failed')
          await this.disposeCandidateHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.disposeCandidateHandle(String(sessionId), handle)
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
          this.ctx.logger.error('[lark] project binding commit failed')
          await this.disposeCandidateHandle(String(sessionId), handle)
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
      return { kind: 'busy' }
    }

    let result: ProjectSwitchMaintenanceResult
    try {
      result = await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      this.ctx.logger.error('[lark] project switch maintenance failed')
      return { kind: 'failed' }
    }
    switch (result.kind) {
      case 'committed':
        this.retireHandleAfterIdle(result.previousSessionId, result.previousHandle, 'project')
        return { kind: 'switched', workspace: result.workspace }
      case 'busy':
        return { kind: 'busy' }
      case 'history-failed':
        return { kind: 'history-failed' }
      case 'unavailable':
        return { kind: 'unavailable' }
      case 'unknown':
        return { kind: 'unknown' }
      case 'missing':
        return { kind: 'missing', workspace: selected }
      case 'failed':
        return { kind: 'failed' }
    }
  }

  private async sendProjectSwitchResult(
    route: MessageRoute,
    result: ProjectSwitchCommandResult,
  ): Promise<void> {
    const options = routeDeliveryOptions(route)
    switch (result.kind) {
      case 'switched':
        await this.safeSend(route.chatId, this.text.projectSwitched(result.workspace), options)
        return
      case 'already-current':
        await this.safeSend(route.chatId, this.text.projectAlreadyCurrent(result.workspace), options)
        return
      case 'missing':
        await this.safeSend(route.chatId, this.text.projectMissingDirectory(result.workspace), options)
        return
      case 'busy':
        await this.safeSend(route.chatId, this.text.projectBusy, options)
        return
      case 'history-failed':
        await this.safeSend(route.chatId, this.text.projectHistoryCheckpointFailed, options)
        return
      case 'ambiguous':
        await this.safeSend(route.chatId, this.text.projectAmbiguous, options)
        return
      case 'unavailable':
        await this.safeSend(route.chatId, this.text.projectUnavailable, options)
        return
      case 'unknown':
        await this.safeSend(route.chatId, this.text.projectUnknown, options)
        return
      case 'failed':
        await this.safeSend(route.chatId, this.text.projectSwitchFailed, options)
    }
  }

  private async recordCurrentConversationMutation(
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
          this.ctx.logger.error('[lark] current conversation binding does not match the live conversation')
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
      this.ctx.logger.error('[lark] current conversation mutation lookup failed: %s', messageOf(error))
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
          this.ctx.logger.error('[lark] current conversation mutation checkpoint failed: %s', messageOf(error))
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
      this.ctx.logger.error('[lark] current conversation mutation maintenance failed: %s', messageOf(error))
      return 'failed'
    }
  }

  private synchronousSessionAuthority(): SynchronousSessionAuthority {
    const registry = workspaceRegistryOf(this.ctx)
    if (registry === undefined || this.workspaceMutationRecoveryRequired || this.stopping) {
      throw new Error('lark: session navigation authority is unavailable')
    }
    const available = listedWorkspaces(registry).filter((workspace) => (
      workspaceContainsSessionCwdNow(workspace, workspace.path)
    ))
    return {
      registry,
      index: sessionWorkspaceIndex(
        available,
        registry.archivedSessionIds ?? [],
      ),
    }
  }

  private authorizeSessionCandidateNow(
    candidate: ConversationSessionCandidate,
    currentSessionId: string,
    allowedLiveSessionId: string | undefined,
    authority: SynchronousSessionAuthority,
  ): ConversationSessionCandidate | undefined {
    const id = String(candidate.sessionId)
    if (authority.index.archived.has(id)) return undefined
    const current = id === currentSessionId
    if (!current) {
      if (authority.index.truncated) return undefined
      if (id !== allowedLiveSessionId
        && (this.ctx.sessions.get(candidate.sessionId) !== undefined
          || this.ctx.agents.get(candidate.sessionId) !== undefined)) return undefined
      const owner = authority.index.bySession.get(id)
      if (owner === undefined
        || owner === null
        || candidate.workspace === undefined
        || owner.id !== candidate.workspace.id
        || owner.path !== candidate.workspace.path
        || !workspaceContainsSessionCwdNow(owner, candidate.cwd)) return undefined
      const currentOwnerRaw = authority.registry.get(owner.id)
      if (currentOwnerRaw === undefined) return undefined
      const currentOwner = registeredWorkspace(currentOwnerRaw)
      if (currentOwner.id !== owner.id
        || currentOwner.path !== owner.path
        || !currentOwner.sessionIds?.some((sessionId) => String(sessionId) === id)) return undefined
      return { ...candidate, workspace: currentOwner, current: false }
    }
    if (candidate.workspace === undefined) return { ...candidate, current: true }
    const currentWorkspaceRaw = authority.registry.get(candidate.workspace.id)
    if (currentWorkspaceRaw === undefined) {
      const { workspace: _workspace, ...unregistered } = candidate
      return { ...unregistered, current: true }
    }
    const currentWorkspace = registeredWorkspace(currentWorkspaceRaw)
    if (currentWorkspace.path !== candidate.workspace.path
      || !workspaceContainsSessionCwdNow(currentWorkspace, candidate.cwd)) {
      const { workspace: _workspace, ...unregistered } = candidate
      return { ...unregistered, current: true }
    }
    return { ...candidate, workspace: currentWorkspace, current: true }
  }

  private async indexedSessionWorkspaces(
    registry: WorkspaceRegistryLike,
  ): Promise<SessionWorkspaceIndex> {
    const workspaces: RegisteredWorkspace[] = []
    for (const workspace of listedWorkspaces(registry)) {
      if (await workspace.status() === 'ok') workspaces.push(workspace)
    }
    return sessionWorkspaceIndex(workspaces, registry.archivedSessionIds ?? [])
  }

  private async conversationSessionCandidates(
    baseId: string,
    currentSessionId: string,
    allowedLiveSessionId?: string,
  ): Promise<ConversationSessionCandidates> {
    const query = sessionQueryOf(this.ctx)
    const registry = workspaceRegistryOf(this.ctx)
    if (query === undefined || registry === undefined || this.workspaceMutationRecoveryRequired) {
      throw new Error('lark: session navigation services are unavailable')
    }
    const recordsRaw = await query.listSessions(this.commandAbort.signal)
    if (!Array.isArray(recordsRaw)) throw new TypeError('lark: sessionQuery.listSessions returned an invalid value')
    const records = recordsRaw.map(sessionQueryRecord).sort((left, right) => (
      right.header.createdAt - left.header.createdAt
        || String(left.header.id).localeCompare(String(right.header.id))
    ))
    const index = await this.indexedSessionWorkspaces(registry)
    const history: ConversationSessionCandidate[] = []
    let currentItem: ConversationSessionCandidate | undefined
    const references = new Set<string>()
    let truncated = index.truncated
    for (const record of records) {
      const id = String(record.header.id)
      const generation = sessionGeneration(baseId, id)
      if (generation === undefined
        || record.header.origin === 'subagent'
        || record.header.parentSession !== undefined
        || (record.header.delegationDepth ?? 0) !== 0
        || !record.persisted) continue
      const current = id === currentSessionId
      const indexedWorkspace = index.bySession.get(id)
      const currentWorkspaceMatches = indexedWorkspace === undefined && current
        ? index.workspaces.filter((candidate) => candidate.path === record.header.cwd)
        : []
      const workspace = currentWorkspaceMatches.length === 1
        ? currentWorkspaceMatches[0]
        : indexedWorkspace ?? undefined
      if (index.archived.has(id)) continue
      if (!current && (workspace === undefined || workspace === null)) continue
      if (!current && record.live && id !== allowedLiveSessionId) continue
      if (!current && history.length >= SESSION_CANDIDATE_LIMIT) {
        truncated = true
        continue
      }
      if (workspace !== undefined
        && workspace !== null
        && !await workspaceContainsSessionCwd(workspace, record.header.cwd)) continue
      const reference = sessionReference(this.sessionReferenceNamespace, baseId, id)
      if (references.has(reference)) throw new Error('lark: session reference collision')
      const candidate: ConversationSessionCandidate = {
        sessionId: SessionId(id),
        sourceHeader: record.header,
        generation,
        reference,
        createdAt: record.header.createdAt,
        ...(record.header.cwd === undefined ? {} : { cwd: record.header.cwd }),
        ...(record.header.agentPreset === undefined ? {} : { agentPreset: record.header.agentPreset }),
        ...(workspace === undefined || workspace === null ? {} : { workspace }),
        current,
      }
      if (current) {
        references.add(reference)
        currentItem = candidate
        continue
      }
      if (history.length >= SESSION_CANDIDATE_LIMIT) {
        truncated = true
        continue
      }
      references.add(reference)
      history.push(candidate)
    }
    if (currentItem !== undefined && history.length === SESSION_CANDIDATE_LIMIT) {
      const omitted = history.pop()
      if (omitted !== undefined) references.delete(omitted.reference)
      truncated = true
    }
    const bounded = currentItem === undefined ? history : [currentItem, ...history]
    const authority = this.synchronousSessionAuthority()
    const authorized: ConversationSessionCandidate[] = []
    for (const candidate of bounded) {
      const current = this.authorizeSessionCandidateNow(
        candidate,
        currentSessionId,
        allowedLiveSessionId,
        authority,
      )
      if (current !== undefined) authorized.push(current)
    }
    const maximum = maximumSessionGeneration(baseId, records.map((record) => record.header))
    this.lastSessionGenerations.set(
      baseId,
      Math.max(this.lastSessionGenerations.get(baseId) ?? 0, maximum),
    )
    return { items: authorized, truncated: truncated || authority.index.truncated }
  }

  private showSessions(route: MessageRoute, page: number): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, async () => {
      const deliveryOptions = routeDeliveryOptions(route)
      try {
        const live = this.conversations.get(route.sessionBaseId)
        const currentSessionId = live?.sessionId
          ?? String((await this.resolveSessionBinding(route.sessionBaseId)).sessionId)
        const candidates = await this.conversationSessionCandidates(route.sessionBaseId, currentSessionId)
        const totalPages = Math.max(1, Math.ceil(candidates.items.length / SESSION_LIST_PAGE_SIZE))
        if (page > totalPages) {
          await this.safeSend(route.chatId, this.text.sessionUsage, deliveryOptions)
          return
        }
        const start = (page - 1) * SESSION_LIST_PAGE_SIZE
        const visible = candidates.items.slice(start, start + SESSION_LIST_PAGE_SIZE)
        const query = sessionQueryOf(this.ctx)
        if (query === undefined) throw new Error('lark: sessionQuery is unavailable')
        const titleResults = await query.readTitleSnapshots(
          visible.map((candidate) => candidate.sessionId),
          this.commandAbort.signal,
        )
        if (!Array.isArray(titleResults) || titleResults.length !== visible.length) {
          throw new TypeError('lark: sessionQuery title results are invalid')
        }
        const listed: ListedConversationSession[] = visible.map((candidate, index) => {
          const result = titleResults[index] as SessionTitleResultLike | undefined
          if (result === undefined
            || result === null
            || typeof result !== 'object'
            || typeof result.sessionId !== 'string'
            || String(result.sessionId) !== String(candidate.sessionId)) {
            throw new TypeError('lark: sessionQuery title result order is invalid')
          }
          if (result.status === 'rejected') return candidate
          if (result.status !== 'fulfilled'
            || result.value === null
            || typeof result.value !== 'object') {
            throw new TypeError('lark: sessionQuery title result is invalid')
          }
          const observed = sessionQueryRecord({
            header: result.value.session,
            live: false,
            persisted: true,
          }).header
          if (!sameSessionSourceHeader(observed, candidate.sourceHeader)) {
            throw new TypeError('lark: sessionQuery title observation changed its source header')
          }
          const titleSnapshot = result.value.title
          if (titleSnapshot !== undefined
            && (titleSnapshot === null
              || typeof titleSnapshot !== 'object'
              || typeof titleSnapshot.title !== 'string')) {
            throw new TypeError('lark: sessionQuery title snapshot is invalid')
          }
          const title = titleSnapshot?.title
          return typeof title === 'string'
            && title.length <= SESSION_TITLE_SOURCE_CODE_UNIT_LIMIT
            && title.isWellFormed()
            ? { ...candidate, title }
            : candidate
        })
        const revalidated = await this.conversationSessionCandidates(
          route.sessionBaseId,
          currentSessionId,
        )
        const finalAuthority = this.synchronousSessionAuthority()
        for (const candidate of listed) {
          const current = revalidated.items.find((item) => (
            item.reference === candidate.reference
              && String(item.sessionId) === String(candidate.sessionId)
          ))
          const authorized = current === undefined
            ? undefined
            : this.authorizeSessionCandidateNow(
                current,
                currentSessionId,
                undefined,
                finalAuthority,
              )
          if (authorized === undefined
            || authorized.workspace?.id !== candidate.workspace?.id
            || !sameSessionSourceHeader(authorized.sourceHeader, candidate.sourceHeader)) {
            throw new Error('lark: session catalog authorization changed during title lookup')
          }
        }
        await this.safeSend(
          route.chatId,
          this.text.sessionList(
            page,
            totalPages,
            listed.map((candidate) => ({
              reference: candidate.reference,
              title: candidate.title,
              project: candidate.workspace?.title,
              createdAt: sessionCreatedAt(candidate.createdAt),
              current: candidate.current,
            })),
            candidates.truncated,
          ),
          deliveryOptions,
        )
      } catch {
        this.ctx.logger.warn('[lark] session list failed')
        await this.safeSend(route.chatId, this.text.sessionUnavailable, deliveryOptions)
      }
    })
  }

  private scheduleSessionResume(route: MessageRoute, reference: string): Promise<void> {
    return this.enqueueConversationOperation(route.sessionBaseId, async () => {
      if (route.mutationHash !== undefined
        && this.conversationBindings?.read(route.sessionBaseId)?.mutationHashes.includes(
          route.mutationHash,
        )) {
        await this.safeSend(route.chatId, this.text.sessionMutationReplayed, routeDeliveryOptions(route))
        return
      }
      const result = await this.enqueueWorkspaceMutation<SessionSwitchCommandResult>(() => (
        this.withConversation(route.sessionBaseId, async (conversation) => {
          await this.sessionOperations.get(conversation.baseId)
          return this.resumeConversationSession(route, conversation, reference)
        })
      ))
      await this.sendSessionSwitchResult(route, result)
    })
  }

  private async resumeConversationSession(
    route: MessageRoute,
    conversation: ConversationSession,
    reference: string,
  ): Promise<SessionSwitchCommandResult> {
    let selected: ConversationSessionCandidate | undefined
    try {
      const candidates = await this.conversationSessionCandidates(
        conversation.baseId,
        conversation.sessionId,
      )
      selected = candidates.items.find((candidate) => candidate.reference === reference)
    } catch {
      return { kind: 'unavailable' }
    }
    if (selected === undefined) return { kind: 'unknown' }
    if (selected.current) {
      const mutation = await this.recordCurrentConversationMutation(route, conversation)
      if (mutation === 'busy') return { kind: 'busy' }
      if (mutation === 'failed') return { kind: 'history-failed' }
      return { kind: 'already-current', candidate: selected }
    }
    return this.resumeHistoricalSession(route, conversation, selected)
  }

  private async resumeHistoricalSession(
    route: MessageRoute,
    conversation: ConversationSession,
    selected: ConversationSessionCandidate,
  ): Promise<SessionSwitchCommandResult> {
    const previousSessionId = conversation.sessionId
    const previousHandle = conversation.handle
    const baseId = conversation.baseId
    let maintenance: Promise<SessionSwitchMaintenanceResult>
    try {
      maintenance = previousHandle.agent.runMaintenance(async (signal) => {
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'busy' }
        const persistence = sessionPersistenceOf(this.ctx)
        if (persistence?.inspect === undefined || this.conversationBindings === undefined) {
          return { kind: 'unavailable' }
        }
        try {
          const durable = await this.ctx.sessions.flush(previousHandle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
          await this.putConversationBinding(
            baseId,
            this.currentConversationBinding(baseId, previousSessionId, conversation.modelSelection),
          )
        } catch (error) {
          if (error instanceof BindingConfirmationInterruptedError) throw error
          return { kind: 'history-failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) return { kind: 'busy' }

        let revalidated: ConversationSessionCandidate | undefined
        try {
          const candidates = await this.conversationSessionCandidates(baseId, previousSessionId)
          revalidated = candidates.items.find((candidate) => (
            candidate.reference === selected.reference
              && String(candidate.sessionId) === String(selected.sessionId)
              && sameSessionSourceHeader(candidate.sourceHeader, selected.sourceHeader)
              && !candidate.current
          ))
        } catch {
          return { kind: 'unavailable' }
        }
        if (revalidated === undefined || revalidated.workspace === undefined) {
          return { kind: 'unknown' }
        }
        const candidate = revalidated
        const candidateWorkspace = revalidated.workspace
        if (this.handles.has(String(candidate.sessionId))
          || this.ctx.agents.get(candidate.sessionId) !== undefined) return { kind: 'busy' }

        let handle: AgentHandle
        let modelSelection: ConversationModelSelection
        let modelSelectionRef: ModelSelectionRef
        try {
          modelSelection = await this.persistedModelSelection(
            persistence,
            candidate.sessionId,
            this.commandAbort.signal,
          )
            ?? this.defaultModelSelection()
          handle = await this.ensureHandle(
            candidate.sessionId,
            true,
            false,
            candidate.agentPreset,
            candidateWorkspace.path,
            modelSelection,
            this.commandAbort.signal,
          )
          modelSelectionRef = this.modelSelectionFor(handle)
        } catch {
          const candidateHandle = await this.handles.get(String(candidate.sessionId))?.catch(() => undefined)
          if (candidateHandle !== undefined) {
            this.retireCandidateHandleAfterIdle(String(candidate.sessionId), candidateHandle)
          }
          return { kind: 'failed' }
        }
        if (signal.aborted
          || previousHandle.agent.inbox.hasPending
          || conversation.handle !== previousHandle
          || conversation.sessionId !== previousSessionId) {
          this.retireCandidateHandleAfterIdle(String(candidate.sessionId), handle)
          return { kind: 'busy' }
        }

        let candidateMaintenance: Promise<SessionCandidateCommitResult>
        try {
          candidateMaintenance = handle.agent.runMaintenance(async (candidateSignal) => {
            if (candidateSignal.aborted
              || handle.agent.inbox.hasPending
              || signal.aborted
              || previousHandle.agent.inbox.hasPending
              || conversation.handle !== previousHandle
              || conversation.sessionId !== previousSessionId) return { kind: 'busy' }
            try {
              const durable = await this.ctx.sessions.flush(handle.agent.session)
              if (durable !== true) throw new Error('no durability listener participated')
            } catch {
              return { kind: 'failed' }
            }
            if (candidateSignal.aborted
              || handle.agent.inbox.hasPending
              || signal.aborted
              || previousHandle.agent.inbox.hasPending
              || conversation.handle !== previousHandle
              || conversation.sessionId !== previousSessionId) return { kind: 'busy' }
            let authorized: ConversationSessionCandidate | undefined
            try {
              const candidates = await this.conversationSessionCandidates(
                baseId,
                previousSessionId,
                String(candidate.sessionId),
              )
              const current = candidates.items.find((item) => (
                item.reference === candidate.reference
                  && String(item.sessionId) === String(candidate.sessionId)
              ))
              authorized = current === undefined
                ? undefined
                : this.authorizeSessionCandidateNow(
                    current,
                    previousSessionId,
                    String(candidate.sessionId),
                    this.synchronousSessionAuthority(),
                  )
            } catch {
              return { kind: 'unavailable' }
            }
            const authorizedWorkspace = authorized?.workspace
            if (authorized === undefined
              || authorizedWorkspace === undefined
              || authorizedWorkspace.id !== candidateWorkspace.id
              || !sameSessionSourceHeader(authorized.sourceHeader, candidate.sourceHeader)
              || !sameSessionSourceHeader(authorized.sourceHeader, handle.agent.session.header)) {
              return { kind: 'unknown' }
            }
            if (candidateSignal.aborted
              || handle.agent.inbox.hasPending
              || signal.aborted
              || previousHandle.agent.inbox.hasPending
              || conversation.handle !== previousHandle
              || conversation.sessionId !== previousSessionId) return { kind: 'busy' }
            try {
              await this.putConversationBinding(
                baseId,
                this.mutatedConversationBinding(
                  baseId,
                  String(authorized.sessionId),
                  modelSelection,
                  route.mutationHash,
                ),
              )
            } catch (error) {
              if (error instanceof BindingConfirmationInterruptedError) throw error
              return { kind: 'failed' }
            }
            return { kind: 'committed', candidate: authorized, workspace: authorizedWorkspace }
          })
        } catch {
          this.retireCandidateHandleAfterIdle(String(candidate.sessionId), handle)
          return { kind: 'busy' }
        }

        let candidateResult: SessionCandidateCommitResult
        try {
          candidateResult = await candidateMaintenance
        } catch (error) {
          this.retireCandidateHandleAfterIdle(String(candidate.sessionId), handle)
          if (error instanceof BindingConfirmationInterruptedError) throw error
          return { kind: 'failed' }
        }
        if (candidateResult.kind !== 'committed') {
          this.retireCandidateHandleAfterIdle(String(candidate.sessionId), handle)
          return candidateResult
        }
        const committedCandidate = candidateResult.candidate

        conversation.handle = handle
        conversation.sessionId = String(committedCandidate.sessionId)
        conversation.modelSelection = modelSelection
        conversation.modelSelectionRef = modelSelectionRef
        conversation.workspaceId = candidateResult.workspace.id
        this.lastSessionGenerations.set(
          baseId,
          Math.max(this.lastSessionGenerations.get(baseId) ?? 0, selected.generation),
        )
        this.clearSessionState(previousSessionId)
        return {
          kind: 'committed',
          candidate: committedCandidate,
          previousSessionId,
          previousHandle,
        }
      })
    } catch {
      return { kind: 'busy' }
    }

    let result: SessionSwitchMaintenanceResult
    try {
      result = await maintenance
    } catch (error) {
      if (error instanceof BindingConfirmationInterruptedError) throw error
      return { kind: 'failed' }
    }
    if (result.kind === 'committed') {
      this.retireHandleAfterIdle(result.previousSessionId, result.previousHandle, 'session')
      return { kind: 'resumed', candidate: result.candidate }
    }
    return result
  }

  private async sendSessionSwitchResult(
    route: MessageRoute,
    result: SessionSwitchCommandResult,
  ): Promise<void> {
    const options = routeDeliveryOptions(route)
    switch (result.kind) {
      case 'resumed':
        await this.safeSend(route.chatId, this.text.sessionResumed(), options)
        return
      case 'already-current':
        await this.safeSend(route.chatId, this.text.sessionAlreadyCurrent(), options)
        return
      case 'busy':
        await this.safeSend(route.chatId, this.text.sessionBusy, options)
        return
      case 'history-failed':
        await this.safeSend(route.chatId, this.text.sessionHistoryCheckpointFailed, options)
        return
      case 'unknown':
        await this.safeSend(route.chatId, this.text.sessionUnknown, options)
        return
      case 'unavailable':
        await this.safeSend(route.chatId, this.text.sessionUnavailable, options)
        return
      case 'failed':
        await this.safeSend(route.chatId, this.text.sessionResumeFailed, options)
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

  private enqueueWorkspaceMutation<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.workspaceMutationTail.then(task)
    const tail = operation.then(() => {}, () => {})
    this.workspaceMutationTail = tail
    return operation
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
          const generation = this.nextSessionGeneration(baseId)
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
          await this.disposeCandidateHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        try {
          this.materializeFreshHandle(handle)
          const durable = await this.ctx.sessions.flush(handle.agent.session)
          if (durable !== true) throw new Error('no durability listener participated')
        } catch (error) {
          this.ctx.logger.error('[lark] fresh session checkpoint failed: %s', messageOf(error))
          await this.disposeCandidateHandle(String(sessionId), handle)
          return { kind: 'failed' }
        }
        if (signal.aborted || previousHandle.agent.inbox.hasPending) {
          await this.disposeCandidateHandle(String(sessionId), handle)
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
          await this.disposeCandidateHandle(String(sessionId), handle)
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
    try {
      const registry = workspaceRegistryOf(this.ctx)
      if (registry === undefined) return
      await this.currentWorkspace(conversation, registry, listedWorkspaces(registry))
    } catch {
      this.ctx.logger.warn('[lark] fresh session project resolution failed')
    }
  }

  private deferWorkspaceAttachment(
    sessionId: string,
    workspaceId: string | undefined,
    workspacePath: string,
  ): void {
    if (workspaceId === undefined || this.workspaceMutationRecoveryRequired) return
    const pending = this.pendingWorkspaceAttachments.get(sessionId)
    if (pending?.workspaceId === workspaceId && pending.workspacePath === workspacePath) return
    this.pendingWorkspaceAttachments.set(sessionId, { workspaceId, workspacePath })
  }

  private prepareWorkspaceAttachment(conversation: ConversationSession): void {
    if (this.workspaceMutationRecoveryRequired) return
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
      if (workspace === undefined) {
        conversation.workspaceId = undefined
        return
      }
      conversation.workspaceId = workspace.id
      this.deferWorkspaceAttachment(conversation.sessionId, workspace.id, workspace.path)
    } catch {
      this.ctx.logger.warn('[lark] workspace attachment preparation failed')
    }
  }

  private scheduleWorkspaceAttachment(session: Session): void {
    if (this.stopping || this.workspaceMutationRecoveryRequired) return
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
      if (retry
        && !this.workspaceMutationRecoveryRequired
        && this.pendingWorkspaceAttachments.has(sessionId)) {
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
      if (this.workspaceMutationRecoveryRequired) return
      const durable = await this.ctx.sessions.flush(session)
      if (durable !== true) {
        throw new Error('no durability listener participated')
      }
      if (this.stopping
        || this.workspaceMutationRecoveryRequired
        || this.pendingWorkspaceAttachments.get(sessionId) !== pending) return
      const registry = workspaceRegistryOf(this.ctx)
      const resolved = registry?.get(pending.workspaceId)
      if (resolved === undefined) {
        if (this.pendingWorkspaceAttachments.get(sessionId) === pending) {
          this.pendingWorkspaceAttachments.delete(sessionId)
        }
        return
      }
      const workspace = registeredWorkspace(resolved)
      if (workspace.id !== pending.workspaceId || workspace.path !== pending.workspacePath) return
      if (await workspace.status() !== 'ok') return
      if (this.stopping
        || this.workspaceMutationRecoveryRequired
        || this.pendingWorkspaceAttachments.get(sessionId) !== pending) return
      await workspace.attachSession(session.id)
      if (this.pendingWorkspaceAttachments.get(sessionId) === pending) {
        this.pendingWorkspaceAttachments.delete(sessionId)
      }
    } catch {
      this.ctx.logger.warn(
        '[lark] durable workspace session attachment failed; leaving it unindexed',
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
      Math.max(this.lastSessionGenerations.get(baseId) ?? 0, binding.maxGeneration),
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
      const headers = await persistence.list()
      const matches = headers.filter((header) => String(header.id) === String(sessionId))
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
        maxGeneration: Math.max(committed.generation, maximumSessionGeneration(baseId, headers)),
        modelSelection,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      }
    }
    if (persistence === undefined) {
      return {
        sessionId: SessionId(baseId),
        persisted: false,
        generation: 0,
        maxGeneration: 0,
        modelSelection: null,
      }
    }
    if (typeof persistence.list !== 'function') {
      throw new TypeError('lark: sessionPersistence.list is unavailable')
    }
    const latest = latestSessionBinding(baseId, await persistence.list())
    if (latest === undefined) {
      return {
        sessionId: SessionId(baseId),
        persisted: false,
        generation: 0,
        maxGeneration: 0,
        modelSelection: null,
      }
    }
    return {
      ...latest,
      modelSelection: await this.persistedModelSelection(persistence, latest.sessionId),
    }
  }

  private async persistedModelSelection(
    persistence: SessionPersistenceLike,
    sessionId: ReturnType<typeof SessionId>,
    signal?: AbortSignal,
  ): Promise<ConversationModelSelection | null> {
    if (persistence.inspect === undefined) return null
    const inspected = await persistence.inspect(sessionId, signal)
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

  private nextSessionGeneration(baseId: string): number {
    const highWater = this.lastSessionGenerations.get(baseId) ?? 0
    if (highWater >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError('lark: session generation space is exhausted')
    }
    const generation = Math.max(Date.now(), highWater + 1)
    if (!Number.isSafeInteger(generation)) {
      throw new RangeError('lark: next session generation is invalid')
    }
    this.lastSessionGenerations.set(baseId, generation)
    return generation
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
    signal?: AbortSignal,
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
      signal,
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
    signal?: AbortSignal,
  ): Promise<AgentHandle> {
    signal?.throwIfAborted()
    const agentOptions = modelSelection ?? this.defaultModelSelection()
    const modelSelectionRef: ModelSelectionRef = {
      current: { provider: agentOptions.provider, model: agentOptions.model },
      assembled: undefined,
    }
    const presets = agentPresetsOf(this.ctx)
    const requestedPreset = persisted
      ? (presets === undefined
          ? undefined
          : await this.persistedAgentPreset(sessionId, persistedAgentPreset, signal))
      : optionalAgentPreset(persistedAgentPreset)
    signal?.throwIfAborted()
    const composition = await this.agentComposition(presets, requestedPreset)
    signal?.throwIfAborted()
    const setup = async (agentCtx: Context): Promise<void> => {
      installModelSelection(agentCtx, modelSelectionRef)
      await composition.setup?.(agentCtx)
      const scopedTools = (agentCtx as unknown as { tools?: {
        get?: Context['tools']['get']
      } }).tools
      const askDefinition = typeof scopedTools?.get === 'function'
        ? scopedTools.get.call(scopedTools, ASK_USER_QUESTION_NAME, agentCtx.agent)
        : undefined
      if (!isCompatibleAskUserQuestionDefinition(askDefinition)) {
        this.ctx.logger.warn(
          '[lark] structured human input unavailable for Agent: compatible ask_user_question tool missing or restricted',
        )
      }
      agentCtx.on('tools/execute', (exec, next) => (
        this.handleAskUserQuestionTool(sessionId, exec, next)
      ))
    }
    const handle = persisted
      ? await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        ...(signal === undefined ? {} : { signal }),
        setup,
      })
      : await this.ctx.agents.create({
        sessionId,
        meta: {
          cwd,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        agentOptions,
        ...(signal === undefined ? {} : { signal }),
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

  private async disposeCandidateHandle(sessionId: string, handle: AgentHandle): Promise<void> {
    this.clearSessionState(sessionId)
    try {
      await handle.dispose()
    } catch (error) {
      this.ctx.logger.error('[lark] candidate session disposal failed: %s', messageOf(error))
    } finally {
      this.handles.delete(sessionId)
    }
  }

  private retireCandidateHandleAfterIdle(sessionId: string, handle: AgentHandle): void {
    this.clearSessionState(sessionId)
    let retirement: Promise<void>
    try {
      retirement = handle.agent.whenIdle().then(async () => {
        if (this.stopping) return
        let durable = false
        try {
          durable = await handle.agent.runMaintenance(async (signal) => {
            if (signal.aborted || handle.agent.inbox.hasPending) return false
            try {
              const flushed = await this.ctx.sessions.flush(handle.agent.session)
              return flushed === true && !signal.aborted && !handle.agent.inbox.hasPending
            } catch {
              return false
            }
          })
        } catch {
          this.retireCandidateHandleAfterIdle(sessionId, handle)
          return
        }
        if (!durable) {
          this.ctx.logger.error('[lark] retired candidate session could not be confirmed durable; retaining its handle')
          return
        }
        if (handle.agent.status !== 'idle' || handle.agent.inbox.hasPending) {
          this.retireCandidateHandleAfterIdle(sessionId, handle)
          return
        }
        this.handles.delete(sessionId)
        await this.disposeReplacedHandle(sessionId, handle, 'candidate')
      })
    } catch {
      this.ctx.logger.error('[lark] candidate session retirement failed')
      return
    }
    this.handleRetirements.add(retirement)
    const cleanup = (): void => {
      this.handleRetirements.delete(retirement)
    }
    void retirement.then(cleanup, () => {
      cleanup()
      this.ctx.logger.error('[lark] candidate session retirement failed')
    })
  }

  private async disposeReplacedHandle(
    sessionId: string,
    handle: AgentHandle,
    reason: 'project' | 'reset' | 'session' | 'candidate',
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
    reason: 'project' | 'reset' | 'session' | 'candidate',
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
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const persistence = sessionPersistenceOf(this.ctx)
    if (persistence?.inspect === undefined) return optionalAgentPreset(headerPreset)
    const inspected = await persistence.inspect(sessionId, signal)
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
    this.pendingHumanInputSessions.get(sessionId)?.claim({
      kind: 'cancelled',
      immediateCard: false,
    })
  }

  private clearRoutes(): void {
    this.messageRoutes.clear()
    this.turnStarts.clear()
    this.turns.clear()
    this.activeRoutes.clear()
    this.contextWindows.clear()
    this.pendingStops.clear()
    this.pendingHumanInputs.clear()
    this.pendingHumanInputMessages.clear()
    this.pendingHumanInputSessions.clear()
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
