import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const CHECK_SCRIPT = resolve('scripts/check-release-version.mjs')

function writeVersions(root: string, version: string): void {
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({
    version,
    packages: { '': { version } },
  }))
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function commit(root: string): string {
  git(root, 'add', 'package.json', 'package-lock.json')
  git(
    root,
    '-c', 'user.name=test',
    '-c', 'user.email=test',
    'commit', '-m', 'fixture',
  )
  return git(root, 'rev-parse', 'HEAD')
}

test('release version gate rejects a version already present on the PR base', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-release-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--quiet')
  writeVersions(root, '0.1.2')
  const base = commit(root)

  const checked = spawnSync(process.execPath, [CHECK_SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_BASE_SHA: base },
  })

  assert.notEqual(checked.status, 0)
  assert.match(checked.stderr, /must be newer than PR base version 0\.1\.2/)
})

test('release version gate accepts a version newer than both base and latest tag', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-lark-release-version-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  git(root, 'init', '--quiet')
  writeVersions(root, '0.1.1')
  const base = commit(root)
  git(root, 'tag', 'v0.1.1')
  writeVersions(root, '0.1.2')

  const checked = spawnSync(process.execPath, [CHECK_SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_BASE_SHA: base },
  })

  assert.equal(checked.status, 0, checked.stderr)
  assert.match(checked.stdout, /release version 0\.1\.2 advances v0\.1\.1/)
})

test('release workflow uses the push base rather than the last PR commit parent', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
  assert.match(workflow, /PREVIOUS_MAIN_SHA: \$\{\{ github\.event\.before \}\}/)
  assert.doesNotMatch(workflow, /GITHUB_SHA\}\^|GITHUB_SHA\^/)
})
