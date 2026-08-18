import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { setImmediate as yieldImmediate, setTimeout as delay } from 'node:timers/promises'
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
    await delay(2)
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
  sendTextHandler?: (chatId: string, text: string) => Promise<void>
  handler?: (message: LarkInbound) => Promise<void>
}

function createClient(): ProjectClient {
  const client: ProjectClient = {
    sent: [],
    async start() {},
    async stop() {},
    async sendText(chatId, text, options) {
      client.sent.push({ chatId, text, options })
      await client.sendTextHandler?.(chatId, text)
    },
    onMessage(handler) { client.handler = handler },
  }
  return client
}

let inboundSequence = 0

function inbound(
  chatId: string,
  text: string,
  overrides: Partial<Pick<LarkInbound, 'chatType' | 'openId' | 'messageId' | 'mentioned' | 'rootId' | 'threadId'>> = {},
): LarkInbound {
  inboundSequence += 1
  return {
    chatId,
    chatType: overrides.chatType ?? 'p2p',
    openId: overrides.openId ?? 'owner',
    text,
    messageId: overrides.messageId ?? `project-${inboundSequence}`,
    mentioned: overrides.mentioned ?? false,
    ...(overrides.rootId === undefined ? {} : { rootId: overrides.rootId }),
    ...(overrides.threadId === undefined ? {} : { threadId: overrides.threadId }),
  }
}

async function send(
  client: ProjectClient,
  chatId: string,
  text: string,
  overrides?: Parameters<typeof inbound>[2],
): Promise<void> {
  assert.ok(client.handler !== undefined)
  await client.handler(inbound(chatId, text, overrides))
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
    readonly version: number
    readonly id: string
    readonly createdAt: number
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
  maintenanceAttempts = 0
  whenIdleCalls = 0
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
    this.whenIdleCalls += 1
    if (!this.maintenance && !this.inbox.hasPending) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  finishPending(): void {
    this.inbox.hasPending = false
    if (this.maintenance) return
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.maintenanceAttempts += 1
    const plannedThrow = this.host.maintenanceThrowPlans.get(this.id)?.shift()
    if (plannedThrow !== undefined) throw plannedThrow
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
  readonly workspaceCreateCalls: Array<{ readonly path: string; readonly title: string }> = []
  readonly workspaceDeleteCalls: string[] = []
  readonly sessionTitles = new Map<string, string>()
  readonly archivedSessionIds: string[] = []
  archivedSessionIdsReads = 0
  archivedSessionIdsReadHandler?: (read: number) => void
  sessionQueryListCalls = 0
  sessionQueryListHandler?: (call: number) => Promise<void> | void
  sessionTitleHeaderOverride?: Partial<ProjectSession['header']>
  resumeHandler?: (sessionId: string, signal: AbortSignal | undefined) => Promise<void>
  workspaceRegistryAvailable = true
  workspaceRegistryMutable = true
  sessionPersistenceAvailable = true
  sessionQueryAvailable = true
  defaultPreset = 'coding'
  createError?: Error
  readonly maintenanceThrowPlans = new Map<string, Error[]>()
  bindingPutError?: Error
  disposeErrorOnce?: Error
  runtimeHandler?: (agent: ProjectAgent, line: string) => Promise<void>
  workspaceResolveHandler?: (path: string) => Promise<TestWorkspace | undefined>
  workspaceCreateHandler?: (path: string, title: string) => Promise<TestWorkspace>
  workspaceDeleteHandler?: (id: string) => Promise<boolean>
  sessionEventListener?: (session: ProjectSession, event: {
    readonly type: 'turn/start'
    readonly time: number
    readonly data: { readonly turn: number }
  }) => void
  private readonly flushPlans: FlushPlan[] = []
  private readonly bindingPutPlans: BindingPutPlan[] = []
  private workspaceRegistryService?: Record<string, unknown>

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
        const host = this
        this.workspaceRegistryService ??= {
          list: () => [...this.workspaces],
          get: (id: unknown) => this.workspaces.find((workspace) => workspace.id === String(id)),
          get archivedSessionIds() {
            host.archivedSessionIdsReads += 1
            host.archivedSessionIdsReadHandler?.(host.archivedSessionIdsReads)
            return host.archivedSessionIds
          },
          resolveByPath: async (path: string) => {
            this.workspaceResolveCalls.push(path)
            return this.workspaceResolveHandler === undefined
              ? this.workspaces.find((workspace) => workspace.path === path)
              : this.workspaceResolveHandler(path)
          },
          ...(this.workspaceRegistryMutable
            ? {
                create: (path: string, title: string) => this.createWorkspace(path, title),
                delete: (id: string) => this.deleteWorkspace(id),
              }
            : {}),
        }
        return this.workspaceRegistryService
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
      if (name === 'sessionQuery' && this.sessionQueryAvailable) {
        return {
          listSessions: async () => {
            this.sessionQueryListCalls += 1
            await this.sessionQueryListHandler?.(this.sessionQueryListCalls)
            const ids = new Set([...this.persisted.keys(), ...this.liveSessions.keys()])
            return [...ids].map((id) => {
              const session = this.liveSessions.get(id) ?? this.persisted.get(id)
              assert.ok(session !== undefined)
              return {
                header: { id, ...session.header },
                live: this.liveSessions.has(id),
                persisted: this.persisted.has(id),
              }
            }).sort((left, right) => right.header.createdAt - left.header.createdAt)
          },
          readTitleSnapshots: async (ids: readonly string[]) => ids.map((id) => {
            const session = this.liveSessions.get(id) ?? this.persisted.get(id)
            if (session === undefined) return { sessionId: id, status: 'rejected' as const, reason: new Error('missing') }
            const title = this.sessionTitles.get(id)
            return {
              sessionId: id,
              status: 'fulfilled' as const,
              value: {
                session: { id, ...session.header, ...this.sessionTitleHeaderOverride },
                ...(title === undefined ? {} : { title: { title } }),
              },
            }
          }),
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
        meta?: { cwd?: string; agentPreset?: string; createdAt?: number }
        seed?: readonly unknown[]
        setup?: (agentCtx: unknown) => Promise<unknown> | unknown
      }) => this.create(options),
      resume: (options: {
        resumeSessionId: unknown
        signal?: AbortSignal
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

  planMaintenanceThrow(sessionId: string, error: Error): void {
    const plans = this.maintenanceThrowPlans.get(sessionId) ?? []
    plans.push(error)
    this.maintenanceThrowPlans.set(sessionId, plans)
  }

  planBindingPut(plan: BindingPutPlan): void {
    this.bindingPutPlans.push(plan)
  }

  seedPersisted(
    sessionId: string,
    options: {
      readonly cwd: string
      readonly createdAt: number
      readonly title?: string
      readonly agentPreset?: string
      readonly events?: readonly unknown[]
    },
  ): ProjectSession {
    const events = [...(options.events ?? [{ type: 'todo/write', data: { todos: [] } }])]
    const session: ProjectSession = {
      id: sessionId,
      header: {
        version: 0,
        id: sessionId,
        createdAt: options.createdAt,
        cwd: options.cwd,
        ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
      },
      events,
      append(type, data) {
        const event = { type, data }
        events.push(event)
        return event
      },
      requestContext: () => undefined,
    }
    this.persisted.set(sessionId, session)
    if (options.title !== undefined) this.sessionTitles.set(sessionId, options.title)
    return session
  }

  private async createWorkspace(path: string, title: string): Promise<TestWorkspace> {
    this.workspaceCreateCalls.push({ path, title })
    this.operations.push(`workspace-create:${title}`)
    if (this.workspaceCreateHandler !== undefined) {
      return this.workspaceCreateHandler(path, title)
    }
    const existing = this.workspaces.find((workspace) => workspace.path === path)
    if (existing !== undefined) return existing
    const suffix = String(this.workspaceCreateCalls.length).padStart(12, '0')
    const workspace = new TestWorkspace(
      `00000000-0000-4000-8000-${suffix}`,
      title,
      path,
    )
    this.workspaces.push(workspace)
    return workspace
  }

  private async deleteWorkspace(id: string): Promise<boolean> {
    this.workspaceDeleteCalls.push(id)
    this.operations.push(`workspace-delete:${id}`)
    if (this.workspaceDeleteHandler !== undefined) return this.workspaceDeleteHandler(id)
    const index = this.workspaces.findIndex((workspace) => workspace.id === id)
    if (index < 0) return false
    this.workspaces.splice(index, 1)
    return true
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
    meta?: { cwd?: string; agentPreset?: string; createdAt?: number }
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
      on: () => () => {},
      tools: { register: (tool: { name: string }) => { scopedTools.push(tool.name) } },
    }) as { commit?: () => void } | undefined
    setupResult?.commit?.()
    const events = [...(options.seed ?? [])]
    const session: ProjectSession = {
      id: sessionId,
      header: {
        version: 0,
        id: sessionId,
        createdAt: options.meta?.createdAt ?? Date.now(),
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
    signal?: AbortSignal
    setup?: (agentCtx: unknown) => Promise<unknown> | unknown
  }) {
    const sessionId = String(options.resumeSessionId)
    const stored = this.persisted.get(sessionId)
    if (stored === undefined) throw new Error(`session "${sessionId}" not found`)
    await this.resumeHandler?.(sessionId, options.signal)
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

async function navigableWorkspaces(
  t: { after(callback: () => void | Promise<void>): void },
): Promise<TestWorkspace[]> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-session-workspaces-'))
  const alpha = join(root, 'alpha')
  const beta = join(root, 'beta')
  await mkdir(alpha)
  await mkdir(beta)
  t.after(() => rm(root, { recursive: true, force: true }))
  return [
    new TestWorkspace(WORKSPACE_IDS.alpha, 'Alpha Repo', await realpath(alpha)),
    new TestWorkspace(WORKSPACE_IDS.beta, 'Beta Repo', await realpath(beta)),
  ]
}

function mount(
  t: { after(callback: () => void | Promise<void>): void },
  workspaces: readonly TestWorkspace[] = standardWorkspaces(),
  options: {
    defaultSessionId?: string
    workspaceRegistryAvailable?: boolean
    workspaceRegistryMutable?: boolean
    sessionPersistenceAvailable?: boolean
    sessionQueryAvailable?: boolean
    sessionReferenceNamespace?: string
    projectManageFrom?: string[]
    allowFrom?: string[]
    allowAllUsers?: boolean
    cwd?: string
  } = {},
): { readonly host: ProjectHost; readonly client: ProjectClient; readonly bridge: LarkBridge } {
  const host = new ProjectHost(workspaces)
  host.workspaceRegistryAvailable = options.workspaceRegistryAvailable ?? true
  host.workspaceRegistryMutable = options.workspaceRegistryMutable ?? true
  host.sessionPersistenceAvailable = options.sessionPersistenceAvailable ?? true
  host.sessionQueryAvailable = options.sessionQueryAvailable ?? true
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
    allowFrom: options.allowFrom ?? ['owner'],
    allowAllUsers: options.allowAllUsers,
    projectManageFrom: options.projectManageFrom ?? ['owner'],
    cwd: options.cwd ?? '/srv/default-repo',
    defaultSessionId: options.defaultSessionId,
    sessionReferenceNamespace: options.sessionReferenceNamespace ?? 'test-app',
  })
  void bridge.start()
  t.after(() => bridge.stop())
  return { host, client, bridge }
}

function seedSessionNavigation(host: ProjectHost, workspace: TestWorkspace, chatId: string): {
  readonly baseId: string
  readonly historicalId: string
  readonly currentId: string
} {
  const baseId = `lark:${chatId}`
  const historicalId = baseId
  const currentId = `${baseId}:1-00000000-0000-4000-8000-000000000001`
  host.seedPersisted(historicalId, {
    cwd: workspace.path,
    createdAt: 1_000,
    title: 'Old <at user_id="all"> session\nline',
    agentPreset: 'coding',
  })
  host.seedPersisted(currentId, {
    cwd: workspace.path,
    createdAt: 2_000,
    title: 'Current session',
    agentPreset: 'coding',
  })
  workspace.sessionIds.push(currentId, historicalId)
  host.bindings.set(baseId, {
    generation: 1,
    suffix: '1-00000000-0000-4000-8000-000000000001',
    modelSelection: null,
    mutationHashes: [],
  })
  return { baseId, historicalId, currentId }
}

test('/session lists only scoped opaque references and resumes committed history', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-nav')

  await send(client, 'session-nav', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  assert.equal(host.creates.length, 0, 'session listing unexpectedly opened an Agent')
  const references = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)].map(([reference]) => reference)
  assert.equal(references.length, 2)
  assert.equal(new Set(references).size, 2)
  assert.doesNotMatch(catalog, /<at|[\r\n]line/u)
  assert.equal(catalog.includes(workspaces[0]!.path), false)
  assert.equal(catalog.includes(seeded.historicalId), false)
  assert.equal(catalog.includes(seeded.currentId), false)
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  assert.ok(currentLine !== undefined)
  const historicalReference = references.find((reference) => !currentLine.includes(reference))
  assert.ok(historicalReference !== undefined)

  await send(client, 'other-session-nav', `/session resume ${historicalReference}`)
  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)

  await send(client, 'session-nav', `/session resume ${historicalReference}`)
  assert.match(client.sent.at(-1)?.text ?? '', /已恢复所选会话/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 0)
  assert.equal(host.resumes.includes(seeded.historicalId), true)

  t.mock.method(Date, 'now', () => 0)
  await send(client, 'session-nav', '/new')
  const resetGeneration = Number(/^.+:(\d+)-/u.exec(host.latestCreate().sessionId)?.[1])
  assert.equal(resetGeneration, 2)
})

test('/session hides archived or externally live history and keeps failures on the current binding', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-guard')

  await send(client, 'session-guard', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)

  host.planFlush({ result: false })
  await send(client, 'session-guard', `/session resume ${reference}`)
  assert.match(client.sent.at(-1)?.text ?? '', /无法确认当前会话历史/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.deepEqual(host.resumes, [seeded.currentId])

  const external = await host.ctx.agents.resume({ resumeSessionId: seeded.historicalId })
  await send(client, 'session-guard', `/session resume ${reference}`)
  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  await external.dispose()

  host.archivedSessionIds.push(seeded.historicalId)
  await send(client, 'session-guard', '/session list')
  assert.equal(([...(client.sent.at(-1)?.text ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 1)
})

test('/session disposes a resumed candidate whose durability checkpoint fails', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-candidate-failure')
  await send(client, 'session-candidate-failure', '/help')
  await send(client, 'session-candidate-failure', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  host.planFlush({ result: true })
  host.planFlush({ result: false })

  await send(client, 'session-candidate-failure', `/session resume ${reference}`)

  assert.match(client.sent.at(-1)?.text ?? '', /会话恢复失败/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.resumes.includes(seeded.historicalId), true)
  assert.equal(host.disposals.includes(seeded.historicalId), true)
  assert.equal(host.liveAgents.has(seeded.historicalId), false)
})

test('/session preserves target work admitted during the candidate checkpoint', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-candidate-work')
  await send(client, 'session-candidate-work', '/help')
  await send(client, 'session-candidate-work', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const candidateCheckpoint = deferred<void>()
  host.planFlush({ result: true })
  host.planFlush({ result: true, wait: candidateCheckpoint.promise })

  const resuming = send(client, 'session-candidate-work', `/session resume ${reference}`)
  await waitFor(
    () => host.flushCalls.filter((id) => id === seeded.historicalId).length === 1,
    'candidate durability checkpoint did not start',
  )
  const targetAgent = host.liveAgents.get(seeded.historicalId)
  assert.ok(targetAgent !== undefined)
  t.after(() => targetAgent.finishPending())
  targetAgent.followup({ kind: 'checkpoint-target-work' })
  candidateCheckpoint.resolve()
  await resuming

  assert.match(client.sent.at(-1)?.text ?? '', /仍有执行或待处理消息/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.liveAgents.has(seeded.historicalId), true)
  assert.equal(host.disposals.includes(seeded.historicalId), false)
  targetAgent.finishPending()
  await waitFor(
    () => !host.liveAgents.has(seeded.historicalId),
    'checkpoint-raced candidate did not retire after admitted work became durable',
  )
  assert.equal(host.persisted.get(seeded.historicalId)?.events.some((event) => (
    (event as { data?: { kind?: string } }).data?.kind === 'checkpoint-target-work'
  )), true)
})

test('/session retains a rolled-back candidate without spinning when retirement is not durable', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-retirement-failure')
  await send(client, 'session-retirement-failure', '/help')
  await send(client, 'session-retirement-failure', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const finalValidationCall = host.sessionQueryListCalls + 3
  host.sessionQueryListHandler = (call) => {
    if (call === finalValidationCall) host.archivedSessionIds.push(seeded.historicalId)
  }
  host.planFlush({ result: true })
  host.planFlush({ result: true })
  host.planFlush({ error: new Error('retirement persistence unavailable') })

  await send(client, 'session-retirement-failure', `/session resume ${reference}`)
  await yieldTurn()
  const targetFlushes = (): number => host.flushCalls.filter((id) => id === seeded.historicalId).length
  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.liveAgents.has(seeded.historicalId), true)
  assert.equal(targetFlushes(), 2)
  await delay(20)
  assert.equal(targetFlushes(), 2)
  await send(client, 'session-retirement-unrelated', '/help')
  assert.match(client.sent.at(-1)?.text ?? '', /\/session resume/u)
})

test('/session retains a rolled-back candidate without spinning when retirement maintenance throws', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-retirement-throw')
  await send(client, 'session-retirement-throw', '/help')
  await send(client, 'session-retirement-throw', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  host.planMaintenanceThrow(seeded.historicalId, new Error('candidate commit exploded'))
  host.planMaintenanceThrow(seeded.historicalId, new Error('candidate retirement exploded'))

  await send(client, 'session-retirement-throw', `/session resume ${reference}`)
  await yieldTurn()
  const candidate = host.liveAgents.get(seeded.historicalId)
  assert.ok(candidate !== undefined)
  assert.match(client.sent.at(-1)?.text ?? '', /仍有执行或待处理消息|会话恢复失败/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(candidate.disposed, false)
  const attempts = candidate.maintenanceAttempts
  const idleWaits = candidate.whenIdleCalls
  assert.ok(attempts >= 1)
  await delay(20)
  assert.equal(candidate.maintenanceAttempts, attempts)
  assert.equal(candidate.whenIdleCalls, idleWaits)
  assert.ok(attempts <= 2)
  assert.ok(idleWaits <= 2)
  assert.match(host.errors.join(' '), /maintenance failed; retaining its handle/u)
})

test('/session disposes a candidate when the historical Agent cannot be resumed', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-resume-failure')
  await send(client, 'session-resume-failure', '/help')
  await send(client, 'session-resume-failure', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  host.createError = new Error('candidate resume failed')

  await send(client, 'session-resume-failure', `/session resume ${reference}`)

  assert.match(client.sent.at(-1)?.text ?? '', /会话恢复失败/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.liveAgents.has(seeded.historicalId), false)
})

test('/session cancels a pre-publication historical resume during shutdown', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client, bridge } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-resume-cancel')
  await send(client, 'session-resume-cancel', '/help')
  await send(client, 'session-resume-cancel', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const resumeEntered = deferred<void>()
  let observedSignal: AbortSignal | undefined
  host.resumeHandler = async (sessionId, signal) => {
    if (sessionId !== seeded.historicalId) return
    observedSignal = signal
    resumeEntered.resolve()
    if (signal === undefined) await new Promise<never>(() => {})
    if (signal.aborted) throw signal.reason
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })
  }

  const resuming = settleSend(client, 'session-resume-cancel', `/session resume ${reference}`)
  await resumeEntered.promise
  const stopping = bridge.stop()
  await Promise.race([
    stopping,
    delay(500).then(() => { throw new Error('bridge stop did not cancel candidate resume') }),
  ])
  await resuming

  assert.equal(observedSignal?.aborted, true)
  assert.equal(host.liveAgents.has(seeded.historicalId), false)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
})

test('/session rechecks pending work after final target validation', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-final-race')
  await send(client, 'session-final-race', '/help')
  await send(client, 'session-final-race', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const oldAgent = host.liveAgents.get(seeded.currentId)
  assert.ok(oldAgent !== undefined)
  const finalValidationEntered = deferred<void>()
  const releaseFinalValidation = deferred<void>()
  const finalValidationCall = host.sessionQueryListCalls + 3
  host.sessionQueryListHandler = async (call) => {
    if (call !== finalValidationCall) return
    finalValidationEntered.resolve()
    await releaseFinalValidation.promise
  }

  const resuming = send(client, 'session-final-race', `/session resume ${reference}`)
  await finalValidationEntered.promise
  assert.equal(host.liveAgents.has(seeded.historicalId), true)
  oldAgent.followup({ kind: 'external-work' })
  releaseFinalValidation.resolve()
  await resuming

  assert.match(client.sent.at(-1)?.text ?? '', /仍有执行或待处理消息/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.disposals.includes(seeded.historicalId), true)
  assert.equal(host.liveAgents.has(seeded.historicalId), false)
  oldAgent.finishPending()
})

test('/session rolls back when the target is archived during final validation', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-archive-race')
  await send(client, 'session-archive-race', '/help')
  await send(client, 'session-archive-race', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const finalValidationEntered = deferred<void>()
  const releaseFinalValidation = deferred<void>()
  const finalValidationCall = host.sessionQueryListCalls + 3
  host.sessionQueryListHandler = async (call) => {
    if (call !== finalValidationCall) return
    finalValidationEntered.resolve()
    await releaseFinalValidation.promise
  }

  const resuming = send(client, 'session-archive-race', `/session resume ${reference}`)
  await finalValidationEntered.promise
  const targetAgent = host.liveAgents.get(seeded.historicalId)
  assert.ok(targetAgent !== undefined)
  t.after(() => targetAgent.finishPending())
  targetAgent.followup({ kind: 'external-target-work' })
  host.archivedSessionIds.push(seeded.historicalId)
  releaseFinalValidation.resolve()
  await resuming

  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.disposals.includes(seeded.historicalId), false)
  assert.equal(host.liveAgents.has(seeded.historicalId), true)
  targetAgent.finishPending()
  await waitFor(
    () => !host.liveAgents.has(seeded.historicalId),
    'rolled-back target was not retired after admitted work became durable',
  )
  assert.equal(host.persisted.get(seeded.historicalId)?.events.some((event) => (
    (event as { data?: { kind?: string } }).data?.kind === 'external-target-work'
  )), true)
})

test('/session rolls back when the target Workspace is removed after the async status snapshot', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-workspace-race')
  await send(client, 'session-workspace-race', '/help')
  await send(client, 'session-workspace-race', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const finalQueryEntered = deferred<void>()
  const releaseStatus = deferred<void>()
  const finalValidationCall = host.sessionQueryListCalls + 3
  const finalStatusCall = workspaces[0]!.statusCalls.length + 3
  host.sessionQueryListHandler = (call) => {
    if (call !== finalValidationCall) return
    workspaces[0]!.statusWait = releaseStatus.promise
    finalQueryEntered.resolve()
  }

  const resuming = send(client, 'session-workspace-race', `/session resume ${reference}`)
  await finalQueryEntered.promise
  await waitFor(
    () => workspaces[0]!.statusCalls.length === finalStatusCall,
    'final session validation did not enter the deferred Workspace status check',
  )
  const removed = host.workspaces.splice(
    host.workspaces.findIndex((workspace) => workspace.id === workspaces[0]!.id),
    1,
  )
  assert.equal(removed.length, 1)
  releaseStatus.resolve()
  await resuming

  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.disposals.includes(seeded.historicalId), true)
  assert.equal(host.liveAgents.has(seeded.historicalId), false)
})

test('/session closes the async-return authority window before committing a resumed target', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-authority-return-race')
  await send(client, 'session-authority-return-race', '/help')
  await send(client, 'session-authority-return-race', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const finalValidationCall = host.sessionQueryListCalls + 3
  let finalAuthorityReads = 0
  let archiveScheduled = false
  host.archivedSessionIdsReadHandler = () => {
    if (host.sessionQueryListCalls !== finalValidationCall) return
    finalAuthorityReads += 1
    if (finalAuthorityReads !== 2 || archiveScheduled) return
    archiveScheduled = true
    queueMicrotask(() => { host.archivedSessionIds.push(seeded.historicalId) })
  }

  await send(client, 'session-authority-return-race', `/session resume ${reference}`)

  assert.equal(archiveScheduled, true)
  assert.equal(finalAuthorityReads >= 3, true)
  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.disposals.includes(seeded.historicalId), true)
  assert.equal(host.liveAgents.has(seeded.historicalId), false)
})

test('/session rechecks exact Workspace availability after the async candidate returns', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-directory-return-race')
  await send(client, 'session-directory-return-race', '/help')
  await send(client, 'session-directory-return-race', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const finalValidationCall = host.sessionQueryListCalls + 3
  let finalAuthorityReads = 0
  let directoryMoved = false
  const movedPath = `${workspaces[0]!.path}-removed`
  host.archivedSessionIdsReadHandler = () => {
    if (host.sessionQueryListCalls !== finalValidationCall) return
    finalAuthorityReads += 1
    if (finalAuthorityReads !== 2 || directoryMoved) return
    directoryMoved = true
    queueMicrotask(() => { renameSync(workspaces[0]!.path, movedPath) })
  }

  await send(client, 'session-directory-return-race', `/session resume ${reference}`)

  assert.equal(directoryMoved, true)
  assert.equal(finalAuthorityReads >= 3, true)
  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
  assert.equal(host.disposals.includes(seeded.historicalId), true)
})

test('/session commits a target binding confirmed by read-back after a published write error', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-binding-confirmation')
  await send(client, 'session-binding-confirmation', '/help')
  await send(client, 'session-binding-confirmation', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  host.planBindingPut({})
  host.planBindingPut({
    error: new Error('published receipt was lost'),
    published: true,
    visible: true,
  })
  const bindingCount = host.bindingPuts.length

  await send(client, 'session-binding-confirmation', `/session resume ${reference}`)

  assert.match(client.sent.at(-1)?.text ?? '', /已恢复所选会话/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 0)
  assert.equal(host.bindingPuts.length, bindingCount + 2)
  assert.equal(host.disposals.includes(seeded.historicalId), false)
})

test('/session hides a non-current live Handle retained by commit-forward work', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-owned-live')
  await send(client, 'session-owned-live', '/help')
  await send(client, 'session-owned-live', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const references = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)].map(([value]) => value)
  const previousCurrentReference = references.find((value) => currentLine?.includes(value) === true)
  const oldReference = references.find((value) => currentLine?.includes(value) !== true)
  assert.ok(previousCurrentReference !== undefined)
  assert.ok(oldReference !== undefined)
  const oldAgent = host.liveAgents.get(seeded.currentId)
  assert.ok(oldAgent !== undefined)
  t.after(() => oldAgent.finishPending())
  const targetBinding = deferred<void>()
  host.planBindingPut({})
  host.planBindingPut({ wait: targetBinding.promise })
  const bindingCount = host.bindingPuts.length

  const resuming = send(client, 'session-owned-live', `/session resume ${oldReference}`)
  await waitFor(
    () => host.bindingPuts.length === bindingCount + 2,
    'session resume did not reach its final binding commit',
  )
  const targetAgent = host.liveAgents.get(seeded.historicalId)
  assert.ok(targetAgent !== undefined)
  t.after(() => targetAgent.finishPending())
  oldAgent.followup({ kind: 'accepted-during-commit' })
  targetAgent.followup({ kind: 'target-work-during-commit' })
  targetBinding.resolve()
  await resuming
  assert.match(client.sent.at(-1)?.text ?? '', /已恢复所选会话/u)
  assert.equal(host.liveAgents.has(seeded.currentId), true)
  assert.equal(host.disposals.includes(seeded.historicalId), false)

  await send(client, 'session-owned-live', '/session')
  const after = client.sent.at(-1)?.text ?? ''
  assert.equal(([...after.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 1)
  assert.equal(after.includes(oldReference), true)
  assert.equal(after.includes(previousCurrentReference), false)
  await send(client, 'session-owned-live', `/session resume ${previousCurrentReference}`)
  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)

  oldAgent.finishPending()
  targetAgent.finishPending()
  await waitFor(
    () => !host.liveAgents.has(seeded.currentId),
    'retained old session was not retired after pending work settled',
  )
})

test('/session keeps a stale current generation visible within the bounded catalog', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const baseId = 'lark:session-current-cap'
  host.seedPersisted(baseId, {
    cwd: workspaces[0]!.path,
    createdAt: 1,
    title: 'Old current session',
  })
  const ids = [baseId]
  for (let generation = 1; generation <= 201; generation += 1) {
    const id = `${baseId}:${generation}-${String(generation).padStart(8, '0')}-0000-4000-8000-000000000001`
    ids.push(id)
    host.seedPersisted(id, {
      cwd: workspaces[0]!.path,
      createdAt: 1_000 + generation,
      title: `Newer session ${generation}`,
    })
  }
  workspaces[0]!.sessionIds.push(...ids)
  host.bindings.set(baseId, {
    generation: 0,
    suffix: null,
    modelSelection: null,
    mutationHashes: [],
  })

  await send(client, 'session-current-cap', '/session')

  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLines = catalog.split('\n').filter((line) => line.includes('[当前]'))
  assert.equal(currentLines.length, 1)
  assert.match(currentLines[0] ?? '', /Old current session/u)
  assert.match(catalog, /可恢复会话 1\/20/u)
  assert.match(catalog, /还有更多会话未显示/u)
  assert.equal(([...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 10)
})

test('/session fails historical authority closed when the Workspace index exceeds its scan bound', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-index-cap')
  await send(client, 'session-index-cap', '/session')
  const initial = client.sent.at(-1)?.text ?? ''
  const currentLine = initial.split('\n').find((line) => line.includes('[当前]'))
  const historicalReference = [...initial.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(historicalReference !== undefined)

  for (let generation = 2; generation < 1_000; generation += 1) {
    const id = `${seeded.baseId}:${generation}-${generation.toString(16).padStart(8, '0')}-0000-4000-8000-000000000001`
    host.seedPersisted(id, {
      cwd: workspaces[0]!.path,
      createdAt: 2_000 + generation,
      title: `Indexed session ${generation}`,
    })
    workspaces[0]!.sessionIds.push(id)
  }
  assert.equal(workspaces[0]!.sessionIds.length, 1_000)
  const beyondId = `${seeded.baseId}:1000-000003e8-0000-4000-8000-000000000001`
  host.seedPersisted(beyondId, {
    cwd: workspaces[1]!.path,
    createdAt: 10_000,
    title: 'Beyond index bound',
  })
  workspaces[1]!.sessionIds.push(seeded.historicalId, beyondId)

  await send(client, 'session-index-cap', '/session')
  const bounded = client.sent.at(-1)?.text ?? ''
  assert.equal(([...bounded.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 1)
  assert.match(bounded, /还有更多会话未显示/u)
  await send(client, 'session-index-cap', `/session resume ${historicalReference}`)

  assert.match(client.sent.at(-1)?.text ?? '', /没有该可恢复会话引用/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 1)
})

test('/session ignores an oversized missing Workspace when authorizing available history', async (t) => {
  const available = await navigableWorkspaces(t)
  const missing = new TestWorkspace(
    WORKSPACE_IDS.missing,
    'Missing oversized Workspace',
    `${available[0]!.path}-missing`,
    Array.from({ length: 16 }, () => 'missing-dir' as const),
  )
  for (let index = 0; index <= 1_000; index += 1) {
    missing.sessionIds.push(`missing-session-${index}`)
  }
  const { host, client } = mount(t, [missing, ...available])
  const seeded = seedSessionNavigation(host, available[0]!, 'session-missing-index')

  await send(client, 'session-missing-index', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  assert.equal(([...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 2)
  await send(client, 'session-missing-index', `/session resume ${reference}`)

  assert.match(client.sent.at(-1)?.text ?? '', /已恢复所选会话/u)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 0)
})

test('/session displays valid out-of-date-range timestamps safely and rejects changed title sources', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-title-source')
  const historical = host.persisted.get(seeded.historicalId)
  assert.ok(historical !== undefined)
  ;(historical.header as { createdAt: number }).createdAt = Number.MAX_SAFE_INTEGER

  await send(client, 'session-title-source', '/session')
  assert.match(client.sent.at(-1)?.text ?? '', /创建：时间未知/u)
  assert.doesNotMatch(client.sent.at(-1)?.text ?? '', /会话导航暂不可用/u)

  host.sessionTitleHeaderOverride = { agentPreset: 'changed-preset' }
  await send(client, 'session-title-source', '/session')
  assert.match(client.sent.at(-1)?.text ?? '', /会话导航暂不可用/u)
})

test('/session rejects a future Session format before it can poison the generation high-water mark', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-format-version')
  const poisonId = `${seeded.baseId}:${Number.MAX_SAFE_INTEGER}-ffffffff-ffff-4fff-8fff-ffffffffffff`
  const poison = host.seedPersisted(poisonId, {
    cwd: workspaces[0]!.path,
    createdAt: 3_000,
  })
  ;(poison.header as { version: number }).version = 1
  host.persisted.delete(poisonId)
  host.liveSessions.set(poisonId, poison)

  await send(client, 'session-format-version', '/session')
  assert.match(client.sent.at(-1)?.text ?? '', /会话导航暂不可用/u)
  host.liveSessions.delete(poisonId)
  t.mock.method(Date, 'now', () => 0)
  await send(client, 'session-format-version', '/new')

  assert.match(client.sent.at(-1)?.text ?? '', /已开始新会话/u)
  const generation = Number(/^.+:(\d+)-/u.exec(host.latestCreate().sessionId)?.[1])
  assert.equal(generation, 2)
})

test('/session resumes a Workspace-indexed history whose cwd uses a canonical alias', async (t) => {
  const project = await temporaryProject(t)
  const alias = join(project.root, 'project-alias')
  await symlink(project.path, alias, 'dir')
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Aliased Repo', project.path)
  const { host, client } = mount(t, [workspace], { cwd: project.path })
  const baseId = 'lark:session-cwd-alias'
  const historicalId = baseId
  const currentId = `${baseId}:1-00000000-0000-4000-8000-000000000001`
  host.seedPersisted(historicalId, { cwd: alias, createdAt: 1_000, title: 'Aliased history' })
  host.seedPersisted(currentId, { cwd: project.path, createdAt: 2_000, title: 'Current history' })
  workspace.sessionIds.push(currentId, historicalId)
  host.bindings.set(baseId, {
    generation: 1,
    suffix: '1-00000000-0000-4000-8000-000000000001',
    modelSelection: null,
    mutationHashes: [],
  })

  await send(client, 'session-cwd-alias', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  await send(client, 'session-cwd-alias', `/session resume ${reference}`)

  assert.match(client.sent.at(-1)?.text ?? '', /已恢复所选会话/u)
  assert.equal(host.bindings.get(baseId)?.generation, 0)
})

test('/session paginates a bounded catalog and never accepts a raw session id', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client } = mount(t, workspaces)
  const baseId = 'lark:session-pages'
  const ids: string[] = []
  for (let generation = 0; generation < 13; generation += 1) {
    const id = generation === 0
      ? baseId
      : `${baseId}:${generation}-${String(generation).padStart(8, '0')}-0000-4000-8000-000000000001`
    ids.push(id)
    host.seedPersisted(id, {
      cwd: workspaces[0]!.path,
      createdAt: 1_000 + generation,
      title: `Session ${generation}`,
    })
  }
  workspaces[0]!.sessionIds.push(...[...ids].reverse())
  host.bindings.set(baseId, {
    generation: 12,
    suffix: '12-00000012-0000-4000-8000-000000000001',
    modelSelection: null,
    mutationHashes: [],
  })

  await send(client, 'session-pages', '/session')
  assert.equal(([...(client.sent.at(-1)?.text ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 10)
  await send(client, 'session-pages', '/session list 2')
  assert.equal(([...(client.sent.at(-1)?.text ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 3)
  await send(client, 'session-pages', '/session list 0')
  assert.match(client.sent.at(-1)?.text ?? '', /用法：\/session/u)
  await send(client, 'session-pages', `/session resume ${ids[0]}`)
  assert.match(client.sent.at(-1)?.text ?? '', /用法：\/session/u)
  assert.equal(host.bindings.get(baseId)?.generation, 12)
})

test('/session degrades without Session Query and does not create an Agent', async (t) => {
  const { host, client } = mount(t, standardWorkspaces(), { sessionQueryAvailable: false })

  await send(client, 'session-query-missing', '/session')

  assert.match(client.sent.at(-1)?.text ?? '', /会话导航暂不可用/u)
  assert.equal(host.creates.length, 0)
})

test('/session references are isolated by application namespace', async (t) => {
  const firstWorkspaces = await navigableWorkspaces(t)
  const secondWorkspaces = await navigableWorkspaces(t)
  const first = mount(t, firstWorkspaces, { sessionReferenceNamespace: 'app-a' })
  const second = mount(t, secondWorkspaces, { sessionReferenceNamespace: 'app-b' })
  seedSessionNavigation(first.host, firstWorkspaces[0]!, 'session-app-scope')
  seedSessionNavigation(second.host, secondWorkspaces[0]!, 'session-app-scope')

  await send(first.client, 'session-app-scope', '/session')
  await send(second.client, 'session-app-scope', '/session')
  const firstReferences = [...(first.client.sent.at(-1)?.text ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([reference]) => reference)
  const secondReferences = new Set(
    [...(second.client.sent.at(-1)?.text ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
      .map(([reference]) => reference),
  )

  assert.equal(firstReferences.length, 2)
  assert.equal(firstReferences.some((reference) => secondReferences.has(reference)), false)
})

test('/session resume replay cannot roll back a later reset', async (t) => {
  const workspaces = await navigableWorkspaces(t)
  const { host, client, bridge } = mount(t, workspaces)
  const seeded = seedSessionNavigation(host, workspaces[0]!, 'session-replay')

  await send(client, 'session-replay', '/session')
  const catalog = client.sent.at(-1)?.text ?? ''
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  const reference = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)]
    .map(([value]) => value)
    .find((value) => currentLine?.includes(value) !== true)
  assert.ok(reference !== undefined)
  const replay = { messageId: 'session-resume-replay' }
  await send(client, 'session-replay', `/session resume ${reference}`, replay)
  assert.equal(host.bindings.get(seeded.baseId)?.generation, 0)

  await send(client, 'session-replay', '/new')
  const later = host.bindings.get(seeded.baseId)
  assert.ok(later !== undefined && later.generation > 1)
  await bridge.stop()
  const hotReloaded = new LarkBridge(host.ctx as never, {
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
    projectManageFrom: ['owner'],
    cwd: '/srv/default-repo',
    sessionReferenceNamespace: 'test-app',
  })
  await hotReloaded.start()
  t.after(() => hotReloaded.stop())
  await send(client, 'session-replay', `/session resume ${reference}`, replay)

  assert.deepEqual(host.bindings.get(seeded.baseId), later)
  assert.match(client.sent.at(-1)?.text ?? '', /已处理/u)
  assert.equal(host.resumes.filter((id) => id === seeded.historicalId).length, 1)
})

test('session generation exhaustion fails closed without replacing the current binding', async (t) => {
  const workspaces = standardWorkspaces()
  const { host, client } = mount(t, workspaces)
  const baseId = 'lark:session-generation-limit'
  const suffix = '9007199254740991-00000000-0000-4000-8000-000000000001'
  const sessionId = `${baseId}:${suffix}`
  host.seedPersisted(sessionId, {
    cwd: workspaces[0]!.path,
    createdAt: 1_000,
  })
  workspaces[0]!.sessionIds.push(sessionId)
  const binding: ConversationBinding = {
    generation: Number.MAX_SAFE_INTEGER,
    suffix,
    modelSelection: null,
    mutationHashes: [],
  }
  host.bindings.set(baseId, binding)

  await send(client, 'session-generation-limit', '/new')

  assert.match(client.sent.at(-1)?.text ?? '', /无法安全开始新会话/u)
  assert.equal(host.bindings.get(baseId)?.generation, binding.generation)
  assert.equal(host.bindings.get(baseId)?.suffix, binding.suffix)
  assert.deepEqual(host.bindings.get(baseId)?.mutationHashes, [])
  assert.equal(host.creates.filter(({ sessionId: id }) => id !== sessionId).length, 0)
})

async function temporaryProject(
  t: { after(callback: () => void | Promise<void>): void },
): Promise<{ readonly root: string; readonly path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-project-'))
  const path = join(root, 'project')
  await mkdir(path)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, path: await realpath(path) }
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

test('an empty project list is actionable only for an authorized direct-chat project manager', async (t) => {
  const project = await temporaryProject(t)
  const manager = mount(t, [], { cwd: project.path, projectManageFrom: ['owner'] })
  await send(manager.client, 'chat-manager', '/project')
  assert.match(manager.client.sent.at(-1)?.text ?? '', /\/project register <名称>/)

  const ordinary = mount(t, [], { cwd: project.path, projectManageFrom: [] })
  await send(ordinary.client, 'chat-ordinary', '/project')
  assert.doesNotMatch(ordinary.client.sent.at(-1)?.text ?? '', /\/project register/)
  await send(ordinary.client, 'chat-ordinary', '/project register Ordinary')
  assert.match(ordinary.client.sent.at(-1)?.text ?? '', /没有项目注册管理权限/)
  assert.deepEqual(ordinary.host.workspaceCreateCalls, [])

  const publicBot = mount(t, [], {
    cwd: project.path,
    allowFrom: [],
    allowAllUsers: true,
    projectManageFrom: [],
  })
  await send(publicBot.client, 'chat-public', '/project register Public', { openId: 'visitor' })
  assert.match(publicBot.client.sent.at(-1)?.text ?? '', /没有项目注册管理权限/)
  assert.deepEqual(publicBot.host.workspaceCreateCalls, [])

  const group = mount(t, [], { cwd: project.path, projectManageFrom: ['owner'] })
  await send(group.client, 'group-chat', '/project register Group', {
    chatType: 'group',
    mentioned: true,
    rootId: 'root-message',
  })
  assert.match(group.client.sent.at(-1)?.text ?? '', /只能在.*私聊/)
  assert.deepEqual(group.host.workspaceCreateCalls, [])
  await send(group.client, 'group-chat', `/project remove ${WORKSPACE_IDS.alpha}`, {
    chatType: 'group',
    mentioned: false,
    rootId: 'another-root',
  })
  assert.match(group.client.sent.at(-1)?.text ?? '', /只能在.*私聊/)
  assert.deepEqual(group.host.workspaceDeleteCalls, [])

  const managerWithoutBotAccess = mount(t, [], {
    cwd: project.path,
    allowFrom: ['different-user'],
    projectManageFrom: ['owner'],
  })
  await send(managerWithoutBotAccess.client, 'chat-manager-only', '/project register Denied')
  assert.match(managerWithoutBotAccess.client.sent.at(-1)?.text ?? '', /没有权限/)
  assert.deepEqual(managerWithoutBotAccess.host.workspaceCreateCalls, [])

  const noPersistence = mount(t, [], {
    cwd: project.path,
    sessionPersistenceAvailable: false,
  })
  await send(noPersistence.client, 'chat-no-persistence', '/project')
  assert.doesNotMatch(noPersistence.client.sent.at(-1)?.text ?? '', /\/project register/)

  const missingDirectory = mount(t, [], { cwd: join(project.root, 'missing') })
  await send(missingDirectory.client, 'chat-missing-cwd', '/project')
  assert.doesNotMatch(missingDirectory.client.sent.at(-1)?.text ?? '', /\/project register/)
})

test('project registration validates titles and registers only the active Session cwd without resetting it', async (t) => {
  const project = await temporaryProject(t)
  const { host, client } = mount(t, [], { cwd: project.path })
  await send(client, 'chat-register', '/project')
  const active = host.latestCreate()
  const invalidTitles = [
    '',
    '/private/other',
    '\\server\\share',
    'C:\\private\\other',
    'C:private\\other',
    'file:///private/other',
    '~/private',
    '../private',
    'bad\nname',
    'bad\u202Ename',
    '<at user_id="all">everyone</at>',
    '\uD800',
    'x'.repeat(121),
  ]
  for (const title of invalidTitles) {
    await send(client, 'chat-register', `/project register ${title}`)
    assert.match(client.sent.at(-1)?.text ?? '', /用法：\/project register/)
  }
  assert.deepEqual(host.workspaceCreateCalls, [])

  await send(client, 'chat-register', '/project register   Team   Workspace  ')
  assert.deepEqual(host.workspaceCreateCalls, [{ path: project.path, title: 'Team Workspace' }])
  assert.equal(host.creates.length, 1, 'registration reset the active Session')
  assert.equal(host.latestCreate(), active)
  assert.deepEqual(host.disposals, [])
  assert.deepEqual(host.workspaces[0]?.attachCalls, [])
  assert.equal(client.sent.at(-1)?.text.includes(project.path), false)
  assert.match(client.sent.at(-1)?.text ?? '', /已注册当前项目/)

  const unicodeBoundary = mount(t, [], { cwd: project.path })
  const maxTitle = '😀'.repeat(120)
  await send(unicodeBoundary.client, 'chat-unicode-title', `/project register\t${maxTitle}`)
  assert.equal(unicodeBoundary.host.workspaceCreateCalls[0]?.title, maxTitle)
  await send(
    unicodeBoundary.client,
    'chat-unicode-title',
    `/project register ${'😀'.repeat(121)}`,
  )
  assert.equal(unicodeBoundary.host.workspaceCreateCalls.length, 1)
  assert.match(unicodeBoundary.client.sent.at(-1)?.text ?? '', /用法：\/project register/)
})

test('project registration rejects relative, missing, and non-directory Session cwd values', async (t) => {
  const project = await temporaryProject(t)
  const file = join(project.root, 'not-a-directory')
  await writeFile(file, 'preserve me')
  const candidates = [
    { label: 'relative', cwd: 'relative/project' },
    { label: 'missing', cwd: join(project.root, 'missing') },
    { label: 'file', cwd: file },
  ]
  for (const candidate of candidates) {
    const mounted = mount(t, [], { cwd: candidate.cwd })
    await send(mounted.client, `chat-${candidate.label}`, '/project register Valid Title')
    assert.deepEqual(mounted.host.workspaceCreateCalls, [], candidate.label)
    assert.match(mounted.client.sent.at(-1)?.text ?? '', /暂不可用/)
  }
})

test('a read-only custom Workspace registry keeps project selection but rejects registration management', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Read Only', project.path)
  const { host, client } = mount(t, [workspace], {
    cwd: project.path,
    workspaceRegistryMutable: false,
  })

  await send(client, 'chat-read-only', '/project Read Only')
  assert.match(client.sent.at(-1)?.text ?? '', /当前已是|已是项目/)
  await send(client, 'chat-read-only', '/project register New Name')
  assert.match(client.sent.at(-1)?.text ?? '', /注册管理暂不可用/)
  await send(client, 'chat-read-only', `/project remove ${workspace.id}`)
  assert.match(client.sent.at(-1)?.text ?? '', /注册管理暂不可用/)
  assert.equal(host.workspaces[0], workspace)
  assert.deepEqual(host.workspaceCreateCalls, [])
  assert.deepEqual(host.workspaceDeleteCalls, [])
})

test('registering an existing canonical path is idempotent and never renames it', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Original Name', project.path)
  const nonCanonical = `${project.path}${sep}..${sep}project`
  assert.notEqual(nonCanonical, project.path)
  assert.equal(await realpath(nonCanonical), project.path)
  const { host, client } = mount(t, [workspace], { cwd: nonCanonical })

  await send(client, 'chat-existing', '/project register Replacement Name')

  assert.deepEqual(host.workspaceCreateCalls, [])
  assert.equal(workspace.title, 'Original Name')
  assert.equal(host.creates.length, 1)
  assert.deepEqual(workspace.attachCalls, [])
  assert.match(client.sent.at(-1)?.text ?? '', /已注册为项目.*未修改原名称/)
  assert.equal(client.sent.at(-1)?.text.includes(project.path), false)
})

test('a failed project-registry precommit performs no host registry mutation', async (t) => {
  const project = await temporaryProject(t)
  const registration = mount(t, [], { cwd: project.path })
  registration.host.planFlush({ result: false })
  await send(registration.client, 'chat-register-precommit', '/project register Durable')
  assert.deepEqual(registration.host.workspaceCreateCalls, [])
  assert.deepEqual(registration.host.bindingPuts, [])
  assert.match(registration.client.sent.at(-1)?.text ?? '', /暂不可用/)

  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Durable', project.path)
  const removal = mount(t, [workspace], { cwd: project.path })
  removal.host.planFlush({ result: false })
  await send(removal.client, 'chat-remove-precommit', `/project remove ${workspace.id}`)
  assert.deepEqual(removal.host.workspaceDeleteCalls, [])
  assert.equal(removal.host.workspaces[0], workspace)
  assert.match(removal.client.sent.at(-1)?.text ?? '', /暂不可用/)
})

test('exact-id removal handles duplicate titles and leaves the active Session and files intact', async (t) => {
  const project = await temporaryProject(t)
  const otherPath = join(project.root, 'other')
  await mkdir(otherPath)
  const marker = join(project.path, 'marker.txt')
  await writeFile(marker, 'workspace data survives')
  const { host, client } = mount(t, [], { cwd: project.path })

  await send(client, 'chat-remove', 'keep this transcript')
  const active = host.latestCreate()
  await send(client, 'chat-remove', '/project register Duplicate Title')
  const registered = host.workspaces[0]
  assert.ok(registered !== undefined)
  const bindingBeforeRemoval = host.bindings.get('lark:chat-remove')
  assert.ok(bindingBeforeRemoval !== undefined)
  const eventsBeforeRemoval = [...active.agent.session.events]
  const duplicate = new TestWorkspace(
    WORKSPACE_IDS.duplicateTwo,
    'Duplicate Title',
    await realpath(otherPath),
  )
  host.workspaces.push(duplicate)

  await send(client, 'chat-remove', '/project Duplicate Title')
  assert.match(client.sent.at(-1)?.text ?? '', /多个项目/)
  assert.equal(host.creates.length, 1)

  await send(client, 'chat-remove', `/project remove\t${registered.id}`)
  assert.deepEqual(host.workspaceDeleteCalls, [registered.id])
  assert.deepEqual(host.workspaces, [duplicate])
  assert.equal(host.creates.length, 1)
  assert.equal(host.latestCreate(), active)
  assert.equal(active.agent.disposed, false)
  assert.deepEqual(host.disposals, [])
  assert.equal(active.cwd, project.path)
  assert.deepEqual(active.agent.session.events, eventsBeforeRemoval)
  assert.equal(await readFile(marker, 'utf8'), 'workspace data survives')
  assert.equal(host.persisted.get(active.sessionId), active.agent.session)
  assert.deepEqual(registered.attachCalls, [])
  const bindingAfterRemoval = host.bindings.get('lark:chat-remove')
  assert.ok(bindingAfterRemoval !== undefined)
  assert.equal(bindingAfterRemoval.generation, bindingBeforeRemoval.generation)
  assert.equal(bindingAfterRemoval.suffix, bindingBeforeRemoval.suffix)
  assert.deepEqual(bindingAfterRemoval.modelSelection, bindingBeforeRemoval.modelSelection)
  assert.equal(bindingAfterRemoval.mutationHashes.length, bindingBeforeRemoval.mutationHashes.length + 1)
  assert.match(client.sent.at(-1)?.text ?? '', /已移除项目注册.*目录、文件、会话和历史记录均未删除/)

  await send(client, 'chat-remove', `/project ${duplicate.id}`)
  assert.equal(host.latestCreate().cwd, duplicate.path)
})

test('an old registration delivery replay cannot recreate a project removed by a later message', async (t) => {
  const project = await temporaryProject(t)
  const first = mount(t, [], { cwd: project.path })
  assert.ok(first.client.handler !== undefined)
  const registration = inbound('chat-registry-replay', '/project register Replay Safe', {
    messageId: 'registry-add-message',
  })
  await first.client.handler(registration)
  const workspace = first.host.workspaces[0]
  assert.ok(workspace !== undefined)
  const removal = inbound('chat-registry-replay', `/project remove ${workspace.id}`, {
    messageId: 'registry-remove-message',
  })
  await first.client.handler(removal)
  assert.deepEqual(first.host.workspaces, [])
  const binding = first.host.bindings.get('lark:chat-registry-replay')
  const persisted = first.host.persisted.get('lark:chat-registry-replay')
  assert.ok(binding !== undefined)
  assert.ok(persisted !== undefined)

  const restarted = mount(t, [], { cwd: project.path })
  restarted.host.bindings.set('lark:chat-registry-replay', binding)
  restarted.host.persisted.set('lark:chat-registry-replay', persisted)
  assert.ok(restarted.client.handler !== undefined)
  await restarted.client.handler(registration)

  assert.deepEqual(restarted.host.workspaceCreateCalls, [])
  assert.deepEqual(restarted.host.workspaces, [])
  assert.match(restarted.client.sent.at(-1)?.text ?? '', /已处理.*查看当前列表/)

  const replacement = new TestWorkspace(workspace.id, 'Replacement', project.path)
  const replayRemoval = mount(t, [replacement], { cwd: project.path })
  replayRemoval.host.bindings.set('lark:chat-registry-replay', binding)
  replayRemoval.host.persisted.set('lark:chat-registry-replay', persisted)
  assert.ok(replayRemoval.client.handler !== undefined)
  await replayRemoval.client.handler(removal)
  assert.deepEqual(replayRemoval.host.workspaceDeleteCalls, [])
  assert.deepEqual(replayRemoval.host.workspaces, [replacement])
  assert.match(replayRemoval.client.sent.at(-1)?.text ?? '', /已处理.*查看当前列表/)
})

test('pre-validation register and remove outcomes cannot gain a later side effect on replay', async (t) => {
  const project = await temporaryProject(t)
  const missingCwd = join(project.root, 'not-created')
  const firstRegister = mount(t, [], { cwd: missingCwd })
  assert.ok(firstRegister.client.handler !== undefined)
  const registerMessage = inbound(
    'chat-prevalidation-register',
    '/project register Deferred Path',
    { messageId: 'prevalidation-register-message' },
  )
  await firstRegister.client.handler(registerMessage)
  assert.deepEqual(firstRegister.host.workspaceCreateCalls, [])
  const registerBinding = firstRegister.host.bindings.get('lark:chat-prevalidation-register')
  const registerSession = firstRegister.host.persisted.get('lark:chat-prevalidation-register')
  assert.ok(registerBinding !== undefined)
  assert.ok(registerSession !== undefined)
  assert.equal(registerBinding.mutationHashes.length, 1)

  const replayRegister = mount(t, [], { cwd: project.path })
  replayRegister.host.bindings.set('lark:chat-prevalidation-register', registerBinding)
  replayRegister.host.persisted.set('lark:chat-prevalidation-register', registerSession)
  assert.ok(replayRegister.client.handler !== undefined)
  await replayRegister.client.handler(registerMessage)
  assert.deepEqual(replayRegister.host.workspaceCreateCalls, [])
  assert.match(replayRegister.client.sent.at(-1)?.text ?? '', /已处理.*查看当前列表/)

  const futureWorkspace = new TestWorkspace(
    WORKSPACE_IDS.alpha,
    'Future Registration',
    project.path,
  )
  const firstRemove = mount(t, [], { cwd: project.path })
  assert.ok(firstRemove.client.handler !== undefined)
  const removeMessage = inbound(
    'chat-prevalidation-remove',
    `/project remove ${futureWorkspace.id}`,
    { messageId: 'prevalidation-remove-message' },
  )
  await firstRemove.client.handler(removeMessage)
  assert.deepEqual(firstRemove.host.workspaceDeleteCalls, [])
  const removeBinding = firstRemove.host.bindings.get('lark:chat-prevalidation-remove')
  const removeSession = firstRemove.host.persisted.get('lark:chat-prevalidation-remove')
  assert.ok(removeBinding !== undefined)
  assert.ok(removeSession !== undefined)
  assert.equal(removeBinding.mutationHashes.length, 1)

  const replayRemove = mount(t, [futureWorkspace], { cwd: project.path })
  replayRemove.host.bindings.set('lark:chat-prevalidation-remove', removeBinding)
  replayRemove.host.persisted.set('lark:chat-prevalidation-remove', removeSession)
  assert.ok(replayRemove.client.handler !== undefined)
  await replayRemove.client.handler(removeMessage)
  assert.deepEqual(replayRemove.host.workspaceDeleteCalls, [])
  assert.deepEqual(replayRemove.host.workspaces, [futureWorkspace])
  assert.match(replayRemove.client.sent.at(-1)?.text ?? '', /已处理.*查看当前列表/)
})

test('the documented at-most-once boundary suppresses replay after an unconfirmed create acknowledgement', async (t) => {
  const project = await temporaryProject(t)
  const failed = mount(t, [], { cwd: project.path })
  failed.host.workspaceCreateHandler = async () => {
    throw new Error(`host rejected ${project.path}`)
  }
  assert.ok(failed.client.handler !== undefined)
  const message = inbound('chat-at-most-once', '/project register One Attempt', {
    messageId: 'registry-definite-failure',
  })
  await failed.client.handler(message)
  assert.equal(failed.host.workspaceCreateCalls.length, 1)
  assert.deepEqual(failed.host.workspaces, [])
  assert.equal(
    failed.host.errors.flat().some((value) => String(value).includes(project.path)),
    false,
    'a private cwd leaked through a host registry error',
  )
  const binding = failed.host.bindings.get('lark:chat-at-most-once')
  const persisted = failed.host.persisted.get('lark:chat-at-most-once')
  assert.ok(binding !== undefined)
  assert.ok(persisted !== undefined)

  const restarted = mount(t, [], { cwd: project.path })
  restarted.host.bindings.set('lark:chat-at-most-once', binding)
  restarted.host.persisted.set('lark:chat-at-most-once', persisted)
  assert.ok(restarted.client.handler !== undefined)
  await restarted.client.handler(message)
  assert.deepEqual(restarted.host.workspaceCreateCalls, [])
  assert.deepEqual(restarted.host.workspaces, [])
  assert.match(restarted.client.sent.at(-1)?.text ?? '', /已处理.*查看当前列表/)
})

test('registration rechecks a symlink cwd after precommit and performs no stale-path create', async (t) => {
  const project = await temporaryProject(t)
  const other = join(project.root, 'other-target')
  const link = join(project.root, 'current-project')
  await mkdir(other)
  await symlink(project.path, link, 'dir')
  const { host, client } = mount(t, [], { cwd: link })
  const bindingWrite = deferred<void>()
  host.planBindingPut({ wait: bindingWrite.promise })

  const registering = send(client, 'chat-symlink-precommit', '/project register Stable Link')
  try {
    await waitFor(() => host.bindingPuts.length === 1, 'registration precommit did not start')
    await rm(link)
    await symlink(other, link, 'dir')
  } finally {
    bindingWrite.resolve()
    await registering
  }

  assert.deepEqual(host.workspaceCreateCalls, [])
  assert.deepEqual(host.workspaces, [])
  assert.match(client.sent.at(-1)?.text ?? '', /注册管理暂不可用/)
})

test('a symlink cwd changed during create fails closed and requires a Workspace remount', async (t) => {
  const project = await temporaryProject(t)
  const other = join(project.root, 'other-target')
  const link = join(project.root, 'current-project')
  await mkdir(other)
  await symlink(project.path, link, 'dir')
  const { host, client, bridge } = mount(t, [], { cwd: link })
  host.workspaceCreateHandler = async (path, title) => {
    await rm(link)
    await symlink(other, link, 'dir')
    const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, title, path)
    host.workspaces.push(workspace)
    return workspace
  }

  await send(client, 'chat-symlink-create', '/project register Moving Link')
  assert.equal(host.workspaceCreateCalls.length, 1)
  assert.equal(host.workspaces[0]?.path, project.path)
  assert.match(client.sent.at(-1)?.text ?? '', /注册失败.*重启服务/)
  assert.equal(
    host.errors.flat().some((value) => String(value).includes(project.path)),
    false,
  )
  await bridge.stop()
  await assert.rejects(
    bridge.start(),
    /requires a full storage remount after an interrupted workspace mutation/,
  )
  const hotReloaded = new LarkBridge(host.ctx as never, {
    client: createClient(),
    conversationBindings: {
      read: (baseId) => host.bindings.get(baseId),
      put: (baseId, binding) => host.putBinding(baseId, binding),
      async close() {},
    },
    allowFrom: ['owner'],
    projectManageFrom: ['owner'],
  })
  await assert.rejects(
    hotReloaded.start(),
    /requires a full storage remount after an interrupted workspace mutation/,
  )
})

test('Workspace recovery fail-stop clears unrelated pending attachments and blocks every later mutation', async (t) => {
  const project = await temporaryProject(t)
  const other = join(project.root, 'other')
  await mkdir(other)
  const alpha = new TestWorkspace(WORKSPACE_IDS.alpha, 'Alpha', project.path)
  const beta = new TestWorkspace(WORKSPACE_IDS.beta, 'Beta', await realpath(other))
  const { host, client, bridge } = mount(t, [alpha, beta])
  await send(client, 'chat-recovery-alpha', '/project Alpha')
  const alphaSession = host.latestCreate()
  host.workspaceDeleteHandler = async () => true

  await send(client, 'chat-recovery-beta', `/project remove ${beta.id}`)
  assert.match(client.sent.at(-1)?.text ?? '', /移除失败.*重启服务/)
  assert.deepEqual(host.workspaces, [alpha, beta])

  await send(client, 'chat-recovery-alpha', 'ordinary work remains available')
  assert.equal(host.followups.at(-1)?.agent, alphaSession.agent)
  host.emitTurnStart(alphaSession.agent)
  await yieldTurn()
  assert.deepEqual(alpha.attachCalls, [], 'recovery mode allowed a pending attachment write')

  const createsBefore = host.creates.length
  await send(client, 'chat-recovery-alpha', `/project ${beta.id}`)
  assert.equal(host.creates.length, createsBefore)
  assert.match(client.sent.at(-1)?.text ?? '', /项目列表暂不可用/)
  await send(client, 'chat-recovery-beta', '/project register Later')
  assert.equal(host.workspaceCreateCalls.length, 0)
  assert.match(client.sent.at(-1)?.text ?? '', /注册管理暂不可用/)

  await bridge.stop()
  await assert.rejects(
    bridge.start(),
    /requires a full storage remount after an interrupted workspace mutation/,
  )
})

test('a delete rejection after an apparent effect remains unconfirmed and leaks no host path', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Unconfirmed Delete', project.path)
  const { host, client, bridge } = mount(t, [workspace], { cwd: project.path })
  host.workspaceDeleteHandler = async (id) => {
    const index = host.workspaces.findIndex((candidate) => candidate.id === id)
    if (index >= 0) host.workspaces.splice(index, 1)
    throw new Error(`delete acknowledgement exposed ${project.path}`)
  }

  await send(client, 'chat-delete-reject', `/project remove ${workspace.id}`)
  assert.deepEqual(host.workspaces, [])
  assert.match(client.sent.at(-1)?.text ?? '', /移除失败.*重启服务/)
  assert.equal(
    host.errors.flat().some((value) => String(value).includes(project.path)),
    false,
  )
  await send(client, 'chat-delete-reject', '/project register Blocked Later')
  assert.deepEqual(host.workspaceCreateCalls, [])
  assert.match(client.sent.at(-1)?.text ?? '', /注册管理暂不可用/)
  await bridge.stop()
  await assert.rejects(
    bridge.start(),
    /requires a full storage remount after an interrupted workspace mutation/,
  )
})

test('the global Workspace barrier orders switch before removal without blocking unrelated followups', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Serialized', project.path)
  const statusGate = deferred<void>()
  workspace.statusWait = statusGate.promise
  const { host, client } = mount(t, [workspace])

  const switching = send(client, 'chat-switch-first', '/project Serialized')
  await waitFor(() => workspace.statusCalls.length === 1, 'project switch did not enter validation')
  const removing = send(client, 'chat-remove-second', `/project remove ${workspace.id}`)
  await send(client, 'chat-unrelated', 'unrelated work stays live')
  assert.equal(host.followups.at(-1)?.agent.session.id, 'lark:chat-unrelated')
  assert.deepEqual(host.workspaceDeleteCalls, [])

  statusGate.resolve()
  await switching
  await removing

  const switched = host.creates.findLast((record) => record.cwd === project.path)
  assert.ok(switched !== undefined)
  assert.equal(switched.agent.disposed, false)
  assert.deepEqual(host.workspaceDeleteCalls, [workspace.id])
  assert.deepEqual(host.workspaces, [])
  assert.ok(
    host.operations.indexOf(`workspace-delete:${workspace.id}`)
      > host.operations.indexOf(`create:${switched.sessionId}:${project.path}`),
  )
  assert.equal(host.bindings.get('lark:chat-switch-first')?.suffix,
    switched.sessionId.slice('lark:chat-switch-first:'.length))
})

test('the global Workspace barrier makes a completed removal win over a later switch', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Remove First', project.path)
  const deleteGate = deferred<void>()
  const { host, client } = mount(t, [workspace])
  host.workspaceDeleteHandler = async (id) => {
    await deleteGate.promise
    const index = host.workspaces.findIndex((candidate) => candidate.id === id)
    if (index < 0) return false
    host.workspaces.splice(index, 1)
    return true
  }

  const removing = send(client, 'chat-remove-first', `/project remove ${workspace.id}`)
  await waitFor(() => host.workspaceDeleteCalls.length === 1, 'project removal did not start')
  const switching = send(client, 'chat-switch-second', '/project Remove First')
  await yieldTurn()
  assert.deepEqual(workspace.statusCalls, [], 'later switch bypassed the removal barrier')
  deleteGate.resolve()
  await removing
  await switching

  assert.deepEqual(host.workspaces, [])
  assert.equal(host.creates.some((record) => record.cwd === project.path), false)
  const switchReply = client.sent.filter(({ chatId }) => chatId === 'chat-switch-second').at(-1)?.text ?? ''
  assert.match(switchReply, /未找到/)
})

test('a stalled project-switch delivery does not retain the global Workspace barrier', async (t) => {
  const project = await temporaryProject(t)
  const other = join(project.root, 'other-delivery')
  await mkdir(other)
  const alpha = new TestWorkspace(WORKSPACE_IDS.alpha, 'Delivery Alpha', project.path)
  const beta = new TestWorkspace(WORKSPACE_IDS.beta, 'Delivery Beta', await realpath(other))
  const { host, client } = mount(t, [alpha, beta])
  const deliveryGate = deferred<void>()
  client.sendTextHandler = async (chatId, text) => {
    if (chatId === 'chat-stalled-delivery' && /已切换到项目/.test(text)) {
      await deliveryGate.promise
    }
  }

  const switching = send(client, 'chat-stalled-delivery', '/project Delivery Alpha')
  await waitFor(() => client.sent.some(({ chatId, text }) => (
    chatId === 'chat-stalled-delivery' && /已切换到项目/.test(text)
  )), 'project switch did not reach delivery')
  await send(client, 'chat-after-delivery', `/project remove ${beta.id}`)

  assert.deepEqual(host.workspaceDeleteCalls, [beta.id])
  assert.deepEqual(host.workspaces, [alpha])
  deliveryGate.resolve()
  await switching
})

test('shutdown starts no Registry write after precommit and drains an already-started create', async (t) => {
  const project = await temporaryProject(t)
  const beforeMutation = mount(t, [], { cwd: project.path })
  const bindingGate = deferred<void>()
  beforeMutation.host.planBindingPut({ wait: bindingGate.promise })
  const precommitting = send(
    beforeMutation.client,
    'chat-stop-precommit',
    '/project register Stop Before Create',
  )
  await waitFor(() => beforeMutation.host.bindingPuts.length === 1, 'precommit did not start')
  const precommitStop = beforeMutation.bridge.stop()
  bindingGate.resolve()
  await precommitting
  await precommitStop
  assert.deepEqual(beforeMutation.host.workspaceCreateCalls, [])

  const duringResolve = mount(t, [], { cwd: project.path })
  const resolveGate = deferred<void>()
  duringResolve.host.workspaceResolveHandler = async () => {
    await resolveGate.promise
    return undefined
  }
  const resolving = send(
    duringResolve.client,
    'chat-stop-resolve',
    '/project register Stop After Resolve',
  )
  await waitFor(
    () => duringResolve.host.workspaceResolveCalls.length === 1,
    'post-precommit Registry resolve did not start',
  )
  const resolveStop = duringResolve.bridge.stop()
  resolveGate.resolve()
  await resolving
  await resolveStop
  assert.deepEqual(duringResolve.host.workspaceCreateCalls, [])

  const duringMutation = mount(t, [], { cwd: project.path })
  const createGate = deferred<void>()
  duringMutation.host.workspaceCreateHandler = async (path, title) => {
    await createGate.promise
    const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, title, path)
    duringMutation.host.workspaces.push(workspace)
    return workspace
  }
  const registering = send(
    duringMutation.client,
    'chat-stop-create',
    '/project register Drain Started Create',
  )
  await waitFor(() => duringMutation.host.workspaceCreateCalls.length === 1, 'create did not start')
  let stopped = false
  const draining = duringMutation.bridge.stop().then(() => { stopped = true })
  await yieldTurn()
  assert.equal(stopped, false, 'shutdown abandoned an in-flight Registry create')
  createGate.resolve()
  await registering
  await draining
  assert.equal(stopped, true)
  assert.equal(duringMutation.host.workspaces.length, 1)
  assert.match(duringMutation.client.sent.at(-1)?.text ?? '', /已注册当前项目/)

  const deleteWorkspace = new TestWorkspace(WORKSPACE_IDS.beta, 'Drain Delete', project.path)
  const duringDelete = mount(t, [deleteWorkspace], { cwd: project.path })
  const deleteGate = deferred<void>()
  duringDelete.host.workspaceDeleteHandler = async (id) => {
    await deleteGate.promise
    const index = duringDelete.host.workspaces.findIndex((candidate) => candidate.id === id)
    if (index < 0) return false
    duringDelete.host.workspaces.splice(index, 1)
    return true
  }
  const removing = send(
    duringDelete.client,
    'chat-stop-delete',
    `/project remove ${deleteWorkspace.id}`,
  )
  await waitFor(() => duringDelete.host.workspaceDeleteCalls.length === 1, 'delete did not start')
  let deleteStopped = false
  const drainingDelete = duringDelete.bridge.stop().then(() => { deleteStopped = true })
  await yieldTurn()
  assert.equal(deleteStopped, false, 'shutdown abandoned an in-flight Registry delete')
  deleteGate.resolve()
  await removing
  await drainingDelete
  assert.equal(deleteStopped, true)
  assert.deepEqual(duringDelete.host.workspaces, [])
  assert.match(duringDelete.client.sent.at(-1)?.text ?? '', /已移除项目注册/)
})

test('shutdown starts no delete after waiting for an in-flight attachment to quiesce', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Stop Removal', project.path)
  const { host, client, bridge } = mount(t, [workspace])
  await send(client, 'chat-stop-attachment', '/project Stop Removal')
  const active = host.latestCreate()
  const attachmentGate = deferred<void>()
  workspace.statusWait = attachmentGate.promise
  await send(client, 'chat-stop-attachment', 'start pending attachment')
  host.emitTurnStart(active.agent)
  await waitFor(() => workspace.statusCalls.length >= 3, 'attachment status did not start')

  const removing = send(client, 'chat-stop-removal', `/project remove ${workspace.id}`)
  await waitFor(() => host.flushCalls.length >= 4, 'removal precommit did not finish')
  const stopping = bridge.stop()
  attachmentGate.resolve()
  await removing
  await stopping

  assert.deepEqual(host.workspaceDeleteCalls, [])
  assert.deepEqual(host.workspaces, [workspace])
})

test('defaultSessionId shares project state without sharing project-manager authority', async (t) => {
  const project = await temporaryProject(t)
  const { host, client } = mount(t, [], {
    cwd: project.path,
    defaultSessionId: 'shared-project-session',
    allowFrom: ['owner', 'peer'],
    projectManageFrom: ['owner'],
  })

  await send(client, 'chat-owner', '/project register Shared Project')
  const workspace = host.workspaces[0]
  assert.ok(workspace !== undefined)
  await send(client, 'chat-peer', '/project', { openId: 'peer' })
  assert.match(client.sent.at(-1)?.text ?? '', /Shared Project/)
  await send(client, 'chat-peer', `/project remove ${workspace.id}`, { openId: 'peer' })
  assert.match(client.sent.at(-1)?.text ?? '', /没有项目注册管理权限/)
  assert.deepEqual(host.workspaceDeleteCalls, [])

  await send(client, 'chat-owner', `/project remove ${workspace.id}`)
  assert.deepEqual(host.workspaceDeleteCalls, [workspace.id])
  assert.equal(host.creates.length, 1)
  assert.equal(host.latestCreate().sessionId, 'shared-project-session')
  assert.equal(host.latestCreate().agent.disposed, false)
  assert.equal(host.bindings.get('shared-project-session')?.mutationHashes.length, 2)
})

test('removal quiesces an in-flight Workspace attachment and prevents retries to the old id', async (t) => {
  const project = await temporaryProject(t)
  const workspace = new TestWorkspace(WORKSPACE_IDS.alpha, 'Attach Target', project.path)
  const { host, client } = mount(t, [workspace])
  await send(client, 'chat-attach', '/project Attach Target')
  const active = host.latestCreate()
  const attachmentStatus = deferred<void>()
  workspace.statusWait = attachmentStatus.promise
  await send(client, 'chat-attach', 'make this generation durable')
  host.emitTurnStart(active.agent)
  await waitFor(() => workspace.statusCalls.length >= 3, 'Workspace attachment did not start')

  const removing = send(client, 'chat-remove-attach', `/project remove ${workspace.id}`)
  await yieldTurn()
  assert.deepEqual(host.workspaceDeleteCalls, [], 'removal raced past the in-flight attachment')
  attachmentStatus.resolve()
  await removing

  assert.deepEqual(workspace.attachCalls, [])
  assert.deepEqual(host.workspaceDeleteCalls, [workspace.id])
  host.emitTurnStart(active.agent, 2)
  await yieldTurn()
  assert.deepEqual(workspace.attachCalls, [], 'a removed Workspace attachment retried')
  assert.equal(active.agent.disposed, false)
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
      args.some((value) => String(value).includes('durable workspace session attachment failed'))
    )),
    'deferred Workspace attachment failure was not reported',
  )
  assert.deepEqual(workspace.attachCalls, [fresh.sessionId])
  assert.equal(host.warnings.flat().some((value) => (
    String(value).includes('workspace index unavailable')
  )), false)

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
