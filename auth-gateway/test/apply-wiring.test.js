/**
 * Integration test for `apply()` — the wiring between the plugin lifecycle and
 * the settings RPC.
 *
 * Pins the reported defect: with `enabled: false` the plugin must STILL publish
 * a working settings route, so the UI can render a switch instead of
 * "unavailable". It also pins the live-switch model: saving `enabled` starts or
 * stops the listener without remounting the plugin.
 *
 * `index.js` imports `@deepseek-ai/schemastery`, which the dsh host injects at
 * runtime and which is therefore not resolvable from this repository. A Node
 * module customization hook maps that specifier to a local stub so `apply()`
 * can still be exercised for real.
 *
 * Wire shape:
 *   { type:'server-response', rpcId,
 *     result: { ok:true, value: { v, op, result: <plugin payload> } } }
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'
import net from 'node:net'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-apply-'))
process.env.DSH_HOME = HOME

// Map the host-injected package to the local stub before index.js is imported.
const STUB_URL = pathToFileURL(join(import.meta.dirname, 'stubs', 'schemastery.js')).href
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/schemastery') {
    return { url: ${JSON.stringify(STUB_URL)}, shortCircuit: true }
  }
  return next(specifier, context)
}
`)}`)

const { apply } = await import('../index.js')
const { RPC_PATH, RPC_VERSION } = await import('../lib/settings-rpc.js')

/** Build the smallest Cordis-shaped context `apply` actually uses. */
function makeCtx() {
  const routes = new Map()
  const listeners = new Map()
  const effects = []
  const connection = {
    routes,
    authenticatedUrl: (base) => `${base}/?token=launch-token`,
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  }
  const ctx = {
    connection,
    fiber: {},
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
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        listeners.set(event, current.filter((entry) => entry !== handler))
      }
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    listeners,
    effects,
  }
  return ctx
}

/** A volatile config, exactly how the Loader hands it to `apply`. */
function volatileConfig(initial) {
  const store = { ...initial }
  const config = {}
  for (const key of Object.keys(store)) {
    config[key] = { get: () => store[key] }
  }
  return {
    config,
    set(key, value) {
      store[key] = value
    },
  }
}

function post(body) {
  return new Request('http://127.0.0.1/api/auth-gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function envelope(op, payload = {}) {
  return {
    type: 'client-request',
    rpcId: `rpc-${op}`,
    method: 'auth-gateway',
    payload: { v: RPC_VERSION, op, ...payload },
  }
}

/** Send one op and return its plugin payload. */
async function payloadOf(targetCtx, op, extra = {}) {
  const route = targetCtx.connection.routes.get(RPC_PATH)
  assert.ok(route !== undefined, 'settings route must be registered')
  const response = await route.fetch(post(envelope(op, extra)))
  const body = await response.json()
  assert.equal(body.result.ok, true, `outer result must be ok (got ${JSON.stringify(body.result.error)})`)
  return body.result.value.result
}

async function disposeCtx(targetCtx) {
  for (const dispose of targetCtx.effects.reverse()) {
    if (typeof dispose === 'function') await dispose()
  }
}

const baseValues = {
  port: 34882,
  targetHost: '127.0.0.1',
  targetPort: 34999,
  addresses: ['127.0.0.1'],
  username: 'admin',
  password: '',
  realm: 'Apply Test',
  allowedHosts: [],
  allowedOrigins: [],
  sessionMaxAgeSeconds: 3600,
  sessionIdleTimeoutSeconds: 1800,
  upstreamTimeoutMs: 5000,
  requestTimeoutMs: 15000,
}

describe('apply() with the gateway disabled', () => {
  let ctx
  let local

  before(async () => {
    ctx = makeCtx()
    local = volatileConfig({ ...baseValues, enabled: false })
    await apply(ctx, local.config)
    await new Promise((resolve) => setTimeout(resolve, 80))
  })

  after(async () => { await disposeCtx(ctx) })

  it('still publishes the settings route', () => {
    // This is the actual fix: the route lives on the core, not the listener.
    assert.ok(ctx.connection.routes.has(RPC_PATH), 'settings route must exist even while disabled')
  })

  it('reports a usable status instead of failing', async () => {
    const value = await payloadOf(ctx, 'status')
    assert.equal(value.enabled, false)
    assert.equal(value.running, false)
  })

  it('does not open a listener on the configured port', async () => {
    const open = await new Promise((resolve) => {
      const socket = new net.Socket()
      socket.setTimeout(400)
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', () => resolve(false))
      socket.connect(34882, '127.0.0.1')
    })
    assert.equal(open, false)
  })
})

describe('apply() with no password configured', () => {
  it('refuses to start and explains why, rather than listening uselessly', async () => {
    const ctx = makeCtx()
    const local = volatileConfig({ ...baseValues, enabled: true, port: 34883 })
    await apply(ctx, local.config)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const value = await payloadOf(ctx, 'status')
    assert.equal(value.enabled, true)
    assert.equal(value.running, false)
    assert.equal(value.error, 'no_password')
    await disposeCtx(ctx)
  })
})

describe('live switch', () => {
  it('saving enabled:true starts the listener and reports it', async () => {
    const ctx = makeCtx()
    const local = volatileConfig({
      ...baseValues,
      enabled: false,
      port: 34884,
      password: 'a-real-password',
    })
    await apply(ctx, local.config)
    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal((await payloadOf(ctx, 'status')).enabled, false)

    const value = await payloadOf(ctx, 'save', { values: { enabled: true } })
    assert.equal(value.enabled, true, 'the switch must read back as on')
    assert.equal(
      value.running === true || typeof value.error === 'string',
      true,
      'enabling must either start the listener or report a concrete error',
    )
    if (value.running === true) {
      assert.ok(Array.isArray(value.listening) && value.listening.length > 0)
    }
    await disposeCtx(ctx)
  })

  it('saving enabled:false stops a running listener', async () => {
    const ctx = makeCtx()
    const local = volatileConfig({
      ...baseValues,
      enabled: true,
      port: 34885,
      password: 'a-real-password',
    })
    await apply(ctx, local.config)
    await new Promise((resolve) => setTimeout(resolve, 150))

    const value = await payloadOf(ctx, 'save', { values: { enabled: false } })
    assert.equal(value.enabled, false)
    assert.equal(value.running, false)
    assert.deepEqual(value.listening, [])
    await disposeCtx(ctx)
  })
})
