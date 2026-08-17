import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import {
  CONVERSATION_MUTATION_HISTORY_LIMIT,
  DurableConversationBindingStore,
  type ConversationBinding,
  type ConversationModelSelection,
} from '../src/conversation-binding.ts'

interface MountedStore {
  readonly ctx: Context
  readonly store: DurableConversationBindingStore
  dispose(): Promise<void>
}

interface StoredBindingV1 {
  readonly schemaVersion: 1
  readonly generation: number
  readonly suffix: string | null
  readonly mutationHashes: readonly string[]
}

interface StoredBindingV2 {
  readonly schemaVersion: 2
  readonly generation: number
  readonly suffix: string | null
  readonly modelSelection: ConversationModelSelection | null
  readonly mutationHashes: readonly string[]
}

type StoredBinding = StoredBindingV1 | StoredBindingV2

const APP_ID = 'private-test-app'
const BASE_ID = 'private-test-conversation'
const MODEL_1: ConversationModelSelection = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
}
const MODEL_2: ConversationModelSelection = {
  provider: 'openai-compatible',
  model: 'vendor/model-v2',
}
const GENERATION_41: ConversationBinding = {
  generation: 41,
  suffix: '41-00000000-0000-4000-8000-000000000041',
  modelSelection: MODEL_1,
  mutationHashes: ['a'.repeat(64)],
}
const GENERATION_42: ConversationBinding = {
  generation: 42,
  suffix: '42-00000000-0000-4000-8000-000000000042',
  modelSelection: MODEL_2,
  mutationHashes: ['a'.repeat(64), 'b'.repeat(64)],
}

async function mountStore(root: string, appId = APP_ID): Promise<MountedStore> {
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    const store = await DurableConversationBindingStore.open(ctx.storageDomain, appId)
    let disposed = false
    return {
      ctx,
      store,
      async dispose() {
        if (disposed) return
        disposed = true
        try {
          await store.close()
        } finally {
          await ctx.fiber.dispose()
        }
      },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}

function expectedKey(appId: string, baseId: string): string {
  return createHash('sha256')
    .update('dsh-plugin-lark/conversation-binding/v1')
    .update('\0')
    .update(String(Buffer.byteLength(appId, 'utf8')))
    .update(':')
    .update(appId, 'utf8')
    .update(String(Buffer.byteLength(baseId, 'utf8')))
    .update(':')
    .update(baseId, 'utf8')
    .digest('hex')
}

function faultInjectingFacility(): {
  readonly facility: never
  readonly closeCalls: () => number
  failNextPut(): void
  holdNextPut(wait: Promise<void>): void
} {
  const records = new Map<string, StoredBinding>()
  let rejectNextPut = false
  let nextPutWait: Promise<void> | undefined
  let closes = 0
  const table = {
    get(key: string) { return records.get(key) },
    entries() { return records.entries() },
    keys() { return records.keys() },
    get size() { return records.size },
    async put(key: string, value: StoredBinding) {
      const wait = nextPutWait
      nextPutWait = undefined
      await wait
      if (rejectNextPut) {
        rejectNextPut = false
        throw new Error('injected conversation binding put failure')
      }
      records.set(key, value)
    },
  }
  const domain = {
    name: 'lark_conversations',
    global: undefined,
    table(name: string) {
      assert.equal(name, 'bindings')
      return table
    },
    async close() { closes += 1 },
  }
  return {
    facility: { async open() { return domain } } as never,
    closeCalls: () => closes,
    failNextPut() { rejectNextPut = true },
    holdNextPut(wait) { nextPutWait = wait },
  }
}

async function writeMedium(
  root: string,
  bindings: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(root, 'lark_conversations.json'), `${JSON.stringify({
    unit: { name: 'lark_conversations', version: 0 },
    global: null,
    tables: { bindings },
  }, null, 2)}\n`)
}

test('conversation bindings survive reopen and remain isolated by app id', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-conversation-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))

  const first = await mountStore(root)
  t.after(() => first.dispose())
  assert.equal(first.store.read(BASE_ID), undefined)
  await first.store.put(BASE_ID, {
    generation: 0,
    suffix: null,
    modelSelection: null,
    mutationHashes: [],
  })
  await first.store.put(BASE_ID, GENERATION_41)
  assert.deepEqual(first.store.read(BASE_ID), GENERATION_41)
  assert.equal(Object.isFrozen(first.store.read(BASE_ID)), true)
  assert.equal(Object.isFrozen(first.store.read(BASE_ID)?.modelSelection), true)
  assert.equal(Object.isFrozen(first.store.read(BASE_ID)?.mutationHashes), true)
  await first.dispose()

  const otherApp = await mountStore(root, 'other-private-test-app')
  t.after(() => otherApp.dispose())
  assert.equal(otherApp.store.read(BASE_ID), undefined)
  await otherApp.store.put(BASE_ID, GENERATION_42)
  await otherApp.dispose()

  const reopened = await mountStore(root)
  t.after(() => reopened.dispose())
  assert.deepEqual(reopened.store.read(BASE_ID), GENERATION_41)
})

test('the durable medium contains only hashed ids and the minimal versioned value', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-conversation-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const mounted = await mountStore(root)
  t.after(() => mounted.dispose())

  await mounted.store.put(BASE_ID, {
    generation: 0,
    suffix: null,
    modelSelection: null,
    mutationHashes: [],
  })
  const defaultMedium = JSON.parse(
    await readFile(join(root, 'lark_conversations.json'), 'utf8'),
  ) as { tables?: { bindings?: Record<string, unknown> } }
  assert.deepEqual(defaultMedium.tables?.bindings?.[expectedKey(APP_ID, BASE_ID)], {
    schemaVersion: 2,
    generation: 0,
    suffix: null,
    modelSelection: null,
    mutationHashes: [],
  })

  await mounted.store.put(BASE_ID, GENERATION_42)
  const medium = await readFile(join(root, 'lark_conversations.json'), 'utf8')
  assert.equal(medium.includes(APP_ID), false)
  assert.equal(medium.includes(BASE_ID), false)

  const document = JSON.parse(medium) as {
    tables?: { bindings?: Record<string, unknown> }
  }
  const bindings = document.tables?.bindings ?? {}
  assert.deepEqual(Object.keys(bindings), [expectedKey(APP_ID, BASE_ID)])
  assert.deepEqual(bindings[expectedKey(APP_ID, BASE_ID)], {
    schemaVersion: 2,
    generation: GENERATION_42.generation,
    suffix: GENERATION_42.suffix,
    modelSelection: GENERATION_42.modelSelection,
    mutationHashes: GENERATION_42.mutationHashes,
  })
})

test('schema v1 bindings read with a null model selection and upgrade on overwrite', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-conversation-binding-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const key = expectedKey(APP_ID, BASE_ID)
  await writeMedium(root, {
    [key]: {
      schemaVersion: 1,
      generation: GENERATION_41.generation,
      suffix: GENERATION_41.suffix,
      mutationHashes: GENERATION_41.mutationHashes,
    },
  })

  const mounted = await mountStore(root)
  t.after(() => mounted.dispose())
  const legacy = mounted.store.read(BASE_ID)
  assert.deepEqual(legacy, {
    generation: GENERATION_41.generation,
    suffix: GENERATION_41.suffix,
    modelSelection: null,
    mutationHashes: GENERATION_41.mutationHashes,
  })
  assert.equal(Object.isFrozen(legacy), true)
  assert.equal(Object.isFrozen(legacy?.mutationHashes), true)

  await mounted.store.put(BASE_ID, GENERATION_42)
  const medium = JSON.parse(
    await readFile(join(root, 'lark_conversations.json'), 'utf8'),
  ) as { tables?: { bindings?: Record<string, unknown> } }
  assert.deepEqual(medium.tables?.bindings?.[key], {
    schemaVersion: 2,
    generation: GENERATION_42.generation,
    suffix: GENERATION_42.suffix,
    modelSelection: GENERATION_42.modelSelection,
    mutationHashes: GENERATION_42.mutationHashes,
  })
})

test('a failed atomic overwrite leaves the previous binding authoritative', async (t) => {
  const injected = faultInjectingFacility()
  const store = await DurableConversationBindingStore.open(injected.facility, APP_ID)
  t.after(() => store.close())
  await store.put(BASE_ID, GENERATION_41)

  injected.failNextPut()
  await assert.rejects(
    store.put(BASE_ID, GENERATION_42),
    /injected conversation binding put failure/,
  )
  assert.deepEqual(store.read(BASE_ID), GENERATION_41)

  await store.put(BASE_ID, GENERATION_42)
  assert.deepEqual(store.read(BASE_ID), GENERATION_42)
})

test('binding inputs are strictly validated and fail closed', async (t) => {
  await assert.rejects(
    DurableConversationBindingStore.open({} as never, ''),
    /appId must be a non-blank string/,
  )
  const injected = faultInjectingFacility()
  const store = await DurableConversationBindingStore.open(injected.facility, APP_ID)
  t.after(() => store.close())

  assert.throws(() => store.read(''), /baseId must be a non-blank string/)
  assert.throws(() => store.read('\ud800'), /baseId must be a non-blank string/)
  assert.throws(
    () => store.put(BASE_ID, {
      generation: 1,
      suffix: null,
      modelSelection: null,
      mutationHashes: [],
    }),
    /suffix does not match its generation/,
  )
  assert.throws(
    () => store.put(BASE_ID, {
      generation: 2,
      suffix: GENERATION_41.suffix,
      modelSelection: null,
      mutationHashes: [],
    }),
    /suffix does not match its generation/,
  )
  assert.throws(
    () => store.put(BASE_ID, {
      generation: -0,
      suffix: null,
      modelSelection: null,
      mutationHashes: [],
    }),
  )
  assert.throws(
    () => store.put(BASE_ID, {
      generation: 0,
      suffix: null,
      mutationHashes: [],
    } as never),
  )
  assert.throws(
    () => store.put(BASE_ID, {
      generation: 0,
      suffix: null,
      modelSelection: null,
      mutationHashes: [],
      extra: true,
    } as never),
  )
  assert.throws(
    () => store.put(BASE_ID, {
      generation: 0,
      suffix: null,
      modelSelection: null,
      mutationHashes: ['a'.repeat(64), 'a'.repeat(64)],
    }),
    /mutation hashes must be unique/,
  )
  const excessiveHashes = Array.from(
    { length: CONVERSATION_MUTATION_HISTORY_LIMIT + 1 },
    (_, index) => createHash('sha256').update(String(index)).digest('hex'),
  )
  assert.throws(
    () => store.put(BASE_ID, {
      generation: 0,
      suffix: null,
      modelSelection: null,
      mutationHashes: excessiveHashes,
    }),
  )

  const invalidModelSelections: Array<{
    readonly selection: unknown
    readonly message: RegExp
  }> = [
    {
      selection: { provider: '', model: MODEL_1.model },
      message: /provider must be a non-blank trimmed string/,
    },
    {
      selection: { provider: MODEL_1.provider, model: '   ' },
      message: /model must be a non-blank trimmed string/,
    },
    {
      selection: { provider: ' deepseek', model: MODEL_1.model },
      message: /provider must be a non-blank trimmed string/,
    },
    {
      selection: { provider: 'deep\nseek', model: MODEL_1.model },
      message: /provider must not contain control characters/,
    },
    {
      selection: { provider: MODEL_1.provider, model: '\ud800' },
      message: /model must be well-formed Unicode/,
    },
    {
      selection: { provider: 'p'.repeat(257), model: MODEL_1.model },
      message: /provider exceeds 256 characters/,
    },
    {
      selection: { provider: MODEL_1.provider, model: 'm'.repeat(513) },
      message: /model exceeds 512 characters/,
    },
    {
      selection: { ...MODEL_1, apiKey: 'sk-must-never-be-persisted' },
      message: /unrecognized key/i,
    },
  ]
  for (const { selection, message } of invalidModelSelections) {
    assert.throws(
      () => store.put(BASE_ID, {
        generation: 0,
        suffix: null,
        modelSelection: selection,
        mutationHashes: [],
      } as never),
      message,
    )
  }
})

test('malformed persisted keys and values prevent the store from opening', async (t) => {
  const invalidKeyRoot = await mkdtemp(join(tmpdir(), 'dsh-lark-conversation-binding-'))
  const invalidValueRoot = await mkdtemp(join(tmpdir(), 'dsh-lark-conversation-binding-'))
  t.after(() => Promise.all([
    rm(invalidKeyRoot, { recursive: true, force: true }),
    rm(invalidValueRoot, { recursive: true, force: true }),
  ]))

  await writeMedium(invalidKeyRoot, {
    'not-a-hashed-key': {
      schemaVersion: 1,
      generation: GENERATION_41.generation,
      suffix: GENERATION_41.suffix,
      mutationHashes: GENERATION_41.mutationHashes,
    },
  })
  await assert.rejects(
    mountStore(invalidKeyRoot),
    /persisted conversation binding key is invalid/,
  )

  await writeMedium(invalidValueRoot, {
    ['0'.repeat(64)]: {
      schemaVersion: 2,
      generation: GENERATION_41.generation,
      suffix: GENERATION_41.suffix,
      mutationHashes: GENERATION_41.mutationHashes,
    },
  })
  await assert.rejects(
    mountStore(invalidValueRoot),
    /does not match its schema/,
  )

  await writeMedium(invalidValueRoot, {
    ['0'.repeat(64)]: {
      schemaVersion: 2,
      generation: GENERATION_41.generation,
      suffix: GENERATION_41.suffix,
      modelSelection: {
        ...MODEL_1,
        apiKey: 'sk-must-never-be-persisted',
      },
      mutationHashes: GENERATION_41.mutationHashes,
    },
  })
  await assert.rejects(
    mountStore(invalidValueRoot),
    /does not match its schema/,
  )

  await writeMedium(invalidValueRoot, {
    ['0'.repeat(64)]: {
      schemaVersion: 1,
      generation: GENERATION_41.generation,
      suffix: GENERATION_41.suffix,
      modelSelection: null,
      mutationHashes: GENERATION_41.mutationHashes,
    },
  })
  await assert.rejects(
    mountStore(invalidValueRoot),
    /does not match its schema/,
  )
})

test('close is idempotent, drains admitted writes, and rejects later writes', async () => {
  const injected = faultInjectingFacility()
  const store = await DurableConversationBindingStore.open(injected.facility, APP_ID)
  const gate = Promise.withResolvers<void>()
  injected.holdNextPut(gate.promise)
  const write = store.put(BASE_ID, GENERATION_41)
  const firstClose = store.close()
  const secondClose = store.close()
  assert.equal(firstClose, secondClose)
  await Promise.resolve()
  assert.equal(injected.closeCalls(), 0)
  gate.resolve()
  await Promise.all([write, firstClose, secondClose])
  assert.equal(injected.closeCalls(), 1)
  await assert.rejects(
    store.put(BASE_ID, GENERATION_41),
    /conversation binding store is closing/,
  )
})
