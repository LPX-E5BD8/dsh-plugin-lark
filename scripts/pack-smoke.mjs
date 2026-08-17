import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), 'dsh-plugin-lark-pack-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const env = {
  ...process.env,
  npm_config_cache: join(temporary, 'npm-cache'),
  npm_config_registry: 'https://registry.npmjs.org',
}

try {
  await run(npm, ['pack', '--pack-destination', temporary], { cwd: root, env })
  const archiveName = (await readdir(temporary)).find((name) => name.endsWith('.tgz'))
  assert.ok(archiveName !== undefined, 'npm pack did not produce an archive')
  const consumer = join(temporary, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n')
  await run(npm, [
    'install',
    '--ignore-scripts',
    '--no-package-lock',
    join(temporary, archiveName),
  ], { cwd: consumer, env })
  const installedPackage = join(consumer, 'node_modules', 'dsh-plugin-lark')
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
} finally {
  await rm(temporary, { recursive: true, force: true })
}
