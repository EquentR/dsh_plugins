/**
 * Version detection and feature-seam probing for @dsh-plugins/auth-gateway.
 *
 * The gateway supports two DSH releases with materially different surfaces:
 * `0.2.0-rc.2` (npm) and `0.2.1-rc.2` (desktop). Every behavioural difference
 * between them is concentrated here, so `lib/gateway.js` only ever asks this
 * module what the running core can do instead of branching on a version string.
 *
 * Two rules hold for everything below:
 *   * detection is best-effort and NEVER throws — an unprobeable environment
 *     reports `unknown`, it does not break plugin activation;
 *   * `assertRequiredSeams` is the single loud failure point, and it names the
 *     missing service and the release that provides it.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The version reported when nothing on this host can be probed. */
const UNKNOWN_VERSION = Object.freeze({
  raw: 'unknown',
  major: 0,
  minor: 0,
  patch: 0,
  flavor: 'unknown',
})

/**
 * The `Location` a core launch-token exchange answers with on the releases this
 * plugin supports.
 *
 * Advisory only: `0.2.1-rc.2` redirects to the directory-relative `./` while
 * `0.2.0-rc.2` still used `/`, and this value cannot be probed from `ctx`
 * without performing an exchange. `lib/core-session.js` therefore accepts both
 * spellings and never consults this field for its decision.
 */
const CORE_INDEX_REDIRECT = './'

/** Parse `major.minor.patch` out of a version string, tolerating prerelease/build suffixes. */
function parseVersionParts(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(raw ?? '').trim())
  if (match === null) return undefined
  const [, major, minor, patch] = match
  return { major: Number(major), minor: Number(minor), patch: Number(patch) }
}

/** The harness home this process would use, mirroring `$DSH_HOME` precedence. */
function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/**
 * Whether this process is the desktop build rather than a plain npm install.
 * The desktop host stamps distinctive variables into the core's environment.
 */
function detectFlavor() {
  const env = process.env
  if (typeof env.DSH_DESKTOP_DSH_DIR === 'string' && env.DSH_DESKTOP_DSH_DIR !== '') return 'desktop'
  if (typeof env.DSH_DESKTOP_NODE_EXECUTABLE === 'string' && env.DSH_DESKTOP_NODE_EXECUTABLE !== '') return 'desktop'
  if (typeof env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR === 'string' && env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR !== '') return 'desktop'
  if (typeof env.DSH_CLIENT_VERSION === 'string' && env.DSH_CLIENT_VERSION !== '') return 'desktop'
  if (String(process.execPath ?? '').includes('app.asar')) return 'desktop'
  return 'npm'
}

/** Read and parse one JSON file, returning undefined for any failure. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The version of the installed DSH runtime, probed from the most authoritative
 * source available. Each probe is independent and failure-tolerant.
 */
function probeRawVersion(ctx) {
  const fromCtx = [
    ctx?.get?.('packageManifest')?.version,
    ctx?.get?.('appBoot')?.version,
    ctx?.get?.('dsh')?.version,
  ]
  for (const candidate of fromCtx) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }

  const fromEnv = process.env.DSH_VERSION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()

  try {
    const manifestPath = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/package.json'))
    const version = readJson(manifestPath)?.version
    if (typeof version === 'string' && version.trim() !== '') return version.trim()
  } catch {
    // The runtime is not resolvable from this package (a linked install, or a
    // packaged desktop runtime whose layout differs) — fall through.
  }

  const hoisted = readJson(join(dshHome(), 'dsh-runtimes', 'dsh-primary-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  if (typeof hoisted?.version === 'string' && hoisted.version.trim() !== '') return hoisted.version.trim()

  return undefined
}

/**
 * Detect the running DSH version and which distribution it came from.
 *
 * Never throws: an unprobeable host yields `{ raw: 'unknown', major: 0,
 * minor: 0, patch: 0, flavor: 'unknown' }`.
 *
 * @param {object} [ctx] - Host plugin context; any shape is accepted.
 * @returns {{ raw: string, major: number, minor: number, patch: number, flavor: 'npm' | 'desktop' | 'unknown' }}
 */
export function detectVersion(ctx) {
  try {
    const raw = probeRawVersion(ctx)
    if (raw === undefined) return { ...UNKNOWN_VERSION }
    const parts = parseVersionParts(raw)
    const flavor = detectFlavor()
    // An unrecognisable string is still reported verbatim, but its numeric
    // fields stay zero so callers never compare against a bogus number.
    if (parts === undefined) return { ...UNKNOWN_VERSION, raw, flavor }
    return { raw, ...parts, flavor }
  } catch {
    return { ...UNKNOWN_VERSION }
  }
}

/**
 * Probe the seams this plugin adapts to.
 *
 * `hasSettingsRegister` is false on both supported releases: `0.2.0-rc.2` and
 * `0.2.1-rc.2` ship a `dsh-settings` without `register()`, which is exactly why
 * the gateway stores its own state instead of going through Host settings (see
 * CONTRACT.md §1). It is probed rather than hardcoded so a future release that
 * adds the method is reported honestly.
 *
 * @param {object} [ctx] - Host plugin context.
 * @returns {{ hasSettingsRegister: boolean, coreIndexRedirect: '/' | './', supportsTapIndex: boolean, supportsAuthenticatedUrl: boolean }}
 */
export function capabilities(ctx) {
  let settings
  let webServer
  let connection
  try {
    settings = ctx?.get?.('settings')
    webServer = ctx?.get?.('webServer')
    connection = ctx?.get?.('connection')
  } catch {
    settings = undefined
    webServer = undefined
    connection = undefined
  }
  return {
    hasSettingsRegister: typeof settings?.register === 'function',
    coreIndexRedirect: CORE_INDEX_REDIRECT,
    supportsTapIndex: typeof webServer?.tapIndex === 'function',
    supportsAuthenticatedUrl: typeof connection?.authenticatedUrl === 'function',
  }
}

/**
 * Assert the seams the gateway cannot run without.
 *
 * This is the only function here that throws, and it is called once during
 * plugin activation so a misconfigured host fails with an actionable message
 * instead of a `TypeError` deep inside a request handler.
 *
 * @param {object} [ctx] - Host plugin context.
 * @throws {Error} when `connection.authenticatedUrl` is unavailable.
 */
export function assertRequiredSeams(ctx) {
  let connection
  try {
    connection = ctx?.get?.('connection')
  } catch {
    connection = undefined
  }
  if (connection === undefined || connection === null) {
    const detected = detectVersion(ctx)
    throw new Error(
      'auth-gateway: the DSH client-connection service is unavailable, so the gateway cannot '
      + 'exchange the core launch token for an upstream session. Mount the Web profile '
      + '(`dsh --profile web`), which provides `ctx.connection`; this plugin requires DSH 0.2.0-rc.2 '
      + `or 0.2.1-rc.2. Detected version: ${detected.raw} (${detected.flavor}).`,
    )
  }
  if (typeof connection.authenticatedUrl !== 'function') {
    throw new Error(
      'auth-gateway: `ctx.connection` does not expose `authenticatedUrl(baseUrl)`, which this '
      + 'plugin needs to mint a core session. The installed client-connection is older than the '
      + 'supported DSH 0.2.0-rc.2 baseline; upgrade the runtime.',
    )
  }
}
