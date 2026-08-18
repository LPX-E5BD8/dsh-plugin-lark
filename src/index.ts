import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LarkBridge } from './bridge.ts'
import { DEFAULT_CONFIG, LARK_APP_ID_PATTERN } from './config.ts'
import { DurableConversationBindingStore } from './conversation-binding.ts'
import { installLarkHealthRoute } from './health.ts'
import {
  MAX_CONVERSATION_IMAGE_BYTES,
  MAX_CONVERSATION_IMAGES,
  MAX_INBOUND_IMAGE_BYTES,
  MAX_INBOUND_IMAGE_PIXELS,
} from './inbound-image.ts'
import { MAX_INBOUND_TEXT_RESOURCE_BYTES } from './inbound-resource.ts'
import {
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_IMAGE_PIXELS,
  MAX_OUTBOUND_TEXT_BYTES,
} from './outbound-artifact.ts'
import { DurableInboundDeduplicator } from './inbound-dedup.ts'
import { DurableNotifyOutbox } from './outbound-notify.ts'
import { LarkSdkClient } from './lark.ts'
import { LARK_LOCALES } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export const name = 'lark'
export const inject = ['agents', 'storageDomain', 'sessions', 'tools']

export interface LarkConfig {
  domain?: 'feishu' | 'lark'
  locale?: LarkLocale
  allowFrom?: string[]
  allowAllUsers?: boolean
  projectManageFrom?: string[]
  defaultSessionId?: string
  provider?: string
  model?: string
  streamUpdateIntervalMs?: number
  maxConversationHandles?: number
  inboundTextFiles?: boolean
  maxInboundTextFileBytes?: number
  inboundImages?: boolean
  maxInboundImageBytes?: number
  maxInboundImagePixels?: number
  maxConversationImages?: number
  maxConversationImageBytes?: number
  outboundArtifacts?: boolean
  maxOutboundTextFileBytes?: number
  maxOutboundImageBytes?: number
  maxOutboundImagePixels?: number
  proactiveDelivery?: boolean
}

export const Config: Schema = Schema.object({
  domain: Schema.union([Schema.const('feishu'), Schema.const('lark')]).default(DEFAULT_CONFIG.domain),
  locale: Schema.union(LARK_LOCALES.map((locale) => Schema.const(locale))).default(DEFAULT_CONFIG.locale),
  allowFrom: Schema.array(Schema.string()).default([]),
  allowAllUsers: Schema.boolean().default(DEFAULT_CONFIG.allowAllUsers),
  projectManageFrom: Schema.array(Schema.string()).default([]),
  defaultSessionId: Schema.string().default(''),
  provider: Schema.string().default(DEFAULT_CONFIG.provider),
  model: Schema.string().default(DEFAULT_CONFIG.model),
  streamUpdateIntervalMs: Schema.number().default(DEFAULT_CONFIG.streamUpdateIntervalMs),
  maxConversationHandles: Schema.natural()
    .max(Number.MAX_SAFE_INTEGER)
    .default(DEFAULT_CONFIG.maxConversationHandles),
  inboundTextFiles: Schema.boolean().default(DEFAULT_CONFIG.inboundTextFiles),
  maxInboundTextFileBytes: Schema.natural()
    .min(1)
    .max(MAX_INBOUND_TEXT_RESOURCE_BYTES)
    .default(DEFAULT_CONFIG.maxInboundTextFileBytes),
  inboundImages: Schema.boolean().default(DEFAULT_CONFIG.inboundImages),
  maxInboundImageBytes: Schema.natural()
    .min(1)
    .max(MAX_INBOUND_IMAGE_BYTES)
    .default(DEFAULT_CONFIG.maxInboundImageBytes),
  maxInboundImagePixels: Schema.natural()
    .min(1)
    .max(MAX_INBOUND_IMAGE_PIXELS)
    .default(DEFAULT_CONFIG.maxInboundImagePixels),
  maxConversationImages: Schema.natural()
    .min(1)
    .max(MAX_CONVERSATION_IMAGES)
    .default(DEFAULT_CONFIG.maxConversationImages),
  maxConversationImageBytes: Schema.natural()
    .min(1)
    .max(MAX_CONVERSATION_IMAGE_BYTES)
    .default(DEFAULT_CONFIG.maxConversationImageBytes),
  outboundArtifacts: Schema.boolean().default(DEFAULT_CONFIG.outboundArtifacts),
  maxOutboundTextFileBytes: Schema.natural()
    .min(1)
    .max(MAX_OUTBOUND_TEXT_BYTES)
    .default(DEFAULT_CONFIG.maxOutboundTextFileBytes),
  maxOutboundImageBytes: Schema.natural()
    .min(1)
    .max(MAX_OUTBOUND_IMAGE_BYTES)
    .default(DEFAULT_CONFIG.maxOutboundImageBytes),
  maxOutboundImagePixels: Schema.natural()
    .min(1)
    .max(MAX_OUTBOUND_IMAGE_PIXELS)
    .default(DEFAULT_CONFIG.maxOutboundImagePixels),
  proactiveDelivery: Schema.boolean().default(DEFAULT_CONFIG.proactiveDelivery),
})

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

async function cleanupRuntime(
  bridge: LarkBridge | undefined,
  deduplicator: DurableInboundDeduplicator,
  conversationBindings: DurableConversationBindingStore,
  notifyOutbox?: DurableNotifyOutbox,
): Promise<unknown[]> {
  const failures: unknown[] = []
  if (bridge !== undefined) {
    try {
      await bridge.stop()
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    await deduplicator.close()
  } catch (error) {
    failures.push(error)
  }
  try {
    await conversationBindings.close()
  } catch (error) {
    failures.push(error)
  }
  if (notifyOutbox !== undefined) {
    try {
      await notifyOutbox.close()
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

async function openRuntimeStorage(
  ctx: Context,
  appId: string,
  proactiveDelivery: boolean,
): Promise<{
  readonly deduplicator: DurableInboundDeduplicator
  readonly conversationBindings: DurableConversationBindingStore
  readonly notifyOutbox?: DurableNotifyOutbox
}> {
  const deduplicator = await DurableInboundDeduplicator.open(ctx.storageDomain, appId)
  try {
    const conversationBindings = await DurableConversationBindingStore.open(ctx.storageDomain, appId)
    if (!proactiveDelivery) return { deduplicator, conversationBindings }
    try {
      const notifyOutbox = await DurableNotifyOutbox.open(ctx.storageDomain, appId)
      return { deduplicator, conversationBindings, notifyOutbox }
    } catch (error) {
      await conversationBindings.close().catch(() => {})
      throw error
    }
  } catch (error) {
    try {
      await deduplicator.close()
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'lark: runtime storage startup and cleanup failed',
      )
    }
    throw error
  }
}

export const apply = (ctx: Context, config: LarkConfig): Promise<() => Promise<void>> => {
  const appId = firstNonEmpty(process.env.DSH_LARK_APP_ID)
  const appSecret = firstNonEmpty(
    process.env.DSH_LARK_APP_SECRET,
    process.env.FEISHU_APP_SECRET,
  )
  if (appId === undefined || appSecret === undefined) {
    throw new Error('lark: missing appId/appSecret (set DSH_LARK_APP_ID and DSH_LARK_APP_SECRET)')
  }
  if (!LARK_APP_ID_PATTERN.test(appId)) {
    throw new Error('lark: appId must match cli_<16 hexadecimal characters>')
  }
  return (async () => {
    const { deduplicator, conversationBindings, notifyOutbox } = await openRuntimeStorage(
      ctx,
      appId,
      config.proactiveDelivery === true,
    )
    let bridge: LarkBridge | undefined
    try {
      const client = new LarkSdkClient({
        appId,
        appSecret,
        domain: config.domain ?? DEFAULT_CONFIG.domain,
        locale: config.locale ?? DEFAULT_CONFIG.locale,
        inboundTextFiles: config.inboundTextFiles ?? DEFAULT_CONFIG.inboundTextFiles,
        inboundImages: config.inboundImages ?? DEFAULT_CONFIG.inboundImages,
      })
      installLarkHealthRoute(ctx, () => client.connectionHealth())
      bridge = new LarkBridge(ctx, {
        client,
        inboundDeduplicator: deduplicator,
        conversationBindings,
        locale: config.locale ?? DEFAULT_CONFIG.locale,
        allowFrom: config.allowFrom ?? [],
        allowAllUsers: config.allowAllUsers ?? DEFAULT_CONFIG.allowAllUsers,
        projectManageFrom: config.projectManageFrom ?? [],
        defaultSessionId: config.defaultSessionId ?? '',
        provider: config.provider,
        model: config.model,
        streamUpdateIntervalMs: config.streamUpdateIntervalMs,
        maxConversationHandles: config.maxConversationHandles,
        inboundTextFiles: config.inboundTextFiles,
        maxInboundTextFileBytes: config.maxInboundTextFileBytes,
        inboundImages: config.inboundImages,
        maxInboundImageBytes: config.maxInboundImageBytes,
        maxInboundImagePixels: config.maxInboundImagePixels,
        maxConversationImages: config.maxConversationImages,
        maxConversationImageBytes: config.maxConversationImageBytes,
        outboundArtifacts: config.outboundArtifacts,
        maxOutboundTextFileBytes: config.maxOutboundTextFileBytes,
        maxOutboundImageBytes: config.maxOutboundImageBytes,
        maxOutboundImagePixels: config.maxOutboundImagePixels,
        sessionReferenceNamespace: appId,
        notifyOutbox,
        proactiveDelivery: config.proactiveDelivery,
      })
      await bridge.start()
    } catch (error) {
      const failures = await cleanupRuntime(bridge, deduplicator, conversationBindings, notifyOutbox)
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], 'lark: startup and cleanup failed')
      }
      throw error
    }
    let teardown: Promise<void> | undefined
    return () => {
      teardown ??= (async () => {
        const failures = await cleanupRuntime(bridge, deduplicator, conversationBindings, notifyOutbox)
        if (failures.length > 0) throw new AggregateError(failures, 'lark: plugin teardown failed')
      })()
      return teardown
    }
  })()
}

export { LarkBridge } from './bridge.ts'
export {
  renderApprovalCard as approvalCard,
  renderApprovalDecisionCard as decidedCard,
} from './cards.ts'
export { LarkResourceError, LarkSdkClient, splitText, unwrapCardAction } from './lark.ts'
export type {
  LarkArtifactDeliveryOptions,
  LarkArtifactUploadInput,
  LarkArtifactUploadOptions,
  LarkCardAction,
  LarkCardActionResult,
  LarkClientLike,
  LarkConnectionHealth,
  LarkConnectionState,
  LarkDownloadedResource,
  LarkDeliveryOptions,
  LarkInbound,
  LarkInboundResource,
  LarkResourceDownloadOptions,
  LarkResourceErrorCode,
  LarkUploadedArtifact,
} from './lark.ts'
export { LARK_LOCALES } from './locale.ts'
export type { LarkLocale } from './locale.ts'
export { DurableConversationBindingStore } from './conversation-binding.ts'
export type {
  ConversationBinding,
  ConversationBindingStore,
  ConversationModelSelection,
} from './conversation-binding.ts'
