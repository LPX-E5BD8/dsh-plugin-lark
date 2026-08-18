import { DEFAULT_INBOUND_TEXT_RESOURCE_BYTES } from './inbound-resource.ts'
import {
  DEFAULT_CONVERSATION_IMAGE_BYTES,
  DEFAULT_CONVERSATION_IMAGES,
  DEFAULT_INBOUND_IMAGE_BYTES,
  DEFAULT_INBOUND_IMAGE_PIXELS,
} from './inbound-image.ts'

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
  inboundImages: false,
  maxInboundImageBytes: DEFAULT_INBOUND_IMAGE_BYTES,
  maxInboundImagePixels: DEFAULT_INBOUND_IMAGE_PIXELS,
  maxConversationImages: DEFAULT_CONVERSATION_IMAGES,
  maxConversationImageBytes: DEFAULT_CONVERSATION_IMAGE_BYTES,
} as const

export const LARK_APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/i
export const MIN_STREAM_UPDATE_INTERVAL_MS = 100
