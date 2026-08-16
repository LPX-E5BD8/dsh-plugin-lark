import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { LarkBridge } from './bridge.ts'
import { DEFAULT_CONFIG, LARK_APP_ID_PATTERN } from './config.ts'
import { DurableInboundDeduplicator } from './inbound-dedup.ts'
import { LarkSdkClient } from './lark.ts'
import { LARK_LOCALES } from './locale.ts'
import type { LarkLocale } from './locale.ts'

export const name = 'lark'
export const inject = ['agents', 'storageDomain']

export interface LarkConfig {
  domain?: 'feishu' | 'lark'
  locale?: LarkLocale
  allowFrom?: string[]
  allowAllUsers?: boolean
  defaultSessionId?: string
  provider?: string
  model?: string
  streamUpdateIntervalMs?: number
}

export const Config: Schema = Schema.object({
  domain: Schema.union([Schema.const('feishu'), Schema.const('lark')]).default(DEFAULT_CONFIG.domain),
  locale: Schema.union(LARK_LOCALES.map((locale) => Schema.const(locale))).default(DEFAULT_CONFIG.locale),
  allowFrom: Schema.array(Schema.string()).default([]),
  allowAllUsers: Schema.boolean().default(DEFAULT_CONFIG.allowAllUsers),
  defaultSessionId: Schema.string().default(''),
  provider: Schema.string().default(DEFAULT_CONFIG.provider),
  model: Schema.string().default(DEFAULT_CONFIG.model),
  streamUpdateIntervalMs: Schema.number().default(DEFAULT_CONFIG.streamUpdateIntervalMs),
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
  return failures
}

export function apply(ctx: Context, config: LarkConfig): Promise<() => Promise<void>> {
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
    const deduplicator = await DurableInboundDeduplicator.open(ctx.storageDomain, appId)
    let bridge: LarkBridge | undefined
    try {
      const client = new LarkSdkClient({
        appId,
        appSecret,
        domain: config.domain ?? DEFAULT_CONFIG.domain,
        locale: config.locale ?? DEFAULT_CONFIG.locale,
      })
      bridge = new LarkBridge(ctx, {
        client,
        inboundDeduplicator: deduplicator,
        locale: config.locale ?? DEFAULT_CONFIG.locale,
        allowFrom: config.allowFrom ?? [],
        allowAllUsers: config.allowAllUsers ?? DEFAULT_CONFIG.allowAllUsers,
        defaultSessionId: config.defaultSessionId ?? '',
        provider: config.provider,
        model: config.model,
        streamUpdateIntervalMs: config.streamUpdateIntervalMs,
      })
      await bridge.start()
    } catch (error) {
      const failures = await cleanupRuntime(bridge, deduplicator)
      if (failures.length > 0) {
        throw new AggregateError([error, ...failures], 'lark: startup and cleanup failed')
      }
      throw error
    }
    let teardown: Promise<void> | undefined
    return () => {
      teardown ??= (async () => {
        const failures = await cleanupRuntime(bridge, deduplicator)
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
export { LarkSdkClient, splitText, unwrapCardAction } from './lark.ts'
export type { LarkCardAction, LarkCardActionResult, LarkClientLike, LarkInbound } from './lark.ts'
export { LARK_LOCALES } from './locale.ts'
export type { LarkLocale } from './locale.ts'
