import { DEFAULT_INBOUND_TEXT_RESOURCE_BYTES } from './inbound-resource.ts'
import {
  DEFAULT_CONVERSATION_IMAGE_BYTES,
  DEFAULT_CONVERSATION_IMAGES,
  DEFAULT_INBOUND_IMAGE_BYTES,
  DEFAULT_INBOUND_IMAGE_PIXELS,
} from './inbound-image.ts'
import {
  DEFAULT_OUTBOUND_IMAGE_BYTES,
  DEFAULT_OUTBOUND_IMAGE_PIXELS,
  DEFAULT_OUTBOUND_TEXT_BYTES,
} from './outbound-artifact.ts'
import { DEFAULT_PROACTIVE_DELIVERY } from './outbound-notify.ts'

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
  outboundArtifacts: false,
  maxOutboundTextFileBytes: DEFAULT_OUTBOUND_TEXT_BYTES,
  maxOutboundImageBytes: DEFAULT_OUTBOUND_IMAGE_BYTES,
  maxOutboundImagePixels: DEFAULT_OUTBOUND_IMAGE_PIXELS,
  proactiveDelivery: DEFAULT_PROACTIVE_DELIVERY,
} as const

export const LARK_APP_ID_PATTERN = /^cli_[0-9a-f]{16}$/i
export const MIN_STREAM_UPDATE_INTERVAL_MS = 100
