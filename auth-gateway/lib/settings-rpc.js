/**
 * Settings RPC for @dsh-plugins/auth-gateway.
 *
 * The settings page must be able to turn the gateway ON while it is off, so it
 * cannot talk to the gateway's own listener. Instead it uses the core's shared
 * `/api` fetch route: that route is served by the dsh web server, which is
 * always up, and it is already owner-authenticated.
 *
 * Two families of operation live here:
 *   * policy/config — read state, save the Loader row (`settings.update`).
 *   * account — change the password, enrol or drop TOTP. These are Host-side
 *     because they must work whether or not the gateway listener is running.
 *
 * Login itself is NOT here: a session cookie has to be issued for the gateway
 * authority, so login happens at the gateway's own login page.
 */

import {
  changePassword,
  currentPlainPassword,
  effectiveCredentials,
  readCredentials,
  safeEqualString,
  seedCredentials,
  setTwoFactor,
  verifyPassword,
} from './credentials.js'
import { verifyTotp } from './totp.js'

/** Endpoint the browser client calls; must match client.js. */
export const RPC_ENDPOINT = 'auth-gateway'
export const RPC_VERSION = 1
export const RPC_PATH = `/api/${RPC_ENDPOINT}`

/** Fallback used when the live Loader entry id cannot be discovered. */
export const SETTINGS_NAMESPACE_FALLBACK = 'dsh-auth-gateway'

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function service(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
}

/**
 * Response envelope carried inside the shared-RPC `result` slot.
 *
 * IMPORTANT: `@deepseek-ai/dsh-client-connection` parses every shared-RPC reply
 * with `parseConnectionResponse`, which requires `result` to be exactly
 * `{ ok: true, value }` or `{ ok: false, error: { code, message, details } }`.
 * Wrapping it in another layer (adding `v`/`op` here) makes the core throw
 * `TypeError: invalid server-response result` before the page ever sees it.
 *
 * `{ v, op }` therefore belongs INSIDE `value`, which is how the repository's
 * other plugins do it: Host answers `{ ok: true, value: { v, op, result } }`.
 */
function envelope(op, result) {
  return { v: RPC_VERSION, op, result }
}

/** Success reply in the shape the core's parser accepts. */
function ok(value) {
  return { ok: true, value }
}

/**
 * Failure reply. `error.details` is mandatory in the core's parser, so it is
 * always present even when there is nothing extra to report.
 */
function failure(code, message = 'Auth gateway request failed', details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * The Loader entry id this instance owns, for `settings.update`.
 *
 * `settings.update(ns, ...)` keys on the RUNTIME entry id, which is not always
 * the id written in the profile patch: a row inserted through an `include:`
 * layer surfaces as `include:<patchId>`. Discovering the id from the live
 * configEditor is therefore mandatory — guessing the patch id makes every save
 * fail with "entry not found".
 *
 * @returns the live id, or `undefined` when it cannot be discovered.
 */
export function discoverNamespace(ctx) {
  const editor = service(ctx, 'configEditor')
  if (editor === undefined) return undefined

  const matchesOwnFiber = (entry) => entry?.fiber !== undefined && entry.fiber === ctx.fiber
  const idOf = (entry) => (typeof entry?.options?.id === 'string' && entry.options.id !== ''
    ? entry.options.id
    : typeof entry?.id === 'string' && entry.id !== ''
      ? entry.id
      : undefined)

  // `entries()` exposes Loader entries directly.
  try {
    const entries = editor.entries?.()
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!matchesOwnFiber(entry)) continue
        const id = idOf(entry)
        if (id !== undefined) return id
      }
    }
  } catch {
    // Try the composed view next.
  }

  // `configuration()` wraps each entry, so the fiber lives one level deeper.
  try {
    const configuration = editor.configuration?.()
    if (Array.isArray(configuration)) {
      for (const row of configuration) {
        if (!matchesOwnFiber(row?.entry)) continue
        const id = idOf(row.entry)
        if (id !== undefined) return id
      }
    }
  } catch {
    // Give up and report the failure to the caller.
  }

  return undefined
}

/**
 * Namespace used for `settings.update`, plus a readable reason when it cannot
 * be determined. Callers surface `reason` instead of a generic "save failed".
 */
export function settingsNamespace(ctx) {
  const discovered = discoverNamespace(ctx)
  if (discovered !== undefined) return { namespace: discovered, reason: undefined }
  return {
    namespace: undefined,
    reason: 'Could not resolve this plugin\'s Loader entry id, so the profile config cannot be edited',
  }
}

function normalizeStringList(value, fallback) {
  if (!Array.isArray(value)) return fallback
  return value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/**
 * Turn a client-sent `values` object into a Loader-row patch.
 *
 * `password` is deliberately special: an empty string means "leave the stored
 * secret alone", so a settings save that does not touch the password cannot
 * silently wipe it. `clearPassword` removes it explicitly.
 */
export function buildPatch(input, current) {
  const patch = {}
  if (typeof input.enabled === 'boolean') patch.enabled = input.enabled
  if (Number.isSafeInteger(input.port) && input.port >= 1 && input.port <= 65535) patch.port = input.port
  if (typeof input.targetHost === 'string' && input.targetHost.trim() !== '') patch.targetHost = input.targetHost.trim()
  if (Number.isSafeInteger(input.targetPort) && input.targetPort >= 0 && input.targetPort <= 65535) {
    patch.targetPort = input.targetPort
  }
  if (typeof input.username === 'string' && input.username.trim() !== '') patch.username = input.username.trim()
  if (typeof input.realm === 'string' && input.realm.trim() !== '') patch.realm = input.realm.trim()
  if (Array.isArray(input.addresses)) patch.addresses = normalizeStringList(input.addresses, [])
  if (Array.isArray(input.allowedHosts)) patch.allowedHosts = normalizeStringList(input.allowedHosts, [])
  if (Array.isArray(input.allowedOrigins)) patch.allowedOrigins = normalizeStringList(input.allowedOrigins, [])
  if (Number.isSafeInteger(input.sessionMaxAgeSeconds)) patch.sessionMaxAgeSeconds = input.sessionMaxAgeSeconds
  if (Number.isSafeInteger(input.sessionIdleTimeoutSeconds)) patch.sessionIdleTimeoutSeconds = input.sessionIdleTimeoutSeconds

  if (input.clearPassword === true) {
    patch.password = ''
  } else if (typeof input.password === 'string' && input.password !== '') {
    patch.password = input.password
  }
  void current
  return patch
}

/**
 * Shape sent to the client: never includes the password itself.
 *
 * `overrides` carries values that were just saved but whose volatile update has
 * not necessarily landed in `liveConfig()` yet. Without it the UI would read
 * back the pre-save switch position and visibly snap back.
 */
export function describeState(values, status, account, overrides) {
  const view = overrides === undefined || overrides === null ? values : { ...values, ...overrides }
  return {
    enabled: view.enabled === true,
    running: status.running,
    error: status.error,
    listening: status.listening,
    seamError: status.seamError,
    version: status.version,
    port: view.port,
    targetHost: view.targetHost,
    targetPort: view.targetPort,
    addresses: Array.isArray(view.addresses) ? view.addresses : [],
    username: account.username,
    realm: account.realm,
    allowedHosts: Array.isArray(view.allowedHosts) ? view.allowedHosts : [],
    allowedOrigins: Array.isArray(view.allowedOrigins) ? view.allowedOrigins : [],
    sessionMaxAgeSeconds: view.sessionMaxAgeSeconds,
    sessionIdleTimeoutSeconds: view.sessionIdleTimeoutSeconds,
    hasPassword: account.hasPassword,
    twoFactorEnabled: account.twoFactorEnabled,
    authEpoch: account.authEpoch,
  }
}

/**
 * Register the settings RPC on the core's shared `/api` route.
 *
 * `liveConfig` is called with no arguments and must return the current config
 * values; callers bind whatever context it needs.
 *
 * @returns `{ dispose }` — the disposer removes the route.
 */
export function createSettingsRpc(ctx, { liveConfig, status, reconcile }) {
  const logger = ctx.logger ?? console
  const connection = service(ctx, 'connection')

  async function handle(op, payload) {
    const values = liveConfig()
    const account = effectiveCredentials(values)
    const input = isPlainRecord(payload) ? payload : {}

    if (op === 'status') {
      // Report the CONFIGURED switch position, not the running state: an
      // operator who turned it on must see "on" plus the reason it is not
      // serving (for example `no_password`), never a switch that silently
      // reverts to off.
      return ok(describeState(values, status(), account))
    }

    if (op === 'save') {
      const settings = service(ctx, 'settings')
      const resolved = settingsNamespace(ctx)
      if (resolved.namespace === undefined) {
        logger.warn?.(`auth-gateway: ${String(resolved.reason)}`)
        return failure('namespace_unresolved', resolved.reason)
      }
      const namespace = resolved.namespace
      if (typeof settings?.update !== 'function') {
        return failure('read_only', 'The Settings service does not allow writing the plugin config')
      }
      if (settings.writable === false) {
        return failure('read_only', 'This profile does not allow editing the plugin config')
      }
      const patch = buildPatch(isPlainRecord(input.values) ? input.values : {}, account)
      if (Object.keys(patch).length === 0) return failure('nothing_to_save', 'No changed fields to save')
      try {
        // `update` merges the patch into the live form fields, so a partial patch
        // is enough; no revision is sent because a stale one would 409 a save
        // that is otherwise correct.
        await settings.update(namespace, patch)
      } catch (error) {
        const conflict = error?.code === 'SETTINGS_CONFLICT'
        const detail = error?.message ?? String(error)
        logger.warn?.(`auth-gateway: settings update failed for ${namespace}: ${detail}`)
        return failure(conflict ? 'conflict' : 'save_failed', conflict
          ? 'Settings changed elsewhere; reloaded'
          : `Could not write the plugin config: ${detail}`)
      }
      // Apply the values just written so the switch takes effect immediately,
      // instead of waiting for the volatile update to round-trip.
      await reconcile(patch)
      // Report the patch we just wrote. `liveConfig()` may still hold the
      // pre-save values until the volatile update lands, and a switch that reads
      // back its old position looks broken.
      const merged = { ...values, ...patch }
      return ok(describeState(merged, status(), effectiveCredentials(merged), patch))
    }

    if (op === 'diagnose') {
      // Read-only probe of the Settings wiring. Exists because a failed save is
      // otherwise indistinguishable from a transport failure in the UI, and the
      // desktop keeps its Host logs out of reach.
      const editor = service(ctx, 'configEditor')
      const settings = service(ctx, 'settings')
      let entriesShape
      try {
        const entries = editor?.entries?.()
        entriesShape = Array.isArray(entries)
          ? entries.slice(0, 40).map((entry) => ({
              id: entry?.options?.id ?? entry?.id,
              hasFiber: entry?.fiber !== undefined,
              own: entry?.fiber === ctx.fiber,
            }))
          : 'not-an-array'
      } catch (error) {
        entriesShape = `threw: ${error?.message ?? String(error)}`
      }
      let namespaces
      try {
        const described = settings?.describe?.({ redactSecrets: true })
        namespaces = Array.isArray(described) ? described.map((entry) => entry?.ns) : 'not-an-array'
      } catch (error) {
        namespaces = `threw: ${error?.message ?? String(error)}`
      }
      const resolved = settingsNamespace(ctx)
      return ok({
        namespace: resolved.namespace,
        namespaceReason: resolved.reason,
        fallback: SETTINGS_NAMESPACE_FALLBACK,
        hasConfigEditor: editor !== undefined,
        hasEntries: typeof editor?.entries === 'function',
        hasConfiguration: typeof editor?.configuration === 'function',
        hasSettings: settings !== undefined,
        hasUpdate: typeof settings?.update === 'function',
        writable: settings?.writable,
        entries: entriesShape,
        describeNamespaces: namespaces,
      })
    }

    if (op === 'changePassword' || op === 'setPassword') {
      const currentPassword = typeof input.currentPassword === 'string' ? input.currentPassword : ''
      const newPassword = typeof input.newPassword === 'string' ? input.newPassword : ''
      if (newPassword.length < 8) return failure('password_too_short', 'At least 8 characters')

      const record = readCredentials()
      if (record === undefined) {
        // First-time setup: there is no current password to verify, so requiring
        // one made the very first save impossible — the account could never be
        // bootstrapped from the UI.
        try {
          seedCredentials({
            username: typeof values.username === 'string' && values.username !== '' ? values.username : undefined,
            password: newPassword,
          })
        } catch (error) {
          return failure('change_failed', error?.message ?? 'Could not create the password')
        }
        logger.info?.('auth-gateway: initial password created from the settings page')
        const next = effectiveCredentials(values)
        return ok(describeState(values, status(), next))
      }

      if (!verifyPassword(currentPassword, record)) {
        return failure('invalid_credentials', 'Current password is incorrect')
      }
      try {
        changePassword(currentPassword, newPassword, currentPlainPassword(values))
      } catch (error) {
        return failure('change_failed', error?.message ?? 'Could not change the password')
      }
      logger.info?.('auth-gateway: password changed from the settings page')
      return ok(describeState(values, status(), effectiveCredentials(values)))
    }

    if (op === 'totp') {
      const action = input.action
      if (action === 'disable') {
        const password = typeof input.password === 'string' ? input.password : ''
        const record = readCredentials()
        const accepted = record !== undefined
          ? verifyPassword(password, record)
          : safeEqualString(password, currentPlainPassword(values) ?? '')
        if (!accepted) return failure('invalid_credentials', 'Password is incorrect')
        if (record !== undefined) setTwoFactor({ secret: '', enabled: false })
        return ok({ twoFactorEnabled: false })
      }
      if (action === 'enable') {
        const secret = typeof input.secret === 'string' ? input.secret : ''
        const code = typeof input.code === 'string' ? input.code : ''
        if (secret === '') return failure('missing_secret')
        if (!verifyTotp(secret, code)) return failure('invalid_totp', 'Check the 6-digit code and try again')
        if (readCredentials() === undefined) {
          return failure('no_password', 'Set a password before enabling two-factor')
        }
        setTwoFactor({ secret, enabled: true })
        return ok({ twoFactorEnabled: true })
      }
      return failure('bad_request')
    }

    return failure('bad_request')
  }

  /**
   * Build one shared-RPC reply from a handler outcome.
   *
   * The outer `result` must stay `{ ok, value }` / `{ ok, error }` because that
   * is what `parseConnectionResponse` accepts. A handler's own failure is
   * therefore lifted into that outer error, and the plugin's `{ v, op }`
   * contract rides inside `value` on success only.
   */
  function respond(rpcId, op, outcome) {
    if (outcome?.ok !== true) {
      const error = outcome?.error ?? {}
      return Response.json({
        type: 'server-response',
        rpcId,
        result: failure(error.code ?? 'internal', error.message ?? 'Auth gateway request failed', error.details),
      })
    }
    return Response.json({ type: 'server-response', rpcId, result: ok(envelope(op, outcome.value)) })
  }

  async function handleRequest(request) {
    const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const input = isPlainRecord(body) ? body : {}
    const rpcId = typeof input.rpcId === 'string' ? input.rpcId : 'invalid-request'
    if (input.type !== 'client-request' || typeof input.rpcId !== 'string'
      || input.method !== RPC_ENDPOINT || !Object.hasOwn(input, 'payload')) {
      return respond(rpcId, 'invalid', failure('bad_request', 'Malformed request envelope'))
    }
    const payload = isPlainRecord(input.payload) ? input.payload : {}
    if (payload.v !== RPC_VERSION || typeof payload.op !== 'string') {
      return respond(rpcId, 'invalid', failure('protocol_error', 'Host and page disagree on the protocol version'))
    }
    const op = payload.op
    try {
      return respond(rpcId, op, await handle(op, payload))
    } catch (error) {
      logger.warn?.(`auth-gateway: settings rpc failed: ${error?.message ?? String(error)}`)
      return respond(rpcId, op, failure('internal', error?.message ?? 'Internal error'))
    }
  }

  if (connection === undefined || typeof connection.fetch?.register !== 'function') {
    logger.warn?.(
      'auth-gateway: this deployment has no shared Fetch route registry, so the settings page cannot reach the Host',
    )
    return { dispose: () => {}, registered: false, reason: 'no-fetch-registry' }
  }

  let remove
  try {
    remove = connection.fetch.register({
      path: RPC_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: (request) => handleRequest(request),
    })
  } catch (error) {
    // Never let the settings route take the whole plugin down: a throw here
    // aborts `apply`, leaving an active-but-unreachable plugin whose page then
    // reports a transport failure with no explanation.
    logger.error?.(`auth-gateway: could not register ${RPC_PATH}: ${error?.message ?? String(error)}`)
    return { dispose: () => {}, registered: false, reason: error?.message ?? String(error) }
  }
  logger.info?.(`auth-gateway: settings route registered at ${RPC_PATH}`)

  return {
    registered: true,
    dispose: () => {
      try {
        if (typeof remove === 'function') remove()
      } catch {
        // Disposal races with shutdown; nothing useful to do.
      }
    },
  }
}
