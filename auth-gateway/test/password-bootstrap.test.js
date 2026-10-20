/**
 * Password bootstrap and change flows.
 *
 * Defect this pins: the settings page always routed through `changePassword`,
 * which verifies the CURRENT password first. On a fresh install there is no
 * credential record, so `currentPlainPassword()` returned undefined and the
 * compare always failed — "current password is incorrect [change_failed]".
 * First-time setup could therefore never complete from the UI.
 *
 * Correct behaviour:
 *   * no record yet  -> create one from the new password, ignore "current"
 *   * record exists  -> verify the current password, then rotate it
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-pw-'))
process.env.DSH_HOME = HOME
delete process.env.AUTH_PASS
delete process.env.DSH_AUTH_PASS

const { createSettingsRpc, RPC_PATH, RPC_VERSION } = await import('../lib/settings-rpc.js')
const { readCredentials, verifyPassword } = await import('../lib/credentials.js')

const ENDPOINT = 'auth-gateway'

function parseConnectionResponse(value) {
  const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('invalid envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('invalid result')
  if (result.ok === true) return { rpcId: value.rpcId, result: { ok: true, value: result.value } }
  if (result.ok !== false || !isRecord(result.error)) throw new TypeError('invalid result')
  const e = result.error
  if (typeof e.code !== 'string' || typeof e.message !== 'string' || !isRecord(e.details)) {
    throw new TypeError('invalid failure')
  }
  return { rpcId: value.rpcId, result: { ok: false, error: { code: e.code, message: e.message, details: e.details } } }
}

/** One route per test, sharing the real state directory. */
function makeRoute(values) {
  const routes = new Map()
  const ctx = {
    fiber: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'connection') {
        return { fetch: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } } }
      }
      if (name === 'settings') {
        return { writable: true, describe: () => [], update: async () => {} }
      }
      if (name === 'configEditor') {
        return { entries: () => [{ fiber: ctx.fiber, options: { id: 'include:dsh-auth-gateway' } }] }
      }
      return undefined
    },
    on: () => () => {},
    effect: (f) => f(),
  }
  createSettingsRpc(ctx, {
    liveConfig: () => values,
    status: () => ({ running: false, error: null, listening: [], version: { raw: 'x', flavor: 'y' } }),
    reconcile: async () => {},
  })
  return routes.get(RPC_PATH)
}

const baseValues = {
  enabled: false, port: 3080, targetHost: '127.0.0.1', targetPort: 0,
  addresses: [], username: 'admin', password: '', realm: 'R',
  allowedHosts: [], allowedOrigins: [], sessionMaxAgeSeconds: 86400,
  sessionIdleTimeoutSeconds: 43200, upstreamTimeoutMs: 30000, requestTimeoutMs: 120000,
}

async function call(route, op, extra = {}) {
  const response = await route.fetch(new Request('http://h/api/auth-gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: `r-${op}`, method: ENDPOINT, payload: { v: RPC_VERSION, op, ...extra },
    }),
  }))
  assert.equal(response.status, 200)
  return parseConnectionResponse(await response.json()).result
}

let route

beforeEach(() => {
  // Start every case from "no credentials on disk".
  const file = join(HOME, 'plugins', 'dsh-auth-gateway', 'credentials.json')
  if (existsSync(file)) rmSync(file, { force: true })
  route = makeRoute(baseValues)
})

after(() => {
  rmSync(HOME, { recursive: true, force: true })
})

describe('first-time password setup', () => {
  it('creates the record with no current password at all', async () => {
    // This is the reported defect: it used to fail with
    // "current password is incorrect [change_failed]".
    const result = await call(route, 'changePassword', { currentPassword: '', newPassword: 'first-password' })
    assert.equal(result.ok, true, `setup must succeed (got ${JSON.stringify(result.error)})`)
    // `ok(value)` wraps the payload once; the envelope layer adds { v, op }.
    assert.equal(result.value.result.hasPassword, true)

    const record = readCredentials()
    assert.ok(record !== undefined, 'a credential record must now exist')
    assert.equal(verifyPassword('first-password', record), true)
    assert.equal(record.authEpoch, 1)
    // Never store the plaintext.
    assert.ok(!JSON.stringify(record).includes('first-password'))
  })

  it('accepts the `setPassword` alias from the page', async () => {
    const result = await call(route, 'setPassword', { newPassword: 'another-password' })
    assert.equal(result.ok, true)
    assert.equal(verifyPassword('another-password', readCredentials()), true)
  })

  it('still enforces the minimum length', async () => {
    const result = await call(route, 'changePassword', { currentPassword: '', newPassword: 'short' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'password_too_short')
    assert.equal(readCredentials(), undefined, 'nothing may be written for a rejected password')
  })
})

describe('changing an existing password', () => {
  it('requires the correct current password', async () => {
    await call(route, 'changePassword', { newPassword: 'initial-password' })

    const wrong = await call(route, 'changePassword', {
      currentPassword: 'not-the-password',
      newPassword: 'next-password',
    })
    assert.equal(wrong.ok, false)
    assert.equal(wrong.error.code, 'invalid_credentials')
    assert.equal(verifyPassword('initial-password', readCredentials()), true, 'the old password must survive')

    const right = await call(route, 'changePassword', {
      currentPassword: 'initial-password',
      newPassword: 'next-password',
    })
    assert.equal(right.ok, true)
    const record = readCredentials()
    assert.equal(verifyPassword('next-password', record), true)
    assert.equal(verifyPassword('initial-password', record), false)
    // A rotation must invalidate every existing session.
    assert.ok(record.authEpoch >= 2)
  })
})

describe('config-seeded password', () => {
  it('uses the Config password when no record exists yet', async () => {
    const configured = makeRoute({ ...baseValues, password: 'from-config' })
    // No record yet: a "change" is really a bootstrap, so it must still succeed.
    const result = await call(configured, 'changePassword', { newPassword: 'ui-password' })
    assert.equal(result.ok, true)
    assert.equal(verifyPassword('ui-password', readCredentials()), true)
  })
})
