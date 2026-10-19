import z from '@deepseek-ai/schemastery'
import {
  applyProxy,
  displayProxy,
  normalizeValues,
  safeErrorMessage,
  testProxy,
  validateForApply,
} from './lib/proxy.js'
import {
  currentValues,
  isPlainRecord,
  readValues,
  settingsDescriptor,
  settingsNamespace,
  settingsService,
} from './lib/settings.js'

export const name = 'network-proxy'

// `settings` owns persistence for this plugin's Loader row; `connection`
// carries the settings page's RPC over the shared `/api` channel.
export const inject = ['connection', 'settings']

// Every field is volatile: the Settings page edits this row live, and a save
// reloads the plugin so the new policy is installed immediately.
export const Config = z.object({
  enabled: z.boolean().default(false).volatile(),
  mode: z.union([z.const('http'), z.const('socks5')]).default('http').volatile(),
  host: z.string().default('').volatile(),
  port: z.natural().min(1).max(65535).default(8080).volatile(),
  username: z.string().default('').volatile(),
  password: z.string().role('secret').default('').volatile(),
  noProxy: z.string().default('').volatile(),
})

const RPC_ENDPOINT = 'request'
const SHARED_API_ENDPOINT = 'network-proxy'
const RPC_VERSION = 1

function envelope(op, result) {
  return { v: RPC_VERSION, op, result }
}

function ok(value) {
  return { ok: true, value }
}

function failure(code = 'internal') {
  return { ok: false, error: { code, message: 'Network proxy request failed' } }
}

function decodeRequest(payload) {
  if (!isPlainRecord(payload) || payload.v !== RPC_VERSION) return undefined
  if (payload.op === 'read') return { op: 'read' }
  if (payload.op === 'save' && isPlainRecord(payload.values)) {
    return {
      op: 'save',
      values: payload.values,
      revision: Number.isSafeInteger(payload.revision) ? payload.revision : undefined,
    }
  }
  if (payload.op === 'test' && isPlainRecord(payload.values)) {
    return { op: 'test', values: payload.values }
  }
  return undefined
}

function hasEnvironmentProxy() {
  return ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']
    .some((name) => typeof process.env[name] === 'string' && process.env[name] !== '')
}

/** Read the current policy, its persisted form, and the live install state. */
function readSettings(ctx, config, state) {
  const namespace = settingsNamespace(ctx)
  const descriptor = settingsDescriptor(ctx, namespace)
  const settings = settingsService(ctx)
  return {
    kind: 'settings',
    namespace,
    writable: descriptor !== undefined && settings?.writable !== false && typeof settings?.update === 'function',
    revision: Number.isSafeInteger(descriptor?.revision) ? descriptor.revision : null,
    values: readValues(config, descriptor),
    active: state.active,
    error: state.error,
    proxy: state.proxy,
    envProxy: hasEnvironmentProxy(),
  }
}

/** Persist the editable fields, preserving an unedited password. */
async function saveSettings(ctx, config, state, request) {
  const namespace = settingsNamespace(ctx)
  const descriptor = settingsDescriptor(ctx, namespace)
  const settings = settingsService(ctx)
  if (descriptor === undefined || typeof settings?.update !== 'function' || settings?.writable === false) {
    return { kind: 'fault', code: 'read_only' }
  }

  const current = currentValues(config)
  let values
  try {
    values = normalizeValues(request.values, current)
  } catch (error) {
    return { kind: 'fault', code: 'invalid_settings', message: safeErrorMessage(error) }
  }

  const patch = {
    enabled: values.enabled,
    mode: values.mode,
    host: values.host,
    port: values.port,
    username: values.username,
    noProxy: values.noProxy,
  }
  if (values.mode === 'socks5' || values.username === '' || request.values.clearPassword === true) {
    patch.password = ''
  } else if (typeof request.values.password === 'string' && request.values.password !== '') {
    patch.password = values.password
  }

  try {
    await settings.update(namespace, patch, request.revision)
  } catch (error) {
    return {
      kind: 'fault',
      code: error?.code === 'SETTINGS_CONFLICT' ? 'conflict' : 'save_failed',
    }
  }

  const next = currentValues({ ...config, ...patch })
  next.hasPassword = patch.password === undefined ? current.hasPassword : patch.password !== ''
  return {
    kind: 'settings',
    namespace,
    writable: true,
    revision: null,
    values: next,
    active: values.enabled,
    error: null,
    proxy: values.enabled ? displayProxy(values) : null,
    envProxy: hasEnvironmentProxy(),
    saved: true,
  }
}

async function testSettings(config, request) {
  const current = currentValues(config)
  let values
  try {
    const input = request.values.clearPassword === true
      ? { ...request.values, password: '' }
      : request.values
    values = normalizeValues({ ...input, enabled: true }, current)
    validateForApply(values)
  } catch (error) {
    return { ok: false, code: 'invalid_settings', message: safeErrorMessage(error) }
  }

  try {
    return await testProxy(values)
  } catch (error) {
    return { ok: false, code: 'failed', message: safeErrorMessage(error) }
  }
}

function installSettingsPolicy(ctx) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['settings'], (child) => {
      const settings = child.settings
      if (typeof settings?.configure !== 'function') return
      child.effect(() => {
        try {
          return settings.configure({ auto: false }, ctx.fiber)
        } catch (error) {
          ctx.logger?.warn?.('network-proxy: settings policy unavailable: %s', safeErrorMessage(error))
          return () => {}
        }
      }, 'network proxy settings policy')
    })
  } catch (error) {
    ctx.logger?.warn?.('network-proxy: settings injection failed: %s', safeErrorMessage(error))
  }
}

/**
 * Keep the installed dispatcher in sync with the live volatile config.
 *
 * The Loader commits a volatile-only config change into the running `{ get() }`
 * references without remounting the plugin, so activation alone is not enough:
 * a `loader/volatile-update` listener and the settings RPC both reconcile.
 */
function installProxyController(ctx, config, state) {
  let disposed = false
  let cleanup
  let applying = false
  let pending = false

  const reconcile = async () => {
    if (disposed) return
    if (applying) {
      pending = true
      return
    }
    applying = true
    try {
      const values = currentValues(config)
      const previous = cleanup
      cleanup = undefined
      if (previous !== undefined) await previous()
      if (disposed) return
      state.active = false
      state.error = null
      state.proxy = null
      if (!values.enabled) return
      try {
        validateForApply(values)
        const installed = await applyProxy(values)
        if (disposed) {
          await installed.dispose()
          return
        }
        cleanup = installed.dispose
        state.active = true
        state.error = null
        state.proxy = displayProxy(values)
        ctx.logger?.info?.('network-proxy: outbound proxy enabled (%s)', state.proxy)
      } catch (error) {
        state.active = false
        state.error = safeErrorMessage(error)
        state.proxy = null
        ctx.logger?.warn?.('network-proxy: could not apply proxy: %s', state.error)
      }
    } finally {
      applying = false
      if (pending && !disposed) {
        pending = false
        void reconcile()
      }
    }
  }

  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', () => { void reconcile() })
    void reconcile()
    return () => {
      disposed = true
      off()
      const dispose = cleanup
      cleanup = undefined
      state.active = false
      state.proxy = null
      if (dispose !== undefined) void dispose()
    }
  }, 'network proxy dispatcher')

  return { reconcile }
}

function installRpc(ctx, config, state, controller) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection
  if (connection === undefined) return

  const handler = async (endpoint, payload, signal) => {
    const request = decodeRequest(payload)
    if (endpoint !== RPC_ENDPOINT || request === undefined) return failure('bad_request')
    if (signal?.aborted) return failure('aborted')
    try {
      if (request.op === 'read') return ok(envelope('read', readSettings(ctx, config, state)))
      if (request.op === 'save') {
        const result = await saveSettings(ctx, config, state, request)
        if (result?.kind === 'settings') void controller.reconcile()
        return ok(envelope('save', result))
      }
      if (request.op === 'test') return ok(envelope('test', await testSettings(config, request)))
      return failure('bad_request')
    } catch (error) {
      ctx.logger?.warn?.('network-proxy: request failed: %s', safeErrorMessage(error))
      return failure('internal')
    }
  }

  if (Reflect.has(connection, 'fetch') && typeof connection.fetch?.register === 'function') {
    ctx.effect(() => connection.fetch.register({
      path: `/api/${SHARED_API_ENDPOINT}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleSharedApiRequest(request, handler),
    }), 'network proxy shared api')
    return
  }

  ctx.logger?.warn?.('network-proxy: this deployment has no shared Fetch route registry; the settings page cannot reach the Host')
}

async function handleSharedApiRequest(request, handler) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const input = isPlainRecord(body) ? body : undefined
  const rpcId = typeof input?.rpcId === 'string' ? input.rpcId : 'invalid-request'
  if (input?.type !== 'client-request' || typeof input.rpcId !== 'string'
    || input.method !== SHARED_API_ENDPOINT || !Object.hasOwn(input, 'payload')) {
    return Response.json({ type: 'server-response', rpcId, result: failure('bad_request') })
  }
  const result = await handler(RPC_ENDPOINT, input.payload, request.signal)
  return Response.json({ type: 'server-response', rpcId, result })
}

export function apply(ctx, config = {}) {
  const state = { active: false, error: null, proxy: null }
  installSettingsPolicy(ctx)
  const controller = installProxyController(ctx, config, state)
  installRpc(ctx, config, state, controller)
}

apply.inject = inject
