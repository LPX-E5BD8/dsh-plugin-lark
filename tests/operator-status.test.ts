import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderOperatorCard } from '../src/cards.ts'
import {
  buildDiagChecks,
  classifyConversation,
  classifyOperatorFailure,
  formatDiagBody,
  formatStatusBody,
  formatUptime,
  pluginReleaseVersion,
  sanitizeOperatorLabel,
} from '../src/operator-status.ts'

test('status formatting exposes no platform identifiers or paths', () => {
  const body = formatStatusBody({
    version: pluginReleaseVersion(),
    uptimeMs: 125_000,
    connection: 'connected',
    conversation: 'direct',
    project: 'registered',
    modelProvider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    work: 'idle',
    contextLabel: '128000',
  }, 'en-US')
  assert.match(body, /Version: \d+\.\d+\.\d+/u)
  assert.match(body, /Uptime: 2m 5s/u)
  assert.match(body, /Connection: connected/u)
  assert.match(body, /Conversation: direct chat/u)
  assert.doesNotMatch(body, /oc_|ou_|om_|cli_|\/home\/|\/tmp\//u)
  assert.equal(formatUptime(1_500), '1s')
  assert.equal(classifyConversation({
    shared: false,
    chatType: 'group',
    threaded: true,
  }), 'thread')
})

test('diag checks stay actionable and secret-free', () => {
  const checks = buildDiagChecks({
    botReady: false,
    workspaceCount: 0,
    persistenceMounted: false,
    storageFlushOk: false,
    providerConfigured: true,
    recentFailures: ['delivery', 'notify'],
  }, 'en-US')
  const body = formatDiagBody(checks, 'en-US')
  assert.match(body, /FAIL Bot identity is unavailable/u)
  assert.match(body, /WARN No Workspaces are registered/u)
  assert.match(body, /FAIL Session persistence is not mounted/u)
  assert.match(body, /FAIL Storage-domain write check failed/u)
  assert.match(body, /Recent failure classes: delivery, notify/u)
  assert.doesNotMatch(body, /oc_|ou_|secret|token|\/home\//u)
  assert.equal(classifyOperatorFailure('notify drain failed'), 'notify')
  assert.equal(sanitizeOperatorLabel('oc_should_stay_short', 'x').startsWith('oc_'), true)
})

test('operator cards reuse the shared Card 2.0 style', () => {
  const card = renderOperatorCard({
    locale: 'en-US',
    kind: 'status',
    body: formatStatusBody({
      version: '0.9.13',
      uptimeMs: 0,
      connection: 'connected',
      conversation: 'direct',
      project: 'none',
      modelProvider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      work: 'idle',
    }, 'en-US'),
  })
  assert.equal(card.schema, '2.0')
  const encoded = JSON.stringify(card)
  assert.match(encoded, /"element_id":"status"/u)
  assert.match(encoded, /Channel status/u)
  assert.match(encoded, /16px 16px 16px 16px/u)
  assert.doesNotMatch(encoded, /oc_|om_/u)
})
