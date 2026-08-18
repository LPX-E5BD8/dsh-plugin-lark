import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import CodeRuntime from '@deepseek-ai/dsh-code-runtime'
import type { CodeRunRequest, CodeRunResult } from '@deepseek-ai/dsh-code-runtime'
import LlmRuntime, { CallId, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine from '@deepseek-ai/dsh-session-query-sqlite'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import * as AskUserQuestionTool from '@deepseek-ai/dsh-tool-ask-user'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { LarkBridge } from '../src/bridge.ts'
import { inject as larkInject } from '../src/index.ts'
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

function askUserToolResponse(questions: readonly unknown[], id = 'ask-user-call'): StreamChunk[] {
  const callId = CallId(id)
  const args = JSON.stringify({ questions })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'ask_user_question', argumentsDelta: args },
    {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: callId, name: 'ask_user_question', arguments: args },
    },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function runCodeResponse(id = 'run-code-call'): StreamChunk[] {
  const callId = CallId(id)
  const args = JSON.stringify({
    code: 'return await tools.ask_user_question({ questions: [] })',
    description: 'Ask for a nested choice',
  })
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name: 'run_code', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'run_code', arguments: args } },
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

class NestedAskCodeRuntime extends CodeRuntime {
  readonly language = 'typescript'
  readonly isolation = 'worker-thread'

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    const ask = request.bindings
      .find(({ global }) => global === 'tools')
      ?.functions.ask_user_question
    if (ask === undefined) {
      return { logs: [], error: { kind: 'exception', message: 'ask tool is unavailable' } }
    }
    try {
      const value = await ask({
        questions: [{
          id: 'nested',
          question: 'Choose inside Code Mode.',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      })
      return { logs: [], value }
    } catch (error) {
      return {
        logs: [],
        error: {
          kind: 'exception',
          message: error instanceof Error ? error.message : 'nested ask failed',
        },
      }
    }
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

function isHumanInputCard(card: unknown): boolean {
  const payload = card as { body?: { elements?: Array<{ tag?: string; name?: string }> } }
  return payload.body?.elements?.some((element) => (
    element.tag === 'form' && element.name === 'human_input_form'
  )) === true
}

function humanInputCancelRequestId(card: unknown): string {
  const payload = card as {
    body?: {
      elements?: Array<{
        behaviors?: Array<{ value?: { action?: string; request_id?: string } }>
      }>
    }
  }
  return payload.body?.elements
    ?.flatMap((element) => element.behaviors ?? [])
    .find((behavior) => behavior.value?.action === 'human_input_cancel')
    ?.value?.request_id ?? ''
}

function stopRequestId(card: unknown): string {
  const payload = card as {
    body?: {
      elements?: Array<{
        element_id?: string
        columns?: Array<{
          elements?: Array<{
            behaviors?: Array<{ value?: { request_id?: string } }>
          }>
        }>
      }>
    }
  }
  const actions = payload.body?.elements?.find((element) => element.element_id === 'turn_stop')
  return actions?.columns?.[0]?.elements?.[0]?.behaviors?.[0]?.value?.request_id ?? ''
}

interface HarnessPreset {
  readonly defaultId: string
  readonly mounted: string[]
  readonly withEchoTool?: boolean
  readonly denyAskUser?: boolean
  readonly toolMode?: 'code' | 'both'
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

async function cleanupRootOwnedHarness(
  ctx: Context,
  deduplicator: DurableInboundDeduplicator | undefined,
  conversationBindings: DurableConversationBindingStore | undefined,
): Promise<unknown[]> {
  const failures: unknown[] = []
  try {
    await ctx.fiber.dispose()
  } catch (error) {
    failures.push(error)
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
  return failures
}

async function mount(
  root: string,
  adapter?: LlmAdapter,
  locale?: LarkLocale,
  preset?: HarnessPreset,
  maxConversationHandles?: number,
  workspaceSpecs?: readonly HarnessWorkspaceSpec[],
  realWorkspaceCwd?: string,
  sessionCompression: 'none' | 'zstd' = 'none',
  humanInputTimeoutMs?: number,
  humanInputCardCloseTimeoutMs?: number,
  rootOwnedCleanup = false,
  inboundTextFiles = false,
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
    await ctx.plugin(SessionTitleService, {
      fallbackMaxWords: 6,
      fallbackMaxBytes: 120,
      maxTitleBytes: 120,
    })
    await ctx.plugin(SystemPrompt)
    if (preset?.toolMode !== undefined) await ctx.plugin(NestedAskCodeRuntime)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AskUserQuestionTool)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root, compression: sessionCompression })
    await ctx.plugin(SessionCheckpointPolicy)
    await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'never' })
    await ctx.plugin(ApprovalService)
    if (realWorkspaceCwd !== undefined) await ctx.plugin(WorkspaceRegistry)
    if (preset !== undefined) {
      ctx.provide('agentPresets', {
        resolve(id?: string) {
          return Promise.resolve({ id: id ?? preset.defaultId })
        },
        async mount(agentCtx: Context, id?: string) {
          const resolved = id ?? preset.defaultId
          preset.mounted.push(resolved)
          if (preset.withEchoTool === true) agentCtx.tools.register(echoTool())
          if (preset.denyAskUser === true) agentCtx.tools.restrict({ deny: ['ask_user_question'] })
          if (preset.toolMode !== undefined) agentCtx.tools.presentAs(preset.toolMode)
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
    const bridgeReady = Promise.withResolvers<LarkBridge>()
    ctx.plugin({
      name: 'lark-harness-owner',
      inject: larkInject,
      async apply(ownerCtx) {
        const candidate = new LarkBridge(ownerCtx, {
          client,
          inboundDeduplicator: deduplicator,
          conversationBindings,
          locale,
          allowFrom: ['owner'],
          projectManageFrom: realWorkspaceCwd === undefined ? [] : ['owner'],
          provider: adapter === undefined ? undefined : 'mock',
          model: adapter === undefined ? undefined : 'mock',
          maxConversationHandles,
          humanInputTimeoutMs,
          humanInputCardCloseTimeoutMs,
          inboundTextFiles,
          cwd: realWorkspaceCwd,
        })
        bridge = candidate
        try {
          await candidate.start()
          bridgeReady.resolve(candidate)
        } catch (error) {
          bridgeReady.reject(error)
          throw error
        }
        if (rootOwnedCleanup) return () => candidate.stop()
      },
    })
    bridge = await bridgeReady.promise
    let disposal: Promise<void> | undefined
    return {
      ctx,
      bridge,
      client,
      workspaces,
      dispose() {
        disposal ??= (async () => {
          const failures = rootOwnedCleanup
            ? await cleanupRootOwnedHarness(ctx, deduplicator, conversationBindings)
            : await cleanupHarness(ctx, bridge, deduplicator, conversationBindings)
          if (failures.length > 0) {
            throw new AggregateError(failures, 'harness e2e cleanup failed')
          }
        })()
        return disposal
      },
    }
  } catch (error) {
    const failures = rootOwnedCleanup
      ? await cleanupRootOwnedHarness(ctx, deduplicator, conversationBindings)
      : await cleanupHarness(ctx, bridge, deduplicator, conversationBindings)
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], 'harness e2e mount and cleanup failed')
    }
    throw error
  }
}

test('harness e2e: an admitted text attachment reaches the model, persistence, and cold resume', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-text-attachment-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const firstAdapter = new ScriptedAdapter([textResponse('attachment received')])
  const first = await mount(
    root,
    firstAdapter,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    'none',
    undefined,
    undefined,
    false,
    true,
  )
  first.client.downloadMessageResource = async () => ({
    data: new TextEncoder().encode('durable attachment marker'),
    mediaType: 'text/plain; charset=utf-8',
  })
  await first.client.messageHandler?.({
    chatId: 'chat-a',
    chatType: 'p2p',
    openId: 'owner',
    text: '',
    messageId: 'harness-file-message',
    messageType: 'file',
    mentioned: false,
    resource: { kind: 'file', key: 'opaque-resource-key', name: 'evidence.txt' },
  })
  await waitFor(() => firstAdapter.requests.length === 1)
  const firstAgent = first.ctx.agents.list()[0]
  assert.ok(firstAgent !== undefined)
  await firstAgent.whenIdle()
  assert.equal(await first.ctx.sessions.flush(firstAgent.session), true)
  const firstRequest = JSON.stringify(firstAdapter.requests[0]?.messages)
  assert.match(firstRequest, /durable attachment marker/u)
  assert.match(firstRequest, /untrusted-user-data/u)
  assert.doesNotMatch(firstRequest, /opaque-resource-key|harness-file-message/u)
  const persisted = JSON.stringify(
    (await first.ctx.sessionPersistence.inspect(firstAgent.id)).events,
  )
  assert.match(persisted, /durable attachment marker/u)
  assert.match(persisted, /evidence\.txt/u)
  assert.doesNotMatch(persisted, /opaque-resource-key|harness-file-message/u)
  await first.dispose()

  const resumedAdapter = new ScriptedAdapter([textResponse('resumed')])
  const resumed = await mount(root, resumedAdapter)
  t.after(() => resumed.dispose())
  await resumed.client.messageHandler?.(conversationCommand('chat-a', 'continue after attachment'))
  await waitFor(() => resumedAdapter.requests.length === 1)
  const resumedRequest = JSON.stringify(resumedAdapter.requests[0]?.messages)
  assert.match(resumedRequest, /durable attachment marker/u)
  assert.match(resumedRequest, /continue after attachment/u)
  assert.doesNotMatch(resumedRequest, /opaque-resource-key|harness-file-message/u)
})

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

test('harness e2e: /model snapshots the same durable session and survives reset and restart', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-model-switch-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const firstAdapter = new ScriptedAdapter([
    textResponse('dynamic answer'),
    textResponse('reset answer'),
  ])
  const first = await mount(root, firstAdapter)
  await first.client.messageHandler?.(command('/model mock dynamic-v2'))
  assert.match(first.client.sent.at(-1) ?? '', /dynamic-v2/u)
  assert.equal(first.ctx.agents.list().length, 1)
  const selectedAgent = first.ctx.agents.list()[0]
  assert.equal(selectedAgent?.options.model, 'mock')

  await first.client.messageHandler?.(conversationCommand('chat-a', 'first dynamic prompt'))
  await waitFor(() => firstAdapter.requests.length === 1)
  assert.equal(firstAdapter.requests[0]?.provider, 'mock')
  assert.equal(firstAdapter.requests[0]?.model, 'dynamic-v2')
  assert.equal(first.ctx.agents.list()[0], selectedAgent)
  const originalSessionId = first.ctx.agents.list()[0]?.id
  assert.equal(String(originalSessionId), 'lark:chat-a')
  assert.equal(first.ctx.agents.list()[0]?.session.requestHeader()?.config.model, 'dynamic-v2')
  await first.ctx.agents.list()[0]?.whenIdle()

  await first.client.messageHandler?.(conversationCommand('chat-a', '/new'))
  const resetSessionId = first.ctx.agents.list()[0]?.id
  assert.ok(resetSessionId !== undefined)
  assert.notEqual(resetSessionId, originalSessionId)
  await first.client.messageHandler?.(conversationCommand('chat-a', 'reset dynamic prompt'))
  await waitFor(() => firstAdapter.requests.length === 2)
  assert.equal(firstAdapter.requests[1]?.model, 'dynamic-v2')
  await first.ctx.agents.list()[0]?.whenIdle()
  await first.dispose()

  const secondAdapter = new ScriptedAdapter([textResponse('resumed answer')])
  const second = await mount(root, secondAdapter)
  await second.client.messageHandler?.(conversationCommand('chat-a', 'resumed dynamic prompt'))
  await waitFor(() => secondAdapter.requests.length === 1)
  assert.equal(secondAdapter.requests[0]?.provider, 'mock')
  assert.equal(secondAdapter.requests[0]?.model, 'dynamic-v2')
  assert.equal(second.ctx.agents.list()[0]?.id, resetSessionId)
  await second.dispose()
})

test('harness e2e: /project carries the selected model into the blank generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-model-project-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'selected-project')
  await mkdir(projectPath, { recursive: true })
  const canonicalProjectPath = await realpath(projectPath)
  const adapter = new ScriptedAdapter([textResponse('project model answer')])
  const harness = await mount(
    root,
    adapter,
    undefined,
    undefined,
    undefined,
    [{
      id: '33333333-3333-4333-8333-333333333333',
      title: 'Selected Model Project',
      path: canonicalProjectPath,
    }],
  )
  t.after(() => harness.dispose())

  await harness.client.messageHandler?.(conversationCommand(
    'chat-model-project',
    '/model mock project-selected',
  ))
  const originalAgent = harness.ctx.agents.list()[0]
  assert.ok(originalAgent !== undefined)

  await harness.client.messageHandler?.(conversationCommand(
    'chat-model-project',
    '/project Selected Model Project',
  ))
  const projectAgent = harness.ctx.agents.list().find((agent) => (
    agent.session.header.cwd === canonicalProjectPath
  ))
  assert.ok(projectAgent !== undefined)
  assert.notEqual(projectAgent.id, originalAgent.id)

  await harness.client.messageHandler?.(conversationCommand(
    'chat-model-project',
    'use the selected model in this project',
  ))
  await waitFor(() => adapter.requests.length === 1)
  assert.equal(adapter.requests[0]?.provider, 'mock')
  assert.equal(adapter.requests[0]?.model, 'project-selected')
  assert.equal(projectAgent.session.requestHeader()?.config.model, 'project-selected')
  await projectAgent.whenIdle()
  await harness.dispose()
})

test('harness e2e: the durable Lark selector stays authoritative over a later surface selector', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-model-authority-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([textResponse('selected answer')])
  const harness = await mount(root, adapter)

  await harness.client.messageHandler?.(command('/model mock lark-selected'))
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  const laterSurface = {
    current: { provider: 'mock', model: 'web-selected' },
    assembled: undefined,
  }
  installModelSelection(agent.ctx, laterSurface)

  await harness.client.messageHandler?.(conversationCommand('chat-a', 'use durable selection'))
  await waitFor(() => adapter.requests.length === 1)
  assert.equal(adapter.requests[0]?.model, 'lark-selected')
  await harness.dispose()
})

test('harness e2e: an evicted conversation cold-resumes its selected model', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-model-eviction-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    textResponse('first selected answer'),
    textResponse('other answer'),
    textResponse('resumed selected answer'),
  ])
  const harness = await mount(root, adapter, undefined, undefined, 1)

  await harness.client.messageHandler?.(conversationCommand('chat-selected', '/model mock selected-v2'))
  await harness.client.messageHandler?.(conversationCommand('chat-selected', 'first selected prompt'))
  await waitFor(() => adapter.requests.length === 1)
  await harness.ctx.agents.get(SessionId('lark:chat-selected'))?.whenIdle()

  await harness.client.messageHandler?.(conversationCommand('chat-other', 'other prompt'))
  await waitFor(() => adapter.requests.length === 2)
  await harness.ctx.agents.get(SessionId('lark:chat-other'))?.whenIdle()
  await waitFor(() => harness.ctx.agents.get(SessionId('lark:chat-selected')) === undefined)

  await harness.client.messageHandler?.(conversationCommand('chat-selected', 'cold resumed prompt'))
  await waitFor(() => adapter.requests.length === 3)
  assert.deepEqual(adapter.requests.map((request) => request.model), [
    'selected-v2',
    'mock',
    'selected-v2',
  ])
  await harness.dispose()
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

test('harness e2e: structured Lark input resumes its turn and Web input keeps the stock provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const larkQuestions = [
    {
      id: 'mode',
      question: 'Choose a mode.',
      options: [{ label: 'Safe' }, { label: 'Fast' }],
    },
    {
      id: 'features',
      question: 'Choose features.',
      options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
      multi_select: true,
    },
    { id: 'note', question: 'Add a note.' },
  ]
  const adapter = new ScriptedAdapter([
    askUserToolResponse(larkQuestions, 'lark-question'),
    textResponse('continued after Lark answer'),
    askUserToolResponse([{ id: 'web', question: 'Choose in Web.', options: [{ label: 'Web' }, { label: 'Other' }] }], 'web-question'),
    textResponse('continued after Web answer'),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  const providerCalls: unknown[] = []
  const disposeProvider = harness.ctx.userQuestions.registerProvider({
    async ask(request) {
      providerCalls.push(request)
      return {
        answers: request.questions.map((question) => ({
          id: question.id,
          selected: question.options?.[0] === undefined ? [] : [question.options[0].label],
          ...(question.options?.[0] === undefined ? { custom: 'web custom answer' } : {}),
        })),
      }
    },
  })
  t.after(disposeProvider)

  await harness.client.messageHandler?.(command('ask me in Lark'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const wrong = await harness.client.cardHandler?.({
    openId: 'other-user',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o1', q1: ['q1_o0'], c2: 'note' },
  })
  assert.equal(wrong?.toast.type, 'error')
  assert.equal(providerCalls.length, 0)
  const wrongChat = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'other-chat',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o1', q1: ['q1_o0'], c2: 'note' },
  })
  assert.equal(wrongChat?.toast.type, 'error')

  const malformed = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o99', q1: ['q1_o0'], c2: 'note' },
  })
  assert.equal(malformed?.toast.type, 'error')
  const missingForm = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
  })
  assert.equal(missingForm?.toast.type, 'error')
  assert.equal(providerCalls.length, 0)
  await harness.client.messageHandler?.(command('/new'))
  assert.match(harness.client.sent.at(-1) ?? '', /left unchanged|保持不变/u)

  const validAction: LarkCardAction = {
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: {
      q0: 'q0_o1',
      c0: '',
      q1: ['q1_o0', 'q1_o2'],
      c1: 'extra',
      c2: 'note',
    },
  }
  assert.ok(harness.client.cardHandler !== undefined)
  const outcomes = await Promise.all([
    harness.client.cardHandler(validAction),
    harness.client.cardHandler(validAction),
  ])
  const submitted = outcomes.find((outcome) => outcome.toast.type === 'success')
  const duplicate = outcomes.find((outcome) => outcome.toast.type === 'info')
  assert.ok(submitted !== undefined)
  assert.ok(duplicate !== undefined)
  assert.equal(submitted?.toast.type, 'success')
  const immediateCard = JSON.stringify(submitted?.card?.data)
  assert.equal(immediateCard.includes('form'), false)
  assert.equal(immediateCard.includes('note'), false)
  assert.equal(duplicate?.toast.type, 'info')

  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()
  await waitFor(() => harness.client.updated.some(({ messageId, card }) => (
    messageId === questionCard.messageId
      && !JSON.stringify(card).includes('form')
      && JSON.stringify(card).includes('Answer received')
  )))
  assert.equal(providerCalls.length, 0)
  const larkFollowupHistory = JSON.stringify(adapter.requests[1]?.messages)
  assert.match(larkFollowupHistory, /Fast/u)
  assert.equal(larkFollowupHistory.includes('[\\"A\\",\\"C\\"]'), true)
  assert.match(larkFollowupHistory, /extra/u)
  assert.match(larkFollowupHistory, /note/u)
  const humanCardsBeforeWeb = harness.client.cards.filter((entry) => isHumanInputCard(entry.card)).length

  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'ask me in Web' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()
  assert.equal(providerCalls.length, 1)
  assert.equal(harness.client.cards.filter((entry) => isHumanInputCard(entry.card)).length, humanCardsBeforeWeb)
  assert.match(JSON.stringify(adapter.requests[3]?.messages), /Web/u)
})

test('harness e2e: an external direct tool dispatch cannot steal an active Lark question', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-external-dispatch-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const questions = [{
    id: 'choice',
    question: 'Choose in Lark.',
    options: [{ label: 'A' }, { label: 'B' }],
  }]
  const adapter = new ScriptedAdapter([
    askUserToolResponse(questions, 'shared-call-id'),
    textResponse('continued after Lark answer'),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  let providerCalls = 0
  const disposeProvider = harness.ctx.userQuestions.registerProvider({
    async ask(request) {
      providerCalls += 1
      return {
        answers: request.questions.map(({ id }) => ({ id, selected: ['A'] })),
      }
    },
  })
  t.after(disposeProvider)

  await harness.client.messageHandler?.(command('ask in Lark'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  const agent = harness.ctx.agents.list()[0]
  assert.ok(questionCard !== undefined)
  assert.ok(agent !== undefined)
  const humanCards = harness.client.cards.filter((entry) => isHumanInputCard(entry.card)).length

  const external = await harness.ctx.tools.execute({
    callId: CallId('shared-call-id'),
    name: 'ask_user_question',
    arguments: { questions },
    agent,
    signal: new AbortController().signal,
  })
  assert.equal(external.isError, false)
  assert.equal(providerCalls, 1)
  assert.equal(harness.client.cards.filter((entry) => isHumanInputCard(entry.card)).length, humanCards)

  const submitted = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o1' },
  })
  assert.equal(submitted?.toast.type, 'success')
  await agent.whenIdle()
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /B/u)
})

test('harness e2e: a preset restriction keeps ask_user_question hidden from the Lark interceptor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-restricted-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
    textResponse('handled hidden tool'),
  ])
  const harness = await mount(root, adapter, 'en-US', {
    defaultId: 'restricted',
    mounted: [],
    denyAskUser: true,
  })
  t.after(() => harness.dispose())

  await harness.client.messageHandler?.(command('attempt hidden question'))
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()
  assert.equal(harness.client.cards.some((entry) => isHumanInputCard(entry.card)), false)
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /UNKNOWN_TOOL|unknown tool/iu)
})

test('harness e2e: a Code Mode nested question fails closed without presenting a Lark Card', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-code-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    runCodeResponse(),
    textResponse('handled unsupported nested question'),
  ])
  const harness = await mount(root, adapter, 'en-US', {
    defaultId: 'code-mode',
    mounted: [],
    toolMode: 'code',
  })
  t.after(() => harness.dispose())

  await harness.client.messageHandler?.(command('ask from Code Mode'))
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()

  assert.equal(harness.client.cards.some((entry) => isHumanInputCard(entry.card)), false)
  assert.equal(adapter.requests.length, 2)
  assert.match(
    JSON.stringify(adapter.requests[1]?.messages),
    /not supported inside run_code|LARK_HUMAN_INPUT_CODE_MODE_UNSUPPORTED/u,
  )
})

test('harness e2e: Both mode keeps a direct Native question interactive', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-both-mode-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{
      id: 'direct',
      question: 'Choose directly.',
      options: [{ label: 'A' }, { label: 'B' }],
    }], 'both-direct-question'),
    textResponse('continued in Both mode'),
  ])
  const harness = await mount(root, adapter, 'en-US', {
    defaultId: 'both-mode',
    mounted: [],
    toolMode: 'both',
  })
  t.after(() => harness.dispose())

  await harness.client.messageHandler?.(command('ask directly in Both mode'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const result = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o0' },
  })
  assert.equal(result?.toast.type, 'success')
  await harness.ctx.agents.list()[0]?.whenIdle()
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /A/u)
})

test('harness e2e: a pending-call durability checkpoint completes before the Lark Card is created', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-checkpoint-order-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{
      id: 'choice',
      question: 'Choose after checkpoint.',
      options: [{ label: 'A' }, { label: 'B' }],
    }]),
    textResponse('continued after durable question'),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  const sessions = harness.ctx.sessions as unknown as {
    flush(session: Parameters<Context['sessions']['flush']>[0]): Promise<boolean>
  }
  const originalFlush = sessions.flush.bind(sessions)
  const checkpointEntered = Promise.withResolvers<void>()
  const releaseCheckpoint = Promise.withResolvers<void>()
  t.after(() => releaseCheckpoint.resolve())
  sessions.flush = async (session) => {
    if (session.events.at(-1)?.type === 'tool/call') {
      checkpointEntered.resolve()
      await releaseCheckpoint.promise
    }
    return originalFlush(session)
  }
  t.after(() => { sessions.flush = originalFlush })

  await harness.client.messageHandler?.(command('ask only after a durable call'))
  await checkpointEntered.promise
  assert.equal(harness.client.cards.some((entry) => isHumanInputCard(entry.card)), false)
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)

  releaseCheckpoint.resolve()
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  assert.equal(
    (await harness.ctx.sessionPersistence.inspect(agent.id)).events.some(({ type }) => type === 'tool/call'),
    true,
  )
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o0' },
  })
  await agent.whenIdle()
})

for (const checkpointFailure of ['false', 'reject'] as const) {
  test(`harness e2e: a ${checkpointFailure} pending-call checkpoint creates no Card or Web fallback`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-lark-human-input-checkpoint-${checkpointFailure}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const adapter = new ScriptedAdapter([
      askUserToolResponse([{
        id: 'choice',
        question: 'This Card must not be sent.',
        options: [{ label: 'A' }, { label: 'B' }],
      }]),
      textResponse('handled checkpoint failure'),
    ])
    const harness = await mount(root, adapter, 'en-US')
    t.after(() => harness.dispose())
    let providerCalls = 0
    const disposeProvider = harness.ctx.userQuestions.registerProvider({
      async ask(request) {
        providerCalls += 1
        return { answers: request.questions.map(({ id }) => ({ id, selected: ['A'] })) }
      },
    })
    t.after(disposeProvider)
    const sessions = harness.ctx.sessions as unknown as {
      flush(session: Parameters<Context['sessions']['flush']>[0]): Promise<boolean>
    }
    const originalFlush = sessions.flush.bind(sessions)
    let rejected = false
    sessions.flush = async (session) => {
      if (session.events.at(-1)?.type !== 'tool/call') return originalFlush(session)
      if (checkpointFailure === 'false') return false
      if (!rejected) {
        rejected = true
        throw new Error('checkpoint unavailable')
      }
      return originalFlush(session)
    }
    t.after(() => { sessions.flush = originalFlush })

    await harness.client.messageHandler?.(command(`ask with ${checkpointFailure} checkpoint`))
    const agent = harness.ctx.agents.list()[0]
    assert.ok(agent !== undefined)
    await agent.whenIdle()

    assert.equal(harness.client.cards.some((entry) => isHumanInputCard(entry.card)), false)
    assert.equal(providerCalls, 0)
    assert.equal(adapter.requests.length, 2)
    assert.match(JSON.stringify(adapter.requests[1]?.messages), /checkpoint|durab|error/iu)
  })
}

test('harness e2e: cancelling a structured question closes the Card and returns a tool error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-user-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
    textResponse('handled cancellation'),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  const postFailureCodes: string[] = []
  const disposePost = harness.ctx.on('tools/post-execute', (exec, result, next) => {
    if (exec.name === 'ask_user_question' && result.isError) {
      postFailureCodes.push(result.error.info?.code ?? '')
    }
    return next()
  })
  t.after(disposePost)

  await harness.client.messageHandler?.(command('ask then cancel'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const requestId = humanInputCancelRequestId(questionCard.card)
  assert.ok(requestId !== '')
  const cancelled = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: { action: 'human_input_cancel', request_id: requestId },
    tag: 'button',
    name: '',
    formValue: {},
  })
  assert.equal(cancelled?.toast.type, 'success')
  assert.match(JSON.stringify(cancelled?.card?.data), /cancelled/u)
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /cancelled/u)
  assert.deepEqual(postFailureCodes, ['LARK_HUMAN_INPUT_CANCELLED'])
  assert.match(JSON.stringify(harness.client.updated), /handled cancellation/u)
})

test('harness e2e: a blocked reset reply cannot delay an authorized human answer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-reset-answer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{
      id: 'choice',
      question: 'Choose while reset is blocked.',
      options: [{ label: 'A' }, { label: 'B' }],
    }]),
    textResponse('continued after blocked reset'),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  await harness.client.messageHandler?.(command('ask before blocked reset'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)

  const deliveryEntered = Promise.withResolvers<void>()
  const releaseDelivery = Promise.withResolvers<void>()
  const originalSendText = harness.client.sendText.bind(harness.client)
  harness.client.sendText = async (chatId, text, options) => {
    if (/left unchanged/u.test(text)) {
      deliveryEntered.resolve()
      await releaseDelivery.promise
    }
    return originalSendText(chatId, text, options)
  }
  const resetting = harness.client.messageHandler?.(command('/new'))
  await deliveryEntered.promise

  const result = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o1' },
  })
  assert.equal(result?.toast.type, 'success')
  releaseDelivery.resolve()
  await resetting
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /B/u)
})

test('harness e2e: Stop cancels a pending question even when a reset reply holds the conversation barrier', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-reset-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{
      id: 'choice',
      question: 'Choose unless stopped.',
      options: [{ label: 'A' }, { label: 'B' }],
    }]),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  await harness.client.messageHandler?.(command('ask before blocked stop'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  const executionCard = harness.client.cards.find((entry) => stopRequestId(entry.card) !== '')
  assert.ok(questionCard !== undefined)
  assert.ok(executionCard !== undefined)
  const requestId = stopRequestId(executionCard.card)

  const deliveryEntered = Promise.withResolvers<void>()
  const releaseDelivery = Promise.withResolvers<void>()
  const originalSendText = harness.client.sendText.bind(harness.client)
  harness.client.sendText = async (chatId, text, options) => {
    if (/left unchanged/u.test(text)) {
      deliveryEntered.resolve()
      await releaseDelivery.promise
    }
    return originalSendText(chatId, text, options)
  }
  const resetting = harness.client.messageHandler?.(command('/new'))
  await deliveryEntered.promise

  const stopped = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: executionCard.messageId,
    value: { action: 'turn_stop', request_id: requestId },
    tag: 'button',
    name: '',
    formValue: {},
  })
  assert.equal(stopped?.toast.type, 'success')
  const staleAnswer = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o0' },
  })
  assert.equal(staleAnswer?.toast.type, 'info')

  releaseDelivery.resolve()
  await resetting
  await harness.ctx.agents.list()[0]?.whenIdle()
  await waitFor(() => harness.client.updated.some(({ messageId, card }) => (
    messageId === questionCard.messageId && JSON.stringify(card).includes('cancelled')
  )))
})

test('harness e2e: an answer accepted before Stop settles once and the turn remains cancellable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-answer-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{
      id: 'choice',
      question: 'Choose before stopping.',
      options: [{ label: 'A' }, { label: 'B' }],
    }]),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  const postEntered = Promise.withResolvers<void>()
  const releasePost = Promise.withResolvers<void>()
  const disposePost = harness.ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name === 'ask_user_question') {
      postEntered.resolve()
      await releasePost.promise
    }
    return next()
  })
  t.after(disposePost)

  await harness.client.messageHandler?.(command('answer then stop'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  const executionCard = harness.client.cards.find((entry) => stopRequestId(entry.card) !== '')
  assert.ok(questionCard !== undefined)
  assert.ok(executionCard !== undefined)
  const answered = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o0' },
  })
  assert.equal(answered?.toast.type, 'success')
  await postEntered.promise

  const stopped = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: executionCard.messageId,
    value: { action: 'turn_stop', request_id: stopRequestId(executionCard.card) },
    tag: 'button',
    name: '',
    formValue: {},
  })
  assert.equal(stopped?.toast.type, 'success')
  releasePost.resolve()
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()

  const toolResult = agent.session.events.findLast(({ type }) => type === 'tool/result')
  assert.match(JSON.stringify(toolResult), /ABORTED/u)
  const duplicate = await harness.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o0' },
  })
  assert.equal(duplicate?.toast.type, 'info')
})

test('harness e2e: a cold crash after answer acceptance repairs the call and expires the old Card', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-crash-source-'))
  const snapshotParent = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-crash-copy-'))
  const snapshot = join(snapshotParent, 'snapshot')
  t.after(() => rm(root, { recursive: true, force: true }))
  t.after(() => rm(snapshotParent, { recursive: true, force: true }))
  const firstAdapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'text', question: 'Enter a disposable recovery marker.' }]),
    textResponse('source process continued'),
  ])
  const first = await mount(root, firstAdapter, 'en-US')
  const postEntered = Promise.withResolvers<void>()
  const releasePost = Promise.withResolvers<void>()
  const disposePost = first.ctx.on('tools/post-execute', async (exec, _result, next) => {
    if (exec.name === 'ask_user_question') {
      postEntered.resolve()
      await releasePost.promise
    }
    return next()
  })
  t.after(disposePost)
  t.after(async () => {
    releasePost.resolve()
    await first.dispose()
  })

  await first.client.messageHandler?.(command('ask before simulated crash'))
  await waitFor(() => first.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = first.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const accepted = await first.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { c0: 'ephemeral-answer-marker' },
  })
  assert.equal(accepted?.toast.type, 'success')
  await postEntered.promise

  await cp(root, snapshot, { recursive: true, force: false, errorOnExist: true })
  const coldAdapter = new ScriptedAdapter([textResponse('cold recovery continued')])
  const cold = await mount(snapshot, coldAdapter, 'en-US')
  t.after(() => cold.dispose())
  await cold.client.messageHandler?.(command('/help'))
  const coldAgent = cold.ctx.agents.list()[0]
  assert.ok(coldAgent !== undefined)
  const repaired = JSON.stringify(coldAgent.session.events)
  assert.match(repaired, /TOOL_OUTCOME_UNKNOWN|ToolOutcomeUnknownError/u)
  assert.doesNotMatch(repaired, /ephemeral-answer-marker/u)

  const stale = await cold.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { c0: 'ephemeral-answer-marker' },
  })
  assert.equal(stale?.toast.type, 'info')
  await cold.client.messageHandler?.(conversationCommand('chat-a', 'continue after cold recovery'))
  await coldAgent.whenIdle()
  assert.equal(coldAdapter.requests.length, 1)
  assert.match(JSON.stringify(cold.client.updated), /cold recovery continued/u)

  releasePost.resolve()
  await first.ctx.agents.list()[0]?.whenIdle()
})

test('harness e2e: cancelling while a human-input Card create is pending closes the late Card', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-cancel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  const cardSending = Promise.withResolvers<void>()
  const releaseCard = Promise.withResolvers<void>()
  const originalSendCard = harness.client.sendCard?.bind(harness.client)
  assert.ok(originalSendCard !== undefined)
  harness.client.sendCard = async (chatId, card, options) => {
    if (!isHumanInputCard(card)) return originalSendCard(chatId, card, options)
    cardSending.resolve()
    await releaseCard.promise
    return 'late-human-input-card'
  }

  await harness.client.messageHandler?.(command('ask and cancel'))
  await cardSending.promise
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  let idle = false
  const idling = agent.whenIdle().then(() => { idle = true })
  await Promise.resolve()
  assert.equal(idle, false)
  releaseCard.resolve()
  await idling
  await waitFor(() => harness.client.updated.some(({ messageId }) => messageId === 'late-human-input-card'))
  const closed = harness.client.updated.findLast(({ messageId }) => messageId === 'late-human-input-card')?.card
  assert.match(JSON.stringify(closed), /cancelled/u)
  assert.equal(adapter.requests.length, 1)
})

test('harness e2e: a human-input timeout closes the Card and resumes the same turn with an error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'text', question: 'Enter text.' }]),
    textResponse('handled timeout'),
  ])
  const harness = await mount(
    root,
    adapter,
    'en-US',
    undefined,
    undefined,
    undefined,
    undefined,
    'none',
    20,
  )
  t.after(() => harness.dispose())
  const postFailureCodes: string[] = []
  const disposePost = harness.ctx.on('tools/post-execute', (exec, result, next) => {
    if (exec.name === 'ask_user_question' && result.isError) {
      postFailureCodes.push(result.error.info?.code ?? '')
    }
    return next()
  })
  t.after(disposePost)

  await harness.client.messageHandler?.(command('ask and time out'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()
  await waitFor(() => harness.client.updated.some(({ messageId, card }) => (
    messageId === questionCard.messageId && JSON.stringify(card).includes('timed out')
  )))
  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /timed out/u)
  assert.deepEqual(postFailureCodes, ['LARK_HUMAN_INPUT_TIMEOUT'])
  assert.match(JSON.stringify(harness.client.updated), /handled timeout/u)
})

for (const closeOutcome of ['answered', 'cancelled', 'timed-out'] as const) {
  test(`harness e2e: a synchronous terminal patch failure cannot change the ${closeOutcome} settlement`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), `dsh-lark-human-input-sync-patch-${closeOutcome}-`))
    t.after(() => rm(root, { recursive: true, force: true }))
    const adapter = new ScriptedAdapter([
      askUserToolResponse([{
        id: 'choice',
        question: 'Choose or wait.',
        options: [{ label: 'A' }, { label: 'B' }],
      }]),
      textResponse(`handled ${closeOutcome}`),
    ])
    const harness = await mount(
      root,
      adapter,
      'en-US',
      undefined,
      undefined,
      undefined,
      undefined,
      'none',
      closeOutcome === 'timed-out' ? 30 : undefined,
    )
    t.after(() => harness.dispose())
    await harness.client.messageHandler?.(command(`ask for sync patch ${closeOutcome}`))
    await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
    const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
    assert.ok(questionCard !== undefined)
    const originalUpdateCard = harness.client.updateCard?.bind(harness.client)
    assert.ok(originalUpdateCard !== undefined)
    harness.client.updateCard = (messageId, card, options) => {
      if (messageId === questionCard.messageId) throw new Error('synchronous patch failure')
      return originalUpdateCard(messageId, card, options)
    }

    let actionResult: LarkCardActionResult | undefined
    if (closeOutcome === 'answered') {
      actionResult = await harness.client.cardHandler?.({
        openId: 'owner',
        chatId: 'chat-a',
        messageId: questionCard.messageId,
        value: {},
        tag: 'button',
        name: 'human_input_submit',
        formValue: { q0: 'q0_o0' },
      })
    } else if (closeOutcome === 'cancelled') {
      actionResult = await harness.client.cardHandler?.({
        openId: 'owner',
        chatId: 'chat-a',
        messageId: questionCard.messageId,
        value: {
          action: 'human_input_cancel',
          request_id: humanInputCancelRequestId(questionCard.card),
        },
        tag: 'button',
        name: '',
        formValue: {},
      })
    }
    if (actionResult !== undefined) assert.equal(actionResult.toast.type, 'success')
    const agent = harness.ctx.agents.list()[0]
    assert.ok(agent !== undefined)
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 2)
    assert.match(
      JSON.stringify(adapter.requests[1]?.messages),
      closeOutcome === 'answered' ? /A/u : closeOutcome === 'cancelled' ? /cancelled/u : /timed out/u,
    )
  })
}

test('harness e2e: Lark question delivery failure never leaks into the Web provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-delivery-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'text', question: 'Enter text.' }]),
    textResponse('handled delivery failure'),
  ])
  const harness = await mount(root, adapter, 'en-US')
  t.after(() => harness.dispose())
  let providerCalls = 0
  const disposeProvider = harness.ctx.userQuestions.registerProvider({
    async ask(request) {
      providerCalls += 1
      return { answers: request.questions.map(({ id }) => ({ id, selected: [], custom: 'web' })) }
    },
  })
  t.after(disposeProvider)
  const originalSendCard = harness.client.sendCard?.bind(harness.client)
  assert.ok(originalSendCard !== undefined)
  harness.client.sendCard = async (chatId, card, options) => {
    if (isHumanInputCard(card)) throw new Error('question delivery unavailable')
    return originalSendCard(chatId, card, options)
  }

  await harness.client.messageHandler?.(command('ask with failed delivery'))
  const agent = harness.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  await agent.whenIdle()

  assert.equal(providerCalls, 0)
  assert.equal(adapter.requests.length, 2)
  assert.match(JSON.stringify(adapter.requests[1]?.messages), /unavailable in this Lark conversation/u)
  assert.match(JSON.stringify(harness.client.updated), /handled delivery failure/u)
})

test('harness e2e: bridge shutdown drains a pending human-input Card create', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-stop-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
  ])
  const harness = await mount(root, adapter, 'en-US')
  const cardSending = Promise.withResolvers<void>()
  const releaseCard = Promise.withResolvers<void>()
  const originalSendCard = harness.client.sendCard?.bind(harness.client)
  const originalUpdateCard = harness.client.updateCard?.bind(harness.client)
  assert.ok(originalSendCard !== undefined)
  assert.ok(originalUpdateCard !== undefined)
  let terminalSignal: AbortSignal | undefined
  harness.client.sendCard = async (chatId, card, options) => {
    if (!isHumanInputCard(card)) return originalSendCard(chatId, card, options)
    cardSending.resolve()
    await releaseCard.promise
    return 'shutdown-human-input-card'
  }
  harness.client.updateCard = async (messageId, card, options) => {
    if (messageId === 'shutdown-human-input-card') {
      terminalSignal = options?.signal
      assert.ok(terminalSignal !== undefined)
      terminalSignal.throwIfAborted()
    }
    return originalUpdateCard(messageId, card, options)
  }

  await harness.client.messageHandler?.(command('ask during shutdown'))
  await cardSending.promise
  let stopped = false
  const stopping = harness.dispose().then(() => { stopped = true })
  await Promise.resolve()
  assert.equal(stopped, false)
  releaseCard.resolve()
  await stopping
  assert.equal(harness.client.stopped, true)
  assert.equal(terminalSignal?.aborted, false)
  assert.ok(harness.client.updated.some(({ messageId }) => messageId === 'shutdown-human-input-card'))
})

test('harness e2e: shutdown bounds and drains a terminal Card patch that never settles itself', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-stop-patch-timeout-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
  ])
  const harness = await mount(
    root,
    adapter,
    'en-US',
    undefined,
    undefined,
    undefined,
    undefined,
    'none',
    undefined,
    20,
  )
  await harness.client.messageHandler?.(command('ask during bounded shutdown'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const originalUpdateCard = harness.client.updateCard?.bind(harness.client)
  assert.ok(originalUpdateCard !== undefined)
  let terminalSignal: AbortSignal | undefined
  harness.client.updateCard = (messageId, card, options) => {
    if (messageId !== questionCard.messageId) return originalUpdateCard(messageId, card, options)
    terminalSignal = options?.signal
    return new Promise((_resolve, reject) => {
      if (terminalSignal?.aborted === true) {
        reject(terminalSignal.reason)
        return
      }
      terminalSignal?.addEventListener('abort', () => reject(terminalSignal?.reason), { once: true })
    })
  }

  await harness.dispose()
  assert.equal(terminalSignal?.aborted, true)
  assert.equal(harness.client.stopped, true)
})

test('harness e2e: root-fiber disposal registers and drains the terminal Card before stopping REST', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-root-dispose-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
  ])
  const harness = await mount(
    root,
    adapter,
    'en-US',
    undefined,
    undefined,
    undefined,
    undefined,
    'none',
    undefined,
    undefined,
    true,
  )
  await harness.client.messageHandler?.(command('ask during root disposal'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const patchEntered = Promise.withResolvers<void>()
  const releasePatch = Promise.withResolvers<void>()
  const originalUpdateCard = harness.client.updateCard?.bind(harness.client)
  assert.ok(originalUpdateCard !== undefined)
  harness.client.updateCard = async (messageId, card, options) => {
    if (messageId === questionCard.messageId) {
      options?.signal?.throwIfAborted()
      patchEntered.resolve()
      await releasePatch.promise
    }
    return originalUpdateCard(messageId, card, options)
  }

  let disposed = false
  const disposing = harness.dispose().then(() => { disposed = true })
  await patchEntered.promise
  assert.equal(disposed, false)
  assert.equal(harness.client.stopped, false)
  releasePatch.resolve()
  await disposing

  assert.equal(harness.client.stopped, true)
  const terminal = harness.client.updated.findLast(({ messageId }) => messageId === questionCard.messageId)?.card
  assert.match(JSON.stringify(terminal), /cancelled/u)
})

test('harness e2e: root-fiber disposal shortens a stalled Card close below the host grace budget', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-root-deadline-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const adapter = new ScriptedAdapter([
    askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
  ])
  const harness = await mount(
    root,
    adapter,
    'en-US',
    undefined,
    undefined,
    undefined,
    undefined,
    'none',
    undefined,
    undefined,
    true,
  )
  await harness.client.messageHandler?.(command('ask during bounded root disposal'))
  await waitFor(() => harness.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = harness.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  const originalUpdateCard = harness.client.updateCard?.bind(harness.client)
  assert.ok(originalUpdateCard !== undefined)
  let closeSignal: AbortSignal | undefined
  harness.client.updateCard = (messageId, card, options) => {
    if (messageId !== questionCard.messageId) return originalUpdateCard(messageId, card, options)
    closeSignal = options?.signal
    return new Promise((_resolve, reject) => {
      if (closeSignal?.aborted === true) {
        reject(closeSignal.reason)
        return
      }
      closeSignal?.addEventListener('abort', () => reject(closeSignal?.reason), { once: true })
    })
  }

  const startedAt = Date.now()
  await harness.dispose()
  const elapsed = Date.now() - startedAt

  assert.equal(closeSignal?.aborted, true)
  assert.ok(elapsed >= 1_500, `shutdown deadline fired too early: ${elapsed}ms`)
  assert.ok(elapsed < 4_000, `shutdown exceeded the host grace budget: ${elapsed}ms`)
  assert.equal(harness.client.stopped, true)
})

test('harness e2e: a root-disposed pending question cold-repairs and the Session continues', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-human-input-root-repair-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const first = await mount(
    root,
    new ScriptedAdapter([
      askUserToolResponse([{ id: 'choice', question: 'Choose.', options: [{ label: 'A' }, { label: 'B' }] }]),
    ]),
    'en-US',
    undefined,
    undefined,
    undefined,
    undefined,
    'none',
    undefined,
    undefined,
    true,
  )
  await first.client.messageHandler?.(command('ask before root repair'))
  await waitFor(() => first.client.cards.some((entry) => isHumanInputCard(entry.card)))
  const questionCard = first.client.cards.find((entry) => isHumanInputCard(entry.card))
  assert.ok(questionCard !== undefined)
  await first.dispose()
  const terminal = first.client.updated.findLast(({ messageId }) => messageId === questionCard.messageId)?.card
  assert.match(JSON.stringify(terminal), /cancelled/u)

  const adapter = new ScriptedAdapter([textResponse('continued after root repair')])
  const second = await mount(root, adapter, 'en-US')
  t.after(() => second.dispose())
  await second.client.messageHandler?.(command('/help'))
  const agent = second.ctx.agents.list()[0]
  assert.ok(agent !== undefined)
  const repaired = JSON.stringify(agent.session.events)
  assert.match(repaired, /TOOL_OUTCOME_UNKNOWN|LARK_HUMAN_INPUT_CANCELLED/u)
  const stale = await second.client.cardHandler?.({
    openId: 'owner',
    chatId: 'chat-a',
    messageId: questionCard.messageId,
    value: {},
    tag: 'button',
    name: 'human_input_submit',
    formValue: { q0: 'q0_o0' },
  })
  assert.equal(stale?.toast.type, 'info')

  await second.client.messageHandler?.(conversationCommand('chat-a', 'continue after root repair'))
  await agent.whenIdle()
  assert.equal(adapter.requests.length, 1)
  assert.match(JSON.stringify(second.client.updated), /continued after root repair/u)
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

  const first = await mount(
    root,
    new ScriptedAdapter([]),
    undefined,
    undefined,
    undefined,
    workspaceSpecs,
  )
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

test('harness e2e: the real Workspace registry persists registration and removes no files or transcript', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-real-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  const nestedPath = join(projectPath, 'nested')
  await mkdir(nestedPath, { recursive: true })
  const canonicalPath = await realpath(projectPath)
  const nonCanonicalPath = `${nestedPath}${sep}..`
  assert.notEqual(nonCanonicalPath, canonicalPath)
  assert.equal(await realpath(nonCanonicalPath), canonicalPath)
  const markerPath = join(projectPath, 'marker.txt')
  await writeFile(markerPath, 'registration removal must not delete this file')

  const firstAdapter = new ScriptedAdapter([
    textResponse('durable transcript answer'),
    textResponse('attached transcript answer'),
  ])
  const first = await mount(
    root,
    firstAdapter,
    undefined,
    undefined,
    undefined,
    undefined,
    nonCanonicalPath,
  )
  t.after(() => first.dispose())
  await first.client.messageHandler?.(conversationCommand(
    'chat-real-workspace',
    'durable transcript marker',
  ))
  await waitFor(() => firstAdapter.requests.length === 1)
  const session = first.ctx.agents.list()[0]
  assert.ok(session !== undefined)
  await session.whenIdle()
  assert.equal(await first.ctx.sessions.flush(session.session), true)

  await first.client.messageHandler?.(conversationCommand(
    'chat-real-workspace',
    '/project register Real Workspace',
  ))
  const registered = first.ctx.workspaceRegistry.list()[0]
  assert.ok(registered !== undefined)
  const firstId = String(registered.id)
  assert.equal(registered.path, canonicalPath)
  assert.equal(registered.title, 'Real Workspace')
  assert.deepEqual(registered.sessionIds, [])
  assert.equal(first.client.sent.at(-1)?.includes(canonicalPath), false)
  await first.client.messageHandler?.(conversationCommand(
    'chat-real-workspace',
    'attach registered session marker',
  ))
  await waitFor(() => firstAdapter.requests.length === 2)
  await session.whenIdle()
  await waitFor(() => registered.sessionIds.some((id) => String(id) === String(session.id)))
  const transcriptBefore = await first.ctx.sessionPersistence.inspect(session.id)
  assert.match(JSON.stringify(transcriptBefore.events), /durable transcript marker/)
  assert.match(JSON.stringify(transcriptBefore.events), /durable transcript answer/)
  assert.match(JSON.stringify(transcriptBefore.events), /attach registered session marker/)
  await first.dispose()

  const second = await mount(
    root,
    new ScriptedAdapter([]),
    undefined,
    undefined,
    undefined,
    undefined,
    nonCanonicalPath,
  )
  t.after(() => second.dispose())
  const restored = second.ctx.workspaceRegistry.list()[0]
  assert.ok(restored !== undefined)
  assert.equal(String(restored.id), firstId)
  assert.equal(restored.path, canonicalPath)
  assert.equal(restored.title, 'Real Workspace')
  assert.equal(restored.sessionIds.some((id) => String(id) === String(session.id)), true)
  await second.client.messageHandler?.(conversationCommand(
    'chat-real-workspace',
    `/project remove ${firstId}`,
  ))
  assert.deepEqual(second.ctx.workspaceRegistry.list(), [])
  assert.equal(await readFile(markerPath, 'utf8'), 'registration removal must not delete this file')
  const transcriptAfterRemoval = await second.ctx.sessionPersistence.inspect(session.id)
  assert.deepEqual(
    transcriptAfterRemoval.events.slice(0, transcriptBefore.events.length),
    transcriptBefore.events,
  )
  assert.ok(transcriptAfterRemoval.events.slice(transcriptBefore.events.length).every((event) => (
    event.type === 'session/end-seed'
  )))
  await second.dispose()

  const third = await mount(
    root,
    new ScriptedAdapter([]),
    undefined,
    undefined,
    undefined,
    undefined,
    nonCanonicalPath,
  )
  t.after(() => third.dispose())
  assert.deepEqual(third.ctx.workspaceRegistry.list(), [])
  assert.equal(await readFile(markerPath, 'utf8'), 'registration removal must not delete this file')
  assert.match(
    JSON.stringify((await third.ctx.sessionPersistence.inspect(session.id)).events),
    /durable transcript marker/,
  )

  await third.client.messageHandler?.(conversationCommand(
    'chat-real-workspace',
    '/project register Real Workspace Again',
  ))
  const reregistered = third.ctx.workspaceRegistry.list()[0]
  assert.ok(reregistered !== undefined)
  assert.notEqual(String(reregistered.id), firstId)
  assert.equal(reregistered.path, canonicalPath)
  assert.deepEqual(reregistered.sessionIds, [])
  await third.dispose()
})

test('harness e2e: first-command registry mutations survive cold owner-context restarts', async (t) => {
  assert.ok(larkInject.includes('sessions'))
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-first-command-workspace-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  await mkdir(projectPath)
  const canonicalPath = await realpath(projectPath)
  const first = await mount(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    canonicalPath,
    'zstd',
  )
  t.after(() => first.dispose())

  await first.client.messageHandler?.(conversationCommand(
    'chat-first-command-workspace',
    '/project register First Command',
  ))

  const registered = first.ctx.workspaceRegistry.list()[0]
  assert.ok(registered !== undefined)
  assert.equal(registered.path, canonicalPath)
  assert.equal(registered.title, 'First Command')
  assert.deepEqual(registered.sessionIds, [])
  assert.equal(first.ctx.agents.list().length, 1)
  const firstSessionId = first.ctx.agents.list()[0]?.id
  assert.ok(firstSessionId !== undefined)
  assert.deepEqual(
    (await first.ctx.sessionPersistence.inspect(firstSessionId)).events.map((event) => event.type),
    ['todo/write'],
  )
  assert.ok((await first.ctx.sessionPersistence.list()).some(({ id }) => id === firstSessionId))
  await first.dispose()

  const second = await mount(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    canonicalPath,
    'zstd',
  )
  t.after(() => second.dispose())
  assert.equal(second.ctx.workspaceRegistry.list().length, 1)

  await second.client.messageHandler?.(conversationCommand(
    'chat-first-command-workspace',
    '/help',
  ))

  assert.equal(second.ctx.agents.list().length, 1)
  assert.equal(second.ctx.agents.list()[0]?.id, firstSessionId)
  assert.equal(second.ctx.workspaceRegistry.list()[0]?.id, registered.id)
  await second.client.messageHandler?.(conversationCommand(
    'chat-first-command-removal',
    `/project remove ${registered.id}`,
  ))
  assert.deepEqual(second.ctx.workspaceRegistry.list(), [])
  const removalSession = second.ctx.agents.list().find(({ id }) => id !== firstSessionId)
  assert.ok(removalSession !== undefined)
  assert.deepEqual(
    (await second.ctx.sessionPersistence.inspect(removalSession.id)).events.map((event) => event.type),
    ['todo/write'],
  )
  assert.ok((await second.ctx.sessionPersistence.list()).some(({ id }) => id === removalSession.id))
  await second.dispose()

  const third = await mount(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    canonicalPath,
    'zstd',
  )
  t.after(() => third.dispose())
  assert.deepEqual(third.ctx.workspaceRegistry.list(), [])

  await third.client.messageHandler?.(conversationCommand(
    'chat-first-command-removal',
    '/help',
  ))

  assert.equal(third.ctx.agents.list().length, 1)
  assert.equal(third.ctx.agents.list()[0]?.id, removalSession.id)
  await third.dispose()
})

test('harness e2e: scoped session navigation resumes committed history and preserves the lineage high-water mark', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-session-navigation-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const projectPath = join(root, 'project')
  await mkdir(projectPath)
  const canonicalPath = await realpath(projectPath)
  const preset: HarnessPreset = { defaultId: 'coding', mounted: [], withEchoTool: true }
  const adapter = new ScriptedAdapter([
    textResponse('first generation answer'),
    textResponse('second generation answer'),
  ])
  const first = await mount(
    root,
    adapter,
    undefined,
    preset,
    undefined,
    undefined,
    canonicalPath,
    'zstd',
  )
  t.after(() => first.dispose())

  await first.client.messageHandler?.(conversationCommand(
    'chat-session-navigation',
    '/project register Navigation Project',
  ))
  const firstAgent = first.ctx.agents.list()[0]
  assert.ok(firstAgent !== undefined)
  await first.client.messageHandler?.(conversationCommand(
    'chat-session-navigation',
    'first generation marker',
  ))
  await waitFor(() => adapter.requests.length === 1)
  await firstAgent.whenIdle()
  await waitFor(() => firstAgent.session.events.some((event) => (
    event.type === 'session/title' && event.data.title === 'first generation marker'
  )))
  const workspace = first.ctx.workspaceRegistry.list()[0]
  assert.ok(workspace !== undefined)
  await waitFor(() => workspace.sessionIds.some((id) => id === firstAgent.id))

  await first.client.messageHandler?.(conversationCommand('chat-session-navigation', '/new'))
  const secondAgent = first.ctx.agents.list().find(({ id }) => id !== firstAgent.id)
  assert.ok(secondAgent !== undefined)
  await first.client.messageHandler?.(conversationCommand(
    'chat-session-navigation',
    'second generation marker',
  ))
  await waitFor(() => adapter.requests.length === 2)
  await secondAgent.whenIdle()
  await waitFor(() => secondAgent.session.events.some((event) => (
    event.type === 'session/title' && event.data.title === 'second generation marker'
  )))
  await waitFor(() => workspace.sessionIds.some((id) => id === secondAgent.id))

  await first.client.messageHandler?.(conversationCommand('chat-session-navigation', '/session'))
  const catalog = first.client.sent.at(-1) ?? ''
  const references = [...catalog.matchAll(/s_[A-Za-z0-9_-]{43}/gu)].map(([reference]) => reference)
  assert.equal(references.length, 2)
  assert.equal(new Set(references).size, 2)
  assert.doesNotMatch(catalog, new RegExp(String(firstAgent.id), 'u'))
  assert.doesNotMatch(catalog, new RegExp(String(secondAgent.id), 'u'))
  assert.equal(catalog.includes(canonicalPath), false)
  assert.match(catalog, /first generation marker/u)
  assert.match(catalog, /second generation marker/u)
  const currentLine = catalog.split('\n').find((line) => line.includes('[当前]'))
  assert.ok(currentLine !== undefined)
  const currentReference = references.find((reference) => currentLine.includes(reference))
  assert.ok(currentReference !== undefined)
  const historicalReference = references.find((reference) => reference !== currentReference)
  assert.ok(historicalReference !== undefined)

  await first.client.messageHandler?.(conversationCommand(
    'chat-session-navigation-other',
    `/session resume ${historicalReference}`,
  ))
  assert.match(first.client.sent.at(-1) ?? '', /没有该可恢复会话引用/u)

  await first.client.messageHandler?.(conversationCommand(
    'chat-session-navigation',
    `/session resume ${historicalReference}`,
  ))
  assert.match(first.client.sent.at(-1) ?? '', /已恢复所选会话/u)
  assert.equal(first.ctx.agents.list().some(({ id }) => id === firstAgent.id), true)

  const secondGeneration = Number(/^.+:(\d+)-/u.exec(String(secondAgent.id))?.[1])
  assert.ok(Number.isSafeInteger(secondGeneration))
  const orphanGeneration = secondGeneration + 10_000
  const orphanId = SessionId(
    `lark:chat-session-navigation:${orphanGeneration}-00000000-0000-4000-8000-000000000001`,
  )
  const orphan = await first.ctx.agents.create({
    sessionId: orphanId,
    meta: { cwd: canonicalPath },
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  orphan.agent.session.append('todo/write', { todos: [] })
  assert.equal(await first.ctx.sessions.flush(orphan.agent.session), true)
  await orphan.dispose()

  await first.client.messageHandler?.(conversationCommand('chat-session-navigation', '/session list'))
  assert.equal(([...(first.client.sent.at(-1) ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 2)
  await first.ctx.workspaceRegistry.archiveSession(secondAgent.id)
  await first.client.messageHandler?.(conversationCommand('chat-session-navigation', '/session list 1'))
  assert.equal(([...(first.client.sent.at(-1) ?? '').matchAll(/s_[A-Za-z0-9_-]{43}/gu)]).length, 1)
  await first.dispose()

  const second = await mount(
    root,
    new ScriptedAdapter([]),
    undefined,
    preset,
    undefined,
    undefined,
    canonicalPath,
    'zstd',
  )
  t.after(() => second.dispose())
  await second.client.messageHandler?.(conversationCommand('chat-session-navigation', '/help'))
  assert.equal(second.ctx.agents.list()[0]?.id, firstAgent.id)

  t.mock.method(Date, 'now', () => 1)
  await second.client.messageHandler?.(conversationCommand('chat-session-navigation', '/clear'))
  const resetAgent = second.ctx.agents.list().find(({ id }) => id !== firstAgent.id)
  assert.ok(resetAgent !== undefined)
  const resetGeneration = Number(/^.+:(\d+)-/u.exec(String(resetAgent.id))?.[1])
  assert.ok(
    resetGeneration > orphanGeneration,
    `reset generation ${resetGeneration} did not exceed persisted high-water ${orphanGeneration}`,
  )
  await second.dispose()
})
