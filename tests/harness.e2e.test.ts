import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { LarkBridge } from '../src/bridge.ts'
import {
  DurableConversationBindingStore,
  type ConversationBindingStore,
} from '../src/conversation-binding.ts'
import { DurableInboundDeduplicator } from '../src/inbound-dedup.ts'
import type {
  LarkCardAction,
  LarkCardActionResult,
  LarkClientLike,
  LarkInbound,
} from '../src/lark.ts'
import type { LarkLocale } from '../src/locale.ts'

type HarnessClient = LarkClientLike & {
  readonly cards: Array<{ messageId: string; card: unknown }>
  readonly updated: Array<{ messageId: string; card: unknown }>
  readonly sent: string[]
  stopped: boolean
  messageHandler?: (message: LarkInbound) => Promise<void>
  cardHandler?: (action: LarkCardAction) => Promise<LarkCardActionResult>
}

function createClient(): HarnessClient {
  const client: HarnessClient = {
    cards: [],
    updated: [],
    sent: [],
    stopped: false,
    async start() {},
    async stop() { client.stopped = true },
    async sendText(_chatId, text) { client.sent.push(text) },
    async sendCard(_chatId, card) {
      const messageId = `card-${client.cards.length + 1}`
      client.cards.push({ messageId, card })
      return messageId
    },
    async updateCard(messageId, card) { client.updated.push({ messageId, card }) },
    onMessage(handler) { client.messageHandler = handler },
    onCardAction(handler) { client.cardHandler = handler },
  }
  return client
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolResponse(): StreamChunk[] {
  const callId = CallId('echo-call')
  const args = JSON.stringify({ text: 'ping' })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'echo', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'echo', arguments: args } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly responses: StreamChunk[][]) {
    super()
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const response = this.responses.shift()
    if (response === undefined) throw new Error('script exhausted')
    yield* response
  }
}

function echoTool() {
  return defineTool({
    name: 'echo',
    description: 'echo text',
    parameters: { text: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args) { return args.text },
  })
}

function command(text: string): LarkInbound {
  return {
    chatId: 'chat-a',
    chatType: 'p2p',
    openId: 'owner',
    text,
    messageId: `message-${text}`,
    mentioned: false,
  }
}

function conversationCommand(chatId: string, text: string): LarkInbound {
  return {
    chatId,
    chatType: 'p2p',
    openId: 'owner',
    text,
    messageId: `message-${chatId}-${text}`,
    mentioned: false,
  }
}

function approvalRequestId(card: unknown): string {
  const payload = card as {
    body?: {
      elements?: Array<{
        element_id?: string
        columns?: Array<{ elements?: Array<{ behaviors?: Array<{ value?: { request_id?: string } }> }> }>
      }>
    }
  }
  const buttons = payload.body?.elements?.find((element) => element.element_id === 'approval_buttons')
  return buttons?.columns?.[0]?.elements?.[0]?.behaviors?.[0]?.value?.request_id ?? ''
}

interface HarnessPreset {
  readonly defaultId: string
  readonly mounted: string[]
  readonly withEchoTool?: boolean
}

interface HarnessWorkspaceSpec {
  readonly id: string
  readonly path: string
  readonly title: string
}

class HarnessWorkspace {
  readonly sessionIds: Array<ReturnType<typeof SessionId>> = []

  constructor(
    private readonly ctx: Context,
    readonly id: string,
    readonly path: string,
    readonly title: string,
  ) {}

  async status(): Promise<'ok' | 'missing-dir'> {
    try {
      return (await stat(this.path)).isDirectory() ? 'ok' : 'missing-dir'
    } catch {
      return 'missing-dir'
    }
  }

  async attachSession(rawSessionId: ReturnType<typeof SessionId>): Promise<void> {
    const sessionId = SessionId(String(rawSessionId))
    const live = this.ctx.sessions.get(sessionId)
    const header = live?.header
      ?? (await this.ctx.sessionPersistence.inspect(sessionId)).meta
    if (header.cwd === undefined) {
      throw new Error(`cannot attach session '${sessionId}': its header has no cwd`)
    }
    const cwd = await realpath(header.cwd)
    if (!(await stat(cwd)).isDirectory() || cwd !== this.path) {
      throw new Error(`cannot attach session '${sessionId}': cwd '${cwd}' does not match '${this.path}'`)
    }
    const prior = this.sessionIds.indexOf(sessionId)
    if (prior >= 0) this.sessionIds.splice(prior, 1)
    this.sessionIds.unshift(sessionId)
  }
}

const HARNESS_DEDUP_NAMESPACE = 'harness-e2e-app'

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail('condition was not met before timeout')
}

async function cleanupHarness(
  ctx: Context,
  bridge: LarkBridge | undefined,
  deduplicator: DurableInboundDeduplicator | undefined,
  conversationBindings: DurableConversationBindingStore | undefined,
): Promise<unknown[]> {
  const failures: unknown[] = []
  if (bridge !== undefined) {
    try {
      await bridge.stop()
    } catch (error) {
      failures.push(error)
    }
  }
  if (deduplicator !== undefined) {
    try {
      await deduplicator.close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (conversationBindings !== undefined) {
    try {
      await conversationBindings.close()
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    await ctx.fiber.dispose()
  } catch (error) {
    failures.push(error)
  }
  return failures
}

async function mount(
  root: string,
  adapter?: LlmAdapter,
  locale?: LarkLocale,
  preset?: HarnessPreset,
  maxConversationHandles?: number,
  workspaceSpecs?: readonly HarnessWorkspaceSpec[],
): Promise<{
  ctx: Context
  bridge: LarkBridge
  client: HarnessClient
  workspaces: HarnessWorkspace[]
  dispose(): Promise<void>
}> {
  const ctx = new Context()
  let bridge: LarkBridge | undefined
  let deduplicator: DurableInboundDeduplicator | undefined
  let conversationBindings: DurableConversationBindingStore | undefined
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(root, 'inbound-dedup') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    await ctx.plugin(ApprovalService)
    if (preset !== undefined) {
      ctx.provide('agentPresets', {
        resolve(id?: string) {
          return Promise.resolve({ id: id ?? preset.defaultId })
        },
        async mount(agentCtx: Context, id?: string) {
          const resolved = id ?? preset.defaultId
          preset.mounted.push(resolved)
          if (preset.withEchoTool === true) agentCtx.tools.register(echoTool())
          return { id: resolved }
        },
      })
    }
    const workspaces = workspaceSpecs?.map((workspace) => new HarnessWorkspace(
      ctx,
      workspace.id,
      workspace.path,
      workspace.title,
    )) ?? []
    if (workspaceSpecs !== undefined) {
      ctx.provide('workspaceRegistry', {
        list: () => [...workspaces],
        get: (id: unknown) => workspaces.find((workspace) => workspace.id === String(id)),
        resolveByPath: async (path: string) => {
          const canonical = await realpath(path)
          return workspaces.find((workspace) => workspace.path === canonical)
        },
      })
    }
    if (adapter !== undefined) ctx.llm.registerAdapter(['mock'], adapter)
    deduplicator = await DurableInboundDeduplicator.open(
      ctx.storageDomain,
      HARNESS_DEDUP_NAMESPACE,
    )
    conversationBindings = await DurableConversationBindingStore.open(
      ctx.storageDomain,
      HARNESS_DEDUP_NAMESPACE,
    )
    const client = createClient()
    bridge = new LarkBridge(ctx, {
      client,
      inboundDeduplicator: deduplicator,
      conversationBindings,
      locale,
      allowFrom: ['owner'],
      provider: adapter === undefined ? undefined : 'mock',
      model: adapter === undefined ? undefined : 'mock',
      maxConversationHandles,
    })
    await bridge.start()
    let disposal: Promise<void> | undefined
    return {
      ctx,
      bridge,
      client,
      workspaces,
      dispose() {
        disposal ??= (async () => {
          const failures = await cleanupHarness(ctx, bridge, deduplicator, conversationBindings)
          if (failures.length > 0) {
            throw new AggregateError(failures, 'harness e2e cleanup failed')
          }
        })()
        return disposal
      },
    }
  } catch (error) {
    const failures = await cleanupHarness(ctx, bridge, deduplicator, conversationBindings)
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], 'harness e2e mount and cleanup failed')
    }
    throw error
  }
}

test('harness e2e: /new materializes and resumes its session across restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-session-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await mount(root)
  await first.client.messageHandler?.(command('/new'))
  const freshSessionId = first.ctx.agents.list()[0]?.id
  assert.ok(freshSessionId !== undefined)
  assert.notEqual(freshSessionId, 'lark:chat-a')
  assert.deepEqual(
    (await first.ctx.sessionPersistence.inspect(freshSessionId)).events.map((event) => event.type),
    ['todo/write'],
  )
  await first.dispose()

  const second = await mount(root)
  await second.client.messageHandler?.(command('/help'))
  assert.equal(second.ctx.agents.list()[0]?.id, freshSessionId)
  assert.equal(second.ctx.agents.list()[0]?.session.firstLiveSeq, 1)
  await second.dispose()
})

test('harness e2e: a persisted /new receipt suppresses replay after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-new-dedup-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const inbound = command('/new')

  const first = await mount(root)
  t.after(() => first.dispose())
  await first.client.messageHandler?.(inbound)
  assert.equal(first.ctx.agents.list().length, 1)
  assert.equal(first.client.sent.length, 1)
  await first.dispose()

  const second = await mount(root)
  t.after(() => second.dispose())
  await second.client.messageHandler?.(inbound)
  assert.equal(second.ctx.agents.list().length, 0)
  assert.deepEqual(second.client.sent, [])
  await second.dispose()
})

test('harness e2e: a published but rejected /new candidate stays orphaned across restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-new-rollback-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const baseId = 'lark:chat-new-rollback'
  const first = await mount(
    root,
    new ScriptedAdapter([textResponse('durable old reset answer')]),
  )
  t.after(() => first.dispose())
  await first.client.messageHandler?.(
    conversationCommand('chat-new-rollback', 'materialize old reset session'),
  )
  await first.ctx.agents.list()[0]?.whenIdle()
  assert.equal(first.ctx.agents.list()[0]?.id, baseId)

  const sessionService = first.ctx.sessions as unknown as {
    flush(session: Parameters<Context['sessions']['flush']>[0]): Promise<boolean>
  }
  const originalFlush = sessionService.flush.bind(sessionService)
  let flushes = 0
  sessionService.flush = async (session) => {
    flushes += 1
    const durable = await originalFlush(session)
    return flushes === 2 ? false : durable
  }
  let candidateId: ReturnType<typeof SessionId> | undefined
  const disposeCapture = first.ctx.on('session/created', (session) => {
    if (String(session.id) !== baseId) candidateId = session.id
  })

  await first.client.messageHandler?.(conversationCommand('chat-new-rollback', '/new'))
  disposeCapture()
  sessionService.flush = originalFlush
  assert.ok(candidateId !== undefined)
  assert.deepEqual(first.ctx.agents.list().map(({ id }) => String(id)), [baseId])
  assert.match(first.client.sent.at(-1) ?? '', /当前会话保持不变|left unchanged/)
  let orphanPersisted = false
  for (let attempt = 0; attempt < 500; attempt += 1) {
    orphanPersisted = (await first.ctx.sessionPersistence.list())
      .some(({ id }) => id === candidateId)
    if (orphanPersisted) break
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(orphanPersisted, true)
  await first.dispose()

  const second = await mount(root)
  t.after(() => second.dispose())
  await second.client.messageHandler?.(conversationCommand('chat-new-rollback', '/help'))
  assert.equal(second.ctx.agents.list()[0]?.id, baseId)
  assert.notEqual(second.ctx.agents.list()[0]?.id, candidateId)
})

test('harness e2e: message, tool approval, cards, and teardown stay assembled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-assembled-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const harness = await mount(root, new ScriptedAdapter([toolResponse(), textResponse('done')]), 'en-US')
  harness.ctx.tools.register(echoTool())
  harness.ctx.on('tools/pre-execute', async (_execution, _next): Promise<PreToolDecision> => ({
    kind: 'ask',
    reason: 'confirm echo',
  }))

  await harness.client.messageHandler?.(command('use echo'))
  await waitFor(() => harness.client.cards.some((entry) => approvalRequestId(entry.card) !== ''))
  const approval = harness.client.cards.find((entry) => approvalRequestId(entry.card) !== '')
  const requestId = approvalRequestId(approval?.card)
  assert.ok(requestId !== '')
  await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: approval?.messageId ?? '',
    value: { request_id: requestId, decision: 'allowed-once' },
  })

  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()
  await waitFor(() => JSON.stringify(harness.client.updated).includes('done'))
  const eventTypes = agent.session.events.map((event) => event.type)
  for (const type of ['tool/call', 'approval/asked', 'approval/decided', 'tool/result', 'turn/end']) {
    assert.ok(eventTypes.includes(type as never), `missing ${type}`)
  }
  const executionCards = harness.client.cards.filter((entry) => approvalRequestId(entry.card) === '')
  assert.equal(executionCards.length, 1)
  const executionCardId = executionCards[0]?.messageId
  const finalCard = harness.client.updated.findLast((entry) => entry.messageId === executionCardId)?.card
  assert.match(JSON.stringify(finalCard), /echo/)
  assert.match(JSON.stringify(finalCard), /done/)
  assert.ok(harness.client.updated.some((entry) => (
    entry.messageId === approval?.messageId && JSON.stringify(entry.card).includes('Approved')
  )))

  const agents = harness.ctx.agents
  await harness.dispose()
  assert.equal(harness.client.stopped, true)
  assert.equal(agents.list().length, 0)
})

test('harness e2e: an external followup cannot steal a queued Lark reply route', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-route-claim-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    textResponse('external-only answer'),
    textResponse('lark-only answer'),
  ])
  const mounted = await mount(root, adapter)
  t.after(() => mounted.dispose())

  await mounted.client.messageHandler?.(conversationCommand('chat-route', '/help'))
  const agent = mounted.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  const release = Promise.withResolvers<void>()
  const maintenance = agent.runMaintenance(async () => release.promise)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'external prompt' }],
    source: { kind: 'user' },
  }))
  await mounted.client.messageHandler?.(conversationCommand('chat-route', 'lark prompt'))

  release.resolve()
  await maintenance
  await agent.whenIdle()
  await waitFor(() => mounted.client.updated.some(({ card }) => (
    JSON.stringify(card).includes('lark-only answer')
  )))

  const delivered = JSON.stringify([
    ...mounted.client.cards.map(({ card }) => card),
    ...mounted.client.updated.map(({ card }) => card),
  ])
  assert.match(delivered, /lark-only answer/)
  assert.doesNotMatch(delivered, /external-only answer/)
  assert.equal(adapter.requests.length, 2)
})

test('harness e2e: an external turn cannot route its approval to a queued Lark message', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-approval-route-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    toolResponse(),
    textResponse('external tool turn complete'),
    textResponse('queued lark turn complete'),
  ])
  const mounted = await mount(root, adapter)
  t.after(() => mounted.dispose())
  mounted.ctx.tools.register(echoTool())
  mounted.ctx.on('tools/pre-execute', async (): Promise<PreToolDecision> => ({
    kind: 'ask',
    reason: 'external approval must stay external',
  }))

  await mounted.client.messageHandler?.(conversationCommand('chat-approval-route', '/help'))
  const agent = mounted.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  const release = Promise.withResolvers<void>()
  const maintenance = agent.runMaintenance(async () => release.promise)
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'external protected prompt' }],
    source: { kind: 'user' },
  }))
  await mounted.client.messageHandler?.(
    conversationCommand('chat-approval-route', 'queued lark prompt'),
  )
  release.resolve()
  await maintenance

  const timeout = Promise.withResolvers<never>()
  const timeoutId = setTimeout(() => timeout.reject(new Error('external approval turn did not settle')), 1_000)
  try {
    await Promise.race([agent.whenIdle(), timeout.promise])
  } finally {
    clearTimeout(timeoutId)
  }
  assert.equal(
    mounted.client.cards.some(({ card }) => approvalRequestId(card) !== ''),
    false,
  )
  await waitFor(() => mounted.client.updated.some(({ card }) => (
    JSON.stringify(card).includes('queued lark turn complete')
  )))
})

test('harness e2e: Lark agents mount and resume their persisted agent preset', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-preset-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const firstMounts: string[] = []
  const firstAdapter = new ScriptedAdapter([textResponse('ready')])
  const first = await mount(root, firstAdapter, undefined, {
    defaultId: 'standard',
    mounted: firstMounts,
    withEchoTool: true,
  })
  await first.client.messageHandler?.(command('inspect the repository'))
  const firstAgent = first.ctx.agents.list()[0]
  assert.ok(firstAgent !== undefined)
  await firstAgent.whenIdle()
  await first.ctx.sessions.flush(firstAgent.session)
  assert.equal(firstAgent.session.header.agentPreset, 'standard')
  assert.equal(
    (await first.ctx.sessionPersistence.inspect(firstAgent.id)).meta.agentPreset,
    'standard',
  )
  assert.deepEqual(firstMounts, ['standard'])
  assert.ok(
    firstAdapter.requests[0]?.tools?.some((tool) => tool.name === 'echo'),
    'preset-scoped tools must reach the model request',
  )
  await first.dispose()

  const resumedMounts: string[] = []
  const resumedAdapter = new ScriptedAdapter([textResponse('resumed')])
  const second = await mount(root, resumedAdapter, undefined, {
    defaultId: 'replacement-default',
    mounted: resumedMounts,
    withEchoTool: true,
  })
  await second.client.messageHandler?.(command('/help'))
  const resumedAgent = second.ctx.agents.list()[0]
  assert.ok(resumedAgent !== undefined)
  assert.equal(resumedAgent.session.header.agentPreset, 'standard')
  assert.deepEqual(resumedMounts, ['standard'])
  await second.client.messageHandler?.(command('continue'))
  await resumedAgent.whenIdle()
  assert.ok(
    resumedAdapter.requests[0]?.tools?.some((tool) => tool.name === 'echo'),
    'resumed preset-scoped tools must reach the model request',
  )
  await second.dispose()
})

test('harness e2e: bounded conversations unregister and cold-resume exact JSONL history', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-conversation-cache-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    textResponse('answer-a-first'),
    textResponse('answer-b-first'),
    textResponse('answer-a-second'),
  ])
  const harness = await mount(root, adapter, undefined, undefined, 1)
  t.after(() => harness.dispose())

  await harness.client.messageHandler?.(conversationCommand('chat-a', 'prompt-a-first'))
  await waitFor(() => adapter.requests.length >= 1)
  const firstA = harness.ctx.agents.list().find((agent) => String(agent.id) === 'lark:chat-a')
  assert.ok(firstA !== undefined)
  await firstA.whenIdle()

  await harness.client.messageHandler?.(conversationCommand('chat-b', 'prompt-b-first'))
  await waitFor(() => adapter.requests.length >= 2)
  const firstB = harness.ctx.agents.list().find((agent) => String(agent.id) === 'lark:chat-b')
  assert.ok(firstB !== undefined)
  await firstB.whenIdle()
  await waitFor(() => (
    harness.ctx.agents.get(firstA.id) === undefined
    && harness.ctx.sessions.get(firstA.session.id) === undefined
  ))

  const persistedA = await harness.ctx.sessionPersistence.inspect(firstA.id)
  assert.ok(persistedA.events.some((event) => (
    event.type === 'assistant/message'
    && JSON.stringify(event.data).includes('answer-a-first')
  )))

  await harness.client.messageHandler?.(conversationCommand('chat-a', 'prompt-a-second'))
  await waitFor(() => adapter.requests.length >= 3)
  const resumedA = harness.ctx.agents.get(firstA.id)
  assert.ok(resumedA !== undefined)
  assert.notEqual(resumedA, firstA)
  assert.equal(resumedA.session.firstLiveSeq, persistedA.events.length)
  await resumedA.whenIdle()

  const resumedRequest = JSON.stringify(adapter.requests[2]?.messages)
  assert.match(resumedRequest, /prompt-a-first/)
  assert.match(resumedRequest, /answer-a-first/)
  assert.match(resumedRequest, /prompt-a-second/)
  assert.doesNotMatch(resumedRequest, /prompt-b-first|answer-b-first/)

  await harness.dispose()
})

test('harness e2e: /project persists an isolated workspace session and cold-resumes it after restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-project-switch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectsRoot = join(root, 'projects')
  await mkdir(join(projectsRoot, 'alpha'), { recursive: true })
  await mkdir(join(projectsRoot, 'beta'), { recursive: true })
  const alphaPath = await realpath(join(projectsRoot, 'alpha'))
  const betaPath = await realpath(join(projectsRoot, 'beta'))
  const workspaceSpecs: HarnessWorkspaceSpec[] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      title: 'Alpha Project',
      path: alphaPath,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      title: 'Beta Project',
      path: betaPath,
    },
  ]

  const firstMounts: string[] = []
  const firstAdapter = new ScriptedAdapter([
    textResponse('legacy answer marker'),
    textResponse('alpha answer marker'),
  ])
  const first = await mount(
    root,
    firstAdapter,
    undefined,
    { defaultId: 'standard', mounted: firstMounts, withEchoTool: true },
    undefined,
    workspaceSpecs,
  )
  t.after(() => first.dispose())

  await first.client.messageHandler?.(conversationCommand('chat-project', 'legacy prompt marker'))
  await waitFor(() => firstAdapter.requests.length >= 1)
  const legacyAgent = first.ctx.agents.list()[0]
  assert.ok(legacyAgent !== undefined)
  await legacyAgent.whenIdle()

  await first.client.messageHandler?.(conversationCommand('chat-project', '/project Alpha Project'))
  const switchedAgent = first.ctx.agents.list().find((agent) => (
    agent.session.header.cwd === alphaPath
  ))
  assert.ok(switchedAgent !== undefined)
  assert.notEqual(switchedAgent.id, legacyAgent.id)
  assert.equal(switchedAgent.session.header.cwd, alphaPath)
  assert.equal(switchedAgent.session.header.agentPreset, 'standard')
  assert.equal(firstMounts.at(-1), 'standard')

  const emptyCheckpoint = await first.ctx.sessionPersistence.inspect(switchedAgent.id)
  assert.equal(emptyCheckpoint.meta.cwd, alphaPath)
  assert.equal(emptyCheckpoint.meta.agentPreset, 'standard')
  assert.deepEqual(
    emptyCheckpoint.events
      .map((event) => event.type)
      .filter((type) => type !== 'session/end-seed' && type !== 'todo/write'),
    [],
    'the switched generation inherited conversation history',
  )
  assert.deepEqual(
    first.workspaces[0]?.sessionIds,
    [],
    'blank Lark generation was exposed to Workspace reuse',
  )
  assert.deepEqual(first.workspaces[1]?.sessionIds, [])

  await first.client.messageHandler?.(conversationCommand('chat-project', 'alpha prompt marker'))
  await waitFor(() => firstAdapter.requests.length >= 2)
  await switchedAgent.whenIdle()
  await waitFor(() => first.workspaces[0]?.sessionIds.some((id) => id === switchedAgent.id) === true)
  assert.equal(first.workspaces[0]?.sessionIds[0], switchedAgent.id)
  const alphaRequest = firstAdapter.requests[1]
  assert.ok(
    alphaRequest?.tools?.some((tool) => tool.name === 'echo'),
    'the switched preset-scoped tool did not reach the model request',
  )
  const alphaMessages = JSON.stringify(alphaRequest?.messages)
  assert.match(alphaMessages, /alpha prompt marker/)
  assert.doesNotMatch(alphaMessages, /legacy prompt marker|legacy answer marker/)
  assert.equal(await first.ctx.sessions.flush(switchedAgent.session), true)
  await first.dispose()

  const resumedMounts: string[] = []
  const resumedAdapter = new ScriptedAdapter([
    textResponse('resumed answer marker'),
    textResponse('fresh project answer marker'),
  ])
  const second = await mount(
    root,
    resumedAdapter,
    undefined,
    { defaultId: 'replacement-default', mounted: resumedMounts, withEchoTool: true },
    0,
    workspaceSpecs,
  )
  t.after(() => second.dispose())
  const resumedSessions: Array<{ id: string; cwd?: string; agentPreset?: string }> = []
  second.ctx.on('session/created', (session) => {
    resumedSessions.push({
      id: String(session.id),
      cwd: session.header.cwd,
      agentPreset: session.header.agentPreset,
    })
  })

  await second.client.messageHandler?.(conversationCommand('chat-project', '/help'))
  await waitFor(() => resumedSessions.length >= 1)
  assert.deepEqual(resumedSessions[0], {
    id: String(switchedAgent.id),
    cwd: alphaPath,
    agentPreset: 'standard',
  })
  assert.deepEqual(resumedMounts, ['standard'])
  await waitFor(() => (
    second.ctx.agents.get(switchedAgent.id) === undefined
    && second.ctx.sessions.get(switchedAgent.id) === undefined
  ))

  await second.client.messageHandler?.(conversationCommand(
    'chat-project',
    'continue after cold restart marker',
  ))
  await waitFor(() => resumedAdapter.requests.length >= 1)
  await waitFor(() => (
    second.ctx.agents.get(switchedAgent.id) === undefined
    && second.ctx.sessions.get(switchedAgent.id) === undefined
  ))
  assert.ok(resumedSessions.length >= 2)
  assert.ok(resumedSessions.every((session) => (
    session.id === String(switchedAgent.id)
    && session.cwd === alphaPath
    && session.agentPreset === 'standard'
  )))
  const resumedRequest = resumedAdapter.requests[0]
  assert.ok(
    resumedRequest?.tools?.some((tool) => tool.name === 'echo'),
    'the cold-resumed preset-scoped tool did not reach the model request',
  )
  const resumedMessages = JSON.stringify(resumedRequest?.messages)
  assert.match(resumedMessages, /alpha prompt marker/)
  assert.match(resumedMessages, /alpha answer marker/)
  assert.match(resumedMessages, /continue after cold restart marker/)
  assert.doesNotMatch(resumedMessages, /legacy prompt marker|legacy answer marker/)

  const resumedCheckpoint = await second.ctx.sessionPersistence.inspect(switchedAgent.id)
  assert.equal(resumedCheckpoint.meta.cwd, alphaPath)
  assert.equal(resumedCheckpoint.meta.agentPreset, 'standard')

  const idsBeforeReset = new Set(
    (await second.ctx.sessionPersistence.list()).map((header) => String(header.id)),
  )
  await second.client.messageHandler?.(conversationCommand('chat-project', '/new'))
  const resetHeader = (await second.ctx.sessionPersistence.list()).find((header) => (
    !idsBeforeReset.has(String(header.id))
  ))
  assert.ok(resetHeader !== undefined)
  assert.equal(resetHeader.cwd, alphaPath)
  assert.equal(resetHeader.agentPreset, 'standard')
  assert.equal(
    second.workspaces[0]?.sessionIds.some((id) => String(id) === String(resetHeader.id)),
    false,
    'blank reset generation was exposed to Workspace reuse',
  )
  await waitFor(() => (
    second.ctx.agents.get(resetHeader.id) === undefined
    && second.ctx.sessions.get(resetHeader.id) === undefined
  ))

  await second.client.messageHandler?.(conversationCommand(
    'chat-project',
    'fresh project generation marker',
  ))
  await waitFor(() => resumedAdapter.requests.length >= 2)
  await waitFor(() => (
    second.workspaces[0]?.sessionIds.some((id) => String(id) === String(resetHeader.id)) === true
  ))
  assert.equal(String(second.workspaces[0]?.sessionIds[0]), String(resetHeader.id))
  await waitFor(() => (
    second.ctx.agents.get(resetHeader.id) === undefined
    && second.ctx.sessions.get(resetHeader.id) === undefined
  ))
  const freshRequest = resumedAdapter.requests[1]
  assert.ok(
    freshRequest?.tools?.some((tool) => tool.name === 'echo'),
    'the reset project session lost its preset-scoped tool',
  )
  const freshMessages = JSON.stringify(freshRequest?.messages)
  assert.match(freshMessages, /fresh project generation marker/)
  assert.doesNotMatch(
    freshMessages,
    /alpha prompt marker|alpha answer marker|continue after cold restart marker/,
  )
  await second.dispose()
})

test('harness e2e: an agent-created veto leaves only an orphan and restart keeps the old binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-project-veto-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  const canonicalProjectPath = await realpath(projectPath)
  const workspace: HarnessWorkspaceSpec = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    path: canonicalProjectPath,
    title: 'Veto Project',
  }
  const baseId = 'lark:chat-veto'

  const first = await mount(
    root,
    new ScriptedAdapter([textResponse('durable old answer')]),
    undefined,
    undefined,
    undefined,
    [workspace],
  )
  t.after(() => first.dispose())
  await first.client.messageHandler?.(conversationCommand('chat-veto', 'materialize old session'))
  await first.ctx.agents.list()[0]?.whenIdle()
  assert.equal(first.ctx.agents.list()[0]?.id, baseId)
  let candidateId: ReturnType<typeof SessionId> | undefined
  const disposeCandidateSeed = first.ctx.on('session/created', (session) => {
    if (String(session.id) === baseId) return
    candidateId = session.id
    session.append('todo/write', { todos: [] })
  })
  const disposeVeto = first.ctx.on('agent/created', ({ agent }) => {
    if (candidateId !== undefined && agent.id === candidateId) {
      throw new Error('candidate publication veto')
    }
  })

  await first.client.messageHandler?.(conversationCommand('chat-veto', '/project Veto Project'))
  disposeVeto()
  disposeCandidateSeed()
  assert.deepEqual(first.ctx.agents.list().map(({ id }) => String(id)), [baseId])
  assert.match(first.client.sent.at(-1) ?? '', /切换失败|Project switch failed/)
  assert.ok(candidateId !== undefined)
  assert.equal(first.ctx.agents.get(candidateId), undefined)
  assert.equal(first.ctx.sessions.get(candidateId), undefined)
  let orphanId: string | undefined
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const persistedIds = (await first.ctx.sessionPersistence.list()).map(({ id }) => String(id))
    orphanId = persistedIds.find((id) => id === String(candidateId))
    if (orphanId !== undefined) break
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.ok(orphanId !== undefined, 'the veto did not leave the intended persisted orphan fixture')
  assert.match(orphanId, /^lark:chat-veto:\d+-/)
  await first.dispose()

  const second = await mount(root, undefined, undefined, undefined, undefined, [workspace])
  t.after(() => second.dispose())
  await second.client.messageHandler?.(conversationCommand('chat-veto', '/help'))
  assert.equal(second.ctx.agents.list()[0]?.id, baseId)
  assert.notEqual(second.ctx.agents.list()[0]?.id, orphanId)
})

test('harness e2e: non-waking old input during final project commit remains pending and resident', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-project-inject-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  const canonicalProjectPath = await realpath(projectPath)
  const mounted = await mount(root, undefined, undefined, undefined, undefined, [{
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    path: canonicalProjectPath,
    title: 'Injected Project',
  }])
  t.after(() => mounted.dispose())
  await mounted.client.messageHandler?.(conversationCommand('chat-inject', '/help'))
  const oldAgent = mounted.ctx.agents.list()[0]
  assert.ok(oldAgent !== undefined)

  const internals = mounted.bridge as unknown as {
    conversationBindings: ConversationBindingStore
  }
  const durable = internals.conversationBindings
  const finalPutStarted = Promise.withResolvers<void>()
  const releaseFinalPut = Promise.withResolvers<void>()
  let puts = 0
  internals.conversationBindings = {
    read: (baseId) => durable.read(baseId),
    async put(baseId, binding) {
      puts += 1
      if (puts === 2) {
        finalPutStarted.resolve()
        await releaseFinalPut.promise
      }
      await durable.put(baseId, binding)
    },
    close: () => durable.close(),
  }

  const switching = mounted.client.messageHandler?.(
    conversationCommand('chat-inject', '/project Injected Project'),
  )
  await finalPutStarted.promise
  oldAgent.inject(createUserMessage({
    content: [{ type: 'text', text: 'non-waking external context' }],
    source: { kind: 'user' },
  }))
  assert.equal(oldAgent.inbox.hasPending, true)
  releaseFinalPut.resolve()
  await switching
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(oldAgent.inbox.hasPending, true)
  assert.equal(mounted.ctx.agents.get(oldAgent.id), oldAgent)
  assert.equal(mounted.ctx.agents.list().length, 2)
})

test('harness e2e: a blank project generation stays unindexed across restart until its first turn', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-blank-project-restart-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  await mkdir(projectPath, { recursive: true })
  const canonicalProjectPath = await realpath(projectPath)
  const workspaceSpecs: HarnessWorkspaceSpec[] = [{
    id: '33333333-3333-4333-8333-333333333333',
    title: 'Restart Project',
    path: canonicalProjectPath,
  }]

  const first = await mount(root, undefined, undefined, undefined, undefined, workspaceSpecs)
  t.after(() => first.dispose())
  await first.client.messageHandler?.(conversationCommand('chat-blank-project', '/project Restart Project'))
  const blankAgent = first.ctx.agents.list().find((agent) => (
    agent.session.header.cwd === canonicalProjectPath
  ))
  assert.ok(blankAgent !== undefined)
  const blankCheckpoint = await first.ctx.sessionPersistence.inspect(blankAgent.id)
  assert.deepEqual(
    blankCheckpoint.events
      .map((event) => event.type)
      .filter((type) => type !== 'session/end-seed' && type !== 'todo/write'),
    [],
  )
  assert.deepEqual(first.workspaces[0]?.sessionIds, [])
  await first.dispose()

  const adapter = new ScriptedAdapter([textResponse('first project answer')])
  const second = await mount(root, adapter, undefined, undefined, undefined, workspaceSpecs)
  t.after(() => second.dispose())
  await second.client.messageHandler?.(conversationCommand('chat-blank-project', '/help'))
  assert.equal(String(second.ctx.agents.list()[0]?.id), String(blankAgent.id))
  assert.deepEqual(
    second.workspaces[0]?.sessionIds,
    [],
    'help exposed the resumed blank generation to Workspace reuse',
  )

  await second.client.messageHandler?.(conversationCommand(
    'chat-blank-project',
    'first turn after blank restart',
  ))
  await waitFor(() => adapter.requests.length === 1)
  const resumedAgent = second.ctx.agents.get(blankAgent.id)
  assert.ok(resumedAgent !== undefined)
  await resumedAgent.whenIdle()
  await waitFor(() => (
    second.workspaces[0]?.sessionIds.some((id) => id === blankAgent.id) === true
  ))
  assert.equal(second.workspaces[0]?.sessionIds[0], blankAgent.id)
  await second.dispose()
})
