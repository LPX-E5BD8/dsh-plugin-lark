import { createHash } from 'node:crypto'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const POLICY_COMMAND = '/policy'

export type MentionPolicy = 'default' | 'always'

export interface ConversationPolicy {
  readonly workspaceIds?: readonly string[]
  readonly models?: readonly { readonly provider: string; readonly model: string }[]
  readonly allowFrom?: readonly string[]
  readonly mention: MentionPolicy
  readonly approvals: boolean
  readonly outboundArtifacts: boolean
  readonly notify: boolean
}

export interface GlobalPolicyGate {
  readonly outboundArtifacts: boolean
  readonly proactiveDelivery: boolean
}

export interface EffectivePolicy {
  readonly workspaceIds?: readonly string[]
  readonly models?: readonly { readonly provider: string; readonly model: string }[]
  readonly allowFrom?: readonly string[]
  readonly mention: MentionPolicy
  readonly approvals: boolean
  readonly outboundArtifacts: boolean
  readonly notify: boolean
}

export type PolicyMutation =
  | { readonly kind: 'flag'; readonly field: 'approvals' | 'artifacts' | 'notify'; readonly enabled: boolean }
  | { readonly kind: 'mention'; readonly mention: MentionPolicy }
  | { readonly kind: 'users'; readonly action: 'add' | 'remove'; readonly openId: string }
  | { readonly kind: 'users'; readonly action: 'clear' }
  | { readonly kind: 'projects'; readonly action: 'add' | 'remove'; readonly id: string }
  | { readonly kind: 'projects'; readonly action: 'all' }
  | { readonly kind: 'models'; readonly action: 'add' | 'remove'; readonly provider: string; readonly model: string }
  | { readonly kind: 'models'; readonly action: 'all' }

const KEY_PATTERN = /^[0-9a-f]{64}$/u
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u
const HASH_DOMAIN = 'dsh-plugin-lark/conversation-policy/v1'
const PRINCIPAL_HASH_DOMAIN = 'dsh-plugin-lark/conversation-policy/principal/v1'
const MAX_LIST = 64

const modelSchema = z.object({
  provider: z.string().regex(ID_PATTERN),
  model: z.string().regex(ID_PATTERN),
}).strict()

const policySchema = z.object({
  workspaceIds: z.array(z.string().regex(ID_PATTERN)).max(MAX_LIST).optional(),
  models: z.array(modelSchema).max(MAX_LIST).optional(),
  allowFrom: z.array(z.string().regex(KEY_PATTERN)).max(MAX_LIST).optional(),
  mention: z.enum(['default', 'always']),
  approvals: z.boolean(),
  outboundArtifacts: z.boolean(),
  notify: z.boolean(),
}).strict()

type StoredPolicy = z.infer<typeof policySchema>
type PolicyKey = string & { readonly __policyKey: unique symbol }

export const larkPolicyDomainSpec = defineDomain({
  name: 'lark_policy',
  version: 0,
  tables: {
    policies: domainTable<PolicyKey, StoredPolicy>(policySchema),
  },
})

type PolicyDomain = Domain<typeof larkPolicyDomainSpec>
type PolicyTable = KvTable<PolicyKey, StoredPolicy>

export function defaultConversationPolicy(): ConversationPolicy {
  return Object.freeze({
    mention: 'default',
    approvals: true,
    outboundArtifacts: true,
    notify: true,
  })
}

export function intersectPolicy(
  global: GlobalPolicyGate,
  local: ConversationPolicy | undefined,
): EffectivePolicy {
  const policy = local ?? defaultConversationPolicy()
  return Object.freeze({
    ...(policy.workspaceIds === undefined ? {} : { workspaceIds: Object.freeze([...policy.workspaceIds]) }),
    ...(policy.models === undefined ? {} : { models: Object.freeze(policy.models.map((item) => Object.freeze({ ...item }))) }),
    ...(policy.allowFrom === undefined ? {} : { allowFrom: Object.freeze([...policy.allowFrom]) }),
    mention: policy.mention,
    approvals: policy.approvals,
    outboundArtifacts: global.outboundArtifacts && policy.outboundArtifacts,
    notify: global.proactiveDelivery && policy.notify,
  })
}

export function policyAllowsWorkspace(policy: EffectivePolicy, workspaceId: string): boolean {
  return policy.workspaceIds === undefined || policy.workspaceIds.includes(workspaceId)
}

export function policyAllowsModel(policy: EffectivePolicy, provider: string, model: string): boolean {
  return policy.models === undefined || policy.models.some((item) => (
    item.provider === provider && item.model === model
  ))
}

export function policyAllowsUser(policy: EffectivePolicy, hashedOpenId: string): boolean {
  return policy.allowFrom === undefined || policy.allowFrom.includes(hashedOpenId)
}

export function inboundAllowedByMention(
  policy: EffectivePolicy,
  chatType: string,
  mentioned: boolean,
  isCommand: boolean,
): boolean {
  if (chatType !== 'group' || mentioned) return true
  return policy.mention !== 'always' && isCommand
}

export function hashPolicyPrincipal(namespace: string, openId: string): string {
  return createHash('sha256')
    .update(PRINCIPAL_HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(namespace, 'utf8')))
    .update(':')
    .update(namespace, 'utf8')
    .update(String(Buffer.byteLength(openId, 'utf8')))
    .update(':')
    .update(openId, 'utf8')
    .digest('hex')
}

export function parsePolicyMutation(text: string): PolicyMutation | undefined {
  const parts = text.trim().split(/\s+/u)
  if (parts[0] !== '/policy' || parts[1] !== 'set' || parts.length < 4) return undefined
  const field = parts[2]
  const value = parts[3]
  if (field === 'approvals' || field === 'artifacts' || field === 'notify') {
    if (parts.length !== 4 || (value !== 'on' && value !== 'off')) return undefined
    return { kind: 'flag', field, enabled: value === 'on' }
  }
  if (field === 'mention') {
    if (parts.length !== 4 || (value !== 'default' && value !== 'always')) return undefined
    return { kind: 'mention', mention: value }
  }
  if (field === 'users') {
    if (value === 'clear' && parts.length === 4) return { kind: 'users', action: 'clear' }
    if ((value === 'add' || value === 'remove') && parts.length === 5 && ID_PATTERN.test(parts[4] ?? '')) {
      return { kind: 'users', action: value, openId: parts[4] as string }
    }
    return undefined
  }
  if (field === 'projects') {
    if (value === 'all' && parts.length === 4) return { kind: 'projects', action: 'all' }
    if ((value === 'add' || value === 'remove') && parts.length === 5 && ID_PATTERN.test(parts[4] ?? '')) {
      return { kind: 'projects', action: value, id: parts[4] as string }
    }
    return undefined
  }
  if (field === 'models') {
    if (value === 'all' && parts.length === 4) return { kind: 'models', action: 'all' }
    if (
      (value === 'add' || value === 'remove')
      && parts.length === 6
      && ID_PATTERN.test(parts[4] ?? '')
      && ID_PATTERN.test(parts[5] ?? '')
    ) {
      return { kind: 'models', action: value, provider: parts[4] as string, model: parts[5] as string }
    }
    return undefined
  }
  return undefined
}

export function applyPolicyMutation(
  current: ConversationPolicy,
  mutation: PolicyMutation,
  hashUser: (openId: string) => string,
): ConversationPolicy {
  if (mutation.kind === 'flag') {
    return Object.freeze({
      ...current,
      approvals: mutation.field === 'approvals' ? mutation.enabled : current.approvals,
      outboundArtifacts: mutation.field === 'artifacts' ? mutation.enabled : current.outboundArtifacts,
      notify: mutation.field === 'notify' ? mutation.enabled : current.notify,
    })
  }
  if (mutation.kind === 'mention') {
    return Object.freeze({ ...current, mention: mutation.mention })
  }
  if (mutation.kind === 'users') {
    if (mutation.action === 'clear') {
      const { allowFrom: _allowFrom, ...rest } = current
      return Object.freeze(rest)
    }
    const hashed = hashUser(mutation.openId)
    if (!KEY_PATTERN.test(hashed)) throw new TypeError('lark: policy principal hash is invalid')
    const next = mutateBoundedList(current.allowFrom, hashed, mutation.action)
    return Object.freeze({
      ...current,
      ...(next === undefined ? { allowFrom: undefined } : { allowFrom: next }),
    })
  }
  if (mutation.kind === 'projects') {
    if (mutation.action === 'all') {
      const { workspaceIds: _workspaceIds, ...rest } = current
      return Object.freeze(rest)
    }
    const next = mutateBoundedList(current.workspaceIds, mutation.id, mutation.action)
    return Object.freeze({
      ...current,
      ...(next === undefined ? { workspaceIds: undefined } : { workspaceIds: next }),
    })
  }
  if (mutation.action === 'all') {
    const { models: _models, ...rest } = current
    return Object.freeze(rest)
  }
  const token = `${mutation.provider}\0${mutation.model}`
  const encoded = (current.models ?? []).map((item) => `${item.provider}\0${item.model}`)
  const next = mutateBoundedList(encoded, token, mutation.action)
  return Object.freeze({
    ...current,
    ...(next === undefined ? { models: undefined } : {
      models: Object.freeze(next.map((item) => {
        const separator = item.indexOf('\0')
        return Object.freeze({
          provider: item.slice(0, separator),
          model: item.slice(separator + 1),
        })
      })),
    }),
  })
}

export function formatPolicyBody(
  policy: EffectivePolicy,
  locale: 'zh-CN' | 'en-US',
): string {
  if (locale === 'zh-CN') {
    return [
      `审批：${policy.approvals ? '允许' : '关闭'}`,
      `产物发送：${policy.outboundArtifacts ? '允许' : '关闭'}`,
      `主动通知：${policy.notify ? '允许' : '关闭'}`,
      `群聊提及：${policy.mention === 'always' ? '一律需要' : '默认'}`,
      `额外授权：${policy.allowFrom === undefined ? '无（沿用全局）' : `${policy.allowFrom.length} 人`}`,
      `可见项目：${policy.workspaceIds === undefined ? '全部已注册' : `${policy.workspaceIds.length} 个`}`,
      `可选模型：${policy.models === undefined ? '全部可解析' : `${policy.models.length} 条`}`,
    ].join('\n')
  }
  return [
    `Approvals: ${policy.approvals ? 'allowed' : 'off'}`,
    `Outbound artifacts: ${policy.outboundArtifacts ? 'allowed' : 'off'}`,
    `Proactive notify: ${policy.notify ? 'allowed' : 'off'}`,
    `Group mention: ${policy.mention === 'always' ? 'always required' : 'default'}`,
    `Extra allowlist: ${policy.allowFrom === undefined ? 'none (global only)' : `${policy.allowFrom.length} users`}`,
    `Visible projects: ${policy.workspaceIds === undefined ? 'all registered' : `${policy.workspaceIds.length} projects`}`,
    `Selectable models: ${policy.models === undefined ? 'all resolvable' : `${policy.models.length} routes`}`,
  ].join('\n')
}

function mutateBoundedList(
  current: readonly string[] | undefined,
  value: string,
  action: 'add' | 'remove',
): readonly string[] | undefined {
  if (action === 'remove') {
    if (current === undefined) return undefined
    return Object.freeze(current.filter((item) => item !== value))
  }
  const list = [...(current ?? [])]
  if (list.includes(value)) return Object.freeze(list)
  if (list.length >= MAX_LIST) throw new RangeError('lark: conversation policy list is full')
  list.push(value)
  return Object.freeze(list)
}

function freezePolicy(stored: StoredPolicy): ConversationPolicy {
  return Object.freeze({
    ...(stored.workspaceIds === undefined ? {} : { workspaceIds: Object.freeze([...stored.workspaceIds]) }),
    ...(stored.models === undefined ? {} : { models: Object.freeze(stored.models.map((item) => Object.freeze({ ...item }))) }),
    ...(stored.allowFrom === undefined ? {} : { allowFrom: Object.freeze([...stored.allowFrom]) }),
    mention: stored.mention,
    approvals: stored.approvals,
    outboundArtifacts: stored.outboundArtifacts,
    notify: stored.notify,
  })
}

function policyKey(namespace: string, baseId: string): PolicyKey {
  return createHash('sha256')
    .update(HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(namespace, 'utf8')))
    .update(':')
    .update(namespace, 'utf8')
    .update(String(Buffer.byteLength(baseId, 'utf8')))
    .update(':')
    .update(baseId, 'utf8')
    .digest('hex') as PolicyKey
}

export class DurableConversationPolicyStore {
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined

  private constructor(
    private readonly domain: PolicyDomain,
    private readonly table: PolicyTable,
    private readonly namespace: string,
  ) {}

  static async open(facility: DomainFacility, namespace: string): Promise<DurableConversationPolicyStore> {
    if (typeof namespace !== 'string' || namespace.trim() === '') {
      throw new TypeError('lark: policy store namespace must not be empty')
    }
    const domain = await facility.open(larkPolicyDomainSpec)
    try {
      return new DurableConversationPolicyStore(domain, domain.table('policies'), namespace)
    } catch (error) {
      await domain.close().catch(() => {})
      throw error
    }
  }

  principalHash(openId: string): string {
    return hashPolicyPrincipal(this.namespace, openId)
  }

  read(baseId: string): ConversationPolicy | undefined {
    const stored = this.table.get(policyKey(this.namespace, baseId))
    return stored === undefined ? undefined : freezePolicy(stored)
  }

  put(baseId: string, policy: ConversationPolicy): Promise<void> {
    if (this.closing) return Promise.reject(new Error('lark: policy store is closing'))
    const record = policySchema.parse({
      mention: policy.mention,
      approvals: policy.approvals,
      outboundArtifacts: policy.outboundArtifacts,
      notify: policy.notify,
      ...(policy.workspaceIds === undefined ? {} : { workspaceIds: [...policy.workspaceIds] }),
      ...(policy.models === undefined ? {} : { models: policy.models.map((item) => ({ ...item })) }),
      ...(policy.allowFrom === undefined ? {} : { allowFrom: [...policy.allowFrom] }),
    })
    const key = policyKey(this.namespace, baseId)
    const operation = this.operationTail.then(() => this.table.put(key, record))
    this.operationTail = operation.catch(() => {})
    return operation
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.operationTail.then(() => this.domain.close())
    return this.closePromise
  }
}
