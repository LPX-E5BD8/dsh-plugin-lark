import { createHash } from 'node:crypto'
import type { Domain, DomainFacility, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export interface ConversationModelSelection {
  readonly provider: string
  readonly model: string
}

export interface ConversationBinding {
  readonly generation: number
  readonly suffix: string | null
  readonly modelSelection: ConversationModelSelection | null
  readonly mutationHashes: readonly string[]
}

export interface ConversationBindingStore {
  read(baseId: string): ConversationBinding | undefined
  put(baseId: string, binding: ConversationBinding): Promise<void>
  close(): Promise<void>
}

type ConversationKey = string & { readonly __conversationKey: unique symbol }

const LEGACY_CONVERSATION_BINDING_SCHEMA_VERSION = 1
const CONVERSATION_BINDING_SCHEMA_VERSION = 2
export const CONVERSATION_MUTATION_HISTORY_LIMIT = 1_024
const CONVERSATION_KEY_PATTERN = /^[0-9a-f]{64}$/u
const CONVERSATION_KEY_HASH_DOMAIN = 'dsh-plugin-lark/conversation-binding/v1'
const SESSION_SUFFIX_PATTERN = /^([1-9]\d{0,15})-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MUTATION_HASH_PATTERN = /^[0-9a-f]{64}$/u
const CONTROL_CHARACTER_PATTERN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u
const MAX_PROVIDER_ID_LENGTH = 256
const MAX_MODEL_ID_LENGTH = 512

const generationSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
  .refine((generation) => !Object.is(generation, -0))

const mutationHashesSchema = z.array(z.string().regex(MUTATION_HASH_PATTERN))
  .max(CONVERSATION_MUTATION_HISTORY_LIMIT)
  .refine((hashes) => new Set(hashes).size === hashes.length, {
    message: 'conversation binding mutation hashes must be unique',
  })
  .readonly()

function modelIdentifierSchema(name: 'provider' | 'model', maxLength: number) {
  return z.string()
    .max(maxLength, `conversation model ${name} exceeds ${maxLength} characters`)
    .refine((value) => value !== '' && value.trim() === value, {
      message: `conversation model ${name} must be a non-blank trimmed string`,
    })
    .refine((value) => value.isWellFormed(), {
      message: `conversation model ${name} must be well-formed Unicode`,
    })
    .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
      message: `conversation model ${name} must not contain control characters`,
    })
}

const conversationModelSelectionSchema = z.object({
  provider: modelIdentifierSchema('provider', MAX_PROVIDER_ID_LENGTH),
  model: modelIdentifierSchema('model', MAX_MODEL_ID_LENGTH),
}).strict()

const conversationBindingSchema = z.object({
  generation: generationSchema,
  suffix: z.string().regex(SESSION_SUFFIX_PATTERN).nullable(),
  modelSelection: conversationModelSelectionSchema.nullable(),
  mutationHashes: mutationHashesSchema,
}).strict().refine(bindingMatchesGeneration, {
  message: 'conversation binding suffix does not match its generation',
})

const storedConversationBindingV1Schema = z.object({
  schemaVersion: z.literal(LEGACY_CONVERSATION_BINDING_SCHEMA_VERSION),
  generation: generationSchema,
  suffix: z.string().regex(SESSION_SUFFIX_PATTERN).nullable(),
  mutationHashes: mutationHashesSchema,
}).strict()

const storedConversationBindingV2Schema = z.object({
  schemaVersion: z.literal(CONVERSATION_BINDING_SCHEMA_VERSION),
  generation: generationSchema,
  suffix: z.string().regex(SESSION_SUFFIX_PATTERN).nullable(),
  modelSelection: conversationModelSelectionSchema.nullable(),
  mutationHashes: mutationHashesSchema,
}).strict()

const storedConversationBindingSchema = z.discriminatedUnion('schemaVersion', [
  storedConversationBindingV1Schema,
  storedConversationBindingV2Schema,
]).refine(bindingMatchesGeneration, {
  message: 'persisted conversation binding suffix does not match its generation',
})

type StoredConversationBinding = z.infer<typeof storedConversationBindingSchema>

export const larkConversationsDomainSpec = defineDomain({
  name: 'lark_conversations',
  version: 0,
  tables: {
    bindings: domainTable<ConversationKey, StoredConversationBinding>(
      storedConversationBindingSchema,
    ),
  },
})

type ConversationsDomain = Domain<typeof larkConversationsDomainSpec>
type ConversationTable = KvTable<ConversationKey, StoredConversationBinding>

function bindingMatchesGeneration(binding: {
  readonly generation: number
  readonly suffix: string | null
}): boolean {
  if (binding.generation === 0) return binding.suffix === null
  if (binding.suffix === null) return false
  const match = SESSION_SUFFIX_PATTERN.exec(binding.suffix)
  return match?.[1] === String(binding.generation)
}

function validatedIdentifier(value: string, name: 'appId' | 'baseId'): string {
  if (typeof value !== 'string' || value.trim() === '' || !value.isWellFormed()) {
    throw new TypeError(`lark: conversation binding ${name} must be a non-blank string`)
  }
  return value
}

function conversationKey(appId: string, baseId: string): ConversationKey {
  const validatedBaseId = validatedIdentifier(baseId, 'baseId')
  return createHash('sha256')
    .update(CONVERSATION_KEY_HASH_DOMAIN)
    .update('\0')
    .update(String(Buffer.byteLength(appId, 'utf8')))
    .update(':')
    .update(appId, 'utf8')
    .update(String(Buffer.byteLength(validatedBaseId, 'utf8')))
    .update(':')
    .update(validatedBaseId, 'utf8')
    .digest('hex') as ConversationKey
}

function publicBinding(binding: StoredConversationBinding): ConversationBinding {
  const modelSelection = binding.schemaVersion === LEGACY_CONVERSATION_BINDING_SCHEMA_VERSION
    || binding.modelSelection === null
    ? null
    : Object.freeze({
        provider: binding.modelSelection.provider,
        model: binding.modelSelection.model,
      })
  return Object.freeze({
    generation: binding.generation,
    suffix: binding.suffix,
    modelSelection,
    mutationHashes: Object.freeze([...binding.mutationHashes]),
  })
}

export class DurableConversationBindingStore implements ConversationBindingStore {
  private operationTail: Promise<void> = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined

  private constructor(
    private readonly domain: ConversationsDomain,
    private readonly table: ConversationTable,
    private readonly appId: string,
  ) {}

  static async open(
    facility: DomainFacility,
    appId: string,
  ): Promise<DurableConversationBindingStore> {
    const validatedAppId = validatedIdentifier(appId, 'appId')
    const domain = await facility.open(larkConversationsDomainSpec)
    try {
      const store = new DurableConversationBindingStore(
        domain,
        domain.table('bindings'),
        validatedAppId,
      )
      store.validatePersistedRecords()
      return store
    } catch (error) {
      try {
        await domain.close()
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'lark: conversation binding open and cleanup failed',
        )
      }
      throw error
    }
  }

  read(baseId: string): ConversationBinding | undefined {
    const stored = this.table.get(conversationKey(this.appId, baseId))
    return stored === undefined ? undefined : publicBinding(stored)
  }

  put(baseId: string, binding: ConversationBinding): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('lark: conversation binding store is closing'))
    }
    const key = conversationKey(this.appId, baseId)
    const parsed = conversationBindingSchema.parse(binding)
    const modelSelection = parsed.modelSelection === null
      ? null
      : Object.freeze({
          provider: parsed.modelSelection.provider,
          model: parsed.modelSelection.model,
        })
    const stored = Object.freeze({
      schemaVersion: CONVERSATION_BINDING_SCHEMA_VERSION,
      generation: parsed.generation,
      suffix: parsed.suffix,
      modelSelection,
      mutationHashes: Object.freeze([...parsed.mutationHashes]),
    })
    const operation = this.operationTail.then(() => this.table.put(key, stored))
    this.operationTail = operation.catch(() => {})
    return operation
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.closePromise = this.operationTail.then(() => this.domain.close())
    return this.closePromise
  }

  private validatePersistedRecords(): void {
    for (const [key, binding] of this.table.entries()) {
      if (!CONVERSATION_KEY_PATTERN.test(key)) {
        throw new TypeError('lark: persisted conversation binding key is invalid')
      }
      storedConversationBindingSchema.parse(binding)
    }
  }
}
