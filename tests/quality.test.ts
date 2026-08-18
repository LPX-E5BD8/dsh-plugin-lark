import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import {
  CARD_LIMITS,
  renderApprovalCard,
  renderApprovalDecisionCard,
  renderTurnCard,
  renderTurnCardWithMeta,
} from '../src/cards.ts'
import { DEFAULT_CONFIG } from '../src/config.ts'
import { nonCatalogPolicyTypes, projectActivity, unclassifiedKnownEventTypes } from '../src/events.ts'
import {
  DEFAULT_CONVERSATION_IMAGE_BYTES,
  DEFAULT_CONVERSATION_IMAGES,
  DEFAULT_INBOUND_IMAGE_BYTES,
  DEFAULT_INBOUND_IMAGE_PIXELS,
  MAX_CONVERSATION_IMAGE_BYTES,
  MAX_CONVERSATION_IMAGES,
  MAX_INBOUND_IMAGE_BYTES,
  MAX_INBOUND_IMAGE_PIXELS,
} from '../src/inbound-image.ts'
import {
  DEFAULT_INBOUND_TEXT_RESOURCE_BYTES,
  MAX_INBOUND_TEXT_RESOURCE_BYTES,
} from '../src/inbound-resource.ts'
import {
  DEFAULT_OUTBOUND_IMAGE_BYTES,
  DEFAULT_OUTBOUND_IMAGE_PIXELS,
  DEFAULT_OUTBOUND_TEXT_BYTES,
  MAX_OUTBOUND_IMAGE_BYTES,
  MAX_OUTBOUND_IMAGE_PIXELS,
  MAX_OUTBOUND_TEXT_BYTES,
} from '../src/outbound-artifact.ts'
import { apply, Config, inject } from '../src/index.ts'
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
  assert.equal(DEFAULT_CONFIG.outboundArtifacts, false)
  assert.deepEqual(inject, ['agents', 'storageDomain', 'sessions', 'tools'])
})

test('quality: outbound artifacts stay opt-in and independently bounded through the bundle seam', () => {
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  assert.equal(DEFAULT_CONFIG.outboundArtifacts, false)
  assert.equal(DEFAULT_CONFIG.maxOutboundTextFileBytes, DEFAULT_OUTBOUND_TEXT_BYTES)
  assert.equal(DEFAULT_CONFIG.maxOutboundImageBytes, DEFAULT_OUTBOUND_IMAGE_BYTES)
  assert.equal(DEFAULT_CONFIG.maxOutboundImagePixels, DEFAULT_OUTBOUND_IMAGE_PIXELS)
  assert.equal(MAX_OUTBOUND_TEXT_BYTES, 256 * 1024)
  assert.equal(MAX_OUTBOUND_IMAGE_BYTES, 5 * 1024 * 1024)
  assert.equal(MAX_OUTBOUND_IMAGE_PIXELS, 20_000_000)
  assert.match(source, /outboundArtifacts: Schema\.boolean\(\)\.default\(DEFAULT_CONFIG\.outboundArtifacts\)/u)
  for (const [field, max] of [
    ['maxOutboundTextFileBytes', 'MAX_OUTBOUND_TEXT_BYTES'],
    ['maxOutboundImageBytes', 'MAX_OUTBOUND_IMAGE_BYTES'],
    ['maxOutboundImagePixels', 'MAX_OUTBOUND_IMAGE_PIXELS'],
  ]) {
    assert.match(source, new RegExp(`${field}: Schema\\.natural\\(\\)\\s+\\.min\\(1\\)\\s+\\.max\\(${max}\\)`, 'u'))
  }
  for (const line of [
    'outboundArtifacts: false',
    'maxOutboundTextFileBytes: 131072',
    'maxOutboundImageBytes: 5242880',
    'maxOutboundImagePixels: 20000000',
  ]) {
    assert.equal((patch.match(new RegExp(`^\\s+${line}$`, 'gmu')) ?? []).length, 1)
  }
  assert.throws(() => Config({ maxOutboundTextFileBytes: 0 }), TypeError)
  assert.throws(() => Config({ maxOutboundImageBytes: MAX_OUTBOUND_IMAGE_BYTES + 1 }), TypeError)
  assert.throws(() => Config({ maxOutboundImagePixels: MAX_OUTBOUND_IMAGE_PIXELS + 1 }), TypeError)
  assert.equal(Config({ outboundArtifacts: true }).outboundArtifacts, true)
  const bridge = readFileSync(join(process.cwd(), 'src/bridge.ts'), 'utf8')
  assert.match(
    bridge,
    /properties: \{ sent: \{ type: 'boolean', const: true \} \},\s+required: \['sent'\],/u,
  )
})

test('quality: image surface snapshots reuse already-derived messages', () => {
  const source = readFileSync(join(process.cwd(), 'src/bridge.ts'), 'utf8')
  const snapshot = source.match(/private imageSurfaceSnapshot\([\s\S]*?\n  \}\n/u)?.[0]
  assert.ok(snapshot !== undefined)
  assert.match(snapshot, /messagesHaveModelVisibleImage\(messages\)/u)
  assert.doesNotMatch(snapshot, /sessionHasModelVisibleImage\(session\)/u)
})

test('quality: project management configuration stays fail-closed through the bundle seam', () => {
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  assert.match(source, /projectManageFrom\?: string\[\]/u)
  assert.match(source, /projectManageFrom: Schema\.array\(Schema\.string\(\)\)\.default\(\[\]\)/u)
  assert.match(source, /projectManageFrom: config\.projectManageFrom \?\? \[\]/u)
  assert.equal((patch.match(/^\s+projectManageFrom: \[\]$/gmu) ?? []).length, 1)
})

test('quality: inbound text files stay opt-in and bounded through the bundle seam', () => {
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  assert.equal(DEFAULT_CONFIG.inboundTextFiles, false)
  assert.equal(DEFAULT_CONFIG.maxInboundTextFileBytes, DEFAULT_INBOUND_TEXT_RESOURCE_BYTES)
  assert.equal(DEFAULT_INBOUND_TEXT_RESOURCE_BYTES, 128 * 1024)
  assert.equal(MAX_INBOUND_TEXT_RESOURCE_BYTES, 256 * 1024)
  assert.match(source, /inboundTextFiles: Schema\.boolean\(\)\.default\(DEFAULT_CONFIG\.inboundTextFiles\)/u)
  assert.match(source, /maxInboundTextFileBytes: Schema\.natural\(\)\s+\.min\(1\)/u)
  assert.match(source, /\.max\(MAX_INBOUND_TEXT_RESOURCE_BYTES\)/u)
  assert.equal((patch.match(/^\s+inboundTextFiles: false$/gmu) ?? []).length, 1)
  assert.equal((patch.match(/^\s+maxInboundTextFileBytes: 131072$/gmu) ?? []).length, 1)
  assert.throws(() => Config({ maxInboundTextFileBytes: 0 }), TypeError)
  assert.equal(Config({ maxInboundTextFileBytes: 1 }).maxInboundTextFileBytes, 1)
})

test('quality: inbound static images stay opt-in and independently bounded through the bundle seam', () => {
  const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')
  const patch = readFileSync(join(process.cwd(), 'cordis.patch.yml'), 'utf8')
  assert.equal(DEFAULT_CONFIG.inboundImages, false)
  assert.equal(DEFAULT_CONFIG.maxInboundImageBytes, DEFAULT_INBOUND_IMAGE_BYTES)
  assert.equal(DEFAULT_CONFIG.maxInboundImagePixels, DEFAULT_INBOUND_IMAGE_PIXELS)
  assert.equal(DEFAULT_CONFIG.maxConversationImages, DEFAULT_CONVERSATION_IMAGES)
  assert.equal(DEFAULT_CONFIG.maxConversationImageBytes, DEFAULT_CONVERSATION_IMAGE_BYTES)
  assert.match(source, /inboundImages: Schema\.boolean\(\)\.default\(DEFAULT_CONFIG\.inboundImages\)/u)
  for (const [field, max] of [
    ['maxInboundImageBytes', 'MAX_INBOUND_IMAGE_BYTES'],
    ['maxInboundImagePixels', 'MAX_INBOUND_IMAGE_PIXELS'],
    ['maxConversationImages', 'MAX_CONVERSATION_IMAGES'],
    ['maxConversationImageBytes', 'MAX_CONVERSATION_IMAGE_BYTES'],
  ]) {
    assert.match(source, new RegExp(`${field}: Schema\\.natural\\(\\)\\s+\\.min\\(1\\)\\s+\\.max\\(${max}\\)`, 'u'))
  }
  for (const line of [
    'inboundImages: false',
    'maxInboundImageBytes: 5242880',
    'maxInboundImagePixels: 20000000',
    'maxConversationImages: 4',
    'maxConversationImageBytes: 20971520',
  ]) {
    assert.equal((patch.match(new RegExp(`^\\s+${line}$`, 'gmu')) ?? []).length, 1)
  }
  assert.throws(() => Config({ maxInboundImageBytes: 0 }), TypeError)
  assert.throws(() => Config({ maxInboundImageBytes: MAX_INBOUND_IMAGE_BYTES + 1 }), TypeError)
  assert.throws(() => Config({ maxInboundImagePixels: MAX_INBOUND_IMAGE_PIXELS + 1 }), TypeError)
  assert.throws(() => Config({ maxConversationImages: MAX_CONVERSATION_IMAGES + 1 }), TypeError)
  assert.throws(() => Config({ maxConversationImageBytes: MAX_CONVERSATION_IMAGE_BYTES + 1 }), TypeError)
  assert.equal(Config({ inboundImages: true }).inboundImages, true)
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

test('quality: compatibility contract matches the manifest, lockfile, docs, and CI', () => {
  const harnessVersion = '0.1.0-rc.6'
  const cordisVersion = '4.0.1'
  const schemasteryVersion = '3.18.1'
  const nodeRange = '>=22 <23 || >=24 <25'
  const larkSdkVersion = '1.73.0'
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string
    engines?: { node?: string }
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: boolean }>
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  const lockfile = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, {
      version?: string
      engines?: { node?: string }
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
      devDependencies?: Record<string, string>
      dependencies?: Record<string, string>
    }>
  }
  const root = lockfile.packages?.['']
  const expectedPeers = {
    '@deepseek-ai/cordis': cordisVersion,
    '@deepseek-ai/dsh-agent': harnessVersion,
    '@deepseek-ai/dsh-attachment': harnessVersion,
    '@deepseek-ai/dsh-llm': harnessVersion,
    '@deepseek-ai/dsh-session': harnessVersion,
    '@deepseek-ai/dsh-storage-domain': harnessVersion,
    '@deepseek-ai/dsh-tools': harnessVersion,
    '@deepseek-ai/dsh-user-approval': harnessVersion,
    '@deepseek-ai/schemastery': schemasteryVersion,
  }
  const expectedHarnessDevDependencies = {
    '@deepseek-ai/dsh-attachment': harnessVersion,
    '@deepseek-ai/dsh-attachment-local': harnessVersion,
    '@deepseek-ai/dsh-agent-loop': harnessVersion,
    '@deepseek-ai/dsh-code-runtime': harnessVersion,
    '@deepseek-ai/dsh-home-paths': harnessVersion,
    '@deepseek-ai/dsh-invariants': harnessVersion,
    '@deepseek-ai/dsh-session-checkpoint-policy': harnessVersion,
    '@deepseek-ai/dsh-session-persistence': harnessVersion,
    '@deepseek-ai/dsh-session-persistence-jsonl': harnessVersion,
    '@deepseek-ai/dsh-session-projection': harnessVersion,
    '@deepseek-ai/dsh-session-query': harnessVersion,
    '@deepseek-ai/dsh-session-query-sqlite': harnessVersion,
    '@deepseek-ai/dsh-session-title': harnessVersion,
    '@deepseek-ai/dsh-storage': harnessVersion,
    '@deepseek-ai/dsh-storage-domain': harnessVersion,
    '@deepseek-ai/dsh-storage-json': harnessVersion,
    '@deepseek-ai/dsh-system-prompt': harnessVersion,
    '@deepseek-ai/dsh-tool-ask-user': harnessVersion,
    '@deepseek-ai/dsh-tools': harnessVersion,
    '@deepseek-ai/dsh-user-approval': harnessVersion,
    '@deepseek-ai/dsh-user-questions': harnessVersion,
    '@deepseek-ai/dsh-workspace': harnessVersion,
  }
  assert.ok(root !== undefined)
  assert.equal(manifest.engines?.node, nodeRange)
  assert.equal(root.engines?.node, nodeRange)
  assert.equal(manifest.dependencies?.['@larksuiteoapi/node-sdk'], larkSdkVersion)
  assert.equal(root.dependencies?.['@larksuiteoapi/node-sdk'], larkSdkVersion)
  assert.equal(
    lockfile.packages?.['node_modules/@larksuiteoapi/node-sdk']?.version,
    larkSdkVersion,
  )
  assert.deepEqual(manifest.peerDependencies, expectedPeers)
  assert.deepEqual(
    Object.fromEntries(Object.entries(manifest.devDependencies ?? {})
      .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))),
    expectedHarnessDevDependencies,
  )
  assert.deepEqual(manifest.peerDependenciesMeta, {
    '@deepseek-ai/dsh-attachment': { optional: true },
    '@deepseek-ai/dsh-user-approval': { optional: true },
  })
  assert.deepEqual(root.peerDependencies, manifest.peerDependencies)
  assert.deepEqual(root.peerDependenciesMeta, manifest.peerDependenciesMeta)
  assert.deepEqual(root.devDependencies, manifest.devDependencies)

  const directHarnessDependencies = [
    ...Object.entries(manifest.peerDependencies ?? {}),
    ...Object.entries(manifest.devDependencies ?? {}),
  ].filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
  assert.ok(directHarnessDependencies.length > 0)
  for (const [name, version] of directHarnessDependencies) {
    assert.equal(version, harnessVersion, `${name} is outside the supported Harness cohort`)
  }

  const lockedPackages = Object.entries(lockfile.packages ?? {})
  const lockedHarnessPackages = lockedPackages
    .filter(([path]) => /(?:^|\/)node_modules\/@deepseek-ai\/dsh-[^/]+$/u.test(path))
  assert.ok(lockedHarnessPackages.length > 0)
  for (const [path, entry] of lockedHarnessPackages) {
    assert.equal(entry.version, harnessVersion, `${path} is outside the supported Harness cohort`)
  }
  for (const [name, version] of [
    ['@deepseek-ai/cordis', cordisVersion],
    ['@deepseek-ai/schemastery', schemasteryVersion],
  ]) {
    const resolved = lockedPackages.filter(([path]) => (
      path === `node_modules/${name}` || path.endsWith(`/node_modules/${name}`)
    ))
    assert.ok(resolved.length > 0, `${name} is absent from the lockfile`)
    for (const [path, entry] of resolved) {
      assert.equal(entry.version, version, `${path} is outside the supported host baseline`)
    }
  }

  const [major, minor] = manifest.version.split('.')
  const releaseLine = `${major}.${minor}.x`
  const currentReleaseFloor = `${major}.${minor}.0`
  for (const path of ['README.md', 'README.zh-CN.md']) {
    const content = readFileSync(join(process.cwd(), path), 'utf8')
    const matrixRow = content.split('\n')
      .find((line) => line.startsWith(`| \`${currentReleaseFloor}\`–\`${releaseLine}\` |`))
    assert.ok(matrixRow !== undefined, `${path} omits the current compatibility row`)
    for (const marker of [releaseLine, harnessVersion, cordisVersion, schemasteryVersion, '22.x', '24.x']) {
      assert.match(matrixRow, new RegExp(`\\x60${marker.replaceAll('.', '\\.')}\\x60`), `${path} omits ${marker}`)
    }
    const macosNode22Row = content.split('\n').find((line) => line.startsWith('| `0.8.6` |'))
    assert.ok(macosNode22Row !== undefined, `${path} omits the original macOS Node.js 22 row`)
    assert.match(macosNode22Row, /`22\.x`[\s\S]*`24\.x`/u)
    const node24Row = content.split('\n').find((line) => line.startsWith('| `0.8.5` |'))
    assert.ok(node24Row !== undefined, `${path} omits the original Node.js 24 row`)
    assert.match(node24Row, /`22\.x`[\s\S]*`24\.x`/u)
    const historicalRow = content.split('\n')
      .find((line) => line.startsWith('| `0.8.0`–`0.8.4` |'))
    assert.ok(historicalRow !== undefined, `${path} omits the historical Node.js 22 row`)
    assert.match(historicalRow, /`22\.x`/u)
    assert.doesNotMatch(historicalRow, /`24\.x`/u)
  }
  const workflow = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8')
  const nodeVersions = [...workflow.matchAll(/^\s*node-version:\s*(.+?)(?:\s+#.*)?$/gmu)]
    .map((match) => match[1])
  const runners = [...workflow.matchAll(/runs-on:\s*([^\s#]+)/gu)].map((match) => match[1])
  assert.ok(nodeVersions.length > 0)
  assert.ok(runners.length > 0)
  assert.deepEqual([...new Set(nodeVersions)], ['22', '24', '${{ matrix.node }}'])
  assert.deepEqual([...new Set(runners)], ['ubuntu-latest', 'macos-26'])
})

test('quality: upgrade guides track durable schemas and ship with the package', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    version: string
    files?: string[]
  }
  assert.ok(manifest.files?.includes('UPGRADING.md'))
  assert.ok(manifest.files?.includes('UPGRADING.zh-CN.md'))

  const inboundSource = readFileSync(join(process.cwd(), 'src/inbound-dedup.ts'), 'utf8')
  const bindingSource = readFileSync(join(process.cwd(), 'src/conversation-binding.ts'), 'utf8')
  assert.match(inboundSource, /name:\s*'lark_inbound',[\s\S]*?version:\s*0,/u)
  assert.match(bindingSource, /LEGACY_CONVERSATION_BINDING_SCHEMA_VERSION\s*=\s*1/u)
  assert.match(bindingSource, /CONVERSATION_BINDING_SCHEMA_VERSION\s*=\s*2/u)
  assert.match(bindingSource, /name:\s*'lark_conversations',[\s\S]*?version:\s*0,/u)

  const guidePaths = ['UPGRADING.md', 'UPGRADING.zh-CN.md']
  const guides = guidePaths.map((path) => readFileSync(join(process.cwd(), path), 'utf8'))
  const requiredMarkers = [
    '$DSH_HOME/sessions',
    '$DSH_HOME/storages',
    '$DSH_HOME/attachments',
    '$DSH_HOME/profiles/web',
    'lark_inbound',
    'lark_conversations',
    'workspace.json',
    'domain version 0',
    'record schema v1',
    'v2 record',
    'modelSelection',
    '`0.1.3`',
    '`0.3.0`',
    '`0.7.0`',
    '`0.8.0`',
    `target_tag='v${manifest.version}'`,
    'SNAPSHOT_SHA256',
    'SNAPSHOT_COMPLETE',
    'storage-domain',
    '[ws] ws client ready',
    'SIGKILL',
  ]
  for (const [index, guide] of guides.entries()) {
    for (const marker of requiredMarkers) {
      assert.ok(guide.includes(marker), `${guidePaths[index]} omits ${marker}`)
    }
    assert.doesNotMatch(guide, /\brm\s+-rf\b/u)
    assert.doesNotMatch(guide, /^\s*mv\s+--/gmu)
  }
  const bashBlocks = guides.map((guide) => (
    [...guide.matchAll(/^```bash\n([\s\S]*?)\n```$/gmu)].map((match) => match[1] ?? '')
  ))
  assert.equal(bashBlocks[0]?.length, 4)
  assert.deepEqual(bashBlocks[0], bashBlocks[1])
  for (const block of bashBlocks[0] ?? []) {
    assert.match(block, /^\(\nset -Eeuo pipefail\n/u)
    assert.match(block, /\n\)$/u)
    execFileSync('bash', ['-n'], { input: block, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  const restoreBlock = bashBlocks[0]?.at(-1) ?? ''
  for (const marker of [
    'mv -nT',
    'dir_id()',
    "stat -c '%d:%i'",
    "trap 'on_exit \"$?\"' EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 131' QUIT",
    "trap 'exit 143' TERM",
    'rename_committed=1',
    'tree_digest "$restore_stage"',
  ]) {
    assert.ok(restoreBlock.includes(marker), `restore template omits ${marker}`)
  }
  assert.ok((restoreBlock.match(/rename_empty_target /gu) ?? []).length >= 8)
  const profileBlock = bashBlocks[0]?.[2] ?? ''
  assert.match(profileBlock, /DSH_HOME="\$dsh_state_root" dsh --profile web --dump-config/u)
  assert.match(profileBlock, /DSH_HOME="\$dsh_state_root" dsh plugin --profile web add/u)
  assert.equal((profileBlock.match(/dsh --profile web --dump-config/gu) ?? []).length, 2)
  const structure = guides.map((guide) => ({
    headings: guide.split('\n').filter((line) => line.startsWith('## ')).length,
    tables: guide.split('\n').filter((line) => /^\| ---/u.test(line)).length,
    fences: guide.split('\n').filter((line) => line === '```').length,
  }))
  assert.deepEqual(structure[0], structure[1])

  const packSmoke = readFileSync(join(process.cwd(), 'scripts/pack-smoke.mjs'), 'utf8')
  assert.match(packSmoke, /\['UPGRADING\.md', 'UPGRADING\.zh-CN\.md'\]/u)
  assert.match(packSmoke, /packed package did not include/u)

  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  const readmeZh = readFileSync(join(process.cwd(), 'README.zh-CN.md'), 'utf8')
  const smoke = readFileSync(join(process.cwd(), 'SMOKE_TESTS.md'), 'utf8')
  const roadmap = readFileSync(join(process.cwd(), 'ROADMAP.md'), 'utf8')
  assert.match(readme, /\[UPGRADING\.md\]\(\.\/UPGRADING\.md\)/u)
  assert.match(readmeZh, /\[UPGRADING\.zh-CN\.md\]\(\.\/UPGRADING\.zh-CN\.md\)/u)
  assert.match(smoke, /\[UPGRADING\.md\]\(\.\/UPGRADING\.md\)/u)
  assert.match(roadmap, /## 0\.8\.2 — Upgrade and rollback/u)
})

test('quality: rendered cards stay within the conservative plugin byte budget', () => {
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

test('quality: every Card 2.0 payload keeps platform element ids and column sets valid', () => {
  const payloads = [
    renderApprovalCard({
      requestId: 'request-1',
      toolName: 'bash',
      reason: 'Run one command.',
    }),
    ...(['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const)
      .map((outcome) => renderApprovalDecisionCard(outcome, 'bash')),
    renderTurnCard({
      status: 'running',
      tools: [{ id: 'tool-1', name: 'bash', status: 'running' }],
      reasoning: 'Checking the repository.',
      todos: [{ content: 'Run checks', status: 'in_progress' }],
      stopRequestId: 'stop-1',
      startedAt: 1_000,
      updatedAt: 2_000,
    }),
    renderTurnCard({
      status: 'completed',
      tools: [{ id: 'tool-1', name: 'bash', status: 'completed' }],
      answer: 'Done.',
      startedAt: 1_000,
      updatedAt: 2_000,
    }),
  ]
  const allowedColumnSetKeys = new Set([
    'columns',
    'element_id',
    'flex_mode',
    'horizontal_spacing',
    'tag',
  ])
  const visit = (value: unknown, elementIds: Set<string>): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, elementIds)
      return
    }
    const record = value as Record<string, unknown>
    if (record.tag === 'column_set') {
      for (const key of Object.keys(record)) assert.ok(allowedColumnSetKeys.has(key), key)
    }
    if ('element_id' in record) {
      const elementId = String(record.element_id)
      assert.match(elementId, /^[A-Za-z][A-Za-z0-9_]{0,19}$/u)
      assert.equal(elementIds.has(elementId), false, `duplicate Card element id ${elementId}`)
      elementIds.add(elementId)
    }
    for (const item of Object.values(record)) visit(item, elementIds)
  }
  for (const payload of payloads) visit(payload, new Set())
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
