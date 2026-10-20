/**
 * State locations for @dsh-plugins/auth-gateway.
 *
 * The plugin owns its mutable state (credentials, sessions, TOTP secret) in
 * plain files under `$DSH_HOME/plugins/dsh-auth-gateway/` instead of the DSH
 * Settings service, because neither dsh 0.2.0-rc.2 nor 0.2.1-rc.2 exports a
 * usable `settings.register()`. See CONTRACT.md section 1.
 *
 * Resolution deliberately mirrors the 0.7.6 gateway so a `DSH_HOME` written on
 * Linux (`~`, `~/foo`) still resolves on Windows: `node:path` supplies the
 * separator, and both `~/` and `~\` prefixes are expanded.
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'

/** Path segments below the DSH home; also the plugin's state directory name. */
const STATE_SEGMENTS = ['plugins', 'dsh-auth-gateway']

/**
 * Resolve the DSH home directory.
 *
 * `$DSH_HOME` wins when set; `~` and `~<sep>...` are expanded against the OS
 * home so a config carried over from a POSIX host still works. Anything else is
 * resolved as a plain path (relative values are made absolute by `node:path`).
 */
export function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = raw.trim()
    if (value === '~') return homedir()
    if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
    return resolve(value)
  }
  return join(homedir(), '.dsh')
}

/** Absolute path of `<dshHome>/plugins/dsh-auth-gateway`. */
export function stateDir() {
  return join(dshHome(), ...STATE_SEGMENTS)
}

/**
 * Absolute path of one file inside `stateDir()`.
 *
 * Relative sub-paths are allowed so callers can group files, but absolute
 * inputs and `..` traversal are rejected: every state file must stay inside
 * the plugin's own directory, which is the only directory the plugin claims
 * exclusive ownership of.
 */
export function stateFile(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('stateFile name must be a non-empty string')
  }
  const value = name.trim()
  if (isAbsolute(value)) {
    throw new TypeError(`stateFile name must be relative to the state directory, got ${JSON.stringify(name)}`)
  }
  const segments = value.split(/[\\/]+/u).filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0 || segments.includes('..')) {
    throw new TypeError(`stateFile name must not traverse outside the state directory, got ${JSON.stringify(name)}`)
  }
  return join(stateDir(), ...segments)
}

/** Separator used by the current platform; exported for tests and diagnostics. */
export const pathSeparator = sep
