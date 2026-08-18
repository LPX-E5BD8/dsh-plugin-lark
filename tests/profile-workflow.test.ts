import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const BASELINE_TAG = 'v0.9.11'
const BASELINE_COMMIT = 'a97ff21eef3479462dbfd89eac9e3e0a564638dd'
const BASELINE_DIGEST = 'sha256:c8f6151c585a4a5f010356e85315d3df567d89c0bad7cbc81f025fe159723a8e'
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
const profileSmoke = readFileSync('scripts/profile-smoke.mjs', 'utf8')

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

test('Web-profile baseline is one pinned, attested release artifact', () => {
  const baseline = step(job('linux_release'), 'Download and verify the Web-profile upgrade baseline')

  assert.match(baseline, /id: upgrade-baseline/u)
  assert.match(baseline, /GH_TOKEN: \$\{\{ github\.token \}\}/u)
  assert.match(baseline, /BASELINE_DIR: \$\{\{ runner\.temp \}\}\/upgrade-baseline/u)
  assert.match(baseline, new RegExp(`BASELINE_TAG: ${BASELINE_TAG.replaceAll('.', '\\.')}`, 'u'))
  assert.match(baseline, new RegExp(`BASELINE_COMMIT: ${BASELINE_COMMIT}`, 'u'))
  assert.match(baseline, new RegExp(`BASELINE_DIGEST: ${BASELINE_DIGEST}`, 'u'))
  assert.match(baseline, /test ! -e "\$BASELINE_DIR"/u)
  assert.match(baseline, /mkdir "\$BASELINE_DIR"/u)
  assert.match(baseline, /chmod 700 "\$BASELINE_DIR"/u)
  assert.match(baseline, /archive_name="dsh-plugin-lark-\$\{version\}\.tgz"/u)
  assert.match(baseline, /gh release download "\$BASELINE_TAG"/u)
  assert.match(baseline, /--repo "\$GITHUB_REPOSITORY"/u)
  assert.match(baseline, /--pattern "\$archive_name"/u)
  assert.match(baseline, /--dir "\$BASELINE_DIR"/u)
  assert.match(baseline, /test "sha256:\$\{archive_sha\}" = "\$BASELINE_DIGEST"/u)

  assert.match(baseline, /git\/ref\/tags\/\$\{BASELINE_TAG\}/u)
  assert.match(baseline, /test "\$object_type" = 'tag'/u)
  assert.match(baseline, /while \[ "\$object_type" = 'tag' \]; do/u)
  assert.match(baseline, /test "\$peel_depth" -le 8/u)
  assert.match(baseline, /git\/tags\/\$\{object_sha\}/u)
  assert.match(baseline, /test "\$object_type" = 'commit'/u)
  assert.match(baseline, /test "\$object_sha" = "\$BASELINE_COMMIT"/u)

  assert.match(baseline, /--json assets,isDraft,isPrerelease,targetCommitish/u)
  assert.match(baseline, /\.targetCommitish == \$commit and \.isDraft == false and \.isPrerelease == false/u)
  assert.match(baseline, /select\(\.name == \$name and \.state == "uploaded" and \.digest == \$digest\)/u)
  assert.match(baseline, /test "\$packed_version" = "\$version"/u)

  const verifyStart = baseline.indexOf('gh attestation verify "$archive_path"')
  assert.ok(verifyStart >= 0)
  const verify = baseline.slice(verifyStart, baseline.indexOf('\n          jq -e', verifyStart))
  assert.match(verify, /--repo "\$GITHUB_REPOSITORY"/u)
  assert.match(verify, /--signer-workflow "\$GITHUB_REPOSITORY\/\.github\/workflows\/ci\.yml"/u)
  assert.match(verify, /--source-ref refs\/heads\/main/u)
  assert.match(verify, /--source-digest "\$BASELINE_COMMIT"/u)
  assert.match(verify, /--deny-self-hosted-runners/u)
  assert.match(verify, /--format json > "\$verification"/u)
  assert.doesNotMatch(verify, /--owner|--bundle|--source-digest "?\$GITHUB_SHA/u)
  assert.match(baseline, /\.name == \$name and \.digest\.sha256 == \$digest/u)
  assert.match(baseline, /echo "path=\$\{archive_path\}" >> "\$GITHUB_OUTPUT"/u)
  assert.match(
    readFileSync('README.md', 'utf8'),
    new RegExp(`strictly verified ${BASELINE_TAG.replaceAll('.', '\\.')} Release package`, 'u'),
  )
  assert.match(
    readFileSync('README.zh-CN.md', 'utf8'),
    new RegExp(`严格验证的 ${BASELINE_TAG.replaceAll('.', '\\.')} Release package`, 'u'),
  )
})

test('profile lifecycle receives the pinned baseline and the dynamic tested candidate', () => {
  const linuxJob = job('linux_release')
  const profile = step(linuxJob, 'Verify packed Web-profile install and upgrade')
  const node24 = step(linuxJob, 'Verify Node.js 24 compatibility')
  const ordered = [
    'Download and verify the Web-profile upgrade baseline',
    'Pack and install the release archive',
    'Verify packed Web-profile install and upgrade',
    'Verify Node.js 24 compatibility',
    'Upload the tested release archive',
  ]
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(linuxJob.indexOf(ordered[index - 1] ?? '') < linuxJob.indexOf(ordered[index] ?? ''))
  }

  assert.match(profile, /DSH_PROFILE_BASELINE_PACKAGE: \$\{\{ steps\.upgrade-baseline\.outputs\.path \}\}/u)
  assert.match(profile, /DSH_PROFILE_CANDIDATE_DIR: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(profile, /version="\$\(node -p "require\('\.\/package\.json'\)\.version"\)"/u)
  assert.match(profile, /export DSH_PROFILE_CANDIDATE_PACKAGE="\$DSH_PROFILE_CANDIDATE_DIR\/dsh-plugin-lark-\$\{version\}\.tgz"/u)
  assert.match(profile, /npm run test:profile/u)

  const node24Setup = linuxJob.lastIndexOf('node-version: 24')
  assert.ok(node24Setup > linuxJob.indexOf('Verify packed Web-profile install and upgrade'))
  assert.ok(node24Setup < linuxJob.indexOf('Verify Node.js 24 compatibility'))
  assert.match(node24, /DSH_PROFILE_BASELINE_PACKAGE: \$\{\{ steps\.upgrade-baseline\.outputs\.path \}\}/u)
  assert.match(node24, /DSH_PROFILE_CANDIDATE_DIR: \$\{\{ runner\.temp \}\}\/release-package/u)
  assert.match(node24, /DSH_PROFILE_EXPECT_NODE_MAJOR: '24'/u)
  assert.match(node24, /npm_config_cache: \$\{\{ runner\.temp \}\}\/node-24-npm-cache/u)
  assert.match(node24, /npm_config_engine_strict: 'true'/u)
  assert.match(node24, /process\.platform \+ ':' \+ process\.arch/u)
  assert.match(node24, /= 'linux:x64'/u)
  assert.match(node24, /process\.versions\.node\.split\('\.'\)\[0\]/u)
  assert.match(node24, /= '24'/u)
  const node24Commands = [
    'npm ci --ignore-scripts',
    'npm run check',
    'npm audit --omit=dev',
    'npm run test:pack',
    'export DSH_PROFILE_CANDIDATE_PACKAGE=',
    'test -f "$DSH_PROFILE_CANDIDATE_PACKAGE"',
    'npm run test:profile',
  ]
  for (let index = 1; index < node24Commands.length; index += 1) {
    assert.ok(node24.indexOf(node24Commands[index - 1] ?? '') < node24.indexOf(node24Commands[index] ?? ''))
  }
  assert.match(
    node24,
    /export DSH_PROFILE_CANDIDATE_PACKAGE="\$DSH_PROFILE_CANDIDATE_DIR\/dsh-plugin-lark-\$\{version\}\.tgz"/u,
  )
  assert.doesNotMatch(node24, /DSH_PROFILE_CLEAN_ONLY/u)

  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const lockfile = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
    packages?: Record<string, { devDependencies?: Record<string, string> }>
  }
  assert.equal(
    manifest.scripts?.['test:profile'],
    'npm_config_before=2026-08-14T00:00:00.000Z npm exec --yes --package=@deepseek-ai/dsh@0.1.0-rc.6 --package=pnpm@10.15.0 -- node scripts/profile-smoke.mjs',
  )
  assert.equal(manifest.devDependencies?.['@deepseek-ai/dsh'], undefined)
  assert.equal(manifest.devDependencies?.pnpm, undefined)
  assert.equal(lockfile.packages?.['']?.devDependencies?.['@deepseek-ai/dsh'], undefined)
  assert.equal(lockfile.packages?.['']?.devDependencies?.pnpm, undefined)
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string
  assert.match(
    readFileSync('ROADMAP.md', 'utf8'),
    new RegExp(`## ${version.replaceAll('.', '\\.')} — `, 'u'),
  )
})

test('profile smoke pins its tools and isolates every filesystem and credential input', () => {
  assert.match(profileSmoke, /const expectedDshVersion = '0\.1\.0-rc\.6'/u)
  assert.match(profileSmoke, /const expectedPnpmVersion = '10\.15\.0'/u)
  assert.match(profileSmoke, /const expectedNpmBefore = '2026-08-14T00:00:00\.000Z'/u)
  assert.match(profileSmoke, /process\.env\.npm_config_before,[\s\S]*expectedNpmBefore/u)
  assert.match(profileSmoke, /const dshExecutable = await executableOnPath\('dsh', inheritedPath\)/u)
  assert.match(profileSmoke, /const pnpmExecutable = await executableOnPath\('pnpm', inheritedPath\)/u)
  assert.match(profileSmoke, /dirname\(dshExecutable\),\n\s+dirname\(pnpmExecutable\)/u)
  assert.match(profileSmoke, /runChild\('dsh', \['--version'\][\s\S]*expectedDshVersion/u)
  assert.match(profileSmoke, /runChild\('pnpm', \['--version'\][\s\S]*expectedPnpmVersion/u)

  for (const name of [
    'DSH_LARK_APP_ID',
    'DSH_LARK_APP_SECRET',
    'FEISHU_APP_SECRET',
    'DEEPSEEK_API_KEY',
  ]) {
    assert.match(profileSmoke, new RegExp(`  '${name}',`, 'u'))
  }
  assert.match(profileSmoke, /for \(const name of credentialNames\) delete env\[name\]/u)
  assert.match(profileSmoke, /for \(const name of credentialNames\) assert\.equal\(env\[name\], undefined\)/u)
  assert.match(profileSmoke, /for \(const name of \$\{JSON\.stringify\(credentialNames\)\}\) assert\.equal\(process\.env\[name\], undefined\)/u)

  assert.match(profileSmoke, /const temporary = await mkdtemp\(join\(tmpdir\(\), 'dsh-lark-profile-smoke-'\)\)/u)
  assert.match(profileSmoke, /const cleanHome = join\(temporary, 'clean-home'\)/u)
  assert.match(profileSmoke, /const upgradeHome = join\(temporary, 'upgrade-home'\)/u)
  assert.match(profileSmoke, /assert\.ok\(isAbsolute\(home\), 'DSH_HOME must be absolute'\)/u)
  assert.match(profileSmoke, /DSH_HOME: home/u)
  assert.match(profileSmoke, /npm_config_ignore_scripts: 'true'/u)
  assert.match(profileSmoke, /npm_config_userconfig: join\(stateRoot, 'empty-user-npmrc'\)/u)
  assert.match(profileSmoke, /await writeFile\(join\(stateRoot, 'empty-user-npmrc'\), ''\)/u)
  assert.match(profileSmoke, /assert\.deepEqual\(await readdir\(invocationDirectory\), \[\]\)/u)
  assert.match(profileSmoke, /assert\.equal\(process\.platform, 'linux'/u)
  assert.match(profileSmoke, /const cleanOnlyValue = process\.env\.DSH_PROFILE_CLEAN_ONLY/u)
  assert.match(profileSmoke, /cleanOnlyValue === undefined \|\| cleanOnlyValue === '1'/u)
  assert.match(profileSmoke, /const cleanOnly = cleanOnlyValue === '1'/u)
  assert.match(profileSmoke, /process\.env\.DSH_PROFILE_EXPECT_NODE_MAJOR\?\.trim\(\)/u)
  assert.match(profileSmoke, /clean-only smoke must pin DSH_PROFILE_EXPECT_NODE_MAJOR/u)
  assert.match(profileSmoke, /clean-only smoke must not receive an unsupported upgrade baseline/u)
  assert.match(profileSmoke, /compatibility smoke must enforce package engines/u)
  assert.match(profileSmoke, /process\.versions\.node\.split\('\.'\)\[0\], expectedNodeMajor/u)

  for (const name of ['DSH_PROFILE_BASELINE_PACKAGE', 'DSH_PROFILE_CANDIDATE_PACKAGE']) {
    assert.match(profileSmoke, new RegExp(`archivePathFromEnvironment\\('${name}'\\)`, 'u'))
  }
  assert.match(profileSmoke, /assert\.ok\(configured, `\$\{name\} must name a package archive`\)/u)
  assert.match(profileSmoke, /assert\.ok\(isAbsolute\(configured\), `\$\{name\} must be an absolute path`\)/u)
  assert.match(profileSmoke, /const canonical = await realpath\(configured\)/u)
  assert.match(profileSmoke, /assert\.ok\(metadata\.isFile\(\), `\$\{name\} must name a regular file`\)/u)
  assert.match(profileSmoke, /canonical\.endsWith\('\.tgz'\)/u)
  assert.match(profileSmoke, /assert\.notEqual\(baselineArchive, candidateArchive/u)
  assert.match(profileSmoke, /assert\.notEqual\(baselineIntegrity, candidateIntegrity/u)
  assert.match(profileSmoke, /const baselineArchive = cleanOnly[\s\S]*\? undefined[\s\S]*archivePathFromEnvironment\('DSH_PROFILE_BASELINE_PACKAGE'\)/u)
  assert.match(profileSmoke, /if \(baselineArchive !== undefined && baselineIntegrity !== undefined\)/u)
  assert.match(profileSmoke, /await rm\(temporary, \{ recursive: true, force: true \}\)/u)
})

test('profile smoke proves clean install and in-place upgrade composition', () => {
  assert.match(
    profileSmoke,
    /await runChild\('dsh', \[[\s\S]*'plugin',[\s\S]*'--profile',[\s\S]*'web',[\s\S]*'add',[\s\S]*'--ignore-scripts',[\s\S]*archive,[\s\S]*\], context, label\)/u,
  )
  assert.match(profileSmoke, /manifest\.dependencies, \{\n\s+\[packageName\]: `file:\$\{archive\}`/u)
  assert.match(profileSmoke, /const profileBundles = \[[\s\S]*'@deepseek-ai\/dsh-base'[\s\S]*'@deepseek-ai\/dsh-web-app'[\s\S]*packageName/u)
  assert.match(profileSmoke, /assert\.deepEqual\(manifest\.dsh\?\.profile\?\.bundles, profileBundles\)/u)
  assert.match(profileSmoke, /lineOccurrences\(result\.stdout, `# == \$\{packageName\}`\)[\s\S]*1/u)
  assert.match(profileSmoke, /lineOccurrences\(result\.stdout, '- id: lark'\)[\s\S]*1/u)
  assert.match(profileSmoke, /lineOccurrences\(result\.stdout, `  name: \$\{packageName\}`\)[\s\S]*1/u)

  assert.match(profileSmoke, /async function archiveIntegrity\(path\)[\s\S]*sha512-/u)
  assert.match(profileSmoke, /occurrences\(lockRaw, `file:\$\{archive\}`\)[\s\S]*1/u)
  assert.match(profileSmoke, /occurrences\(lockRaw, integrity\)[\s\S]*1/u)
  assert.match(profileSmoke, /assert\.deepEqual\(await readFile\(path\), userPatchSentinel\)/u)

  assert.match(profileSmoke, /const deepseekScope = join\(home, 'profiles', 'node_modules', '@deepseek-ai'\)/u)
  assert.match(profileSmoke, /filter\(\(entry\) => entry\.name\.startsWith\('dsh-'\)\)/u)
  for (const required of [
    'dsh-attachment',
    'dsh-attachment-local',
    'dsh-session-projection',
    'dsh-session-query',
    'dsh-session-query-sqlite',
    'dsh-session-title',
    'dsh-user-approval',
    'dsh-workspace',
  ]) {
    assert.match(profileSmoke, new RegExp(`'${required}'`, 'u'))
  }
  assert.match(profileSmoke, /manifest\.version,[\s\S]*expectedDshVersion,[\s\S]*drifted outside the supported Harness cohort/u)
  assert.match(profileSmoke, /\['cordis', '4\.0\.1'\],[\s\S]*\['schemastery', '3\.18\.1'\]/u)
  assert.equal([...profileSmoke.matchAll(/await assertHarnessFallback\(/gu)].length, 3)

  assert.match(profileSmoke, /realpathSync\(manifestPath\)[\s\S]*realpathSync\(join\(profileDir, 'node_modules', '\$\{packageName\}', 'package\.json'\)\)/u)
  assert.match(profileSmoke, /const plugin = await import\(pathToFileURL\(entryPath\)\.href\)/u)
  assert.match(profileSmoke, /assert\.equal\(plugin\.name, 'lark'\)/u)
  assert.match(profileSmoke, /assert\.equal\(typeof plugin\.apply, 'function'\)/u)
  assert.match(profileSmoke, /assert\.deepEqual\(plugin\.LARK_LOCALES, \['zh-CN', 'en-US'\]\)/u)
  assert.match(profileSmoke, /assert\.throws\([\s\S]*plugin\.apply\(\{\}, \{\}\)[\s\S]*lark: missing appId\/appSecret/u)

  const cleanInstall = profileSmoke.indexOf("await addPackage(cleanContext, candidateArchive, 'clean candidate profile installation')")
  const baselineInstall = profileSmoke.indexOf("await addPackage(upgradeContext, baselineArchive, 'baseline profile installation')")
  const candidateUpgrade = profileSmoke.indexOf("await addPackage(upgradeContext, candidateArchive, 'candidate profile upgrade')")
  const upgradedState = profileSmoke.indexOf('const upgradedState = await assertProfileState')
  const residualCheck = profileSmoke.indexOf('for (const marker of [baselineArchive, baselineRelativeSpec, baselineIntegrity])')
  const upgradedImport = profileSmoke.indexOf("'upgraded candidate profile import'")
  assert.ok(cleanInstall >= 0)
  assert.ok(baselineInstall > cleanInstall)
  assert.ok(candidateUpgrade > baselineInstall)
  assert.ok(upgradedState > candidateUpgrade)
  assert.ok(residualCheck > upgradedState)
  assert.ok(upgradedImport > residualCheck)

  const cleanDump = profileSmoke.indexOf("await dumpProfile(cleanContext, 'clean candidate profile dump')")
  const cleanFallback = profileSmoke.indexOf('await assertHarnessFallback(cleanHome)', cleanDump)
  const baselineDump = profileSmoke.indexOf("await dumpProfile(upgradeContext, 'baseline profile dump')")
  const baselineFallback = profileSmoke.indexOf('await assertHarnessFallback(upgradeHome)', baselineDump)
  const baselineImport = profileSmoke.indexOf("'baseline profile import'", baselineFallback)
  const upgradedDump = profileSmoke.indexOf("await dumpProfile(upgradeContext, 'upgraded candidate profile dump')")
  const upgradedFallback = profileSmoke.indexOf('await assertHarnessFallback(upgradeHome)', upgradedDump)
  assert.ok(cleanDump >= 0 && cleanFallback > cleanDump)
  assert.ok(baselineDump >= 0 && baselineFallback > baselineDump)
  assert.ok(baselineImport > baselineFallback && baselineImport < candidateUpgrade)
  assert.ok(upgradedDump > candidateUpgrade && upgradedFallback > upgradedDump)
  assert.match(
    profileSmoke,
    /await assertProfileImport\([\s\S]*upgradeContext,[\s\S]*baselineState\.paths\.dir,[\s\S]*baselineState\.installed\.version,[\s\S]*'baseline profile import',[\s\S]*\)[\s\S]*await addPackage\(upgradeContext, candidateArchive/u,
  )

  assert.match(profileSmoke, /compareVersions\(baselineState\.installed\.version, rootManifest\.version\)[\s\S]*-1/u)
  assert.match(profileSmoke, /await assertPatchUnchanged\(upgradePaths\.patch\)[\s\S]*await addPackage\(upgradeContext, candidateArchive/u)
  assert.match(profileSmoke, /for \(const marker of \[baselineArchive, baselineRelativeSpec, baselineIntegrity\]\)/u)
  assert.match(profileSmoke, /upgradedState\.manifestRaw\.includes\(marker\)[\s\S]*false/u)
  assert.match(profileSmoke, /upgradedState\.lockRaw\.includes\(marker\)[\s\S]*false/u)
  assert.match(profileSmoke, /discoverLarkPackageVersions\(upgradeHome\)/u)
  assert.match(profileSmoke, /new Set\(discovered\.map\(\(\{ version \}\) => version\)\)[\s\S]*\[rootManifest\.version\]/u)
  assert.match(profileSmoke, /assertHomeContainsOnlyProfiles\(cleanHome\)/u)
  assert.match(profileSmoke, /assertHomeContainsOnlyProfiles\(upgradeHome\)/u)
})
