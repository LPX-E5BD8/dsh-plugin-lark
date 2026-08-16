import assert from 'node:assert/strict'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { LarkBridge } from '../src/bridge.ts'
import type { LarkClientLike, LarkInbound } from '../src/lark.ts'

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

type CacheClient = LarkClientLike & {
  handler?: (message: LarkInbound) => Promise<void>
  stopCalls: number
}

function createClient(): CacheClient {
  const client: CacheClient = {
    stopCalls: 0,
    async start() {},
    async stop() { client.stopCalls += 1 },
    async sendText() {},
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
    messageId: `cache-${inboundSequence}`,
    mentioned: false,
  }
}

async function send(client: CacheClient, chatId: string, text: string): Promise<void> {
  assert.ok(client.handler !== undefined)
  await client.handler(inbound(chatId, text))
}

interface TestSession {
  readonly id: string
  requestContext(): undefined
}

type AgentPhase = 'idle' | 'running' | 'maintenance'

interface FollowupRecord {
  readonly agent: TestAgent
  readonly sessionId: string
  readonly message: unknown
}

type FlushPlan = {
  readonly wait?: Promise<void>
  readonly result: boolean
  readonly error?: undefined
} | {
  readonly wait?: Promise<void>
  readonly error: Error
}

class TestAgent {
  readonly inbox = { hasPending: false }
  readonly ctx: Record<string, never> = {}
  phase: AgentPhase = 'idle'
  disposed = false
  maintenanceAttempts = 0
  whenIdleCalls = 0
  disposeExecutions = 0
  private idleWaiters: Array<() => void> = []

  constructor(
    readonly host: CacheHost,
    readonly id: string,
    readonly session: TestSession,
    readonly serial: number,
  ) {}

  get status(): 'idle' | 'running' {
    return this.phase === 'running' ? 'running' : 'idle'
  }

  beginRunning(): void {
    assert.equal(this.phase, 'idle')
    this.phase = 'running'
  }

  finishRunning(): void {
    assert.equal(this.phase, 'running')
    this.phase = 'idle'
    this.resolveIdleWaiters()
  }

  followup(message: unknown): void {
    assert.equal(this.disposed, false, `followup reached disposed agent ${this.id}#${this.serial}`)
    this.host.operations.push(`${this.id}#${this.serial}:followup`)
    this.host.followups.push({ agent: this, sessionId: this.id, message })
    if (this.host.runOnFollowup.has(this.id) && this.phase === 'idle') this.beginRunning()
  }

  cancel(): void {}

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.maintenanceAttempts += 1
    if (this.phase !== 'idle') throw new Error(`agent "${this.id}" already has active work`)
    const abort = new AbortController()
    this.phase = 'maintenance'
    this.host.operations.push(`${this.id}#${this.serial}:maintenance:start`)
    return (async () => {
      try {
        return await task(abort.signal)
      } finally {
        this.phase = 'idle'
        this.host.operations.push(`${this.id}#${this.serial}:maintenance:end`)
        this.resolveIdleWaiters()
      }
    })()
  }

  whenIdle(): Promise<void> {
    this.whenIdleCalls += 1
    if (this.phase === 'idle') return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private resolveIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}

class CacheHost {
  readonly persisted = new Set<string>()
  readonly liveAgents = new Map<string, TestAgent>()
  readonly liveSessions = new Map<string, TestSession>()
  readonly agentHistory = new Map<string, TestAgent[]>()
  readonly created: string[] = []
  readonly resumed: string[] = []
  readonly disposed: TestAgent[] = []
  readonly followups: FollowupRecord[] = []
  readonly flushCalls: string[] = []
  readonly warnings: unknown[][] = []
  readonly errors: unknown[][] = []
  readonly operations: string[] = []
  readonly runOnFollowup = new Set<string>()
  private readonly flushPlans = new Map<string, FlushPlan[]>()
  private readonly disposeWaits = new Map<string, Promise<void>[]>()
  private readonly disposeFailures = new Map<string, Error[]>()
  private serial = 0
  commandHandler?: (
    agent: TestAgent,
    line: string,
    signal: AbortSignal,
  ) => Promise<{ readonly result: { readonly kind: 'success' | 'error'; readonly text?: string } } | undefined>

  readonly ctx = {
    logger: {
      warn: (...args: unknown[]) => { this.warnings.push(args) },
      error: (...args: unknown[]) => { this.errors.push(args) },
    },
    on: (_name: string, _listener: (...args: never[]) => unknown) => () => {},
    get: (name: string) => {
      if (name === 'approval') return {}
      if (name === 'sessionPersistence') {
        return {
          list: async () => [...this.persisted].map((id) => ({ id })),
        }
      }
      if (name === 'commands' && this.commandHandler !== undefined) {
        return {
          list: () => [],
          execute: (agent: TestAgent, line: string, signal: AbortSignal) => (
            this.commandHandler?.(agent, line, signal)
          ),
        }
      }
      return undefined
    },
    agents: {
      create: async (options: { sessionId: unknown }) => this.open(String(options.sessionId), false),
      resume: async (options: { resumeSessionId: unknown }) => this.open(String(options.resumeSessionId), true),
      get: (id: unknown) => this.liveAgents.get(String(id)),
      list: () => [...this.liveAgents.values()],
      roots: () => [...this.liveAgents.values()],
    },
    sessions: {
      get: (id: unknown) => this.liveSessions.get(String(id)),
      list: () => [...this.liveSessions.values()],
      flush: (session: TestSession) => this.flush(session),
    },
  }

  planFlush(sessionId: string, plan: FlushPlan): void {
    const plans = this.flushPlans.get(sessionId) ?? []
    plans.push(plan)
    this.flushPlans.set(sessionId, plans)
  }

  planDisposeFailure(sessionId: string, error: Error): void {
    const failures = this.disposeFailures.get(sessionId) ?? []
    failures.push(error)
    this.disposeFailures.set(sessionId, failures)
  }

  planDisposeWait(sessionId: string, wait: Promise<void>): void {
    const waits = this.disposeWaits.get(sessionId) ?? []
    waits.push(wait)
    this.disposeWaits.set(sessionId, waits)
  }

  latest(sessionId: string): TestAgent {
    const agent = this.agentHistory.get(sessionId)?.at(-1)
    assert.ok(agent !== undefined, `missing agent ${sessionId}`)
    return agent
  }

  private open(sessionId: string, resumed: boolean) {
    if (this.liveAgents.has(sessionId) || this.liveSessions.has(sessionId)) {
      throw new Error(`duplicate live session ${sessionId}`)
    }
    if (resumed && !this.persisted.has(sessionId)) {
      throw new Error(`session "${sessionId}" not found`)
    }
    if (resumed) this.resumed.push(sessionId)
    else this.created.push(sessionId)
    const session: TestSession = { id: sessionId, requestContext: () => undefined }
    const agent = new TestAgent(this, sessionId, session, ++this.serial)
    this.liveSessions.set(sessionId, session)
    this.liveAgents.set(sessionId, agent)
    const history = this.agentHistory.get(sessionId) ?? []
    history.push(agent)
    this.agentHistory.set(sessionId, history)
    let disposal: Promise<void> | undefined
    return {
      agent,
      dispose: () => disposal ??= this.dispose(agent),
    }
  }

  private async flush(session: TestSession): Promise<boolean> {
    this.flushCalls.push(session.id)
    const agent = this.liveAgents.get(session.id)
    this.operations.push(`${session.id}#${agent?.serial ?? 'missing'}:flush`)
    const plans = this.flushPlans.get(session.id)
    const plan = plans?.shift() ?? { result: true }
    if (plans?.length === 0) this.flushPlans.delete(session.id)
    await plan.wait
    if ('error' in plan) throw plan.error
    if (plan.result) this.persisted.add(session.id)
    return plan.result
  }

  private async dispose(agent: TestAgent): Promise<void> {
    agent.disposeExecutions += 1
    this.operations.push(`${agent.id}#${agent.serial}:dispose:${agent.phase}`)
    assert.notEqual(agent.phase, 'maintenance', 'handle.dispose() ran inside runMaintenance callback')
    const waits = this.disposeWaits.get(agent.id)
    const wait = waits?.shift()
    if (waits?.length === 0) this.disposeWaits.delete(agent.id)
    await wait
    agent.disposed = true
    this.disposed.push(agent)
    if (this.liveAgents.get(agent.id) === agent) this.liveAgents.delete(agent.id)
    if (this.liveSessions.get(agent.id) === agent.session) this.liveSessions.delete(agent.id)
    const failures = this.disposeFailures.get(agent.id)
    const failure = failures?.shift()
    if (failures?.length === 0) this.disposeFailures.delete(agent.id)
    if (failure !== undefined) throw failure
  }
}

function mountCache(t: { after(callback: () => void | Promise<void>): void }, cap: number): {
  readonly host: CacheHost
  readonly client: CacheClient
  readonly bridge: LarkBridge
} {
  const host = new CacheHost()
  const client = createClient()
  const bridge = new LarkBridge(host.ctx as never, {
    client,
    allowFrom: ['owner'],
    maxConversationHandles: cap,
  } as never)
  void bridge.start()
  t.after(() => bridge.stop())
  return { host, client, bridge }
}

test('maxConversationHandles rejects unsafe numeric bounds at construction', () => {
  const client = createClient()
  const invalid = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]
  for (const value of invalid) {
    assert.throws(
      () => new LarkBridge({} as never, {
        client,
        maxConversationHandles: value,
      } as never),
      /maxConversationHandles must be a non-negative safe integer/,
    )
  }
})

test('conversation cache touches LRU order and cold-resumes an evicted conversation', async (t) => {
  const { host, client } = mountCache(t, 2)

  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  await send(client, 'chat-b', 'b1')
  const b = host.latest('lark:chat-b')
  await send(client, 'chat-a', 'a2')
  await send(client, 'chat-c', 'c1')

  await waitFor(() => b.disposed, 'least-recently-used chat B was not evicted')
  assert.equal(a.disposed, false)
  assert.equal(host.latest('lark:chat-c').disposed, false)
  assert.deepEqual(host.disposed, [b])

  await send(client, 'chat-b', 'b2')
  await waitFor(
    () => host.resumed.includes('lark:chat-b'),
    'evicted chat B was not cold-resumed',
  )
  const resumedB = host.latest('lark:chat-b')
  assert.notEqual(resumedB, b)
  assert.deepEqual(
    host.followups.filter(({ sessionId }) => sessionId === 'lark:chat-b').map(({ agent }) => agent),
    [b, resumedB],
  )
})

test('a terminal dispose rejection cannot leave a dead active binding', async (t) => {
  const { host, client } = mountCache(t, 1)
  host.planDisposeFailure('lark:chat-a', new Error('scope teardown reported failure'))
  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  host.runOnFollowup.add('lark:chat-b')

  await send(client, 'chat-b', 'b1')
  const b = host.latest('lark:chat-b')
  await waitFor(() => a.disposed, 'failing terminal disposer did not run')
  await waitFor(
    () => host.errors.some((args) => args.some((value) => String(value).includes('disposal failed'))),
    'dispose rejection was not reported',
  )
  assert.equal(host.liveAgents.has(a.id), false)
  assert.equal(host.liveSessions.has(a.id), false)
  assert.equal(a.disposeExecutions, 1)

  await send(client, 'chat-a', 'a2')
  await waitFor(() => host.resumed.includes(a.id), 'detached conversation was not cold-resumed')
  const resumedA = host.latest(a.id)
  assert.notEqual(resumedA, a)
  assert.equal(
    host.followups.filter(({ agent }) => agent === resumedA).length,
    1,
    'revisited message did not reach the replacement handle',
  )
  b.finishRunning()
})

test('busy oldest conversation stays resident and whenIdle automatically converges the cap', async (t) => {
  const { host, client } = mountCache(t, 1)
  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  a.beginRunning()
  host.runOnFollowup.add('lark:chat-b')

  await send(client, 'chat-b', 'b1')
  const b = host.latest('lark:chat-b')
  await waitFor(() => a.whenIdleCalls > 0, 'busy candidate did not arm an idle retry')
  assert.equal(a.disposed, false)
  assert.equal(b.disposed, false)
  assert.equal(host.liveAgents.size, 2)

  a.finishRunning()
  await waitFor(() => a.disposed, 'idle retry did not evict the old conversation')
  assert.equal(b.disposed, false)
  assert.equal(host.liveAgents.size, 1)
  b.finishRunning()
})

for (const failure of ['false', 'reject'] as const) {
  test(`conversation cache is fail-closed when durability flush returns ${failure}`, async (t) => {
    const { host, client } = mountCache(t, 1)
    await send(client, 'chat-a', 'a1')
    const a = host.latest('lark:chat-a')
    if (failure === 'false') host.planFlush(a.id, { result: false })
    else host.planFlush(a.id, { error: new Error('persistence unavailable') })
    host.runOnFollowup.add('lark:chat-b')

    await send(client, 'chat-b', 'b1')
    const b = host.latest('lark:chat-b')
    await waitFor(() => host.flushCalls.includes(a.id), 'durability checkpoint was not attempted')
    await yieldTurn()

    assert.equal(a.disposed, false)
    assert.equal(b.disposed, false)
    assert.equal(host.liveAgents.get(a.id), a)
    assert.equal(host.liveSessions.get(a.id), a.session)
    b.finishRunning()
  })
}

test('a same-base lease vetoes eviction while durability flush is deferred', async (t) => {
  const { host, client } = mountCache(t, 1)
  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  const checkpoint = deferred<void>()
  host.planFlush(a.id, { result: true, wait: checkpoint.promise })
  host.runOnFollowup.add('lark:chat-b')

  await send(client, 'chat-b', 'b1')
  await waitFor(() => host.flushCalls.includes(a.id), 'deferred eviction flush did not start')
  const revisiting = send(client, 'chat-a', 'a2')
  await yieldTurn()
  assert.equal(
    host.followups.filter(({ agent }) => agent === a).length,
    1,
    'same-base message reached the candidate before the eviction gate settled',
  )

  checkpoint.resolve()
  await revisiting
  await waitFor(
    () => host.followups.filter(({ agent }) => agent === a).length === 2,
    'same-base message did not return to the retained handle',
  )
  assert.equal(host.agentHistory.get(a.id)?.length, 1)
  const secondFollowup = host.operations.lastIndexOf(`${a.id}#${a.serial}:followup`)
  const disposed = host.operations.indexOf(`${a.id}#${a.serial}:dispose:idle`)
  assert.ok(secondFollowup >= 0)
  assert.ok(disposed === -1 || disposed > secondFollowup, 'message landed on a closing handle')
  host.latest('lark:chat-b').finishRunning()
})

test('an idle agent with pending inbox work is not evicted', async (t) => {
  const { host, client } = mountCache(t, 1)
  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  a.inbox.hasPending = true
  host.runOnFollowup.add('lark:chat-b')

  await send(client, 'chat-b', 'b1')
  await waitFor(() => a.maintenanceAttempts > 0, 'pending candidate was not inspected')
  await yieldTurn()

  assert.equal(a.status, 'idle')
  assert.equal(a.disposed, false)
  assert.equal(host.flushCalls.includes(a.id), false)
  host.latest('lark:chat-b').finishRunning()
})

test('a deferred runtime command leases its public-idle conversation until queue completion', async (t) => {
  const { host, client } = mountCache(t, 1)
  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  assert.equal(a.status, 'idle')

  const commandStarted = deferred<TestAgent>()
  const commandCompletion = deferred<void>()
  host.commandHandler = async (agent, line) => {
    assert.equal(line, '/hold')
    commandStarted.resolve(agent)
    await commandCompletion.promise
    return { result: { kind: 'success' } }
  }
  let commandSettled = false
  const command = send(client, 'chat-a', '/hold').then(() => { commandSettled = true })
  assert.equal(await commandStarted.promise, a)
  host.runOnFollowup.add('lark:chat-b')

  await send(client, 'chat-b', 'b1')
  const b = host.latest('lark:chat-b')
  await waitFor(() => b.whenIdleCalls > 0, 'cap pressure was not evaluated while command was leased')
  await yieldTurn()
  assert.equal(commandSettled, false)
  assert.equal(a.status, 'idle')
  assert.equal(a.disposed, false)
  assert.equal(a.maintenanceAttempts, 0, 'leased command handle reached eviction maintenance')
  assert.equal(host.liveAgents.size, 2)

  commandCompletion.resolve()
  await command
  await waitFor(() => a.disposed, 'released command lease did not converge the cache')
  assert.equal(b.disposed, false)
  assert.equal(host.liveAgents.size, 1)
  b.finishRunning()
})

test('eviction finalization preserves a newer queued command tail for the same base', async (t) => {
  const { host, client, bridge } = mountCache(t, 1)
  await send(client, 'chat-a', 'a1')
  const oldA = host.latest('lark:chat-a')
  const disposeRelease = deferred<void>()
  host.planDisposeWait(oldA.id, disposeRelease.promise)
  host.runOnFollowup.add('lark:chat-b')

  await send(client, 'chat-b', 'b1')
  const b = host.latest('lark:chat-b')
  await waitFor(() => oldA.disposeExecutions === 1, 'old A disposal did not become pending')
  assert.equal(oldA.disposed, false)

  const firstStarted = deferred<TestAgent>()
  const firstCompletion = deferred<void>()
  const secondStarted = deferred<TestAgent>()
  const secondCompletion = deferred<void>()
  const order: string[] = []
  host.commandHandler = async (agent, line) => {
    if (line === '/first') {
      order.push('first:start')
      firstStarted.resolve(agent)
      await firstCompletion.promise
      order.push('first:end')
      return { result: { kind: 'success' } }
    }
    assert.equal(line, '/second')
    order.push('second:start')
    secondStarted.resolve(agent)
    await secondCompletion.promise
    order.push('second:end')
    return { result: { kind: 'success' } }
  }

  const first = send(client, 'chat-a', '/first')
  const internals = bridge as unknown as {
    readonly sessionOperations: Map<string, Promise<void>>
  }
  await waitFor(
    () => internals.sessionOperations.has(oldA.id),
    'first command tail was not queued behind the eviction gate',
  )
  assert.deepEqual(order, [])

  disposeRelease.resolve()
  const resumedA = await firstStarted.promise
  assert.notEqual(resumedA, oldA)
  assert.ok(host.resumed.includes(oldA.id))
  assert.deepEqual(order, ['first:start'])

  const second = send(client, 'chat-a', '/second')
  await yieldTurn()
  assert.deepEqual(order, ['first:start'], 'second command bypassed the first command tail')

  firstCompletion.resolve()
  await secondStarted.promise
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start'])
  secondCompletion.resolve()
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end'])
  b.finishRunning()
})

test('one rejected oldest checkpoint stops the eviction pass and a later access retries', async (t) => {
  const { host, client, bridge } = mountCache(t, 3)
  await send(client, 'chat-a', 'a1')
  await send(client, 'chat-b', 'b1')
  await send(client, 'chat-c', 'c1')
  const a = host.latest('lark:chat-a')
  const b = host.latest('lark:chat-b')
  const c = host.latest('lark:chat-c')
  const internals = bridge as unknown as { maxConversationHandles: number }
  internals.maxConversationHandles = 1
  host.planFlush(a.id, { error: new Error('backend unavailable') })

  await send(client, 'chat-c', 'trigger-first-pass')
  await waitFor(() => host.flushCalls.length >= 1, 'oldest checkpoint was not attempted')
  await yieldTurn()
  assert.deepEqual(host.flushCalls, [a.id])
  assert.deepEqual(host.disposed, [])
  assert.equal(a.disposed, false)
  assert.equal(b.disposed, false)
  assert.equal(c.disposed, false)
  assert.equal(
    host.warnings.filter((args) => args.some((value) => String(value).includes('checkpoint failed'))).length,
    1,
  )

  await send(client, 'chat-c', 'trigger-retry')
  await waitFor(() => host.flushCalls.length >= 2, 'later access did not retry eviction')
  assert.deepEqual(host.flushCalls.slice(0, 2), [a.id, a.id])
})

test('handle disposal happens only after the maintenance callback exits', async (t) => {
  const { host, client } = mountCache(t, 0)
  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  await waitFor(() => a.disposed, 'zero-cap conversation was not evicted')

  assert.deepEqual(
    host.operations.filter((entry) => entry.startsWith(`${a.id}#${a.serial}:`)),
    [
      `${a.id}#${a.serial}:followup`,
      `${a.id}#${a.serial}:maintenance:start`,
      `${a.id}#${a.serial}:flush`,
      `${a.id}#${a.serial}:maintenance:end`,
      `${a.id}#${a.serial}:dispose:idle`,
    ],
  )
})

test('bridge stop waits for a deferred eviction transaction', async () => {
  const host = new CacheHost()
  const client = createClient()
  const bridge = new LarkBridge(host.ctx as never, {
    client,
    allowFrom: ['owner'],
    maxConversationHandles: 0,
  } as never)
  await bridge.start()
  const checkpoint = deferred<void>()
  host.planFlush('lark:chat-a', { result: true, wait: checkpoint.promise })

  await send(client, 'chat-a', 'a1')
  const a = host.latest('lark:chat-a')
  await waitFor(() => host.flushCalls.includes(a.id), 'deferred zero-cap eviction did not start')
  let stopped = false
  const stopping = bridge.stop().then(() => { stopped = true })
  await yieldTurn()
  assert.equal(stopped, false)
  assert.equal(a.disposed, false)

  checkpoint.resolve()
  await stopping
  assert.equal(a.disposed, true)
  assert.equal(a.disposeExecutions, 1)
  assert.equal(host.liveAgents.size, 0)
  assert.equal(host.liveSessions.size, 0)
})
