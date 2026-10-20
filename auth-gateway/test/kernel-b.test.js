/**
 * Unit tests for the auth-gateway "kernel B" modules:
 * `lib/login-page.js`, `lib/core-session.js`, and `lib/version.js`.
 *
 * Run with: node --test auth-gateway/test/kernel-b.test.js
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import {
  loginErrorMessage,
  loginLocales,
  renderLoginPage,
  selectLoginLocale,
} from '../lib/login-page.js'
import {
  attachCoreCookie,
  createCoreSessionBridge,
  createLoopbackTarget,
  isCoreSetCookie,
  stripCoreCookies,
  stripCoreSetCookies,
  stripLaunchToken,
} from '../lib/core-session.js'
import { assertRequiredSeams, capabilities, detectVersion } from '../lib/version.js'

/** Bind a server to an ephemeral loopback port and return that port. */
async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}

/** Close a server and wait for its handles to drain. */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/**
 * Stand up a fake core that answers the launch-token exchange with the given
 * redirect target, and return a bridge wired to it.
 */
async function fakeCore(t, { status = 303, location = './', cookie = 'dsh-auth-current=v1.body.signature; Max-Age=60; Path=/; HttpOnly', requests = [] } = {}) {
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } })
    const headers = {}
    if (location !== undefined) headers.location = location
    if (cookie !== null) headers['set-cookie'] = [cookie]
    res.writeHead(status, headers)
    res.end()
  })
  const port = await listen(server)
  t.after(() => close(server))
  const target = createLoopbackTarget('127.0.0.1', port)
  const bridge = createCoreSessionBridge({
    authenticatedUrl(baseUrl) {
      return `${baseUrl}/?token=current-process-token`
    },
  }, target, { timeoutMs: 1000 })
  t.after(() => bridge.dispose())
  return { bridge, target, port, requests }
}

// ---------------------------------------------------------------------------
// createLoopbackTarget
// ---------------------------------------------------------------------------

test('createLoopbackTarget accepts 127.0.0.1 and ::1', () => {
  assert.deepEqual(createLoopbackTarget('127.0.0.1', 3080), {
    hostname: '127.0.0.1',
    port: 3080,
    authority: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
  })
  assert.deepEqual(createLoopbackTarget('[::1]', 3080), {
    hostname: '::1',
    port: 3080,
    authority: '[::1]:3080',
    origin: 'http://[::1]:3080',
  })
  assert.deepEqual(createLoopbackTarget('::1', 3080).hostname, '::1')
  assert.equal(createLoopbackTarget(' 127.0.0.1 ', 3080).hostname, '127.0.0.1')
})

test('createLoopbackTarget refuses a non-loopback destination', () => {
  // The whole point of the guard: a process launch token must never leave the host.
  assert.throws(() => createLoopbackTarget('192.168.1.1', 3080), /loopback address/u)
  assert.throws(() => createLoopbackTarget('10.0.0.5', 3080), /loopback address/u)
  assert.throws(() => createLoopbackTarget('0.0.0.0', 3080), /loopback address/u)
  assert.throws(() => createLoopbackTarget('localhost', 3080), /loopback address/u)
  assert.throws(() => createLoopbackTarget('example.com', 3080), /loopback address/u)
  assert.throws(() => createLoopbackTarget('', 3080), /loopback address/u)
  assert.throws(() => createLoopbackTarget(undefined, 3080), /loopback address/u)
  // A lookalike prefix must not slip through a naive substring check.
  assert.throws(() => createLoopbackTarget('127.0.0.1.example.com', 3080), /loopback address/u)
})

test('createLoopbackTarget refuses an invalid port', () => {
  assert.throws(() => createLoopbackTarget('127.0.0.1', 0), /port is invalid/u)
  assert.throws(() => createLoopbackTarget('127.0.0.1', 65536), /port is invalid/u)
  assert.throws(() => createLoopbackTarget('127.0.0.1', -1), /port is invalid/u)
  assert.throws(() => createLoopbackTarget('127.0.0.1', 1.5), /port is invalid/u)
  assert.throws(() => createLoopbackTarget('127.0.0.1', '3080'), /port is invalid/u)
  assert.throws(() => createLoopbackTarget('127.0.0.1', undefined), /port is invalid/u)
})

// ---------------------------------------------------------------------------
// cookie helpers
// ---------------------------------------------------------------------------

test('isCoreSetCookie recognizes only the dsh-auth- namespace', () => {
  assert.equal(isCoreSetCookie('dsh-auth-abc=value; Max-Age=30; Path=/'), true)
  assert.equal(isCoreSetCookie('dsh-auth-=value; Max-Age=30'), true)
  assert.equal(isCoreSetCookie('app=visible; Path=/'), false)
  assert.equal(isCoreSetCookie('dsh_auth_token=value; Path=/'), false)
  assert.equal(isCoreSetCookie(''), false)
})

test('stripCoreCookies removes only dsh-auth-* and preserves everything else', () => {
  assert.equal(
    stripCoreCookies('dsh-auth-old=attacker; foo=bar'),
    'foo=bar',
  )
  assert.equal(
    stripCoreCookies('foo=bar; dsh-auth-old=attacker; baz=qux'),
    'foo=bar; baz=qux',
  )
  // An unrelated cookie that merely shares a prefix-ish name survives.
  assert.equal(stripCoreCookies('dsh_auth_token=gateway'), 'dsh_auth_token=gateway')
  // Nothing left after stripping → undefined, so no empty Cookie header is sent.
  assert.equal(stripCoreCookies('dsh-auth-only=value'), undefined)
  assert.equal(stripCoreCookies(undefined), undefined)
  assert.equal(stripCoreCookies(''), undefined)
})

test('attachCoreCookie replaces public core cookies with the owned session', () => {
  assert.equal(
    attachCoreCookie('dsh-auth-old=attacker; foo=bar', { name: 'dsh-auth-current', value: 'v1.body.signature' }),
    'foo=bar; dsh-auth-current=v1.body.signature',
  )
  assert.equal(
    attachCoreCookie(undefined, { name: 'dsh-auth-current', value: 'v1.body.signature' }),
    'dsh-auth-current=v1.body.signature',
  )
  // A client-supplied core cookie must never survive alongside the owned one.
  const attached = attachCoreCookie('dsh-auth-evil=stolen', { name: 'dsh-auth-current', value: 'v1.body.signature' })
  assert.equal(attached, 'dsh-auth-current=v1.body.signature')
  assert.doesNotMatch(attached, /stolen/u)
})

test('stripCoreSetCookies filters core bearer cookies out of upstream responses', () => {
  const mixed = {
    'set-cookie': [
      'dsh-auth-current=v1.body.signature; Max-Age=30; Path=/',
      'app=visible; Path=/',
    ],
  }
  assert.equal(stripCoreSetCookies(mixed), mixed)
  assert.deepEqual(mixed['set-cookie'], ['app=visible; Path=/'])

  const onlyCore = { 'set-cookie': 'dsh-auth-current=v1.body.signature; Max-Age=30; Path=/' }
  stripCoreSetCookies(onlyCore)
  assert.equal(Object.hasOwn(onlyCore, 'set-cookie'), false)

  // A single surviving line collapses back to a scalar, not a one-element array.
  const scalarCore = { 'set-cookie': 'dsh-auth-current=v1; Max-Age=30' }
  stripCoreSetCookies(scalarCore)
  assert.equal(Object.hasOwn(scalarCore, 'set-cookie'), false)

  const scalarMixed = { 'set-cookie': 'app=visible; Path=/' }
  stripCoreSetCookies(scalarMixed)
  assert.equal(scalarMixed['set-cookie'], 'app=visible; Path=/')

  const untouched = { 'content-type': 'text/html' }
  assert.deepEqual(stripCoreSetCookies(untouched), { 'content-type': 'text/html' })
})

test('stripLaunchToken removes ?token= and preserves other query parameters', () => {
  assert.equal(stripLaunchToken('/?token=old-secret&view=chat'), '/?view=chat')
  assert.equal(stripLaunchToken('/?token=old-secret'), '/')
  assert.equal(stripLaunchToken('/?view=chat&token=old-secret'), '/?view=chat')
  assert.equal(stripLaunchToken('/?a=1&token=secret&b=2'), '/?a=1&b=2')
  // A combo URL shares one `?`, so it must survive untouched.
  const combo = '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=boot-1'
  assert.equal(stripLaunchToken(combo), combo)
  assert.equal(stripLaunchToken('/'), '/')
  assert.equal(stripLaunchToken(undefined), '/')
  // A differently-named parameter is not the launch token.
  assert.equal(stripLaunchToken('/?token_x=keep'), '/?token_x=keep')
  // The fragment survives, and only the token parameter is dropped.
  assert.equal(stripLaunchToken('/?token=secret&view=chat#section'), '/?view=chat#section')
})

// ---------------------------------------------------------------------------
// core session bridge — the version-adaptive regression
// ---------------------------------------------------------------------------

test('bridge accepts the 0.2.1 redirect target "./" (the ported fix)', async (t) => {
  const { bridge, target, requests } = await fakeCore(t, { location: './' })
  const session = await bridge.ensure()
  assert.equal(session.name, 'dsh-auth-current')
  assert.equal(session.value, 'v1.body.signature')
  assert.ok(session.expiresAt > Date.now())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/?token=current-process-token')
  assert.equal(requests[0].headers.host, target.authority)
  assert.equal(requests[0].headers.cookie, undefined)
  assert.equal(requests[0].headers.origin, undefined)
})

test('bridge accepts the 0.2.0 redirect target "/"', async (t) => {
  const { bridge, requests } = await fakeCore(t, { location: '/' })
  const session = await bridge.ensure()
  assert.equal(session.name, 'dsh-auth-current')
  assert.equal(session.value, 'v1.body.signature')
  assert.equal(requests.length, 1)
})

test('bridge rejects a redirect target that is neither "/" nor "./"', async (t) => {
  const { bridge } = await fakeCore(t, { location: '/somewhere-else' })
  await assert.rejects(bridge.ensure(), /exchange was rejected/u)
})

test('bridge collapses concurrent exchanges into one request', async (t) => {
  const { bridge, requests } = await fakeCore(t, { location: './' })
  const [first, second] = await Promise.all([bridge.ensure(), bridge.ensure()])
  assert.equal(requests.length, 1)
  assert.deepEqual(first, second)

  // A cached session is reused without touching the network again.
  await bridge.ensure()
  assert.equal(requests.length, 1)

  // invalidate() forces a fresh exchange.
  bridge.invalidate()
  await bridge.ensure()
  assert.equal(requests.length, 2)
})

test('bridge rejects a non-303 exchange and clears its pending request', async (t) => {
  const { bridge } = await fakeCore(t, { status: 200, location: undefined, cookie: null })
  await assert.rejects(bridge.ensure(), /exchange was rejected/u)
  // A rejected exchange must not wedge the bridge: the next call retries.
  await assert.rejects(bridge.ensure(), /exchange was rejected/u)
})

test('bridge rejects a 303 exchange without a usable Set-Cookie', async (t) => {
  const missing = await fakeCore(t, { location: './', cookie: null })
  await assert.rejects(missing.bridge.ensure(), /exchange was rejected/u)

  const noMaxAge = await fakeCore(t, { location: './', cookie: 'dsh-auth-current=v1.body.signature; Path=/' })
  await assert.rejects(noMaxAge.bridge.ensure(), /exchange was rejected/u)

  // A cookie outside the core namespace is not a core session.
  const wrongName = await fakeCore(t, { location: './', cookie: 'app=visible; Max-Age=60; Path=/' })
  await assert.rejects(wrongName.bridge.ensure(), /exchange was rejected/u)
})

test('bridge rejects a second Set-Cookie line and a malformed token URL', async (t) => {
  const server = createServer((_req, res) => {
    res.writeHead(303, {
      location: './',
      'set-cookie': [
        'dsh-auth-current=v1.body.signature; Max-Age=60; Path=/',
        'dsh-auth-other=v1.other.signature; Max-Age=60; Path=/',
      ],
    })
    res.end()
  })
  const port = await listen(server)
  t.after(() => close(server))
  const connection = { authenticatedUrl: (baseUrl) => `${baseUrl}/?token=current-process-token` }
  const ambiguous = createCoreSessionBridge(connection, createLoopbackTarget('127.0.0.1', port), { timeoutMs: 1000 })
  t.after(() => ambiguous.dispose())
  await assert.rejects(ambiguous.ensure(), /exchange was rejected/u)

  const target = createLoopbackTarget('127.0.0.1', port)
  const badUrls = [
    (baseUrl) => `${baseUrl}/?token=a&token=b`,          // more than one token
    (baseUrl) => `${baseUrl}/?token=a&extra=1`,          // unexpected query parameter
    (baseUrl) => `${baseUrl}/path?token=a`,              // wrong pathname
    (baseUrl) => `http://127.0.0.1:1/?token=a`,          // origin mismatch
    (baseUrl) => `${baseUrl}/?token=a#fragment`,         // fragment
    (baseUrl) => `${baseUrl}/`,
  ]
  for (const authenticatedUrl of badUrls) {
    const bridge = createCoreSessionBridge({ authenticatedUrl }, target, { timeoutMs: 1000 })
    await assert.rejects(bridge.ensure(), /authentication URL is invalid/u)
    bridge.dispose()
  }
})

test('bridge requires a usable authenticatedUrl seam and refuses use after dispose', async (t) => {
  const target = createLoopbackTarget('127.0.0.1', 1)
  assert.throws(() => createCoreSessionBridge(undefined, target), /client-connection service is required/u)
  assert.throws(() => createCoreSessionBridge({}, target), /client-connection service is required/u)

  const { bridge } = await fakeCore(t, { location: './' })
  bridge.dispose()
  await assert.rejects(bridge.ensure(), /bridge is disposed/u)
})

// ---------------------------------------------------------------------------
// login page
// ---------------------------------------------------------------------------

test('loginLocales lists Chinese and English', () => {
  assert.deepEqual([...loginLocales], ['zh', 'en'])
})

test('selectLoginLocale prefers an explicit URL language over Accept-Language', () => {
  assert.equal(selectLoginLocale({ url: '/?lang=zh', headers: { 'accept-language': 'en-US,en;q=0.9' } }), 'zh')
  assert.equal(selectLoginLocale({ url: '/?lang=zh-CN', headers: { 'accept-language': 'en-US' } }), 'zh')
  assert.equal(selectLoginLocale({ url: '/?lang=en', headers: { 'accept-language': 'zh-CN' } }), 'en')
})

test('selectLoginLocale honours weighted Accept-Language and falls back to en', () => {
  assert.equal(selectLoginLocale({ url: '/', headers: { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } }), 'zh')
  assert.equal(selectLoginLocale({ url: '/', headers: { 'accept-language': 'fr-FR, en-US;q=0.8' } }), 'en')
  assert.equal(selectLoginLocale({ url: '/', headers: { 'accept-language': 'en-US;q=0.4, zh;q=0.8' } }), 'zh')
  assert.equal(selectLoginLocale({ url: '/', headers: { 'accept-language': 'zh;q=0' } }), 'en')
  assert.equal(selectLoginLocale({ url: '/', headers: {} }), 'en')
  assert.equal(selectLoginLocale({ url: '/', headers: { 'accept-language': 'de-DE' } }), 'en')
  assert.equal(selectLoginLocale(undefined), 'en')
  assert.equal(selectLoginLocale({ url: 'not a url', headers: {} }), 'en')
})

test('renderLoginPage emits a usable English form with the expected fields', () => {
  const html = renderLoginPage({ realm: 'DeepSeek Harness Authentication', locale: 'en' })
  assert.match(html, /<html lang="en">/u)
  assert.match(html, /DeepSeek Harness Authentication/u)
  assert.match(html, /<form id="login" method="post"/u)
  assert.match(html, /action="\/api\/auth\.login\?lang=en"/u)
  assert.match(html, /id="username" name="username" type="text"/u)
  assert.match(html, /id="password" name="password" type="password"/u)
  assert.match(html, /<button type="submit">Sign in<\/button>/u)
  assert.match(html, /<div id="error" role="alert"/u)
  // TOTP is opt-in, so the default document has no code field.
  assert.doesNotMatch(html, /id="otp"/u)
})

test('renderLoginPage renders the Chinese page with the TOTP field when enabled', () => {
  const html = renderLoginPage({ realm: '网关 & 主机', twoFactorEnabled: true, locale: 'zh' })
  assert.match(html, /<html lang="zh-CN">/u)
  assert.match(html, /用户名/u)
  assert.match(html, /密码/u)
  assert.match(html, /<label for="otp">验证码<\/label>/u)
  assert.match(html, /id="otp" name="totp" type="text"[^>]*autocomplete="one-time-code"/u)
  assert.match(html, /action="\/api\/auth\.login\?lang=zh"/u)
  assert.match(html, /网关 &amp; 主机/u)
})

test('renderLoginPage escapes realm, error, and the request URL against XSS', () => {
  const attack = '<script>alert(1)</script>'
  const html = renderLoginPage({ realm: attack, error: attack, locale: 'en', rawRequestUrl: `/?x=${attack}` })
  // The raw payload must not appear as executable markup anywhere.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/u)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)

  // An attribute-breaking payload must not escape its attribute.
  const attrAttack = '" onload="alert(1)'
  const quoted = renderLoginPage({ realm: attrAttack, locale: 'en' })
  assert.doesNotMatch(quoted, / onload="alert\(1\)"/u)
  assert.match(quoted, /&quot; onload=&quot;alert\(1\)/u)

  // A payload in the request URL must not break out of the language link href.
  const hrefAttack = renderLoginPage({ locale: 'en', rawRequestUrl: '/"><script>alert(1)</script>' })
  assert.doesNotMatch(hrefAttack, /"><script>/u)
})

test('renderLoginPage survives an adversarial XSS payload sweep', () => {
  const payloads = [
    '<script>alert(1)</script>',
    '" onload="alert(1)',
    "' onfocus='alert(1)",
    '</p><script>alert(1)</script><p>',
    '</title><script>alert(1)</script>',
    '&lt;script&gt;',
    'javascript:alert(1)',
    '<img src=x onerror=alert(1)>',
    '<!--<script>alert(1)</script>-->',
  ]
  // The document legitimately contains one <script> block of its own, so a
  // payload is proven inert by comparing against a payload-free baseline
  // rather than by searching for tags the template itself emits.
  const baseline = renderLoginPage({ realm: 'Safe realm', error: 'Safe error', locale: 'en', twoFactorEnabled: true, rawRequestUrl: '/?q=safe' })
  const count = (text, pattern) => (text.match(pattern) ?? []).length

  for (const payload of payloads) {
    const html = renderLoginPage({
      realm: payload,
      error: payload,
      locale: 'en',
      twoFactorEnabled: true,
      rawRequestUrl: `/?q=${encodeURIComponent(payload)}`,
    })
    const where = `payload ${JSON.stringify(payload)}`

    // 1. No extra elements beyond the baseline.
    assert.equal(count(html, /<script>/gu), count(baseline, /<script>/gu), `${where}: injected a script element`)
    assert.equal(count(html, /<\/script>/gu), count(baseline, /<\/script>/gu), `${where}: injected a script terminator`)
    // A handler only becomes live when a RAW quote closes the preceding
    // attribute. Counting the bare substring ` onload=` is not a valid
    // invariant: correct escaping rewrites the payload to `&quot; onload=`,
    // which still contains that substring as inert text. Assert on the raw
    // quote forms instead.
    assert.doesNotMatch(html, /" onload=/u, `${where}: live onload attribute`)
    assert.doesNotMatch(html, /' onload=/u, `${where}: live onload attribute`)
    assert.doesNotMatch(html, /" onfocus=/u, `${where}: live onfocus attribute`)
    assert.doesNotMatch(html, /' onfocus=/u, `${where}: live onfocus attribute`)
    // `onerror` rides on a new element, so the tag-opener count below is the
    // controlling invariant; a quoted spelling would additionally break out of
    // an attribute.
    assert.doesNotMatch(html, /" onerror=/u, `${where}: live onerror attribute`)
    assert.doesNotMatch(html, /' onerror=/u, `${where}: live onerror attribute`)
    assert.equal(count(html, /<img /gu), 0, `${where}: injected an img element`)
    // 2. The same number of raw `<` characters — escaping rewrites each payload
    //    `<` into `&lt;`, so a payload can never introduce a new tag opener.
    assert.equal(count(html, /</gu), count(baseline, /</gu), `${where}: changed the tag count`)
    // 3. Where the payload landed, it is escaped text, not markup.
    if (payload.startsWith('<script>')) assert.match(html, /&lt;script&gt;/u, `${where}: payload was not escaped`)
    if (payload === '" onload="alert(1)') assert.match(html, /&quot; onload=&quot;/u, `${where}: attribute payload was not escaped`)
  }
})

test('renderLoginPage preserves unrelated query parameters in the language links', () => {
  const html = renderLoginPage({ realm: 'Auth', locale: 'zh', rawRequestUrl: '/?dsh_mode=mobile' })
  assert.match(html, /href="\/\?dsh_mode=mobile&amp;lang=zh"/u)
  assert.match(html, /href="\/\?dsh_mode=mobile&amp;lang=en"/u)
})

test('renderLoginPage falls back to English for an unsupported locale', () => {
  const html = renderLoginPage({ realm: 'Auth', locale: 'de' })
  assert.match(html, /<html lang="en">/u)
  assert.match(html, /<label for="username">Username<\/label>/u)
})

test('loginErrorMessage localizes and falls back to the key', () => {
  assert.equal(loginErrorMessage('zh', 'invalid'), '用户名、密码或验证码无效')
  assert.equal(loginErrorMessage('en', 'rateLimited'), 'Too many login attempts')
  assert.equal(loginErrorMessage('de', 'rateLimited'), 'Too many login attempts')
  assert.equal(loginErrorMessage('en', 'no-such-key'), 'no-such-key')
})

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

test('detectVersion never throws and always reports unknown on an empty context', () => {
  const detected = detectVersion(undefined)
  assert.equal(typeof detected.raw, 'string')
  assert.equal(typeof detected.major, 'number')
  assert.equal(typeof detected.minor, 'number')
  assert.equal(typeof detected.patch, 'number')
  assert.ok(['npm', 'desktop', 'unknown'].includes(detected.flavor))
  // Either a real version was resolvable in this checkout, or it is "unknown" —
  // both are valid, but a throw is not.
  assert.ok(detected.raw === 'unknown' || /^\d+\.\d+\.\d+/u.test(detected.raw))
})

test('detectVersion survives a hostile context', () => {
  const hostile = {
    get() {
      throw new Error('no such service')
    },
  }
  assert.doesNotThrow(() => detectVersion(hostile))
  assert.equal(detectVersion(hostile).raw, 'unknown')
})

test('capabilities reports the seams of the running core', () => {
  // Neither 0.2.0-rc.2 nor 0.2.1-rc.2 exposes settings.register().
  const withoutSettings = { get: () => undefined }
  assert.equal(capabilities(withoutSettings).hasSettingsRegister, false)
  assert.equal(capabilities(withoutSettings).supportsTapIndex, false)
  assert.equal(capabilities(withoutSettings).supportsAuthenticatedUrl, false)
  assert.ok(['/', './'].includes(capabilities(withoutSettings).coreIndexRedirect))

  // A settings service without register() must still report false.
  const settingsShim = { get: (name) => (name === 'settings' ? { forms: {} } : undefined) }
  assert.equal(capabilities(settingsShim).hasSettingsRegister, false)

  const full = {
    get: (name) => {
      if (name === 'settings') return { register() {} }
      if (name === 'webServer') return { tapIndex() {} }
      if (name === 'connection') return { authenticatedUrl: () => '' }
      return undefined
    },
  }
  assert.deepEqual(capabilities(full), {
    hasSettingsRegister: true,
    coreIndexRedirect: './',
    supportsTapIndex: true,
    supportsAuthenticatedUrl: true,
  })

  // The documented 0.2.1 shape: connection + webServer present, settings register absent.
  const shipped = {
    get: (name) => {
      if (name === 'webServer') return { tapIndex() {} }
      if (name === 'connection') return { authenticatedUrl: () => '' }
      return undefined
    },
  }
  assert.deepEqual(capabilities(shipped), {
    hasSettingsRegister: false,
    coreIndexRedirect: './',
    supportsTapIndex: true,
    supportsAuthenticatedUrl: true,
  })
})

test('assertRequiredSeams throws a readable error on an empty context', () => {
  assert.throws(() => assertRequiredSeams(undefined), /client-connection service is unavailable/u)
  assert.throws(() => assertRequiredSeams({}), /client-connection service is unavailable/u)
  assert.throws(() => assertRequiredSeams({ get: () => undefined }), /auth-gateway:/u)
  // The message must name the release baseline so an operator can act on it.
  assert.throws(() => assertRequiredSeams({ get: () => undefined }), /0\.2\.0-rc\.2/u)
})

test('assertRequiredSeams rejects a connection without authenticatedUrl', () => {
  const incomplete = { get: (name) => (name === 'connection' ? {} : undefined) }
  assert.throws(() => assertRequiredSeams(incomplete), /does not expose `authenticatedUrl/u)
})

test('assertRequiredSeams accepts a complete connection seam', () => {
  const complete = { get: (name) => (name === 'connection' ? { authenticatedUrl: () => '' } : undefined) }
  assert.doesNotThrow(() => assertRequiredSeams(complete))
})
