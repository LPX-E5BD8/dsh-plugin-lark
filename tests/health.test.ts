import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import {
  createLarkHealthHandler,
  installLarkHealthRoute,
  LARK_HEALTH_PATH,
  registerLarkHealthRoute,
} from '../src/health.ts'
import type { WebServerLike } from '../src/health.ts'
import type { LarkConnectionHealth } from '../src/lark.ts'

interface CapturedResponse {
  status: number
  headers: Record<string, string | number>
  body: string
}

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage
}

function response(): { capture: CapturedResponse; value: ServerResponse } {
  const capture: CapturedResponse = { status: 0, headers: {}, body: '' }
  const value = {
    writeHead(status: number, headers: Record<string, string | number>) {
      capture.status = status
      capture.headers = Object.fromEntries(
        Object.entries(headers).map(([key, item]) => [key.toLowerCase(), item]),
      )
      return value
    },
    end(chunk?: string) {
      if (chunk !== undefined) capture.body += chunk
      return value
    },
  } as unknown as ServerResponse
  return { capture, value }
}

function connectedHealth(): LarkConnectionHealth {
  return {
    state: 'connected',
    ready: true,
    reconnectAttempts: 2,
    lastAttemptAt: '2026-08-16T01:02:03.000Z',
    nextAttemptAt: '2026-08-16T01:02:04.000Z',
  }
}

async function invoke(method: string, source = connectedHealth): Promise<CapturedResponse> {
  const target = response()
  await createLarkHealthHandler(source)(request(method), target.value)
  return target.capture
}

test('health handler returns only the public connected snapshot and disables caching', async () => {
  const result = await invoke('GET', () => ({
    ...connectedHealth(),
    secret: 'must-not-leak',
  } as LarkConnectionHealth))

  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(result.headers['content-length'], Buffer.byteLength(result.body))
  assert.deepEqual(JSON.parse(result.body), {
    component: 'lark',
    ready: true,
    state: 'connected',
    reconnectAttempts: 2,
    lastAttemptAt: '2026-08-16T01:02:03.000Z',
    nextAttemptAt: '2026-08-16T01:02:04.000Z',
  })
})

test('health handler reports every non-connected state as unavailable', async () => {
  const states: LarkConnectionHealth['state'][] = [
    'idle',
    'connecting',
    'reconnecting',
    'failed',
    'stopped',
    'unknown',
  ]
  for (const state of states) {
    const result = await invoke('GET', () => ({ state, ready: false, reconnectAttempts: 3 }))
    assert.equal(result.status, 503, state)
    assert.deepEqual(JSON.parse(result.body), {
      component: 'lark',
      ready: false,
      state,
      reconnectAttempts: 3,
    })
  }
})

test('health handler degrades source failures to a bounded unknown response', async () => {
  const result = await invoke('GET', () => {
    throw new Error('credential-shaped internal detail')
  })

  assert.equal(result.status, 503)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(result.body), {
    component: 'lark',
    ready: false,
    state: 'unknown',
    reconnectAttempts: 0,
  })
  assert.doesNotMatch(result.body, /credential-shaped/)
})

test('health handler supports HEAD without a body', async () => {
  const result = await invoke('HEAD')

  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['content-length'], Buffer.byteLength(JSON.stringify({
    component: 'lark',
    ready: true,
    state: 'connected',
    reconnectAttempts: 2,
    lastAttemptAt: '2026-08-16T01:02:03.000Z',
    nextAttemptAt: '2026-08-16T01:02:04.000Z',
  })))
  assert.equal(result.body, '')

  const unavailable = await invoke('HEAD', () => ({
    state: 'reconnecting',
    ready: false,
    reconnectAttempts: 4,
  }))
  assert.equal(unavailable.status, 503)
  assert.equal(unavailable.headers['cache-control'], 'no-store')
  assert.equal(unavailable.body, '')
})

test('health handler rejects unsupported methods with Allow and no-store', async () => {
  const result = await invoke('POST')

  assert.equal(result.status, 405)
  assert.equal(result.headers.allow, 'GET, HEAD')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.body, '')
})

test('health route registration claims the exact public path and returns its disposer', () => {
  let route: Parameters<WebServerLike['register']>[0] | undefined
  let disposed = false
  const webServer: WebServerLike = {
    register(value) {
      route = value
      return () => { disposed = true }
    },
  }

  const dispose = registerLarkHealthRoute(webServer, connectedHealth)
  assert.equal(route?.kind, 'exact')
  assert.equal(route?.path, LARK_HEALTH_PATH)
  assert.equal(typeof route?.handler, 'function')
  dispose()
  assert.equal(disposed, true)
})

class LifecycleWebServer implements WebServerLike {
  registrations = 0
  disposals = 0
  route: Parameters<WebServerLike['register']>[0] | undefined

  register(route: Parameters<WebServerLike['register']>[0]): () => void {
    this.registrations += 1
    this.route = route
    return () => {
      this.disposals += 1
      this.route = undefined
    }
  }
}

function provideWebServer(ctx: Context, webServer: WebServerLike): void {
  ctx.provide('webServer', webServer)
}

function settleCordis(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('health route follows optional WebServer mounts and owner cleanup', async () => {
  const ctx = new Context()
  const first = new LifecycleWebServer()
  const second = new LifecycleWebServer()
  const owner = ctx.plugin((ownerCtx) => {
    installLarkHealthRoute(ownerCtx, connectedHealth)
  })
  await owner
  assert.equal(first.registrations, 0)

  const firstProvider = ctx.plugin(provideWebServer, first)
  await firstProvider
  await settleCordis()
  assert.equal(first.registrations, 1)
  assert.equal(first.route?.path, LARK_HEALTH_PATH)

  await firstProvider.dispose()
  assert.equal(first.disposals, 1)
  assert.equal(first.route, undefined)

  const secondProvider = ctx.plugin(provideWebServer, second)
  await secondProvider
  await settleCordis()
  assert.equal(second.registrations, 1)

  await owner.dispose()
  assert.equal(second.disposals, 1)
  assert.equal(second.route, undefined)
  await secondProvider.dispose()
})

test('health route registration conflicts warn without failing either owner', async () => {
  const ctx = new Context()
  const warnings: unknown[][] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message) {
      if (message.type === 'warn') warnings.push(message.args)
    },
  })
  const owner = ctx.plugin((ownerCtx) => {
    installLarkHealthRoute(ownerCtx, connectedHealth)
  })
  await owner
  const provider = ctx.plugin(provideWebServer, {
    register() {
      throw new Error('duplicate exact route')
    },
  })
  await provider
  await settleCordis()

  assert.equal(owner.uid === null, false)
  assert.equal(provider.uid === null, false)
  assert.ok(warnings.some((args) => (
    args.join(' ').includes('health route registration failed')
      && args.join(' ').includes('duplicate exact route')
  )))
  await provider.dispose()

  const recovered = new LifecycleWebServer()
  const replacement = ctx.plugin(provideWebServer, recovered)
  await replacement
  await settleCordis()
  assert.equal(recovered.registrations, 1)
  assert.equal(recovered.route?.path, LARK_HEALTH_PATH)

  await owner.dispose()
  assert.equal(recovered.disposals, 1)
  await replacement.dispose()
})
