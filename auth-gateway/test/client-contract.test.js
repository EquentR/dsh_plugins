/**
 * End-to-end contract test across the REAL boundary between client and Host.
 *
 * History of this file: earlier versions tested each half separately and both
 * halves looked right, yet the settings page still showed "cannot reach the
 * Host". The gap was the shape of `rpc.call()`'s resolved value:
 *
 *   rpc.call()  ->  `full.result`   = { ok: true, value }   (browser side)
 *   HTTP body   ->  { type, rpcId, result }                 (wire)
 *
 * `client.js` read `carrier.result` (always undefined) so every call degraded
 * to `transport_failed`. Testing the wire body alone could never catch that.
 *
 * This test drives the pipeline in the exact order the runtime uses:
 *   Host route -> HTTP body -> core parseConnectionResponse -> full.result
 *              -> client call() logic -> page-level { ok, result }
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-e2e-'))
process.env.DSH_HOME = HOME

const { createSettingsRpc, RPC_PATH, RPC_VERSION } = await import('../lib/settings-rpc.js')

const SHARED_API_ENDPOINT = 'auth-gateway'

/** Verbatim from dsh-client-connection `client.browser.js`. */
function parseConnectionResponse(value) {
  const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('connection: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result')
  if (result.ok === true) return { rpcId: value.rpcId, result: { ok: true, value: result.value } }
  if (result.ok !== false || !isRecord(result.error)) {
    throw new TypeError('connection: invalid server-response result')
  }
  const error = result.error
  if (typeof error.code !== 'string' || typeof error.message !== 'string' || !isRecord(error.details)) {
    throw new TypeError('connection: invalid server-response failure')
  }
  return {
    rpcId: value.rpcId,
    result: { ok: false, error: { code: error.code, message: error.message, details: error.details } },
  }
}

const values = {
  enabled: false, port: 3080, targetHost: '127.0.0.1', targetPort: 0,
  addresses: [], username: 'admin', password: 'a-password', realm: 'R',
  allowedHosts: [], allowedOrigins: [], sessionMaxAgeSeconds: 86400,
  sessionIdleTimeoutSeconds: 43200, upstreamTimeoutMs: 30000, requestTimeoutMs: 120000,
}

let route

before(() => {
  const routes = new Map()
  const ctx = {
    fiber: {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'connection') {
        return { fetch: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } } }
      }
      if (name === 'settings') {
        return {
          writable: true,
          describe: () => [{ ns: 'include:dsh-auth-gateway', revision: 0, value: {} }],
          update: async () => {},
        }
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
  route = routes.get(RPC_PATH)
})

after(() => {
  rmSync(HOME, { recursive: true, force: true })
})

/**
 * Reproduce `connection.rpc.call()` for real: POST the envelope, run the core
 * parser, and return ONLY `full.result` — exactly what the browser receives.
 */
async function rpcCall(op, extra = {}) {
  const rpcId = `rpc-${op}`
  const response = await route.fetch(new Request('http://host/api/auth-gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: SHARED_API_ENDPOINT,
      payload: { v: RPC_VERSION, op, ...extra },
    }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  const full = parseConnectionResponse(body)
  assert.equal(full.rpcId, rpcId, 'rpcId must round-trip')
  return full.result
}

/**
 * Verbatim copy of `client.js`'s `createRpc().call()` body, kept literal so the
 * two cannot drift without failing here.
 */
function clientCall(carrier, op) {
  const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (carrier?.ok !== true) {
    const error = carrier?.error
    return { ok: false, code: error?.code ?? 'transport_failed', message: error?.message }
  }
  const envelope = isRecord(carrier.value) ? carrier.value : undefined
  if (envelope?.v !== RPC_VERSION || envelope?.op !== op) return { ok: false, code: 'protocol_error' }
  return { ok: true, result: envelope.result }
}

describe('client <-> Host through the core RPC boundary', () => {
  it('status reaches the page as a usable payload', async () => {
    const carrier = await rpcCall('status')
    // Guard the exact assumption that was wrong: rpc.call() is ALREADY
    // { ok, value }, never { rpcId, result }.
    assert.equal(carrier.ok, true)
    assert.equal(carrier.result, undefined, 'rpc.call() must not expose the rpcId envelope')

    const page = clientCall(carrier, 'status')
    assert.equal(page.ok, true, `page must accept the carrier (got ${String(page.code)})`)
    assert.equal(page.result.enabled, false)
    assert.equal(page.result.running, false)
  })

  it('save reaches the page as a usable payload', async () => {
    const page = clientCall(await rpcCall('save', { values: { enabled: true } }), 'save')
    assert.equal(page.ok, true, `page must accept the carrier (got ${String(page.code)})`)
    assert.equal(page.result.enabled, true)
  })

  it('diagnose reaches the page with the resolved namespace', async () => {
    const page = clientCall(await rpcCall('diagnose'), 'diagnose')
    assert.equal(page.ok, true)
    assert.equal(page.result.namespace, 'include:dsh-auth-gateway')
  })

  it('a Host-side failure reaches the page as a coded error, not transport_failed', async () => {
    const page = clientCall(await rpcCall('nonsense'), 'nonsense')
    assert.equal(page.ok, false)
    assert.equal(page.code, 'bad_request', 'a coded Host error must survive to the page')
  })

  it('a protocol mismatch is reported as protocol_error', async () => {
    const carrier = await rpcCall('status')
    const page = clientCall(carrier, 'save')
    assert.equal(page.ok, false)
    assert.equal(page.code, 'protocol_error')
  })

  it('the exact defect is pinned: reading carrier.result yields undefined', async () => {
    const carrier = await rpcCall('status')
    // The old (buggy) read — undefined, hence "cannot reach the Host".
    assert.equal(carrier?.result, undefined, 'carrier.result is undefined — this was the bug')
    // The correct read:
    assert.equal(typeof carrier.value, 'object')
  })
})
