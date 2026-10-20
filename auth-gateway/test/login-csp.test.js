/**
 * End-to-end login test through the real gateway listener.
 *
 * Pins the reported defect: the login page's own `fetch` was blocked by
 *   "default-src 'none'" with no `connect-src`,
 * so the page rendered fine but sign-in could never complete.
 *
 * This starts an actual gateway over a fake core, then asserts:
 *   * the login page response advertises connect-src 'self'
 *   * POST /api/auth.login succeeds with the configured credentials
 *   * a wrong password is rejected with a coded failure
 *   * the issued session cookie is HttpOnly and authenticates a subsequent GET
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-csp-'))
process.env.DSH_HOME = HOME

const { createGateway } = await import('../lib/gateway.js')

const LAUNCH_TOKEN = 'csp-test-token'
const USER = 'csp-user'
const PASSWORD = 'correct-password'

/** Minimal dsh core: token exchange + authenticated passthrough. */
function startFakeCore() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') === LAUNCH_TOKEN && url.pathname === '/') {
        res.writeHead(303, {
          location: './',
          'set-cookie': 'dsh-auth-fake=coresecret; Max-Age=2592000; Path=/; HttpOnly',
        })
        res.end()
        return
      }
      if (!String(req.headers.cookie ?? '').includes('dsh-auth-fake=coresecret')) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><title>DeepSeek Harness</title>core</html>')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

let core
let gateway
let base
let cookies = []

before(async () => {
  core = await startFakeCore()
  const ctx = {
    connection: { authenticatedUrl: (b) => `${b}/?token=${LAUNCH_TOKEN}` },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'connection') return this.connection
      if (name === 'webServer') return { port: core.port }
      return undefined
    },
    effect: (f) => f(),
  }
  gateway = createGateway(ctx, {
    enabled: true,
    port: 0,
    targetHost: '127.0.0.1',
    targetPort: core.port,
    addresses: ['127.0.0.1'],
    username: USER,
    password: PASSWORD,
    realm: 'CSP Test',
    allowedHosts: [],
    allowedOrigins: [],
    sessionMaxAgeSeconds: 3600,
    sessionIdleTimeoutSeconds: 1800,
    upstreamTimeoutMs: 5000,
    requestTimeoutMs: 15000,
  })
  const started = await gateway.start()
  base = `http://127.0.0.1:${String(started.listening[0].port)}`
})

after(async () => {
  await gateway?.stop()
  await new Promise((resolve) => core?.server.close(resolve))
  rmSync(HOME, { recursive: true, force: true })
})

function absorb(response) {
  for (const entry of response.headers.getSetCookie?.() ?? []) cookies.push(entry.split(';')[0])
}

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) }
  if (cookies.length > 0) headers.cookie = cookies.join('; ')
  const response = await fetch(`${base}${path}`, { ...options, headers, redirect: 'manual' })
  absorb(response)
  return response
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('the login page can actually reach its own API', () => {
  it('advertises connect-src self so fetch is not blocked', async () => {
    const response = await call('/', { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200)
    const csp = response.headers.get('content-security-policy')
    assert.ok(csp !== null, 'a CSP header must be present')
    // The defect: this directive was missing, so default-src 'none' blocked fetch.
    assert.match(csp, /connect-src 'self'/, `CSP must allow same-origin fetch: ${csp}`)
    // Keep the rest locked down.
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /base-uri 'none'/)
  })

  it('the login form posts to the same-origin API path', async () => {
    const response = await call('/', { headers: { accept: 'text/html' } })
    const html = await response.text()
    assert.match(html, /action="\/api\/auth\.login/)
    assert.match(html, /fetch\(/)
  })
})

describe('sign-in works end to end', () => {
  it('rejects a wrong password with a coded failure', async () => {
    const response = await call('/api/auth.login', json({ username: USER, password: 'wrong' }))
    assert.equal(response.status, 401)
    const body = await response.json()
    assert.equal(body.ok, false)
    assert.equal(typeof body.error, 'string')
  })

  it('accepts the configured credentials and issues cookies', async () => {
    cookies = []
    const response = await call('/api/auth.login', json({ username: USER, password: PASSWORD }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    const setCookie = response.headers.getSetCookie().join(' ')
    assert.match(setCookie, /dsh_gw_session=/)
    assert.match(setCookie, /HttpOnly/)
    assert.match(setCookie, /SameSite=Strict/)
  })

  it('the issued session authenticates a proxied request', async () => {
    const response = await call('/', { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /DeepSeek Harness/)
  })
})
