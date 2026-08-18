import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  type FileHandle,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import {
  DEFAULT_OUTBOUND_IMAGE_BYTES,
  DEFAULT_OUTBOUND_IMAGE_PIXELS,
  DEFAULT_OUTBOUND_TEXT_BYTES,
  inspectOutboundArtifact,
  MAX_LARK_OUTBOUND_IMAGE_EDGE,
  type OutboundArtifactFileSystem,
  OutboundArtifactError,
  readOutboundArtifact,
} from '../src/outbound-artifact.ts'

const linuxOutboundTest = process.platform === 'linux' ? test : test.skip

const LIMITS = Object.freeze({
  maxTextBytes: DEFAULT_OUTBOUND_TEXT_BYTES,
  maxImageBytes: DEFAULT_OUTBOUND_IMAGE_BYTES,
  maxImagePixels: DEFAULT_OUTBOUND_IMAGE_PIXELS,
})

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

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

function pngCrc(data: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of data) value = (CRC_TABLE[(value ^ byte) & 0xff] ?? 0) ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngWithDimensions(width: number, height: number): Buffer {
  const data = Buffer.from(PNG)
  data.writeUInt32BE(width, 16)
  data.writeUInt32BE(height, 20)
  data.writeUInt32BE(pngCrc(data.subarray(12, 29)), 29)
  return data
}

const run = promisify(execFile)

test('outbound artifact inspection fails closed without the Linux descriptor boundary', {
  skip: process.platform === 'linux',
}, async () => {
  await assert.rejects(
    inspectOutboundArtifact('/tmp/workspace', 'report.txt', LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'WORKSPACE_UNAVAILABLE',
  )
})

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-lark-outbound-'))
  const root = join(parent, 'workspace')
  const outside = join(parent, 'outside')
  await mkdir(join(root, 'generated'), { recursive: true })
  await mkdir(outside)
  t.after(() => rm(parent, { recursive: true, force: true }))
  return { parent, root, outside }
}

linuxOutboundTest('outbound artifacts inspect and reread bounded text and static PNG snapshots', async (t) => {
  const { root } = await fixture(t)
  const text = new TextEncoder().encode('generated report\n')
  await writeFile(join(root, 'generated', 'report.txt'), text)
  await writeFile(join(root, 'generated', 'plot.png'), PNG)

  const textPreflight = await inspectOutboundArtifact(root, 'generated/report.txt', LIMITS)
  assert.deepEqual({
    kind: textPreflight.kind,
    name: textPreflight.name,
    relativePath: textPreflight.relativePath,
    bytes: textPreflight.bytes,
  }, {
    kind: 'text',
    name: 'report.txt',
    relativePath: 'generated/report.txt',
    bytes: text.byteLength,
  })
  const preparedText = await readOutboundArtifact(textPreflight, LIMITS)
  assert.equal(preparedText.kind, 'file')
  assert.equal(preparedText.name, 'report.txt')
  assert.deepEqual([...preparedText.data], [...text])

  const imagePreflight = await inspectOutboundArtifact(root, 'generated/plot.png', LIMITS)
  const preparedImage = await readOutboundArtifact(imagePreflight, LIMITS)
  assert.equal(preparedImage.kind, 'image')
  if (preparedImage.kind !== 'image') assert.fail('expected image artifact')
  assert.equal(preparedImage.mediaType, 'image/png')
  assert.deepEqual([preparedImage.width, preparedImage.height], [1, 1])
  assert.notEqual(preparedImage.data, PNG)
  assert.deepEqual([...preparedImage.data], [...PNG])
})

linuxOutboundTest('outbound artifact paths reject absolute, URI, traversal, hidden, reserved, and unsupported targets', async (t) => {
  const { root } = await fixture(t)
  for (const path of [
    '',
    '/etc/passwd',
    '../secret.txt',
    'generated/../secret.txt',
    'generated\\report.txt',
    'file:generated/report.txt',
    'https://example.com/report.txt',
    '.env',
    '.git/config.txt',
    'generated/.secret.txt',
    'generated/CON.txt',
    'generated/archive.zip',
  ]) {
    await assert.rejects(
      inspectOutboundArtifact(root, path, LIMITS),
      (error) => error instanceof OutboundArtifactError
        && (error.code === 'INVALID_PATH' || error.code === 'UNSUPPORTED_TYPE')
        && !error.message.includes(root),
    )
  }
})

linuxOutboundTest('outbound artifact containment rejects final symlinks, parent escapes, and hardlinks', async (t) => {
  const { root, outside } = await fixture(t)
  const external = join(outside, 'external.txt')
  await writeFile(external, 'external')
  await symlink(external, join(root, 'generated', 'final.txt'))
  await symlink(outside, join(root, 'escape'))
  await link(external, join(root, 'generated', 'hardlink.txt'))

  for (const path of ['generated/final.txt', 'escape/external.txt', 'generated/hardlink.txt']) {
    await assert.rejects(
      inspectOutboundArtifact(root, path, LIMITS),
      (error) => error instanceof OutboundArtifactError
        && (error.code === 'INVALID_PATH'
          || error.code === 'FILE_UNAVAILABLE'
          || error.code === 'FILE_CHANGED'),
    )
  }
})

linuxOutboundTest('outbound artifact containment permits an intermediate symlink whose canonical target stays inside', async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'generated', 'inside.txt'), 'inside')
  await symlink(join(root, 'generated'), join(root, 'alias'), 'dir')

  const preflight = await inspectOutboundArtifact(root, 'alias/inside.txt', LIMITS)
  const prepared = await readOutboundArtifact(preflight, LIMITS)
  assert.equal(preflight.canonicalPath, join(root, 'generated', 'inside.txt'))
  assert.equal(prepared.kind, 'file')
  assert.equal(new TextDecoder().decode(prepared.data), 'inside')
})

linuxOutboundTest('outbound artifact containment rejects an intermediate symlink into a hidden Workspace path', async (t) => {
  const { root } = await fixture(t)
  const hidden = join(root, '.private')
  await mkdir(hidden)
  await writeFile(join(hidden, 'report.txt'), 'hidden')
  await symlink(hidden, join(root, 'visible'), 'dir')

  await assert.rejects(
    inspectOutboundArtifact(root, 'visible/report.txt', LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'INVALID_PATH',
  )
})

linuxOutboundTest('outbound artifact descriptor open rejects a FIFO without blocking', async (t) => {
  const { root } = await fixture(t)
  const fifo = join(root, 'generated', 'pipe.txt')
  await run('mkfifo', [fifo])
  const startedAt = Date.now()
  await assert.rejects(
    inspectOutboundArtifact(root, 'generated/pipe.txt', LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_UNAVAILABLE',
  )
  assert.ok(Date.now() - startedAt < 1_000)
})

linuxOutboundTest('outbound artifact approval snapshot rejects replacement and parent-symlink swaps', async (t) => {
  const { root, outside } = await fixture(t)
  const target = join(root, 'generated', 'result.txt')
  await writeFile(target, 'first')
  const replaced = await inspectOutboundArtifact(root, 'generated/result.txt', LIMITS)
  await writeFile(join(root, 'replacement.txt'), 'first')
  await rename(join(root, 'replacement.txt'), target)
  await assert.rejects(
    readOutboundArtifact(replaced, LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_CHANGED',
  )

  await writeFile(target, 'inside')
  const swapped = await inspectOutboundArtifact(root, 'generated/result.txt', LIMITS)
  await writeFile(join(outside, 'result.txt'), 'outside')
  await rename(join(root, 'generated'), join(root, 'generated-original'))
  await symlink(outside, join(root, 'generated'))
  await assert.rejects(
    readOutboundArtifact(swapped, LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_CHANGED',
  )
})

linuxOutboundTest('descriptor identity rejects a parent symlink swapped outside only for open', async (t) => {
  const { root, outside } = await fixture(t)
  const generated = join(root, 'generated')
  const parked = join(root, 'generated-parked')
  await writeFile(join(generated, 'result.txt'), 'inside!')
  await writeFile(join(outside, 'result.txt'), 'outside')
  const preflight = await inspectOutboundArtifact(root, 'generated/result.txt', LIMITS)
  let swapped = false
  const attackFileSystem: OutboundArtifactFileSystem = {
    lstat: (path) => lstat(path, { bigint: true }),
    realpath,
    async open(path, flags) {
      if (swapped) return open(path, flags)
      swapped = true
      await rename(generated, parked)
      await symlink(outside, generated)
      try {
        return await open(path, flags)
      } finally {
        await rm(generated)
        await rename(parked, generated)
      }
    },
  }
  await assert.rejects(
    readOutboundArtifact(preflight, LIMITS, { fileSystem: attackFileSystem }),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_CHANGED',
  )
  assert.equal(swapped, true)
})

linuxOutboundTest('descriptor canonical identity rejects alternating parent-symlink path observations', async (t) => {
  const { root, outside } = await fixture(t)
  const inside = join(root, 'inside')
  const generated = join(root, 'generated')
  const candidate = join(generated, 'report.txt')
  await mkdir(inside)
  await writeFile(join(inside, 'report.txt'), 'INSIDE_SECRET!')
  await writeFile(join(outside, 'report.txt'), 'OUTSIDE_SECRET')
  await rm(generated, { recursive: true })
  let target = ''
  const pointAt = async (next: string): Promise<void> => {
    if (target === next) return
    await rm(generated, { force: true })
    await symlink(next, generated, 'dir')
    target = next
  }
  await pointAt(inside)
  const alternatingFileSystem: OutboundArtifactFileSystem = {
    async lstat(path) {
      if (path === candidate) await pointAt(outside)
      return lstat(path, { bigint: true })
    },
    async realpath(path) {
      if (path === candidate) await pointAt(inside)
      return realpath(path)
    },
    async open(path, flags) {
      if (path === candidate) await pointAt(outside)
      return open(path, flags)
    },
  }

  await assert.rejects(
    inspectOutboundArtifact(root, 'generated/report.txt', LIMITS, {
      fileSystem: alternatingFileSystem,
    }),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_CHANGED',
  )
})

linuxOutboundTest('descriptor read rejects an in-place rewrite even when byte length is unchanged', async (t) => {
  const { root } = await fixture(t)
  const path = join(root, 'generated', 'result.txt')
  await writeFile(path, 'approved')
  const preflight = await inspectOutboundArtifact(root, 'generated/result.txt', LIMITS)
  let rewritten = false
  const rewritingFileSystem: OutboundArtifactFileSystem = {
    lstat: (target) => lstat(target, { bigint: true }),
    realpath,
    async open(target, flags) {
      const handle = await open(target, flags)
      return {
        fd: handle.fd,
        stat: handle.stat.bind(handle),
        close: handle.close.bind(handle),
        async read(...args: Parameters<FileHandle['read']>) {
          const result = await handle.read(...args)
          if (!rewritten) {
            rewritten = true
            await writeFile(path, 'replaced')
          }
          return result
        },
      } as FileHandle
    },
  }
  await assert.rejects(
    readOutboundArtifact(preflight, LIMITS, { fileSystem: rewritingFileSystem }),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_CHANGED',
  )
  assert.equal(rewritten, true)
})

linuxOutboundTest('outbound artifacts reject byte overflow and content disguised by an allowed extension', async (t) => {
  const { root } = await fixture(t)
  await writeFile(join(root, 'generated', 'large.txt'), Buffer.alloc(9, 0x61))
  await assert.rejects(
    inspectOutboundArtifact(root, 'generated/large.txt', { ...LIMITS, maxTextBytes: 8 }),
    (error) => error instanceof OutboundArtifactError && error.code === 'FILE_TOO_LARGE',
  )

  await writeFile(join(root, 'generated', 'binary.txt'), PNG)
  const binary = await inspectOutboundArtifact(root, 'generated/binary.txt', LIMITS)
  await assert.rejects(
    readOutboundArtifact(binary, LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'INVALID_CONTENT',
  )

  await writeFile(join(root, 'generated', 'renamed.jpg'), PNG)
  const renamed = await inspectOutboundArtifact(root, 'generated/renamed.jpg', LIMITS)
  await assert.rejects(
    readOutboundArtifact(renamed, LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'INVALID_CONTENT',
  )
})

linuxOutboundTest('outbound images reject a platform-oversize edge before approval preparation completes', async (t) => {
  const { root } = await fixture(t)
  const path = join(root, 'generated', 'wide.png')
  await writeFile(path, pngWithDimensions(MAX_LARK_OUTBOUND_IMAGE_EDGE + 1, 1_000))
  const preflight = await inspectOutboundArtifact(root, 'generated/wide.png', LIMITS)
  await assert.rejects(
    readOutboundArtifact(preflight, LIMITS),
    (error) => error instanceof OutboundArtifactError && error.code === 'INVALID_CONTENT',
  )
})

linuxOutboundTest('outbound artifact cancellation and filesystem failures expose no raw path cause', async (t) => {
  const { root } = await fixture(t)
  const controller = new AbortController()
  controller.abort(new Error(`private abort at ${root}`))
  const interrupted = await inspectOutboundArtifact(
    root,
    'generated/missing.txt',
    LIMITS,
    { signal: controller.signal },
  ).catch((error: unknown) => error)
  assert.ok(interrupted instanceof OutboundArtifactError)
  assert.equal(interrupted.code, 'INTERRUPTED')
  assert.equal(interrupted.cause, undefined)
  assert.doesNotMatch(interrupted.message, new RegExp(root, 'u'))

  const missing = await inspectOutboundArtifact(
    root,
    'generated/missing.txt',
    LIMITS,
  ).catch((error: unknown) => error)
  assert.ok(missing instanceof OutboundArtifactError)
  assert.equal(missing.cause, undefined)
  assert.doesNotMatch(missing.message, new RegExp(root, 'u'))
})
