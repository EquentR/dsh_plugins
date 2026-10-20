/**
 * Kernel A unit tests: paths / safe-fs / policy / totp / credentials / sessions.
 *
 * Run with: node --test auth-gateway/test/kernel-a.test.js
 *
 * The safe-fs group is the regression guard for the Windows failure that killed
 * `dsh-plugin-auth-webserver` 0.7.6: it asserted on `stat().mode & 0o077`, which
 * is always dirty on Windows, so the gateway crashed on every restart. These
 * tests must keep passing on win32 *without* any mode assertion.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { dshHome, pathSeparator, stateDir, stateFile } from '../lib/paths.js'
import {
  ensurePrivateDir,
  hardenFile,
  readPrivateFile,
  setWarnSink,
  supportsPosixModes,
  writePrivateFile,
} from '../lib/safe-fs.js'
import {
  hostMatches,
  originMatches,
  parseAllowedHost,
  parseAllowedOrigin,
  parseAllowedOriginHost,
  parseList,
  parseRequestHost,
} from '../lib/policy.js'
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS_VALUE,
  totpCode,
  verifyTotp,
} from '../lib/totp.js'
import {
  changePassword,
  CREDENTIALS_VERSION,
  effectiveCredentials,
  hashPassword,
  readCredentials,
  seedCredentials,
  setTwoFactor,
  verifyPassword,
  writeCredentials,
} from '../lib/credentials.js'
import { SESSION_ID_PATTERN, SESSION_STORE_VERSION, SessionStore } from '../lib/sessions.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Run `fn` with `process.env.DSH_HOME` pointed at a throwaway directory. */
function withTempHome(fn) {
  return async () => {
    const home = mkdtempSync(join(tmpdir(), 'auth-gateway-kernel-a-'))
    const saved = { DSH_HOME: process.env.DSH_HOME, AUTH_USER: process.env.AUTH_USER, AUTH_PASS: process.env.AUTH_PASS }
    process.env.DSH_HOME = home
    delete process.env.AUTH_USER
    delete process.env.AUTH_PASS
    try {
      await fn(home)
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(home, { recursive: true, force: true })
    }
  }
}

function withTempDir(fn) {
  return () => {
    const dir = mkdtempSync(join(tmpdir(), 'auth-gateway-kernel-a-'))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

test('paths: dshHome honours DSH_HOME and falls back to <home>/.dsh', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = ''
    assert.match(dshHome(), /\.dsh$/u)

    process.env.DSH_HOME = '~'
    assert.equal(dshHome().includes('.dsh'), false)

    process.env.DSH_HOME = '~/custom-home'
    assert.equal(dshHome().endsWith(`custom-home`), true)

    process.env.DSH_HOME = 'relative-home'
    assert.equal(dshHome().endsWith('relative-home'), true)
    assert.equal(pathSeparator === '\\' || pathSeparator === '/', true)
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('paths: stateDir and stateFile live under the plugin state directory', () => {
  const saved = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = join(tmpdir(), 'auth-gateway-paths-probe')
    assert.equal(stateDir(), join(process.env.DSH_HOME, 'plugins', 'dsh-auth-gateway'))
    assert.equal(stateFile('credentials.json'), join(stateDir(), 'credentials.json'))
    assert.equal(stateFile('nested/x.json'), join(stateDir(), 'nested', 'x.json'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('paths: stateFile rejects absolute paths and traversal', () => {
  assert.throws(() => stateFile(''), TypeError)
  assert.throws(() => stateFile('   '), TypeError)
  assert.throws(() => stateFile('../escape.json'), TypeError)
  assert.throws(() => stateFile('a/../../escape.json'), TypeError)
  assert.throws(() => stateFile(join(tmpdir(), 'absolute.json')), TypeError)
})

// ---------------------------------------------------------------------------
// safe-fs — Windows regression guard
// ---------------------------------------------------------------------------

test('safe-fs: ensurePrivateDir + writePrivateFile + readPrivateFile round-trip', withTempDir((dir) => {
  const nested = join(dir, 'plugins', 'dsh-auth-gateway')
  ensurePrivateDir(nested)
  const file = join(nested, 'state.json')
  writePrivateFile(file, '{"ok":true}\n')
  assert.equal(readPrivateFile(file), '{"ok":true}\n')
}))

test('safe-fs: missing file reads as undefined instead of throwing', withTempDir((dir) => {
  assert.equal(readPrivateFile(join(dir, 'nope.json')), undefined)
}))

test('safe-fs: hardenFile never throws on a world-readable file (Windows crash regression)', withTempDir((dir) => {
  const file = join(dir, 'secret.txt')
  // Written with default permissions: on Windows that is mode 0o666, i.e.
  // exactly the state 0.7.6 treated as fatal.
  writeFileSync(file, 'secret', 'utf8')
  const mode = statSync(file).mode & 0o777

  // The 0.7.6 assertion would be: (mode & 0o077) !== 0 -> throw.
  // Every outcome must be a boolean here, never an exception.
  const result = hardenFile(file)
  assert.equal(typeof result, 'boolean')

  // Whatever the platform could do, the value is still readable: hardening is
  // best-effort and must not make the file unusable.
  assert.equal(readPrivateFile(file), 'secret')

  if (!supportsPosixModes()) {
    // Document, not assert, the platform fact that caused the original crash.
    assert.equal((mode & 0o077) !== 0, true)
    assert.equal((statSync(file).mode & 0o777 & 0o077) !== 0, true)
  } else {
    assert.equal(statSync(file).mode & 0o077, 0)
  }
}))

test('safe-fs: overwriting an existing private file stays readable and does not throw', withTempDir((dir) => {
  const file = join(dir, 'sessions.json')
  writePrivateFile(file, 'first')
  writePrivateFile(file, 'second')
  assert.equal(readPrivateFile(file), 'second')
}))

test('safe-fs: repeated hardening of the same file is idempotent and silent', withTempDir((dir) => {
  const messages = []
  setWarnSink((message) => messages.push(message))
  try {
    const file = join(dir, 'idempotent.txt')
    writeFileSync(file, 'x', 'utf8')
    assert.equal(hardenFile(file), hardenFile(file))
    assert.deepEqual(messages, [])
  } finally {
    setWarnSink(undefined)
  }
}))

test('safe-fs: writePrivateFile rejects non-string content', withTempDir((dir) => {
  assert.throws(() => writePrivateFile(join(dir, 'a.json'), null), TypeError)
  assert.throws(() => writePrivateFile('', 'x'), TypeError)
}))

// ---------------------------------------------------------------------------
// policy — the 421 / 403 fences
// ---------------------------------------------------------------------------

test('policy: parseAllowedHost requires canonical spelling', () => {
  assert.deepEqual(parseAllowedHost('dsh.example.com'), { hostname: 'dsh.example.com', port: '', host: 'dsh.example.com' })
  assert.deepEqual(parseAllowedHost('dsh.example.com:8443'), {
    hostname: 'dsh.example.com',
    port: '8443',
    host: 'dsh.example.com:8443',
  })
  // Hostnames are case-insensitive, so an uppercase spelling is normalised
  // rather than rejected (the strict check compares the lowered value).
  assert.equal(parseAllowedHost('DSH.Example.com').hostname, 'dsh.example.com')
  // A non-canonical port spelling is rejected.
  assert.throws(() => parseAllowedHost('dsh.example.com:0443'), /canonical/u)
  assert.throws(() => parseAllowedHost('https://dsh.example.com'))
  assert.throws(() => parseAllowedHost('dsh.example.com/path'))
  assert.throws(() => parseAllowedHost(' dsh.example.com'))
  assert.throws(() => parseAllowedHost(''))
})

test('policy: parseRequestHost tolerates any spelling, rejects junk', () => {
  assert.equal(parseRequestHost('DSH.Example.com').hostname, 'dsh.example.com')
  assert.equal(parseRequestHost('192.168.55.20:3080').port, '3080')
  assert.equal(parseRequestHost('not a host'), undefined)
  assert.equal(parseRequestHost(undefined), undefined)
})

test('policy: hostMatches is the 421 decision', () => {
  const allowed = [parseAllowedHost('192.168.55.20:3080'), parseAllowedHost('dsh.example.com')]
  assert.equal(hostMatches('192.168.55.20:3080', allowed), true)
  assert.equal(hostMatches('192.168.55.20:9999', allowed), false)
  // A portless allowlist entry accepts any request port.
  assert.equal(hostMatches('dsh.example.com:3080', allowed), true)
  assert.equal(hostMatches('dsh.example.com', allowed), true)
  // Unknown host, malformed host, and missing host all fail closed.
  assert.equal(hostMatches('evil.example.com', allowed), false)
  assert.equal(hostMatches('', allowed), false)
  assert.equal(hostMatches(undefined, allowed), false)
  assert.equal(hostMatches('192.168.55.20:3080', []), false)
})

test('policy: hostMatches uses the scheme default port when none is given', () => {
  const allowed = [parseAllowedHost('dsh.example.com:443'), parseAllowedHost('plain.example.com:80')]
  assert.equal(hostMatches('dsh.example.com', allowed, true), true)
  assert.equal(hostMatches('dsh.example.com', allowed, false), false)
  assert.equal(hostMatches('plain.example.com', allowed, false), true)
})

test('policy: parseAllowedOrigin normalises and derives a host', () => {
  assert.equal(parseAllowedOrigin('https://dsh.example.com/'), 'https://dsh.example.com')
  assert.equal(parseAllowedOrigin('http://192.168.55.20:3080'), 'http://192.168.55.20:3080')
  assert.throws(() => parseAllowedOrigin('https://dsh.example.com/path'))
  assert.throws(() => parseAllowedOrigin('ftp://dsh.example.com'))
  assert.throws(() => parseAllowedOrigin('dsh.example.com'))

  const derived = parseAllowedOriginHost('https://dsh.example.com')
  assert.deepEqual(derived, { hostname: 'dsh.example.com', port: '', host: 'dsh.example.com' })
  assert.deepEqual(parseAllowedOriginHost('http://192.168.55.20:3080'), {
    hostname: '192.168.55.20',
    port: '3080',
    host: '192.168.55.20:3080',
  })
})

test('policy: originMatches requires Origin agreement with Host', () => {
  // Absent Origin (same-origin navigation, non-browser client) is allowed and
  // the Host fence still stands on its own.
  assert.equal(originMatches(undefined, 'dsh.example.com', []), true)

  // Same authority: allowed, with and without an explicit allowlist.
  assert.equal(originMatches('https://dsh.example.com', 'dsh.example.com', []), true)
  assert.equal(originMatches('https://dsh.example.com', 'dsh.example.com', ['https://dsh.example.com']), true)

  // Origin that backends must not trust.
  assert.equal(originMatches('https://evil.example.com', 'dsh.example.com', []), false)
  assert.equal(originMatches('https://evil.example.com', 'dsh.example.com', ['https://dsh.example.com']), false)

  // In the allowlist but addressed to a different Host: still rejected.
  assert.equal(originMatches('https://dsh.example.com', 'other.example.com', ['https://dsh.example.com']), false)

  // Port mismatch is not the same authority and is rejected.
  assert.equal(originMatches('https://dsh.example.com:8443', 'dsh.example.com', []), false)
  assert.equal(originMatches('https://dsh.example.com', 'dsh.example.com:8443', []), false)
  // An explicit scheme-default port still names the same authority.
  assert.equal(originMatches('https://dsh.example.com', 'dsh.example.com:443', []), true)

  // Upstream semantics: the fence compares authorities, not schemes, so a
  // scheme difference on the same host[:port] is not caught here. The gateway
  // handles transport separately via `requireHttps` / `isSecureRequest`.
  assert.equal(originMatches('http://dsh.example.com', 'dsh.example.com', []), true)

  // Malformed Origin fails closed.
  assert.equal(originMatches('null', 'dsh.example.com', []), false)
  assert.equal(originMatches('', 'dsh.example.com', []), false)
})

test('policy: parseList splits comma lists and preserves absence', () => {
  assert.equal(parseList(undefined), undefined)
  assert.deepEqual(parseList('a, b ,,c'), ['a', 'b', 'c'])
  assert.deepEqual(parseList(''), [])
})

// ---------------------------------------------------------------------------
// totp
// ---------------------------------------------------------------------------

test('totp: base32 round-trips and matches RFC 4648 vectors', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
  assert.equal(base32Decode('MZXW6YTBOI').toString('utf8'), 'foobar')
  assert.equal(base32Decode('mzxw 6ytb-oi====').toString('utf8'), 'foobar')
  assert.equal(base32Decode('not base32!'), null)
  assert.equal(base32Decode(''), null)
  assert.equal(base32Decode(12345), null)

  const generated = generateTotpSecret()
  assert.match(generated, /^[A-Z2-7]+$/u)
  assert.equal(base32Decode(generated).length, 20)
  assert.equal(TOTP_PERIOD_SECONDS_VALUE, 30)
  assert.equal(TOTP_DIGITS, 6)
})

test('totp: matches the RFC 6238 SHA-1 vector at T=59 (6-digit truncation)', () => {
  // RFC 6238 SHA-1 secret "12345678901234567890" in base32.
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  // RFC's 8-digit value at T=59 is 94287082; 6-digit truncation keeps 287082.
  assert.equal(totpCode(secret, 59_000), '287082')
  assert.equal(totpCode(secret, 1_111_111_109_000), '081804')
})

test('totp: accepts the current code and rejects wrong/malformed input', () => {
  const secret = generateTotpSecret()
  const now = 1_700_000_000_000
  const code = totpCode(secret, now)
  assert.match(code, /^\d{6}$/u)
  assert.equal(verifyTotp(secret, code, now), true)

  const wrong = code === '000000' ? '111111' : '000000'
  assert.equal(verifyTotp(secret, wrong, now), false)
  assert.equal(verifyTotp(secret, '', now), false)
  assert.equal(verifyTotp(secret, '12345', now), false)
  assert.equal(verifyTotp(secret, 'abcdef', now), false)
  assert.equal(verifyTotp(secret, undefined, now), false)
  assert.equal(verifyTotp('not-a-secret', code, now), false)
})

test('totp: verifies across a ±1 step window and rejects ±2', () => {
  const secret = generateTotpSecret()
  const now = 1_700_000_000_000
  const step = TOTP_PERIOD_SECONDS_VALUE * 1000

  assert.equal(verifyTotp(secret, totpCode(secret, now - step), now), true, 'previous step')
  assert.equal(verifyTotp(secret, totpCode(secret, now), now), true, 'current step')
  assert.equal(verifyTotp(secret, totpCode(secret, now + step), now), true, 'next step')
  assert.equal(verifyTotp(secret, totpCode(secret, now - 2 * step), now), false, 'two steps back')
  assert.equal(verifyTotp(secret, totpCode(secret, now + 2 * step), now), false, 'two steps ahead')
})

test('totp: tolerates spaces and dashes in the submitted code', () => {
  const secret = generateTotpSecret()
  const now = 1_700_000_000_000
  const code = totpCode(secret, now)
  const formatted = `${code.slice(0, 3)} ${code.slice(3)}`
  assert.equal(verifyTotp(secret, formatted, now), true)
})

// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

test('credentials: hash is salted, verifiable and never the plaintext', withTempHome(async () => {
  const password = 'correct horse battery staple'
  const first = hashPassword(password)
  const second = hashPassword(password)
  assert.notEqual(first.salt, second.salt, 'salt must be random per call')
  assert.notEqual(first.hash, second.hash, 'same password, different hash')
  assert.equal(first.hash.includes(password), false)
  assert.equal(Buffer.from(first.salt, 'base64').length, 16)

  const record = {
    version: CREDENTIALS_VERSION,
    username: 'admin',
    salt: first.salt,
    hash: first.hash,
    authEpoch: 1,
    totpSecret: '',
    twoFactorEnabled: false,
    updatedAt: 0,
  }
  assert.equal(verifyPassword(password, record), true)
  assert.equal(verifyPassword('wrong password', record), false)
  assert.equal(verifyPassword('', record), false)
}))

test('credentials: verifyPassword never throws on malformed records', () => {
  for (const record of [
    undefined,
    null,
    {},
    { version: 99, salt: 'AAAA', hash: 'AAAA' },
    { version: CREDENTIALS_VERSION, salt: '', hash: '' },
    { version: CREDENTIALS_VERSION, salt: 'not base64!', hash: 'AAAA' },
    { version: CREDENTIALS_VERSION, salt: Buffer.from('s').toString('base64'), hash: Buffer.from('short').toString('base64') },
  ]) {
    assert.equal(verifyPassword('anything', record), false)
  }
})

test('credentials: readCredentials returns undefined before the first write', withTempHome(async () => {
  assert.equal(readCredentials(), undefined)
  assert.equal(effectiveCredentials({ username: 'admin', password: 'p' }).hasPassword, true)
}))

test('credentials: write then read round-trips and stores no plaintext', withTempHome(async () => {
  const password = 'super-secret-password'
  const { salt, hash } = hashPassword(password)
  writeCredentials({
    version: CREDENTIALS_VERSION,
    username: 'alice',
    salt,
    hash,
    authEpoch: 3,
    totpSecret: '',
    twoFactorEnabled: false,
    updatedAt: 1,
  })

  const record = readCredentials()
  assert.equal(record.username, 'alice')
  assert.equal(record.authEpoch, 3)
  assert.equal(record.version, CREDENTIALS_VERSION)

  // Nothing on disk may contain the plaintext.
  const raw = readFileSync(stateFile('credentials.json'), 'utf8')
  assert.equal(raw.includes(password), false)
  assert.equal(JSON.parse(raw).username, 'alice')
}))

test('credentials: seedCredentials creates once and is idempotent', withTempHome(async () => {
  const seeded = seedCredentials({ username: 'admin', password: 'first-password' })
  assert.equal(seeded.username, 'admin')
  assert.equal(seeded.authEpoch, 1)
  assert.equal(verifyPassword('first-password', seeded), true)

  const again = seedCredentials({ username: 'other', password: 'different-password' })
  assert.deepEqual(again, seeded, 'an existing record must not be overwritten')
  assert.equal(verifyPassword('different-password', again), false)
}))

test('credentials: changePassword bumps authEpoch and rotates the hash', withTempHome(async () => {
  const seeded = seedCredentials({ username: 'admin', password: 'old-password-1' })

  const updated = changePassword('old-password-1', 'new-password-2')
  assert.equal(updated.authEpoch, seeded.authEpoch + 1)
  assert.notEqual(updated.salt, seeded.salt)
  assert.equal(verifyPassword('new-password-2', updated), true)
  assert.equal(verifyPassword('old-password-1', updated), false)

  const epochAfterSecond = changePassword('new-password-2', 'third-password-3').authEpoch
  assert.equal(epochAfterSecond, seeded.authEpoch + 2)
}))

test('credentials: changePassword rejects a wrong current password and short new ones', withTempHome(async () => {
  seedCredentials({ username: 'admin', password: 'old-password-1' })
  assert.throws(() => changePassword('nope', 'new-password-2'), /current password is incorrect/u)
  assert.throws(() => changePassword('old-password-1', 'short'), /at least 8/u)
}))

test('credentials: changePassword can seed from a Config password when no record exists', withTempHome(async () => {
  assert.equal(readCredentials(), undefined)
  const updated = changePassword('config-password', 'brand-new-password', 'config-password')
  assert.equal(updated.authEpoch, 1)
  assert.equal(verifyPassword('brand-new-password', updated), true)
}))

test('credentials: effectiveCredentials merges file > config > environment', withTempHome(async () => {
  // Environment only.
  process.env.AUTH_USER = 'env-user'
  process.env.AUTH_PASS = 'env-pass'
  let effective = effectiveCredentials({})
  assert.equal(effective.username, 'env-user')
  assert.equal(effective.hasPassword, true)
  assert.equal(effective.source, 'environment')

  // Config outranks the environment.
  effective = effectiveCredentials({ username: 'cfg-user', password: 'cfg-pass', realm: 'My Realm' })
  assert.equal(effective.username, 'cfg-user')
  assert.equal(effective.realm, 'My Realm')
  assert.equal(effective.source, 'config')

  // The file outranks both.
  seedCredentials({ username: 'file-user', password: 'file-password' })
  effective = effectiveCredentials({ username: 'cfg-user', password: 'cfg-pass' })
  assert.equal(effective.username, 'file-user')
  assert.equal(effective.hasPassword, true)
  assert.equal(effective.source, 'file')
  assert.equal(effective.authEpoch, 1)

  // A 2FA secret in Config still applies when the file has not enrolled.
  effective = effectiveCredentials({ twoFactorSecret: generateTotpSecret() })
  assert.equal(effective.twoFactorEnabled, true)
  assert.notEqual(effective.twoFactorSecret, '')
}))

test('credentials: setTwoFactor bumps the epoch only on a real change', withTempHome(async () => {
  const seeded = seedCredentials({ username: 'admin', password: 'old-password-1' })
  const secret = generateTotpSecret()

  const enrolled = setTwoFactor({ secret, enabled: true })
  assert.equal(enrolled.twoFactorEnabled, true)
  assert.equal(enrolled.totpSecret, secret)
  assert.equal(enrolled.authEpoch, seeded.authEpoch + 1)

  const unchanged = setTwoFactor({ secret, enabled: true })
  assert.equal(unchanged.authEpoch, enrolled.authEpoch)
}))

test('credentials: effectiveCredentials defaults the username and realm', withTempHome(async () => {
  const effective = effectiveCredentials({})
  assert.equal(effective.username, 'admin')
  assert.equal(effective.realm, 'DeepSeek Harness Authentication')
  assert.equal(effective.hasPassword, false)
  assert.equal(effective.authEpoch, 0)
  assert.equal(effective.source, 'none')
}))

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

function sessionStore(dir, options = {}) {
  return new SessionStore({ file: join(dir, 'sessions.json'), maxAgeSeconds: 3600, idleTimeoutSeconds: 600, ...options })
}

test('sessions: create / verify / revoke', withTempDir((dir) => {
  const store = sessionStore(dir)
  const created = store.create('Mozilla/5.0', '192.168.55.30')

  assert.match(created.id, SESSION_ID_PATTERN)
  assert.equal(created.id.length, 22)
  assert.equal(typeof created.csrf, 'string')
  assert.equal(created.csrf.length > 20, true)
  // The returned object carries no bearer beyond the one-time id.
  assert.deepEqual(Object.keys(created).sort(), ['csrf', 'id'])

  assert.equal(store.verify(created.id, 0), true)
  store.touch(created.id)
  assert.equal(store.verify(created.id, 0), true)

  const listed = store.list()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, created.id)
  assert.equal(listed[0].address, '192.168.55.30')
  assert.equal('hmac' in listed[0], false, 'list() must not expose the integrity digest')
  assert.equal('csrf' in listed[0], false, 'list() must not expose the CSRF token')

  assert.equal(store.revoke(created.id), true)
  assert.equal(store.revoke(created.id), false)
  assert.equal(store.verify(created.id, 0), false)
  assert.deepEqual(store.list(), [])
  store.dispose()
}))

test('sessions: verify fails closed on unknown or malformed ids', withTempDir((dir) => {
  const store = sessionStore(dir)
  assert.equal(store.verify('unknown', 0), false)
  assert.equal(store.verify('', 0), false)
  assert.equal(store.verify('too-short', 0), false)
  assert.equal(store.verify('!!!!!!!!!!!!!!!!!!!!!!', 0), false)
  assert.equal(store.verify(undefined, 0), false)
  store.dispose()
}))

test('sessions: absolute maxAge expiry', withTempDir((dir) => {
  let clock = 1_700_000_000_000
  const store = sessionStore(dir, { maxAgeSeconds: 60, idleTimeoutSeconds: 0, now: () => clock })
  const created = store.create('ua', '127.0.0.1')

  assert.equal(store.verify(created.id, 0), true)
  clock += 59_000
  assert.equal(store.verify(created.id, 0), true)
  clock += 2_000
  assert.equal(store.verify(created.id, 0), false, 'absolute lifetime must end the session')
  assert.deepEqual(store.list(), [])
  store.dispose()
}))

test('sessions: idle timeout expires a session that stops being touched', withTempDir((dir) => {
  let clock = 1_700_000_000_000
  const store = sessionStore(dir, { maxAgeSeconds: 86_400, idleTimeoutSeconds: 60, now: () => clock })
  const created = store.create('ua', '127.0.0.1')

  clock += 30_000
  store.touch(created.id)
  clock += 50_000
  assert.equal(store.verify(created.id, 0), true, 'touching must extend the idle window')

  clock += 61_000
  assert.equal(store.verify(created.id, 0), false, 'no activity for the idle window must expire it')
  store.dispose()
}))

test('sessions: an authEpoch change invalidates every existing session', withTempDir((dir) => {
  const store = sessionStore(dir, { authEpoch: 1 })
  const created = store.create('ua', '127.0.0.1')
  assert.equal(store.verify(created.id, 1), true)
  assert.equal(store.verify(created.id, 2), false, 'epoch mismatch must fail')
  assert.equal(store.verify(created.id, 0), false, 'older epoch must fail')

  store.authEpoch = 2
  assert.equal(store.verify(created.id), false, 'default epoch follows the store')
  const fresh = store.create('ua', '127.0.0.1')
  assert.equal(store.verify(fresh.id, 2), true)
  store.dispose()
}))

test('sessions: revokeAll reports the count and empties the registry', withTempDir((dir) => {
  const store = sessionStore(dir)
  store.create('a', '127.0.0.1')
  store.create('b', '127.0.0.1')
  store.create('c', '127.0.0.1')
  assert.equal(store.size, 3)
  assert.equal(store.revokeAll(), 3)
  assert.equal(store.size, 0)
  assert.equal(store.revokeAll(), 0)
  store.dispose()
}))

test('sessions: no bearer token is written to disk', withTempDir((dir) => {
  const store = sessionStore(dir)
  const created = store.create('Mozilla/5.0', '192.168.55.30')
  store.persist()

  const raw = readPrivateFile(join(dir, 'sessions.json'))
  assert.equal(typeof raw, 'string')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.version, SESSION_STORE_VERSION)
  assert.equal(parsed.sessions.length, 1)

  const record = parsed.sessions[0]
  assert.equal(record.id, created.id)
  for (const forbidden of ['token', 'csrf', 'password', 'bearer', 'cookie']) {
    assert.equal(JSON.stringify(record).toLowerCase().includes(`"${forbidden}"`), false)
  }
  // The CSRF value handed to the browser must not be recoverable from disk.
  assert.equal(raw.includes(created.csrf), false)
  store.dispose()
}))

test('sessions: reload preserves live sessions and drops tampered or revoked ones', withTempDir((dir) => {
  let clock = 1_700_000_000_000
  const file = join(dir, 'sessions.json')
  const store = new SessionStore({ file, maxAgeSeconds: 3600, idleTimeoutSeconds: 0, now: () => clock })
  const kept = store.create('ua', '127.0.0.1')
  const doomed = store.create('ua', '127.0.0.1')
  store.revoke(doomed.id)
  store.persist()

  // Tamper: clone a record under a new id without recomputing the HMAC. The
  // cloned `hmac` no longer covers the new id, so the record must be rejected.
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  parsed.sessions.push({ ...parsed.sessions[0], id: 'AAAAAAAAAAAAAAAAAAAAAA' })
  writeFileSync(file, JSON.stringify(parsed), 'utf8')

  clock += 1_000
  const reloaded = new SessionStore({ file, maxAgeSeconds: 3600, idleTimeoutSeconds: 0, now: () => clock })
  assert.equal(reloaded.verify(kept.id, 0), true, 'valid sessions survive a restart')
  assert.equal(reloaded.verify(doomed.id, 0), false, 'revoked sessions stay revoked')
  assert.equal(reloaded.verify('AAAAAAAAAAAAAAAAAAAAAA', 0), false, 'a tampered record is rejected')
  reloaded.dispose()
  store.dispose()
}))

test('sessions: a malformed state file loads as empty instead of throwing', withTempDir((dir) => {
  const file = join(dir, 'sessions.json')
  writeFileSync(file, '{not json', 'utf8')
  const store = new SessionStore({ file, maxAgeSeconds: 60, idleTimeoutSeconds: 0 })
  assert.equal(store.size, 0)
  assert.deepEqual(store.list(), [])
  const created = store.create('ua', '127.0.0.1')
  assert.equal(store.verify(created.id, 0), true)
  store.dispose()
}))

test('sessions: dispose persists and refuses further writes', withTempDir((dir) => {
  const store = sessionStore(dir)
  const created = store.create('ua', '127.0.0.1')
  store.dispose()
  assert.equal(store.verify(created.id, 0), false)

  const reopened = sessionStore(dir)
  assert.equal(reopened.verify(created.id, 0), true, 'dispose must persist before closing')
  reopened.dispose()
}))

test('sessions: a session minted without an epoch does not verify against a later epoch', withTempDir((dir) => {
  // Integration contract: CONTRACT.md 3.6 gives `create()` no epoch argument,
  // but `verify(id, authEpoch)` compares against it. A caller that forgets to
  // supply the epoch would otherwise mint sessions bound to epoch 0 that can
  // never verify once credentials have been seeded (authEpoch >= 1), which
  // presents as "login appears to succeed, then every request is anonymous".
  // Two supported wiring styles, both covered here:
  const viaConstructor = sessionStore(dir, { authEpoch: 1 })
  const constructed = viaConstructor.create('ua', '127.0.0.1')
  assert.equal(viaConstructor.verify(constructed.id, 1), true, 'constructor authEpoch is stamped on create()')
  viaConstructor.dispose()

  const viaArgument = sessionStore(dir, { file: join(dir, 'second.json') })
  const explicit = viaArgument.create('ua', '127.0.0.1', 1)
  assert.equal(viaArgument.verify(explicit.id, 1), true, 'explicit create() epoch is honoured')

  // Forgetting both keeps the record at epoch 0, which must fail closed.
  const forgotten = viaArgument.create('ua', '127.0.0.1')
  assert.equal(viaArgument.verify(forgotten.id, 1), false, 'an epoch-0 record must not verify under epoch 1')
  assert.equal(viaArgument.verify(forgotten.id, 0), true, 'an epoch-0 record only matches epoch 0')
  viaArgument.dispose()
}))

// ---------------------------------------------------------------------------
// cross-process restart — the exact shape of the 0.7.6 Windows failure
// ---------------------------------------------------------------------------

/**
 * 0.7.6 mounted on a cold `$DSH_HOME` and then rejected every later start,
 * because the *second* process was the first one to read an existing `.secret`
 * and its `stat().mode & 0o077` assertion never passes on Windows.
 *
 * This boots the credentials module twice in two separate processes against the
 * same state directory. Both must exit 0; a regression would fail the second.
 */
test('credentials: a second process can restart against existing state (0.7.6 regression)', withTempHome(async (home) => {
  const script = [
    `import { effectiveCredentials, readCredentials, seedCredentials } from ${JSON.stringify(
      new URL('../lib/credentials.js', import.meta.url).href,
    )}`,
    'const existing = readCredentials()',
    "if (existing === undefined) seedCredentials({ username: 'admin', password: 'boot-password' })",
    "const effective = effectiveCredentials({ username: 'admin', password: 'boot-password' })",
    "if (!effective.hasPassword) { console.error('no password in force'); process.exit(3) }",
    "if (effective.authEpoch !== 1) { console.error(`unexpected epoch ${effective.authEpoch}`); process.exit(4) }",
    "console.log(`epoch=${effective.authEpoch} source=${effective.source}`)",
  ].join('\n')

  const { spawnSync } = await import('node:child_process')
  const runs = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: home,
      env: { ...process.env, DSH_HOME: home, AUTH_USER: '', AUTH_PASS: '' },
      encoding: 'utf8',
      timeout: 60_000,
    })
    // A confined sandbox may be unable to spawn a child at all; skip rather
    // than report a false regression.
    if (result.error?.code === 'EPERM' || result.error?.code === 'ENOENT') return
    runs.push(result)
  }

  assert.equal(runs.length, 2)
  assert.equal(runs[0].status, 0, `first process failed: ${runs[0].stderr}`)
  assert.match(runs[0].stdout, /epoch=1/u)
  // The regression: on Windows the second start threw
  // "persistent session secret must be owner-readable only".
  assert.equal(runs[1].status, 0, `second process failed: ${runs[1].stderr}`)
  assert.match(runs[1].stdout, /source=file/u, 'the second start must read the record written by the first')
  assert.equal(runs[1].stderr.includes('owner-readable only'), false)
  assert.equal(runs[1].stderr.includes('permission'), false)
}))
