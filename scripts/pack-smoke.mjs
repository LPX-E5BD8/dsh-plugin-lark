import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-plugin-lark-pack-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const sourceLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
const typescriptVersion = sourceLock.packages?.['node_modules/typescript']?.version
assert.equal(typeof typescriptVersion, 'string')
assert.equal(manifest.name, 'dsh-plugin-lark')
assert.match(manifest.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
const expectedArchiveName = `${manifest.name}-${manifest.version}.tgz`
const inputArchive = process.env.DSH_PACK_INPUT_PACKAGE?.trim()
const env = {
  ...process.env,
  npm_config_cache: join(temporary, 'npm-cache'),
  npm_config_registry: 'https://registry.npmjs.org',
}
const pinnedConsumerPackages = Object.entries(sourceLock.packages ?? {})
  .filter(([path]) => (
    /^node_modules\/@deepseek-ai\/(?:cordis|schemastery|dsh-[^/]+)$/u.test(path)
  ))
  .map(([path, entry]) => {
    assert.equal(typeof entry.version, 'string', `${path} has no locked version`)
    return `${path.slice('node_modules/'.length)}@${entry.version}`
  })
  .sort()
assert.ok(pinnedConsumerPackages.includes('@deepseek-ai/dsh-agent@0.1.0-rc.6'))
assert.ok(pinnedConsumerPackages.includes('@deepseek-ai/dsh-workspace@0.1.0-rc.6'))

async function verifyConsumer(archivePath) {
  const consumer = join(temporary, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  await run(npm, [
    'install',
    '--ignore-scripts',
    '--no-package-lock',
    ...pinnedConsumerPackages,
    `typescript@${typescriptVersion}`,
    archivePath,
  ], { cwd: consumer, env })
  const installedPackage = join(consumer, 'node_modules', manifest.name)
  for (const document of ['UPGRADING.md', 'UPGRADING.zh-CN.md']) {
    const metadata = await stat(join(installedPackage, document))
    assert.ok(metadata.isFile(), `packed package did not include ${document}`)
  }
  const installed = JSON.parse((await run(
    npm,
    ['ls', '--all', '--json'],
    { cwd: consumer, env },
  )).stdout)
  const versions = new Map()
  function collectDependencies(dependencies) {
    for (const [name, dependency] of Object.entries(dependencies ?? {})) {
      const values = versions.get(name) ?? new Set()
      if (typeof dependency.version === 'string') values.add(dependency.version)
      versions.set(name, values)
      collectDependencies(dependency.dependencies)
    }
  }
  collectDependencies(installed.dependencies)
  assert.deepEqual([...(versions.get(manifest.name) ?? [])], [manifest.version])
  for (const name of [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-agent',
    '@deepseek-ai/dsh-llm',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-storage-domain',
    '@deepseek-ai/schemastery',
  ]) {
    assert.ok(versions.has(name), `packed consumer did not resolve ${name}`)
  }
  assert.deepEqual([...(versions.get('@deepseek-ai/cordis') ?? [])], ['4.0.1'])
  assert.deepEqual([...(versions.get('@deepseek-ai/schemastery') ?? [])], ['3.18.1'])
  for (const [name, resolved] of versions) {
    if (!name.startsWith('@deepseek-ai/dsh-')) continue
    if (resolved.size === 0) {
      assert.equal(name, '@deepseek-ai/dsh-user-approval', `${name} was not installed`)
      continue
    }
    assert.deepEqual([...resolved], ['0.1.0-rc.6'], `${name} resolved a mixed Harness cohort`)
  }
  await writeFile(join(consumer, 'smoke.mjs'), [
    "import assert from 'node:assert/strict'",
    "import { LARK_LOCALES, name } from 'dsh-plugin-lark'",
    "assert.equal(name, 'lark')",
    "assert.deepEqual(LARK_LOCALES, ['zh-CN', 'en-US'])",
    '',
  ].join('\n'))
  await run(process.execPath, [join(consumer, 'smoke.mjs')], { cwd: consumer, env })
  await writeFile(join(consumer, 'smoke.ts'), [
    "import type {",
    "  LarkArtifactDeliveryOptions,",
    "  LarkArtifactUploadInput,",
    "  LarkArtifactUploadOptions,",
    "  LarkClientLike,",
    "  LarkUploadedArtifact,",
    "} from 'dsh-plugin-lark'",
    '',
    'const client: LarkClientLike = {',
    '  async start() {},',
    '  async stop() {},',
    '  async sendText() {},',
    '  onMessage() {},',
    '  uploadArtifact(',
    '    input: LarkArtifactUploadInput,',
    '    _options: LarkArtifactUploadOptions,',
    '  ): Promise<LarkUploadedArtifact> {',
    '    return Promise.resolve(Object.freeze({ kind: input.kind }))',
    '  },',
    '  sendArtifact(',
    '    _chatId: string,',
    '    _artifact: LarkUploadedArtifact,',
    '    _options: LarkArtifactDeliveryOptions,',
    '  ): Promise<string> {',
    "    return Promise.resolve('om_pack_smoke')",
    '  },',
    '}',
    'void client',
    '',
  ].join('\n'))
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    files: ['smoke.ts'],
  }))
  await run(join(consumer, 'node_modules', '.bin', 'tsc'), [], { cwd: consumer, env })
}

const digest = async (path) => createHash('sha256').update(await readFile(path)).digest('hex')

try {
  let archivePath
  if (inputArchive) {
    assert.equal(
      process.env.DSH_PACK_ARTIFACT_DIR,
      undefined,
      'an input package cannot also produce the canonical artifact',
    )
    assert.ok(isAbsolute(inputArchive), 'DSH_PACK_INPUT_PACKAGE must be absolute')
    archivePath = await realpath(inputArchive)
    assert.ok((await stat(archivePath)).isFile(), 'DSH_PACK_INPUT_PACKAGE must be a regular file')
    assert.equal(basename(archivePath), expectedArchiveName)
  } else {
    await run(npm, ['pack', '--pack-destination', temporary], { cwd: root, env })
    const archiveNames = (await readdir(temporary)).filter((name) => name.endsWith('.tgz'))
    assert.deepEqual(archiveNames, [expectedArchiveName], 'npm pack produced an unexpected archive set')
    archivePath = join(temporary, expectedArchiveName)
  }

  await verifyConsumer(archivePath)

  if (!inputArchive) {
    const repeat = join(temporary, 'repeat')
    await mkdir(repeat)
    await run(npm, [
      'pack',
      '--ignore-scripts',
      '--pack-destination',
      repeat,
    ], { cwd: root, env })
    assert.deepEqual(
      (await readdir(repeat)).filter((name) => name.endsWith('.tgz')),
      [expectedArchiveName],
      'repeat npm pack produced an unexpected archive set',
    )
    assert.equal(
      await digest(archivePath),
      await digest(join(repeat, expectedArchiveName)),
      'npm pack is not reproducible within one clean build',
    )

    const artifactDirectory = process.env.DSH_PACK_ARTIFACT_DIR?.trim()
    if (artifactDirectory) {
      assert.ok(isAbsolute(artifactDirectory), 'DSH_PACK_ARTIFACT_DIR must be absolute')
      await mkdir(artifactDirectory, { recursive: true })
      assert.deepEqual(await readdir(artifactDirectory), [], 'DSH_PACK_ARTIFACT_DIR must be empty')
      const artifactPath = join(artifactDirectory, expectedArchiveName)
      await copyFile(archivePath, artifactPath, fsConstants.COPYFILE_EXCL)
      assert.ok((await stat(artifactPath)).isFile())
      assert.equal(await digest(artifactPath), await digest(archivePath))
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
