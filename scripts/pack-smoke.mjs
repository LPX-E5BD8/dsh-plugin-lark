import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
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
