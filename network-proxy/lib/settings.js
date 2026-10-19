/**
 * Settings plumbing for @dsh-plugins/network-proxy.
 *
 * The plugin stores its policy in its own profile Loader row, so the DSH
 * Settings service owns persistence, revisions, and secret redaction.
 */

/** Used when the live Loader row cannot be discovered; matches cordis.patch.yml. */
export const SETTINGS_NAMESPACE_FALLBACK = 'dsh-network-proxy'

export function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * The Loader hands `apply` a config whose `.volatile()` fields are live
 * `{ get() }` references. Read every field through that getter so activation
 * and later volatile updates see the current values instead of the wrapper.
 */
export function plainConfig(config) {
  if (!isPlainRecord(config)) return {}
  const result = {}
  for (const [key, value] of Object.entries(config)) {
    result[key] = value !== null && typeof value === 'object'
      && typeof value.get === 'function' && Object.keys(value).length === 1
      ? value.get()
      : value
  }
  return result
}

function service(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
}

export function settingsService(ctx) {
  return service(ctx, 'settings')
}

export function configEditorService(ctx) {
  return service(ctx, 'configEditor')
}

/**
 * The plugin's own profile entry id. Discovery from the live Loader entries
 * keeps a renamed row's settings page working; the patch id is the fallback.
 */
export function settingsNamespace(ctx) {
  try {
    const own = configEditorService(ctx)?.entries?.().find((entry) => entry?.fiber === ctx.fiber)
    if (typeof own?.options?.id === 'string' && own.options.id !== '') return own.options.id
  } catch {
    // Fall through to the id this package's bundle patch declares.
  }
  return SETTINGS_NAMESPACE_FALLBACK
}

export function settingsDescriptor(ctx, namespace) {
  try {
    const descriptors = settingsService(ctx)?.describe?.({ redactSecrets: true })
    return Array.isArray(descriptors) ? descriptors.find((entry) => entry.ns === namespace) : undefined
  } catch {
    return undefined
  }
}

/** Read the raw Config values this plugin instance was activated with. */
export function currentValues(config) {
  const plain = plainConfig(config)
  const mode = plain.mode === 'socks5' ? 'socks5' : 'http'
  return {
    enabled: plain.enabled === true,
    mode,
    host: typeof plain.host === 'string' ? plain.host : '',
    port: Number.isSafeInteger(plain.port) ? plain.port : mode === 'socks5' ? 1080 : 8080,
    username: typeof plain.username === 'string' ? plain.username : '',
    noProxy: typeof plain.noProxy === 'string' ? plain.noProxy : '',
    hasPassword: typeof plain.password === 'string' && plain.password !== '',
  }
}

/**
 * Merge non-secret fields the Settings service may already hold with the raw
 * Config this instance activated with. The redacted password marker is never
 * copied into the returned values; `hasPassword` reports its presence.
 */
export function readValues(config, descriptor) {
  const raw = plainConfig(config)
  const saved = isPlainRecord(descriptor?.value) ? descriptor.value : {}
  const merged = {
    ...raw,
    ...saved,
    password: raw.password,
  }
  delete merged.password
  const values = currentValues(merged)
  values.hasPassword = typeof raw.password === 'string' && raw.password !== ''
  return values
}
