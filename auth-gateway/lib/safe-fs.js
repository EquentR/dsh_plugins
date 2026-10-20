/**
 * Private file IO for @dsh-plugins/auth-gateway.
 *
 * REGRESSION GUARD — read before editing.
 *
 * `@yiln-dsh/dsh-plugin-auth-webserver@0.7.6` crashed on Windows because
 * `readPrivateSecret()` did this (index.js:374-387 in the 107 source):
 *
 *     const mode = statSync(file).mode & 0o777
 *     if ((mode & 0o077) !== 0) {
 *       chmodSync(file, 0o600)
 *       if ((statSync(file).mode & 0o777 & 0o077) !== 0) throw new Error(...)
 *     }
 *
 * On Windows `stat().mode` is always 0o666 (33206) and `chmodSync()` only
 * toggles the read-only attribute, so the second check can never pass: the
 * gateway mounted once and then rejected every following start.
 *
 * Therefore: **no function in this module may ever assert on permission bits.**
 * Hardening is a best-effort side effect. On POSIX it sets 0o700/0o600. On
 * Windows it narrows the ACL with `icacls`. If either fails we warn and carry
 * on; the caller still gets its data. Only genuine IO failures that make the
 * requested value unavailable are reported, and reads report them as
 * `undefined` rather than throwing.
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'

/** Directory mode used on POSIX. Ignored (harmlessly) elsewhere. */
export const PRIVATE_DIR_MODE = 0o700
/** File mode used on POSIX. Ignored (harmlessly) elsewhere. */
export const PRIVATE_FILE_MODE = 0o600

const IS_WINDOWS = process.platform === 'win32'
const IS_POSIX = !IS_WINDOWS
const RENAME_ATTEMPTS = 5
const RENAME_BACKOFF_MS = 20

/**
 * Warning sink. The gateway injects `ctx.logger.warn` so hardening failures
 * land in the DSH log; the default keeps the plugin usable standalone.
 */
let warnSink = (message) => {
  console.warn(message)
}

/** Repeated identical warnings (one per file+reason) stay quiet after the first. */
const warned = new Set()

/** Replace the warning sink (pass `undefined` to restore the default). */
export function setWarnSink(sink) {
  warnSink = typeof sink === 'function' ? sink : () => {}
}

function warnOnce(key, message) {
  if (warned.has(key)) return
  warned.add(key)
  try {
    warnSink(`auth-gateway: ${message}`)
  } catch {
    // A broken logger must never break a file write.
  }
}

function isRegularFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/** POSIX: force owner-only mode. Useless on Windows (read-only bit only). */
function hardenPosix(file, mode) {
  chmodSync(file, mode)
}

/**
 * Windows: replace inherited ACEs with a single full-control grant for the
 * current user. `icacls` needs a principal name; if none is derivable we skip
 * silently — an unhardened file in `%USERPROFILE%` is the platform default and
 * must not stop the gateway from running.
 */
function hardenWindows(file) {
  const user = process.env.USERNAME || process.env.USER
  if (typeof user !== 'string' || user.trim() === '') {
    throw new Error('current user name is unavailable; cannot narrow the ACL')
  }
  execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user.trim()}:F`], {
    stdio: 'ignore',
    timeout: 10_000,
    windowsHide: true,
  })
}

/**
 * Best-effort permission hardening. Never throws: a failure is a warning, by
 * design (see the module header). Returns whether hardening succeeded, which
 * is informational only — callers must not turn `false` into an error.
 */
export function hardenFile(file) {
  if (typeof file !== 'string' || file === '') return false
  try {
    if (IS_POSIX) hardenPosix(file, PRIVATE_FILE_MODE)
    else hardenWindows(file)
    return true
  } catch (error) {
    const code = error?.code ?? error?.status ?? 'unknown'
    const detail = error instanceof Error ? error.message : String(error)
    warnOnce(`file:${file}:${code}`, `could not harden ${file} (${detail}); continuing without permission hardening`)
    return false
  }
}

/** Best-effort directory hardening; same non-throwing contract as `hardenFile`. */
function hardenDir(dir) {
  try {
    if (IS_POSIX) hardenPosix(dir, PRIVATE_DIR_MODE)
    else hardenWindows(dir)
    return true
  } catch (error) {
    const code = error?.code ?? error?.status ?? 'unknown'
    const detail = error instanceof Error ? error.message : String(error)
    warnOnce(`dir:${dir}:${code}`, `could not harden ${dir} (${detail}); continuing without permission hardening`)
    return false
  }
}

/**
 * Create `dir` (recursively) and try to restrict it to the current user.
 *
 * Only a genuine "cannot create the directory" failure throws — that is an
 * unrecoverable precondition. Permission hardening never throws.
 */
export function ensurePrivateDir(dir) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('ensurePrivateDir requires a directory path')
  // Only a freshly created directory needs hardening; re-hardening on every
  // write would spawn a process per write on Windows for no benefit.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
    hardenDir(dir)
  }
  return dir
}

/**
 * Read a UTF-8 file, returning `undefined` when it does not exist or cannot be
 * read. Deliberately forgiving: the gateway's first boot has no state yet, and
 * a state file that cannot be read must degrade to "not configured" rather than
 * abort plugin activation.
 */
export function readPrivateFile(file) {
  if (typeof file !== 'string' || file === '') return undefined
  if (!existsSync(file)) return undefined
  if (!isRegularFile(file)) {
    warnOnce(`read:${file}:not-file`, `${file} is not a regular file; ignoring it`)
    return undefined
  }
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    warnOnce(`read:${file}:${error?.code ?? 'unknown'}`, `could not read ${file} (${detail})`)
    return undefined
  }
}

/**
 * Atomically write a private file: write a sibling temp file, then rename over
 * the target, then harden. The rename makes a reader see either the old or the
 * new content, never a truncated file.
 *
 * Windows may briefly refuse the rename (indexer / antivirus holding a handle),
 * so the rename is retried a few times before the error propagates.
 */
export function writePrivateFile(file, content) {
  if (typeof file !== 'string' || file === '') throw new TypeError('writePrivateFile requires a file path')
  if (typeof content !== 'string') throw new TypeError('writePrivateFile content must be a string')

  const dir = dirname(file)
  ensurePrivateDir(dir)

  const temporary = join(dir, `${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    // Hardening the temp file is enough: both `rename` and `chmod` carry the
    // mode, and a same-volume rename keeps the ACL, so the target inherits them.
    hardenFile(temporary)
    renameWithRetry(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Best-effort cleanup after a failed write.
    }
    throw error
  }
  return file
}

function renameWithRetry(source, target) {
  let lastError
  for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt += 1) {
    try {
      renameSync(source, target)
      return
    } catch (error) {
      lastError = error
      const retriable = error?.code === 'EBUSY' || error?.code === 'EPERM' || error?.code === 'EACCES'
      if (!retriable || attempt === RENAME_ATTEMPTS - 1) break
      sleepSync(RENAME_BACKOFF_MS * (attempt + 1))
    }
  }
  throw lastError
}

/** Small synchronous backoff; the write path is not hot enough for async. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    const until = Date.now() + ms
    while (Date.now() < until) {
      // Fallback spin when `Atomics.wait` is unavailable.
    }
  }
}

/** True when the platform can actually enforce POSIX permission bits. */
export function supportsPosixModes() {
  return IS_POSIX
}
