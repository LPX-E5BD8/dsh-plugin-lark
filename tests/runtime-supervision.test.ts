import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  ChannelOwnershipError,
  ChannelOwnershipLock,
  DEFAULT_OWNER_TTL_MS,
  evaluateOwnership,
  ownerRecordIsStale,
  MAX_OWNER_TTL_MS,
  MIN_OWNER_TTL_MS,
  RUNTIME_OWNER_FILE,
  RUNTIME_STATUS_FILE,
  RuntimeSupervisor,
  runtimeStatusDocument,
  validateOwnerTtl,
  validateRuntimeDir,
  writeRuntimeStatus,
} from '../src/runtime-supervision.ts'

async function runtimeDir(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-runtime-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('ownership decisions treat a live record as held and an expired one as free', () => {
  const mine = randomUUID()
  const theirs = randomUUID()
  const record = {
    instanceId: theirs,
    pid: 1234,
    acquiredAt: 1_000,
    heartbeatAt: 1_000,
    ttlMs: 30_000,
  }
  assert.equal(evaluateOwnership(undefined, mine, 1_000), 'acquire')
  assert.equal(evaluateOwnership({ ...record, instanceId: mine }, mine, 40_000), 'renew')
  assert.equal(evaluateOwnership(record, mine, 1_000 + 29_999), 'held')
  // An abandoned record is never silently taken: one actor clears it first.
  assert.equal(evaluateOwnership(record, mine, 1_000 + 30_000), 'stale')
  assert.equal(ownerRecordIsStale(record, 1_000 + 29_999), false)
  assert.equal(ownerRecordIsStale(record, 1_000 + 30_000), true)
})

test('runtime supervision inputs are bounded and absolute', () => {
  assert.equal(validateOwnerTtl(MIN_OWNER_TTL_MS), MIN_OWNER_TTL_MS)
  assert.equal(validateOwnerTtl(MAX_OWNER_TTL_MS), MAX_OWNER_TTL_MS)
  assert.throws(() => validateOwnerTtl(MIN_OWNER_TTL_MS - 1), RangeError)
  assert.throws(() => validateOwnerTtl(MAX_OWNER_TTL_MS + 1), RangeError)
  assert.throws(() => validateOwnerTtl(1_000.5), RangeError)
  assert.equal(validateRuntimeDir('/srv/lark '), '/srv/lark')
  assert.throws(() => validateRuntimeDir('relative/path'), TypeError)
  assert.throws(() => validateRuntimeDir('   '), TypeError)
})

test('a second instance is refused while the first still heartbeats', async (t) => {
  const dir = await runtimeDir(t)
  const first = await ChannelOwnershipLock.acquire(dir, 1_000, DEFAULT_OWNER_TTL_MS)

  await assert.rejects(
    () => ChannelOwnershipLock.acquire(dir, 1_500, DEFAULT_OWNER_TTL_MS),
    (error: unknown) => error instanceof ChannelOwnershipError && error.code === 'HELD',
  )

  // Renewing keeps the record live, so the window never opens on its own.
  assert.equal(await first.heartbeat(20_000), true)
  await assert.rejects(
    () => ChannelOwnershipLock.acquire(dir, 40_000, DEFAULT_OWNER_TTL_MS),
    (error: unknown) => error instanceof ChannelOwnershipError && error.code === 'HELD',
  )

  await first.release()
  const second = await ChannelOwnershipLock.acquire(dir, 41_000, DEFAULT_OWNER_TTL_MS)
  assert.notEqual(second.instanceId, first.instanceId)
  await second.release()
})

test('a crashed owner blocks a replacement until its record is cleared', async (t) => {
  const dir = await runtimeDir(t)
  const crashed = await ChannelOwnershipLock.acquire(dir, 1_000, MIN_OWNER_TTL_MS)

  await assert.rejects(
    () => ChannelOwnershipLock.acquire(dir, 1_000 + MIN_OWNER_TTL_MS - 1, MIN_OWNER_TTL_MS),
    (error: unknown) => error instanceof ChannelOwnershipError && error.code === 'HELD',
  )
  // Past the ttl the record is abandoned, but a starting instance still refuses
  // to remove it: clearing is a single-actor recovery step.
  await assert.rejects(
    () => ChannelOwnershipLock.acquire(dir, 1_000 + MIN_OWNER_TTL_MS, MIN_OWNER_TTL_MS),
    (error: unknown) => error instanceof ChannelOwnershipError && error.code === 'STALE',
  )

  await rm(join(dir, RUNTIME_OWNER_FILE), { force: true })
  const recovered = await ChannelOwnershipLock.acquire(dir, 1_000 + MIN_OWNER_TTL_MS, MIN_OWNER_TTL_MS)
  assert.notEqual(recovered.instanceId, crashed.instanceId)

  // The crashed instance must not reclaim or delete the new record.
  assert.equal(await crashed.heartbeat(1_000 + MIN_OWNER_TTL_MS + 1), false)
  await crashed.release()
  const owner = JSON.parse(await readFile(join(dir, RUNTIME_OWNER_FILE), 'utf8')) as {
    instanceId: string
  }
  assert.equal(owner.instanceId, recovered.instanceId)
  await recovered.release()
})

test('a released owner never reclaims the file and leaves no record behind', async (t) => {
  const dir = await runtimeDir(t)
  const lock = await ChannelOwnershipLock.acquire(dir, 1_000)
  await lock.release()
  await assert.rejects(() => stat(join(dir, RUNTIME_OWNER_FILE)))
  assert.equal(await lock.heartbeat(2_000), false)
  await lock.release()
})

test('a corrupt owner record refuses a start instead of being overwritten', async (t) => {
  const dir = await runtimeDir(t)
  await writeFile(join(dir, RUNTIME_OWNER_FILE), '{ truncated', 'utf8')
  await assert.rejects(
    () => ChannelOwnershipLock.acquire(dir, 1_000),
    (error: unknown) => error instanceof ChannelOwnershipError && error.code === 'HELD',
  )
  await rm(join(dir, RUNTIME_OWNER_FILE), { force: true })
  const lock = await ChannelOwnershipLock.acquire(dir, 1_000)
  assert.equal(await lock.heartbeat(2_000), true)
  await lock.release()
})

// A record this process cannot parse -- a newer format, say -- belongs to
// something else. Rewriting it would clobber that writer.
test('an owner record that becomes unreadable is lost ownership, not ours', async (t) => {
  const dir = await runtimeDir(t)
  const ownerFile = join(dir, RUNTIME_OWNER_FILE)
  const lock = await ChannelOwnershipLock.acquire(dir, 1_000)
  assert.equal(await lock.heartbeat(2_000), true)

  await writeFile(ownerFile, '{"instanceId":"from-a-newer-release"', 'utf8')
  assert.equal(await lock.heartbeat(3_000), false, 'an unreadable record was treated as ours')
  assert.equal(await readFile(ownerFile, 'utf8'), '{"instanceId":"from-a-newer-release"')

  // Releasing must not delete it either.
  await lock.release()
  assert.equal(await readFile(ownerFile, 'utf8'), '{"instanceId":"from-a-newer-release"')
})

test('the status document is readable, private, and free of identifiers', async (t) => {
  const dir = await runtimeDir(t)
  const instanceId = randomUUID()
  await writeRuntimeStatus(dir, runtimeStatusDocument({
    instanceId,
    version: '0.9.16',
    state: 'ready',
    ready: true,
    startedAt: 1_700_000_000_000,
    now: 1_700_000_030_000,
  }))
  const path = join(dir, RUNTIME_STATUS_FILE)
  const raw = await readFile(path, 'utf8')
  const document = JSON.parse(raw) as Record<string, unknown>
  assert.equal(document.component, 'lark')
  assert.equal(document.state, 'ready')
  assert.equal(document.ready, true)
  assert.equal(document.version, '0.9.16')
  assert.equal(document.startedAt, '2023-11-14T22:13:20.000Z')
  assert.doesNotMatch(raw, /oc_|ou_|cli_|secret|token|\/home\//u)
  assert.equal(((await stat(path)).mode & 0o777).toString(8), '600')

  // Rewriting replaces the document in place without leaving staging files.
  await writeRuntimeStatus(dir, runtimeStatusDocument({
    instanceId,
    version: '0.9.16',
    state: 'stopped',
    ready: false,
    startedAt: 1_700_000_000_000,
    now: 1_700_000_060_000,
  }))
  const stopped = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.ready, false)
})

test('the supervisor publishes its lifecycle and releases ownership on stop', async (t) => {
  const dir = await runtimeDir(t)
  let lost = 0
  const supervisor = await RuntimeSupervisor.start({
    runtimeDir: dir,
    version: '0.9.16',
    ttlMs: MIN_OWNER_TTL_MS,
    onOwnershipLost: () => { lost += 1 },
  })
  const statusPath = join(dir, RUNTIME_STATUS_FILE)
  assert.equal(
    (JSON.parse(await readFile(statusPath, 'utf8')) as { state: string }).state,
    'starting',
  )
  await supervisor.markReady()
  const ready = JSON.parse(await readFile(statusPath, 'utf8')) as { state: string; ready: boolean }
  assert.equal(ready.state, 'ready')
  assert.equal(ready.ready, true)

  await supervisor.stop()
  const stopped = JSON.parse(await readFile(statusPath, 'utf8')) as { state: string; ready: boolean }
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.ready, false)
  await assert.rejects(() => stat(join(dir, RUNTIME_OWNER_FILE)))
  await supervisor.stop()
  assert.equal(lost, 0)
})

test('a supervisor displaced by a mis-recovery reports degraded and stops serving', async (t) => {
  const dir = await runtimeDir(t)
  let lost = 0
  let clock = 1_000
  const supervisor = await RuntimeSupervisor.start({
    runtimeDir: dir,
    version: '0.9.16',
    ttlMs: MIN_OWNER_TTL_MS,
    now: () => clock,
    onOwnershipLost: () => { lost += 1 },
  })
  await supervisor.markReady()

  // Model a mis-recovery: an operator clears a record that is still live, so a
  // second process claims the channel while this one is still serving.
  clock += MIN_OWNER_TTL_MS
  await rm(join(dir, RUNTIME_OWNER_FILE), { force: true })
  const usurper = await ChannelOwnershipLock.acquire(dir, clock, MIN_OWNER_TTL_MS)
  t.after(() => usurper.release())

  await new Promise((resolve) => setTimeout(resolve, Math.floor(MIN_OWNER_TTL_MS / 3) + 400))
  assert.equal(lost, 1, 'the displaced supervisor never reported lost ownership')
  const degraded = JSON.parse(await readFile(join(dir, RUNTIME_STATUS_FILE), 'utf8')) as {
    state: string
    ready: boolean
  }
  assert.equal(degraded.state, 'degraded')
  assert.equal(degraded.ready, false)

  // Stopping the displaced supervisor must not delete the new owner's record.
  await supervisor.stop()
  const owner = JSON.parse(await readFile(join(dir, RUNTIME_OWNER_FILE), 'utf8')) as {
    instanceId: string
  }
  assert.equal(owner.instanceId, usurper.instanceId)
})

// The shipped readiness script is the external contract, so drive it directly
// instead of reimplementing its parsing.
test('the shipped readiness script judges the real status document', async (t) => {
  const dir = await runtimeDir(t)
  const script = join(process.cwd(), 'contrib', 'systemd', 'lark-readiness.sh')
  const run = (maxAge?: string): { code: number; stderr: string; stdout: string } => {
    const result = spawnSync('sh', maxAge === undefined ? [script, dir] : [script, dir, maxAge], {
      encoding: 'utf8',
    })
    return { code: result.status ?? -1, stderr: result.stderr, stdout: result.stdout }
  }

  assert.equal(run().code, 2, 'a missing status document must not read as ready')

  const instanceId = randomUUID()
  const publish = (state: 'ready' | 'degraded' | 'stopped', ready: boolean, now: number) => (
    writeRuntimeStatus(dir, runtimeStatusDocument({
      instanceId,
      version: '0.9.16',
      state,
      ready,
      startedAt: now - 1_000,
      now,
    }))
  )

  await publish('ready', true, Date.now())
  const serving = run()
  assert.equal(serving.code, 0, serving.stderr)
  assert.match(serving.stdout, /state=ready/u)

  await publish('degraded', false, Date.now())
  assert.equal(run().code, 1, 'a degraded channel must not read as ready')

  await publish('stopped', false, Date.now())
  assert.equal(run().code, 1, 'a stopped channel must not read as ready')

  // A stale heartbeat is not ready even when the last written state said ready.
  await publish('ready', true, Date.now() - 600_000)
  const stale = run('60')
  assert.equal(stale.code, 1, stale.stdout)
  assert.match(stale.stderr, /heartbeat is \d+s old/u)
})

test('concurrent starts on a free channel leave a single owner', async (t) => {
  const dir = await runtimeDir(t)

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => ChannelOwnershipLock.acquire(dir, 1_000, MIN_OWNER_TTL_MS)),
  )
  const winners = results.filter((result) => result.status === 'fulfilled')
  assert.equal(winners.length, 1, `expected exactly one owner, got ${winners.length}`)
  for (const result of results) {
    if (result.status === 'fulfilled') continue
    assert.ok(
      result.reason instanceof ChannelOwnershipError && result.reason.code === 'HELD',
      `unexpected rejection: ${String(result.reason)}`,
    )
  }
  const owner = JSON.parse(await readFile(join(dir, RUNTIME_OWNER_FILE), 'utf8')) as {
    instanceId: string
  }
  const winner = winners[0] as PromiseFulfilledResult<ChannelOwnershipLock>
  assert.equal(owner.instanceId, winner.value.instanceId)
  await winner.value.release()
})

// The recovery script is the single actor allowed to clear a record, so its
// judgement is a shipped contract rather than an implementation detail.
test('the shipped recovery script clears only an abandoned owner record', async (t) => {
  const dir = await runtimeDir(t)
  const script = join(process.cwd(), 'contrib', 'systemd', 'lark-clear-stale-owner.sh')
  const run = (): { code: number; stderr: string } => {
    const result = spawnSync('sh', [script, dir], { encoding: 'utf8' })
    return { code: result.status ?? -1, stderr: result.stderr }
  }
  const ownerFile = join(dir, RUNTIME_OWNER_FILE)

  assert.equal(run().code, 0, 'a free channel needs no recovery')

  const live = await ChannelOwnershipLock.acquire(dir, Date.now(), MIN_OWNER_TTL_MS)
  assert.equal(run().code, 1, 'a live owner must never be cleared')
  await assert.doesNotReject(() => stat(ownerFile))

  await live.heartbeat(Date.now() - MIN_OWNER_TTL_MS - 1_000)
  const cleared = run()
  assert.equal(cleared.code, 0, cleared.stderr)
  await assert.rejects(() => stat(ownerFile), 'an abandoned record must be removed')

  await writeFile(ownerFile, '{ truncated', 'utf8')
  assert.equal(run().code, 2, 'an unreadable record is not proof the channel is free')
  await assert.doesNotReject(() => stat(ownerFile))
  await live.release()
})

// macOS ships BSD date, which rejects the GNU `-d` form, so a GNU host runs the
// shipped script against a BSD-shaped `date` to cover that branch too. A BSD
// host already exercises it natively and cannot host the GNU-based shim.
const hostDateIsGnu = spawnSync('date', ['--version'], { encoding: 'utf8' }).status === 0

test('the readiness script reads a heartbeat with BSD date as well as GNU date', {
  skip: hostDateIsGnu ? false : 'host date is already BSD, which the shipped script covers natively',
}, async (t) => {
  const dir = await runtimeDir(t)
  const shimDir = await mkdtemp(join(tmpdir(), 'dsh-lark-bsd-date-'))
  t.after(() => rm(shimDir, { recursive: true, force: true }))
  const realDate = spawnSync('sh', ['-c', 'command -v date'], { encoding: 'utf8' }).stdout.trim()
  assert.ok(realDate.length > 0)
  await writeFile(join(shimDir, 'date'), [
    '#!/bin/sh',
    // BSD date has no --version and no GNU -d; both must fail here.
    '[ "$1" = "--version" ] && exit 1',
    '[ "$2" = "-d" ] && exit 1',
    `[ "$2" = "-j" ] && exec ${realDate} -u -d "$5" "$6"`,
    `exec ${realDate} "$@"`,
    '',
  ].join('\n'), { mode: 0o755 })

  await writeRuntimeStatus(dir, runtimeStatusDocument({
    instanceId: randomUUID(),
    version: '0.9.16',
    state: 'ready',
    ready: true,
    startedAt: Date.now() - 1_000,
    now: Date.now(),
  }))
  const script = join(process.cwd(), 'contrib', 'systemd', 'lark-readiness.sh')
  const result = spawnSync('sh', [script, dir], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` },
  })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
  assert.match(result.stdout, /state=ready/u)
})
