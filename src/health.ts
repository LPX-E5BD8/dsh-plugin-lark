import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { LarkConnectionHealth } from './lark.ts'

export const LARK_HEALTH_PATH = '/api/lark/health'

export type LarkHealthSource = () => LarkConnectionHealth

export interface LarkHealthResponse extends LarkConnectionHealth {
  component: 'lark'
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

const UNKNOWN_HEALTH: LarkConnectionHealth = {
  state: 'unknown',
  ready: false,
  reconnectAttempts: 0,
}

function readHealth(source: LarkHealthSource): LarkConnectionHealth {
  try {
    return source()
  } catch {
    return UNKNOWN_HEALTH
  }
}

function responseBody(source: LarkHealthSource): LarkHealthResponse {
  const health = readHealth(source)
  const response: LarkHealthResponse = {
    component: 'lark',
    ready: health.ready,
    state: health.state,
    reconnectAttempts: health.reconnectAttempts,
  }
  if (health.lastAttemptAt !== undefined) response.lastAttemptAt = health.lastAttemptAt
  if (health.nextAttemptAt !== undefined) response.nextAttemptAt = health.nextAttemptAt
  return response
}

export function createLarkHealthHandler(source: LarkHealthSource) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, {
        Allow: 'GET, HEAD',
        'Cache-Control': 'no-store',
      })
      res.end()
      return
    }

    const response = responseBody(source)
    const body = JSON.stringify(response)
    const status = response.state === 'connected' ? 200 : 503
    res.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }
}

export function registerLarkHealthRoute(
  webServer: WebServerLike,
  source: LarkHealthSource,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: LARK_HEALTH_PATH,
    handler: createLarkHealthHandler(source),
  })
}

/** Install the route whenever the optional Web host service is available. */
export function installLarkHealthRoute(ctx: Context, source: LarkHealthSource): void {
  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.get('webServer') as WebServerLike | undefined
    if (webServer === undefined) return
    try {
      return registerLarkHealthRoute(webServer, source)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      injected.logger.warn('[lark] health route registration failed: %s', detail)
    }
  })
}
