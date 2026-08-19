import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { larkConversationsDomainSpec } from '../src/conversation-binding.ts'
import { larkPolicyDomainSpec } from '../src/conversation-policy.ts'
import { larkInboundDomainSpec } from '../src/inbound-dedup.ts'
import { larkNotifyDomainSpec } from '../src/outbound-notify.ts'
import { larkTaskDomainSpec } from '../src/parallel-tasks.ts'

/**
 * The 1.0 stable surface. These two sets are what a deployment configures and
 * what it stores on disk, so changing either changes the contract a stable
 * release promises. Editing this file is the deliberate act that records such a
 * change; it is not a list to update until the suite goes green again.
 */
const FROZEN_CONFIG_KEYS = [
  'domain',
  'locale',
  'allowFrom',
  'allowAllUsers',
  'projectManageFrom',
  'defaultSessionId',
  'provider',
  'model',
  'streamUpdateIntervalMs',
  'maxConversationHandles',
  'inboundTextFiles',
  'maxInboundTextFileBytes',
  'inboundImages',
  'maxInboundImageBytes',
  'maxInboundImagePixels',
  'maxConversationImages',
  'maxConversationImageBytes',
  'outboundArtifacts',
  'maxOutboundTextFileBytes',
  'maxOutboundImageBytes',
  'maxOutboundImagePixels',
  'proactiveDelivery',
  'operatorFrom',
  'runtimeDir',
  'runtimeOwnerTtlMs',
  'parallelTasks',
  'maxParallelTasks',
  'taskWorkspaces',
  'documentHandoff',
  'maxDocumentReadBytes',
  'maxDocumentPublishBytes',
] as const

const FROZEN_DOMAINS = [
  { name: 'lark_conversations', version: 0 },
  { name: 'lark_inbound', version: 0 },
  { name: 'lark_notify', version: 0 },
  { name: 'lark_policy', version: 0 },
  { name: 'lark_tasks', version: 0 },
] as const

test('stable surface: the public configuration surface is frozen', () => {
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  const block = /export const Config: Schema = Schema\.object\(\{([\s\S]*?)\n\}\)/u.exec(source)
  assert.ok(block !== null)
  const keys = [...(block[1] ?? '').matchAll(/^ {2}(\w+):/gmu)].map((match) => match[1] as string)

  assert.deepEqual(
    keys,
    [...FROZEN_CONFIG_KEYS],
    'the public configuration surface changed; a stable release may only add an optional key, '
      + 'and removing or renaming one is a breaking change that needs a major version',
  )
})

test('stable surface: durable storage domains and their versions are frozen', () => {
  const declared = [
    larkConversationsDomainSpec,
    larkInboundDomainSpec,
    larkNotifyDomainSpec,
    larkPolicyDomainSpec,
    larkTaskDomainSpec,
  ]
    .map((spec) => ({ name: spec.name, version: spec.version }))
    .sort((left, right) => left.name.localeCompare(right.name))

  assert.deepEqual(
    declared,
    [...FROZEN_DOMAINS],
    'a durable storage domain changed; a version bump needs a migration path and an '
      + 'UPGRADING entry before it can ship',
  )
})

test('stable surface: every frozen domain is documented in both upgrade guides', () => {
  for (const path of ['UPGRADING.md', 'UPGRADING.zh-CN.md']) {
    const guide = readFileSync(join(process.cwd(), path), 'utf8')
    for (const domain of FROZEN_DOMAINS) {
      assert.ok(guide.includes(domain.name), `${path} omits ${domain.name}`)
    }
  }
})
