/**
 * Auth gateway: an authenticating reverse proxy in front of the stock DSH web
 * server.
 *
 * Why this exists: dsh authenticates a browser with a single per-process launch
 * token exchanged for one signed cookie, and every authenticated connection maps
 * to the same `owner` principal. There is no account, no logout, no per-device
 * revocation and no audit trail. This gateway adds those on a separate port
 * while leaving the core web server untouched on loopback.
 *
 * Security model (all of these are load-bearing):
 *   * The upstream is forced to a loopback address, so the core process launch
 *     token is never sent to a network destination.
 *   * The core session cookie is held in memory by this process only. Browser
 *     `dsh-auth-*` cookies are stripped on the way in and the core `Set-Cookie`
 *     is stripped on the way out.
 *   * Fences run before authentication and fail closed: a Host that is not ours
 *     is 421, an Origin that is not same-authority is 403.
 */

import { createServer, request as httpRequest } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { dirname } from 'node:path'

import { stateFile } from './paths.js'
import { ensurePrivateDir, readPrivateFile, writePrivateFile, hardenFile } from './safe-fs.js'
import {
  hostMatches,
  originMatches,
  parseAllowedHost,
  parseAllowedOrigin,
  parseList,
  parseRequestHost,
} from './policy.js'
import { generateTotpSecret, verifyTotp } from './totp.js'
import {
  CREDENTIALS_VERSION,
  changePassword as changeStoredPassword,
  currentPlainPassword,
  effectiveCredentials,
  hashPassword,
  readCredentials,
  safeEqualString,
  seedCredentials,
  setTwoFactor,
  verifyPassword,
  writeCredentials,
} from './credentials.js'
import { SessionStore } from './sessions.js'
import { renderLoginPage, selectLoginLocale, loginErrorMessage } from './login-page.js'
import {
  attachCoreCookie,
  createCoreSessionBridge,
  createLoopbackTarget,
  stripCoreCookies,
  stripCoreSetCookies,
  stripLaunchToken,
} from './core-session.js'

/** Gateway-owned routes. These are part of the client RPC contract. */
export const GATEWAY_ROUTES = Object.freeze({
  login: '/api/auth.login',
  logout: '/api/auth.logout',
  changePassword: '/api/auth.change-password',
  status: '/api/auth.status',
  totp: '/api/auth.totp',
  state: '/_dsh/auth-gateway/state',
})

export const SESSION_COOKIE = 'dsh_gw_session'
export const CSRF_COOKIE = 'dsh_gw_csrf'
const SECURE_SESSION_COOKIE = '__Host-dsh_gw_session'
const SECURE_CSRF_COOKIE = '__Host-dsh_gw_csrf'

const SECRET_BYTES = 32
const MAX_BODY_BYTES = 64 * 1024
const LOGIN_WINDOW_SECONDS = 60
const LOGIN_MAX_ATTEMPTS = 10
const LOGIN_ATTEMPT_ENTRIES = 10_000
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000
const PASSWORD_MIN_LENGTH = 8

/* ------------------------------------------------------------------ *
 * Small HTTP helpers (kept local so this file has no hidden coupling)
 * ------------------------------------------------------------------ */

/**
 * Security headers for every gateway-owned response.
 *
 * `connect-src 'self'` is required, not optional: the login page submits its
 * credentials with `fetch` (so the page can show an inline error instead of
 * navigating away). With `default-src 'none'` and no `connect-src`, the browser
 * blocks that very request — the page renders but sign-in can never complete:
 *
 *   Connecting to '.../api/auth.login' violates the following Content Security
 *   Policy directive: "default-src 'none'". Note that 'connect-src' was not
 *   explicitly set, so 'default-src' is used as a fallback.
 *
 * The rest stays locked down: no external origins, no framing, no base-uri.
 */
function securityHeaders({ secure = false, noStore = true } = {}) {
  const headers = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      // Same-origin XHR/fetch for the login form and the diagnostics actions.
      "connect-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "form-action 'self'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  }
  if (noStore) headers['cache-control'] = 'no-store'
  if (secure) headers['strict-transport-security'] = 'max-age=31536000'
  return headers
}

function sendJson(res, status, value, extra = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    ...securityHeaders(),
    ...extra,
  })
  res.end(body)
}

function sendHtml(res, status, html, extra = {}) {
  const body = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.byteLength),
    ...securityHeaders(),
    ...extra,
  })
  res.end(body)
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseCookies(req) {
  const header = req.headers.cookie
  const out = new Map()
  if (typeof header !== 'string') return out
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    out.set(trimmed.slice(0, equals).trim(), trimmed.slice(equals + 1).trim())
  }
  return out
}

function clientAddress(req) {
  const raw = req.socket?.remoteAddress ?? ''
  if (raw.startsWith('::ffff:')) return raw.slice(7)
  return raw
}

function rejectUpgrade(socket, status, message) {
  const body = `${message}\n`
  socket.write(
    `HTTP/1.1 ${String(status)} ${message}\r\n`
    + 'connection: close\r\n'
    + 'content-type: text/plain; charset=utf-8\r\n'
    + `content-length: ${String(Buffer.byteLength(body))}\r\n`
    + '\r\n'
    + body,
  )
  socket.destroy()
}

function isLoopbackAddress(address) {
  const value = typeof address === 'string' ? address : ''
  return value === '127.0.0.1' || value === '::1' || value.startsWith('127.')
}

function signValue(secret, value) {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

/** Constant-time comparison that tolerates unequal lengths without throwing. */
function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8')
  const b = Buffer.from(String(right ?? ''), 'utf8')
  if (a.byteLength !== b.byteLength) return false
  if (a.byteLength === 0) return false
  return timingSafeEqual(a, b)
}

/**
 * Whether one request may reach the gateway at all (fence stage).
 *
 * Mirrors the core's own browser-trust fence: a Host is acceptable when it is
 * loopback, when it names one of the addresses this gateway actually bound, or
 * when it matches a configured `allowedHosts` entry. Requiring an explicit
 * entry for the common case would 421 every request out of the box, so the bind
 * authority is accepted inherently — it is not a DNS-rebinding target.
 *
 * @returns `{ kind: 'host' }` for a rejected Host, `{ kind: 'origin' }` for a
 * rejected Origin, else `{ kind: 'allow' }`.
 */
export function fenceDecision(headers, allowedHosts, allowedOrigins, secure, bindAddresses = []) {
  const host = headers.host
  if (typeof host !== 'string' || host === '') return { kind: 'host' }
  const parsed = parseRequestHost(host)
  if (parsed === undefined) return { kind: 'host' }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '')
  const bound = bindAddresses.some((address) => {
    const literal = String(address).replace(/^\[|\]$/g, '').split('%')[0]
    return literal !== '' && literal === hostname
  })
  if (hostname !== 'localhost' && !isLoopbackHostname(hostname) && !bound
    && !hostMatches(host, allowedHosts, secure)) {
    return { kind: 'host' }
  }
  if (!originMatches(headers.origin, host, allowedOrigins)) return { kind: 'origin' }
  return { kind: 'allow' }
}

/** Loopback classification shared by the fence. */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost') return true
  if (hostname === '::1') return true
  if (/^127\./u.test(hostname)) return true
  // `::ffff:127.0.0.1` is the mapped form a dual-stack listener reports.
  return /^::ffff:127\./iu.test(hostname)
}

/**
 * Remove this gateway's own cookies before a request continues upstream.
 *
 * The upstream is the dsh core; it has no business seeing the gateway's session
 * or CSRF cookie, and forwarding them would widen the blast radius if the
 * upstream ever logged or relayed request headers.
 */
export function stripGatewayCookies(header, names) {
  if (typeof header !== 'string') return undefined
  const drop = new Set(names.filter((name) => typeof name === 'string' && name !== ''))
  const kept = header.split(';')
    .map((part) => part.trim())
    .filter((part) => {
      if (part === '') return false
      const equals = part.indexOf('=')
      const name = equals < 0 ? part : part.slice(0, equals).trim()
      return !drop.has(name)
    })
  return kept.length > 0 ? kept.join('; ') : undefined
}

/* ------------------------------------------------------------------ *
 * Gateway
 * ------------------------------------------------------------------ */

/**
 * Build the gateway. `deps` exists so tests can inject doubles; production
 * callers pass nothing and get the real modules.
 */
export function createGateway(ctx, config, deps = {}) {
  const logger = deps.logger ?? ctx?.logger ?? console
  const policy = {
    hostMatches,
    originMatches,
    parseAllowedHost,
    parseAllowedOrigin,
    parseRequestHost,
    parseList,
    ...(deps.policy ?? {}),
  }

  const secure = config.tls === true
  const sessionCookieName = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE
  const csrfCookieName = secure ? SECURE_CSRF_COOKIE : CSRF_COOKIE

  const allowedHosts = (Array.isArray(config.allowedHosts) ? config.allowedHosts : [])
    .map((value, index) => policy.parseAllowedHost(value, index))
  const allowedOrigins = (Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [])
    .map((value, index) => policy.parseAllowedOrigin(value, index))

  let secret
  let sessions
  let coreSession
  let coreTarget
  let disposed = false
  const servers = []
  const activeSockets = new Set()
  // Addresses this gateway actually bound. The fence accepts them inherently:
  // an operator should not have to list the machine's own IP just to reach it.
  const boundAddresses = []

  const attempts = new Map()

  function loadSecret() {
    const file = stateFile('gateway-secret')
    ensurePrivateDir(dirname(file))
    const existing = readPrivateFile(file)
    if (typeof existing === 'string' && existing.trim() !== '') return existing.trim()
    const created = randomBytes(SECRET_BYTES).toString('hex')
    writePrivateFile(file, created)
    hardenFile(file)
    return created
  }

  function credentials() {
    return effectiveCredentials(config)
  }

  /**
   * Check a password against whichever source is authoritative.
   *
   * A stored record always wins. Before the first record exists the Config (or
   * `AUTH_PASS`) plaintext stands in, so an operator can bootstrap without a
   * pre-seeded file.
   */
  function passwordOk(password) {
    const record = readCredentials()
    if (record !== undefined) return verifyPassword(password, record)
    const fallback = currentPlainPassword(config)
    return typeof fallback === 'string' && fallback !== '' && safeEqualString(password, fallback)
  }

  /** Ensure a record exists so sessions can be bound to a stable authEpoch. */
  function ensureRecord() {
    const record = readCredentials()
    if (record !== undefined) return record
    const fallback = currentPlainPassword(config)
    if (typeof fallback !== 'string' || fallback === '') return undefined
    try {
      return seedCredentials({ username: config.username, password: fallback })
    } catch (error) {
      logger.warn?.('auth-gateway: could not seed credentials: %s', error?.message ?? String(error))
      return undefined
    }
  }

  function rateLimit(key) {
    const now = Date.now()
    const windowMs = LOGIN_WINDOW_SECONDS * 1000
    let entry = attempts.get(key)
    if (entry === undefined || now - entry.startedAt > windowMs) {
      entry = { startedAt: now, count: 0 }
      if (attempts.size >= LOGIN_ATTEMPT_ENTRIES) attempts.clear()
      attempts.set(key, entry)
    }
    entry.count += 1
    return entry.count <= LOGIN_MAX_ATTEMPTS
  }

  function issueSession(req, res) {
    const epoch = credentials().authEpoch
    const record = sessions.create(
      String(req.headers['user-agent'] ?? ''),
      clientAddress(req),
      epoch,
    )
    const signature = signValue(secret, record.id)
    const maxAge = config.sessionMaxAgeSeconds
    const cookies = [
      `${sessionCookieName}=${record.id}.${signature}; Max-Age=${String(maxAge)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
      `${csrfCookieName}=${record.csrf}; Max-Age=${String(maxAge)}; Path=/; SameSite=Strict${secure ? '; Secure' : ''}`,
    ]
    return { record, cookies }
  }

  /** Resolve the browser session, or undefined when unauthenticated. */
  function authenticate(req) {
    const cookies = parseCookies(req)
    const raw = cookies.get(sessionCookieName)
    if (typeof raw !== 'string' || raw === '') return undefined
    const dot = raw.lastIndexOf('.')
    if (dot <= 0) return undefined
    const id = raw.slice(0, dot)
    const signature = raw.slice(dot + 1)
    if (!safeEqual(signature, signValue(secret, id))) return undefined
    const current = credentials()
    if (!sessions.verify(id, current.authEpoch)) return undefined
    sessions.touch(id)
    return { id, csrf: cookies.get(csrfCookieName) }
  }

  /** Write operations must present the CSRF value bound to the session. */
  function csrfOk(req, auth, body) {
    if (auth === undefined) return false
    const presented = req.headers['x-dsh-csrf']
      ?? (body !== undefined && typeof body === 'object' ? body.csrf : undefined)
    if (typeof presented !== 'string' || presented === '') return false
    return safeEqual(presented, auth.csrf)
  }

  function clearCookies() {
    const parts = [
      `${sessionCookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
      `${csrfCookieName}=; Max-Age=0; Path=/; SameSite=Strict${secure ? '; Secure' : ''}`,
    ]
    return parts
  }

  function loginPageResponse(req, res, error) {
    const current = credentials()
    const html = renderLoginPage({
      realm: current.realm,
      twoFactorEnabled: current.twoFactorEnabled,
      locale: selectLoginLocale(req),
      rawRequestUrl: req.url ?? '/',
      error,
    })
    sendHtml(res, 200, html)
  }

  function unauthorized(req, res) {
    if (req.method === 'GET' && acceptsHtml(req)) {
      loginPageResponse(req, res)
      return
    }
    sendJson(res, 401, { ok: false, error: 'unauthenticated' })
  }

  function acceptsHtml(req) {
    const accept = req.headers.accept
    return typeof accept === 'string' && accept.includes('text/html')
  }

  /* ---------------------------- routes ---------------------------- */

  async function handleLogin(req, res) {
    if (!rateLimit(clientAddress(req))) {
      sendJson(res, 429, { ok: false, error: 'too_many_attempts' })
      return
    }
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_request' })
      return
    }
    const current = credentials()
    const locale = selectLoginLocale(req)
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''

    if (!safeEqualString(username, current.username) || !passwordOk(password)) {
      sendJson(res, 401, { ok: false, error: loginErrorMessage(locale, 'invalid_credentials') })
      return
    }
    if (current.twoFactorEnabled) {
      const code = typeof body?.totp === 'string' ? body.totp : ''
      if (!verifyTotp(current.twoFactorSecret, code)) {
        sendJson(res, 401, { ok: false, error: loginErrorMessage(locale, 'invalid_totp') })
        return
      }
    }
    const { record, cookies } = issueSession(req, res)
    void record
    logger.info?.('auth-gateway: login succeeded for %s', current.username)
    sendJson(res, 200, { ok: true, username: current.username, csrf: record.csrf }, {
      'set-cookie': cookies,
    })
  }

  async function handleLogout(req, res) {
    const auth = authenticate(req)
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      body = {}
    }
    if (!csrfOk(req, auth, body)) {
      sendJson(res, 403, { ok: false, error: 'csrf' })
      return
    }
    sessions.revoke(auth.id)
    sendJson(res, 200, { ok: true }, { 'set-cookie': clearCookies() })
  }

  async function handleChangePassword(req, res) {
    const auth = authenticate(req)
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_request' })
      return
    }
    if (!csrfOk(req, auth, body)) {
      sendJson(res, 403, { ok: false, error: 'csrf' })
      return
    }
    const current = credentials()
    const currentPassword = typeof body?.currentPassword === 'string' ? body.currentPassword : ''
    const newPassword = typeof body?.newPassword === 'string' ? body.newPassword : ''
    if (!passwordOk(currentPassword)) {
      sendJson(res, 401, { ok: false, error: 'invalid_credentials' })
      return
    }
    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      sendJson(res, 400, { ok: false, error: 'password_too_short' })
      return
    }
    if (current.twoFactorEnabled && !verifyTotp(current.twoFactorSecret, body?.totp)) {
      sendJson(res, 401, { ok: false, error: 'invalid_totp' })
      return
    }
    try {
      // The helper bumps authEpoch, which is what invalidates every existing
      // session; clearing the registry keeps the two in step immediately.
      changeStoredPassword(currentPassword, newPassword, currentPlainPassword(config))
    } catch (error) {
      sendJson(res, 400, { ok: false, error: 'password_change_failed' })
      logger.warn?.('auth-gateway: password change failed: %s', error?.message ?? String(error))
      return
    }
    sessions.revokeAll()
    sessions.persist()
    logger.info?.('auth-gateway: password changed; all sessions revoked')
    sendJson(res, 200, { ok: true, reauthenticate: true }, { 'set-cookie': clearCookies() })
  }

  async function handleTotp(req, res) {
    const auth = authenticate(req)
    let body
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid_request' })
      return
    }
    if (!csrfOk(req, auth, body)) {
      sendJson(res, 403, { ok: false, error: 'csrf' })
      return
    }
    const current = credentials()
    const action = body?.action
    if (action === 'begin') {
      const secret = generateTotpSecret()
      sendJson(res, 200, { ok: true, secret })
      return
    }
    if (action === 'enable') {
      const secret = typeof body?.secret === 'string' ? body.secret : ''
      if (secret === '' || !verifyTotp(secret, body?.code)) {
        sendJson(res, 400, { ok: false, error: 'invalid_totp' })
        return
      }
      const record = ensureRecord()
      if (record === undefined) {
        sendJson(res, 409, { ok: false, error: 'no_credentials' })
        return
      }
      setTwoFactor({ secret, enabled: true })
      sessions.revokeAll()
      sessions.persist()
      sendJson(res, 200, { ok: true, twoFactorEnabled: true })
      return
    }
    if (action === 'disable') {
      if (!passwordOk(typeof body?.password === 'string' ? body.password : '')) {
        sendJson(res, 401, { ok: false, error: 'invalid_credentials' })
        return
      }
      if (readCredentials() !== undefined) setTwoFactor({ secret: '', enabled: false })
      sendJson(res, 200, { ok: true, twoFactorEnabled: false })
      return
    }
    sendJson(res, 400, { ok: false, error: 'invalid_request' })
  }

  function handleStatus(req, res) {
    const auth = authenticate(req)
    const current = credentials()
    sendJson(res, 200, {
      ok: true,
      authenticated: auth !== undefined,
      username: current.username,
      twoFactorEnabled: current.twoFactorEnabled,
      hasPassword: current.hasPassword,
      authEpoch: current.authEpoch,
      sessions: sessions.list().length,
      // The CSRF value is only released to an already-authenticated caller: it is
      // the second half of the double-submit check on write routes.
      csrf: auth?.csrf,
    })
  }

  function handleState(req, res) {
    const auth = authenticate(req)
    sendJson(res, 200, {
      ok: true,
      authenticated: auth !== undefined,
      username: credentials().username,
      twoFactorEnabled: credentials().twoFactorEnabled,
      listening: servers.map((server) => server.address()).filter(Boolean),
    })
  }

  /* -------------------------- proxying --------------------------- */

  function cleanForwardedHeaders(headers) {
    const out = { ...headers }
    for (const name of ['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']) {
      delete out[name]
    }
    return out
  }

  async function proxyHttp(req, res, auth) {
    let core
    try {
      core = await coreSession.ensure()
    } catch (error) {
      logger.warn?.('auth-gateway: core session bootstrap failed: %s', error?.message ?? String(error))
      sendJson(res, 503, { ok: false, error: 'upstream_authentication_unavailable' })
      return
    }
    const headers = cleanForwardedHeaders(req.headers)
    if (headers.cookie !== undefined) {
      // Drop both families: the browser's core cookies (which belong to the
      // browser↔core hop only) and our own, which the upstream must never see.
      headers.cookie = stripGatewayCookies(
        stripCoreCookies(headers.cookie),
        [sessionCookieName, csrfCookieName],
      )
      if (headers.cookie === undefined) delete headers.cookie
    }
    headers.cookie = attachCoreCookie(headers.cookie, core)
    headers.host = coreTarget.authority
    if (headers.origin !== undefined) headers.origin = coreTarget.origin
    headers['x-forwarded-for'] = clientAddress(req)

    const upstream = httpRequest({
      hostname: coreTarget.hostname,
      port: coreTarget.port,
      method: req.method,
      path: stripLaunchToken(req.url),
      headers,
    }, (upstreamRes) => {
      if (upstreamRes.statusCode === 401) coreSession.invalidate()
      const responseHeaders = stripCoreSetCookies({ ...upstreamRes.headers })
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      upstreamRes.pipe(res)
    })
    upstream.setTimeout(config.upstreamTimeoutMs, () => {
      upstream.destroy(new Error('upstream request timed out'))
    })
    upstream.once('error', (error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { ok: false, error: 'upstream_unreachable' })
      } else {
        res.destroy()
      }
      logger.warn?.('auth-gateway: upstream error: %s', error?.message ?? String(error))
    })
    req.pipe(upstream)
    void auth
  }

  async function proxyUpgrade(req, socket, head, auth) {
    let core
    try {
      core = await coreSession.ensure()
    } catch (error) {
      logger.warn?.('auth-gateway: core session bootstrap failed for upgrade: %s', error?.message ?? String(error))
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const headers = cleanForwardedHeaders(req.headers)
    if (headers.cookie !== undefined) {
      headers.cookie = stripGatewayCookies(
        stripCoreCookies(headers.cookie),
        [sessionCookieName, csrfCookieName],
      )
      if (headers.cookie === undefined) delete headers.cookie
    }
    headers.cookie = attachCoreCookie(headers.cookie, core)
    headers.host = coreTarget.authority
    if (headers.origin !== undefined) headers.origin = coreTarget.origin
    headers['x-forwarded-for'] = clientAddress(req)
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'

    const upstream = httpRequest({
      hostname: coreTarget.hostname,
      port: coreTarget.port,
      method: 'GET',
      path: stripLaunchToken(req.url),
      headers,
    })
    const pair = { upstream: undefined, closed: false }
    const closePair = () => {
      if (pair.closed) return
      pair.closed = true
      activeSockets.delete(socket)
      socket.destroy()
      pair.upstream?.destroy()
    }
    activeSockets.add(socket)
    socket.once('close', closePair)
    socket.once('error', closePair)
    upstream.once('error', closePair)
    upstream.setTimeout(config.upstreamTimeoutMs, () => {
      upstream.destroy(new Error('upstream WebSocket handshake timed out'))
    })
    upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
      if (pair.closed) {
        upstreamSocket.destroy()
        return
      }
      pair.upstream = upstreamSocket
      if (upstreamRes.statusCode === 401) coreSession.invalidate()
      // A 101 is only valid for the browser when it carries the hop-by-hop
      // headers, so rebuild the status line explicitly.
      const lines = [`HTTP/1.1 ${String(upstreamRes.statusCode)} ${upstreamRes.statusMessage ?? 'Switching Protocols'}`]
      lines.push(`Upgrade: ${upstreamRes.headers.upgrade ?? 'websocket'}`)
      lines.push('Connection: Upgrade')
      for (const [key, value] of Object.entries(stripCoreSetCookies({ ...upstreamRes.headers }))) {
        const lower = key.toLowerCase()
        if (lower === 'connection' || lower === 'upgrade') continue
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else lines.push(`${key}: ${value}`)
      }
      lines.push('', '')
      socket.write(lines.join('\r\n'))
      if (upstreamHead !== undefined && upstreamHead.length > 0) socket.write(upstreamHead)
      if (head !== undefined && head.length > 0) upstreamSocket.write(head)
      socket.pipe(upstreamSocket)
      upstreamSocket.pipe(socket)
      upstreamSocket.once('close', closePair)
      upstreamSocket.once('error', closePair)
    })
    upstream.on('response', (upstreamRes) => {
      // A non-101 response means the upstream refused the upgrade.
      const status = upstreamRes.statusCode ?? 502
      if (status === 401) coreSession.invalidate()
      rejectUpgrade(socket, status, status === 401 ? 'Unauthorized' : 'Bad Gateway')
    })
    upstream.end()
    void auth
  }

  /* --------------------------- dispatch -------------------------- */

  async function handleRequest(req, res) {
    if (disposed) {
      sendJson(res, 503, { ok: false, error: 'shutting_down' })
      return
    }
    const decision = fenceDecision(req.headers, allowedHosts, allowedOrigins, secure, boundAddresses)
    if (decision.kind === 'host') {
      // 421: this listener is not authoritative for the requested Host. This is
      // the DNS-rebinding defence and must run before anything else.
      sendJson(res, 421, { ok: false, error: 'misdirected_request' })
      return
    }
    if (decision.kind === 'origin') {
      sendJson(res, 403, { ok: false, error: 'forbidden_origin' })
      return
    }

    const path = (req.url ?? '/').split('?', 1)[0]

    if (path === GATEWAY_ROUTES.login && req.method === 'POST') return handleLogin(req, res)
    if (path === GATEWAY_ROUTES.logout && req.method === 'POST') return handleLogout(req, res)
    if (path === GATEWAY_ROUTES.changePassword && req.method === 'POST') return handleChangePassword(req, res)
    if (path === GATEWAY_ROUTES.totp && req.method === 'POST') return handleTotp(req, res)
    if (path === GATEWAY_ROUTES.status && req.method === 'GET') return handleStatus(req, res)
    if (path === GATEWAY_ROUTES.state && req.method === 'GET') return handleState(req, res)

    const auth = authenticate(req)
    if (auth === undefined) {
      unauthorized(req, res)
      return
    }
    return proxyHttp(req, res, auth)
  }

  function handleUpgrade(req, socket, head) {
    if (disposed) {
      rejectUpgrade(socket, 503, 'Service Unavailable')
      return
    }
    const decision = fenceDecision(req.headers, allowedHosts, allowedOrigins, secure, boundAddresses)
    if (decision.kind === 'host') {
      rejectUpgrade(socket, 421, 'Misdirected Request')
      return
    }
    if (decision.kind === 'origin') {
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }
    const auth = authenticate(req)
    if (auth === undefined) {
      rejectUpgrade(socket, 401, 'Unauthorized')
      return
    }
    void proxyUpgrade(req, socket, head, auth)
  }

  /* ------------------------ listener wiring ---------------------- */

  /** Candidate bind addresses: explicit config first, else every non-loopback NIC. */
  function pickAddresses() {
    const explicit = (Array.isArray(config.addresses) ? config.addresses : [])
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
    if (explicit.length > 0) return explicit
    const out = []
    const interfaces = networkInterfaces()
    for (const entries of Object.values(interfaces)) {
      for (const info of entries ?? []) {
        if (info.internal) continue
        const family = info.family
        if (family !== 'IPv4' && family !== 4) continue
        out.push(info.address)
      }
    }
    return out
  }

  async function listenOn(address) {
    const server = createServer((req, res) => {
      handleRequest(req, res).catch((error) => {
        logger.warn?.('auth-gateway: request failed: %s', error?.message ?? String(error))
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' })
        else res.destroy()
      })
    })
    server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head))
    server.requestTimeout = config.requestTimeoutMs
    server.headersTimeout = Math.min(config.requestTimeoutMs, 60_000)

    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(config.port, address, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return server
  }

  return {
    async start() {
      secret = deps.secret ?? loadSecret()
      const sessionFile = stateFile('sessions.json')
      sessions = deps.sessions ?? new SessionStore({
        file: sessionFile,
        maxAgeSeconds: config.sessionMaxAgeSeconds,
        idleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
      })
      sessions.load()

      let port = config.targetPort
      if (!Number.isSafeInteger(port) || port <= 0) {
        // Desktop launches the core web server with `--port 0`, so the real port
        // only exists once the listener is bound. Read it from the live service.
        const webServer = ctx?.get?.('webServer')
        const live = webServer?.port
        if (!Number.isSafeInteger(live) || live <= 0) {
          throw new Error('auth-gateway: cannot determine the upstream dsh port; set targetPort or ensure the webServer service is active')
        }
        port = live
      }
      coreTarget = createLoopbackTarget(config.targetHost, port)
      coreSession = deps.coreSession ?? createCoreSessionBridge(ctx.get('connection'), coreTarget, {
        timeoutMs: config.upstreamTimeoutMs,
      })

      const addresses = pickAddresses()
      const listening = []
      for (const address of addresses) {
        try {
          const server = await listenOn(address)
          servers.push(server)
          boundAddresses.push(address)
          const bound = server.address()
          listening.push({ address, port: typeof bound === 'object' && bound !== null ? bound.port : config.port })
        } catch (error) {
          // Best-effort binding: one unusable interface (a Hyper-V or VPN adapter,
          // a stale address after sleep) must not take the whole gateway down.
          logger.warn?.('auth-gateway: could not bind %s: %s', address, error?.message ?? String(error))
        }
      }
      if (servers.length === 0) {
        throw new Error(`auth-gateway: no listener could bind on port ${String(config.port)} (tried ${addresses.join(', ') || 'none'})`)
      }
      return { listening }
    },

    async stop() {
      disposed = true
      for (const socket of activeSockets) socket.destroy()
      activeSockets.clear()
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))))
      servers.length = 0
      coreSession?.dispose?.()
      sessions?.dispose?.()
    },

    status() {
      return {
        listening: servers.map((server) => server.address()).filter(Boolean),
        sessions: sessions?.list?.().length ?? 0,
        authEpoch: credentials().authEpoch,
      }
    },

    routes: {
      handleRequest,
      handleUpgrade,
    },
  }
}

/** Re-exported so index.js and tests share one definition of the fence. */
export { isLoopbackAddress }
