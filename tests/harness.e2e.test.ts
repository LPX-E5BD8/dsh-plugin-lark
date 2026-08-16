import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { LarkBridge } from '../src/bridge.ts'
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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.fail('condition was not met before timeout')
}

async function mount(
  root: string,
  adapter?: LlmAdapter,
  locale?: LarkLocale,
  preset?: HarnessPreset,
): Promise<{
  ctx: Context
  bridge: LarkBridge
  client: HarnessClient
  dispose(): Promise<void>
}> {
  const ctx = new Context()
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
  if (adapter !== undefined) ctx.llm.registerAdapter(['mock'], adapter)
  const client = createClient()
  const bridge = new LarkBridge(ctx, {
    client,
    locale,
    allowFrom: ['owner'],
    provider: adapter === undefined ? undefined : 'mock',
    model: adapter === undefined ? undefined : 'mock',
  })
  bridge.start()
  let disposed = false
  return {
    ctx,
    bridge,
    client,
    async dispose() {
      if (disposed) return
      disposed = true
      await bridge.stop()
      await ctx.fiber.dispose()
    },
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
    ['session/end-seed'],
  )
  await first.dispose()

  const second = await mount(root)
  await second.client.messageHandler?.(command('/help'))
  assert.equal(second.ctx.agents.list()[0]?.id, freshSessionId)
  assert.equal(second.ctx.agents.list()[0]?.session.firstLiveSeq, 1)
  await second.dispose()
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

  await harness.bridge.stop()
  assert.equal(harness.client.stopped, true)
  assert.equal(harness.ctx.agents.list().length, 0)
  await harness.ctx.fiber.dispose()
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
