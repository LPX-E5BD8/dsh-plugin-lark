import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  MAX_INBOUND_IMAGE_BYTES,
  MAX_INBOUND_IMAGE_PIXELS,
  prepareInboundImage,
} from './inbound-image.ts'
import type { StaticImageMediaType } from './inbound-image.ts'
import {
  MAX_INBOUND_TEXT_RESOURCE_BYTES,
  prepareInboundTextResource,
  validateInboundTextResourceName,
} from './inbound-resource.ts'

export const OUTBOUND_ARTIFACT_TOOL_NAME = 'send_lark_artifact'
export const DEFAULT_OUTBOUND_TEXT_BYTES = 128 * 1024
export const MAX_OUTBOUND_TEXT_BYTES = MAX_INBOUND_TEXT_RESOURCE_BYTES
export const DEFAULT_OUTBOUND_IMAGE_BYTES = MAX_INBOUND_IMAGE_BYTES
export const MAX_OUTBOUND_IMAGE_BYTES = MAX_INBOUND_IMAGE_BYTES
export const DEFAULT_OUTBOUND_IMAGE_PIXELS = MAX_INBOUND_IMAGE_PIXELS
export const MAX_OUTBOUND_IMAGE_PIXELS = MAX_INBOUND_IMAGE_PIXELS
export const MAX_LARK_OUTBOUND_IMAGE_EDGE = 12_000

const MAX_RELATIVE_PATH_RUNES = 512
const MAX_RELATIVE_PATH_BYTES = 1024
const MAX_IMAGE_NAME_RUNES = 120
const MAX_IMAGE_NAME_BYTES = 255
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg'])
const UNSAFE_PATH_SEGMENT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\\/:*?"<>|]/u
const WINDOWS_RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu
const PROC_SELF_FD_ROOT = '/proc/self/fd'

export type OutboundArtifactKind = 'text' | 'image'

export type OutboundArtifactErrorCode =
  | 'INVALID_PATH'
  | 'UNSUPPORTED_TYPE'
  | 'WORKSPACE_UNAVAILABLE'
  | 'FILE_UNAVAILABLE'
  | 'FILE_CHANGED'
  | 'FILE_TOO_LARGE'
  | 'INVALID_CONTENT'
  | 'INTERRUPTED'

export class OutboundArtifactError extends Error {
  constructor(readonly code: OutboundArtifactErrorCode, message: string) {
    super(message)
    this.name = 'OutboundArtifactError'
  }
}

interface FileFingerprint {
  readonly dev: bigint
  readonly ino: bigint
  readonly nlink: bigint
  readonly size: bigint
  readonly mtimeNs: bigint
  readonly ctimeNs: bigint
}

interface DirectoryIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

export interface OutboundArtifactPreflight {
  readonly kind: OutboundArtifactKind
  readonly name: string
  readonly relativePath: string
  readonly workspaceRoot: string
  readonly rootIdentity: DirectoryIdentity
  readonly candidatePath: string
  readonly canonicalPath: string
  readonly bytes: number
  readonly fingerprint: FileFingerprint
}

export type PreparedOutboundArtifact = {
  readonly kind: 'file'
  readonly name: string
  readonly data: Uint8Array
  readonly bytes: number
} | {
  readonly kind: 'image'
  readonly name: string
  readonly data: Uint8Array
  readonly mediaType: StaticImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
}

export interface OutboundArtifactLimits {
  readonly maxTextBytes: number
  readonly maxImageBytes: number
  readonly maxImagePixels: number
}

export interface OutboundArtifactFileSystem {
  lstat(path: string): Promise<BigIntStats>
  open(path: string, flags: number): Promise<FileHandle>
  realpath(path: string): Promise<string>
}

export interface OutboundArtifactIoOptions {
  readonly signal?: AbortSignal
  readonly fileSystem?: OutboundArtifactFileSystem
}

const NODE_FILE_SYSTEM: OutboundArtifactFileSystem = Object.freeze({
  lstat: (path: string) => lstat(path, { bigint: true }),
  open,
  realpath,
})

function failure(
  code: OutboundArtifactErrorCode,
  message: string,
  _cause?: unknown,
): never {
  // The raw filesystem error often contains an absolute host path. This
  // privacy boundary deliberately discards it before tool/session handling.
  throw new OutboundArtifactError(code, message)
}

function throwIfInterrupted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    failure('INTERRUPTED', 'Outbound artifact operation was interrupted.')
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function safeImageName(value: string): void {
  if (value === ''
    || value === '.'
    || value === '..'
    || value.startsWith('.')
    || value.endsWith('.')
    || value.trim() !== value
    || !value.isWellFormed()
    || [...value].length > MAX_IMAGE_NAME_RUNES
    || utf8Bytes(value) > MAX_IMAGE_NAME_BYTES
    || UNSAFE_PATH_SEGMENT.test(value)
    || WINDOWS_RESERVED_NAME.test(value)) {
    failure('INVALID_PATH', 'Outbound artifact name is invalid.')
  }
}

function classifyRelativePath(value: unknown): {
  readonly relativePath: string
  readonly name: string
  readonly kind: OutboundArtifactKind
} {
  if (typeof value !== 'string'
    || value === ''
    || value.trim() !== value
    || !value.isWellFormed()
    || isAbsolute(value)
    || value.includes('\\')
    || [...value].length > MAX_RELATIVE_PATH_RUNES
    || utf8Bytes(value) > MAX_RELATIVE_PATH_BYTES) {
    return failure('INVALID_PATH', 'Outbound artifact path must be a bounded relative path.')
  }
  const segments = value.split('/')
  if (segments.length === 0 || segments.some((segment) => (
    segment === ''
    || segment === '.'
    || segment === '..'
    || segment.startsWith('.')
    || segment.endsWith('.')
    || segment.trim() !== segment
    || !segment.isWellFormed()
    || UNSAFE_PATH_SEGMENT.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) {
    return failure('INVALID_PATH', 'Outbound artifact path contains an unsafe segment.')
  }
  const name = segments.at(-1) ?? ''
  const extension = extname(name).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) {
    safeImageName(name)
    return { relativePath: value, name, kind: 'image' }
  }
  try {
    validateInboundTextResourceName(name)
  } catch (error) {
    return failure('UNSUPPORTED_TYPE', 'Outbound artifact type is unsupported.', error)
  }
  return { relativePath: value, name, kind: 'text' }
}

function contained(root: string, candidate: string): boolean {
  const child = relative(root, candidate)
  return child !== ''
    && child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
}

function canonicalTargetIsSafe(
  root: string,
  canonicalPath: string,
  expected: ReturnType<typeof classifyRelativePath>,
): boolean {
  try {
    const canonical = classifyRelativePath(relative(root, canonicalPath).split(sep).join('/'))
    return canonical.kind === expected.kind && canonical.name === expected.name
  } catch {
    return false
  }
}

function fingerprint(stat: BigIntStats): FileFingerprint {
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    nlink: stat.nlink,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  })
}

function sameFingerprint(stat: BigIntStats, expected: FileFingerprint): boolean {
  return stat.dev === expected.dev
    && stat.ino === expected.ino
    && stat.nlink === expected.nlink
    && stat.size === expected.size
    && stat.mtimeNs === expected.mtimeNs
    && stat.ctimeNs === expected.ctimeNs
}

async function descriptorCanonicalPath(
  handle: FileHandle,
  fileSystem: OutboundArtifactFileSystem,
): Promise<string> {
  if (!Number.isSafeInteger(handle.fd) || handle.fd < 0) {
    return failure('FILE_UNAVAILABLE', 'Outbound artifact descriptor is unavailable.')
  }
  try {
    return await fileSystem.realpath(`${PROC_SELF_FD_ROOT}/${handle.fd}`)
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact descriptor cannot be resolved.', error)
  }
}

function validLimit(value: number, hardMax: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= hardMax
}

function validateLimits(limits: OutboundArtifactLimits): void {
  if (!validLimit(limits.maxTextBytes, MAX_OUTBOUND_TEXT_BYTES)
    || !validLimit(limits.maxImageBytes, MAX_OUTBOUND_IMAGE_BYTES)
    || !validLimit(limits.maxImagePixels, MAX_OUTBOUND_IMAGE_PIXELS)) {
    throw new RangeError('lark: outbound artifact limits are invalid')
  }
}

async function canonicalWorkspaceRoot(
  root: string,
  fileSystem: OutboundArtifactFileSystem,
  signal?: AbortSignal,
): Promise<{
  readonly path: string
  readonly identity: DirectoryIdentity
}> {
  if (!isAbsolute(root) || !root.isWellFormed()) {
    return failure('WORKSPACE_UNAVAILABLE', 'Registered Workspace root is invalid.')
  }
  let canonical: string
  let rootStat: BigIntStats
  try {
    throwIfInterrupted(signal)
    rootStat = await fileSystem.lstat(root)
    throwIfInterrupted(signal)
    canonical = await fileSystem.realpath(root)
    throwIfInterrupted(signal)
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('WORKSPACE_UNAVAILABLE', 'Registered Workspace root is unavailable.', error)
  }
  if (canonical !== root || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    return failure('WORKSPACE_UNAVAILABLE', 'Registered Workspace root changed identity.')
  }
  return Object.freeze({
    path: canonical,
    identity: Object.freeze({ dev: rootStat.dev, ino: rootStat.ino }),
  })
}

async function assertWorkspaceRootCurrent(
  root: string,
  identity: DirectoryIdentity,
  fileSystem: OutboundArtifactFileSystem,
  signal?: AbortSignal,
): Promise<void> {
  try {
    throwIfInterrupted(signal)
    const current = await fileSystem.lstat(root)
    throwIfInterrupted(signal)
    const canonical = await fileSystem.realpath(root)
    throwIfInterrupted(signal)
    if (!current.isDirectory()
      || current.isSymbolicLink()
      || current.dev !== identity.dev
      || current.ino !== identity.ino
      || canonical !== root) {
      return failure('WORKSPACE_UNAVAILABLE', 'Registered Workspace root changed identity.')
    }
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('WORKSPACE_UNAVAILABLE', 'Registered Workspace root is unavailable.', error)
  }
}

type OutboundArtifactLocation = Pick<
  OutboundArtifactPreflight,
  | 'kind'
  | 'name'
  | 'relativePath'
  | 'workspaceRoot'
  | 'rootIdentity'
  | 'candidatePath'
  | 'canonicalPath'
>

async function stableOpen(
  preflight: OutboundArtifactLocation,
  expected?: FileFingerprint,
  options: OutboundArtifactIoOptions = {},
): Promise<{ readonly handle: Awaited<ReturnType<typeof open>>; readonly stat: BigIntStats }> {
  const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM
  const signal = options.signal
  await assertWorkspaceRootCurrent(
    preflight.workspaceRoot,
    preflight.rootIdentity,
    fileSystem,
    signal,
  )
  let canonical: string
  try {
    throwIfInterrupted(signal)
    canonical = await fileSystem.realpath(preflight.candidatePath)
    throwIfInterrupted(signal)
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact cannot be resolved.', error)
  }
  if (canonical !== preflight.canonicalPath
    || !contained(preflight.workspaceRoot, canonical)) {
    return failure('FILE_CHANGED', 'Outbound artifact changed containment.')
  }
  let before: BigIntStats
  try {
    before = await fileSystem.lstat(preflight.candidatePath)
    throwIfInterrupted(signal)
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact is unavailable.', error)
  }
  if (!before.isFile()
    || before.isSymbolicLink()
    || before.nlink !== 1n
    || before.dev !== preflight.rootIdentity.dev) {
    return failure(
      'FILE_UNAVAILABLE',
      'Outbound artifact must be a regular non-symlink, non-hardlinked local file.',
    )
  }
  if (expected !== undefined && !sameFingerprint(before, expected)) {
    return failure('FILE_CHANGED', 'Outbound artifact changed after approval.')
  }
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_NONBLOCK prevents a final-entry swap to a FIFO/device from hanging
    // before fstat can reject it. Node opens descriptors close-on-exec.
    throwIfInterrupted(signal)
    handle = await fileSystem.open(
      preflight.candidatePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    )
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact cannot be opened safely.', error)
  }
  try {
    throwIfInterrupted(signal)
    const opened = await handle.stat({ bigint: true })
    throwIfInterrupted(signal)
    const after = await fileSystem.lstat(preflight.candidatePath)
    throwIfInterrupted(signal)
    const afterCanonical = await fileSystem.realpath(preflight.candidatePath)
    throwIfInterrupted(signal)
    const openedCanonical = await descriptorCanonicalPath(handle, fileSystem)
    throwIfInterrupted(signal)
    if (!opened.isFile()
      || after.isSymbolicLink()
      || opened.nlink !== 1n
      || opened.dev !== preflight.rootIdentity.dev
      || !sameFingerprint(after, fingerprint(opened))
      || (expected !== undefined && !sameFingerprint(opened, expected))
      || afterCanonical !== preflight.canonicalPath
      || !contained(preflight.workspaceRoot, afterCanonical)
      || openedCanonical !== preflight.canonicalPath
      || !contained(preflight.workspaceRoot, openedCanonical)) {
      return failure('FILE_CHANGED', 'Outbound artifact changed while opening.')
    }
    await assertWorkspaceRootCurrent(
      preflight.workspaceRoot,
      preflight.rootIdentity,
      fileSystem,
      signal,
    )
    return { handle, stat: opened }
  } catch (error) {
    await handle.close().catch(() => {})
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact verification failed.', error)
  }
}

export async function inspectOutboundArtifact(
  workspaceRoot: string,
  rawRelativePath: unknown,
  limits: OutboundArtifactLimits,
  options: OutboundArtifactIoOptions = {},
): Promise<OutboundArtifactPreflight> {
  if (process.platform !== 'linux') {
    return failure(
      'WORKSPACE_UNAVAILABLE',
      'Outbound artifact descriptor validation is unsupported on this platform.',
    )
  }
  validateLimits(limits)
  const classified = classifyRelativePath(rawRelativePath)
  const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM
  const root = await canonicalWorkspaceRoot(workspaceRoot, fileSystem, options.signal)
  const candidatePath = resolve(root.path, classified.relativePath)
  if (!contained(root.path, candidatePath)) {
    return failure('INVALID_PATH', 'Outbound artifact path escapes its Workspace.')
  }
  let canonicalPath: string
  try {
    throwIfInterrupted(options.signal)
    canonicalPath = await fileSystem.realpath(candidatePath)
    throwIfInterrupted(options.signal)
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact is unavailable.', error)
  }
  if (!contained(root.path, canonicalPath)) {
    return failure('INVALID_PATH', 'Outbound artifact resolves outside its Workspace.')
  }
  if (!canonicalTargetIsSafe(root.path, canonicalPath, classified)) {
    return failure('INVALID_PATH', 'Outbound artifact resolves through an unsafe Workspace path.')
  }
  const base = {
    ...classified,
    workspaceRoot: root.path,
    rootIdentity: root.identity,
    candidatePath,
    canonicalPath,
  }
  const opened = await stableOpen(base, undefined, options)
  try {
    const bytes = Number(opened.stat.size)
    const maxBytes = classified.kind === 'image' ? limits.maxImageBytes : limits.maxTextBytes
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      return failure('FILE_UNAVAILABLE', 'Outbound artifact is empty or has an invalid size.')
    }
    if (bytes > maxBytes) {
      return failure('FILE_TOO_LARGE', 'Outbound artifact exceeds its configured byte limit.')
    }
    return Object.freeze({
      ...base,
      bytes,
      fingerprint: fingerprint(opened.stat),
    })
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

async function readStableBytes(
  preflight: OutboundArtifactPreflight,
  options: OutboundArtifactIoOptions,
): Promise<Uint8Array> {
  const fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM
  const signal = options.signal
  const opened = await stableOpen(preflight, preflight.fingerprint, options)
  try {
    const data = Buffer.alloc(preflight.bytes)
    let offset = 0
    while (offset < data.byteLength) {
      throwIfInterrupted(signal)
      const result = await opened.handle.read(data, offset, data.byteLength - offset, offset)
      throwIfInterrupted(signal)
      if (result.bytesRead === 0) {
        return failure('FILE_CHANGED', 'Outbound artifact became truncated while reading.')
      }
      offset += result.bytesRead
    }
    const extra = Buffer.alloc(1)
    const trailing = await opened.handle.read(extra, 0, 1, offset)
    throwIfInterrupted(signal)
    const after = await opened.handle.stat({ bigint: true })
    throwIfInterrupted(signal)
    const pathAfter = await fileSystem.lstat(preflight.candidatePath)
    throwIfInterrupted(signal)
    const canonicalAfter = await fileSystem.realpath(preflight.candidatePath)
    throwIfInterrupted(signal)
    const descriptorAfter = await descriptorCanonicalPath(opened.handle, fileSystem)
    throwIfInterrupted(signal)
    await assertWorkspaceRootCurrent(
      preflight.workspaceRoot,
      preflight.rootIdentity,
      fileSystem,
      signal,
    )
    if (trailing.bytesRead !== 0
      || !sameFingerprint(after, preflight.fingerprint)
      || !sameFingerprint(pathAfter, preflight.fingerprint)
      || pathAfter.isSymbolicLink()
      || canonicalAfter !== preflight.canonicalPath
      || !contained(preflight.workspaceRoot, canonicalAfter)
      || descriptorAfter !== preflight.canonicalPath
      || !contained(preflight.workspaceRoot, descriptorAfter)) {
      return failure('FILE_CHANGED', 'Outbound artifact changed while reading.')
    }
    return new Uint8Array(data)
  } catch (error) {
    if (error instanceof OutboundArtifactError) throw error
    return failure('FILE_UNAVAILABLE', 'Outbound artifact could not be read safely.', error)
  } finally {
    await opened.handle.close().catch(() => {})
  }
}

function textMediaType(name: string): string {
  const extension = extname(name).toLowerCase()
  if (extension === '.log') return 'text/x-log'
  if (extension === '.patch') return 'text/x-patch'
  if (extension === '.diff') return 'text/x-diff'
  return 'text/plain'
}

export async function readOutboundArtifact(
  preflight: OutboundArtifactPreflight,
  limits: OutboundArtifactLimits,
  options: OutboundArtifactIoOptions = {},
): Promise<PreparedOutboundArtifact> {
  validateLimits(limits)
  const data = await readStableBytes(preflight, options)
  throwIfInterrupted(options.signal)
  if (preflight.kind === 'text') {
    try {
      const prepared = prepareInboundTextResource({
        name: preflight.name,
        mediaType: textMediaType(preflight.name),
        data,
      }, limits.maxTextBytes)
      return Object.freeze({
        kind: 'file',
        name: prepared.name,
        data,
        bytes: prepared.bytes,
      })
    } catch (error) {
      return failure('INVALID_CONTENT', 'Outbound text artifact is invalid.', error)
    }
  }
  const declared = extname(preflight.name).toLowerCase() === '.png'
    ? 'image/png'
    : 'image/jpeg'
  try {
    const prepared = prepareInboundImage(
      data,
      declared,
      limits.maxImageBytes,
      limits.maxImagePixels,
    )
    if (prepared.width > MAX_LARK_OUTBOUND_IMAGE_EDGE
      || prepared.height > MAX_LARK_OUTBOUND_IMAGE_EDGE) {
      return failure('INVALID_CONTENT', 'Outbound image exceeds the platform dimension limit.')
    }
    return Object.freeze({
      kind: 'image',
      name: preflight.name,
      data: prepared.input.data,
      mediaType: prepared.input.mediaType,
      bytes: prepared.input.data.byteLength,
      width: prepared.width,
      height: prepared.height,
    })
  } catch (error) {
    return failure('INVALID_CONTENT', 'Outbound image artifact is invalid.', error)
  }
}

export function sameOutboundArtifactPreflight(
  left: OutboundArtifactPreflight,
  right: OutboundArtifactPreflight,
): boolean {
  return left.kind === right.kind
    && left.name === right.name
    && left.relativePath === right.relativePath
    && left.workspaceRoot === right.workspaceRoot
    && left.rootIdentity.dev === right.rootIdentity.dev
    && left.rootIdentity.ino === right.rootIdentity.ino
    && left.candidatePath === right.candidatePath
    && left.canonicalPath === right.canonicalPath
    && left.bytes === right.bytes
    && left.fingerprint.dev === right.fingerprint.dev
    && left.fingerprint.ino === right.fingerprint.ino
    && left.fingerprint.nlink === right.fingerprint.nlink
    && left.fingerprint.size === right.fingerprint.size
    && left.fingerprint.mtimeNs === right.fingerprint.mtimeNs
    && left.fingerprint.ctimeNs === right.fingerprint.ctimeNs
}
