import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function parseVersion(value, source) {
  const match = SEMVER.exec(value)
  if (match === null) throw new Error(`${source} must contain a stable x.y.z version, got ${value}`)
  return match.slice(1).map(Number)
}

function compare(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index] - right[index]
    if (difference !== 0) return difference
  }
  return 0
}

const manifest = readJson('package.json')
const lockfile = readJson('package-lock.json')
const version = String(manifest.version ?? '')
if (lockfile.version !== version || lockfile.packages?.['']?.version !== version) {
  throw new Error('package.json and package-lock.json versions must match')
}
const candidate = parseVersion(version, 'package.json')
const baseSha = process.env.RELEASE_BASE_SHA?.trim()
if (baseSha !== undefined && baseSha !== '') {
  const baseManifest = JSON.parse(execFileSync(
    'git',
    ['show', `${baseSha}:package.json`],
    { encoding: 'utf8' },
  ))
  const baseVersion = String(baseManifest.version ?? '')
  if (compare(candidate, parseVersion(baseVersion, `package.json at ${baseSha}`)) <= 0) {
    throw new Error(`package version ${version} must be newer than PR base version ${baseVersion}`)
  }
}
const tags = execFileSync('git', ['tag', '--list', 'v*'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .filter(Boolean)
  .flatMap((tag) => {
    const match = SEMVER.exec(tag.slice(1))
    return match === null ? [] : [{ tag, parsed: match.slice(1).map(Number) }]
  })
  .sort((left, right) => compare(right.parsed, left.parsed))
const latest = tags[0]
if (latest !== undefined && compare(candidate, latest.parsed) <= 0) {
  throw new Error(`package version ${version} must be newer than latest release ${latest.tag}`)
}
console.log(latest === undefined
  ? `release version ${version} is valid`
  : `release version ${version} advances ${latest.tag}`)
