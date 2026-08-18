import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ImageBlock, LlmCallConfig, UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { LarkBridge } from '../src/bridge.ts'
import type { ConversationBinding } from '../src/conversation-binding.ts'
import type {
  LarkClientLike,
  LarkDeliveryOptions,
  LarkDownloadedResource,
  LarkInbound,
  LarkResourceDownloadOptions,
} from '../src/lark.ts'

interface SentText {
  readonly chatId: string
  readonly text: string
  readonly options?: LarkDeliveryOptions
}

type ModelClient = LarkClientLike & {
  readonly sent: SentText[]
  handler?: (message: LarkInbound) => Promise<void>
}

function createClient(): ModelClient {
  const client: ModelClient = {
    sent: [],
    async start() {},
    async stop() {},
    async sendText(chatId, text, options) { client.sent.push({ chatId, text, options }) },
    onMessage(handler) { client.handler = handler },
  }
  return client
}

let inboundSequence = 0

function inbound(chatId: string, text: string, messageId?: string): LarkInbound {
  inboundSequence += 1
  return {
    chatId,
    chatType: 'p2p',
    openId: 'owner',
    text,
    messageId: messageId ?? `model-${inboundSequence}`,
    mentioned: false,
  }
}

function groupInbound(
  partial: Partial<LarkInbound> & Pick<LarkInbound, 'chatId' | 'text' | 'messageId'>,
): LarkInbound {
  return {
    chatType: 'group',
    openId: 'owner',
    mentioned: true,
    ...partial,
  }
}

async function deliver(client: ModelClient, message: LarkInbound): Promise<void> {
  assert.ok(client.handler !== undefined)
  await client.handler(message)
}

async function send(
  client: ModelClient,
  chatId: string,
  text: string,
  messageId?: string,
): Promise<void> {
  await deliver(client, inbound(chatId, text, messageId))
}

interface ModelProvider {
  readonly id: string
  readonly name: string
}

interface ModelRow {
  readonly provider: string
  readonly id: string
  readonly name: string
}

type ResolvePlan = Error | LlmCallConfig | ((config: LlmCallConfig) => LlmCallConfig)

interface ModelCapability {
  readonly provider: string
  readonly id: string
  readonly name: string
  readonly inputModalities?: readonly string[]
}

type ModelInfoPlan = Error | ModelCapability | ((
  provider: string,
  model: string,
  signal?: AbortSignal,
) => ModelCapability | Promise<ModelCapability>)

class ModelRuntime {
  readonly providers: ModelProvider[] = []
  readonly models = new Map<string, ModelRow[] | Error>()
  readonly listModelsCalls: string[] = []
  readonly resolveCalls: LlmCallConfig[] = []
  readonly resolveModelInfoCalls: Array<{ readonly provider: string; readonly model: string }> = []
  private readonly resolvePlans: ResolvePlan[] = []
  private readonly modelInfoPlans: ModelInfoPlan[] = []
  private readonly modelCapabilities = new Map<string, ModelCapability | Error>()

  listProviders(): ModelProvider[] {
    return this.providers.map(provider => ({ ...provider }))
  }

  async listModels(provider: string): Promise<ModelRow[]> {
    this.listModelsCalls.push(provider)
    const rows = this.models.get(provider) ?? []
    if (rows instanceof Error) throw rows
    return rows.map(model => ({ ...model }))
  }

  planResolve(plan: ResolvePlan): void {
    this.resolvePlans.push(plan)
  }

  setModelCapability(
    provider: string,
    model: string,
    inputModalities: readonly string[] | undefined,
  ): void {
    this.modelCapabilities.set(`${provider}\0${model}`, {
      provider,
      id: model,
      name: model,
      ...(inputModalities === undefined ? {} : { inputModalities }),
    })
  }

  planModelInfo(plan: ModelInfoPlan): void {
    this.modelInfoPlans.push(plan)
  }

  async resolveCallConfig(config: LlmCallConfig): Promise<LlmCallConfig> {
    this.resolveCalls.push({ ...config })
    const plan = this.resolvePlans.shift()
    if (plan instanceof Error) throw plan
    if (typeof plan === 'function') return plan(config)
    return plan ?? config
  }

  async resolveModelInfo(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelCapability> {
    this.resolveModelInfoCalls.push({ provider, model })
    const plan = this.modelInfoPlans.shift()
      ?? this.modelCapabilities.get(`${provider}\0${model}`)
      ?? { provider, id: model, name: model, inputModalities: ['text'] }
    if (plan instanceof Error) throw plan
    return typeof plan === 'function' ? plan(provider, model, signal) : plan
  }
}

type ModelSession = Session

class ModelInbox {
  readonly nextStep: UserMessage[] = []
  readonly nextTurn: UserMessage[] = []

  get hasPending(): boolean {
    return this.nextStep.length > 0 || this.nextTurn.length > 0
  }

  set hasPending(value: boolean) {
    if (!value) {
      this.nextStep.length = 0
      this.nextTurn.length = 0
      return
    }
    if (this.hasPending) return
    this.nextStep.push(createUserMessage({
      content: [{ type: 'text', text: 'synthetic pending work' }],
      source: { kind: 'plugin', plugin: 'model-test' },
    }))
  }

  replace(messageId: UserMessage['id'], replacement: UserMessage): boolean {
    const index = this.nextStep.findIndex(({ id }) => id === messageId)
    if (index < 0) return false
    this.nextStep[index] = replacement
    return true
  }

  remove(messageId: UserMessage['id']): boolean {
    for (const inbox of [this.nextStep, this.nextTurn]) {
      const index = inbox.findIndex(({ id }) => id === messageId)
      if (index < 0) continue
      inbox.splice(index, 1)
      return true
    }
    return false
  }
}

class ModelAgent {
  readonly inbox = new ModelInbox()
  readonly ctx: Record<string, never> = {}
  readonly id: string
  status: 'idle' | 'running' = 'idle'
  disposed = false
  private maintenance = false

  constructor(
    readonly host: ModelHost,
    readonly session: ModelSession,
    readonly options: Readonly<{ provider: string; model: string }>,
  ) {
    this.id = session.id
  }

  followup(message: unknown): void {
    assert.equal(this.disposed, false, `followup reached disposed agent ${this.id}`)
    this.host.followups.push({ agent: this, message })
    this.session.append('user/message', message as UserMessage, { surfaceOp: 'append' })
    if (this.maintenance) this.inbox.hasPending = true
  }

  send(message: UserMessage, target: 'next-step' | 'next-turn', _wakeup: boolean): void {
    assert.equal(this.disposed, false, `send reached disposed agent ${this.id}`)
    const failure = this.host.takeAgentSendFailure()
    if (failure !== undefined) throw failure
    this.host.agentSends.push({ agent: this, message, target })
    const inbox = target === 'next-step' ? this.inbox.nextStep : this.inbox.nextTurn
    inbox.push(message)
  }

  cancel(): void {}

  whenIdle(): Promise<void> {
    return Promise.resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.maintenance) {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    this.maintenance = true
    return task(new AbortController().signal).finally(() => {
      this.maintenance = false
    })
  }
}

interface OpenRecord {
  readonly kind: 'create' | 'resume'
  readonly sessionId: string
  readonly agentOptions: Readonly<{ provider: string; model: string }>
  readonly agent: ModelAgent
}

type FlushPlan = boolean | Error

function cloneBinding(binding: ConversationBinding): ConversationBinding {
  return {
    generation: binding.generation,
    suffix: binding.suffix,
    modelSelection: binding.modelSelection === null ? null : { ...binding.modelSelection },
    mutationHashes: [...binding.mutationHashes],
  }
}

type ImageSavePlan = Error | ImageAttachmentRef | ((input: SaveImageAttachment) => Promise<ImageAttachmentRef>)

class ModelAttachmentStore {
  imageLimits: ImageAttachmentLimits = Object.freeze({
    maxImageBytes: 5 * 1024 * 1024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 100 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    mediaTypes: Object.freeze(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  })
  readonly saveCalls: SaveImageAttachment[] = []
  readonly readCalls: ImageAttachmentRef[] = []
  private readonly savePlans: ImageSavePlan[] = []

  planSave(plan: ImageSavePlan): void {
    this.savePlans.push(plan)
  }

  async validateImage(_input: SaveImageAttachment): Promise<void> {}

  async saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saveCalls.push(input)
    const plan = this.savePlans.shift()
    if (plan instanceof Error) throw plan
    if (typeof plan === 'function') return plan(input)
    return plan ?? {
      attachmentId: `sha256:${'c'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
  }

  async readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    this.readCalls.push(ref)
    return { ref, data: new Uint8Array(ref.bytes) }
  }
}

class ModelHost {
  readonly llm = new ModelRuntime()
  attachments: ModelAttachmentStore | undefined = new ModelAttachmentStore()
  readonly liveAgents = new Map<string, ModelAgent>()
  readonly liveSessions = new Map<string, ModelSession>()
  readonly persisted = new Map<string, ModelSession>()
  readonly bindings = new Map<string, ConversationBinding>()
  readonly bindingPuts: Array<{ readonly baseId: string; readonly binding: ConversationBinding }> = []
  readonly opens: OpenRecord[] = []
  readonly disposals: string[] = []
  readonly flushCalls: string[] = []
  readonly followups: Array<{ readonly agent: ModelAgent; readonly message: unknown }> = []
  readonly agentSends: Array<{
    readonly agent: ModelAgent
    readonly message: UserMessage
    readonly target: 'next-step' | 'next-turn'
  }> = []
  readonly completedInboundKeys: string[] = []
  readonly warnings: unknown[][] = []
  readonly errors: unknown[][] = []
  readonly runtimeExecutions: string[] = []
  runtimeAvailable = false
  private agentSendFailure: Error | undefined
  private inboundCompletionFailures = 0
  private readonly flushPlans: FlushPlan[] = []
  private bindingPutStart: (() => void) | undefined
  private bindingPutWait: Promise<void> | undefined
  private agentOpenStart: (() => void) | undefined
  private agentOpenWait: Promise<void> | undefined

  readonly ctx = {
    logger: {
      warn: (...args: unknown[]) => { this.warnings.push(args) },
      error: (...args: unknown[]) => { this.errors.push(args) },
    },
    on: (_name: string, _listener: (...args: never[]) => unknown) => () => {},
    get: (name: string) => {
      if (name === 'approval') return {}
      if (name === 'llm') return this.llm
      if (name === 'attachments') return this.attachments
      if (name === 'commands' && this.runtimeAvailable) {
        return {
          list: () => [
            { name: 'plan', description: 'plan work' },
            { name: 'compact', description: 'compact history' },
            { name: 'custom', description: 'custom command' },
          ],
          execute: async (_agent: ModelAgent, line: string) => {
            this.runtimeExecutions.push(line)
            return { result: { kind: 'success' as const, text: 'runtime executed' } }
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          list: async () => [...this.persisted.values()].map(session => ({
            id: session.id,
            cwd: session.header.cwd,
            agentPreset: session.header.agentPreset,
          })),
          inspect: async (id: unknown) => {
            const session = this.persisted.get(String(id))
            if (session === undefined) throw new Error(`session "${String(id)}" not found`)
            return { meta: session.header, events: session.events }
          },
        }
      }
      return undefined
    },
    agents: {
      create: (options: AgentOpenOptions) => this.open('create', options),
      resume: (options: AgentResumeOptions) => this.resume(options),
      get: (id: unknown) => this.liveAgents.get(String(id)),
      list: () => [...this.liveAgents.values()],
      roots: () => [...this.liveAgents.values()],
    },
    sessions: {
      get: (id: unknown) => this.liveSessions.get(String(id)),
      list: () => [...this.liveSessions.values()],
      flush: (session: ModelSession) => this.flush(session),
    },
  }

  planFlush(plan: FlushPlan): void {
    this.flushPlans.push(plan)
  }

  failNextInboundCompletion(): void {
    this.inboundCompletionFailures += 1
  }

  failNextAgentSend(error: Error): void {
    this.agentSendFailure = error
  }

  takeAgentSendFailure(): Error | undefined {
    const failure = this.agentSendFailure
    this.agentSendFailure = undefined
    return failure
  }

  async completeInbound(key: string): Promise<void> {
    if (this.inboundCompletionFailures > 0) {
      this.inboundCompletionFailures -= 1
      throw new Error('simulated inbound receipt failure')
    }
    this.completedInboundKeys.push(key)
  }

  holdNextBindingPut(start: () => void, wait: Promise<void>): void {
    this.bindingPutStart = start
    this.bindingPutWait = wait
  }

  holdNextAgentOpen(start: () => void, wait: Promise<void>): void {
    this.agentOpenStart = start
    this.agentOpenWait = wait
  }

  async putBinding(baseId: string, binding: ConversationBinding): Promise<void> {
    const start = this.bindingPutStart
    const wait = this.bindingPutWait
    this.bindingPutStart = undefined
    this.bindingPutWait = undefined
    start?.()
    await wait
    const snapshot = cloneBinding(binding)
    this.bindingPuts.push({ baseId, binding: snapshot })
    this.bindings.set(baseId, snapshot)
  }

  private newSession(
    id: string,
    header: { readonly cwd?: string; readonly agentPreset?: string },
    seed?: readonly SessionEvent[],
  ): ModelSession {
    const sessionId = SessionId(id)
    const sessionHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: Date.now(),
      ...header,
    }
    return Session.create(sessionId, seed, sessionHeader)
  }

  private async open(kind: 'create' | 'resume', options: AgentOpenOptions) {
    const openStart = this.agentOpenStart
    const openWait = this.agentOpenWait
    this.agentOpenStart = undefined
    this.agentOpenWait = undefined
    openStart?.()
    await openWait
    const sessionId = String(options.sessionId)
    const agentOptions = {
      provider: options.agentOptions?.provider ?? '',
      model: options.agentOptions?.model ?? '',
    }
    await options.setup?.({ on: () => () => {} })
    const session = this.newSession(
      sessionId,
      {
        ...(options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }),
        ...(options.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }),
      },
      options.seed,
    )
    const agent = new ModelAgent(this, session, agentOptions)
    this.liveSessions.set(sessionId, session)
    this.liveAgents.set(sessionId, agent)
    this.opens.push({ kind, sessionId, agentOptions, agent })
    let disposed = false
    return {
      agent,
      dispose: async () => {
        this.disposals.push(sessionId)
        if (disposed) return
        disposed = true
        agent.disposed = true
        if (this.liveAgents.get(sessionId) === agent) this.liveAgents.delete(sessionId)
        if (this.liveSessions.get(sessionId) === session) this.liveSessions.delete(sessionId)
      },
    }
  }

  private async resume(options: AgentResumeOptions) {
    const sessionId = String(options.resumeSessionId)
    const stored = this.persisted.get(sessionId)
    if (stored === undefined) throw new Error(`session "${sessionId}" not found`)
    return this.open('resume', {
      sessionId,
      agentOptions: options.agentOptions,
      meta: stored.header,
      seed: stored.events,
      setup: options.setup,
    })
  }

  private async flush(session: ModelSession): Promise<boolean> {
    this.flushCalls.push(session.id)
    const plan = this.flushPlans.shift() ?? true
    if (plan instanceof Error) throw plan
    if (plan) this.persisted.set(session.id, session)
    return plan
  }
}

interface AgentOpenOptions {
  readonly sessionId: unknown
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
  readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
  readonly seed?: readonly SessionEvent[]
  readonly setup?: (agentCtx: unknown) => Promise<unknown> | unknown
}

interface AgentResumeOptions {
  readonly resumeSessionId: unknown
  readonly agentOptions?: { readonly provider?: string; readonly model?: string }
  readonly setup?: (agentCtx: unknown) => Promise<unknown> | unknown
}

interface MountOptions {
  readonly provider?: string
  readonly model?: string
  readonly defaultSessionId?: string
  readonly inboundImages?: boolean
  readonly maxInboundImageBytes?: number
  readonly maxInboundImagePixels?: number
  readonly maxConversationImages?: number
  readonly maxConversationImageBytes?: number
}

async function mount(
  t: { after(callback: () => void | Promise<void>): void },
  options: MountOptions = {},
): Promise<{ readonly host: ModelHost; readonly client: ModelClient; readonly bridge: LarkBridge }> {
  const host = new ModelHost()
  const mounted = await mountHost(t, host, options)
  return { host, ...mounted }
}

async function mountHost(
  t: { after(callback: () => void | Promise<void>): void },
  host: ModelHost,
  options: MountOptions = {},
): Promise<{ readonly client: ModelClient; readonly bridge: LarkBridge }> {
  const client = createClient()
  const bridge = new LarkBridge(host.ctx as never, {
    client,
    inboundDeduplicator: {
      has: () => false,
      complete: key => host.completeInbound(key),
    },
    conversationBindings: {
      read: baseId => host.bindings.get(baseId),
      put: (baseId, binding) => host.putBinding(baseId, binding),
      async close() {},
    },
    allowFrom: ['owner'],
    locale: 'en-US',
    cwd: '/srv/model-tests',
    provider: options.provider ?? 'default-provider',
    model: options.model ?? 'default-model',
    defaultSessionId: options.defaultSessionId,
    inboundImages: options.inboundImages,
    maxInboundImageBytes: options.maxInboundImageBytes,
    maxInboundImagePixels: options.maxInboundImagePixels,
    maxConversationImages: options.maxConversationImages,
    maxConversationImageBytes: options.maxConversationImageBytes,
  })
  await bridge.start()
  t.after(() => bridge.stop())
  return { client, bridge }
}

function currentBinding(host: ModelHost, baseId: string): ConversationBinding {
  const binding = host.bindings.get(baseId)
  assert.ok(binding !== undefined)
  return binding
}

function assertModel(
  actual: Readonly<{ provider: string; model: string }> | null,
  provider: string,
  model: string,
): void {
  assert.deepEqual(actual, { provider, model })
}

const STANDARD_IMAGE_BLOCK: ImageBlock = Object.freeze({
  type: 'image',
  attachment: Object.freeze({
    attachmentId: `sha256:${'b'.repeat(64)}` as ImageBlock['attachment']['attachmentId'],
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
    name: 'model-switch.png',
  }),
})

const INBOUND_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

function inboundImage(chatId: string, messageId: string, key = 'img_v3_private_key'): LarkInbound {
  return {
    chatId,
    chatType: 'p2p',
    openId: 'owner',
    text: '',
    messageType: 'image',
    messageId,
    mentioned: false,
    resource: { kind: 'image', key },
  }
}

function appendImageSurface(session: ModelSession): number {
  return session.append('user/message', createUserMessage({
    content: [STANDARD_IMAGE_BLOCK],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' }).seq
}

function appendTextSurface(session: ModelSession, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

test('/model groups live catalogs and isolates a provider failure without exposing its error', async (t) => {
  const { host, client } = await mount(t, { provider: 'primary', model: 'chat' })
  host.llm.providers.push(
    { id: 'primary', name: 'Primary Provider' },
    { id: 'broken', name: 'Broken Provider' },
  )
  host.llm.models.set('primary', [
    { provider: 'primary', id: 'chat', name: 'Chat Model' },
    { provider: 'primary', id: 'reasoner', name: 'Reasoner Model' },
  ])
  host.llm.models.set('broken', new Error('credential sk-secret-value failed at https://private.invalid'))

  await send(client, 'catalog-chat', '/model')

  const listing = client.sent.at(-1)?.text ?? ''
  assert.match(listing, /Primary Provider \(primary\)/)
  assert.match(listing, /Chat Model \(chat\) \[current\]/)
  assert.match(listing, /Reasoner Model \(reasoner\)/)
  assert.match(listing, /Some provider catalogs failed to load/)
  assert.equal(listing.includes('sk-secret-value'), false)
  assert.equal(listing.includes('private.invalid'), false)
  assert.deepEqual(host.llm.listModelsCalls, ['primary', 'broken'])
  assert.equal(JSON.stringify(host.warnings).includes('sk-secret-value'), false)
  assert.equal(JSON.stringify(host.warnings).includes('private.invalid'), false)
})

test('an exact catalog-external model commits binding v2 state without replacing the Handle', async (t) => {
  const { host, client } = await mount(t)
  host.llm.providers.push({ id: 'dynamic', name: 'Dynamic' })
  host.llm.models.set('dynamic', [
    { provider: 'dynamic', id: 'advertised', name: 'Advertised' },
  ])
  const baseId = 'lark:exact-chat'

  await send(client, 'exact-chat', '/model dynamic private-preview', 'exact-switch')

  assert.deepEqual(host.llm.listModelsCalls, [], 'selection incorrectly treated the advisory catalog as a whitelist')
  assert.equal(host.opens.length, 1)
  const original = host.opens[0]
  assert.ok(original !== undefined)
  assert.deepEqual(original.agentOptions, { provider: 'default-provider', model: 'default-model' })
  assert.equal(original.agent.disposed, false)
  assert.deepEqual(host.disposals, [])
  const binding = currentBinding(host, baseId)
  assert.equal(binding.generation, 0)
  assert.equal(binding.suffix, null)
  assertModel(binding.modelSelection, 'dynamic', 'private-preview')
  assert.equal(binding.mutationHashes.length, 1)
  assert.match(binding.mutationHashes[0] ?? '', /^[0-9a-f]{64}$/u)

  await send(client, 'exact-chat', 'use the selected model', 'exact-followup')

  assert.equal(host.opens.length, 1)
  assert.equal(host.followups.at(-1)?.agent, original.agent)
})

test('selecting the current model records every mutation hash without rebuilding the Handle', async (t) => {
  const { host, client } = await mount(t)
  const baseId = 'lark:same-chat'

  await send(client, 'same-chat', '/model default-provider default-model', 'same-one')
  const firstAgent = host.opens[0]?.agent
  assert.ok(firstAgent !== undefined)
  const first = currentBinding(host, baseId)
  assert.equal(first.mutationHashes.length, 1)

  await send(client, 'same-chat', '/model default-provider default-model', 'same-two')

  const second = currentBinding(host, baseId)
  assert.equal(host.opens.length, 1)
  assert.equal(host.liveAgents.get(baseId), firstAgent)
  assert.equal(firstAgent.disposed, false)
  assert.deepEqual(host.disposals, [])
  assert.equal(second.mutationHashes.length, 2)
  assert.notEqual(second.mutationHashes[0], second.mutationHashes[1])
  assertModel(second.modelSelection, 'default-provider', 'default-model')
  assert.match(client.sent.at(-1)?.text ?? '', /already the current model/)
})

test('replaying an old model mutation after a later switch cannot roll the selection back', async (t) => {
  const { host, client, bridge } = await mount(t)
  const first = inbound('replay-chat', '/model route older', 'old-mutation')
  const later = inbound('replay-chat', '/model route newest', 'new-mutation')
  const baseId = 'lark:replay-chat'

  await deliver(client, first)
  await deliver(client, later)
  const committed = cloneBinding(currentBinding(host, baseId))
  assertModel(committed.modelSelection, 'route', 'newest')
  const puts = host.bindingPuts.length
  const resolves = host.llm.resolveCalls.length

  await bridge.stop()
  const restarted = await mountHost(t, host)
  const opens = host.opens.length
  await deliver(restarted.client, first)

  assert.deepEqual(currentBinding(host, baseId), committed)
  assert.equal(host.bindingPuts.length, puts)
  assert.equal(host.opens.length, opens)
  assert.equal(host.llm.resolveCalls.length, resolves)
  assert.match(restarted.client.sent.at(-1)?.text ?? '', /already handled/)
})

test('replaying the latest model mutation after restart does not cold-open an empty Session', async (t) => {
  const { host, client, bridge } = await mount(t)
  const command = inbound('empty-replay-chat', '/model route selected', 'empty-replay')
  const baseId = 'lark:empty-replay-chat'

  await deliver(client, command)
  const committed = cloneBinding(currentBinding(host, baseId))
  const puts = host.bindingPuts.length
  const resolves = host.llm.resolveCalls.length
  await bridge.stop()

  const restarted = await mountHost(t, host)
  const opens = host.opens.length
  await deliver(restarted.client, command)

  assert.deepEqual(currentBinding(host, baseId), committed)
  assert.equal(host.bindingPuts.length, puts)
  assert.equal(host.opens.length, opens)
  assert.equal(host.llm.resolveCalls.length, resolves)
  assert.match(restarted.client.sent.at(-1)?.text ?? '', /already handled/)
})

test('an older model replay cannot wake later pending work after the route returns', async (t) => {
  const { host, client } = await mount(t)
  const first = inbound('route-loop-chat', '/model route a', 'route-a-old')
  const second = inbound('route-loop-chat', '/model route b', 'route-b')
  const latest = inbound('route-loop-chat', '/model route a', 'route-a-new')
  const baseId = 'lark:route-loop-chat'

  host.failNextInboundCompletion()
  const firstFailure = await deliver(client, first).catch((error: unknown) => error)
  assert.ok(firstFailure instanceof Error)
  assert.equal(firstFailure.message, 'simulated inbound receipt failure')
  await deliver(client, second)
  await deliver(client, latest)
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)
  agent.inbox.hasPending = true
  const committed = cloneBinding(currentBinding(host, baseId))
  const opens = host.opens.length
  const puts = host.bindingPuts.length
  const resolves = host.llm.resolveCalls.length
  const capabilityResolves = host.llm.resolveModelInfoCalls.length

  await deliver(client, first)

  assert.deepEqual(currentBinding(host, baseId), committed)
  assert.equal(host.opens.length, opens)
  assert.equal(host.bindingPuts.length, puts)
  assert.equal(host.llm.resolveCalls.length, resolves)
  assert.equal(host.llm.resolveModelInfoCalls.length, capabilityResolves)
  assert.equal(agent.inbox.hasPending, true)
  assert.match(client.sent.at(-1)?.text ?? '', /already handled/)
})

test('private conversations isolate model state while defaultSessionId intentionally shares it', async (t) => {
  const isolated = await mount(t)
  await send(isolated.client, 'chat-a', '/model route model-a', 'isolated-a')
  await send(isolated.client, 'chat-b', '/model route model-b', 'isolated-b')

  assertModel(currentBinding(isolated.host, 'lark:chat-a').modelSelection, 'route', 'model-a')
  assertModel(currentBinding(isolated.host, 'lark:chat-b').modelSelection, 'route', 'model-b')
  await send(isolated.client, 'chat-a', 'resume a', 'resume-a')
  await send(isolated.client, 'chat-b', 'resume b', 'resume-b')
  assert.equal(isolated.host.opens.length, 2)

  const shared = await mount(t, { defaultSessionId: 'shared-model-session' })
  await send(shared.client, 'chat-a', '/model route shared-model', 'shared-switch')
  await send(shared.client, 'chat-b', 'continue from another chat', 'shared-followup')

  assert.deepEqual([...shared.host.bindings.keys()], ['shared-model-session'])
  assertModel(currentBinding(shared.host, 'shared-model-session').modelSelection, 'route', 'shared-model')
  assert.equal(shared.host.opens.length, 1)
  assert.equal(shared.host.opens[0]?.sessionId, 'shared-model-session')
})

test('group reply trees and native threads isolate their model selections', async (t) => {
  const { host, client } = await mount(t)
  const replyTreeId = 'lark:group-v1:group-chat:root:root-a'
  const threadId = 'lark:group-v1:group-chat:thread:thread-a'

  await deliver(client, groupInbound({
    chatId: 'group-chat',
    text: '/model route reply-tree-model',
    messageId: 'reply-tree-switch',
    rootId: 'root-a',
  }))
  await deliver(client, groupInbound({
    chatId: 'group-chat',
    text: '/model route thread-model',
    messageId: 'thread-switch',
    rootId: 'root-a',
    threadId: 'thread-a',
  }))

  assertModel(currentBinding(host, replyTreeId).modelSelection, 'route', 'reply-tree-model')
  assertModel(currentBinding(host, threadId).modelSelection, 'route', 'thread-model')
  assert.notEqual(host.liveAgents.get(replyTreeId), host.liveAgents.get(threadId))
})

test('/new inherits the conversation model into its fresh generation', async (t) => {
  const { host, client } = await mount(t)
  const baseId = 'lark:reset-chat'
  await send(client, 'reset-chat', '/model route inherited-model', 'inherit-model')

  await send(client, 'reset-chat', '/new', 'inherit-reset')

  const binding = currentBinding(host, baseId)
  assert.ok(binding.generation > 0)
  assert.notEqual(binding.suffix, null)
  assertModel(binding.modelSelection, 'route', 'inherited-model')
  assert.equal(binding.mutationHashes.length, 2)
  const generation = host.opens.findLast(record => record.kind === 'create' && record.sessionId !== baseId)
  assert.ok(generation !== undefined)
  assert.deepEqual(generation.agentOptions, { provider: 'route', model: 'inherited-model' })
  assert.equal(generation.sessionId, `${baseId}:${binding.suffix}`)
})

test('a legacy null binding pins its request-header model into a blank reset generation', async (t) => {
  const host = new ModelHost()
  const baseId = 'lark:legacy-model'
  const legacy = await host.ctx.agents.create({
    sessionId: baseId,
    agentOptions: { provider: 'configured', model: 'configured' },
  })
  legacy.agent.session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'historical', model: 'historical-model' } },
  })
  await host.ctx.sessions.flush(legacy.agent.session)
  await legacy.dispose()
  host.bindings.set(baseId, {
    generation: 0,
    suffix: null,
    modelSelection: null,
    mutationHashes: [],
  })
  const mounted = await mountHost(t, host)

  await send(mounted.client, 'legacy-model', '/new', 'legacy-reset')

  const binding = currentBinding(host, baseId)
  assertModel(binding.modelSelection, 'historical', 'historical-model')
  const generation = host.opens.findLast((record) => (
    record.kind === 'create' && record.sessionId !== baseId
  ))
  assert.deepEqual(generation?.agentOptions, {
    provider: 'historical',
    model: 'historical-model',
  })
})

test('resolve and flush failures retain the old model, binding, and live Handle', async (t) => {
  const { host, client } = await mount(t)
  host.llm.providers.push(
    { id: 'default-provider', name: 'Default Provider' },
    { id: 'route', name: 'Route Provider' },
  )
  host.llm.models.set('default-provider', [
    { provider: 'default-provider', id: 'default-model', name: 'Default Model' },
  ])
  host.llm.models.set('route', [
    { provider: 'route', id: 'next', name: 'Next Model' },
  ])
  await send(client, 'failure-chat', 'open the conversation', 'failure-open')
  const original = host.liveAgents.get('lark:failure-chat')
  assert.ok(original !== undefined)

  host.llm.planResolve(new Error('resolver leaked-secret-value'))
  await send(client, 'failure-chat', '/model route next', 'resolve-failure')
  assert.equal(host.liveAgents.get('lark:failure-chat'), original)
  assert.equal(original.disposed, false)
  assert.equal(host.bindings.has('lark:failure-chat'), false)
  assert.deepEqual(host.disposals, [])
  assert.equal(host.flushCalls.length, 0)
  assert.equal(JSON.stringify(host.warnings).includes('leaked-secret-value'), false)

  host.planFlush(false)
  await send(client, 'failure-chat', '/model route next', 'flush-failure')
  assert.equal(host.liveAgents.get('lark:failure-chat'), original)
  assert.equal(original.disposed, false)
  assert.equal(host.bindings.has('lark:failure-chat'), false)
  assert.deepEqual(host.disposals, [])
  assert.deepEqual(host.flushCalls, ['lark:failure-chat'])

  await send(client, 'failure-chat', '/model', 'failure-list')
  assert.match(client.sent.at(-1)?.text ?? '', /Current model: Default Model/)
})

test('running and pending work reject a model switch without replacing the Handle', async (t) => {
  const { host, client } = await mount(t)
  await send(client, 'busy-chat', 'open the conversation', 'busy-open')
  const original = host.liveAgents.get('lark:busy-chat')
  assert.ok(original !== undefined)

  original.status = 'running'
  await send(client, 'busy-chat', '/model route while-running', 'busy-running')
  assert.match(client.sent.at(-1)?.text ?? '', /running or pending work/i)
  assert.equal(host.liveAgents.get('lark:busy-chat'), original)
  assert.equal(host.bindings.has('lark:busy-chat'), false)
  assert.deepEqual(host.disposals, [])

  original.status = 'idle'
  original.inbox.hasPending = true
  await send(client, 'busy-chat', '/model route while-pending', 'busy-pending')
  assert.match(client.sent.at(-1)?.text ?? '', /running or pending work/i)
  assert.equal(host.liveAgents.get('lark:busy-chat'), original)
  assert.equal(host.bindings.has('lark:busy-chat'), false)
  assert.deepEqual(host.disposals, [])
})

test('work admitted during the final binding put stays on the selected live Handle', async (t) => {
  const { host, client } = await mount(t)
  await send(client, 'commit-race', 'open the conversation', 'race-open')
  const agent = host.liveAgents.get('lark:commit-race')
  assert.ok(agent !== undefined)
  const putStarted = Promise.withResolvers<void>()
  const releasePut = Promise.withResolvers<void>()
  host.holdNextBindingPut(() => putStarted.resolve(), releasePut.promise)

  const switching = send(client, 'commit-race', '/model route committed', 'race-switch')
  await putStarted.promise
  agent.followup({ id: 'external-during-put' })
  releasePut.resolve()
  await switching

  assert.equal(host.liveAgents.get('lark:commit-race'), agent)
  assert.equal(agent.disposed, false)
  assert.equal(agent.inbox.hasPending, true)
  assert.equal(host.followups.at(-1)?.agent, agent)
  assertModel(currentBinding(host, 'lark:commit-race').modelSelection, 'route', 'committed')
  assert.deepEqual(host.disposals, [])
})

test('an image surface rejects text-only and unknown model capabilities without changing binding or selection ref', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'vision' })
  const baseId = 'lark:image-downgrade'
  host.llm.setModelCapability('route', 'vision', ['text', 'image'])
  host.llm.setModelCapability('route', 'text-only', ['text'])
  host.llm.setModelCapability('route', 'unknown-input', undefined)
  await send(client, 'image-downgrade', '/model route vision', 'image-vision-current')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)
  const before = cloneBinding(currentBinding(host, baseId))

  await send(client, 'image-downgrade', '/model route text-only', 'image-to-text')
  assert.match(client.sent.at(-1)?.text ?? '', /contains images.*cannot switch/iu)
  assert.deepEqual(currentBinding(host, baseId), before)
  assert.equal(host.liveAgents.get(baseId), agent)

  await send(client, 'image-downgrade', '/model route unknown-input', 'image-to-unknown')
  assert.match(client.sent.at(-1)?.text ?? '', /contains images.*cannot switch/iu)
  assert.deepEqual(currentBinding(host, baseId), before)
  assert.equal(host.liveAgents.get(baseId), agent)

  const followups = host.followups.length
  await send(client, 'image-downgrade', 'continue on vision', 'image-ref-still-vision')
  assert.equal(host.followups.length, followups + 1, 'rejected switch changed the live model selection ref')
  assert.equal(host.followups.at(-1)?.agent, agent)
  assert.deepEqual(host.llm.resolveModelInfoCalls, [
    { provider: 'route', model: 'text-only' },
    { provider: 'route', model: 'unknown-input' },
    { provider: 'route', model: 'vision' },
  ])
})

test('an image surface permits an exact vision-to-vision switch on the same Handle', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'vision-a' })
  const baseId = 'lark:image-vision-switch'
  host.llm.setModelCapability('route', 'vision-a', ['text', 'image'])
  host.llm.setModelCapability('route', 'vision-b', ['image', 'text'])
  await send(client, 'image-vision-switch', '/model route vision-a', 'vision-a-current')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)

  await send(client, 'image-vision-switch', '/model route vision-b', 'vision-a-to-b')

  assertModel(currentBinding(host, baseId).modelSelection, 'route', 'vision-b')
  assert.equal(host.liveAgents.get(baseId), agent)
  assert.equal(agent.disposed, false)
  assert.deepEqual(host.disposals, [])
  assert.deepEqual(host.llm.resolveModelInfoCalls, [{ provider: 'route', model: 'vision-b' }])
  assert.match(client.sent.at(-1)?.text ?? '', /Switched to route \/ vision-b/u)

  const followups = host.followups.length
  await send(client, 'image-vision-switch', 'continue on vision b', 'vision-b-followup')
  assert.equal(host.followups.length, followups + 1)
  assert.equal(host.followups.at(-1)?.agent, agent)
})

test('a compaction replacement that shadows the image permits a text-only switch', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'vision' })
  const baseId = 'lark:image-shadowed-switch'
  host.llm.setModelCapability('route', 'text-only', ['text'])
  await send(client, 'image-shadowed-switch', '/help', 'shadow-open')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  const imageSeq = appendImageSurface(agent.session)
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'compacted image summary' }],
    source: { kind: 'user' },
  }), {
    surfaceOp: { op: 'replace', start: imageSeq, end: imageSeq },
    sourceEventSeqs: [imageSeq],
  })

  await send(client, 'image-shadowed-switch', '/model route text-only', 'shadow-to-text')

  assertModel(currentBinding(host, baseId).modelSelection, 'route', 'text-only')
  assert.equal(host.liveAgents.get(baseId), agent)
  assert.deepEqual(host.llm.resolveModelInfoCalls, [])
  assert.match(client.sent.at(-1)?.text ?? '', /Switched to route \/ text-only/u)
})

test('image capability lookup failure keeps the prior binding and Handle without leaking its error', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'vision' })
  const baseId = 'lark:image-capability-failure'
  await send(client, 'image-capability-failure', '/model route vision', 'capability-current')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)
  const before = cloneBinding(currentBinding(host, baseId))
  host.llm.planModelInfo(new Error('private capability credential marker'))

  await send(client, 'image-capability-failure', '/model route maybe-vision', 'capability-failed')

  assert.deepEqual(currentBinding(host, baseId), before)
  assert.equal(host.liveAgents.get(baseId), agent)
  assert.match(client.sent.at(-1)?.text ?? '', /compatibility cannot be confirmed/iu)
  assert.doesNotMatch(JSON.stringify(client.sent), /private capability credential marker/u)
  assert.doesNotMatch(JSON.stringify(host.warnings), /private capability credential marker/u)
  assert.deepEqual(host.llm.resolveModelInfoCalls, [{ provider: 'route', model: 'maybe-vision' }])
})

test('a cold image Session on a degraded text route rejects prompts until /model selects vision', async (t) => {
  const host = new ModelHost()
  const baseId = 'lark:cold-image-route'
  const stored = await host.ctx.agents.create({
    sessionId: baseId,
    agentOptions: { provider: 'route', model: 'text-only' },
  })
  appendImageSurface(stored.agent.session)
  await host.ctx.sessions.flush(stored.agent.session)
  await stored.dispose()
  host.bindings.set(baseId, {
    generation: 0,
    suffix: null,
    modelSelection: { provider: 'route', model: 'text-only' },
    mutationHashes: [],
  })
  host.llm.setModelCapability('route', 'text-only', ['text'])
  host.llm.setModelCapability('route', 'vision', ['text', 'image'])
  const { client } = await mountHost(t, host, { provider: 'route', model: 'text-only' })

  await send(client, 'cold-image-route', 'must not enter the text model', 'cold-text-prompt')
  assert.equal(host.followups.length, 0)
  assert.match(client.sent.at(-1)?.text ?? '', /current model does not explicitly support image input/iu)
  assertModel(currentBinding(host, baseId).modelSelection, 'route', 'text-only')
  const resumed = host.liveAgents.get(baseId)
  assert.ok(resumed !== undefined)

  await send(client, 'cold-image-route', '/model route vision', 'cold-select-vision')
  assertModel(currentBinding(host, baseId).modelSelection, 'route', 'vision')
  assert.equal(host.liveAgents.get(baseId), resumed)

  await send(client, 'cold-image-route', 'vision can continue', 'cold-vision-prompt')
  assert.equal(host.followups.length, 1)
  assert.equal(host.followups[0]?.agent, resumed)
  assert.deepEqual(host.llm.resolveModelInfoCalls, [
    { provider: 'route', model: 'text-only' },
    { provider: 'route', model: 'vision' },
    { provider: 'route', model: 'vision' },
  ])
})

test('a degraded image route blocks dynamic runtime commands and hides them from /help', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'text-only' })
  const baseId = 'lark:image-runtime-guard'
  host.runtimeAvailable = true
  host.llm.setModelCapability('route', 'text-only', ['text'])
  host.llm.setModelCapability('route', 'vision', ['text', 'image'])
  await send(client, 'image-runtime-guard', '/help', 'runtime-open')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)

  for (const [index, command] of ['/plan do work', '/compact', '/custom value'].entries()) {
    await send(client, 'image-runtime-guard', command, `runtime-blocked-${index}`)
    assert.match(client.sent.at(-1)?.text ?? '', /current model does not explicitly support image input/iu)
  }
  assert.deepEqual(host.runtimeExecutions, [])

  await send(client, 'image-runtime-guard', '/help', 'runtime-degraded-help')
  const help = client.sent.at(-1)?.text ?? ''
  assert.match(help, /current model does not explicitly support image input/iu)
  assert.doesNotMatch(help, /\/plan|\/compact|\/custom/u)

  await send(client, 'image-runtime-guard', '/model route vision', 'runtime-select-vision')
  await send(client, 'image-runtime-guard', '/custom value', 'runtime-after-recovery')
  assert.deepEqual(host.runtimeExecutions, ['/custom value'])
  assert.match(client.sent.at(-1)?.text ?? '', /runtime executed/u)
})

test('surface or inbox changes while image capability awaits make the model switch busy', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'vision-a' })
  const baseId = 'lark:image-capability-race'
  await send(client, 'image-capability-race', '/model route vision-a', 'race-current')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)
  const before = cloneBinding(currentBinding(host, baseId))

  const surfaceStarted = Promise.withResolvers<void>()
  const releaseSurface = Promise.withResolvers<void>()
  host.llm.planModelInfo(async (provider, model, signal) => {
    assert.equal(signal?.aborted, false)
    surfaceStarted.resolve()
    await releaseSurface.promise
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  })
  const surfaceSwitch = send(
    client,
    'image-capability-race',
    '/model route vision-b',
    'capability-surface-race',
  )
  await surfaceStarted.promise
  appendTextSurface(agent.session, 'surface changed during capability lookup')
  releaseSurface.resolve()
  await surfaceSwitch

  assert.match(client.sent.at(-1)?.text ?? '', /running or pending work/iu)
  assert.deepEqual(currentBinding(host, baseId), before)
  assert.equal(agent.inbox.hasPending, false)

  const inboxStarted = Promise.withResolvers<void>()
  const releaseInbox = Promise.withResolvers<void>()
  host.llm.planModelInfo(async (provider, model) => {
    inboxStarted.resolve()
    await releaseInbox.promise
    return { provider, id: model, name: model, inputModalities: ['image'] }
  })
  const inboxSwitch = send(
    client,
    'image-capability-race',
    '/model route vision-c',
    'capability-inbox-race',
  )
  await inboxStarted.promise
  agent.inbox.hasPending = true
  releaseInbox.resolve()
  await inboxSwitch

  assert.match(client.sent.at(-1)?.text ?? '', /running or pending work/iu)
  assert.deepEqual(currentBinding(host, baseId), before)
  assert.equal(host.liveAgents.get(baseId), agent)
  assert.deepEqual(host.llm.resolveModelInfoCalls, [
    { provider: 'route', model: 'vision-b' },
    { provider: 'route', model: 'vision-c' },
  ])
})

test('same-id inbox replacement during capability lookup prevents pending recovery commit', async (t) => {
  const { host, client } = await mount(t, { provider: 'route', model: 'vision-a' })
  const baseId = 'lark:image-inbox-replace-race'
  await send(client, 'image-inbox-replace-race', '/model route vision-a', 'replace-current')
  const agent = host.liveAgents.get(baseId)
  assert.ok(agent !== undefined)
  appendImageSurface(agent.session)
  const original = createUserMessage({
    content: [{ type: 'text', text: 'original pending content' }],
    source: { kind: 'plugin', plugin: 'replace-race' },
  })
  agent.inbox.nextStep.push(original)
  const before = cloneBinding(currentBinding(host, baseId))
  const lookupStarted = Promise.withResolvers<void>()
  const releaseLookup = Promise.withResolvers<void>()
  host.llm.planModelInfo(async (provider, model) => {
    lookupStarted.resolve()
    await releaseLookup.promise
    return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
  })
  const switching = send(
    client,
    'image-inbox-replace-race',
    '/model route vision-b',
    'replace-during-lookup',
  )
  await lookupStarted.promise
  const replacement = Object.freeze({
    ...createUserMessage({
      content: [{ type: 'text', text: 'replacement with the same id' }],
      source: { kind: 'plugin', plugin: 'replace-race' },
    }),
    id: original.id,
  }) as UserMessage
  assert.equal(agent.inbox.replace(original.id, replacement), true)
  releaseLookup.resolve()
  await switching

  assert.match(client.sent.at(-1)?.text ?? '', /running or pending work/iu)
  assert.deepEqual(currentBinding(host, baseId), before)
  assert.equal(agent.inbox.nextStep[0], replacement)
  assert.equal(host.liveAgents.get(baseId), agent)
})

test('an opted-in direct PNG is saved once and admitted as one image inbox message', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['text', 'image'])
  const downloads: Array<{
    messageId: string
    kind: string
    maxBytes: number
    aborted: boolean
  }> = []
  client.downloadMessageResource = async (messageId, resource, options) => {
    downloads.push({
      messageId,
      kind: resource.kind,
      maxBytes: options.maxBytes,
      aborted: options.signal.aborted,
    })
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  await deliver(client, inboundImage('image-direct', 'image-success', 'img_v3_never_persist'))

  const attachments = host.attachments
  assert.ok(attachments !== undefined)
  assert.deepEqual(downloads, [{
    messageId: 'image-success',
    kind: 'image',
    maxBytes: 5 * 1024 * 1024,
    aborted: false,
  }])
  assert.equal(attachments.saveCalls.length, 1)
  assert.equal(attachments.saveCalls[0]?.mediaType, 'image/png')
  assert.notEqual(attachments.saveCalls[0]?.data, INBOUND_PNG)
  assert.deepEqual([...(attachments.saveCalls[0]?.data ?? [])], [...INBOUND_PNG])
  assert.equal(host.agentSends.length, 1)
  assert.equal(host.agentSends[0]?.target, 'next-turn')
  assert.equal(host.agentSends[0]?.message.content[0]?.type, 'image')
  assert.equal(JSON.stringify(host.agentSends.map(({ message, target }) => ({
    message,
    target,
  }))).includes('img_v3_never_persist'), false)
  assert.equal(JSON.stringify(host.warnings).includes('img_v3_never_persist'), false)
  assert.deepEqual(host.llm.resolveModelInfoCalls, [
    { provider: 'route', model: 'vision' },
    { provider: 'route', model: 'vision' },
  ])
})

test('inbound image admission owns downloaded bytes before asynchronous storage', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const downloaded = Buffer.from(INBOUND_PNG)
  client.downloadMessageResource = async () => ({ data: downloaded, mediaType: 'image/png' })
  const service = host.attachments
  assert.ok(service !== undefined)
  const saveStarted = Promise.withResolvers<void>()
  const releaseSave = Promise.withResolvers<void>()
  service.planSave(async (input) => {
    saveStarted.resolve()
    await releaseSave.promise
    assert.notEqual(input.data, downloaded)
    assert.deepEqual([...input.data], [...INBOUND_PNG])
    return {
      attachmentId: `sha256:${'6'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
  })

  const delivery = deliver(client, inboundImage('image-owned-bytes', 'image-owned-bytes-message'))
  await saveStarted.promise
  downloaded.fill(0)
  releaseSave.resolve()
  await delivery

  assert.equal(service.saveCalls.length, 1)
  assert.equal(host.agentSends.length, 1)
  assert.equal(host.agentSends[0]?.message.content[0]?.type, 'image')
})

test('a text-only route rejects an inbound image before download or storage', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'text-only', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'text-only', ['text'])
  let downloads = 0
  client.downloadMessageResource = async () => {
    downloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  await deliver(client, inboundImage('image-text-only', 'image-rejected'))

  assert.equal(downloads, 0)
  assert.equal(host.attachments?.saveCalls.length, 0)
  assert.deepEqual(host.agentSends, [])
  assert.match(client.sent.at(-1)?.text ?? '', /does not explicitly support image input/iu)
})

test('missing image capabilities or attachment storage reject before download', async (t) => {
  const missingCapability = await mount(t, {
    provider: 'route', model: 'unknown-input', inboundImages: true,
  })
  missingCapability.host.llm.setModelCapability('route', 'unknown-input', undefined)
  let capabilityDownloads = 0
  missingCapability.client.downloadMessageResource = async () => {
    capabilityDownloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  await deliver(
    missingCapability.client,
    inboundImage('image-missing-capability', 'image-missing-capability-message'),
  )

  assert.equal(capabilityDownloads, 0)
  assert.equal(missingCapability.host.attachments?.saveCalls.length, 0)
  assert.deepEqual(missingCapability.host.agentSends, [])
  assert.match(
    missingCapability.client.sent.at(-1)?.text ?? '',
    /does not explicitly support image input/iu,
  )

  const missingStorage = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  missingStorage.host.llm.setModelCapability('route', 'vision', ['image'])
  missingStorage.host.attachments = undefined
  let storageDownloads = 0
  missingStorage.client.downloadMessageResource = async () => {
    storageDownloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  await deliver(
    missingStorage.client,
    inboundImage('image-missing-storage', 'image-missing-storage-message'),
  )

  assert.equal(storageDownloads, 0)
  assert.deepEqual(missingStorage.host.agentSends, [])
  assert.match(missingStorage.client.sent.at(-1)?.text ?? '', /cannot be admitted safely/iu)
})

test('the global inbound-image slot rejects another chat without queueing a download', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const firstDownload = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  const downloads: string[] = []
  client.downloadMessageResource = async (messageId) => {
    downloads.push(messageId)
    firstDownload.resolve()
    await releaseFirst.promise
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  const first = deliver(client, inboundImage('image-slot-a', 'image-slot-first'))
  await firstDownload.promise
  await deliver(client, inboundImage('image-slot-b', 'image-slot-second'))

  assert.deepEqual(downloads, ['image-slot-first'])
  assert.equal(host.opens.length, 1)
  assert.match(client.sent.at(-1)?.text ?? '', /another image is being processed/iu)
  releaseFirst.resolve()
  await first
  assert.equal(host.attachments?.saveCalls.length, 1)
  assert.equal(host.agentSends.length, 1)
})

test('the global inbound-image slot rejects another chat while the first Agent cold-opens', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const openStarted = Promise.withResolvers<void>()
  const releaseOpen = Promise.withResolvers<void>()
  host.holdNextAgentOpen(() => openStarted.resolve(), releaseOpen.promise)
  const downloads: string[] = []
  client.downloadMessageResource = async (messageId) => {
    downloads.push(messageId)
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  const first = deliver(client, inboundImage('image-open-a', 'image-open-first'))
  await openStarted.promise
  await deliver(client, inboundImage('image-open-b', 'image-open-second'))

  assert.deepEqual(downloads, [])
  assert.deepEqual(host.opens, [])
  assert.match(client.sent.at(-1)?.text ?? '', /another image is being processed/iu)
  releaseOpen.resolve()
  await first
  assert.deepEqual(downloads, ['image-open-first'])
  assert.equal(host.opens.length, 1)
  assert.equal(host.agentSends.length, 1)
})

test('shutdown during an inbound-image cold-open commits no notice, admission, or receipt', async (t) => {
  const { host, client, bridge } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const openStarted = Promise.withResolvers<void>()
  const releaseOpen = Promise.withResolvers<void>()
  host.holdNextAgentOpen(() => openStarted.resolve(), releaseOpen.promise)
  let downloads = 0
  client.downloadMessageResource = async () => {
    downloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  const delivery = deliver(client, inboundImage('image-open-stop', 'image-open-stop-message'))
  await openStarted.promise
  let stopped = false
  const stopping = bridge.stop().then(() => { stopped = true })
  await yieldImmediate()
  assert.equal(stopped, false)
  releaseOpen.resolve()
  const error = await delivery.catch((reason: unknown) => reason)
  await stopping

  assert.ok(error instanceof Error)
  assert.equal(downloads, 0)
  assert.deepEqual(client.sent, [])
  assert.deepEqual(host.agentSends, [])
  assert.deepEqual(host.completedInboundKeys, [])
  assert.equal((bridge as unknown as { inboundImageSlotTaken: boolean }).inboundImageSlotTaken, false)
})

test('a Session surface change during image download prevents save and admission', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const downloadStarted = Promise.withResolvers<void>()
  const releaseDownload = Promise.withResolvers<void>()
  client.downloadMessageResource = async () => {
    downloadStarted.resolve()
    await releaseDownload.promise
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  const delivery = deliver(client, inboundImage('image-surface-race', 'image-surface'))
  await downloadStarted.promise
  const agent = host.opens[0]?.agent
  assert.ok(agent !== undefined)
  appendTextSurface(agent.session, 'external surface mutation during image download')
  releaseDownload.resolve()
  await delivery

  assert.equal(host.attachments?.saveCalls.length, 0)
  assert.deepEqual(host.agentSends, [])
  assert.match(client.sent.at(-1)?.text ?? '', /another image is being processed/iu)
})

test('shutdown after an abort-ignoring image download commits no notice, admission, or receipt', async (t) => {
  const { host, client, bridge } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const downloadStarted = Promise.withResolvers<void>()
  const releaseDownload = Promise.withResolvers<void>()
  client.downloadMessageResource = async () => {
    downloadStarted.resolve()
    await releaseDownload.promise
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  const delivery = deliver(client, inboundImage('image-download-stop', 'image-download-stop-message'))
  await downloadStarted.promise
  let stopped = false
  const stopping = bridge.stop().then(() => { stopped = true })
  await yieldImmediate()
  assert.equal(stopped, false)
  releaseDownload.resolve()
  const error = await delivery.catch((reason: unknown) => reason)
  await stopping

  assert.ok(error instanceof Error)
  assert.equal(host.attachments?.saveCalls.length, 0)
  assert.deepEqual(client.sent, [])
  assert.deepEqual(host.agentSends, [])
  assert.deepEqual(host.completedInboundKeys, [])
  assert.equal((bridge as unknown as { inboundImageSlotTaken: boolean }).inboundImageSlotTaken, false)
})

test('attachment service replacement after save leaves only an orphan and no ImageBlock', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  client.downloadMessageResource = async () => ({ data: INBOUND_PNG, mediaType: 'image/png' })
  const original = host.attachments
  assert.ok(original !== undefined)
  const saveStarted = Promise.withResolvers<void>()
  const releaseSave = Promise.withResolvers<void>()
  original.planSave(async (input) => {
    saveStarted.resolve()
    await releaseSave.promise
    return {
      attachmentId: `sha256:${'d'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
  })

  const delivery = deliver(client, inboundImage('image-service-race', 'image-service'))
  await saveStarted.promise
  host.attachments = new ModelAttachmentStore()
  releaseSave.resolve()
  await delivery

  assert.equal(original.saveCalls.length, 1)
  assert.equal(host.attachments.saveCalls.length, 0)
  assert.deepEqual(host.agentSends, [])
  assert.match(client.sent.at(-1)?.text ?? '', /another image is being processed/iu)
})

test('attachment policy mutation during save leaves only an orphan and no ImageBlock', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  client.downloadMessageResource = async () => ({ data: INBOUND_PNG, mediaType: 'image/png' })
  const service = host.attachments
  assert.ok(service !== undefined)
  const saveStarted = Promise.withResolvers<void>()
  const releaseSave = Promise.withResolvers<void>()
  service.planSave(async (input) => {
    saveStarted.resolve()
    await releaseSave.promise
    return {
      attachmentId: `sha256:${'7'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
  })

  const delivery = deliver(client, inboundImage('image-policy-race', 'image-policy-message'))
  await saveStarted.promise
  service.imageLimits = Object.freeze({
    ...service.imageLimits,
    maxMessageImageBytes: service.imageLimits.maxMessageImageBytes - 1,
  })
  releaseSave.resolve()
  await delivery

  assert.equal(service.saveCalls.length, 1)
  assert.deepEqual(host.agentSends, [])
  assert.equal(host.completedInboundKeys.length, 1)
  assert.match(client.sent.at(-1)?.text ?? '', /another image is being processed/iu)
})

test('conversation image count is enforced before another resource download', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true, maxConversationImages: 1,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  let downloads = 0
  client.downloadMessageResource = async () => {
    downloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }
  await deliver(client, inboundImage('image-count', 'image-count-first'))
  const agent = host.opens[0]?.agent
  assert.ok(agent !== undefined)
  const admitted = agent.inbox.nextTurn.shift()
  assert.ok(admitted !== undefined)
  agent.session.append('user/message', admitted, { surfaceOp: 'append' })

  await deliver(client, inboundImage('image-count', 'image-count-second'))

  assert.equal(downloads, 1)
  assert.equal(host.attachments?.saveCalls.length, 1)
  assert.equal(host.agentSends.length, 1)
  assert.match(client.sent.at(-1)?.text ?? '', /image count or byte limit/iu)
})

test('invalid image bytes and malformed attachment limits fail before save or admission', async (t) => {
  const invalid = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  invalid.host.llm.setModelCapability('route', 'vision', ['image'])
  invalid.client.downloadMessageResource = async () => ({
    data: Buffer.from('GIF89a'),
    mediaType: 'image/gif',
  })
  await deliver(invalid.client, inboundImage('image-invalid', 'image-invalid-gif'))
  assert.equal(invalid.host.attachments?.saveCalls.length, 0)
  assert.deepEqual(invalid.host.agentSends, [])
  assert.match(invalid.client.sent.at(-1)?.text ?? '', /static PNG or JPEG/iu)

  const malformed = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  malformed.host.llm.setModelCapability('route', 'vision', ['image'])
  const service = malformed.host.attachments
  assert.ok(service !== undefined)
  service.imageLimits = { ...service.imageLimits, maxImageBytes: 0 }
  let downloads = 0
  malformed.client.downloadMessageResource = async () => {
    downloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }
  await deliver(malformed.client, inboundImage('image-limits', 'image-malformed-limits'))
  assert.equal(downloads, 0)
  assert.equal(service.saveCalls.length, 0)
  assert.match(malformed.client.sent.at(-1)?.text ?? '', /cannot be admitted safely/iu)
})

test('attachment service byte limits reduce the resource download cap', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  const service = host.attachments
  assert.ok(service !== undefined)
  service.imageLimits = { ...service.imageLimits, maxImageBytes: 32 }
  let requestedMax = 0
  client.downloadMessageResource = async (_messageId, _resource, options) => {
    requestedMax = options.maxBytes
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }

  await deliver(client, inboundImage('image-service-limit', 'image-service-limit-message'))

  assert.equal(requestedMax, 32)
  assert.equal(service.saveCalls.length, 0)
  assert.match(client.sent.at(-1)?.text ?? '', /limit: 32 bytes/iu)
})

test('duplicate image delivery downloads, saves, and admits only once', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  let downloads = 0
  client.downloadMessageResource = async () => {
    downloads += 1
    return { data: INBOUND_PNG, mediaType: 'image/png' }
  }
  const message = inboundImage('image-duplicate', 'image-duplicate-message')

  await deliver(client, message)
  await deliver(client, message)

  assert.equal(downloads, 1)
  assert.equal(host.attachments?.saveCalls.length, 1)
  assert.equal(host.agentSends.length, 1)
  assert.equal(host.completedInboundKeys.length, 1)
})

test('shutdown waits for non-cancellable image save and admits no late ImageBlock or receipt', async (t) => {
  const { host, client, bridge } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  client.downloadMessageResource = async () => ({ data: INBOUND_PNG, mediaType: 'image/png' })
  const service = host.attachments
  assert.ok(service !== undefined)
  const saveStarted = Promise.withResolvers<void>()
  const releaseSave = Promise.withResolvers<void>()
  service.planSave(async (input) => {
    saveStarted.resolve()
    await releaseSave.promise
    return {
      attachmentId: `sha256:${'e'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    }
  })
  const delivery = deliver(client, inboundImage('image-shutdown', 'image-shutdown-message'))
  await saveStarted.promise
  let stopped = false
  const stopping = bridge.stop().then(() => { stopped = true })
  await yieldImmediate()
  assert.equal(stopped, false)
  releaseSave.resolve()
  const error = await delivery.catch((reason: unknown) => reason)
  await stopping

  assert.ok(error instanceof Error)
  assert.equal(service.saveCalls.length, 1)
  assert.deepEqual(host.agentSends, [])
  assert.deepEqual(host.completedInboundKeys, [])
})

test('a post-save followup failure leaves an orphan and exact redelivery remains retryable', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  client.downloadMessageResource = async () => ({ data: INBOUND_PNG, mediaType: 'image/png' })
  host.failNextAgentSend(new Error('private image followup marker'))
  const message = inboundImage('image-followup-failure', 'image-followup-failure-message')

  const first = await deliver(client, message).catch((error: unknown) => error)
  assert.ok(first instanceof Error)
  assert.doesNotMatch(first.message, /private image followup marker/u)
  assert.equal(host.attachments?.saveCalls.length, 1)
  assert.deepEqual(host.agentSends, [])
  assert.deepEqual(host.completedInboundKeys, [])
  assert.match(client.sent.at(-1)?.text ?? '', /submission failed/iu)
  assert.equal(JSON.stringify(host.errors).includes('private image followup marker'), false)

  await deliver(client, message)
  assert.equal(host.attachments?.saveCalls.length, 2)
  assert.equal(host.agentSends.length, 1)
  assert.equal(host.completedInboundKeys.length, 1)
})

test('a malformed saved reference is unavailable and never enters the Agent inbox', async (t) => {
  const { host, client } = await mount(t, {
    provider: 'route', model: 'vision', inboundImages: true,
  })
  host.llm.setModelCapability('route', 'vision', ['image'])
  client.downloadMessageResource = async () => ({ data: INBOUND_PNG, mediaType: 'image/png' })
  const service = host.attachments
  assert.ok(service !== undefined)
  service.planSave({
    attachmentId: `sha256:${'f'.repeat(64)}` as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: INBOUND_PNG.length + 1,
    width: 1,
    height: 1,
  })

  await deliver(client, inboundImage('image-bad-ref', 'image-bad-ref-message'))

  assert.equal(service.saveCalls.length, 1)
  assert.deepEqual(host.agentSends, [])
  assert.match(client.sent.at(-1)?.text ?? '', /cannot be admitted safely/iu)
})

test('attachment save failures expose only bounded categories and no private cause', async (t) => {
  const fixtures = [
    { code: 'IMAGE_TOO_LARGE', reply: /limit: 5120 KiB/iu },
    { code: 'IMAGE_TOO_MANY_PIXELS', reply: /limit: 20000000 pixels/iu },
    { code: 'IMAGE_TYPE_MISMATCH', reply: /static PNG or JPEG/iu },
    { code: undefined, reply: /cannot be admitted safely/iu },
  ] as const

  for (const [index, fixture] of fixtures.entries()) {
    const { host, client } = await mount(t, {
      provider: 'route', model: 'vision', inboundImages: true,
    })
    host.llm.setModelCapability('route', 'vision', ['image'])
    client.downloadMessageResource = async () => ({ data: INBOUND_PNG, mediaType: 'image/png' })
    const service = host.attachments
    assert.ok(service !== undefined)
    const privateMarker = `private-save-cause-${index}`
    const failure = Object.assign(new Error(privateMarker), {
      ...(fixture.code === undefined ? {} : { code: fixture.code }),
    })
    service.planSave(failure)

    await deliver(client, inboundImage(`image-save-failure-${index}`, `image-save-message-${index}`))

    assert.equal(service.saveCalls.length, 1)
    assert.deepEqual(host.agentSends, [])
    assert.match(client.sent.at(-1)?.text ?? '', fixture.reply)
    assert.equal(JSON.stringify({
      sent: client.sent,
      warnings: host.warnings,
      errors: host.errors,
      receipts: host.completedInboundKeys,
      bindings: [...host.bindings.values()],
    }).includes(privateMarker), false)
  }
})

test('oversized and control-character catalog fields are sanitized and globally bounded', async (t) => {
  const { host, client } = await mount(t)
  const longProvider = 'P'.repeat(600)
  const longModel = 'I'.repeat(900)
  for (let providerIndex = 0; providerIndex < 40; providerIndex += 1) {
    const provider = `provider-${providerIndex}\u0007`
    host.llm.providers.push({ id: provider, name: `Provider\u0008${longProvider}${providerIndex}` })
    host.llm.models.set(provider, Array.from({ length: 10 }, (_, modelIndex) => ({
      provider,
      id: `model-${modelIndex}\u0001${longModel}`,
      name: `Model\u0002${longModel}${modelIndex}`,
    })))
  }

  await send(client, 'bounded-chat', '/model', 'bounded-list')

  const listing = client.sent.at(-1)?.text ?? ''
  assert.equal(host.llm.listModelsCalls.length, 32)
  assert.equal(listing.split('\n').filter(line => line.startsWith('- ')).length, 128)
  assert.equal(listing.includes('\u0001'), false)
  assert.equal(listing.includes('\u0002'), false)
  assert.equal(listing.includes('\u0007'), false)
  assert.equal(listing.includes('\u0008'), false)
  assert.equal(listing.includes('P'.repeat(121)), false)
  assert.equal(listing.includes('I'.repeat(121)), false)
  assert.ok(listing.length < 45_000, `catalog response was unexpectedly large: ${listing.length}`)
  assert.match(listing, /model list was truncated/i)
})
