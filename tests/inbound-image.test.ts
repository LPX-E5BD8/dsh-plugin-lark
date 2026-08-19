import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import {
  assertImageAggregate,
  contentImageStats,
  DEFAULT_CONVERSATION_IMAGE_BYTES,
  DEFAULT_CONVERSATION_IMAGES,
  InboundImageError,
  MAX_INBOUND_IMAGE_BYTES,
  MAX_INBOUND_IMAGE_PIXELS,
  messagesImageStats,
  prepareInboundImage,
  validateSavedImageRef,
} from '../src/inbound-image.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)
const JPEG_BASELINE_TRUNCATED = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z',
  'base64',
)
const JPEG_PROGRESSIVE_TRUNCATED = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wgARCAABAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAVAQEBAAAAAAAAAAAAAAAAAAAFB//aAAwDAQACEAMQAAABnANSP//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAQUCf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Bf//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Bf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEABj8Cf//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8hf//aAAwDAQACAAMAAAAQ/wD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==',
  'base64',
)
const JPEG_BASELINE = Buffer.concat([
  JPEG_BASELINE_TRUNCATED.subarray(0, 137),
  Buffer.alloc(3, 0x28),
  JPEG_BASELINE_TRUNCATED.subarray(137),
])
const JPEG_PROGRESSIVE = Buffer.concat([
  JPEG_PROGRESSIVE_TRUNCATED.subarray(0, 137),
  Buffer.alloc(3, 0x28),
  JPEG_PROGRESSIVE_TRUNCATED.subarray(137),
])

const CRC_TABLE = (() => {
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

function crc(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.byteLength)
  chunk.writeUInt32BE(data.byteLength, 0)
  typeBytes.copy(chunk, 4)
  Buffer.from(data).copy(chunk, 8)
  chunk.writeUInt32BE(crc(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.byteLength)
  return chunk
}

function insertPngChunk(source: Buffer, chunk: Buffer): Buffer {
  const idat = source.indexOf(Buffer.from('IDAT', 'ascii'))
  assert.ok(idat >= 4)
  return Buffer.concat([source.subarray(0, idat - 4), chunk, source.subarray(idat - 4)])
}

function imageBlock(bytes: number, suffix: string): ImageBlock {
  return Object.freeze({
    type: 'image',
    attachment: Object.freeze({
      attachmentId: `sha256:${suffix.repeat(64).slice(0, 64)}` as ImageBlock['attachment']['attachmentId'],
      mediaType: 'image/png',
      bytes,
      width: 1,
      height: 1,
    }),
  })
}

test('static image inspector accepts PNG and baseline/progressive JPEG with exact MIME', () => {
  const png = prepareInboundImage(PNG, 'image/png; charset=binary', PNG.length, 1)
  assert.deepEqual({ mediaType: png.input.mediaType, width: png.width, height: png.height }, {
    mediaType: 'image/png', width: 1, height: 1,
  })
  const baseline = prepareInboundImage(JPEG_BASELINE, 'image/jpeg', JPEG_BASELINE.length, 2)
  const progressive = prepareInboundImage(
    JPEG_PROGRESSIVE,
    'application/octet-stream',
    JPEG_PROGRESSIVE.length,
    2,
  )
  assert.deepEqual([baseline.width, baseline.height], [2, 1])
  assert.deepEqual([progressive.width, progressive.height], [2, 1])
  assert.equal(progressive.input.mediaType, 'image/jpeg')
})

test('real rc.7 attachment-local saves and rereads inspected baseline/progressive JPEG', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-static-jpeg-'))
  const ctx = new Context()
  t.after(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  await ctx.plugin(LocalAttachmentStore, {
    dshHome: root,
    maxImageBytes: MAX_INBOUND_IMAGE_BYTES,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 20 * 1024 * 1024,
    maxImagePixels: MAX_INBOUND_IMAGE_PIXELS,
  })

  for (const data of [JPEG_BASELINE, JPEG_PROGRESSIVE]) {
    const prepared = prepareInboundImage(
      data,
      'image/jpeg',
      MAX_INBOUND_IMAGE_BYTES,
      MAX_INBOUND_IMAGE_PIXELS,
    )
    const ref = validateSavedImageRef(
      await ctx.attachments.saveImage(prepared.input),
      prepared,
    )
    const stored = await ctx.attachments.readImage(ref)
    assert.deepEqual([...stored.data], [...data])
  }
})

test('static image inspector rejects MIME mismatch, unsupported magic, bytes, and pixels', () => {
  assert.throws(
    () => prepareInboundImage(PNG, 'image/jpeg', PNG.length, 1),
    (error: unknown) => error instanceof InboundImageError && error.code === 'IMAGE_INVALID',
  )
  assert.throws(
    () => prepareInboundImage(Buffer.from('GIF89a'), 'image/gif', 100, 100),
    (error: unknown) => error instanceof InboundImageError && error.code === 'IMAGE_TYPE_UNSUPPORTED',
  )
  assert.throws(
    () => prepareInboundImage(PNG, 'image/png', PNG.length - 1, 1),
    (error: unknown) => error instanceof InboundImageError && error.code === 'IMAGE_TOO_LARGE',
  )
  assert.throws(
    () => prepareInboundImage(JPEG_BASELINE, 'image/jpeg', JPEG_BASELINE.length, 1),
    (error: unknown) => error instanceof InboundImageError && error.code === 'IMAGE_TOO_MANY_PIXELS',
  )
  assert.throws(() => prepareInboundImage(PNG, 'image/png', MAX_INBOUND_IMAGE_BYTES + 1, 1))
  assert.throws(() => prepareInboundImage(PNG, 'image/png', PNG.length, MAX_INBOUND_IMAGE_PIXELS + 1))
})

test('static PNG parser rejects APNG, corrupt chunks, truncation, and trailing images', () => {
  const animated = insertPngChunk(PNG, pngChunk('acTL', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0)))
  assert.throws(
    () => prepareInboundImage(animated, 'image/png', animated.length, 10),
    (error: unknown) => error instanceof InboundImageError && error.code === 'IMAGE_TYPE_UNSUPPORTED',
  )
  const corrupt = Buffer.from(PNG)
  corrupt[40] = (corrupt[40] ?? 0) ^ 1
  assert.throws(() => prepareInboundImage(corrupt, 'image/png', corrupt.length, 10))
  assert.throws(() => prepareInboundImage(PNG.subarray(0, -1), 'image/png', PNG.length, 10))
  const concatenated = Buffer.concat([PNG, PNG])
  assert.throws(() => prepareInboundImage(concatenated, 'image/png', concatenated.length, 10))
})

test('static JPEG parser rejects MPO, duplicate images, malformed markers, and trailing data', () => {
  const mpfData = Buffer.from('MPF\0test', 'binary')
  const app2 = Buffer.alloc(4 + mpfData.length)
  app2[0] = 0xff
  app2[1] = 0xe2
  app2.writeUInt16BE(mpfData.length + 2, 2)
  mpfData.copy(app2, 4)
  const mpo = Buffer.concat([JPEG_BASELINE.subarray(0, 2), app2, JPEG_BASELINE.subarray(2)])
  assert.throws(
    () => prepareInboundImage(mpo, 'image/jpeg', mpo.length, 10),
    (error: unknown) => error instanceof InboundImageError && error.code === 'IMAGE_TYPE_UNSUPPORTED',
  )
  const concatenated = Buffer.concat([JPEG_BASELINE, JPEG_BASELINE])
  assert.throws(() => prepareInboundImage(concatenated, 'image/jpeg', concatenated.length, 10))
  assert.throws(() => prepareInboundImage(JPEG_BASELINE.subarray(0, -2), 'image/jpeg', 1_000, 10))
  assert.throws(() => prepareInboundImage(
    Buffer.concat([JPEG_BASELINE, Buffer.from('tail')]),
    'image/jpeg',
    1_000,
    10,
  ))
})

test('saved image references must exactly match inspected bytes and omit synthesized names', () => {
  const prepared = prepareInboundImage(PNG, 'image/png', PNG.length, 1)
  const attachmentId = `sha256:${'a'.repeat(64)}` as ImageBlock['attachment']['attachmentId']
  const valid = validateSavedImageRef({
    attachmentId,
    mediaType: 'image/png',
    bytes: PNG.length,
    width: 1,
    height: 1,
  }, prepared)
  assert.deepEqual(valid, {
    attachmentId,
    mediaType: 'image/png',
    bytes: PNG.length,
    width: 1,
    height: 1,
  })
  for (const invalid of [
    { ...valid, mediaType: 'image/jpeg' },
    { ...valid, bytes: PNG.length + 1 },
    { ...valid, width: 2 },
    { ...valid, name: 'platform-key.png' },
    { ...valid, attachmentId: '/private/image' },
  ]) {
    assert.throws(
      () => validateSavedImageRef(invalid, prepared),
      (error: unknown) => error instanceof InboundImageError
        && error.code === 'IMAGE_REFERENCE_INVALID',
    )
  }
})

test('image stats include nested tool results and enforce exact aggregate boundaries', () => {
  const first = imageBlock(10, 'a')
  const second = imageBlock(20, 'b')
  const stats = contentImageStats([
    first,
    {
      type: 'tool-result',
      toolCallId: 'call-stats' as never,
      content: [second],
      isError: false,
    },
  ])
  assert.deepEqual(stats, { count: 2, bytes: 30 })
  assert.deepEqual(messagesImageStats([{
    id: 'message-stats' as never,
    role: 'user',
    content: [first],
    source: { kind: 'user' },
  }]), { count: 1, bytes: 10 })
  assert.doesNotThrow(() => assertImageAggregate(
    { count: DEFAULT_CONVERSATION_IMAGES - 1, bytes: DEFAULT_CONVERSATION_IMAGE_BYTES - 10 },
    10,
    DEFAULT_CONVERSATION_IMAGES,
    DEFAULT_CONVERSATION_IMAGE_BYTES,
  ))
  assert.throws(
    () => assertImageAggregate(
      { count: DEFAULT_CONVERSATION_IMAGES, bytes: 0 },
      1,
      DEFAULT_CONVERSATION_IMAGES,
      DEFAULT_CONVERSATION_IMAGE_BYTES,
    ),
    (error: unknown) => error instanceof InboundImageError
      && error.code === 'IMAGE_AGGREGATE_LIMIT',
  )
})
