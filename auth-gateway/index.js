/**
 * @dsh-plugins/auth-gateway — Host entry.
 *
 * An authenticating reverse proxy for the stock DSH web server. It adds an
 * account, a login page, password change, TOTP and per-device session
 * revocation — none of which dsh itself provides — while leaving the core web
 * server untouched on loopback.
 *
 * Portability note: this plugin deliberately does **not** depend on the dsh
 * `settings` service's `register()` API. That API was removed upstream (both
 * 0.2.0-rc.2 and 0.2.1-rc.2 export only `SettingsConflictError`, `SettingsForms`
 * and `redactSecrets`), so the plugin keeps static policy in its own Loader row
 * Config and mutable account state in its own files under
 * `$DSH_HOME/plugins/dsh-auth-gateway/`.
 *
 * Switching model: `enabled` is a real switch, not a restart. The option is
 * declared `.volatile()`, so the Loader commits a new value into the live
 * config references without remounting the plugin; a `loader/volatile-update`
 * listener then starts or stops the gateway listener in place. Saving from the
 * settings page writes the same Loader row through `settings.update()`.
 *
 * The settings page talks to the Host over the core's shared `/api` fetch
 * route, NOT over the gateway's own listener. That matters: while the gateway
 * is off there is no gateway port to answer, so a page that phoned its own
 * listener could never turn the switch back on.
 */

import z from '@deepseek-ai/schemastery'

import { createGateway } from './lib/gateway.js'
import { assertRequiredSeams, capabilities, detectVersion } from './lib/version.js'
import { effectiveCredentials } from './lib/credentials.js'
import { createSettingsRpc } from './lib/settings-rpc.js'

export const name = 'auth-gateway'

// `connection` is the only hard dependency: the core session bridge needs
// `connection.authenticatedUrl()` to obtain a browser session of its own, and
// the settings page needs its shared `/api` route.
export const inject = ['connection']

/**
 * Every field is volatile: the settings page edits this row live, and an
 * `enabled` change must start or stop the listener without a reload.
 */
export const Config = z.object({
  /** Master switch. Off leaves the core web server exactly as it was. */
  enabled: z.boolean().default(false).volatile(),
  /** Port the gateway listens on for each non-loopback address. */
  port: z.natural().max(65535).default(3080).volatile(),
  /** Upstream host. Forced to loopback at runtime; never point this off-box. */
  targetHost: z.string().default('127.0.0.1').volatile(),
  /**
   * Upstream port. `0` means "ask the live webServer service", which is what the
   * desktop shell needs because it launches the core host with `--port 0`.
   */
  targetPort: z.natural().max(65535).default(0).volatile(),
  /** Explicit bind addresses. Empty means every non-loopback IPv4 interface. */
  addresses: z.array(z.string()).default([]).volatile(),
  /** Initial account name; a later change-password keeps whatever is stored. */
  username: z.string().default('admin').volatile(),
  /** Initial password. Used only to seed the store on first run. */
  password: z.string().role('secret').default('').volatile(),
  /** Realm shown on the login page. */
  realm: z.string().default('DeepSeek Harness Authentication').volatile(),
  /** Extra Host authorities accepted by the fence (bare host or host:port). */
  allowedHosts: z.array(z.string()).default([]).volatile(),
  /** Extra browser Origins accepted by the fence. */
  allowedOrigins: z.array(z.string()).default([]).volatile(),
  /** Absolute browser session lifetime. */
  sessionMaxAgeSeconds: z.natural().min(300).max(30 * 24 * 3600).default(24 * 3600).volatile(),
  /** Idle timeout; a session unused for this long stops validating. */
  sessionIdleTimeoutSeconds: z.natural().min(60).max(30 * 24 * 3600).default(12 * 3600).volatile(),
  /** Upstream connect/handshake timeout. */
  upstreamTimeoutMs: z.natural().min(1000).max(600_000).default(30_000).volatile(),
  /** Request timeout applied to gateway-owned listeners. */
  requestTimeoutMs: z.natural().min(1000).max(3_600_000).default(120_000).volatile(),
})

/**
 * Read the live config. The Loader hands `apply` a config whose `.volatile()`
 * fields are live `{ get() }` references, so every read must go through the
 * getter to see an update that has not remounted the plugin.
 */
function liveConfig(config) {
  if (config === null || typeof config !== 'object') return {}
  const out = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = value !== null && typeof value === 'object'
      && typeof value.get === 'function' && Object.keys(value).length === 1
      ? value.get()
      : value
  }
  return out
}

export async function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const state = {
    running: false,
    listener: null,
    error: null,
    listening: [],
  }

  // `inject` guarantees `connection` is present before `apply` runs; failing
  // here would make the settings page unreachable, so only report the seam
  // problem and let the RPC layer surface it in the UI.
  let seamError
  try {
    assertRequiredSeams(ctx)
  } catch (error) {
    seamError = error?.message ?? String(error)
    logger.error?.('auth-gateway: required seam is missing: %s', seamError)
  }

  const version = detectVersion(ctx)
  const caps = capabilities(ctx)
  logger.info?.(
    `auth-gateway: loaded (dsh=${version.raw} flavor=${version.flavor} settings.register=${String(caps.hasSettingsRegister)} tapIndex=${String(caps.supportsTapIndex)})`,
  )

  let gateway
  let applying = false
  let pending = false

  async function stopGateway() {
    if (gateway === undefined) return
    const stopped = gateway
    gateway = undefined
    try {
      await stopped.stop()
    } catch (error) {
      logger.warn?.('auth-gateway: stop failed: %s', error?.message ?? String(error))
    }
    state.running = false
    state.listening = []
  }

  async function startGateway(values) {
    const credentials = effectiveCredentials(values)
    if (!credentials.hasPassword) {
      // Fail closed and say so: a gateway nobody can log in to is not "on".
      state.running = false
      state.error = 'no_password'
      state.listening = []
      logger.warn?.(
        'auth-gateway: enabled but no password is configured, so logins would all be refused; set `password` and save again.',
      )
      return
    }
    const created = createGateway(ctx, values)
    try {
      const started = await created.start()
      gateway = created
      state.running = true
      state.error = null
      state.listening = started.listening
      logger.info?.(
        `auth-gateway: listening on ${started.listening.map((entry) => `${entry.address}:${String(entry.port)}`).join(', ')}`,
      )
    } catch (error) {
      state.running = false
      state.error = error?.message ?? String(error)
      state.listening = []
      logger.error?.('auth-gateway: failed to start: %s', state.error)
      // Never leave a half-open listener behind a failed start.
      await created.stop().catch(() => {})
    }
  }

  /**
   * Bring the listener in line with the current live config.
   *
   * `override` lets the save path apply values it just wrote instead of waiting
   * for the Loader's volatile update to land: a switch that visibly does nothing
   * for a few hundred milliseconds reads as broken.
   */
  async function reconcile(override) {
    if (applying) {
      pending = true
      return
    }
    applying = true
    try {
      const values = override === undefined ? liveConfig(config) : { ...liveConfig(config), ...override }
      if (values.enabled !== true) {
        await stopGateway()
        state.error = null
        return
      }
      if (seamError !== undefined) {
        await stopGateway()
        state.error = seamError
        return
      }
      await stopGateway()
      await startGateway(values)
    } finally {
      applying = false
      if (pending) {
        pending = false
        void reconcile()
      }
    }
  }

  function status() {
    return {
      running: state.running,
      error: state.error,
      listening: state.listening,
      seamError,
      version: { raw: version.raw, flavor: version.flavor },
    }
  }

  // The settings page is registered BEFORE any listener work so that a failed or
  // disabled gateway still leaves a working switch in the UI.
  const rpc = createSettingsRpc(ctx, {
    config,
    // The RPC layer calls this with no arguments, so bind the config here. Passing
    // the two-argument module function directly would read `undefined` and report
    // an empty config, which is what made the switch appear to snap back.
    liveConfig: () => liveConfig(config),
    state,
    status,
    reconcile,
  })
  ctx.effect(() => rpc.dispose, 'auth-gateway settings rpc')

  ctx.effect(() => {
    const off = ctx.on('loader/volatile-update', () => { void reconcile() })
    void reconcile()
    return () => {
      off()
      void stopGateway()
    }
  }, 'auth-gateway listener')
}

apply.inject = inject
