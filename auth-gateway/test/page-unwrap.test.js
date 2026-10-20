/**
 * Pins the exact defect that produced "(unknown)" on the settings page.
 *
 * The client has ONE unwrap step (`call()`), which returns either
 *   { ok: true,  result: <payload> }        on success
 *   { ok: false, code, message }            on failure
 *
 * An earlier version added a second unwrap (`explain()`) that re-checked
 * `result.ok` on an already-unwrapped PAYLOAD. Payloads have no `ok` field, so
 * every success was reported as a failure with `code: undefined` — rendered to
 * the user as "save failed (unknown)".
 *
 * This test reproduces the real pipeline (Host route -> core parser -> call() ->
 * applyResponse()) and asserts the page receives the payload on success.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-unwrap-'))
process.env.DSH_HOME = HOME

const { createSettingsRpc, RPC_PATH, RPC_VERSION } = await import('../lib/settings-rpc.js')

const ENDPOINT = 'auth-gateway'

/** Verbatim from dsh-client-connection `client.browser.js`. */
function parseConnectionResponse(value) {
  const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
  if (!isRecord(value) || value.type !== 'server-response' || typeof value.rpcId !== 'string') {
    throw new TypeError('connection: invalid server-response envelope')
  }
  const result = value.result
  if (!isRecord(result)) throw new TypeError('connection: invalid server-response result')
  if (result.ok === true) return { rpcId: value.rpcId, result: { ok: true, value: result.value } }
  if (result.ok !== false || !isRecord(result.error)) throw new TypeError('invalid result')
  const e = result.error
  if (typeof e.code !== 'string' || typeof e.message !== 'string' || !isRecord(e.details)) {
    throw new TypeError('invalid failure')
  }
  return { rpcId: value.rpcId, result: { ok: false, error: { code: e.code, message: e.message, details: e.details } } }
}

/** Verbatim from client.js `createRpc().call()`. */
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

/** Verbatim from client.js `applyResponse()`: success returns the payload. */
function applyResponse(response) {
  if (response?.ok === true) return response.result
  return { __error: true, code: response?.code, message: response?.message }
}

const values = {
  enabled: false, port: 3080, targetHost: '127.0.0.1', targetPort: 0,
  addresses: [], username: 'admin', password: '', realm: 'R',
  allowedHosts: [], allowedOrigins: [], sessionMaxAgeSeconds: 86400,
  sessionIdleTimeoutSeconds: 43200, upstreamTimeoutMs: 30000, requestTimeoutMs: 120000,
}

let route
let updates = []

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
          update: async (ns, patch) => { updates.push({ ns, patch }) },
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

after(() => { rmSync(HOME, { recursive: true, force: true }) })

async function rpcCall(op, extra = {}) {
  const rpcId = `r-${op}`
  const response = await route.fetch(new Request('http://h/api/auth-gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId, method: ENDPOINT, payload: { v: RPC_VERSION, op, ...extra },
    }),
  }))
  assert.equal(response.status, 200)
  const full = parseConnectionResponse(await response.json())
  assert.equal(full.rpcId, rpcId)
  return full.result
}

describe('the page receives payloads, not double-wrapped results', () => {
  it('status reaches the page as a payload with enabled/running', async () => {
    const page = applyResponse(clientCall(await rpcCall('status'), 'status'))
    assert.equal(page.__error, undefined, `page must not report an error (got ${String(page.code)})`)
    assert.equal(page.enabled, false)
    assert.equal(page.running, false)
    assert.equal(typeof page.port, 'number')
  })

  it('save reaches the page as a payload and reaches settings.update', async () => {
    updates = []
    const page = applyResponse(clientCall(await rpcCall('save', { values: { enabled: true } }), 'save'))
    assert.equal(page.__error, undefined, `page must not report an error (got ${String(page.code)})`)
    assert.equal(page.enabled, true)
    assert.equal(updates.length, 1)
    assert.equal(updates[0].ns, 'include:dsh-auth-gateway')
    assert.deepEqual(updates[0].patch, { enabled: true })
  })

  it('diagnose reaches the page with the resolved namespace', async () => {
    const page = applyResponse(clientCall(await rpcCall('diagnose'), 'diagnose'))
    assert.equal(page.__error, undefined)
    assert.equal(page.namespace, 'include:dsh-auth-gateway')
    assert.equal(page.hasUpdate, true)
  })

  it('a genuine failure still surfaces its code', async () => {
    const page = applyResponse(clientCall(await rpcCall('nonsense'), 'nonsense'))
    assert.equal(page.__error, true)
    assert.equal(page.code, 'bad_request')
    assert.notEqual(page.code, undefined, 'a failure must never lose its code')
  })

  it('pins the old bug: a payload has no `ok` field', async () => {
    // The removed `explain()` re-read `result.ok`. It was always undefined.
    const carrier = await rpcCall('status')
    const call = clientCall(carrier, 'status')
    assert.equal(call.ok, true)
    assert.equal(call.result.ok, undefined, 'payloads carry no `ok` — this was the bug')
  })
})
