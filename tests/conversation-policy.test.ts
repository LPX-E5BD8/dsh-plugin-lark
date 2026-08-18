import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import { LarkBridge } from '../src/bridge.ts'
import type { LarkClientLike, LarkInbound } from '../src/lark.ts'
import { DurableNotifyOutbox } from '../src/outbound-notify.ts'
import {
  applyPolicyMutation,
  defaultConversationPolicy,
  DurableConversationPolicyStore,
  formatPolicyBody,
  hashPolicyPrincipal,
  inboundAllowedByMention,
  intersectPolicy,
  parsePolicyMutation,
  policyAllowsModel,
  policyAllowsUser,
  policyAllowsWorkspace,
} from '../src/conversation-policy.ts'

const hashUser = (openId: string): string => hashPolicyPrincipal('cli_policytest0001', openId)

test('local policy can only narrow global tool gates', () => {
  const open = intersectPolicy({ outboundArtifacts: true, proactiveDelivery: true }, {
    mention: 'default',
    approvals: false,
    outboundArtifacts: true,
    notify: true,
  })
  assert.equal(open.approvals, false)
  assert.equal(open.outboundArtifacts, true)
  assert.equal(open.notify, true)

  const closed = intersectPolicy({ outboundArtifacts: false, proactiveDelivery: false }, {
    mention: 'always',
    approvals: true,
    outboundArtifacts: true,
    notify: true,
  })
  assert.equal(closed.outboundArtifacts, false)
  assert.equal(closed.notify, false)
  assert.equal(closed.mention, 'always')
})

test('workspace, model, and user lists only restrict when set', () => {
  const open = intersectPolicy({ outboundArtifacts: true, proactiveDelivery: true }, undefined)
  assert.equal(policyAllowsWorkspace(open, 'any-id'), true)
  assert.equal(policyAllowsModel(open, 'p', 'm'), true)
  assert.equal(policyAllowsUser(open, hashUser('ou_anyone')), true)
  const hashed = hashUser('ou_allowed')
  const narrowed = intersectPolicy({ outboundArtifacts: true, proactiveDelivery: true }, {
    mention: 'default',
    approvals: true,
    outboundArtifacts: true,
    notify: true,
    workspaceIds: ['ws-a'],
    models: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    allowFrom: [hashed],
  })
  assert.equal(policyAllowsWorkspace(narrowed, 'ws-a'), true)
  assert.equal(policyAllowsWorkspace(narrowed, 'ws-b'), false)
  assert.equal(policyAllowsModel(narrowed, 'deepseek-official', 'deepseek-v4-flash'), true)
  assert.equal(policyAllowsModel(narrowed, 'other', 'x'), false)
  assert.equal(policyAllowsUser(narrowed, hashed), true)
  assert.equal(policyAllowsUser(narrowed, hashUser('ou_other')), false)
})

test('mention policy can only require more mentions in groups', () => {
  const ordinary = intersectPolicy({ outboundArtifacts: true, proactiveDelivery: true }, undefined)
  assert.equal(inboundAllowedByMention(ordinary, 'group', false, true), true)
  assert.equal(inboundAllowedByMention(ordinary, 'group', false, false), false)
  assert.equal(inboundAllowedByMention(ordinary, 'p2p', false, false), true)
  const always = intersectPolicy({ outboundArtifacts: true, proactiveDelivery: true }, {
    ...defaultConversationPolicy(),
    mention: 'always',
  })
  assert.equal(inboundAllowedByMention(always, 'group', false, true), false)
  assert.equal(inboundAllowedByMention(always, 'group', true, true), true)
  assert.equal(inboundAllowedByMention(always, 'p2p', false, true), true)
})

test('policy mutations parse only the bounded operator vocabulary', () => {
  assert.deepEqual(parsePolicyMutation('/policy set notify off'), {
    kind: 'flag',
    field: 'notify',
    enabled: false,
  })
  assert.deepEqual(parsePolicyMutation('/policy set mention always'), {
    kind: 'mention',
    mention: 'always',
  })
  assert.deepEqual(parsePolicyMutation('/policy set users add ou_owner'), {
    kind: 'users',
    action: 'add',
    openId: 'ou_owner',
  })
  assert.deepEqual(parsePolicyMutation('/policy set projects add 11111111-1111-4111-8111-111111111111'), {
    kind: 'projects',
    action: 'add',
    id: '11111111-1111-4111-8111-111111111111',
  })
  assert.deepEqual(parsePolicyMutation('/policy set models add deepseek-official deepseek-v4-flash'), {
    kind: 'models',
    action: 'add',
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  assert.equal(parsePolicyMutation('/policy set notify maybe'), undefined)
  assert.equal(parsePolicyMutation('/policy set destination oc_chat'), undefined)
  assert.equal(parsePolicyMutation('/policy set users add'), undefined)
  const next = applyPolicyMutation(defaultConversationPolicy(), {
    kind: 'flag',
    field: 'artifacts',
    enabled: false,
  }, hashUser)
  assert.equal(next.outboundArtifacts, false)
  assert.equal(next.notify, true)
  const restricted = applyPolicyMutation(next, {
    kind: 'users',
    action: 'add',
    openId: 'ou_owner',
  }, hashUser)
  assert.equal(restricted.allowFrom?.length, 1)
  assert.equal(restricted.allowFrom?.[0], hashUser('ou_owner'))
  const body = formatPolicyBody(intersectPolicy({
    outboundArtifacts: false,
    proactiveDelivery: true,
  }, restricted), 'en-US')
  assert.doesNotMatch(body, /oc_|ou_|secret|[0-9a-f]{64}/u)
  assert.match(body, /Extra allowlist: 1 users/u)
  assert.equal(applyPolicyMutation(restricted, {
    kind: 'users',
    action: 'remove',
    openId: 'ou_missing',
  }, hashUser).allowFrom?.length, 1)
  assert.equal(applyPolicyMutation(defaultConversationPolicy(), {
    kind: 'users',
    action: 'remove',
    openId: 'ou_owner',
  }, hashUser).allowFrom, undefined)
})

test('durable policy store survives reopen without secrets', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-policy-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const open = async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const store = await DurableConversationPolicyStore.open(ctx.storageDomain, 'cli_policytest0001')
    return {
      store,
      async dispose() {
        await store.close()
        await ctx.fiber.dispose()
      },
    }
  }
  const first = await open()
  await first.store.put('lark:chat-a', {
    mention: 'always',
    approvals: true,
    outboundArtifacts: false,
    notify: true,
    workspaceIds: ['11111111-1111-4111-8111-111111111111'],
    allowFrom: [first.store.principalHash('ou_owner')],
  })
  await first.dispose()
  const second = await open()
  t.after(() => second.dispose())
  const stored = second.store.read('lark:chat-a')
  assert.equal(stored?.outboundArtifacts, false)
  assert.equal(stored?.mention, 'always')
  assert.deepEqual(stored?.workspaceIds, ['11111111-1111-4111-8111-111111111111'])
  assert.deepEqual(stored?.allowFrom, [second.store.principalHash('ou_owner')])
  assert.doesNotMatch(JSON.stringify(stored), /ou_owner/u)
})

interface PolicyTool {
  readonly name: string
}

function createPolicyClient(): LarkClientLike & {
  readonly sent: string[]
  messageHandler?: (message: LarkInbound) => Promise<void>
} {
  const client = {
    sent: [] as string[],
    messageHandler: undefined as ((message: LarkInbound) => Promise<void>) | undefined,
    async start() {},
    async stop() {},
    async sendText(_chatId: string, text: string) { client.sent.push(text) },
    async sendCard() { return 'om_policy_card' },
    onMessage(handler: (message: LarkInbound) => Promise<void>) { client.messageHandler = handler },
  }
  return client as never
}

function createPolicyHost(tools: PolicyTool[]) {
  return {
    logger: { error() {}, warn() {} },
    on() { return () => {} },
    get() { return undefined },
    agents: {
      async create(options: {
        sessionId: unknown
        setup?: (agentCtx: {
          tools: { register(tool: PolicyTool): void }
          on(): () => void
        }) => Promise<void> | void
      }) {
        const sessionId = String(options.sessionId)
        const agent = {
          id: sessionId,
          session: {
            id: sessionId,
            events: [],
            header: {},
            append() {},
            requestContext() { return undefined },
          },
          status: 'idle' as const,
          inbox: { hasPending: false },
          cancel() {},
          followup() {},
          runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>) {
            return task(new AbortController().signal)
          },
          whenIdle() { return Promise.resolve() },
        }
        await options.setup?.({
          tools: { register(tool) { tools.push(tool) } },
          on: () => () => {},
        })
        return { agent, dispose: async () => {} }
      },
      get() { return undefined },
      list() { return [] },
      roots() { return [] },
    },
    sessions: { async flush() { return true } },
  }
}

test('a narrowed policy hides scoped tools for a direct conversation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-policy-tools-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const policies = await DurableConversationPolicyStore.open(ctx.storageDomain, 'cli_policytools001')
  const notifyOutbox = await DurableNotifyOutbox.open(ctx.storageDomain, 'cli_policytools001')
  t.after(async () => {
    await notifyOutbox.close().catch(() => {})
    await policies.close().catch(() => {})
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await policies.put('oc_policy_off', {
    ...defaultConversationPolicy(),
    notify: false,
  })

  const narrowedTools: PolicyTool[] = []
  const narrowedClient = createPolicyClient()
  const narrowedBridge = new LarkBridge(createPolicyHost(narrowedTools) as never, {
    client: narrowedClient,
    allowFrom: ['ou_owner'],
    proactiveDelivery: true,
    notifyOutbox,
    conversationPolicies: policies,
  })
  await narrowedBridge.start()
  await narrowedClient.messageHandler?.({
    chatId: 'oc_policy_off',
    chatType: 'p2p',
    openId: 'ou_owner',
    text: 'start work',
    messageId: 'om_policy_off',
    mentioned: false,
  })
  assert.equal(
    narrowedTools.some((tool) => tool.name === 'notify_lark'),
    false,
    'notify_lark was registered even though the conversation policy disabled it',
  )
  await narrowedBridge.stop()

  const allowedTools: PolicyTool[] = []
  const allowedClient = createPolicyClient()
  const allowedBridge = new LarkBridge(createPolicyHost(allowedTools) as never, {
    client: allowedClient,
    allowFrom: ['ou_owner'],
    proactiveDelivery: true,
    notifyOutbox,
    conversationPolicies: policies,
  })
  await allowedBridge.start()
  await allowedClient.messageHandler?.({
    chatId: 'oc_policy_on',
    chatType: 'p2p',
    openId: 'ou_owner',
    text: 'start work',
    messageId: 'om_policy_on',
    mentioned: false,
  })
  assert.equal(
    allowedTools.some((tool) => tool.name === 'notify_lark'),
    true,
    'notify_lark was not registered for a conversation without a narrowing policy',
  )
  await allowedBridge.stop()
})
