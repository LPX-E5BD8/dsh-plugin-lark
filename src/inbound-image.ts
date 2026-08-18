import type { ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'

export const MAX_INBOUND_IMAGE_BYTES = 5 * 1024 * 1024
export const DEFAULT_INBOUND_IMAGE_BYTES = MAX_INBOUND_IMAGE_BYTES
export const MAX_INBOUND_IMAGE_PIXELS = 20_000_000
export const DEFAULT_INBOUND_IMAGE_PIXELS = MAX_INBOUND_IMAGE_PIXELS
export const MAX_CONVERSATION_IMAGES = 20
export const DEFAULT_CONVERSATION_IMAGES = 4
export const MAX_CONVERSATION_IMAGE_BYTES = 20 * 1024 * 1024
export const DEFAULT_CONVERSATION_IMAGE_BYTES = MAX_CONVERSATION_IMAGE_BYTES

export type StaticImageMediaType = 'image/png' | 'image/jpeg'

export type InboundImageErrorCode =
  | 'IMAGE_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TOO_MANY_PIXELS'
  | 'IMAGE_TYPE_UNSUPPORTED'
  | 'IMAGE_REFERENCE_INVALID'
  | 'IMAGE_AGGREGATE_LIMIT'

export class InboundImageError extends Error {
  constructor(readonly code: InboundImageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'InboundImageError'
  }
}

export interface PreparedInboundImage {
  readonly input: SaveImageAttachment & { readonly mediaType: StaticImageMediaType }
  readonly width: number
  readonly height: number
}

export interface ImageContentStats {
  readonly count: number
  readonly bytes: number
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const PNG_STATIC_FORBIDDEN_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT'])
const PNG_ALLOWED_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND'])
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7])
const JPEG_UNSUPPORTED_SOF_MARKERS = new Set([
  0xc1, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])
const ATTACHMENT_ID_CONTROL_PATTERN = /[\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

const PNG_CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

function invalidImage(message: string): never {
  throw new InboundImageError('IMAGE_INVALID', message)
}

function checkedPixels(width: number, height: number, maxPixels: number): void {
  if (!Number.isSafeInteger(width) || width <= 0
    || !Number.isSafeInteger(height) || height <= 0) {
    invalidImage('lark: image dimensions are invalid')
  }
  const pixels = width * height
  if (!Number.isSafeInteger(pixels)) invalidImage('lark: image dimensions overflow')
  if (pixels > maxPixels) {
    throw new InboundImageError(
      'IMAGE_TOO_MANY_PIXELS',
      'lark: image exceeds the configured pixel limit',
    )
  }
}

function startsWith(data: Uint8Array, prefix: Uint8Array): boolean {
  return data.length >= prefix.length && prefix.every((value, index) => data[index] === value)
}

function ascii(data: Uint8Array, start: number, length: number): string {
  let value = ''
  for (let index = start; index < start + length; index += 1) {
    const code = data[index]
    if (code === undefined || code < 0x41 || (code > 0x5a && code < 0x61) || code > 0x7a) {
      invalidImage('lark: PNG chunk type is invalid')
    }
    value += String.fromCharCode(code)
  }
  return value
}

function pngCrc(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let index = start; index < end; index += 1) {
    crc = (PNG_CRC_TABLE[(crc ^ (data[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function parseStaticPng(data: Uint8Array, maxPixels: number): { width: number; height: number } {
  if (!startsWith(data, PNG_SIGNATURE)) invalidImage('lark: PNG signature is invalid')
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let sawHeader = false
  let sawPalette = false
  let sawImageData = false
  let imageDataEnded = false
  while (offset < data.length) {
    if (data.length - offset < 12) invalidImage('lark: PNG chunk is truncated')
    const length = view.getUint32(offset, false)
    if (length > data.length - offset - 12) invalidImage('lark: PNG chunk length is invalid')
    const type = ascii(data, offset + 4, 4)
    const dataStart = offset + 8
    const crcOffset = dataStart + length
    const nextOffset = crcOffset + 4
    if (pngCrc(data, offset + 4, crcOffset) !== view.getUint32(crcOffset, false)) {
      invalidImage('lark: PNG chunk checksum is invalid')
    }
    if (!sawHeader && type !== 'IHDR') invalidImage('lark: PNG header is not first')
    if (PNG_STATIC_FORBIDDEN_CHUNKS.has(type)) {
      throw new InboundImageError('IMAGE_TYPE_UNSUPPORTED', 'lark: animated PNG is unsupported')
    }
    if (type[0] === type[0]?.toUpperCase() && !PNG_ALLOWED_CRITICAL_CHUNKS.has(type)) {
      invalidImage('lark: PNG contains an unknown critical chunk')
    }
    if (type === 'IHDR') {
      if (sawHeader || length !== 13 || offset !== PNG_SIGNATURE.length) {
        invalidImage('lark: PNG header is invalid')
      }
      sawHeader = true
      width = view.getUint32(dataStart, false)
      height = view.getUint32(dataStart + 4, false)
      checkedPixels(width, height, maxPixels)
    } else if (type === 'PLTE') {
      if (sawPalette || sawImageData || length === 0 || length % 3 !== 0 || length > 768) {
        invalidImage('lark: PNG palette is invalid')
      }
      sawPalette = true
    } else if (type === 'IDAT') {
      if (imageDataEnded || length === 0) invalidImage('lark: PNG image data is invalid')
      sawImageData = true
    } else if (sawImageData) {
      imageDataEnded = true
    }
    if (type === 'IEND') {
      if (length !== 0 || !sawImageData || nextOffset !== data.length) {
        invalidImage('lark: PNG end marker or trailing data is invalid')
      }
      return { width, height }
    }
    offset = nextOffset
  }
  return invalidImage('lark: PNG end marker is missing')
}

function segmentHasMpf(data: Uint8Array, start: number, end: number): boolean {
  for (let index = start; index + 3 < end; index += 1) {
    if (data[index] === 0x4d && data[index + 1] === 0x50
      && data[index + 2] === 0x46 && data[index + 3] === 0x00) return true
  }
  return false
}

function jpegSegmentEnd(view: DataView, offset: number, dataLength: number): number {
  if (dataLength - offset < 2) return invalidImage('lark: JPEG segment length is missing')
  const length = view.getUint16(offset, false)
  if (length < 2 || length > dataLength - offset) {
    return invalidImage('lark: JPEG segment length is invalid')
  }
  return offset + length
}

function nextJpegScanMarker(
  data: Uint8Array,
  initialOffset: number,
): { readonly marker: number; readonly offset: number } {
  let offset = initialOffset
  while (offset < data.length) {
    if (data[offset] !== 0xff) {
      offset += 1
      continue
    }
    while (data[offset] === 0xff) offset += 1
    const marker = data[offset]
    offset += 1
    if (marker === 0x00 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker !== undefined) return { marker, offset }
  }
  return invalidImage('lark: JPEG scan is truncated')
}

function parseStaticJpeg(data: Uint8Array, maxPixels: number): { width: number; height: number } {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    invalidImage('lark: JPEG signature is invalid')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 2
  let inScan = false
  let sawFrame = false
  let sawScan = false
  let width = 0
  let height = 0
  while (offset < data.length) {
    let marker: number | undefined
    if (inScan) {
      const next = nextJpegScanMarker(data, offset)
      marker = next.marker
      offset = next.offset
      inScan = false
    } else {
      if (data[offset] !== 0xff) invalidImage('lark: JPEG marker prefix is invalid')
      while (data[offset] === 0xff) offset += 1
      marker = data[offset]
      offset += 1
      if (marker === undefined || marker === 0x00) invalidImage('lark: JPEG marker is invalid')
    }
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || offset !== data.length) {
        invalidImage('lark: JPEG end marker or trailing data is invalid')
      }
      return { width, height }
    }
    if (marker === 0xd8) {
      throw new InboundImageError('IMAGE_TYPE_UNSUPPORTED', 'lark: multi-image JPEG is unsupported')
    }
    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      invalidImage('lark: JPEG standalone marker is outside scan data')
    }
    const segmentStart = offset + 2
    const segmentEnd = jpegSegmentEnd(view, offset, data.length)
    if (marker === 0xe2 && segmentHasMpf(data, segmentStart, segmentEnd)) {
      throw new InboundImageError('IMAGE_TYPE_UNSUPPORTED', 'lark: MPO JPEG is unsupported')
    }
    if (JPEG_UNSUPPORTED_SOF_MARKERS.has(marker) || marker === 0xde || marker === 0xdc) {
      throw new InboundImageError('IMAGE_TYPE_UNSUPPORTED', 'lark: JPEG coding mode is unsupported')
    }
    if (marker === 0xc0 || marker === 0xc2) {
      if (sawFrame || segmentEnd - offset < 8) invalidImage('lark: JPEG frame header is invalid')
      const components = data[offset + 7]
      if (data[offset + 2] !== 8 || components === undefined
        || components === 0 || view.getUint16(offset, false) !== 8 + 3 * components) {
        invalidImage('lark: JPEG frame layout is invalid')
      }
      height = view.getUint16(offset + 3, false)
      width = view.getUint16(offset + 5, false)
      checkedPixels(width, height, maxPixels)
      sawFrame = true
    }
    if (marker === 0xda) {
      if (!sawFrame || segmentEnd - offset < 6) invalidImage('lark: JPEG scan header is invalid')
      const components = data[offset + 2]
      if (components === undefined || components === 0
        || view.getUint16(offset, false) !== 6 + 2 * components) {
        invalidImage('lark: JPEG scan layout is invalid')
      }
      sawScan = true
      inScan = true
    }
    offset = segmentEnd
  }
  return invalidImage('lark: JPEG end marker is missing')
}

function mediaTypeBase(value: string): string {
  if (value.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    return invalidImage('lark: image media type is invalid')
  }
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

function detectedMediaType(data: Uint8Array): StaticImageMediaType {
  if (startsWith(data, PNG_SIGNATURE)) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'image/jpeg'
  throw new InboundImageError('IMAGE_TYPE_UNSUPPORTED', 'lark: image type is unsupported')
}

export function prepareInboundImage(
  data: Uint8Array,
  declaredMediaType: string,
  maxBytes: number,
  maxPixels: number,
): PreparedInboundImage {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_INBOUND_IMAGE_BYTES
    || !Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > MAX_INBOUND_IMAGE_PIXELS) {
    throw new RangeError('lark: inbound image limits are invalid')
  }
  if (!(data instanceof Uint8Array)) invalidImage('lark: image bytes are invalid')
  if (data.byteLength === 0) invalidImage('lark: image is empty')
  if (data.byteLength > maxBytes) {
    throw new InboundImageError('IMAGE_TOO_LARGE', 'lark: image exceeds the configured byte limit')
  }
  const ownedData = Uint8Array.from(data)
  const mediaType = detectedMediaType(ownedData)
  const declared = mediaTypeBase(declaredMediaType.trim())
  if (declared !== 'application/octet-stream' && declared !== mediaType) {
    invalidImage('lark: image media type does not match its bytes')
  }
  const dimensions = mediaType === 'image/png'
    ? parseStaticPng(ownedData, maxPixels)
    : parseStaticJpeg(ownedData, maxPixels)
  return {
    input: Object.freeze({ data: ownedData, mediaType }),
    ...dimensions,
  }
}

function validAttachmentId(value: unknown): value is ImageAttachmentRef['attachmentId'] {
  return typeof value === 'string'
    && value !== ''
    && value.length <= 512
    && value.isWellFormed()
    && !ATTACHMENT_ID_CONTROL_PATTERN.test(value)
    && !value.includes('/')
    && !value.includes('\\')
    && !/^file:/iu.test(value)
}

export function validateSavedImageRef(
  value: unknown,
  prepared: PreparedInboundImage,
): ImageAttachmentRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: saved image reference is invalid')
  }
  const ref = value as Partial<ImageAttachmentRef>
  if (!validAttachmentId(ref.attachmentId)
    || ref.mediaType !== prepared.input.mediaType
    || ref.bytes !== prepared.input.data.byteLength
    || ref.width !== prepared.width
    || ref.height !== prepared.height
    || ref.name !== undefined) {
    throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: saved image reference is invalid')
  }
  return Object.freeze({
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  })
}

function addImageRef(stats: { count: number; bytes: number }, value: unknown): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: image reference is invalid')
  }
  const bytes = (value as { readonly bytes?: unknown }).bytes
  if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: image byte count is invalid')
  }
  stats.count += 1
  stats.bytes += bytes
  if (!Number.isSafeInteger(stats.count) || !Number.isSafeInteger(stats.bytes)) {
    throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: image aggregate overflows')
  }
}

export function contentImageStats(content: readonly ContentBlock[]): ImageContentStats {
  const stats = { count: 0, bytes: 0 }
  const pending = content.map((block) => ({ block, depth: 0 }))
  const seen = new Set<object>()
  while (pending.length > 0) {
    const entry = pending.pop()
    if (entry === undefined) continue
    if (entry.depth > 64 || seen.has(entry.block)) {
      throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: image content nesting is invalid')
    }
    seen.add(entry.block)
    if (entry.block.type === 'image') addImageRef(stats, entry.block.attachment)
    if (entry.block.type === 'tool-result') {
      for (const block of entry.block.content) pending.push({ block, depth: entry.depth + 1 })
    }
  }
  return Object.freeze(stats)
}

export function messagesImageStats(messages: readonly Message[]): ImageContentStats {
  let count = 0
  let bytes = 0
  for (const message of messages) {
    const stats = contentImageStats(message.content)
    count += stats.count
    bytes += stats.bytes
    if (!Number.isSafeInteger(count) || !Number.isSafeInteger(bytes)) {
      throw new InboundImageError('IMAGE_REFERENCE_INVALID', 'lark: image aggregate overflows')
    }
  }
  return Object.freeze({ count, bytes })
}

export function assertImageAggregate(
  current: ImageContentStats,
  candidateBytes: number,
  maxImages: number,
  maxBytes: number,
): void {
  if (!Number.isSafeInteger(maxImages) || maxImages <= 0 || maxImages > MAX_CONVERSATION_IMAGES
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_CONVERSATION_IMAGE_BYTES) {
    throw new RangeError('lark: conversation image limits are invalid')
  }
  if (current.count + 1 > maxImages || current.bytes + candidateBytes > maxBytes) {
    throw new InboundImageError(
      'IMAGE_AGGREGATE_LIMIT',
      'lark: conversation image aggregate exceeds the configured limit',
    )
  }
}
