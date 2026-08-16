import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import { CARD_LIMITS, renderTurnCard, renderTurnCardWithMeta } from '../src/cards.ts'
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

test('quality: card rendering reports byte-cap answer truncation', () => {
  const answer = '&'.repeat(CARD_LIMITS.maxAnswerRunes)
  const rendered = renderTurnCardWithMeta({
    status: 'completed',
    answer,
    tools: [],
    startedAt: 1_000,
    updatedAt: 2_000,
  })
  const encoded = JSON.stringify(rendered.payload)
  assert.equal(rendered.answerTruncated, true)
  assert.ok(Buffer.byteLength(encoded, 'utf8') <= CARD_LIMITS.maxBytes)
  assert.ok((encoded.match(/&amp;/g)?.length ?? 0) < answer.length)
})

test('quality: display trimming does not report a short answer as truncated', () => {
  const rendered = renderTurnCardWithMeta({
    status: 'completed',
    answer: 'short reply\n',
    tools: [],
    startedAt: 1_000,
    updatedAt: 2_000,
  })
  assert.equal(rendered.answerTruncated, false)
})

test('quality: running cards nest tools and bound reasoning', () => {
  const latestReasoning = Array.from(
    { length: CARD_LIMITS.maxReasoningLines + 2 },
    (_, index) => `line-${index}-${'思'.repeat(80)}`,
  ).join('\n')
  const payload = renderTurnCard({
    status: 'running',
    tools: [{
      id: 'tool-1',
      name: 'bash',
      detail: '{"cmd":"pwd"}',
      status: 'running',
      startedAt: 1_000,
      updatedAt: 1_000,
    }],
    reasoning: `hidden-start\n${latestReasoning}\nlatest-tail`,
    loadingImageKey: 'img_test',
    startedAt: 1_000,
    updatedAt: 2_000,
  }) as {
    body?: { elements?: Array<{
      element_id?: string
      elements?: Array<{
        tag?: string
        expanded?: boolean
        header?: { icon?: { token?: string }; title?: { content?: string } }
        icon?: { token?: string; img_key?: string }
        text?: { content?: string; lines?: number }
      }>
    }> }
  }
  const execution = payload.body?.elements?.find((element) => element.element_id === 'execution_panel')
  const reasoning = execution?.elements?.find((element) => element.tag === 'div')
  const tool = execution?.elements?.find((element) => element.tag === 'collapsible_panel')
  assert.equal(reasoning?.icon?.img_key, 'img_test')
  assert.equal(reasoning?.text?.lines, CARD_LIMITS.maxReasoningLines)
  assert.match(reasoning?.text?.content ?? '', /^…/)
  assert.match(reasoning?.text?.content ?? '', /latest-tail$/)
  assert.doesNotMatch(reasoning?.text?.content ?? '', /hidden-start|line-0/)
  assert.ok((reasoning?.text?.content?.split('\n').length ?? 0) <= CARD_LIMITS.maxReasoningLines)
  assert.ok([...(reasoning?.text?.content?.slice(1) ?? '')].length <= CARD_LIMITS.maxReasoningRunes)
  assert.equal(tool?.expanded, true)
  assert.equal(tool?.header?.icon?.token, 'down-small-ccm_outlined')
  assert.match(tool?.header?.title?.content ?? '', /⏳.*⌨️.*bash.*1\.0s/)

  const completed = renderTurnCard({
    status: 'completed',
    tools: [],
    reasoning: 'done',
    startedAt: 1,
    updatedAt: 2,
  }) as { body?: { elements?: Array<{ elements?: Array<{ tag?: string; icon?: { token?: string } }> }> } }
  const completedReasoning = completed.body?.elements?.[0]?.elements?.find((element) => element.tag === 'div')
  assert.equal(completedReasoning?.icon?.token, 'done_outlined')
})

test('quality: execution cards favor reasoning over recent tools', () => {
  assert.equal(CARD_LIMITS.maxVisibleTools, 3)
  assert.equal(CARD_LIMITS.maxReasoningLines, 12)
  const payload = renderTurnCard({
    status: 'running',
    tools: Array.from({ length: 7 }, (_, index) => ({
      id: `tool-${index}`,
      name: `read-${index}`,
      status: 'completed' as const,
    })),
    reasoning: Array.from({ length: 20 }, (_, index) => `reasoning-${index}`).join('\n'),
    startedAt: 1,
    updatedAt: 2,
  }) as {
    body?: { elements?: Array<{
      element_id?: string
      elements?: Array<{
        tag?: string
        content?: string
        header?: { title?: { content?: string } }
        text?: { lines?: number }
      }>
    }> }
  }
  const execution = payload.body?.elements?.find((element) => element.element_id === 'execution_panel')
  const tools = execution?.elements?.filter((element) => element.tag === 'collapsible_panel') ?? []
  assert.equal(execution?.elements?.find((element) => element.tag === 'div')?.text?.lines, 12)
  assert.equal(tools.length, 3)
  assert.deepEqual(
    tools.map((tool) => tool.header?.title?.content?.match(/read-\d/)?.[0]),
    ['read-4', 'read-5', 'read-6'],
  )
  assert.match(execution?.elements?.find((element) => element.tag === 'markdown')?.content ?? '', />4 /)
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

test('quality: answer headings stay compact without rewriting code fences', () => {
  const payload = renderTurnCard({
    status: 'completed',
    answer: '# Large title\n\n## Small title\n\n```sh\n# shell comment\n```',
    tools: [],
    startedAt: 1,
    updatedAt: 2,
  })
  const encoded = JSON.stringify(payload)
  assert.match(encoded, /\*\*Large title\*\*/)
  assert.match(encoded, /\*\*Small title\*\*/)
  assert.match(encoded, /# shell comment/)
  assert.doesNotMatch(encoded, /# Large title|## Small title/)
  assert.match(encoded, /"mobile":"normal"/)
})

test('quality: shorter fence markers cannot close a longer code fence', () => {
  const payload = renderTurnCard({
    status: 'completed',
    answer: '````md\n```\n# still code\n```\n````\n# Real heading',
    tools: [],
    startedAt: 1,
    updatedAt: 2,
  })
  const encoded = JSON.stringify(payload)
  assert.match(encoded, /# still code/)
  assert.doesNotMatch(encoded, /\*\*still code\*\*/)
  assert.match(encoded, /\*\*Real heading\*\*/)
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
