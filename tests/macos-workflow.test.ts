import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const packSmoke = readFileSync('scripts/pack-smoke.mjs', 'utf8')

function job(name: string): string {
  const marker = `  ${name}:\n`
  const start = workflow.indexOf(marker)
  assert.notEqual(start, -1, `workflow omits the ${name} job`)
  const remainder = workflow.slice(start + marker.length)
  const nextJob = remainder.search(/^  [a-zA-Z0-9_-]+:\n/mu)
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob)
}

function step(jobSource: string, name: string): string {
  const marker = `      - name: ${name}\n`
  assert.equal(jobSource.split(marker).length - 1, 1, `job must contain one ${name} step`)
  const remainder = jobSource.slice(jobSource.indexOf(marker) + marker.length)
  const nextStep = remainder.indexOf('\n      - ')
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep)
}

test('macOS gate verifies one exact arm64 and Node.js 22 package runtime', () => {
  const macos = job('macos')
  const download = step(macos, 'Download the canonical release archive')
  const verify = step(macos, 'Verify macOS 26 arm64 package compatibility')

  assert.match(macos, /^    name: macOS package compatibility$/mu)
  assert.match(macos, /^    needs: linux_release$/mu)
  assert.match(macos, /^    runs-on: macos-26$/mu)
  assert.match(macos, /^    timeout-minutes: 15$/mu)
  assert.match(macos, /^    permissions:\n      contents: read$/mu)
  assert.doesNotMatch(macos, /continue-on-error|if:\s+false|attestations:|id-token:|contents: write/u)

  assert.match(download, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/u)
  assert.match(download, /name: release-package-\$\{\{ github\.sha \}\}/u)
  assert.match(download, /path: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(download, /^          digest-mismatch: error$/mu)

  assert.match(verify, /PACKAGE_DIR: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(verify, /npm_config_engine_strict: 'true'/u)
  assert.match(verify, /process\.platform \+ ':' \+ process\.arch/u)
  assert.match(verify, /= 'darwin:arm64'/u)
  assert.match(verify, /process\.versions\.node\.split\('\.'\)\[0\]/u)
  assert.match(verify, /= '22'/u)
  assert.match(verify, /sw_vers -productVersion/u)
  assert.match(verify, /in 26\.\*\)/u)
  const commands = [
    'npm ci --ignore-scripts',
    'npm run check',
    'npm audit --omit=dev',
    'npm run test:pack',
    'export DSH_PACK_INPUT_PACKAGE=',
    'test -f "$DSH_PACK_INPUT_PACKAGE"',
    'npm run test:pack',
  ]
  let offset = -1
  for (const command of commands) {
    const next = verify.indexOf(command, offset + 1)
    assert.ok(next > offset, `${command} is absent or out of order`)
    offset = next
  }
  assert.match(
    verify,
    /export DSH_PACK_INPUT_PACKAGE="\$PACKAGE_DIR\/dsh-plugin-lark-\$\{version\}\.tgz"/u,
  )
  assert.equal([...verify.matchAll(/npm run test:pack/gu)].length, 2)
  assert.doesNotMatch(macos, /test:profile|DSH_PROFILE_|upgrade-baseline|gh attestation|upload-artifact/u)
})

test('protected test context fails closed across Linux and macOS gates', () => {
  const gate = job('test')
  const requireEveryGate = step(gate, 'Require every release gate')

  assert.match(gate, /^    name: test$/mu)
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/mu)
  assert.match(gate, /^    needs: \[linux_release, macos\]$/mu)
  assert.match(gate, /^    runs-on: ubuntu-latest$/mu)
  assert.match(gate, /^    timeout-minutes: 5$/mu)
  assert.match(gate, /^    permissions: \{\}$/mu)
  assert.doesNotMatch(gate, /continue-on-error/u)
  assert.match(requireEveryGate, /LINUX_RESULT: \$\{\{ needs\.linux_release\.result \}\}/u)
  assert.match(requireEveryGate, /MACOS_RESULT: \$\{\{ needs\.macos\.result \}\}/u)
  assert.match(requireEveryGate, /test "\$LINUX_RESULT" = success/u)
  assert.match(requireEveryGate, /test "\$MACOS_RESULT" = success/u)
  assert.equal([...workflow.matchAll(/^    name: test$/gmu)].length, 1)
  assert.match(job('release'), /^    needs: test$/mu)
})

test('pack smoke consumes a staged archive without replacing the canonical artifact', () => {
  assert.match(packSmoke, /process\.env\.DSH_PACK_INPUT_PACKAGE\?\.trim\(\)/u)
  assert.match(packSmoke, /an input package cannot also produce the canonical artifact/u)
  assert.match(packSmoke, /assert\.ok\(isAbsolute\(inputArchive\)/u)
  assert.match(packSmoke, /archivePath = await realpath\(inputArchive\)/u)
  assert.match(packSmoke, /DSH_PACK_INPUT_PACKAGE must be a regular file/u)
  assert.match(packSmoke, /assert\.equal\(basename\(archivePath\), expectedArchiveName\)/u)
  assert.match(packSmoke, /await verifyConsumer\(archivePath\)/u)
  assert.match(packSmoke, /versions\.get\(manifest\.name\)[\s\S]*manifest\.version/u)
  assert.match(packSmoke, /if \(!inputArchive\) \{[\s\S]*DSH_PACK_ARTIFACT_DIR/u)
})
