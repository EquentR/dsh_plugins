/**
 * Remote host-settings access.
 *
 * Defect this addresses: on a plain npm deployment reached over the LAN the
 * Models page fails with "settings are unavailable in this browser", because
 * `dsh-client-ui-settings` resolves
 *
 *   persistence = ctx.remote.$host.isLoopback ? "host" : "memory"
 *
 * and a non-loopback page gets `memory`, which never talks to the Host. The
 * desktop shell avoids it by injecting `__DSH_TRANSPORT__.ownsHost = true`.
 *
 * The gateway therefore rewrites ONLY the authenticated HTML document to claim
 * the same flag. These tests pin both what it rewrites and what it must not.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const {
  HOST_SETTINGS_SCRIPT,
  TRANSPORT_GLOBAL,
  injectOwnsHost,
  isEncoded,
  isHtmlDocument,
  planHtmlRewrite,
} = await import('../lib/host-settings.js')

/** Evaluate the injected script in an isolated fake global. */
function runScript(existing) {
  const scope = {}
  if (existing !== undefined) scope[TRANSPORT_GLOBAL] = existing
  // eslint-disable-next-line no-new-func
  new Function('globalThis', HOST_SETTINGS_SCRIPT)(scope)
  return scope[TRANSPORT_GLOBAL]
}

describe('the injected carrier script', () => {
  it('sets ownsHost when no transport exists', () => {
    const transport = runScript(undefined)
    assert.equal(transport.ownsHost, true)
  })

  it('preserves an existing streamBaseUrl and custom carrier', () => {
    const transport = runScript({ streamBaseUrl: 'http://127.0.0.1:3080', ownsHost: false, extra: 1 })
    assert.equal(transport.ownsHost, true)
    assert.equal(transport.streamBaseUrl, 'http://127.0.0.1:3080')
    assert.equal(transport.extra, 1)
  })

  it('is idempotent', () => {
    const once = runScript({ streamBaseUrl: 'x' })
    const twice = runScript({ ...once })
    assert.deepEqual(twice, once)
  })

  it('does not overwrite a transport that already owns the host', () => {
    const transport = runScript({ ownsHost: true, streamBaseUrl: 'y' })
    assert.equal(transport.streamBaseUrl, 'y')
  })
})

describe('injectOwnsHost', () => {
  it('inserts the script immediately after <head>', () => {
    const html = '<html><head><title>x</title></head><body></body></html>'
    const out = injectOwnsHost(html)
    const at = out.indexOf('</script>')
    const headAt = out.indexOf('<head>')
    const titleAt = out.indexOf('<title>')
    assert.ok(at > headAt && at < titleAt, 'script must run before any other head content')
    assert.match(out, /ownsHost = true/u)
  })

  it('handles a <head> tag with attributes', () => {
    const out = injectOwnsHost('<html><head data-x="1"><meta charset="utf-8"></head></html>')
    assert.match(out, /<head data-x="1"><script>/u)
  })

  it('leaves a document without <head> untouched', () => {
    const html = '<html><body>no head</body></html>'
    assert.equal(injectOwnsHost(html), html)
  })

  it('does not corrupt markup containing a literal script tag in text', () => {
    const html = '<html><head></head><body>&lt;script&gt;</body></html>'
    const out = injectOwnsHost(html)
    assert.ok(out.includes('&lt;script&gt;'), 'body text must be preserved verbatim')
  })
})

describe('response classification', () => {
  it('detects HTML content type regardless of charset or casing', () => {
    assert.equal(isHtmlDocument({ 'content-type': 'text/html; charset=utf-8' }), true)
    assert.equal(isHtmlDocument({ 'content-type': 'TEXT/HTML' }), true)
    assert.equal(isHtmlDocument({ 'content-type': ['text/html'] }), true)
  })

  it('rejects everything that is not HTML', () => {
    assert.equal(isHtmlDocument({ 'content-type': 'application/json' }), false)
    assert.equal(isHtmlDocument({ 'content-type': 'application/javascript' }), false)
    assert.equal(isHtmlDocument({}), false)
  })

  it('detects compressed bodies so they are never spliced', () => {
    assert.equal(isEncoded({ 'content-encoding': 'gzip' }), true)
    assert.equal(isEncoded({ 'content-encoding': 'br' }), true)
    assert.equal(isEncoded({ 'content-encoding': 'identity' }), false)
    assert.equal(isEncoded({}), false)
  })
})

describe('planHtmlRewrite', () => {
  const html = '<html><head></head><body></body></html>'
  const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' }

  it('rewrites an authenticated HTML document', () => {
    const plan = planHtmlRewrite({ statusCode: 200, headers: htmlHeaders, body: html, enabled: true })
    assert.equal(plan.rewrite, true)
    assert.match(plan.body, /ownsHost = true/u)
  })

  it('does nothing when the operator disabled remote settings', () => {
    const plan = planHtmlRewrite({ statusCode: 200, headers: htmlHeaders, body: html, enabled: false })
    assert.equal(plan.rewrite, false)
  })

  it('never rewrites non-200 responses', () => {
    for (const statusCode of [301, 401, 403, 404, 500]) {
      const plan = planHtmlRewrite({ statusCode, headers: htmlHeaders, body: html, enabled: true })
      assert.equal(plan.rewrite, false, `status ${String(statusCode)} must pass through`)
    }
  })

  it('never rewrites JSON, assets or plugin bundles', () => {
    for (const contentType of ['application/json', 'application/javascript', 'text/css', 'image/svg+xml']) {
      const plan = planHtmlRewrite({
        statusCode: 200,
        headers: { 'content-type': contentType },
        body: html,
        enabled: true,
      })
      assert.equal(plan.rewrite, false, `${contentType} must pass through`)
    }
  })

  it('never rewrites a compressed body', () => {
    const plan = planHtmlRewrite({
      statusCode: 200,
      headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
      body: html,
      enabled: true,
    })
    assert.equal(plan.rewrite, false)
  })

  it('reports no rewrite when the document has no <head>', () => {
    const plan = planHtmlRewrite({
      statusCode: 200,
      headers: htmlHeaders,
      body: '<p>fragment</p>',
      enabled: true,
    })
    assert.equal(plan.rewrite, false)
  })
})
