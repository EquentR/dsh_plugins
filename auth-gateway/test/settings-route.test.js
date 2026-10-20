/**
 * Integration test for the shared `/api` settings route.
 *
 * Regression for the reported defect: with `enabled: false` the settings page
 * showed "unavailable", because the page called the gateway's OWN listener —
 * which does not exist while the gateway is off.
 *
 * The fix is that the page talks to the Host over the core's shared `/api`
 * route. This test drives that route through a fake `connection.fetch`
 * registry, exactly as Cordis would, and asserts it answers while stopped.
 *
 * Wire shape (two layers, both load-bearing):
 *   { type:'server-response', rpcId,
 *     result: { ok:true, value: { v, op, result: <plugin payload> } } }
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-route-'))
process.env.DSH_HOME = HOME

const { createSettingsRpc, RPC_PATH, RPC_VERSION, RPC_ENDPOINT } = await import('../lib/settings-rpc.js')

/** Capture the route Cordis would have registered. */
function fakeConnection() {
  const routes = new Map()
  return {
    routes,
    fetch: {
      register(route) {
        if (routes.has(route.path)) throw new Error(`duplicate ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    authenticatedUrl: (base) => `${base}/?token=t`,
  }
}

/** Build the client request envelope the real page sends. */
function envelope(op, payload = {}) {
  return {
    type: 'client-request',
    rpcId: `rpc-${op}`,
    method: RPC_ENDPOINT,
    payload: { v: RPC_VERSION, op, ...payload },
  }
}

function post(body) {
  return new Request('http://127.0.0.1/api/auth-gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

let connection
let dispose
let statusCalls

before(() => {
  connection = fakeConnection()
  statusCalls = 0
  const values = { enabled: false, port: 3080, username: 'admin', realm: 'R' }
  const ctx = {
    fiber: {},
    connection,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    get(name) {
      if (name === 'connection') return connection
      if (name === 'settings') {
        return {
          writable: true,
          async update() {},
          describe: () => [{ ns: 'include:dsh-auth-gateway', revision: 1, value: {} }],
        }
      }
      if (name === 'configEditor') {
        return { entries: () => [{ fiber: ctx.fiber, options: { id: 'include:dsh-auth-gateway' } }] }
      }
      return undefined
    },
    effect(factory) {
      return factory()
    },
  }
  const rpc = createSettingsRpc(ctx, {
    liveConfig: () => values,
    status: () => {
      statusCalls += 1
      return { running: false, error: null, listening: [], version: { raw: 'n/a', flavor: 'n/a' } }
    },
    reconcile: () => {},
  })
  dispose = rpc.dispose
})

after(() => {
  dispose?.()
  rmSync(HOME, { recursive: true, force: true })
})

/** Read the plugin payload out of the core-normalized reply. */
function payloadOf(body) {
  assert.equal(body.type, 'server-response')
  assert.equal(body.result.ok, true, 'outer result must be ok')
  const envelopeValue = body.result.value
  assert.equal(envelopeValue.v, RPC_VERSION)
  return envelopeValue.result
}

describe('the settings route is published on the core /api channel', () => {
  it('registers exactly one POST route at the contract path', () => {
    assert.equal(RPC_PATH, '/api/auth-gateway')
    const route = connection.routes.get(RPC_PATH)
    assert.ok(route !== undefined, 'route must be registered')
    assert.deepEqual(route.methods, ['POST'])
    assert.equal(route.requestBody, 'buffered')
  })

  it('answers `status` while the gateway is STOPPED', async () => {
    // The defect: this response used to be unreachable, so the UI said
    // "unavailable" instead of rendering a switch.
    const route = connection.routes.get(RPC_PATH)
    const response = await route.fetch(post(envelope('status')))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.rpcId, 'rpc-status')
    const payload = payloadOf(body)
    assert.equal(payload.enabled, false)
    assert.equal(payload.running, false)
    assert.equal(statusCalls, 1)
  })

  it('round-trips a switch-on save', async () => {
    const route = connection.routes.get(RPC_PATH)
    const response = await route.fetch(post(envelope('save', { values: { enabled: true } })))
    const payload = payloadOf(await response.json())
    assert.equal(payload.enabled, true)
  })

  it('refuses a non-JSON content type', async () => {
    const route = connection.routes.get(RPC_PATH)
    const request = new Request('http://127.0.0.1/api/auth-gateway', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    const response = await route.fetch(request)
    assert.equal(response.status, 415)
  })

  it('rejects a malformed envelope without throwing', async () => {
    const route = connection.routes.get(RPC_PATH)
    const response = await route.fetch(post({ type: 'wrong', rpcId: 'x' }))
    const body = await response.json()
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'bad_request')
    assert.deepEqual(body.result.error.details, {})
  })

  it('rejects a wrong protocol version', async () => {
    const route = connection.routes.get(RPC_PATH)
    const response = await route.fetch(post({ ...envelope('status'), payload: { v: 99, op: 'status' } }))
    const body = await response.json()
    assert.equal(body.result.ok, false)
    assert.equal(body.result.error.code, 'protocol_error')
  })

  it('unregisters the route on dispose', () => {
    dispose()
    assert.equal(connection.routes.has(RPC_PATH), false)
  })
})
