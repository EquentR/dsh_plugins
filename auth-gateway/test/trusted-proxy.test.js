/**
 * Trusted-proxy behaviour: `X-Forwarded-For` and `X-Forwarded-Proto`.
 *
 * Why this matters: dsh107 sits behind a TLS-terminating reverse proxy. Two
 * things break without trusting that proxy:
 *
 *   1. Every proxied visitor shares the proxy's address, so ONE attacker
 *      exhausts the login rate-limit bucket and locks out everyone.
 *   2. The proxy→gateway hop is plain HTTP, so the request looks insecure and
 *      the session cookie silently loses `Secure`.
 *
 * And two things break if we trust the headers too broadly:
 *
 *   3. Any caller could forge its own bucket, defeating the limiter.
 *   4. Any caller could claim HTTPS, obtaining a `__Host-` cookie over plain
 *      HTTP that the browser would then reject.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-proxy-'))
process.env.DSH_HOME = HOME

const { createGateway } = await import('../lib/gateway.js')

const TOKEN = 'proxy-test-token'
const USER = 'proxy-user'
const PASSWORD = 'proxy-password'

function startFakeCore() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') === TOKEN && url.pathname === '/') {
        res.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-fake=core; Max-Age=2592000; Path=/; HttpOnly' })
        res.end()
        return
      }
      if (!String(req.headers.cookie ?? '').includes('dsh-auth-fake=core')) {
        res.writeHead(401)
        res.end('no')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<title>DeepSeek Harness</title>ok')
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/** Start a gateway on loopback with an optional trusted-proxy list. */
async function startGateway(corePort, trustedProxyAddresses) {
  const ctx = {
    connection: { authenticatedUrl: (b) => `${b}/?token=${TOKEN}` },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'connection') return this.connection
      if (name === 'webServer') return { port: corePort }
      return undefined
    },
    effect: (f) => f(),
  }
  const gateway = createGateway(ctx, {
    enabled: true,
    port: 0,
    targetHost: '127.0.0.1',
    targetPort: corePort,
    addresses: ['127.0.0.1'],
    username: USER,
    password: PASSWORD,
    realm: 'Proxy Test',
    allowedHosts: [],
    allowedOrigins: [],
    trustedProxyAddresses,
    sessionMaxAgeSeconds: 3600,
    sessionIdleTimeoutSeconds: 1800,
    upstreamTimeoutMs: 5000,
    requestTimeoutMs: 15000,
  })
  const started = await gateway.start()
  return { gateway, base: `http://127.0.0.1:${String(started.listening[0].port)}` }
}

let core
let trusting
let notTrusting

before(async () => {
  core = await startFakeCore()
  // The test client connects FROM 127.0.0.1, so that is the peer address.
  trusting = await startGateway(core.port, ['127.0.0.1'])
  notTrusting = await startGateway(core.port, [])
})

after(async () => {
  await trusting?.gateway.stop()
  await notTrusting?.gateway.stop()
  await new Promise((resolve) => core?.server.close(resolve))
  rmSync(HOME, { recursive: true, force: true })
})

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('with no trusted proxy configured', () => {
  it('ignores X-Forwarded-Proto, so the cookie stays non-Secure', async () => {
    const response = await fetch(`${notTrusting.base}/api/auth.login`, {
      ...json({ username: USER, password: PASSWORD }),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
    })
    assert.equal(response.status, 200)
    const setCookie = response.headers.getSetCookie().join(' ')
    // A `__Host-` cookie over plain HTTP is rejected by browsers, so the name
    // must NOT switch to the secure variant without real TLS or a trusted proxy.
    assert.ok(!setCookie.includes('__Host-'), `must not emit a __Host- cookie: ${setCookie}`)
    assert.ok(!/;\s*Secure/u.test(setCookie), `must not set Secure without TLS: ${setCookie}`)
  })
})

describe('with the proxy trusted', () => {
  it('honours X-Forwarded-Proto: https and issues a Secure __Host- cookie', async () => {
    const response = await fetch(`${trusting.base}/api/auth.login`, {
      ...json({ username: USER, password: PASSWORD }),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
      },
    })
    assert.equal(response.status, 200)
    const setCookie = response.headers.getSetCookie().join(' ')
    assert.match(setCookie, /__Host-dsh_gw_session=/)
    assert.match(setCookie, /Secure/)
    assert.match(setCookie, /HttpOnly/)
  })

  it('the Secure cookie authenticates a later request', async () => {
    const login = await fetch(`${trusting.base}/api/auth.login`, {
      ...json({ username: USER, password: PASSWORD }),
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    })
    const cookies = login.headers.getSetCookie().map((entry) => entry.split(';')[0]).join('; ')
    const page = await fetch(`${trusting.base}/`, {
      headers: { cookie: cookies, accept: 'text/html', 'x-forwarded-proto': 'https' },
    })
    assert.equal(page.status, 200)
    assert.match(await page.text(), /DeepSeek Harness/)
  })

  it('keys the rate limiter on the forwarded client, not the proxy', async () => {
    // A burst from one forwarded address must exhaust that address's bucket.
    let limited = false
    for (let index = 0; index < 14; index += 1) {
      const response = await fetch(`${trusting.base}/api/auth.login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-proto': 'https',
          'x-forwarded-for': '203.0.113.9',
        },
        body: JSON.stringify({ username: USER, password: 'wrong' }),
      })
      if (response.status === 429) { limited = true; break }
    }
    assert.ok(limited, 'repeated failures from one forwarded client must be rate limited')

    // A DIFFERENT forwarded client must still be able to sign in — this is the
    // lockout bug that trusting the proxy fixes.
    const other = await fetch(`${trusting.base}/api/auth.login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '203.0.113.200',
      },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    })
    assert.equal(other.status, 200, 'an unrelated client must not be locked out')
  })

  it('ignores a malformed X-Forwarded-For instead of trusting it', async () => {
    const response = await fetch(`${trusting.base}/api/auth.login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': 'not-an-address',
      },
      body: JSON.stringify({ username: USER, password: PASSWORD }),
    })
    // Falls back to the socket peer; the request still succeeds.
    assert.equal(response.status, 200)
  })
})
