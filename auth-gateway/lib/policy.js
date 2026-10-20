/**
 * Host and Origin fences for the auth gateway.
 *
 * Ported unchanged (semantics included) from
 * `@yiln-dsh/dsh-plugin-auth-webserver@0.7.6` `lib/policy.js`. Pure functions,
 * zero dependencies, no I/O — every rule below is a security decision, so
 * edits here need a test that proves the fence still fails closed.
 *
 * Contract (CONTRACT.md 3.3):
 *   - a Host that matches nothing must yield `hostMatches() === false`, which
 *     the gateway turns into 421 Misdirected Request;
 *   - an Origin must agree with the request Host, so a cross-site form post
 *     cannot borrow an allowlisted origin.
 */

/**
 * Parse a bare `host[:port]` authority.
 *
 * `strict` additionally requires the canonical spelling (lowercase hostname,
 * default port omitted), which is right for operator-supplied config and wrong
 * for request headers.
 */
function parseAuthority(value, label, strict) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || /\s/u.test(value)) {
    throw new Error(`auth-gateway: ${label} must be a bare host[:port] authority`)
  }

  let http
  let https
  try {
    http = new URL(`http://${value}`)
    https = new URL(`https://${value}`)
  } catch {
    throw new Error(`auth-gateway: ${label} is not a valid host[:port] authority`)
  }
  if (http.username !== '' || http.password !== '' || http.pathname !== '/' || http.search !== '' || http.hash !== '') {
    throw new Error(`auth-gateway: ${label} must be a bare host[:port] authority`)
  }

  const hostname = http.hostname.toLowerCase()
  const port = http.port || https.port
  const canonical = port === '' ? hostname : `${hostname}:${port}`
  if (strict && value.toLowerCase() !== canonical) {
    throw new Error(`auth-gateway: ${label} must use canonical host[:port] spelling`)
  }
  return { hostname, port, host: canonical }
}

/** Parse and validate one configured Host authority. */
export function parseAllowedHost(value, index = 0) {
  return parseAuthority(value, `allowedHosts[${String(index)}]`, true)
}

/** Parse and validate one request `Host` header; `undefined` when malformed. */
export function parseRequestHost(value) {
  try {
    return parseAuthority(value, 'request Host', false)
  } catch {
    return undefined
  }
}

/** Parse one allowed browser Origin and derive the Host authority it permits. */
export function parseAllowedOriginHost(value, index = 0) {
  const origin = parseOrigin(value, `allowedOrigins[${String(index)}]`, false)
  return parseAuthority(origin.host, `allowedOrigins[${String(index)}]`, true)
}

/**
 * Whether a request Host matches one configured authority.
 *
 * An allowed entry without a port accepts any request port; an entry with a
 * port must match the request's port (or the scheme default). This is the 421
 * decision: `false` means the request was addressed to a name this gateway does
 * not answer for.
 */
export function hostMatches(requestHost, allowedHosts, secure = false) {
  const request = parseRequestHost(requestHost)
  if (request === undefined) return false
  const requestPort = request.port || (secure ? '443' : '80')
  return allowedHosts.some((allowed) => allowed.port === ''
    ? allowed.hostname === request.hostname
    : allowed.hostname === request.hostname && allowed.port === requestPort)
}

function parseOrigin(value, label, strict) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || /[\r\n]/u.test(value)) {
    throw new Error(`auth-gateway: ${label} must be an absolute http(s) origin`)
  }
  let origin
  try {
    origin = new URL(value)
  } catch {
    throw new Error(`auth-gateway: ${label} must be an absolute http(s) origin`)
  }
  if ((origin.protocol !== 'http:' && origin.protocol !== 'https:')
    || origin.username !== ''
    || origin.password !== ''
    || origin.pathname !== '/'
    || origin.search !== ''
    || origin.hash !== '') {
    throw new Error(`auth-gateway: ${label} must be an absolute http(s) origin`)
  }
  if (strict && origin.origin !== value.replace(/\/$/u, '')) {
    throw new Error(`auth-gateway: ${label} must be a canonical origin`)
  }
  return origin
}

/** Parse and normalize one configured browser Origin. */
export function parseAllowedOrigin(value, index = 0) {
  return parseOrigin(value, `allowedOrigins[${String(index)}]`, false).origin
}

/**
 * Whether an `Origin` header is acceptable for this request Host.
 *
 * A missing Origin is allowed (same-origin navigations and non-browser clients
 * omit it); the Host fence still applies to those. When an allowlist is
 * configured the Origin must be in it *and* agree with the request Host.
 */
export function originMatches(originValue, requestHost, allowedOrigins) {
  if (originValue === undefined) return true
  let origin
  try {
    origin = parseOrigin(originValue, 'request Origin', false)
  } catch {
    return false
  }
  if (allowedOrigins.length > 0 && !allowedOrigins.includes(origin.origin)) return false
  const request = parseRequestHost(requestHost)
  if (request === undefined) return false
  if (request.host === origin.host) return true
  if (request.port === '') return false
  const defaultPort = origin.protocol === 'https:' ? '443' : '80'
  return request.hostname === origin.hostname && request.port === (origin.port || defaultPort)
}

/** Parse a comma-separated environment list, preserving an absent value. */
export function parseList(value) {
  if (value === undefined) return undefined
  const entries = String(value).split(',').map((entry) => entry.trim()).filter(Boolean)
  return entries
}
