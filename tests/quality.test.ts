import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { CARD_LIMITS, renderTurnCard } from '../src/cards.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { nonCatalogPolicyTypes, projectActivity, unclassifiedKnownEventTypes } from '../src/events.ts'
import { apply } from '../src/index.ts'
import { LARK_LOCALES } from '../src/locale.ts'

const MAX_CONTROL_DEPTH = 3

function sourceFiles(directory: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path))
    if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path)
  }
  return files
}

function isControl(node: ts.Node): boolean {
  return ts.isIfStatement(node)
    || ts.isSwitchStatement(node)
    || ts.isForStatement(node)
    || ts.isForInStatement(node)
    || ts.isForOfStatement(node)
    || ts.isWhileStatement(node)
    || ts.isDoStatement(node)
    || ts.isTryStatement(node)
    || ts.isConditionalExpression(node)
}

function isElseIf(node: ts.Node): boolean {
  return ts.isIfStatement(node)
    && ts.isIfStatement(node.parent)
    && node.parent.elseStatement === node
}

function assertControlDepth(source: ts.SourceFile): void {
  const visit = (node: ts.Node, parentDepth: number): void => {
    const depth = parentDepth + (isControl(node) && !isElseIf(node) ? 1 : 0)
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    assert.ok(
      depth <= MAX_CONTROL_DEPTH,
      `${source.fileName}:${position.line + 1} control depth ${depth} exceeds ${MAX_CONTROL_DEPTH}`,
    )
    ts.forEachChild(node, (child) => {
      visit(child, ts.isFunctionLike(child) ? 0 : depth)
    })
  }
  visit(source, 0)
}

test('quality: public defaults fail closed', () => {
  assert.equal(DEFAULT_CONFIG.allowAllUsers, false)
})

test('quality: malformed app ids fail before startup', () => {
  const previousAppId = process.env.DSH_LARK_APP_ID
  const previousAppSecret = process.env.DSH_LARK_APP_SECRET
  process.env.DSH_LARK_APP_ID = 'not-an-app-id'
  process.env.DSH_LARK_APP_SECRET = 'test-only-secret'
  try {
    assert.throws(() => apply({} as never, {}), /appId must match/)
  } finally {
    if (previousAppId === undefined) delete process.env.DSH_LARK_APP_ID
    else process.env.DSH_LARK_APP_ID = previousAppId
    if (previousAppSecret === undefined) delete process.env.DSH_LARK_APP_SECRET
    else process.env.DSH_LARK_APP_SECRET = previousAppSecret
  }
})

test('quality: tracked files contain no concrete Lark identities or private paths', () => {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  assert.deepEqual(paths.filter((path) => /^\.env(?:\.|$)/.test(path)), [])
  const forbidden = [
    /\bcli_[0-9a-f]{16}\b/i,
    /\bou_[0-9a-z_-]{12,}\b/i,
    /\/(?:Users|home)\/[^/\s]+/,
    /\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ]
  for (const path of paths) {
    const content = readFileSync(path, 'utf8')
    for (const pattern of forbidden) {
      assert.doesNotMatch(content, pattern, `${path} contains repository-private data`)
    }
  }
})

test('quality: lockfile artifacts use the public npm registry', () => {
  const lockfile = readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')
  const urls = [...lockfile.matchAll(/"resolved": "([^"]+)"/g)].map((match) => match[1])
  assert.ok(urls.length > 0)
  for (const url of urls) assert.equal(new URL(url ?? '').hostname, 'registry.npmjs.org')
})

test('quality: publishing targets the public npm registry', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    publishConfig?: { registry?: string }
  }
  assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/')
})

test('quality: rendered cards stay within the Lark byte limit', () => {
  const payload = renderTurnCard({
    status: 'completed',
    answer: '"\\长内容'.repeat(10_000),
    tools: Array.from({ length: 100 }, (_, index) => ({
      id: `tool-${index}`,
      name: `tool-${index}`,
      detail: '参数'.repeat(1_000),
      status: 'completed' as const,
    })),
    reasoning: 'reasoning'.repeat(10_000),
    todos: Array.from({ length: 100 }, (_, index) => ({
      content: `todo-${index}-${'detail'.repeat(1_000)}`,
      status: 'completed' as const,
    })),
    startedAt: 1_000,
    updatedAt: 2_000,
  })
  const encoded = JSON.stringify(payload)
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= CARD_LIMITS.maxBytes)
  assert.match(encoded, /…/)
})

test('quality: model output cannot inject Lark platform tags', () => {
  const payload = renderTurnCard({
    status: 'completed',
    answer: '**safe markdown** <at id=all>everyone</at>',
    reasoning: '<at id=all>reasoning</at>',
    tools: [],
    startedAt: 1,
    updatedAt: 2,
  })
  const encoded = JSON.stringify(payload)
  assert.match(encoded, /\*\*safe markdown\*\*/)
  assert.doesNotMatch(encoded, /<at id=all>/)
  assert.match(encoded, /&lt;at id=all&gt;/)
})

test('quality: supported locales cover cards and extended events', () => {
  assert.deepEqual(LARK_LOCALES, ['zh-CN', 'en-US'])
  const card = renderTurnCard({
    locale: 'en-US',
    status: 'failed',
    error: 'upstream unavailable',
    tools: [],
    startedAt: 1,
    updatedAt: 2,
  })
  assert.match(JSON.stringify(card), /Execution failed/)
  const activity = projectActivity({
    type: 'llm/retry',
    seq: 1,
    time: 1,
    data: { retryId: 'retry-1', retry: 1, failure: { message: 'retry me' } },
  }, 'en-US')
  assert.equal(activity?.name, 'Model retry 1')
})

test('quality: every DSH session event has an explicit policy', () => {
  assert.deepEqual(unclassifiedKnownEventTypes(), [])
  assert.deepEqual(nonCatalogPolicyTypes(), [])
})

test('quality: source control flow stays within three levels', () => {
  for (const path of sourceFiles(join(process.cwd(), 'src'))) {
    const source = ts.createSourceFile(
      path,
      readFileSync(path, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    assertControlDepth(source)
  }
})
