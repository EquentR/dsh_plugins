/**
 * Account, password hash and TOTP secret storage for @dsh-plugins/auth-gateway.
 *
 * Self-managed state (CONTRACT.md section 1): neither supported dsh version
 * exposes `settings.register()`, so the plugin owns a JSON record under
 * `$DSH_HOME/plugins/dsh-auth-gateway/credentials.json`.
 *
 * Guarantees:
 *   - the plaintext password is never stored or logged — only a scrypt hash
 *     plus a per-record random salt;
 *   - `verifyPassword` is constant time and never throws on a missing or
 *     malformed record;
 *   - `readCredentials()` returns `undefined` (not an error) on first boot, so
 *     activation cannot fail because state is absent;
 *   - `authEpoch` increments on every credential change and is the hook the
 *     session store uses to invalidate every existing session at once.
 *
 * Merge precedence (CONTRACT.md 3.5): file (mutable) > Config (static) >
 * environment (`AUTH_USER` / `AUTH_PASS`). The `DSH_AUTH_*` spellings are also
 * accepted as a lower-priority alias for deployments that namespace env vars.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { stateFile } from './paths.js'
import { readPrivateFile, writePrivateFile } from './safe-fs.js'

export const CREDENTIALS_VERSION = 1

/** Record file name inside the plugin state directory. */
export const CREDENTIALS_FILENAME = 'credentials.json'

export const DEFAULT_USERNAME = 'admin'
export const DEFAULT_REALM = 'DeepSeek Harness Authentication'

/** scrypt cost parameters. Stored implicitly: changing them invalidates hashes. */
const SCRYPT_KEY_LENGTH = 32
const SCRYPT_SALT_BYTES = 16
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

/** Base64 round-trip check used when validating a stored record. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u

function credentialsPath() {
  return stateFile(CREDENTIALS_FILENAME)
}

/** Normalize an untrusted parsed JSON value into a `Credentials` or `undefined`. */
function normalizeCredentials(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  if (value.version !== CREDENTIALS_VERSION) return undefined
  if (typeof value.username !== 'string' || value.username === '') return undefined
  if (typeof value.salt !== 'string' || !BASE64_PATTERN.test(value.salt)) return undefined
  if (typeof value.hash !== 'string' || !BASE64_PATTERN.test(value.hash)) return undefined
  return {
    version: CREDENTIALS_VERSION,
    username: value.username.slice(0, 256),
    salt: value.salt,
    hash: value.hash,
    authEpoch: Number.isSafeInteger(value.authEpoch) && value.authEpoch >= 0 ? value.authEpoch : 0,
    totpSecret: typeof value.totpSecret === 'string' ? value.totpSecret : '',
    twoFactorEnabled: value.twoFactorEnabled === true,
    updatedAt: Number.isSafeInteger(value.updatedAt) ? value.updatedAt : 0,
  }
}

/**
 * Read the stored credentials. Returns `undefined` when the file is absent,
 * unreadable, or not a valid record — the caller decides whether to seed.
 */
export function readCredentials() {
  const text = readPrivateFile(credentialsPath())
  if (text === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  return normalizeCredentials(parsed)
}

/**
 * Persist credentials atomically with owner-only permissions where the platform
 * allows it. Throws only when the file cannot be written at all.
 */
export function writeCredentials(next) {
  const normalized = normalizeCredentials({ ...next, version: CREDENTIALS_VERSION })
  if (normalized === undefined) {
    throw new TypeError('writeCredentials requires { username, salt, hash } with base64 values')
  }
  writePrivateFile(credentialsPath(), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

/**
 * Derive `{ salt, hash }` (both base64) from a password.
 *
 * Pass an explicit `salt` only to reproduce an existing record; every real
 * write must use a fresh random salt.
 */
export function hashPassword(password, salt) {
  if (typeof password !== 'string' || password === '') {
    throw new TypeError('hashPassword requires a non-empty password string')
  }
  const saltBuffer = Buffer.isBuffer(salt) ? salt : randomBytes(SCRYPT_SALT_BYTES)
  const derived = scryptSync(password, saltBuffer, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS)
  return { salt: saltBuffer.toString('base64'), hash: derived.toString('base64') }
}

/**
 * Constant-time password check against a stored record.
 *
 * Returns `false` — never throws — for a missing record, an unsupported
 * version, a malformed hash, or a length mismatch. The length guard exists
 * because `timingSafeEqual` throws when the buffers differ in size.
 */
export function verifyPassword(password, record) {
  if (typeof password !== 'string' || password === '') return false
  const normalized = normalizeCredentials(record)
  if (normalized === undefined) return false
  try {
    const saltBuffer = Buffer.from(normalized.salt, 'base64')
    const expected = Buffer.from(normalized.hash, 'base64')
    if (saltBuffer.length === 0 || expected.length === 0) return false
    const actual = scryptSync(password, saltBuffer, expected.length, SCRYPT_OPTIONS)
    if (actual.length !== expected.length) return false
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/** Constant-time comparison of two plain strings, tolerant of any input. */
export function safeEqualString(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  const leftBuffer = Buffer.from(left, 'utf8')
  const rightBuffer = Buffer.from(right, 'utf8')
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * The credentials actually in force, after merging the three sources.
 *
 * `authEpoch` and `source` are additive fields beyond CONTRACT.md 3.5: the
 * gateway needs the epoch to validate sessions and the source to explain the
 * login page ("config", "environment", "file").
 */
export function effectiveCredentials(config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const record = readCredentials()

  const envUser = envValue('AUTH_USER', 'DSH_AUTH_USER')
  const envPass = envValue('AUTH_PASS', 'DSH_AUTH_PASS')
  const configUser = typeof settings.username === 'string' && settings.username !== '' ? settings.username : undefined
  const configPass = typeof settings.password === 'string' && settings.password !== '' ? settings.password : undefined
  const configSecret = typeof settings.twoFactorSecret === 'string' ? settings.twoFactorSecret : ''
  const realm = typeof settings.realm === 'string' && settings.realm !== '' ? settings.realm : DEFAULT_REALM

  if (record !== undefined) {
    // A file record always carries a password hash, and an empty TOTP secret in
    // the file means "not enrolled", so Config may still supply one.
    const twoFactorSecret = record.totpSecret !== '' ? record.totpSecret : configSecret
    return {
      username: record.username,
      realm,
      twoFactorEnabled: record.twoFactorEnabled === true || twoFactorSecret !== '',
      twoFactorSecret,
      hasPassword: true,
      authEpoch: record.authEpoch,
      source: 'file',
    }
  }

  // No file yet: fall back to Config, then the environment.
  const twoFactorSecret = configSecret
  return {
    username: configUser ?? envUser ?? DEFAULT_USERNAME,
    realm,
    twoFactorEnabled: settings.twoFactorEnabled === true || twoFactorSecret !== '',
    twoFactorSecret,
    hasPassword: configPass !== undefined || envPass !== undefined,
    authEpoch: 0,
    source: configUser !== undefined || configPass !== undefined ? 'config' : envUser !== undefined || envPass !== undefined ? 'environment' : 'none',
  }
}

/**
 * The plaintext password currently in force, or `undefined`.
 *
 * Only exists so a change-password flow can verify against a Config/env-sourced
 * password before any record exists. Never log or persist the result.
 */
export function currentPlainPassword(config) {
  const settings = config !== null && typeof config === 'object' ? config : {}
  const configPass = typeof settings.password === 'string' && settings.password !== '' ? settings.password : undefined
  const envPass = envValue('AUTH_PASS', 'DSH_AUTH_PASS')
  return configPass ?? envPass
}

/**
 * Create the first record from a plaintext password.
 *
 * Used by the gateway's first boot / bootstrap path when no record exists yet
 * and credentials came from Config or the environment. Returns the new record,
 * or the existing one (untouched) when one is already present.
 */
export function seedCredentials({ username, password } = {}) {
  const existing = readCredentials()
  if (existing !== undefined) return existing
  if (typeof password !== 'string' || password === '') {
    throw new TypeError('seedCredentials requires a password')
  }
  const { salt, hash } = hashPassword(password)
  return writeCredentials({
    version: CREDENTIALS_VERSION,
    username: typeof username === 'string' && username !== '' ? username : DEFAULT_USERNAME,
    salt,
    hash,
    authEpoch: 1,
    totpSecret: '',
    twoFactorEnabled: false,
    updatedAt: Date.now(),
  })
}

/**
 * Replace the password, bump `authEpoch`, and keep the TOTP enrollment.
 *
 * `fallbackPassword` is the plaintext in force when no record exists yet (the
 * Config or environment password). Returns the new record; throws with a
 * caller-safe message when the current password is wrong.
 */
export function changePassword(currentPassword, newPassword, fallbackPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw new Error('new password must be at least 8 characters')
  }
  const record = readCredentials()
  const accepted = record !== undefined
    ? verifyPassword(currentPassword, record)
    : typeof fallbackPassword === 'string' && fallbackPassword !== '' && safeEqualString(currentPassword, fallbackPassword)
  if (!accepted) throw new Error('current password is incorrect')

  const { salt, hash } = hashPassword(newPassword)
  return writeCredentials({
    version: CREDENTIALS_VERSION,
    username: record?.username ?? DEFAULT_USERNAME,
    salt,
    hash,
    authEpoch: (record?.authEpoch ?? 0) + 1,
    totpSecret: record?.totpSecret ?? '',
    twoFactorEnabled: record?.twoFactorEnabled === true,
    updatedAt: Date.now(),
  })
}

/** Update the TOTP enrollment fields, bumping `authEpoch` on real changes. */
export function setTwoFactor({ secret, enabled }) {
  const record = readCredentials()
  if (record === undefined) throw new Error('no credentials record to update')
  const nextSecret = typeof secret === 'string' ? secret : record.totpSecret
  const nextEnabled = typeof enabled === 'boolean' ? enabled : record.twoFactorEnabled
  const changed = nextSecret !== record.totpSecret || nextEnabled !== record.twoFactorEnabled
  return writeCredentials({
    ...record,
    totpSecret: nextSecret,
    twoFactorEnabled: nextEnabled,
    authEpoch: changed ? record.authEpoch + 1 : record.authEpoch,
    updatedAt: changed ? Date.now() : record.updatedAt,
  })
}
