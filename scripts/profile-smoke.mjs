import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import {
  access,
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
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const expectedDshVersion = '0.1.0-rc.6'
const expectedPnpmVersion = '10.15.0'
const expectedNpmBefore = '2026-08-14T00:00:00.000Z'
const packageName = 'dsh-plugin-lark'
assert.equal(
  process.env.npm_config_before,
  expectedNpmBefore,
  'profile smoke must resolve the rc.6 tool graph from its pinned registry snapshot',
)
const cleanOnlyValue = process.env.DSH_PROFILE_CLEAN_ONLY
assert.ok(
  cleanOnlyValue === undefined || cleanOnlyValue === '1',
  'DSH_PROFILE_CLEAN_ONLY must be absent or exactly 1',
)
const cleanOnly = cleanOnlyValue === '1'
const expectedNodeMajor = process.env.DSH_PROFILE_EXPECT_NODE_MAJOR?.trim()
if (cleanOnly) {
  assert.ok(expectedNodeMajor, 'clean-only smoke must pin DSH_PROFILE_EXPECT_NODE_MAJOR')
  assert.equal(
    process.env.DSH_PROFILE_BASELINE_PACKAGE,
    undefined,
    'clean-only smoke must not receive an unsupported upgrade baseline',
  )
}
if (expectedNodeMajor !== undefined) {
  assert.equal(
    process.env.npm_config_engine_strict,
    'true',
    'compatibility smoke must enforce package engines',
  )
  assert.match(expectedNodeMajor, /^(0|[1-9]\d*)$/u)
  assert.equal(process.versions.node.split('.')[0], expectedNodeMajor)
}
const profileBundles = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  packageName,
]
const credentialNames = [
  'DSH_LARK_APP_ID',
  'DSH_LARK_APP_SECRET',
  'FEISHU_APP_SECRET',
  'DEEPSEEK_API_KEY',
]
const userPatchSentinel = Buffer.from([
  '# profile-smoke user patch sentinel; preserve these exact bytes',
  '[]',
  '',
].join('\n'))

function occurrences(value, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let offset = 0
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1
    offset += needle.length
  }
  return count
}

function lineOccurrences(value, expected) {
  return value.split(/\r?\n/u).filter((line) => line === expected).length
}

function parseStableVersion(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value)
  assert.ok(match, `${label} must be a stable semantic version, got ${JSON.stringify(value)}`)
  return match.slice(1).map((part) => BigInt(part))
}

function compareVersions(left, right) {
  const leftParts = parseStableVersion(left, 'left version')
  const rightParts = parseStableVersion(right, 'right version')
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1
    if (leftParts[index] > rightParts[index]) return 1
  }
  return 0
}

async function archivePathFromEnvironment(name) {
  const configured = process.env[name]?.trim()
  assert.ok(configured, `${name} must name a package archive`)
  assert.ok(isAbsolute(configured), `${name} must be an absolute path`)
  const canonical = await realpath(configured)
  const metadata = await stat(canonical)
  assert.ok(metadata.isFile(), `${name} must name a regular file`)
  assert.equal(canonical.endsWith('.tgz'), true, `${name} must name a .tgz archive`)
  return canonical
}

async function archiveIntegrity(path) {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`
}

async function executableOnPath(name, pathValue) {
  assert.ok(pathValue, 'PATH must be present')
  for (const directory of pathValue.split(delimiter)) {
    if (directory === '') continue
    const candidate = resolve(directory, name)
    try {
      await access(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Continue through the inherited npm-exec PATH.
    }
  }
  assert.fail(`${name} was not found on PATH`)
}

function childEnvironment(home, store, stateRoot) {
  assert.ok(isAbsolute(home), 'DSH_HOME must be absolute')
  assert.ok(isAbsolute(store), 'the pnpm store must be absolute')
  const env = {
    ...process.env,
    CI: '1',
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    NO_COLOR: '1',
    PNPM_HOME: join(stateRoot, 'pnpm-home'),
    XDG_CACHE_HOME: join(stateRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: join(stateRoot, 'xdg-config'),
    XDG_DATA_HOME: join(stateRoot, 'xdg-data'),
    npm_config_cache: join(stateRoot, 'npm-cache'),
    npm_config_ignore_scripts: 'true',
    npm_config_store_dir: store,
    npm_config_userconfig: join(stateRoot, 'empty-user-npmrc'),
  }
  for (const name of credentialNames) delete env[name]
  for (const name of credentialNames) assert.equal(env[name], undefined)
  return env
}

async function runChild(file, args, options, label) {
  try {
    return await run(file, args, {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    })
  } catch (error) {
    const stdout = typeof error?.stdout === 'string' ? error.stdout : ''
    const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
    const details = [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
      .filter(Boolean)
      .join('\n')
    throw new Error(`${label} failed${details === '' ? '' : `\n${details}`}`, { cause: error })
  }
}

function profilePaths(home) {
  const dir = join(home, 'profiles', 'web')
  return {
    dir,
    installedPackage: join(dir, 'node_modules', packageName),
    lock: join(dir, 'pnpm-lock.yaml'),
    manifest: join(dir, 'package.json'),
    patch: join(dir, 'cordis.patch.yml'),
  }
}

async function addPackage(context, archive, label) {
  await runChild('dsh', [
    'plugin',
    '--profile',
    'web',
    'add',
    '--ignore-scripts',
    archive,
  ], context, label)
}

async function dumpProfile(context, label) {
  const result = await runChild(
    'dsh',
    ['--profile', 'web', '--dump-config'],
    context,
    label,
  )
  assert.equal(
    lineOccurrences(result.stdout, `# == ${packageName}`),
    1,
    `${label} must contain exactly one plugin provenance header`,
  )
  assert.equal(
    lineOccurrences(result.stdout, '- id: lark'),
    1,
    `${label} must contain exactly one lark row`,
  )
  assert.equal(
    lineOccurrences(result.stdout, `  name: ${packageName}`),
    1,
    `${label} must contain exactly one lark package name`,
  )
  return result.stdout
}

async function assertProfileState(home, archive, integrity, expectedVersion) {
  const paths = profilePaths(home)
  const manifestRaw = await readFile(paths.manifest, 'utf8')
  const manifest = JSON.parse(manifestRaw)
  assert.equal(manifest.name, 'dsh-profile-web')
  assert.equal(manifest.private, true)
  assert.deepEqual(manifest.dependencies, {
    [packageName]: `file:${archive}`,
  })
  assert.deepEqual(manifest.dsh?.profile?.bundles, profileBundles)
  assert.equal(
    manifest.dsh.profile.bundles.filter((bundle) => bundle === packageName).length,
    1,
  )

  const installedRaw = await readFile(join(paths.installedPackage, 'package.json'), 'utf8')
  const installed = JSON.parse(installedRaw)
  assert.equal(installed.name, packageName)
  if (expectedVersion !== undefined) assert.equal(installed.version, expectedVersion)
  parseStableVersion(installed.version, `${packageName} version`)
  assert.equal(installed.dsh?.bundle?.patch, './cordis.patch.yml')

  const lockRaw = await readFile(paths.lock, 'utf8')
  assert.equal(
    occurrences(lockRaw, `file:${archive}`),
    1,
    'the profile lock must bind its importer to the absolute archive path',
  )
  assert.equal(
    occurrences(lockRaw, integrity),
    1,
    'the profile lock must bind exactly one package to the archive SHA-512',
  )

  return {
    installed,
    lockRaw,
    manifestRaw,
    paths,
  }
}

const importProbe = String.raw`
import assert from 'node:assert/strict'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const profileDir = process.env.DSH_PROFILE_SMOKE_PROFILE_DIR
const expectedVersion = process.env.DSH_PROFILE_SMOKE_EXPECTED_VERSION
assert.ok(profileDir)
assert.ok(expectedVersion)
for (const name of ${JSON.stringify(credentialNames)}) assert.equal(process.env[name], undefined)

const require = createRequire(pathToFileURL(join(profileDir, '.profile-smoke-resolver.cjs')))
const manifestPath = require.resolve('${packageName}/package.json')
assert.equal(
  realpathSync(manifestPath),
  realpathSync(join(profileDir, 'node_modules', '${packageName}', 'package.json')),
)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
assert.equal(manifest.name, '${packageName}')
assert.equal(manifest.version, expectedVersion)
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')

const entryPath = require.resolve('${packageName}')
const plugin = await import(pathToFileURL(entryPath).href)
assert.equal(plugin.name, 'lark')
assert.equal(typeof plugin.apply, 'function')
assert.deepEqual(plugin.LARK_LOCALES, ['zh-CN', 'en-US'])
assert.throws(
  () => plugin.apply({}, {}),
  (error) => error instanceof Error
    && error.message === 'lark: missing appId/appSecret (set DSH_LARK_APP_ID and DSH_LARK_APP_SECRET)',
)
`

async function assertProfileImport(context, profileDir, expectedVersion, label) {
  const env = {
    ...context.env,
    DSH_PROFILE_SMOKE_EXPECTED_VERSION: expectedVersion,
    DSH_PROFILE_SMOKE_PROFILE_DIR: profileDir,
  }
  await runChild(
    process.execPath,
    ['--input-type=module', '--eval', importProbe],
    { ...context, env },
    label,
  )
}

async function assertPatchUnchanged(path) {
  assert.deepEqual(await readFile(path), userPatchSentinel)
}

async function assertHomeContainsOnlyProfiles(home) {
  assert.deepEqual((await readdir(home)).sort(), ['profiles'])
}

async function assertHarnessFallback(home) {
  const deepseekScope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  const packageDirectories = (await readdir(deepseekScope, { withFileTypes: true }))
    .filter((entry) => entry.name.startsWith('dsh-'))
    .map((entry) => entry.name)
    .sort()
  assert.ok(packageDirectories.length > 0, 'the profile fallback must contain DSH packages')
  for (const required of [
    'dsh-session-projection',
    'dsh-session-query',
    'dsh-session-query-sqlite',
    'dsh-session-title',
    'dsh-workspace',
  ]) {
    assert.ok(
      packageDirectories.includes(required),
      `the stock profile fallback must contain ${required}`,
    )
  }
  for (const directory of packageDirectories) {
    const manifest = JSON.parse(await readFile(join(deepseekScope, directory, 'package.json'), 'utf8'))
    assert.equal(manifest.name, `@deepseek-ai/${directory}`)
    assert.equal(
      manifest.version,
      expectedDshVersion,
      `${manifest.name} drifted outside the supported Harness cohort`,
    )
  }

  for (const [name, version] of [
    ['cordis', '4.0.1'],
    ['schemastery', '3.18.1'],
  ]) {
    const manifest = JSON.parse(await readFile(join(deepseekScope, name, 'package.json'), 'utf8'))
    assert.equal(manifest.name, `@deepseek-ai/${name}`)
    assert.equal(manifest.version, version, `${manifest.name} drifted outside the supported baseline`)
  }
}

function portableRelative(from, to) {
  return relative(from, to).split(sep).join('/')
}

async function discoverLarkPackageVersions(rootPath) {
  const versions = []
  const pending = [rootPath]
  while (pending.length > 0) {
    const directory = pending.pop()
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (!entry.isDirectory()) continue
      const manifestPath = join(path, 'package.json')
      try {
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        if (manifest.name === packageName) {
          versions.push({ path: manifestPath, version: manifest.version })
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      pending.push(path)
    }
  }
  return versions
}

const temporary = await mkdtemp(join(tmpdir(), 'dsh-lark-profile-smoke-'))
try {
  assert.equal(process.platform, 'linux', 'the Web-profile smoke is supported on Linux')

  const candidateArchive = await archivePathFromEnvironment('DSH_PROFILE_CANDIDATE_PACKAGE')
  const candidateIntegrity = await archiveIntegrity(candidateArchive)
  const baselineArchive = cleanOnly
    ? undefined
    : await archivePathFromEnvironment('DSH_PROFILE_BASELINE_PACKAGE')
  const baselineIntegrity = baselineArchive === undefined
    ? undefined
    : await archiveIntegrity(baselineArchive)
  if (baselineArchive !== undefined && baselineIntegrity !== undefined) {
    assert.notEqual(baselineArchive, candidateArchive, 'baseline and candidate archives must differ')
    assert.notEqual(baselineIntegrity, candidateIntegrity, 'baseline and candidate bytes must differ')
  }

  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  assert.equal(rootManifest.name, packageName)
  parseStableVersion(rootManifest.version, 'candidate repository version')

  const invocationDirectory = join(temporary, 'invocation')
  const stateRoot = join(temporary, 'tool-state')
  const pnpmStore = join(temporary, 'pnpm-store')
  const cleanHome = join(temporary, 'clean-home')
  const upgradeHome = join(temporary, 'upgrade-home')
  await mkdir(invocationDirectory)
  await mkdir(stateRoot)
  await writeFile(join(stateRoot, 'empty-user-npmrc'), '')
  assert.deepEqual(await readdir(invocationDirectory), [])

  const inheritedPath = process.env.PATH
  const dshExecutable = await executableOnPath('dsh', inheritedPath)
  const pnpmExecutable = await executableOnPath('pnpm', inheritedPath)
  assert.equal(
    dirname(dshExecutable),
    dirname(pnpmExecutable),
    'dsh and pnpm must come from the same npm-exec PATH entry',
  )

  const versionContext = {
    cwd: invocationDirectory,
    env: childEnvironment(join(temporary, 'version-home'), pnpmStore, stateRoot),
  }
  assert.equal(
    (await runChild('dsh', ['--version'], versionContext, 'dsh version check')).stdout.trim(),
    expectedDshVersion,
  )
  assert.equal(
    (await runChild('pnpm', ['--version'], versionContext, 'pnpm version check')).stdout.trim(),
    expectedPnpmVersion,
  )

  const cleanContext = {
    cwd: invocationDirectory,
    env: childEnvironment(cleanHome, pnpmStore, stateRoot),
  }
  await addPackage(cleanContext, candidateArchive, 'clean candidate profile installation')
  const cleanPaths = profilePaths(cleanHome)
  await writeFile(cleanPaths.patch, userPatchSentinel)
  const cleanState = await assertProfileState(
    cleanHome,
    candidateArchive,
    candidateIntegrity,
    rootManifest.version,
  )
  await dumpProfile(cleanContext, 'clean candidate profile dump')
  await assertHarnessFallback(cleanHome)
  await assertPatchUnchanged(cleanPaths.patch)
  await assertProfileImport(
    cleanContext,
    cleanState.paths.dir,
    rootManifest.version,
    'clean candidate profile import',
  )
  await assertHomeContainsOnlyProfiles(cleanHome)

  if (baselineArchive !== undefined && baselineIntegrity !== undefined) {
    const upgradeContext = {
      cwd: invocationDirectory,
      env: childEnvironment(upgradeHome, pnpmStore, stateRoot),
    }
    await addPackage(upgradeContext, baselineArchive, 'baseline profile installation')
    const upgradePaths = profilePaths(upgradeHome)
    await writeFile(upgradePaths.patch, userPatchSentinel)
    const baselineState = await assertProfileState(
      upgradeHome,
      baselineArchive,
      baselineIntegrity,
    )
    assert.equal(
      compareVersions(baselineState.installed.version, rootManifest.version),
      -1,
      `candidate ${rootManifest.version} must advance baseline ${baselineState.installed.version}`,
    )
    await dumpProfile(upgradeContext, 'baseline profile dump')
    await assertHarnessFallback(upgradeHome)
    await assertPatchUnchanged(upgradePaths.patch)
    await assertProfileImport(
      upgradeContext,
      baselineState.paths.dir,
      baselineState.installed.version,
      'baseline profile import',
    )

    await addPackage(upgradeContext, candidateArchive, 'candidate profile upgrade')
    await assertPatchUnchanged(upgradePaths.patch)
    const upgradedState = await assertProfileState(
      upgradeHome,
      candidateArchive,
      candidateIntegrity,
      rootManifest.version,
    )
    const baselineRelativeSpec = `file:${portableRelative(upgradedState.paths.dir, baselineArchive)}`
    for (const marker of [baselineArchive, baselineRelativeSpec, baselineIntegrity]) {
      assert.equal(
        upgradedState.manifestRaw.includes(marker),
        false,
        `upgraded manifest retained baseline marker ${JSON.stringify(marker)}`,
      )
      assert.equal(
        upgradedState.lockRaw.includes(marker),
        false,
        `upgraded lock retained baseline marker ${JSON.stringify(marker)}`,
      )
    }
    await dumpProfile(upgradeContext, 'upgraded candidate profile dump')
    await assertHarnessFallback(upgradeHome)
    await assertPatchUnchanged(upgradePaths.patch)
    await assertProfileImport(
      upgradeContext,
      upgradedState.paths.dir,
      rootManifest.version,
      'upgraded candidate profile import',
    )

    const discovered = await discoverLarkPackageVersions(upgradeHome)
    assert.ok(discovered.length > 0, 'the upgraded profile must contain a discoverable lark package')
    assert.deepEqual(
      [...new Set(discovered.map(({ version }) => version))],
      [rootManifest.version],
      `the upgraded profile retained another lark package: ${JSON.stringify(discovered)}`,
    )
    await assertHomeContainsOnlyProfiles(upgradeHome)
  }
  assert.deepEqual(await readdir(invocationDirectory), [])
} finally {
  await rm(temporary, { recursive: true, force: true })
}
