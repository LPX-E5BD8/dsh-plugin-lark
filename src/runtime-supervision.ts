import { randomUUID } from 'node:crypto'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

export const RUNTIME_STATUS_FILE = 'status.json'
export const RUNTIME_OWNER_FILE = 'owner.json'
export const RUNTIME_STATUS_VERSION = 1
export const DEFAULT_OWNER_TTL_MS = 30_000
export const MIN_OWNER_TTL_MS = 5_000
export const MAX_OWNER_TTL_MS = 5 * 60_000
const FILE_MODE = 0o600

export type RuntimeState = 'starting' | 'ready' | 'degraded' | 'stopped'

export class ChannelOwnershipError extends Error {
  constructor(readonly code: 'HELD' | 'STALE' | 'UNAVAILABLE', message: string) {
    super(message)
    this.name = 'ChannelOwnershipError'
  }
}

const ownerSchema = z.object({
  instanceId: z.string().uuid(),
  pid: z.number().int().nonnegative(),
  acquiredAt: z.number().int().nonnegative(),
  heartbeatAt: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive(),
}).strict()

export type ChannelOwnerRecord = z.infer<typeof ownerSchema>

export interface RuntimeStatusDocument {
  readonly component: 'lark'
  readonly statusVersion: typeof RUNTIME_STATUS_VERSION
  readonly instanceId: string
  readonly pid: number
  readonly version: string
  readonly state: RuntimeState
  readonly ready: boolean
  readonly startedAt: string
  readonly heartbeatAt: string
}

export function validateOwnerTtl(ttlMs: number): number {
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_OWNER_TTL_MS || ttlMs > MAX_OWNER_TTL_MS) {
    throw new RangeError(
      `lark: runtime owner ttl must be an integer between ${MIN_OWNER_TTL_MS} and ${MAX_OWNER_TTL_MS}`,
    )
  }
  return ttlMs
}

export function validateRuntimeDir(dir: string): string {
  const trimmed = dir.trim()
  if (trimmed === '' || !isAbsolute(trimmed)) {
    throw new TypeError('lark: runtimeDir must be an absolute path')
  }
  return trimmed
}

/**
 * Decide what an existing owner record means for this instance. Exclusive
 * creation is the only safe way to become the owner, so a contender never
 * removes someone else's record: a live one is `held` and an abandoned one is
 * `stale`, which one supervisor clears before the next start.
 */
export function evaluateOwnership(
  current: ChannelOwnerRecord | undefined,
  instanceId: string,
  now: number,
): 'acquire' | 'renew' | 'held' | 'stale' {
  if (current === undefined) return 'acquire'
  if (current.instanceId === instanceId) return 'renew'
  if (now - current.heartbeatAt >= current.ttlMs) return 'stale'
  return 'held'
}

/** True when a record is abandoned and safe for a supervisor to clear. */
export function ownerRecordIsStale(current: ChannelOwnerRecord, now: number): boolean {
  return now - current.heartbeatAt >= current.ttlMs
}

function ownerRecord(instanceId: string, now: number, ttlMs: number, acquiredAt: number): ChannelOwnerRecord {
  return Object.freeze({
    instanceId,
    pid: process.pid,
    acquiredAt,
    heartbeatAt: now,
    ttlMs,
  })
}

async function writeFileAtomically(path: string, body: string): Promise<void> {
  const staging = `${path}.${randomUUID()}.tmp`
  const handle = await open(staging, 'wx', FILE_MODE)
  try {
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(staging, path)
  } catch (error) {
    await rm(staging, { force: true })
    throw error
  }
}

async function readOwner(path: string): Promise<ChannelOwnerRecord | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ChannelOwnershipError('UNAVAILABLE', 'lark: runtime owner file is unreadable')
  }
  try {
    return Object.freeze(ownerSchema.parse(JSON.parse(raw)))
  } catch {
    // A truncated or foreign record -- including one written by a newer release
    // -- is not proof that the channel is free, and it is not ours to rewrite.
    // Callers must treat this as an owner they cannot reason about.
    throw new ChannelOwnershipError('UNAVAILABLE', 'lark: runtime owner record is unreadable')
  }
}

/**
 * Cross-process ownership of one Lark channel, held as a heartbeat file next to
 * the runtime status document. `O_EXCL` creation is the mutual-exclusion
 * primitive because the JSON storage backend has no cross-process writer lock.
 */
export class ChannelOwnershipLock {
  private released = false

  private constructor(
    readonly instanceId: string,
    private readonly path: string,
    private readonly ttlMs: number,
    private readonly acquiredAt: number,
  ) {}

  static async acquire(
    runtimeDir: string,
    now: number,
    ttlMs: number = DEFAULT_OWNER_TTL_MS,
    instanceId: string = randomUUID(),
  ): Promise<ChannelOwnershipLock> {
    const path = join(validateRuntimeDir(runtimeDir), RUNTIME_OWNER_FILE)
    const validTtl = validateOwnerTtl(ttlMs)
    const body = `${JSON.stringify(ownerRecord(instanceId, now, validTtl, now))}\n`
    let created
    try {
      created = await open(path, 'wx', FILE_MODE)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ChannelOwnershipError('UNAVAILABLE', 'lark: runtime owner file is not writable')
      }
    }
    if (created !== undefined) {
      try {
        await created.writeFile(body, 'utf8')
        await created.sync()
      } catch {
        await created.close().catch(() => {})
        // An empty record would read as an expired owner, so remove it instead.
        await rm(path, { force: true })
        throw new ChannelOwnershipError('UNAVAILABLE', 'lark: runtime owner file is not writable')
      }
      await created.close()
      return new ChannelOwnershipLock(instanceId, path, validTtl, now)
    }
    // Exclusive creation lost, so someone else holds the record. Removing it here
    // would race every other contender doing the same, and two owners of one bot
    // is exactly what this guards against. Clearing an abandoned record is a
    // single-actor recovery step, not something a starting instance may do.
    let current: ChannelOwnerRecord | undefined
    try {
      current = await readOwner(path)
    } catch {
      throw new ChannelOwnershipError(
        'HELD',
        'lark: an unreadable channel owner record remains; inspect it before starting a replacement',
      )
    }
    if (current !== undefined && ownerRecordIsStale(current, now)) {
      throw new ChannelOwnershipError(
        'STALE',
        'lark: an abandoned channel owner record remains; clear it before starting a replacement',
      )
    }
    throw new ChannelOwnershipError(
      'HELD',
      'lark: another process already owns this channel; stop it before starting another',
    )
  }

  /**
   * Refresh the heartbeat. Returns false when another instance has taken the
   * file over, which the caller must treat as lost ownership and fail closed.
   */
  async heartbeat(now: number): Promise<boolean> {
    if (this.released) return false
    let current: ChannelOwnerRecord | undefined
    try {
      current = await readOwner(this.path)
    } catch {
      // Rewriting a record this process cannot parse would clobber whatever
      // wrote it, so treat it as ownership already lost.
      return false
    }
    if (current !== undefined && current.instanceId !== this.instanceId) return false
    const body = `${JSON.stringify(ownerRecord(this.instanceId, now, this.ttlMs, this.acquiredAt))}\n`
    await writeFileAtomically(this.path, body)
    return true
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    const current = await readOwner(this.path).catch(() => 'unreadable' as const)
    if (current === 'unreadable') return
    if (current !== undefined && current.instanceId !== this.instanceId) return
    await rm(this.path, { force: true })
  }
}

/**
 * Publish a bounded status document an external supervisor can read without
 * loading the Harness profile graph. It carries no credential, platform
 * identifier, conversation scope, or filesystem path.
 */
export async function writeRuntimeStatus(
  runtimeDir: string,
  document: RuntimeStatusDocument,
): Promise<void> {
  const path = join(validateRuntimeDir(runtimeDir), RUNTIME_STATUS_FILE)
  await writeFileAtomically(path, `${JSON.stringify(document)}\n`)
}

export function runtimeStatusDocument(input: {
  readonly instanceId: string
  readonly version: string
  readonly state: RuntimeState
  readonly ready: boolean
  readonly startedAt: number
  readonly now: number
}): RuntimeStatusDocument {
  return Object.freeze({
    component: 'lark' as const,
    statusVersion: RUNTIME_STATUS_VERSION,
    instanceId: input.instanceId,
    pid: process.pid,
    version: input.version,
    state: input.state,
    ready: input.ready,
    startedAt: new Date(input.startedAt).toISOString(),
    heartbeatAt: new Date(input.now).toISOString(),
  })
}

export interface RuntimeSupervisorOptions {
  readonly runtimeDir: string
  readonly version: string
  readonly ttlMs?: number
  /** Called once when another process has taken ownership of this channel. */
  readonly onOwnershipLost: () => void
  readonly logger?: { error(message: string): void }
  readonly now?: () => number
}

/**
 * Holds channel ownership for the life of the plugin and publishes the status
 * document an external supervisor reads. Losing ownership is terminal: the
 * caller stops serving rather than competing with the new owner.
 */
export class RuntimeSupervisor {
  private timer: NodeJS.Timeout | undefined
  private stopping = false

  private constructor(
    private readonly lock: ChannelOwnershipLock,
    private readonly options: RuntimeSupervisorOptions,
    private readonly startedAt: number,
    private readonly ttlMs: number,
  ) {}

  static async start(options: RuntimeSupervisorOptions): Promise<RuntimeSupervisor> {
    const dir = validateRuntimeDir(options.runtimeDir)
    const ttlMs = validateOwnerTtl(options.ttlMs ?? DEFAULT_OWNER_TTL_MS)
    const clock = options.now ?? Date.now
    const startedAt = clock()
    const lock = await ChannelOwnershipLock.acquire(dir, startedAt, ttlMs)
    const supervisor = new RuntimeSupervisor(lock, { ...options, runtimeDir: dir }, startedAt, ttlMs)
    try {
      await supervisor.publish('starting', false, startedAt)
    } catch (error) {
      await lock.release().catch(() => {})
      throw error
    }
    return supervisor
  }

  async markReady(): Promise<void> {
    const clock = this.options.now ?? Date.now
    await this.publish('ready', true, clock())
    this.timer ??= setInterval(() => {
      void this.beat()
    }, Math.max(1_000, Math.floor(this.ttlMs / 3)))
    this.timer.unref?.()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    const clock = this.options.now ?? Date.now
    try {
      await this.publish('stopped', false, clock())
    } catch (error) {
      this.options.logger?.error(`lark: runtime status write failed: ${String(error)}`)
    }
    await this.lock.release()
  }

  private async beat(): Promise<void> {
    if (this.stopping) return
    const clock = this.options.now ?? Date.now
    const now = clock()
    let held: boolean
    try {
      held = await this.lock.heartbeat(now)
    } catch (error) {
      this.options.logger?.error(`lark: runtime owner heartbeat failed: ${String(error)}`)
      return
    }
    if (held) {
      await this.publish('ready', true, now).catch((error: unknown) => {
        this.options.logger?.error(`lark: runtime status write failed: ${String(error)}`)
      })
      return
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    this.options.logger?.error('lark: channel ownership was taken by another process; stopping')
    await this.publish('degraded', false, now).catch(() => {})
    this.options.onOwnershipLost()
  }

  private publish(state: RuntimeState, ready: boolean, now: number): Promise<void> {
    return writeRuntimeStatus(this.options.runtimeDir, runtimeStatusDocument({
      instanceId: this.lock.instanceId,
      version: this.options.version,
      state,
      ready,
      startedAt: this.startedAt,
      now,
    }))
  }
}
