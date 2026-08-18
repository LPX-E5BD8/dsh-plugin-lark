import { DEFAULT_INBOUND_TEXT_RESOURCE_BYTES } from './inbound-resource.ts'

export const DEFAULT_CONFIG = {
  domain: 'feishu',
  locale: 'zh-CN',
  allowAllUsers: false,
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  sessionPrefix: 'lark',
  streamUpdateIntervalMs: 1_000,
  maxConversationHandles: 32,
  inboundTextFiles: false,
  maxInboundTextFileBytes: DEFAULT_INBOUND_TEXT_RESOURCE_BYTES,
} as const

export const LARK_APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/i
export const MIN_STREAM_UPDATE_INTERVAL_MS = 100
