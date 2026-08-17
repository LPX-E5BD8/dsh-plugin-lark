import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')

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
  assert.equal(
    jobSource.split(marker).length - 1,
    1,
    `job must contain exactly one ${name} step`,
  )
  const start = jobSource.indexOf(marker)
  assert.notEqual(start, -1, `job omits the ${name} step`)
  const remainder = jobSource.slice(start + marker.length)
  const nextStep = remainder.indexOf('\n      - ')
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep)
}

function permissions(source: string, indentation: string): Record<string, string> {
  const expression = new RegExp(`^${indentation}permissions:\\n((?:${indentation}  [^\\n]+\\n)+)`, 'mu')
  const block = expression.exec(source)?.[1]
  assert.ok(block !== undefined, 'permissions block is missing')
  return Object.fromEntries(block.trim().split('\n').map((line) => {
    const [key, value] = line.trim().split(/:\s+/u)
    assert.ok(key !== undefined && value !== undefined)
    return [key, value]
  }))
}

function namedSteps(jobSource: string): string[] {
  return [...jobSource.matchAll(/^      - name: ([^\n]+)$/gmu)]
    .map((match) => match[1] ?? '')
}

function assertNamedSteps(jobSource: string, expected: readonly string[]): void {
  const names = namedSteps(jobSource)
  assert.deepEqual(names, [...new Set(names)], 'workflow step names must be unique within a job')
  assert.deepEqual(names, expected)
}

function countMatches(source: string, expression: RegExp): number {
  return [...source.matchAll(expression)].length
}

test('release workflow keeps provenance permissions narrow and every action SHA-pinned', () => {
  const release = job('release')
  assert.deepEqual(permissions(workflow, ''), {
    contents: 'read',
    attestations: 'read',
  })
  assert.deepEqual(permissions(release, '    '), {
    contents: 'write',
    'id-token': 'write',
    attestations: 'write',
  })
  assert.match(release, /if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/u)
  assert.match(release, /needs: test/u)
  assert.match(release, /timeout-minutes: (?:1[0-9]|[2-9][0-9])/u)
  assert.doesNotMatch(release, /^    concurrency:/mu)
  assert.doesNotMatch(release, /group:\s*release-\$\{\{\s*github\.repository\s*\}\}/u)
  assert.doesNotMatch(release, /secrets\.|NPM_TOKEN|npm\s+publish|write-all|packages:\s*write/u)

  assertNamedSteps(job('linux_release'), [
    'Download and verify the Web-profile upgrade baseline',
    'Pack and install the release archive',
    'Verify packed Web-profile install and upgrade',
    'Verify Node.js 24 compatibility',
    'Upload the tested release archive',
  ])
  assertNamedSteps(release, [
    'Wait for the previous release',
    'Download the tested release archive',
    'Validate the tested release archive',
    'Check for existing package provenance',
    'Attest the tested release archive',
    'Verify the generated provenance bundle',
    'Verify package provenance',
    'Tag the tested commit',
    'Create or verify the GitHub Release',
  ])

  const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)/gu)].map((match) => match[1] ?? '')
  assert.ok(uses.length > 0)
  for (const action of uses) assert.match(action, /@[0-9a-f]{40}$/u, `${action} is not SHA-pinned`)
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7\.0\.1/u)
  assert.match(release, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8\.0\.1/u)
  assert.match(release, /actions\/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4\.2\.2/u)
  assert.equal(countMatches(release, /uses:\s+actions\/attest@[0-9a-f]{40}/gu), 1)
  assert.doesNotMatch(workflow, /attest-build-provenance/u)
})

test('release workflow carries the exact pack-smoke archive into the privileged job', () => {
  const linuxJob = job('linux_release')
  const release = job('release')
  const baseline = step(linuxJob, 'Download and verify the Web-profile upgrade baseline')
  const pack = step(linuxJob, 'Pack and install the release archive')
  const profile = step(linuxJob, 'Verify packed Web-profile install and upgrade')
  const node24 = step(linuxJob, 'Verify Node.js 24 compatibility')
  const upload = step(linuxJob, 'Upload the tested release archive')
  const download = step(release, 'Download the tested release archive')
  const validate = step(release, 'Validate the tested release archive')

  assert.match(pack, /DSH_PACK_ARTIFACT_DIR: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(pack, /run: npm run test:pack/u)
  assert.doesNotMatch(upload, /if:|continue-on-error/u)
  assert.match(upload, /name: release-package-\$\{\{ github\.sha \}\}/u)
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(upload, /if-no-files-found: error/u)
  assert.match(upload, /^          retention-days: 7$/mu)
  assert.match(upload, /overwrite: true/u)
  assert.match(download, /name: release-package-\$\{\{ github\.sha \}\}/u)
  assert.match(download, /path: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(download, /^          digest-mismatch: error$/mu)
  const testOrder = [
    'Download and verify the Web-profile upgrade baseline',
    'Pack and install the release archive',
    'Verify packed Web-profile install and upgrade',
    'Verify Node.js 24 compatibility',
    'Upload the tested release archive',
  ]
  for (let index = 1; index < testOrder.length; index += 1) {
    assert.ok(linuxJob.indexOf(testOrder[index - 1] ?? '') < linuxJob.indexOf(testOrder[index] ?? ''))
  }
  assert.match(baseline, /id: upgrade-baseline/u)
  assert.match(profile, /npm run test:profile/u)
  assert.match(node24, /DSH_PROFILE_CANDIDATE_DIR: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(
    node24,
    /export DSH_PROFILE_CANDIDATE_PACKAGE="\$DSH_PROFILE_CANDIDATE_DIR\/dsh-plugin-lark-\$\{version\}\.tgz"/u,
  )
  assert.match(node24, /test -f "\$DSH_PROFILE_CANDIDATE_PACKAGE"/u)
  assert.match(node24, /npm run test:profile/u)
  assert.doesNotMatch(node24, /DSH_PACK_ARTIFACT_DIR/u)
  assert.ok(release.indexOf('Download the tested release archive') < release.indexOf('Validate the tested release archive'))

  assert.match(validate, /id: package/u)
  assert.match(validate, /test "\$\(git rev-parse HEAD\)" = "\$GITHUB_SHA"/u)
  assert.match(validate, /expected_name="dsh-plugin-lark-\$\{version\}\.tgz"/u)
  assert.match(validate, /expected exactly one tested package archive/u)
  assert.match(validate, /tar -xOf "\$package_path" package\/package\.json/u)
  assert.match(validate, /test "\$packed_name" = 'dsh-plugin-lark'/u)
  assert.match(validate, /test "\$packed_version" = "\$version"/u)
  const tagBranchStart = validate.indexOf('if git rev-parse --verify --quiet "refs/tags/${tag}"')
  const tagBranchElse = validate.indexOf('\n          else\n', tagBranchStart)
  const tagBranchEnd = validate.indexOf('\n          fi\n', tagBranchElse)
  assert.ok(tagBranchStart >= 0 && tagBranchElse > tagBranchStart && tagBranchEnd > tagBranchElse)
  const existingTagBranch = validate.slice(tagBranchStart, tagBranchElse)
  const missingTagBranch = validate.slice(tagBranchElse, tagBranchEnd)
  assert.match(existingTagBranch, /target="\$\(git rev-list -n 1 "\$tag"\)"/u)
  assert.match(existingTagBranch, /if \[ "\$target" != "\$GITHUB_SHA" \]; then/u)
  assert.match(existingTagBranch, /not \$\{GITHUB_SHA\}/u)
  assert.doesNotMatch(existingTagBranch, /check-release-version/u)
  assert.match(missingTagBranch, /RELEASE_BASE_SHA="\$PREVIOUS_MAIN_SHA" node scripts\/check-release-version\.mjs/u)
  assert.equal(countMatches(validate, /check-release-version\.mjs/gu), 1)
  assert.equal(countMatches(release, /check-release-version\.mjs/gu), 1)
  for (const output of ['path', 'name', 'digest', 'tag', 'version']) {
    assert.match(validate, new RegExp(`echo "${output}=\\$\\{[^}]+\\}" >> "\\$GITHUB_OUTPUT"`, 'u'))
  }

  const packScript = readFileSync('scripts/pack-smoke.mjs', 'utf8')
  assert.match(packScript, /npm pack is not reproducible within one clean build/u)
  assert.match(packScript, /DSH_PACK_ARTIFACT_DIR must be absolute/u)
  assert.match(packScript, /DSH_PACK_ARTIFACT_DIR must be empty/u)
  assert.match(packScript, /COPYFILE_EXCL/u)
})

test('release workflow attests and verifies the exact archive before tagging', () => {
  const release = job('release')
  const preflight = step(release, 'Check for existing package provenance')
  const attest = step(release, 'Attest the tested release archive')
  const bundle = step(release, 'Verify the generated provenance bundle')
  const verify = step(release, 'Verify package provenance')
  const tag = step(release, 'Tag the tested commit')

  const orderedSteps = [
    'Download the tested release archive',
    'Validate the tested release archive',
    'Check for existing package provenance',
    'Attest the tested release archive',
    'Verify the generated provenance bundle',
    'Verify package provenance',
    'Tag the tested commit',
    'Create or verify the GitHub Release',
  ]
  for (let index = 1; index < orderedSteps.length; index += 1) {
    const previous = orderedSteps[index - 1] ?? ''
    const current = orderedSteps[index] ?? ''
    assert.ok(release.indexOf(previous) < release.indexOf(current), `${previous} must precede ${current}`)
  }
  assert.match(preflight, /id: provenance/u)
  assert.match(attest, /id: attestation/u)
  assert.match(attest, /if: steps\.provenance\.outputs\.exists != 'true'/u)
  assert.match(attest, /subject-path: \$\{\{ steps\.package\.outputs\.path \}\}/u)
  assert.match(attest, /subject-name: \$\{\{ steps\.package\.outputs\.name \}\}/u)
  assert.doesNotMatch(attest, /continue-on-error/u)
  assert.doesNotMatch(attest, /^\s+(?:sbom-path|predicate(?:-type|-path)?|push-to-registry):/mu)

  assert.match(bundle, /if: steps\.provenance\.outputs\.exists != 'true'/u)
  assert.match(bundle, /ATTESTATION_BUNDLE: \$\{\{ steps\.attestation\.outputs\.bundle-path \}\}/u)
  assert.match(bundle, /ATTESTATION_ID: \$\{\{ steps\.attestation\.outputs\.attestation-id \}\}/u)
  assert.match(bundle, /test -s "\$ATTESTATION_BUNDLE"/u)
  assert.match(bundle, /case "\$ATTESTATION_ID" in ''\|\*\[!0-9\]\*\) exit 1 ;; esac/u)
  assert.match(bundle, /gh attestation verify "\$PACKAGE_PATH"/u)
  assert.match(bundle, /--bundle "\$ATTESTATION_BUNDLE"/u)
  assert.match(bundle, /\.name == \$name and \.digest\.sha256 == \$digest/u)

  for (const verification of [preflight, bundle, verify]) {
    assert.match(verification, /gh attestation verify "\$PACKAGE_PATH"/u)
    assert.match(verification, /--repo "\$GITHUB_REPOSITORY"/u)
    assert.match(verification, /--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/ci\.yml"/u)
    assert.match(verification, /--source-ref "\$GITHUB_REF"/u)
    assert.match(verification, /--source-digest "\$GITHUB_SHA"/u)
    assert.match(verification, /--deny-self-hosted-runners/u)
    assert.match(verification, /\.name == \$name and \.digest\.sha256 == \$digest/u)
  }
  assert.match(verify, /verified=0/u)
  assert.match(verify, /for attempt in \$\(seq 1 12\); do/u)
  assert.match(verify, /verified=1/u)
  assert.match(verify, /sleep 5/u)
  assert.match(verify, /if \[ "\$verified" -ne 1 \]; then/u)
  assert.match(verify, /package provenance was not verifiable/u)
  assert.doesNotMatch(verify, /while\s+true/u)
  assert.match(tag, /test "\$\(git rev-list -n 1 "\$TAG"\)" = "\$GITHUB_SHA"/u)
  assert.match(tag, /git tag -a "\$TAG"[^\n]+"\$GITHUB_SHA"/u)
})

test('release workflow reconciles one exact asset and fails closed on digest conflicts', () => {
  const release = job('release')
  const publish = step(release, 'Create or verify the GitHub Release')
  assert.match(publish, /gh release create "\$TAG"/u)
  assert.match(publish, /--verify-tag/u)
  assert.match(publish, /--target "\$GITHUB_SHA"/u)
  assert.match(publish, /--draft/u)
  assert.match(publish, /gh release upload "\$TAG" "\$PACKAGE_PATH"/u)
  assert.match(publish, /release_id="\$\(gh release view "\$TAG" --json databaseId --jq \.databaseId/u)
  assert.match(publish, /case "\$release_id" in ''\|\*\[!0-9\]\*\)/u)
  assert.match(publish, /release_endpoint="repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{release_id\}"/u)
  assert.match(publish, /release_json=''/u)
  assert.equal(countMatches(publish, /for attempt in \$\(seq 1 12\); do/gu), 2)
  assert.match(publish, /if release_json="\$\(gh api "\$release_endpoint" 2>\/dev\/null\)"; then[\s\S]*break[\s\S]*sleep 5/u)
  assert.match(publish, /if \[ -z "\$release_json" \]; then[\s\S]*could not load \$\{TAG\} release \$\{release_id\}[\s\S]*exit 1/u)
  assert.match(publish, /upload_attempts=0/u)
  assert.match(publish, /for attempt in \$\(seq 1 36\); do/u)
  assert.match(publish, /if \[ "\$upload_attempts" -gt 3 \]; then/u)
  assert.match(publish, /release metadata conflicts with \$\{GITHUB_SHA\}"[\s\S]*exit 1/u)
  assert.match(publish, /release metadata changed during reconciliation"[\s\S]*exit 1/u)
  assert.match(publish, /if \[ "\$asset_count" -gt 1 \]; then[\s\S]*multiple \$\{PACKAGE_NAME\} assets[\s\S]*exit 1/u)
  assert.match(publish, /if \[ -n "\$asset_digest" \] && \[ "\$asset_digest" != "\$PACKAGE_DIGEST" \]; then[\s\S]*digest conflict:[\s\S]*exit 1/u)
  assert.match(publish, /if \[ "\$asset_state" = 'uploaded' \] && \[ "\$asset_digest" = "\$PACKAGE_DIGEST" \]; then/u)

  const deleteCommands = [...publish.matchAll(/gh api --method DELETE[^\n]+/gu)]
  assert.equal(deleteCommands.length, 1)
  assert.equal(deleteCommands[0]?.[0], 'gh api --method DELETE "$asset_endpoint"; then')
  assert.match(
    publish,
    /if \{ \[ "\$asset_state" = 'open' \] \|\| \[ "\$asset_state" = 'starter' \]; \} && \[ -z "\$asset_digest" \]; then[\s\S]*case "\$asset_id" in ''\|\*\[!0-9\]\*\) exit 1 ;; esac[\s\S]*if \[ "\$incomplete_observations" -ge 3 \]; then[\s\S]*asset_endpoint="repos\/\$\{GITHUB_REPOSITORY\}\/releases\/assets\/\$\{asset_id\}"[\s\S]*incomplete_json="\$\(gh api "\$asset_endpoint" 2>\/dev\/null\)"[\s\S]*\.name == \$name and \(\.state == "open" or \.state == "starter"\) and \(\.digest \/\/ ""\) == ""[\s\S]*gh api --method DELETE "\$asset_endpoint"[\s\S]*elif \[ "\$asset_state" != 'uploaded' \] \|\| \[ -n "\$asset_digest" \]; then[\s\S]*unexpected state[\s\S]*exit 1/u,
  )
  assert.doesNotMatch(publish, /--clobber|release delete/u)

  const assetVerified = publish.indexOf('if [ "$asset_verified" -ne 1 ]; then')
  const publishDraft = publish.indexOf('gh release edit "$TAG" --draft=false --prerelease=false')
  const finalVerification = publish.indexOf('release_verified=0')
  assert.ok(assetVerified >= 0 && publishDraft > assetVerified && finalVerification > publishDraft)
  assert.match(publish, /if \[ "\$\(printf '%s' "\$release_json" \| jq -r '\.draft'\)" = 'true' \]; then[\s\S]*release_published=0[\s\S]*for attempt in 1 2 3; do[\s\S]*gh release edit "\$TAG" --draft=false --prerelease=false[\s\S]*if \[ "\$release_published" -ne 1 \]; then[\s\S]*could not publish \$\{TAG\} draft[\s\S]*exit 1/u)
  assert.match(publish, /\.draft == false and \.prerelease == false/u)
  assert.match(publish, /select\(\.name == \$name and \.state == "uploaded" and \.digest == \$digest\)/u)
  assert.match(publish, /\[\.assets\[\] \| select\(\.name == \$name\)\] \| length\) == 1/u)
  assert.match(publish, /if \[ "\$release_verified" -ne 1 \]; then/u)
  assert.match(publish, /was not published as an exact final release/u)
  assert.doesNotMatch(publish, /while\s+true/u)
  assert.doesNotMatch(workflow, /npm\s+publish/u)

  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
  for (const path of ['README.md', 'README.zh-CN.md']) {
    const readme = readFileSync(path, 'utf8')
    assert.ok(readme.includes(`version='${version}'`), `${path} does not verify the current release`)
    assert.match(readme, /gh attestation verify "\$archive"/u)
    assert.match(readme, /--signer-workflow "\$repository\/\.github\/workflows\/ci\.yml"/u)
    assert.match(readme, /--source-ref refs\/heads\/main/u)
    assert.match(readme, /--source-digest "\$tag_commit"/u)
    assert.match(readme, /--deny-self-hosted-runners/u)
  }
  assert.match(readFileSync('ROADMAP.md', 'utf8'), /## 0\.8\.3 — Release provenance/u)
})
