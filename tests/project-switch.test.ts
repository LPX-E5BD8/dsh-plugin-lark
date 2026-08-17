import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { LarkBridge } from '../src/bridge.ts'
import type { ConversationBinding } from '../src/conversation-binding.ts'
import type { LarkClientLike, LarkDeliveryOptions, LarkInbound } from '../src/lark.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  const result = Promise.withResolvers<T>()
  return {
    promise: result.promise,
    resolve: result.resolve,
    reject: result.reject,
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await yieldImmediate()
  }
  assert.fail(message)
}

async function yieldTurn(): Promise<void> {
  await Promise.resolve()
  await yieldImmediate()
  await Promise.resolve()
}

interface SentText {
  readonly chatId: string
  readonly text: string
  readonly options?: LarkDeliveryOptions
}

type ProjectClient = LarkClientLike & {
  readonly sent: SentText[]
  handler?: (message: LarkInbound) => Promise<void>
}

function createClient(): ProjectClient {
  const client: ProjectClient = {
    sent: [],
    async start() {},
    async stop() {},
    async sendText(chatId, text, options) { client.sent.push({ chatId, text, options }) },
    onMessage(handler) { client.handler = handler },
  }
  return client
}

let inboundSequence = 0

function inbound(chatId: string, text: string): LarkInbound {
  inboundSequence += 1
  return {
    chatId,
    chatType: 'p2p',
    openId: 'owner',
    text,
    messageId: `project-${inboundSequence}`,
    mentioned: false,
  }
}

async function send(client: ProjectClient, chatId: string, text: string): Promise<void> {
  assert.ok(client.handler !== undefined)
  await client.handler(inbound(chatId, text))
}

async function settleSend(client: ProjectClient, chatId: string, text: string): Promise<void> {
  try {
    await send(client, chatId, text)
  } catch {
    // Transaction failures may either propagate or be rendered as a localized reply.
  }
}

interface ProjectSession {
  readonly id: string
  readonly header: {
    readonly cwd?: string
    readonly agentPreset?: string
  }
  readonly events: unknown[]
  append(type: string, data: unknown): unknown
  requestContext(): undefined
}

class ProjectAgent {
  readonly inbox = { hasPending: false }
  readonly ctx: Record<string, never> = {}
  readonly id: string
  status: 'idle' | 'running' = 'idle'
  disposed = false
  private maintenance = false
  private readonly idleWaiters: Array<() => void> = []

  constructor(
    readonly host: ProjectHost,
    readonly session: ProjectSession,
    readonly scopedTools: readonly string[],
  ) {
    this.id = session.id
  }

  followup(message: unknown): void {
    assert.equal(this.disposed, false, `followup reached disposed agent ${this.id}`)
    this.host.followups.push({ agent: this, message })
    this.session.events.push({ type: 'user/message', data: message })
    this.host.operations.push(`followup:${this.id}`)
    if (this.maintenance) this.inbox.hasPending = true
  }

  cancel(): void {}

  whenIdle(): Promise<void> {
    if (!this.maintenance && !this.inbox.hasPending) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  finishPending(): void {
    this.inbox.hasPending = false
    if (this.maintenance) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.maintenance) {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    this.maintenance = true
    return task(new AbortController().signal).finally(() => {
      this.maintenance = false
      if (!this.inbox.hasPending) {
        for (const resolve of this.idleWaiters.splice(0)) resolve()
      }
    })
  }
}

type WorkspaceStatus = 'ok' | 'missing-dir'

const WORKSPACE_IDS = {
  alpha: '11111111-1111-4111-8111-111111111111',
  beta: '22222222-2222-4222-8222-222222222222',
  duplicateOne: '33333333-3333-4333-8333-333333333333',
  duplicateTwo: '44444444-4444-4444-8444-444444444444',
  missing: '55555555-5555-4555-8555-555555555555',
} as const

class TestWorkspace {
  readonly createdAt = '2026-08-16T00:00:00.000Z'
  readonly updatedAt = '2026-08-16T00:00:00.000Z'
  readonly sessionIds: string[] = []
  readonly statusCalls: number[] = []
  readonly attachCalls: string[] = []
  attachError?: Error
  statusWait?: Promise<void>
  private readonly statusPlans: WorkspaceStatus[]

  constructor(
    readonly id: string,
    readonly title: string,
    readonly path: string,
    statuses: WorkspaceStatus | readonly WorkspaceStatus[] = 'ok',
  ) {
    this.statusPlans = typeof statuses === 'string' ? [statuses] : [...statuses]
  }

  async status(): Promise<WorkspaceStatus> {
    this.statusCalls.push(this.statusCalls.length + 1)
    await this.statusWait
    return this.statusPlans.shift() ?? 'ok'
  }

  async attachSession(sessionId: string): Promise<void> {
    this.attachCalls.push(sessionId)
    if (this.attachError !== undefined) throw this.attachError
    const index = this.sessionIds.indexOf(sessionId)
    if (index >= 0) this.sessionIds.splice(index, 1)
    this.sessionIds.unshift(sessionId)
  }

  async setTitle(): Promise<void> {}
  async insertSessionBefore(): Promise<void> {}
  async detachSession(): Promise<void> {}
}

interface CreateRecord {
  readonly sessionId: string
  readonly cwd?: string
  readonly agentPreset?: string
  readonly seed?: readonly unknown[]
  readonly scopedTools: readonly string[]
  readonly agent: ProjectAgent
}

type FlushPlan = {
  readonly wait?: Promise<void>
  readonly result: boolean
  readonly error?: undefined
} | {
  readonly wait?: Promise<void>
  readonly error: Error
  readonly published?: boolean
}

type BindingPutPlan = {
  readonly wait?: Promise<void>
  readonly error?: Error
  readonly published?: boolean
  readonly visible?: boolean
}

interface RuntimeExecution {
  readonly agent: ProjectAgent
  readonly line: string
}

class ProjectHost {
  readonly workspaces: TestWorkspace[]
  readonly liveAgents = new Map<string, ProjectAgent>()
  readonly liveSessions = new Map<string, ProjectSession>()
  readonly persisted = new Map<string, ProjectSession>()
  readonly bindings = new Map<string, ConversationBinding>()
  readonly durableBindings = new Map<string, ConversationBinding>()
  readonly bindingPuts: Array<{ readonly baseId: string; readonly binding: ConversationBinding }> = []
  readonly completedInboundKeys: string[] = []
  readonly creates: CreateRecord[] = []
  readonly resumes: string[] = []
  readonly disposals: string[] = []
  readonly flushCalls: string[] = []
  readonly followups: Array<{ readonly agent: ProjectAgent; readonly message: unknown }> = []
  readonly warnings: unknown[][] = []
  readonly errors: unknown[][] = []
  readonly operations: string[] = []
  readonly mounts: Array<{ readonly preset: string; readonly tools: readonly string[] }> = []
  readonly runtimeExecutions: RuntimeExecution[] = []
  readonly workspaceResolveCalls: string[] = []
  workspaceRegistryAvailable = true
  sessionPersistenceAvailable = true
  defaultPreset = 'coding'
  createError?: Error
  bindingPutError?: Error
  disposeErrorOnce?: Error
  runtimeHandler?: (agent: ProjectAgent, line: string) => Promise<void>
  workspaceResolveHandler?: (path: string) => Promise<TestWorkspace | undefined>
  sessionEventListener?: (session: ProjectSession, event: {
    readonly type: 'turn/start'
    readonly time: number
    readonly data: { readonly turn: number }
  }) => void
  private readonly flushPlans: FlushPlan[] = []
  private readonly bindingPutPlans: BindingPutPlan[] = []

  constructor(workspaces: readonly TestWorkspace[]) {
    this.workspaces = [...workspaces]
  }

  readonly ctx = {
    logger: {
      warn: (...args: unknown[]) => { this.warnings.push(args) },
      error: (...args: unknown[]) => { this.errors.push(args) },
    },
    on: (name: string, listener: (...args: never[]) => unknown) => {
      if (name !== 'session/event') return () => {}
      const sessionListener = listener as unknown as ProjectHost['sessionEventListener']
      this.sessionEventListener = sessionListener
      return () => {
        if (this.sessionEventListener === sessionListener) this.sessionEventListener = undefined
      }
    },
    get: (name: string) => {
      if (name === 'approval') return {}
      if (name === 'workspaceRegistry' && this.workspaceRegistryAvailable) {
        return {
          list: () => [...this.workspaces],
          get: (id: unknown) => this.workspaces.find((workspace) => workspace.id === String(id)),
          resolveByPath: async (path: string) => {
            this.workspaceResolveCalls.push(path)
            return this.workspaceResolveHandler === undefined
              ? this.workspaces.find((workspace) => workspace.path === path)
              : this.workspaceResolveHandler(path)
          },
        }
      }
      if (name === 'sessionPersistence' && this.sessionPersistenceAvailable) {
        return {
          list: async () => [...this.persisted.values()].map((session) => ({
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
      if (name === 'agentPresets') {
        return {
          resolve: async (id?: string) => ({ id: id ?? this.defaultPreset }),
          mount: async (agentCtx: { tools: { register(tool: { name: string }): void } }, id?: string) => {
            const preset = id ?? this.defaultPreset
            const tools = [`tool:${preset}`]
            for (const tool of tools) agentCtx.tools.register({ name: tool })
            this.mounts.push({ preset, tools })
            return { id: preset }
          },
        }
      }
      if (name === 'commands' && this.runtimeHandler !== undefined) {
        return {
          list: () => [{ name: 'hold', description: 'hold this session' }],
          execute: async (agent: ProjectAgent, line: string) => {
            this.runtimeExecutions.push({ agent, line })
            await this.runtimeHandler?.(agent, line)
            return { result: { kind: 'success' as const } }
          },
        }
      }
      return undefined
    },
    agents: {
      create: (options: {
        sessionId: unknown
        meta?: { cwd?: string; agentPreset?: string }
        seed?: readonly unknown[]
        setup?: (agentCtx: unknown) => Promise<unknown> | unknown
      }) => this.create(options),
      resume: (options: {
        resumeSessionId: unknown
        setup?: (agentCtx: unknown) => Promise<unknown> | unknown
      }) => this.resume(options),
      get: (id: unknown) => this.liveAgents.get(String(id)),
      list: () => [...this.liveAgents.values()],
      roots: () => [...this.liveAgents.values()],
    },
    sessions: {
      get: (id: unknown) => this.liveSessions.get(String(id)),
      list: () => [...this.liveSessions.values()],
      flush: (session: ProjectSession) => this.flush(session),
    },
  }

  planFlush(plan: FlushPlan): void {
    this.flushPlans.push(plan)
  }

  planBindingPut(plan: BindingPutPlan): void {
    this.bindingPutPlans.push(plan)
  }

  async putBinding(baseId: string, binding: ConversationBinding): Promise<void> {
    this.bindingPuts.push({ baseId, binding: { ...binding } })
    const plan = this.bindingPutPlans.shift()
    await plan?.wait
    if (plan?.error !== undefined) {
      if (plan.published === true) {
        this.durableBindings.set(baseId, { ...binding })
        if (plan.visible === true) this.bindings.set(baseId, { ...binding })
        else this.bindingPutError = plan.error
      }
      throw plan.error
    }
    if (this.bindingPutError !== undefined) throw this.bindingPutError
    this.bindings.set(baseId, { ...binding })
    this.durableBindings.set(baseId, { ...binding })
  }

  latestCreate(): CreateRecord {
    const record = this.creates.at(-1)
    assert.ok(record !== undefined)
    return record
  }

  emitTurnStart(agent: ProjectAgent, turn = 1): void {
    const event = { type: 'turn/start' as const, time: Date.now(), data: { turn } }
    agent.session.events.push(event)
    this.sessionEventListener?.(agent.session, event)
  }

  private async create(options: {
    sessionId: unknown
    meta?: { cwd?: string; agentPreset?: string }
    seed?: readonly unknown[]
    setup?: (agentCtx: unknown) => Promise<unknown> | unknown
  }) {
    if (this.createError !== undefined) {
      const error = this.createError
      this.createError = undefined
      throw error
    }
    const sessionId = String(options.sessionId)
    const scopedTools: string[] = []
    const setupResult = await options.setup?.({
      tools: { register: (tool: { name: string }) => { scopedTools.push(tool.name) } },
    }) as { commit?: () => void } | undefined
    setupResult?.commit?.()
    const events = [...(options.seed ?? [])]
    const session: ProjectSession = {
      id: sessionId,
      header: {
        ...(options.meta?.cwd === undefined ? {} : { cwd: options.meta.cwd }),
        ...(options.meta?.agentPreset === undefined ? {} : { agentPreset: options.meta.agentPreset }),
      },
      events,
      append: (type, data) => {
        const event = { type, data }
        events.push(event)
        return event
      },
      requestContext: () => undefined,
    }
    const agent = new ProjectAgent(this, session, scopedTools)
    this.liveSessions.set(sessionId, session)
    this.liveAgents.set(sessionId, agent)
    const record: CreateRecord = {
      sessionId,
      cwd: options.meta?.cwd,
      agentPreset: options.meta?.agentPreset,
      seed: options.seed,
      scopedTools,
      agent,
    }
    this.creates.push(record)
    this.operations.push(`create:${sessionId}:${options.meta?.cwd ?? ''}`)
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
        this.operations.push(`dispose:${sessionId}`)
        if (this.disposeErrorOnce !== undefined) {
          const error = this.disposeErrorOnce
          this.disposeErrorOnce = undefined
          throw error
        }
      },
    }
  }

  private async resume(options: {
    resumeSessionId: unknown
    setup?: (agentCtx: unknown) => Promise<unknown> | unknown
  }) {
    const sessionId = String(options.resumeSessionId)
    const stored = this.persisted.get(sessionId)
    if (stored === undefined) throw new Error(`session "${sessionId}" not found`)
    this.resumes.push(sessionId)
    return this.create({
      sessionId,
      meta: stored.header,
      seed: stored.events,
      setup: options.setup,
    })
  }

  private async flush(session: ProjectSession): Promise<boolean> {
    this.flushCalls.push(session.id)
    this.operations.push(`flush:${session.id}`)
    const plan = this.flushPlans.shift() ?? { result: true }
    await plan.wait
    if ('error' in plan) {
      if (plan.published === true) this.persisted.set(session.id, session)
      throw plan.error
    }
    if (plan.result) this.persisted.set(session.id, session)
    return plan.result
  }
}

function standardWorkspaces(): TestWorkspace[] {
  return [
    new TestWorkspace(WORKSPACE_IDS.alpha, 'Alpha Repo', '/srv/private/alpha-repo'),
    new TestWorkspace(WORKSPACE_IDS.beta, 'Beta Repo', '/srv/private/beta-repo'),
  ]
}

function mount(
  t: { after(callback: () => void | Promise<void>): void },
  workspaces: readonly TestWorkspace[] = standardWorkspaces(),
  options: {
    defaultSessionId?: string
    workspaceRegistryAvailable?: boolean
    sessionPersistenceAvailable?: boolean
  } = {},
): { readonly host: ProjectHost; readonly client: ProjectClient; readonly bridge: LarkBridge } {
  const host = new ProjectHost(workspaces)
  host.workspaceRegistryAvailable = options.workspaceRegistryAvailable ?? true
  host.sessionPersistenceAvailable = options.sessionPersistenceAvailable ?? true
  const client = createClient()
  const bridge = new LarkBridge(host.ctx as never, {
    client,
    inboundDeduplicator: {
      has: () => false,
      async complete(key) { host.completedInboundKeys.push(key) },
    },
    conversationBindings: {
      read: (baseId) => host.bindings.get(baseId),
      put: (baseId, binding) => host.putBinding(baseId, binding),
      async close() {},
    },
    allowFrom: ['owner'],
    cwd: '/srv/default-repo',
    defaultSessionId: options.defaultSessionId,
  })
  void bridge.start()
  t.after(() => bridge.stop())
  return { host, client, bridge }
}

test('/project lists titles and complete ids without leaking filesystem paths', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)

  await send(client, 'chat-a', '/project Alpha Repo')
  const createCount = host.creates.length
  await send(client, 'chat-a', '/project')

  const listing = client.sent.at(-1)?.text ?? ''
  assert.match(listing, /当前项目/)
  for (const workspace of workspaces) {
    assert.match(listing, new RegExp(workspace.title))
    assert.match(listing, new RegExp(workspace.id))
    assert.equal(listing.includes(workspace.path), false, `listing leaked ${workspace.path}`)
  }
  assert.equal(host.creates.length, createCount, 'listing unexpectedly created a session')
})

test('/project selects a unique full title or an exact complete id and no-ops current selection', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)

  await send(client, 'chat-a', '/project Alpha Repo')
  const alpha = host.latestCreate()
  assert.equal(alpha.cwd, workspaces[0]?.path)

  await send(client, 'chat-a', `/project ${WORKSPACE_IDS.beta}`)
  const beta = host.latestCreate()
  assert.notEqual(beta, alpha)
  assert.equal(beta.cwd, workspaces[1]?.path)

  const createCount = host.creates.length
  await send(client, 'chat-a', `/project ${WORKSPACE_IDS.beta}`)
  assert.equal(host.creates.length, createCount)
  assert.match(client.sent.at(-1)?.text ?? '', /当前|已是/)
})

test('/project rejects duplicate titles, unknown queries, unavailable registries, and missing directories', async (t) => {
  const workspaces = [
    new TestWorkspace(WORKSPACE_IDS.duplicateOne, 'Same Title', '/srv/private/same-one'),
    new TestWorkspace(WORKSPACE_IDS.duplicateTwo, 'Same Title', '/srv/private/same-two'),
    new TestWorkspace(WORKSPACE_IDS.missing, 'Missing Repo', '/srv/private/missing', 'missing-dir'),
  ]
  const available = mount(t, workspaces)

  await send(available.client, 'chat-a', '/project Same Title')
  assert.equal(available.host.creates.length, 0)
  assert.match(available.client.sent.at(-1)?.text ?? '', /多个项目/)

  await send(available.client, 'chat-a', '/project Does Not Exist')
  assert.equal(available.host.creates.length, 0)
  assert.match(available.client.sent.at(-1)?.text ?? '', /未找到/)

  await send(available.client, 'chat-a', '/project Missing Repo')
  assert.equal(available.host.creates.length, 0)
  assert.equal(workspaces[2]?.statusCalls.length, 1)
  assert.match(available.client.sent.at(-1)?.text ?? '', /目录不存在/)

  const unavailable = mount(t, standardWorkspaces(), { workspaceRegistryAvailable: false })
  await send(unavailable.client, 'chat-a', '/project Alpha Repo')
  assert.equal(unavailable.host.creates.length, 0)
  assert.match(unavailable.client.sent.at(-1)?.text ?? '', /不可用/)

  const nonDurable = mount(t, standardWorkspaces(), { sessionPersistenceAvailable: false })
  await send(nonDurable.client, 'chat-a', '/project Alpha Repo')
  assert.equal(nonDurable.host.creates.length, 0)
  assert.match(nonDurable.client.sent.at(-1)?.text ?? '', /不可用/)
})

test('a successful project switch creates an empty durable generation with cwd, preset, and scoped tools', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'remember old history')
  const old = host.latestCreate()
  old.agent.session.events.push({
    type: 'agent-preset/selected',
    data: { agentPreset: 'review' },
  })

  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()

  assert.notEqual(fresh.sessionId, old.sessionId)
  assert.match(fresh.sessionId, /^lark:chat-a:\d+-/)
  assert.equal(fresh.seed, undefined)
  assert.deepEqual(
    fresh.agent.session.events,
    [{ type: 'todo/write', data: { todos: [] } }],
  )
  assert.equal(fresh.cwd, workspaces[0]?.path)
  assert.equal(fresh.agentPreset, 'review')
  assert.deepEqual(fresh.scopedTools, ['tool:review'])
  assert.deepEqual(host.flushCalls, [old.sessionId, fresh.sessionId])
  assert.deepEqual(workspaces[0]?.attachCalls, [], 'blank generation was exposed to Workspace reuse')
  assert.equal(old.agent.disposed, true)
  assert.equal(fresh.agent.disposed, false)

  await send(client, 'chat-a', 'continue in alpha')
  assert.equal(host.followups.at(-1)?.agent, fresh.agent)
  host.emitTurnStart(fresh.agent)
  await waitFor(
    () => workspaces[0]?.attachCalls.length === 1,
    'non-blank durable generation was not attached to its Workspace',
  )
  assert.deepEqual(workspaces[0]?.attachCalls, [fresh.sessionId])
})

test('a missing candidate durability participant rolls back to the old binding', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  host.planFlush({ result: true })
  host.planFlush({ result: false })

  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()
  assert.notEqual(fresh, old)
  assert.equal(fresh.agent.disposed, true)
  assert.equal(old.agent.disposed, false)
  assert.deepEqual(workspaces[0]?.attachCalls, [])
  assert.match(client.sent.at(-1)?.text ?? '', /切换失败/)

  await send(client, 'chat-a', 'continue in the old session')
  assert.equal(host.followups.at(-1)?.agent, old.agent)
})

test('a published orphan candidate is ignored after checkpoint rejection and restart', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client, bridge } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  host.planFlush({ result: true })
  host.planFlush({ error: new Error('published but final fsync failed'), published: true })

  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()
  assert.notEqual(fresh, old)
  assert.equal(fresh.agent.disposed, true)
  assert.equal(old.agent.disposed, false)
  assert.deepEqual(workspaces[0]?.attachCalls, [])
  assert.match(client.sent.at(-1)?.text ?? '', /切换失败/)

  await send(client, 'chat-a', 'continue before restart')
  assert.equal(host.followups.at(-1)?.agent, old.agent)

  const published = host.persisted.get(fresh.sessionId)
  const persistedOld = host.persisted.get(old.sessionId)
  const committed = host.bindings.get('lark:chat-a')
  assert.ok(published !== undefined)
  assert.ok(persistedOld !== undefined)
  assert.ok(committed !== undefined)
  await bridge.stop()
  const restarted = mount(t, standardWorkspaces())
  restarted.host.persisted.set(fresh.sessionId, published)
  restarted.host.persisted.set(old.sessionId, persistedOld)
  restarted.host.bindings.set('lark:chat-a', committed)
  await send(restarted.client, 'chat-a', 'continue after restart')
  assert.deepEqual(restarted.host.resumes, [old.sessionId])
  assert.equal(restarted.host.followups.at(-1)?.agent.session.id, old.sessionId)
})

test('a binding committed before put rejection is confirmed by read-back without retry', async (t) => {
  const { host, client } = mount(t)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  host.planBindingPut({})
  host.planBindingPut({
    error: new Error('commit completed before acknowledgement failed'),
    published: true,
    visible: true,
  })

  await send(client, 'chat-a', '/project Alpha Repo')
  const candidate = host.latestCreate()
  assert.notEqual(candidate, old)
  assert.equal(host.bindingPuts.length, 2)
  assert.equal(host.bindings.get('lark:chat-a')?.suffix, candidate.sessionId.slice('lark:chat-a:'.length))
  assert.equal(old.agent.disposed, true)
  assert.equal(candidate.agent.disposed, false)
  assert.match(client.sent.at(-1)?.text ?? '', /已切换到项目/)
})

test('a rejected final binding write retries the same value and restart follows the confirmed candidate', async (t) => {
  const { host, client, bridge } = mount(t)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  host.planBindingPut({})
  host.planBindingPut({ error: new Error('published binding acknowledgement failed') })

  await send(client, 'chat-a', '/project Alpha Repo')
  const candidate = host.latestCreate()
  assert.notEqual(candidate, old)
  assert.equal(old.agent.disposed, true)
  assert.equal(candidate.agent.disposed, false)
  assert.equal(host.bindingPuts.length, 3)
  assert.deepEqual(host.bindingPuts[1], host.bindingPuts[2])
  const committed = host.bindings.get('lark:chat-a')
  const persisted = host.persisted.get(candidate.sessionId)
  assert.ok(committed !== undefined)
  assert.ok(persisted !== undefined)

  await bridge.stop()
  const restarted = mount(t)
  restarted.host.bindings.set('lark:chat-a', committed)
  restarted.host.persisted.set(candidate.sessionId, persisted)
  await send(restarted.client, 'chat-a', 'after confirmed retry')
  assert.deepEqual(restarted.host.resumes, [candidate.sessionId])
})

test('shutdown after a published but unconfirmed binding requires a fresh storage remount', async (t) => {
  const { host, client, bridge } = mount(t)
  await send(client, 'chat-a', 'old context')
  const receiptsBeforeSwitch = host.completedInboundKeys.length
  const repliesBeforeSwitch = client.sent.length
  host.planBindingPut({})
  host.planBindingPut({
    error: new Error('post-rename directory fsync acknowledgement failed'),
    published: true,
  })

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.bindingPuts.length >= 4, 'published binding confirmation did not retry')
  const candidate = host.latestCreate()
  const durableBinding = host.durableBindings.get('lark:chat-a')
  const persistedCandidate = host.persisted.get(candidate.sessionId)
  assert.ok(durableBinding !== undefined)
  assert.ok(persistedCandidate !== undefined)
  assert.equal(durableBinding.suffix, candidate.sessionId.slice('lark:chat-a:'.length))
  assert.notDeepEqual(host.bindings.get('lark:chat-a'), durableBinding)

  await bridge.stop()
  await assert.rejects(switching, /binding confirmation was interrupted by shutdown/)
  assert.equal(host.completedInboundKeys.length, receiptsBeforeSwitch)
  assert.equal(client.sent.length, repliesBeforeSwitch)
  await assert.rejects(
    bridge.start(),
    /requires a full storage remount after an interrupted binding confirmation/,
  )

  const remounted = mount(t)
  remounted.host.bindings.set('lark:chat-a', durableBinding)
  remounted.host.persisted.set(candidate.sessionId, persistedCandidate)
  await send(remounted.client, 'chat-a', 'resume the recovered candidate')
  assert.deepEqual(remounted.host.resumes, [candidate.sessionId])
})

test('bridge stop interrupts an indefinitely unconfirmed final binding write', async (t) => {
  const { host, client, bridge } = mount(t)
  await send(client, 'chat-a', 'old context')
  const candidateCheckpoint = deferred<void>()
  host.planFlush({ result: true })
  host.planFlush({ result: true, wait: candidateCheckpoint.promise })
  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.flushCalls.length === 2, 'candidate checkpoint did not start')
  const candidate = host.latestCreate()
  host.bindingPutError = new Error('persistent binding acknowledgement failure')
  candidateCheckpoint.resolve()
  await waitFor(() => host.bindingPuts.length >= 4, 'binding confirmation did not retry')

  const stopped = bridge.stop()
  const timeout = Promise.withResolvers<never>()
  const timeoutId = setTimeout(() => {
    timeout.reject(new Error('bridge stop remained blocked by binding retry'))
  }, 1_000)
  try {
    await Promise.race([stopped, timeout.promise])
  } finally {
    clearTimeout(timeoutId)
  }
  await assert.rejects(switching, /binding confirmation was interrupted by shutdown/)
  assert.equal(candidate.agent.disposed, true)
})

test('project switch fails closed when the old transcript checkpoint is not confirmed', async (t) => {
  const missing = mount(t, standardWorkspaces())
  await send(missing.client, 'chat-a', 'old context')
  const missingOld = missing.host.latestCreate()
  missing.host.planFlush({ result: false })

  await send(missing.client, 'chat-a', '/project Alpha Repo')
  assert.equal(missing.host.creates.length, 1)
  assert.equal(missingOld.agent.disposed, false)
  assert.deepEqual(missing.host.flushCalls, [missingOld.sessionId])
  assert.match(missing.client.sent.at(-1)?.text ?? '', /历史已保存|持久化存储/)

  const rejected = mount(t, standardWorkspaces())
  await send(rejected.client, 'chat-a', 'old context')
  const rejectedOld = rejected.host.latestCreate()
  rejected.host.planFlush({ error: new Error('old transcript unavailable') })

  await send(rejected.client, 'chat-a', '/project Alpha Repo')
  assert.equal(rejected.host.creates.length, 1)
  assert.equal(rejectedOld.agent.disposed, false)
  assert.deepEqual(rejected.host.flushCalls, [rejectedOld.sessionId])
  assert.match(rejected.client.sent.at(-1)?.text ?? '', /历史已保存|持久化存储/)
})

test('/new and /clear retain the committed handle when session persistence disappears', async (t) => {
  const { host, client } = mount(t)
  await send(client, 'chat-a', 'old context')
  await send(client, 'chat-a', '/project Alpha Repo')
  const committed = host.latestCreate()
  const committedBinding = host.bindings.get('lark:chat-a')
  assert.ok(committedBinding !== undefined)
  host.sessionPersistenceAvailable = false

  for (const command of ['/new', '/clear']) {
    const createsBefore = host.creates.length
    await send(client, 'chat-a', command)
    assert.equal(host.creates.length, createsBefore)
    assert.equal(committed.agent.disposed, false)
    assert.deepEqual(host.bindings.get('lark:chat-a'), committedBinding)
    assert.match(client.sent.at(-1)?.text ?? '', /无法安全开始新会话/)
  }

  await send(client, 'chat-a', 'continue without persistence')
  assert.equal(host.followups.at(-1)?.agent, committed.agent)
})

test('a cold committed binding fails closed when session persistence is unavailable', async (t) => {
  const first = mount(t)
  const committedProject = inbound('chat-a', '/project Alpha Repo')
  assert.ok(first.client.handler !== undefined)
  await first.client.handler(committedProject)
  const committed = first.host.bindings.get('lark:chat-a')
  assert.ok(committed !== undefined)
  await first.bridge.stop()

  const cold = mount(t, standardWorkspaces(), { sessionPersistenceAvailable: false })
  cold.host.bindings.set('lark:chat-a', committed)
  assert.ok(cold.client.handler !== undefined)
  await assert.rejects(
    cold.client.handler(committedProject),
    /committed conversation binding requires session persistence/,
  )
  assert.equal(cold.host.creates.length, 0)
  assert.equal(cold.host.completedInboundKeys.length, 0)
  assert.equal(cold.client.sent.length, 0)
})

test('project switch rechecks directory availability before creating and retains the old handle', async (t) => {
  const workspace = new TestWorkspace(
    WORKSPACE_IDS.alpha,
    'Alpha Repo',
    '/srv/private/alpha-repo',
    ['ok', 'missing-dir'],
  )
  const { host, client } = mount(t, [workspace])
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  const createCount = host.creates.length

  await settleSend(client, 'chat-a', '/project Alpha Repo')
  assert.equal(workspace.statusCalls.length, 2)
  assert.equal(host.creates.length, createCount)
  assert.deepEqual(host.flushCalls, [old.sessionId])
  assert.equal(old.agent.disposed, false)
  assert.deepEqual(workspace.attachCalls, [])

  await send(client, 'chat-a', 'still old context')
  assert.equal(host.followups.at(-1)?.agent, old.agent)
})

test('workspace removal during the old transcript checkpoint prevents a new generation', async (t) => {
  const workspaces = standardWorkspaces()
  const workspace = workspaces[0]
  assert.ok(workspace !== undefined)
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  const oldCheckpoint = deferred<void>()
  host.planFlush({ result: true, wait: oldCheckpoint.promise })

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.flushCalls.length === 1, 'old transcript checkpoint did not start')
  host.workspaces.splice(0, 1)
  oldCheckpoint.resolve()
  await switching

  assert.equal(host.creates.length, 1)
  assert.equal(old.agent.disposed, false)
  assert.deepEqual(workspace.attachCalls, [])
  assert.match(client.sent.at(-1)?.text ?? '', /未找到|不可用/)
})

test('workspace removal during a successful flush cannot roll back the durable generation', async (t) => {
  const workspaces = standardWorkspaces()
  const workspace = workspaces[0]
  assert.ok(workspace !== undefined)
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  const checkpoint = deferred<void>()
  host.planFlush({ result: true })
  host.planFlush({ result: true, wait: checkpoint.promise })

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.flushCalls.length === 2, 'new project checkpoint did not start')
  const fresh = host.latestCreate()
  host.workspaces.splice(0, 1)
  checkpoint.resolve()
  await switching

  assert.equal(old.agent.disposed, true)
  assert.equal(fresh.agent.disposed, false)
  assert.deepEqual(workspace.attachCalls, [])
  await send(client, 'chat-a', 'continue after registry removal')
  assert.equal(host.followups.at(-1)?.agent, fresh.agent)
})

test('project selections remain isolated between ordinary conversations', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'a-old')
  const oldA = host.latestCreate()
  await send(client, 'chat-b', 'b-old')
  const oldB = host.latestCreate()

  await send(client, 'chat-a', '/project Alpha Repo')
  const freshA = host.latestCreate()
  await send(client, 'chat-a', 'a-new')
  await send(client, 'chat-b', 'b-still-old')

  assert.equal(host.followups.at(-2)?.agent, freshA.agent)
  assert.equal(host.followups.at(-1)?.agent, oldB.agent)
  assert.equal(oldA.agent.disposed, true)
  assert.equal(oldB.agent.disposed, false)
  assert.equal(freshA.cwd, workspaces[0]?.path)
})

test('defaultSessionId shares one project selection across every chat', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces, { defaultSessionId: 'shared-session' })
  await send(client, 'chat-a', 'shared old')
  const old = host.latestCreate()

  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()
  await send(client, 'chat-b', 'continue from another chat')

  assert.equal(old.agent.disposed, true)
  assert.equal(fresh.cwd, workspaces[0]?.path)
  assert.equal(host.followups.at(-1)?.agent, fresh.agent)
  assert.equal(host.creates.length, 2)
})

test('a slow project lookup blocks only its own conversation', async (t) => {
  const workspaces = standardWorkspaces()
  const alpha = workspaces[0]
  assert.ok(alpha !== undefined)
  const status = deferred<void>()
  alpha.statusWait = status.promise
  const { host, client } = mount(t, workspaces)

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => alpha.statusCalls.length === 1, 'project status check did not start')
  await send(client, 'chat-b', 'independent work')
  assert.equal(host.followups.at(-1)?.agent.session.id, 'lark:chat-b')

  status.resolve()
  await switching
  assert.equal(host.latestCreate().cwd, alpha.path)
})

test('conversation FIFO preserves text arrival before runtime commands and project listings', async (t) => {
  const { host, client } = mount(t, standardWorkspaces())
  await send(client, 'chat-a', 'warm conversation')

  host.runtimeHandler = async (agent, line) => {
    assert.equal(line, '/hold')
    host.operations.push(`runtime:start:${agent.id}`)
    host.operations.push(`runtime:end:${agent.id}`)
  }
  host.operations.length = 0
  await Promise.all([
    send(client, 'chat-a', 'text before runtime'),
    send(client, 'chat-a', '/hold'),
  ])
  const followupBeforeRuntime = host.operations.findIndex((entry) => entry.startsWith('followup:'))
  const runtimeStart = host.operations.findIndex((entry) => entry.startsWith('runtime:start:'))
  assert.ok(followupBeforeRuntime >= 0)
  assert.ok(runtimeStart > followupBeforeRuntime)

  host.operations.length = 0
  host.workspaceResolveHandler = async () => {
    host.operations.push('project:list')
    return undefined
  }
  await Promise.all([
    send(client, 'chat-a', 'text before project list'),
    send(client, 'chat-a', '/project'),
  ])
  const followupBeforeList = host.operations.findIndex((entry) => entry.startsWith('followup:'))
  const projectList = host.operations.indexOf('project:list')
  assert.ok(followupBeforeList >= 0)
  assert.ok(projectList > followupBeforeList)
})

test('a running runtime command blocks a later followup on the same conversation', async (t) => {
  const { host, client } = mount(t, standardWorkspaces())
  await send(client, 'chat-a', 'warm conversation')
  const followupsBefore = host.followups.length
  host.operations.length = 0
  const runtimeStarted = deferred<void>()
  const runtimeRelease = deferred<void>()
  host.runtimeHandler = async (agent, line) => {
    assert.equal(line, '/hold')
    host.operations.push(`runtime:start:${agent.id}`)
    runtimeStarted.resolve()
    await runtimeRelease.promise
    host.operations.push(`runtime:end:${agent.id}`)
  }

  const runtime = send(client, 'chat-a', '/hold')
  await runtimeStarted.promise
  const followup = send(client, 'chat-a', 'wait behind runtime')
  await yieldTurn()
  assert.equal(host.followups.length, followupsBefore)

  runtimeRelease.resolve()
  await Promise.all([runtime, followup])
  assert.equal(host.followups.length, followupsBefore + 1)
  const runtimeEnd = host.operations.findIndex((entry) => entry.startsWith('runtime:end:'))
  const laterFollowup = host.operations.findIndex((entry) => entry.startsWith('followup:'))
  assert.ok(runtimeEnd >= 0)
  assert.ok(laterFollowup > runtimeEnd)
})

test('runtime and reset queued behind a slow project do not block another conversation', async (t) => {
  const workspaces = standardWorkspaces()
  const alpha = workspaces[0]
  assert.ok(alpha !== undefined)
  const status = deferred<void>()
  alpha.statusWait = status.promise
  const { host, client } = mount(t, workspaces)
  host.runtimeHandler = async () => {}

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => alpha.statusCalls.length === 1, 'project status check did not start')
  const runtime = send(client, 'chat-a', '/hold')
  const reset = send(client, 'chat-a', '/new')
  await yieldTurn()
  assert.equal(host.runtimeExecutions.length, 0)

  await send(client, 'chat-b', 'independent while A is queued')
  assert.equal(host.followups.at(-1)?.agent.session.id, 'lark:chat-b')
  assert.equal(host.runtimeExecutions.length, 0)

  status.resolve()
  await Promise.all([switching, runtime, reset])
  assert.equal(host.runtimeExecutions.length, 1)
  assert.equal(host.latestCreate().agent.disposed, false)
})

test('an unconfirmed /new binding fail-stops only its own conversation', async (t) => {
  const { host, client, bridge } = mount(t)
  await send(client, 'chat-a', 'old A context')
  const candidateCheckpoint = deferred<void>()
  host.planFlush({ result: true })
  host.planFlush({ result: true, wait: candidateCheckpoint.promise })
  const resetting = send(client, 'chat-a', '/new')
  await waitFor(() => host.flushCalls.length === 2, 'reset candidate checkpoint did not start')
  host.bindingPutError = new Error('persistent reset binding acknowledgement failure')
  candidateCheckpoint.resolve()
  await waitFor(() => host.bindingPuts.length >= 4, 'reset binding confirmation did not retry')

  await send(client, 'chat-b', 'independent during reset fail-stop')
  assert.equal(host.followups.at(-1)?.agent.session.id, 'lark:chat-b')

  await bridge.stop()
  await assert.rejects(resetting, /binding confirmation was interrupted by shutdown/)
})

test('project switching rejects a running or queued old conversation without dropping work', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()

  old.agent.status = 'running'
  await send(client, 'chat-a', '/project Alpha Repo')
  assert.equal(host.creates.length, 1)
  assert.equal(old.agent.disposed, false)
  assert.match(client.sent.at(-1)?.text ?? '', /执行或待处理消息/)

  old.agent.status = 'idle'
  old.agent.inbox.hasPending = true
  await send(client, 'chat-a', '/project Alpha Repo')
  assert.equal(host.creates.length, 1)
  assert.equal(old.agent.disposed, false)
  assert.match(client.sent.at(-1)?.text ?? '', /执行或待处理消息/)
})

test('an external followup accepted before binding commit aborts the candidate without losing old work', async (t) => {
  const { host, client } = mount(t)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  const candidateCheckpoint = deferred<void>()
  host.planFlush({ result: true })
  host.planFlush({ result: true, wait: candidateCheckpoint.promise })

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.flushCalls.length === 2, 'candidate checkpoint did not start')
  const candidate = host.latestCreate()
  old.agent.followup({ id: 'external-before-commit' })
  candidateCheckpoint.resolve()
  await switching

  assert.equal(candidate.agent.disposed, true)
  assert.equal(old.agent.disposed, false)
  assert.equal(host.bindingPuts.length, 1)
  assert.match(client.sent.at(-1)?.text ?? '', /执行或待处理消息/)
  old.agent.finishPending()
  await send(client, 'chat-a', 'still on old binding')
  assert.equal(host.followups.at(-1)?.agent, old.agent)
})

test('an external followup during the final binding put commits forward but retires old only after idle', async (t) => {
  const { host, client } = mount(t)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  const commit = deferred<void>()
  host.planBindingPut({})
  host.planBindingPut({ wait: commit.promise })

  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.bindingPuts.length === 2, 'final binding put did not start')
  const candidate = host.latestCreate()
  old.agent.followup({ id: 'external-during-commit' })
  commit.resolve()
  await switching

  assert.equal(candidate.agent.disposed, false)
  assert.equal(old.agent.disposed, false, 'accepted old work was disposed before reaching idle')
  await send(client, 'chat-a', 'new binding work')
  assert.equal(host.followups.at(-1)?.agent, candidate.agent)
  old.agent.finishPending()
  await waitFor(() => old.agent.disposed, 'old handle was not retired after accepted work became idle')
})

test('a retired handle rechecks status when new work wins the whenIdle resolution race', async (t) => {
  const { host, client } = mount(t)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  const firstIdle = deferred<void>()
  const secondIdle = deferred<void>()
  let idleCalls = 0
  old.agent.whenIdle = () => {
    idleCalls += 1
    return idleCalls === 1 ? firstIdle.promise : secondIdle.promise
  }

  await send(client, 'chat-a', '/project Alpha Repo')
  assert.equal(idleCalls, 1)
  assert.equal(old.agent.disposed, false)

  old.agent.status = 'running'
  firstIdle.resolve()
  await waitFor(() => idleCalls === 2, 'retirement did not wait for the later running phase')
  assert.equal(old.agent.disposed, false)

  old.agent.status = 'idle'
  secondIdle.resolve()
  await waitFor(() => old.agent.disposed, 'retirement did not finish after the later work became idle')
})

test('a deferred project listing cannot overwrite a later switch with stale current state', async (t) => {
  const workspaces = standardWorkspaces()
  const alpha = workspaces[0]
  const beta = workspaces[1]
  assert.ok(alpha !== undefined && beta !== undefined)
  const resolution = deferred<TestWorkspace | undefined>()
  const { host, client } = mount(t, workspaces)
  host.workspaceResolveHandler = () => resolution.promise
  await send(client, 'chat-a', 'old context')

  const listing = send(client, 'chat-a', '/project')
  await waitFor(() => host.workspaceResolveCalls.length === 1, 'project resolution did not start')
  const switching = send(client, 'chat-a', '/project Beta Repo')
  await yieldTurn()
  assert.equal(host.creates.length, 1, 'switch bypassed the conversation listing barrier')

  resolution.resolve(alpha)
  await Promise.all([listing, switching])
  assert.equal(host.latestCreate().cwd, beta.path)

  await send(client, 'chat-a', '/project Alpha Repo')
  assert.equal(host.latestCreate().cwd, alpha.path, 'stale listing cache caused a false no-op')
})

test('/project serializes with runtime commands and /new on the same conversation', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()

  const projectCheckpoint = deferred<void>()
  host.planFlush({ result: true })
  host.planFlush({ result: true, wait: projectCheckpoint.promise })
  const switching = send(client, 'chat-a', '/project Alpha Repo')
  await waitFor(() => host.flushCalls.length === 2, 'new project checkpoint did not start')
  const projectAgent = host.latestCreate()

  const runtimeStarted = deferred<ProjectAgent>()
  const runtimeRelease = deferred<void>()
  host.runtimeHandler = async (agent, line) => {
    assert.equal(line, '/hold')
    host.operations.push(`runtime:start:${agent.id}`)
    runtimeStarted.resolve(agent)
    await runtimeRelease.promise
    host.operations.push(`runtime:end:${agent.id}`)
  }
  const runtime = send(client, 'chat-a', '/hold')
  const reset = send(client, 'chat-a', '/new')
  await yieldTurn()
  assert.equal(host.runtimeExecutions.length, 0)
  assert.equal(host.creates.length, 2)

  projectCheckpoint.resolve()
  await switching
  assert.equal(await runtimeStarted.promise, projectAgent.agent)
  await yieldTurn()
  assert.equal(host.creates.length, 2, '/new bypassed the running command')

  runtimeRelease.resolve()
  await Promise.all([runtime, reset])
  const resetAgent = host.latestCreate()
  assert.equal(host.creates.length, 3)
  assert.equal(resetAgent.cwd, workspaces[0]?.path, '/new lost the selected project')
  assert.equal(old.agent.disposed, true)
  assert.equal(projectAgent.agent.disposed, true)
  assert.equal(resetAgent.agent.disposed, false)

  const runtimeEnd = host.operations.indexOf(`runtime:end:${projectAgent.sessionId}`)
  const resetCreate = host.operations.indexOf(`create:${resetAgent.sessionId}:${workspaces[0]?.path}`)
  assert.ok(runtimeEnd >= 0)
  assert.ok(resetCreate > runtimeEnd)
})

test('a replayed /new mutation after restart acknowledges the committed generation without resetting again', async (t) => {
  const first = mount(t)
  const resetMessage = inbound('chat-replay', '/new')
  assert.ok(first.client.handler !== undefined)
  await first.client.handler(resetMessage)
  const committedSession = first.host.latestCreate()
  const persisted = first.host.persisted.get(committedSession.sessionId)
  const binding = first.host.bindings.get('lark:chat-replay')
  assert.ok(persisted !== undefined)
  assert.ok(binding !== undefined)
  await first.bridge.stop()

  const second = mount(t)
  second.host.persisted.set(committedSession.sessionId, persisted)
  second.host.bindings.set('lark:chat-replay', binding)
  assert.ok(second.client.handler !== undefined)
  await second.client.handler(resetMessage)

  assert.deepEqual(second.host.resumes, [committedSession.sessionId])
  assert.equal(second.host.creates.length, 1)
  assert.equal(second.host.latestCreate().sessionId, committedSession.sessionId)
  assert.match(second.client.sent.at(-1)?.text ?? '', /已开始新会话/)
})

test('a delayed /new replay remains idempotent after a later project mutation', async (t) => {
  const first = mount(t)
  const earlierReset = inbound('chat-delayed-replay', '/new')
  const laterProject = inbound('chat-delayed-replay', '/project Alpha Repo')
  assert.ok(first.client.handler !== undefined)
  await first.client.handler(earlierReset)
  await first.client.handler(laterProject)

  const committedSession = first.host.latestCreate()
  const persisted = first.host.persisted.get(committedSession.sessionId)
  const binding = first.host.bindings.get('lark:chat-delayed-replay')
  assert.ok(persisted !== undefined)
  assert.ok(binding !== undefined)
  assert.equal(binding.mutationHashes.length, 2)
  await first.bridge.stop()

  const second = mount(t)
  second.host.persisted.set(committedSession.sessionId, persisted)
  second.host.bindings.set('lark:chat-delayed-replay', binding)
  assert.ok(second.client.handler !== undefined)
  await second.client.handler(earlierReset)

  assert.deepEqual(second.host.resumes, [committedSession.sessionId])
  assert.equal(second.host.creates.length, 1)
  assert.equal(second.host.latestCreate().sessionId, committedSession.sessionId)
  assert.match(second.client.sent.at(-1)?.text ?? '', /已开始新会话/)
})

test('a delayed project replay cannot roll back a later project mutation', async (t) => {
  const first = mount(t)
  const earlierProject = inbound('chat-project-replay', '/project Alpha Repo')
  const laterProject = inbound('chat-project-replay', '/project Beta Repo')
  assert.ok(first.client.handler !== undefined)
  await first.client.handler(earlierProject)
  await first.client.handler(laterProject)

  const committedSession = first.host.latestCreate()
  const persisted = first.host.persisted.get(committedSession.sessionId)
  const binding = first.host.bindings.get('lark:chat-project-replay')
  assert.ok(persisted !== undefined)
  assert.ok(binding !== undefined)
  assert.equal(committedSession.cwd, '/srv/private/beta-repo')
  assert.equal(binding.mutationHashes.length, 2)
  await first.bridge.stop()

  const second = mount(t)
  second.host.persisted.set(committedSession.sessionId, persisted)
  second.host.bindings.set('lark:chat-project-replay', binding)
  assert.ok(second.client.handler !== undefined)
  await second.client.handler(earlierProject)

  assert.equal(second.host.creates.length, 1)
  assert.deepEqual(second.host.resumes, [committedSession.sessionId])
  assert.deepEqual(second.host.bindings.get('lark:chat-project-replay'), binding)
  assert.match(second.client.sent.at(-1)?.text ?? '', /已处理.*最新状态/)

  await send(second.client, 'chat-project-replay', 'continue in the latest project')
  assert.deepEqual(second.host.resumes, [committedSession.sessionId])
  assert.equal(second.host.followups.at(-1)?.agent.session.header.cwd, '/srv/private/beta-repo')
})

test('a delayed already-current project replay cannot roll back a later project mutation', async (t) => {
  const first = mount(t)
  assert.ok(first.client.handler !== undefined)
  await first.client.handler(inbound('chat-project-noop-replay', '/project Alpha Repo'))
  const earlierNoop = inbound('chat-project-noop-replay', '/project Alpha Repo')
  await first.client.handler(earlierNoop)
  await first.client.handler(inbound('chat-project-noop-replay', '/project Beta Repo'))

  const committedSession = first.host.latestCreate()
  const persisted = first.host.persisted.get(committedSession.sessionId)
  const binding = first.host.bindings.get('lark:chat-project-noop-replay')
  assert.ok(persisted !== undefined)
  assert.ok(binding !== undefined)
  assert.equal(committedSession.cwd, '/srv/private/beta-repo')
  assert.equal(binding.mutationHashes.length, 3)
  await first.bridge.stop()

  const second = mount(t)
  second.host.persisted.set(committedSession.sessionId, persisted)
  second.host.bindings.set('lark:chat-project-noop-replay', binding)
  assert.ok(second.client.handler !== undefined)
  await second.client.handler(earlierNoop)

  assert.equal(second.host.creates.length, 1)
  assert.deepEqual(second.host.resumes, [committedSession.sessionId])
  assert.match(second.client.sent.at(-1)?.text ?? '', /已处理.*最新状态/)
  await send(second.client, 'chat-project-noop-replay', 'continue in beta')
  assert.deepEqual(second.host.resumes, [committedSession.sessionId])
  assert.equal(second.host.followups.at(-1)?.agent.session.header.cwd, '/srv/private/beta-repo')
})

test('workspace attach failure is warned after commit and does not roll back the new binding', async (t) => {
  const workspaces = standardWorkspaces()
  const workspace = workspaces[0]
  assert.ok(workspace !== undefined)
  workspace.attachError = new Error('workspace index unavailable')
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()

  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()
  assert.equal(host.flushCalls.includes(fresh.sessionId), true)
  assert.deepEqual(workspace.attachCalls, [])
  assert.equal(old.agent.disposed, true)
  assert.equal(fresh.agent.disposed, false)

  await send(client, 'chat-a', 'continue after attach failure')
  host.emitTurnStart(fresh.agent)
  await waitFor(
    () => host.warnings.some((args) => (
      args.some((value) => String(value).includes('workspace index unavailable'))
    )),
    'deferred Workspace attachment failure was not reported',
  )
  assert.deepEqual(workspace.attachCalls, [fresh.sessionId])
  assert.ok(host.warnings.some((args) => (
    args.some((value) => String(value).includes('workspace index unavailable'))
  )))

  assert.equal(host.followups.at(-1)?.agent, fresh.agent)
  assert.ok(client.sent.some(({ text }) => /Alpha Repo/.test(text)))
})

test('Workspace indexing waits for a confirmed non-blank checkpoint and retries later', async (t) => {
  const workspaces = standardWorkspaces()
  const workspace = workspaces[0]
  assert.ok(workspace !== undefined)
  const { host, client } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()
  assert.deepEqual(workspace.attachCalls, [])

  const firstTurnCheckpoint = deferred<void>()
  host.planFlush({ result: false, wait: firstTurnCheckpoint.promise })
  const flushesBeforeTurn = host.flushCalls.length
  await send(client, 'chat-a', 'first project turn')
  host.emitTurnStart(fresh.agent, 1)
  await waitFor(
    () => host.flushCalls.length === flushesBeforeTurn + 1,
    'first turn checkpoint did not start',
  )
  await send(client, 'chat-a', 'second project turn')
  host.emitTurnStart(fresh.agent, 2)
  firstTurnCheckpoint.resolve()
  await waitFor(
    () => host.warnings.some((args) => (
      args.some((value) => String(value).includes('leaving it unindexed'))
    )),
    'unconfirmed turn checkpoint was not reported',
  )
  await waitFor(
    () => workspace.attachCalls.length === 1,
    'overlapping later turn did not retry Workspace indexing',
  )
  assert.deepEqual(workspace.attachCalls, [fresh.sessionId])
})

test('Workspace indexing retries the current registration when the same path gets a new id', async (t) => {
  const original = new TestWorkspace(
    WORKSPACE_IDS.alpha,
    'Original Repo',
    '/srv/private/re-registered-repo',
  )
  const { host, client } = mount(t, [original])
  await send(client, 'chat-a', 'old context')
  await send(client, 'chat-a', '/project Original Repo')
  const fresh = host.latestCreate()
  const firstCheckpoint = deferred<void>()
  host.planFlush({ result: true, wait: firstCheckpoint.promise })
  const flushesBeforeTurn = host.flushCalls.length

  await send(client, 'chat-a', 'first indexed turn')
  host.emitTurnStart(fresh.agent, 1)
  await waitFor(
    () => host.flushCalls.length === flushesBeforeTurn + 1,
    'first Workspace checkpoint did not start',
  )
  const replacement = new TestWorkspace(
    WORKSPACE_IDS.beta,
    'Replacement Repo',
    original.path,
  )
  host.workspaces.splice(0, 1, replacement)
  await send(client, 'chat-a', 'turn after Workspace re-registration')
  host.emitTurnStart(fresh.agent, 2)
  firstCheckpoint.resolve()

  await waitFor(
    () => replacement.attachCalls.length === 1,
    'current Workspace registration was not retried',
  )
  assert.deepEqual(original.attachCalls, [])
  assert.deepEqual(replacement.attachCalls, [fresh.sessionId])
})

test('a terminal old handle is never retained or disposed twice after project cleanup rejects', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client, bridge } = mount(t, workspaces)
  await send(client, 'chat-a', 'old context')
  const old = host.latestCreate()
  host.disposeErrorOnce = new Error('terminal cleanup report')

  await send(client, 'chat-a', '/project Alpha Repo')
  const fresh = host.latestCreate()
  assert.equal(old.agent.disposed, true)
  assert.equal(fresh.agent.disposed, false)
  assert.equal(host.disposals.filter((id) => id === old.sessionId).length, 1)

  await bridge.stop()
  assert.equal(host.disposals.filter((id) => id === old.sessionId).length, 1)
  assert.equal(host.disposals.filter((id) => id === fresh.sessionId).length, 1)
})
