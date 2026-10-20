/**
 * Browser session registry for @dsh-plugins/auth-gateway.
 *
 * Storage model: metadata + an integrity HMAC only. The cookie *value* (the
 * bearer) is never written to disk — losing the state file therefore cannot
 * hand out a usable credential, and a stolen state file cannot be replayed as a
 * login. `create()` mints a 128-bit random id, returns it once to the caller
 * (which puts it in an HttpOnly cookie), and stores only its digest material.
 *
 * Two independent lifetimes apply, both from CONTRACT.md 3.6:
 *   - `maxAgeSeconds`     absolute lifetime from creation;
 *   - `idleTimeoutSeconds` sliding lifetime from the last `touch()`.
 * `authEpoch` is a third, orthogonal switch: any credential change bumps it in
 * credentials.json and every record minted under the old epoch fails
 * `verify()`, which is how "change the password, kick every browser" works
 * without touching the registry.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readPrivateFile, writePrivateFile } from './safe-fs.js'

/** Session ids are 16 random bytes, base64url-encoded without padding. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u
export const SESSION_STORE_VERSION = 1
/** `touch()` persists at most this often; every request would be wasteful. */
export const TOUCH_PERSIST_INTERVAL_MS = 30_000
const KEY_BYTES = 32
const MAX_TEXT_FIELD = 512

function sanitizeText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, MAX_TEXT_FIELD)
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value)
}

/**
 * A single session record: no bearer token, no password material.
 * `hmac` covers the immutable fields so a hand-edited file is detected.
 */
function normalizeRecord(value) {
  if (value === null || typeof value !== 'object') return null
  if (typeof value.id !== 'string' || !SESSION_ID_PATTERN.test(value.id)) return null
  if (!isSafeInteger(value.createdAt) || !isSafeInteger(value.lastSeenAt) || !isSafeInteger(value.expiresAt)) return null
  if (value.expiresAt <= value.createdAt) return null
  if (typeof value.hmac !== 'string' || !/^[a-f0-9]{64}$/u.test(value.hmac)) return null
  return {
    id: value.id,
    authEpoch: isSafeInteger(value.authEpoch) && value.authEpoch >= 0 ? value.authEpoch : 0,
    createdAt: value.createdAt,
    lastSeenAt: Math.max(value.createdAt, value.lastSeenAt),
    expiresAt: value.expiresAt,
    userAgent: sanitizeText(value.userAgent),
    address: sanitizeText(value.address),
    hmac: value.hmac,
  }
}

/** Public projection: safe to render in a settings page, contains no token. */
function publicRecord(record) {
  return {
    id: record.id,
    authEpoch: record.authEpoch,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    expiresAt: record.expiresAt,
    userAgent: record.userAgent,
    address: record.address,
  }
}

export class SessionStore {
  #file
  #keyFile
  #key
  #maxAgeMs
  #idleTimeoutMs
  #authEpoch
  #now
  #records = new Map()
  #lastPersistAt = 0
  #disposed = false

  /**
   * @param {object} options
   * @param {string} options.file          absolute path of `sessions.json`
   * @param {number} [options.maxAgeSeconds=86400]
   * @param {number} [options.idleTimeoutSeconds=43200]
   * @param {number} [options.authEpoch=0]  epoch stamped on new sessions
   * @param {() => number} [options.now]    clock injection for tests
   */
  constructor(options = {}) {
    const { file, maxAgeSeconds = 86_400, idleTimeoutSeconds = 43_200, authEpoch = 0, now } = options ?? {}
    if (typeof file !== 'string' || file === '') throw new TypeError('SessionStore requires a file path')
    this.#file = file
    this.#keyFile = `${file}.key`
    this.#maxAgeMs = Math.max(0, Number(maxAgeSeconds) || 0) * 1000
    this.#idleTimeoutMs = Math.max(0, Number(idleTimeoutSeconds) || 0) * 1000
    this.#authEpoch = isSafeInteger(authEpoch) && authEpoch >= 0 ? authEpoch : 0
    this.#now = typeof now === 'function' ? now : () => Date.now()
    this.#key = this.#loadOrCreateKey()
    this.load()
  }

  /** Epoch stamped onto newly created sessions; also the default for `verify`. */
  get authEpoch() {
    return this.#authEpoch
  }

  set authEpoch(value) {
    if (isSafeInteger(value) && value >= 0) this.#authEpoch = value
  }

  /** Number of records, including ones already expired but not yet pruned. */
  get size() {
    return this.#records.size
  }

  #loadOrCreateKey() {
    const existing = readPrivateFile(this.#keyFile)
    if (typeof existing === 'string' && /^[a-f0-9]{64}$/u.test(existing.trim())) {
      return Buffer.from(existing.trim(), 'hex')
    }
    const key = randomBytes(KEY_BYTES)
    try {
      writePrivateFile(this.#keyFile, key.toString('hex'))
    } catch {
      // An in-memory-only key still serves this process; persist() will simply
      // leave records unreadable across a restart, which fails closed.
    }
    return key
  }

  #hmacFor(record) {
    return createHmac('sha256', this.#key)
      .update(`${record.id}\u0000${record.authEpoch}\u0000${record.createdAt}\u0000${record.expiresAt}`)
      .digest('hex')
  }

  /** CSRF token is derived, not stored, so it never leaves the process. */
  #csrfFor(id) {
    return createHmac('sha256', this.#key).update(`csrf\u0000${id}`).digest('base64url')
  }

  #isExpired(record, now) {
    if (record.expiresAt <= now) return true
    return this.#idleTimeoutMs > 0 && record.lastSeenAt + this.#idleTimeoutMs <= now
  }

  /** Load records from disk, dropping anything malformed, tampered or expired. */
  load() {
    this.#records.clear()
    const text = readPrivateFile(this.#file)
    if (text === undefined) return this
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return this
    }
    if (parsed === null || typeof parsed !== 'object') return this
    if (parsed.version !== SESSION_STORE_VERSION || !Array.isArray(parsed.sessions)) return this
    const now = this.#now()
    for (const value of parsed.sessions) {
      const record = normalizeRecord(value)
      if (record === null) continue
      if (!this.#hmacMatches(record)) continue
      if (this.#isExpired(record, now)) continue
      this.#records.set(record.id, record)
    }
    return this
  }

  #hmacMatches(record) {
    try {
      const expected = Buffer.from(this.#hmacFor(record), 'hex')
      const actual = Buffer.from(record.hmac, 'hex')
      return expected.length === actual.length && timingSafeEqual(expected, actual)
    } catch {
      return false
    }
  }

  /**
   * Mint a session and return the one-time cookie material.
   *
   * `authEpoch` is an optional third argument beyond CONTRACT.md 3.6: without it
   * the store's own epoch is used, so `create(ua, addr)` works for callers that
   * configure the epoch in the constructor instead.
   */
  create(userAgent, remoteAddress, authEpoch) {
    if (this.#disposed) throw new Error('SessionStore is disposed')
    const epoch = isSafeInteger(authEpoch) && authEpoch >= 0 ? authEpoch : this.#authEpoch
    const now = this.#now()
    let id
    do {
      id = randomBytes(16).toString('base64url')
    } while (this.#records.has(id))
    const record = {
      id,
      authEpoch: epoch,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.#maxAgeMs,
      userAgent: sanitizeText(userAgent),
      address: sanitizeText(remoteAddress),
      hmac: '',
    }
    record.hmac = this.#hmacFor(record)
    this.#records.set(id, record)
    this.persist()
    return { id, csrf: this.#csrfFor(id) }
  }

  /**
   * Whether `id` is a live session minted under `authEpoch`.
   *
   * Fails closed on: unknown id, malformed id, tampered record, expired
   * absolute age, expired idle age, or an epoch mismatch.
   */
  verify(id, authEpoch) {
    if (this.#disposed) return false
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return false
    const record = this.#records.get(id)
    if (record === undefined) return false
    const epoch = isSafeInteger(authEpoch) ? authEpoch : this.#authEpoch
    if (record.authEpoch !== epoch) return false
    if (!this.#hmacMatches(record)) return false
    return !this.#isExpired(record, this.#now())
  }

  /** Mark activity. Persists at most once per `TOUCH_PERSIST_INTERVAL_MS`. */
  touch(id) {
    if (this.#disposed) return
    if (typeof id !== 'string' || !SESSION_ID_PATTERN.test(id)) return
    const record = this.#records.get(id)
    if (record === undefined) return
    const now = this.#now()
    if (this.#isExpired(record, now)) return
    record.lastSeenAt = now
    if (now - this.#lastPersistAt >= TOUCH_PERSIST_INTERVAL_MS) this.persist()
  }

  /** Revoke one session; returns whether it existed. */
  revoke(id) {
    if (typeof id !== 'string') return false
    const existed = this.#records.delete(id)
    if (existed) this.persist()
    return existed
  }

  /** Revoke every session; returns how many were removed. */
  revokeAll() {
    const count = this.#records.size
    this.#records.clear()
    this.persist()
    return count
  }

  /** Drop expired records; returns how many were removed. */
  prune() {
    const now = this.#now()
    let removed = 0
    for (const [id, record] of this.#records) {
      if (!this.#isExpired(record, now)) continue
      this.#records.delete(id)
      removed += 1
    }
    if (removed > 0) this.persist()
    return removed
  }

  /** Sessions for the settings page: metadata only, never a token value. */
  list() {
    const now = this.#now()
    return [...this.#records.values()]
      .filter((record) => !this.#isExpired(record, now))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt || right.createdAt - left.createdAt)
      .map(publicRecord)
  }

  /** Atomically write the registry. Throws only when the file cannot be written. */
  persist() {
    if (this.#disposed) return
    const body = {
      version: SESSION_STORE_VERSION,
      sessions: [...this.#records.values()].map((record) => ({ ...record })),
    }
    writePrivateFile(this.#file, `${JSON.stringify(body, null, 2)}\n`)
    this.#lastPersistAt = this.#now()
  }

  /** Persist, then stop accepting operations. Safe to call more than once. */
  dispose() {
    if (this.#disposed) return
    try {
      this.persist()
    } catch {
      // Shutdown must not throw; the registry is rebuildable (sessions die).
    }
    this.#disposed = true
    this.#records.clear()
  }
}
