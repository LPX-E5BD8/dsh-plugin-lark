import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import {
  admitTask,
  DurableParallelTaskStore,
  MAX_PARALLEL_TASKS_LIMIT,
  MAX_TASK_PROMPT_RUNES,
  MAX_TASKS_LISTED,
  MAX_TASK_TITLE_RUNES,
  newTaskReference,
  ParallelTaskError,
  parseTaskCommand,
  taskBaseId,
  taskIsLive,
  taskTitle,
  workspaceCollisionKey,
  validateMaxParallelTasks,
  type ParallelTaskRecord,
} from '../src/parallel-tasks.ts'

const WS_A = workspaceCollisionKey('cli_tasktest0001', 'ws-a')
const WS_B = workspaceCollisionKey('cli_tasktest0001', 'ws-b')

function record(overrides: Partial<ParallelTaskRecord> = {}): ParallelTaskRecord {
  return {
    reference: newTaskReference(),
    scopeId: 'oc_chat',
    parentBaseId: 'lark:oc_chat',
    taskBaseId: 'lark:v1:oc_chat:task:aaaaaaaaaaaa',
    chatId: 'oc_chat',
    replyToMessageId: 'om_start',
    title: 'ship the release',
    status: 'running',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

test('only the explicit task vocabulary creates parallel work', () => {
  assert.deepEqual(parseTaskCommand('/task'), { kind: 'list' })
  assert.deepEqual(parseTaskCommand('/task list'), { kind: 'list' })
  assert.deepEqual(parseTaskCommand('/task run build the docs'), {
    kind: 'run',
    prompt: 'build the docs',
  })
  assert.deepEqual(parseTaskCommand('/task stop abcdef012345'), {
    kind: 'stop',
    reference: 'abcdef012345',
  })
  assert.deepEqual(parseTaskCommand('/task abcdef012345'), {
    kind: 'inspect',
    reference: 'abcdef012345',
  })

  // An ordinary message is never parallel work.
  assert.equal(parseTaskCommand('please run the build in parallel'), undefined)
  assert.equal(parseTaskCommand('/taskrun something'), undefined)
  assert.equal(parseTaskCommand('/task run '), undefined)
  assert.equal(parseTaskCommand('/task stop nope'), undefined)
  assert.equal(parseTaskCommand('/task ABCDEF012345'), undefined)
  assert.equal(parseTaskCommand(`/task run ${'x'.repeat(MAX_TASK_PROMPT_RUNES + 1)}`), undefined)
})

test('task references and scopes stay opaque and chat-resolvable', () => {
  const reference = newTaskReference()
  assert.match(reference, /^[0-9a-f]{12}$/u)
  assert.notEqual(newTaskReference(), reference)

  // The chat stays the second segment so conversation policy still resolves it.
  const base = taskBaseId('lark', 'v1', 'oc_chat:weird', reference)
  assert.equal(base, `lark:v1:oc_chat%3Aweird:task:${reference}`)
  assert.equal(decodeURIComponent(base.split(':')[2] ?? ''), 'oc_chat:weird')
})

test('task titles are bounded and single-line', () => {
  assert.equal(taskTitle('  build\n  the   docs '), 'build the docs')
  const long = taskTitle('x'.repeat(MAX_TASK_TITLE_RUNES + 40))
  assert.equal([...long].length, MAX_TASK_TITLE_RUNES)
  assert.ok(long.endsWith('…'))
})

test('parallel task limits are bounded', () => {
  assert.equal(validateMaxParallelTasks(1), 1)
  assert.equal(validateMaxParallelTasks(MAX_PARALLEL_TASKS_LIMIT), MAX_PARALLEL_TASKS_LIMIT)
  assert.throws(() => validateMaxParallelTasks(0), RangeError)
  assert.throws(() => validateMaxParallelTasks(MAX_PARALLEL_TASKS_LIMIT + 1), RangeError)
  assert.throws(() => validateMaxParallelTasks(1.5), RangeError)
})

test('admission enforces per-conversation capacity', () => {
  const live = [record(), record()]
  assert.throws(
    () => admitTask(live, {
      scopeId: 'oc_chat',
      maxParallelTasks: 2,
      workspacePolicy: 'shared',
    }),
    (error: unknown) => error instanceof ParallelTaskError && error.code === 'AT_CAPACITY',
  )
  // Capacity is per conversation, so another chat is unaffected.
  assert.doesNotThrow(() => admitTask(live, {
    scopeId: 'oc_other',
    maxParallelTasks: 2,
    workspacePolicy: 'shared',
  }))
})

test('an exclusive workspace policy refuses a second live task in one project', () => {
  const live = [record({ workspaceKey: WS_A })]
  assert.throws(
    () => admitTask(live, {
      scopeId: 'oc_other',
      workspaceKey: WS_A,
      maxParallelTasks: 4,
      workspacePolicy: 'exclusive',
    }),
    (error: unknown) => error instanceof ParallelTaskError && error.code === 'WORKSPACE_BUSY',
  )
  assert.doesNotThrow(() => admitTask(live, {
    scopeId: 'oc_other',
    workspaceKey: WS_B,
    maxParallelTasks: 4,
    workspacePolicy: 'exclusive',
  }))
  // Sharing is possible only when it was configured explicitly.
  assert.doesNotThrow(() => admitTask(live, {
    scopeId: 'oc_other',
    workspaceKey: WS_A,
    maxParallelTasks: 4,
    workspacePolicy: 'shared',
  }))
  // A settled task no longer holds its project.
  assert.doesNotThrow(() => admitTask([], {
    scopeId: 'oc_other',
    workspaceKey: WS_A,
    maxParallelTasks: 4,
    workspacePolicy: 'exclusive',
  }))
})

async function openStore(t: { after(callback: () => Promise<void>): void }, namespace = 'cli_tasktest0001') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-tasks-'))
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  const store = await DurableParallelTaskStore.open(ctx.storageDomain, namespace)
  t.after(async () => {
    await store.close().catch(() => {})
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  return { store, ctx, root, namespace }
}

test('tasks persist, settle once, and list live work first', async (t) => {
  const { store } = await openStore(t)
  const first = record({ createdAt: 1_000, title: 'first' })
  const second = record({ createdAt: 2_000, title: 'second' })
  await store.put(first)
  await store.put(second)
  await store.settle(first.reference, 'completed', 3_000)

  const listed = store.list('oc_chat')
  assert.deepEqual(listed.map((row) => row.title), ['second', 'first'])
  assert.equal(store.read(first.reference)?.status, 'completed')
  assert.equal(store.liveTasks().length, 1)

  // Settling twice keeps the first terminal outcome.
  await store.settle(first.reference, 'failed', 4_000)
  assert.equal(store.read(first.reference)?.status, 'completed')
  await assert.rejects(
    () => store.settle('ffffffffffff', 'stopped', 5_000),
    (error: unknown) => error instanceof ParallelTaskError && error.code === 'UNKNOWN',
  )
  assert.equal(store.read('not-a-reference'), undefined)
})

test('the store returns every row and leaves display bounds to its caller', async (t) => {
  const { store } = await openStore(t)
  for (let index = 0; index < MAX_TASKS_LISTED + 3; index += 1) {
    await store.put(record({ createdAt: 1_000 + index, title: `task ${index}` }))
  }
  // The docstring used to claim a bound the store never applied.
  assert.equal(store.list('oc_chat').length, MAX_TASKS_LISTED + 3)
})

test('a task list is scoped to its own conversation', async (t) => {
  const { store } = await openStore(t)
  await store.put(record({ scopeId: 'oc_a', title: 'mine' }))
  await store.put(record({ scopeId: 'oc_b', title: 'theirs' }))
  assert.deepEqual(store.list('oc_a').map((row) => row.title), ['mine'])
  assert.deepEqual(store.list('oc_b').map((row) => row.title), ['theirs'])
  assert.equal(store.list().length, 2)
})

test('a restart retires tasks whose process is gone and frees their project', async (t) => {
  const { store, ctx, namespace } = await openStore(t)
  const running = record({ workspaceKey: WS_A })
  await store.put(running)
  await store.close()

  const reopened = await DurableParallelTaskStore.open(ctx.storageDomain, namespace)
  t.after(() => reopened.close().catch(() => {}))
  assert.equal(reopened.read(running.reference)?.status, 'running')
  assert.equal(await reopened.reconcileOrphans(9_000), 1)
  assert.equal(reopened.read(running.reference)?.status, 'orphaned')
  assert.equal(taskIsLive(reopened.read(running.reference) as ParallelTaskRecord), false)

  // The freed project can be claimed again.
  assert.doesNotThrow(() => admitTask(reopened.liveTasks(), {
    scopeId: 'oc_chat',
    workspaceKey: WS_A,
    maxParallelTasks: 2,
    workspacePolicy: 'exclusive',
  }))
  assert.equal(await reopened.reconcileOrphans(10_000), 0)
})

test('the store rejects records that do not match its schema', async (t) => {
  const { store } = await openStore(t)
  await assert.rejects(() => store.put(record({ reference: 'NOTHEX' })))
  await assert.rejects(() => store.put(record({ status: 'weird' as never })))
  await assert.rejects(() => store.put(record({ title: '' })))
})
