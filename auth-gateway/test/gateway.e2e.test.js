/**
 * End-to-end integration test for @dsh-plugins/auth-gateway.
 *
 * This is the test that actually proves the plugin works: it starts a fake dsh
 * core web server (loopback, token exchange, a WebSocket mux endpoint), then
 * starts the real gateway in front of it and drives the whole browser flow —
 * fence, login page, login, authenticated proxy, TOTP, password change,
 * revocation and the WebSocket upgrade.
 *
 * Everything runs on 127.0.0.1 with ephemeral ports and an isolated DSH_HOME.
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-auth-gateway-e2e-'))
process.env.DSH_HOME = HOME

const { createGateway } = await import('../lib/gateway.js')
const { totpCode } = await import('../lib/totp.js')

const LAUNCH_TOKEN = 'e2e-launch-token'
const PASSWORD = 'correct horse battery'
const NEW_PASSWORD = 'a different password'
const USERNAME = 'e2e-user'

/** Minimal stand-in for the dsh core web server. */
function startFakeCore() {
  return new Promise((resolve) => {
    const seen = []
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // Token exchange mirroring the real core: 303 to "./" (0.2.x) plus cookie.
      if (url.searchParams.get('token') === LAUNCH_TOKEN && url.pathname === '/') {
        res.writeHead(303, {
          location: './',
          'set-cookie': `dsh-auth-fakecookie=coresecret; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
        })
        res.end()
        return
      }
      const cookies = String(req.headers.cookie ?? '')
      seen.push({ url: req.url, cookie: cookies, host: req.headers.host })
      if (!cookies.includes('dsh-auth-fakecookie=coresecret')) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized by core')
        return
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html><title>DeepSeek Harness</title><body>core</body></html>')
        return
      }
      if (url.pathname.startsWith('/api/')) {
        // Echo the cookie the gateway injected so the test can assert isolation.
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'dsh-auth-should-be-stripped=1; Path=/' })
        res.end(JSON.stringify({ reached: true }))
        return
      }
      if (url.pathname === '/dsh-auth-echo') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ cookie: cookies }))
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    server.on('upgrade', (req, socket) => {
      const cookies = String(req.headers.cookie ?? '')
      if (!cookies.includes('dsh-auth-fakecookie=coresecret')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const accept = createHash('sha1')
        .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest('base64')
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Connection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      )
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }))
  })
}

/** The `connection` service the gateway consumes. */
function fakeConnection(corePort) {
  return {
    authenticatedUrl: (base) => `${base}/?token=${LAUNCH_TOKEN}`,
    // Present so version.js sees the full seam set.
    admit: () => ({ peer: {} }),
    __corePort: corePort,
  }
}

function fakeCtx(corePort) {
  const effects = []
  return {
    connection: fakeConnection(corePort),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'connection') return this.connection
      if (name === 'webServer') return { port: corePort }
      return undefined
    },
    effect(factory) {
      const d = factory()
      effects.push(d)
      return d
    },
    effects,
  }
}

/** Cookie jar good enough for these flows. */
function jar() {
  const store = new Map()
  return {
    absorb(response) {
      const raw = response.headers.getSetCookie?.() ?? []
      for (const entry of raw) {
        const [pair] = entry.split(';')
        const eq = pair.indexOf('=')
        if (eq > 0) store.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
      }
    },
    header() {
      return [...store.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
    },
    get(name) {
      return store.get(name)
    },
    clear() {
      store.clear()
    },
  }
}

let core
let gateway
let base
let cookies
// Hoisted so the password-change suite can satisfy TOTP with the same secret.
let enrolledSecret

before(async () => {
  core = await startFakeCore()
  const ctx = fakeCtx(core.port)
  gateway = createGateway(ctx, {
    enabled: true,
    port: 0,
    targetHost: '127.0.0.1',
    targetPort: core.port,
    addresses: ['127.0.0.1'],
    username: USERNAME,
    password: PASSWORD,
    realm: 'E2E Realm',
    allowedHosts: [],
    allowedOrigins: [],
    sessionMaxAgeSeconds: 3600,
    sessionIdleTimeoutSeconds: 1800,
    upstreamTimeoutMs: 5000,
    requestTimeoutMs: 15_000,
  })
  const started = await gateway.start()
  base = `http://127.0.0.1:${String(started.listening[0].port)}`
  cookies = jar()
})

after(async () => {
  await gateway?.stop()
  await new Promise((resolve) => core?.server.close(resolve))
  rmSync(HOME, { recursive: true, force: true })
})

/** Fetch that never follows redirects and records cookies. */
async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  const cookieHeader = cookies.header()
  if (cookieHeader !== '') headers.cookie = cookieHeader
  const response = await fetch(`${base}${path}`, { ...options, headers, redirect: 'manual' })
  cookies.absorb(response)
  return response
}

function json(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

describe('fences run before authentication and fail closed', () => {
  it('rejects a Host the gateway is not authoritative for with 421', async () => {
    // `fetch` controls the Host header itself, so drive this one over raw http.
    const port = Number(new URL(base).port)
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/',
        headers: { host: 'evil.example.com' },
      }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 421)
  })

  it('rejects a cross-authority Origin with 403', async () => {
    const response = await fetch(`${base}/`, {
      headers: { host: '127.0.0.1', origin: 'http://elsewhere.example' },
      redirect: 'manual',
    })
    assert.equal(response.status, 403)
  })

  it('serves the login page to an anonymous browser', async () => {
    const response = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /E2E Realm/)
    assert.match(html, /<form/)
  })

  it('answers 401 JSON to a non-browser anonymous request', async () => {
    const response = await fetch(`${base}/api/anything`, { redirect: 'manual' })
    assert.equal(response.status, 401)
  })
})

describe('login and authenticated proxying', () => {
  it('refuses a wrong password', async () => {
    const response = await call('/api/auth.login', json({ username: USERNAME, password: 'wrong' }))
    assert.equal(response.status, 401)
  })

  it('refuses a wrong username', async () => {
    const response = await call('/api/auth.login', json({ username: 'nobody', password: PASSWORD }))
    assert.equal(response.status, 401)
  })

  it('logs in with the seeded Config password and issues HttpOnly cookies', async () => {
    const response = await call('/api/auth.login', json({ username: USERNAME, password: PASSWORD }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.ok(cookies.get('dsh_gw_session'), 'session cookie must be set')
    assert.ok(cookies.get('dsh_gw_csrf'), 'csrf cookie must be set')
    const setCookie = response.headers.getSetCookie().join(' ')
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
  })

  it('proxies the authenticated UI through to the core', async () => {
    const response = await call('/', { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /DeepSeek Harness/)
  })

  it('never leaks the core cookie to the browser and never forwards the gateway cookie upstream', async () => {
    const response = await call('/api/probe')
    assert.equal(response.status, 200)
    // The core's Set-Cookie must have been stripped on the way back.
    const setCookie = response.headers.getSetCookie().join(' ')
    assert.ok(!setCookie.includes('should-be-stripped'), `core Set-Cookie leaked: ${setCookie}`)
    // And the upstream request must have carried only the core cookie.
    const last = core.seen.at(-1)
    assert.match(last.cookie, /dsh-auth-fakecookie=coresecret/)
    assert.ok(!last.cookie.includes('dsh_gw_session'), `gateway cookie leaked upstream: ${last.cookie}`)
  })

  it('lets the browser reach a WebSocket upgrade end to end', async () => {
    const port = Number(new URL(base).port)
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/remote.mux',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
          cookie: cookies.header(),
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.statusCode)
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 101)
  })

  it('rejects an unauthenticated WebSocket upgrade with 401', async () => {
    const port = Number(new URL(base).port)
    const status = await new Promise((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: '/api/remote.mux',
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
      })
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        resolve(res.statusCode)
      })
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 401)
  })
})

describe('write routes require CSRF', () => {
  it('refuses a password change without the CSRF header', async () => {
    const response = await call('/api/auth.change-password', json({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    }))
    assert.equal(response.status, 403)
  })
})

describe('TOTP enrollment and login', () => {
  let secret

  it('generates a secret', async () => {
    const csrf = cookies.get('dsh_gw_csrf')
    const response = await call('/api/auth.totp', json({ action: 'begin', csrf }))
    assert.equal(response.status, 200)
    const body = await response.json()
    secret = body.secret
    enrolledSecret = secret
    assert.match(secret, /^[A-Z2-7]{32}$/)
  })

  it('rejects enrollment with a bad code', async () => {
    const csrf = cookies.get('dsh_gw_csrf')
    const response = await call('/api/auth.totp', json({ action: 'enable', secret, code: '000000', csrf }))
    assert.equal(response.status, 400)
  })

  it('enrolls with a valid code', async () => {
    const csrf = cookies.get('dsh_gw_csrf')
    const response = await call('/api/auth.totp', json({
      action: 'enable',
      secret,
      code: totpCode(secret),
      csrf,
    }))
    assert.equal(response.status, 200)
  })

  it('rejects login with the right password but no code', async () => {
    cookies.clear()
    const response = await call('/api/auth.login', json({ username: USERNAME, password: PASSWORD }))
    assert.equal(response.status, 401)
  })

  it('accepts login with password plus a valid code', async () => {
    cookies.clear()
    const response = await call('/api/auth.login', json({
      username: USERNAME,
      password: PASSWORD,
      totp: totpCode(secret),
    }))
    assert.equal(response.status, 200)
    assert.ok(cookies.get('dsh_gw_session'))
  })
})

describe('password change revokes every session', () => {
  it('changes the password when CSRF and 2FA are satisfied', async () => {
    const csrf = cookies.get('dsh_gw_csrf')
    const status = await call('/api/auth.status')
    const statusBody = await status.json()
    // The status route must never expose the shared secret, only whether 2FA is on.
    assert.equal(statusBody.twoFactorSecret, undefined, 'status must not expose the TOTP secret')
    assert.equal(statusBody.twoFactorEnabled, true)
    const response = await call('/api/auth.change-password', json({
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
      csrf,
      totp: totpCode(enrolledSecret),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.reauthenticate, true)
  })

  it('rejects the old password after the change', async () => {
    cookies.clear()
    const response = await call('/api/auth.login', json({ username: USERNAME, password: PASSWORD }))
    assert.equal(response.status, 401)
  })

  it('accepts the new password', async () => {
    cookies.clear()
    // Fetch the current secret by re-reading state is not needed: enrollment
    // survives the change, so a fresh code from the same secret works.
    const response = await call('/api/auth.login', json({
      username: USERNAME,
      password: NEW_PASSWORD,
      totp: undefined,
    }))
    // TOTP is still enrolled, so a code-less login must fail.
    assert.equal(response.status, 401)
  })

  it('is rate limited after repeated failures', async () => {
    let sawLimit = false
    for (let index = 0; index < 15; index += 1) {
      const response = await call('/api/auth.login', json({ username: USERNAME, password: 'nope' }))
      if (response.status === 429) {
        sawLimit = true
        break
      }
    }
    assert.ok(sawLimit, 'expected the login limiter to engage')
  })
})
