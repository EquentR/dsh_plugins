/**
 * Transport helpers for @dsh-plugins/network-proxy.
 *
 * The Host applies one outbound proxy policy to Node's global fetch dispatcher
 * (undici). Loopback traffic and the configured no-proxy list stay direct so
 * the Harness Web UI, local services, and test servers keep working.
 */

/** Reached by the settings page's "test" action; a failure never proves the proxy is broken. */
export const PROXY_TEST_URL = 'https://www.baidu.com/'

const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1', '[::1]']
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const LOOPBACK_IPV4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`)
const HOST_FORBIDDEN = /[\s/?#@\\]/u
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u

/** The two proxy protocols the settings page exposes. */
export function normalizeMode(value) {
  if (value === 'http' || value === 'socks5') return value
  throw new TypeError('mode must be "http" or "socks5"')
}

/** Port shown when a mode has no explicit port yet. */
export function defaultPort(mode) {
  return mode === 'socks5' ? 1080 : 8080
}

/** Validate and trim a host. A scheme, path, credentials, or whitespace is refused. */
export function normalizeHost(value) {
  if (typeof value !== 'string') throw new TypeError('host must be a string')
  const host = value.trim()
  if (host === '') throw new TypeError('host is required')
  if (host.length > 253) throw new RangeError('host is too long')
  if (HOST_FORBIDDEN.test(host)) throw new TypeError('host must not contain spaces, slashes, @, ? or #')
  if (host.includes('://')) throw new TypeError('host must not include a scheme')
  return host
}

/** Accept a JSON number or a decimal string, and bound it to one TCP port. */
export function normalizePort(value) {
  const port = typeof value === 'string' && /^\d+$/u.test(value.trim()) ? Number(value.trim()) : value
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new RangeError('port must be an integer from 1 through 65535')
  }
  return port
}

/** Trim a username and reject control characters. */
export function normalizeUsername(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError('username must be a string')
  const username = value.trim()
  if (username.length > 255) throw new RangeError('username is too long')
  if (CONTROL_CHARS.test(username)) throw new TypeError('username must not contain control characters')
  return username
}

/** Keep a password byte-for-byte; only control characters and an unreasonable length are refused. */
export function normalizePassword(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError('password must be a string')
  if (value.length > 4096) throw new RangeError('password is too long')
  if (value.includes('\u0000')) throw new TypeError('password must not contain NUL')
  return value
}

/** Validate the optional bypass list. Matching happens in shouldBypass(). */
export function normalizeNoProxy(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new TypeError('noProxy must be a string')
  const noProxy = value.trim()
  if (noProxy.length > 4096) throw new RangeError('noProxy is too long')
  if (CONTROL_CHARS.test(noProxy)) throw new TypeError('noProxy must not contain control characters')
  return noProxy
}

/**
 * Merge a request's fields over the current values and validate the result.
 *
 * HTTP mode accepts a username and password. SOCKS5 clears both: Chromium
 * cannot carry SOCKS5 credentials, so the setting deliberately never offers
 * them and a later Chromium integration stays possible.
 */
export function normalizeValues(input, current = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('values must be an object')
  }
  const mode = input.mode === undefined ? normalizeMode(current.mode) : normalizeMode(input.mode)
  const values = {
    enabled: input.enabled === undefined ? current.enabled === true : input.enabled === true,
    mode,
    host: input.host === undefined ? normalizeHost(current.host ?? '') : normalizeHost(input.host),
    port: input.port === undefined ? normalizePort(current.port ?? defaultPort(mode)) : normalizePort(input.port),
    username: input.username === undefined ? normalizeUsername(current.username ?? '') : normalizeUsername(input.username),
    password: input.password === undefined ? normalizePassword(current.password ?? '') : normalizePassword(input.password),
    noProxy: input.noProxy === undefined ? normalizeNoProxy(current.noProxy ?? '') : normalizeNoProxy(input.noProxy),
  }
  if (mode === 'socks5' || values.username === '') {
    values.username = ''
    values.password = ''
  }
  return values
}

/** Throws when an enabled policy cannot be installed. */
export function validateForApply(values) {
  if (!values.enabled) return
  normalizeHost(values.host)
  normalizePort(values.port)
  normalizeMode(values.mode)
}

/** Wrap an IPv6 literal so it can appear in a proxy URL. */
export function formatHost(host) {
  if (host.startsWith('[') && host.endsWith(']')) return host
  return host.includes(':') ? `[${host}]` : host
}

/** The proxy URL handed to undici. HTTP credentials live in the URL's userinfo. */
export function proxyUrlFor(values) {
  const host = formatHost(values.host)
  if (values.mode === 'socks5') return `socks5://${host}:${values.port}`
  const auth = values.username === ''
    ? ''
    : `${encodeURIComponent(values.username)}:${encodeURIComponent(values.password)}@`
  return `http://${auth}${host}:${values.port}`
}

/** A user-facing summary that never contains the password. */
export function displayProxy(values) {
  const host = formatHost(values.host)
  if (values.mode === 'socks5') return `socks5://${host}:${values.port}`
  const auth = values.username === '' ? '' : `${encodeURIComponent(values.username)}:***@`
  return `http://${auth}${host}:${values.port}`
}

function splitHostPort(entry) {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']')
    if (close !== -1) {
      const rest = entry.slice(close + 1)
      const host = entry.slice(1, close)
      return rest.startsWith(':') ? { host, port: rest.slice(1) } : { host }
    }
  }
  const colon = entry.indexOf(':')
  if (colon !== -1 && entry.indexOf(':', colon + 1) === -1) {
    return { host: entry.slice(0, colon), port: entry.slice(colon + 1) }
  }
  return { host: entry }
}

/** Whether a host names this machine and therefore must never be sent to a proxy. */
export function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  const mappedHigh = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/u.exec(host)?.[1]
  if (mappedHigh !== undefined) return Number.parseInt(mappedHigh, 16) >>> 8 === 127
  const bare = host.startsWith('::ffff:') ? host.slice(7) : host
  return LOOPBACK_IPV4.test(bare)
}

/** Whether this URL bypasses the proxy through loopback or the configured list. */
export function shouldBypass(url, noProxy = '') {
  if (isLoopbackHost(url.hostname)) return true
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase()
  const port = url.port !== '' ? url.port : url.protocol === 'https:' ? '443' : '80'
  for (const raw of noProxy.split(/[,\s]+/u)) {
    const entry = raw.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const split = splitHostPort(entry)
    if (split.port !== undefined && split.port !== port) continue
    const candidate = split.host.replace(/^\*?\./u, '').replace(/\.$/u, '')
    if (candidate === '') continue
    if (host === candidate || host.endsWith(`.${candidate}`)) return true
  }
  return false
}

/** Build a dispatcher that tunnels non-bypassed origins and pins local ones direct. */
export function createDispatcher(undici, values) {
  const proxyUrl = proxyUrlFor(values)
  const noProxy = values.noProxy
  return new undici.Agent({
    factory(origin, options) {
      const url = origin instanceof URL ? origin : new URL(origin.toString())
      if (shouldBypass(url, noProxy)) return new undici.Pool(url.origin, options)
      if (values.mode === 'socks5') return new undici.Socks5ProxyAgent(proxyUrl, options)
      return new undici.ProxyAgent({ ...options, uri: proxyUrl })
    },
  })
}

/** Import the runtime's undici copy; the global dispatcher slot is shared with Node's fetch. */
export async function loadUndici() {
  try {
    return await import('undici')
  } catch (error) {
    throw new Error(`undici is unavailable: ${safeErrorMessage(error)}`)
  }
}

/** Install the policy and return the disposer that restores the previous dispatcher. */
export async function applyProxy(values) {
  const undici = await loadUndici()
  const dispatcher = createDispatcher(undici, values)
  const previous = undici.getGlobalDispatcher()
  undici.setGlobalDispatcher(dispatcher)
  return {
    dispatcher,
    async dispose() {
      if (undici.getGlobalDispatcher() === dispatcher) undici.setGlobalDispatcher(previous)
      await dispatcher.close().catch(() => {})
    },
  }
}

/** Try one request through a policy without installing it. */
export async function testProxy(values, { url = PROXY_TEST_URL, timeoutMs = 8000 } = {}) {
  const undici = await loadUndici()
  const dispatcher = createDispatcher(undici, values)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await undici.fetch(url, {
      dispatcher,
      signal: controller.signal,
      redirect: 'manual',
    })
    if (response.body !== null) await response.body.cancel().catch(() => {})
    return {
      ok: true,
      status: response.status,
      latencyMs: Date.now() - started,
      target: url,
    }
  } catch (error) {
    const code = error?.name === 'AbortError' ? 'timeout' : 'failed'
    return {
      ok: false,
      code,
      message: safeErrorMessage(error),
      target: url,
    }
  } finally {
    clearTimeout(timer)
    await dispatcher.close().catch(() => {})
  }
}

/** Keep credentials out of logs, settings pages, and RPC replies. */
export function safeErrorMessage(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const code = typeof error?.code === 'string' ? ` (${error.code})` : ''
  return `${raw.replace(/\/\/[^/@\s]+@/gu, '//***@')}${code}`.slice(0, 300)
}

export { LOOPBACK_NO_PROXY }
