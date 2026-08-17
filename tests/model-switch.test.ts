import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import { LarkBridge } from '../src/bridge.ts'
import type { ConversationBinding } from '../src/conversation-binding.ts'
import type { LarkClientLike, LarkDeliveryOptions, LarkInbound } from '../src/lark.ts'

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

class ModelRuntime {
  readonly providers: ModelProvider[] = []
  readonly models = new Map<string, ModelRow[] | Error>()
  readonly listModelsCalls: string[] = []
  readonly resolveCalls: LlmCallConfig[] = []
  private readonly resolvePlans: ResolvePlan[] = []

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

  async resolveCallConfig(config: LlmCallConfig): Promise<LlmCallConfig> {
    this.resolveCalls.push({ ...config })
    const plan = this.resolvePlans.shift()
    if (plan instanceof Error) throw plan
    if (typeof plan === 'function') return plan(config)
    return plan ?? config
  }
}

interface ModelSession {
  readonly id: string
  readonly header: { readonly cwd?: string; readonly agentPreset?: string }
  readonly events: Array<{ readonly type: string; readonly data: unknown }>
  append(type: string, data: unknown): unknown
  requestContext(): undefined
  requestHeader(): { readonly config: LlmCallConfig } | undefined
}

class ModelAgent {
  readonly inbox = { hasPending: false }
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
    this.session.events.push({ type: 'user/message', data: message })
    if (this.maintenance) this.inbox.hasPending = true
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

class ModelHost {
  readonly llm = new ModelRuntime()
  readonly liveAgents = new Map<string, ModelAgent>()
  readonly liveSessions = new Map<string, ModelSession>()
  readonly persisted = new Map<string, ModelSession>()
  readonly bindings = new Map<string, ConversationBinding>()
  readonly bindingPuts: Array<{ readonly baseId: string; readonly binding: ConversationBinding }> = []
  readonly opens: OpenRecord[] = []
  readonly disposals: string[] = []
  readonly flushCalls: string[] = []
  readonly followups: Array<{ readonly agent: ModelAgent; readonly message: unknown }> = []
  readonly completedInboundKeys: string[] = []
  readonly warnings: unknown[][] = []
  readonly errors: unknown[][] = []
  private readonly flushPlans: FlushPlan[] = []
  private bindingPutStart: (() => void) | undefined
  private bindingPutWait: Promise<void> | undefined

  readonly ctx = {
    logger: {
      warn: (...args: unknown[]) => { this.warnings.push(args) },
      error: (...args: unknown[]) => { this.errors.push(args) },
    },
    on: (_name: string, _listener: (...args: never[]) => unknown) => () => {},
    get: (name: string) => {
      if (name === 'approval') return {}
      if (name === 'llm') return this.llm
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

  holdNextBindingPut(start: () => void, wait: Promise<void>): void {
    this.bindingPutStart = start
    this.bindingPutWait = wait
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
    header: ModelSession['header'],
    seed: readonly { readonly type: string; readonly data: unknown }[] = [],
  ): ModelSession {
    const events = [...seed]
    return {
      id,
      header: { ...header },
      events,
      append: (type, data) => {
        const event = { type, data }
        events.push(event)
        return event
      },
      requestContext: () => undefined,
      requestHeader: () => {
        for (let index = events.length - 1; index >= 0; index -= 1) {
          const event = events[index]
          if (event?.type !== 'request/header') continue
          const data = event.data as { readonly header?: { readonly config?: LlmCallConfig } }
          if (data.header?.config !== undefined) return { config: data.header.config }
        }
        return undefined
      },
    }
  }

  private async open(kind: 'create' | 'resume', options: AgentOpenOptions) {
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
  readonly seed?: readonly { readonly type: string; readonly data: unknown }[]
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
      async complete(key) { host.completedInboundKeys.push(key) },
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
