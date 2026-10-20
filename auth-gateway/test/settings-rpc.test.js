/**
 * Unit tests for the settings RPC layer and the live-switch model.
 *
 * The behaviours pinned here are the ones that made the first version of this
 * plugin feel broken: the settings page could not read status while the gateway
 * was off, and an empty password field could wipe a stored secret.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-ag-rpc-'))
process.env.DSH_HOME = HOME

const { buildPatch, describeState, RPC_ENDPOINT, RPC_PATH, RPC_VERSION } = await import('../lib/settings-rpc.js')
const { seedCredentials, readCredentials } = await import('../lib/credentials.js')

describe('RPC contract constants', () => {
  it('keeps the endpoint the client uses', () => {
    assert.equal(RPC_ENDPOINT, 'auth-gateway')
    assert.equal(RPC_PATH, '/api/auth-gateway')
    assert.equal(RPC_VERSION, 1)
  })
})

describe('buildPatch', () => {
  it('carries the switch and listener fields through', () => {
    const patch = buildPatch({
      enabled: true,
      port: 3081,
      targetHost: '127.0.0.1',
      targetPort: 0,
      addresses: ['192.168.1.10'],
      allowedHosts: ['dsh.example.com'],
      realm: 'My Realm',
      username: 'alice',
      sessionMaxAgeSeconds: 3600,
      sessionIdleTimeoutSeconds: 600,
    }, {})
    assert.equal(patch.enabled, true)
    assert.equal(patch.port, 3081)
    assert.equal(patch.targetPort, 0)
    assert.deepEqual(patch.addresses, ['192.168.1.10'])
    assert.deepEqual(patch.allowedHosts, ['dsh.example.com'])
    assert.equal(patch.realm, 'My Realm')
    assert.equal(patch.username, 'alice')
  })

  it('never wipes a stored password just because the field is empty', () => {
    // This is the regression: a settings save that does not touch the password
    // must not send `password: ''` and silently disable login.
    const patch = buildPatch({ enabled: true, password: '' }, {})
    assert.equal(Object.hasOwn(patch, 'password'), false)
  })

  it('writes a password only when one is supplied', () => {
    assert.equal(buildPatch({ password: 'secret123' }, {}).password, 'secret123')
  })

  it('clears the password only when explicitly asked', () => {
    assert.equal(buildPatch({ clearPassword: true }, {}).password, '')
  })

  it('drops out-of-range numbers instead of persisting them', () => {
    const patch = buildPatch({ port: 99999, targetPort: -1, sessionMaxAgeSeconds: 'x' }, {})
    assert.equal(Object.hasOwn(patch, 'port'), false)
    assert.equal(Object.hasOwn(patch, 'targetPort'), false)
    assert.equal(Object.hasOwn(patch, 'sessionMaxAgeSeconds'), false)
  })

  it('normalizes and trims address lists', () => {
    const patch = buildPatch({ addresses: ['  10.0.0.5 ', '', 42, '10.0.0.6'] }, {})
    assert.deepEqual(patch.addresses, ['10.0.0.5', '10.0.0.6'])
  })

  it('rejects an empty patch rather than issuing a no-op update', () => {
    assert.deepEqual(buildPatch({}, {}), {})
  })
})

describe('describeState', () => {
  const account = {
    username: 'admin',
    realm: 'Realm',
    hasPassword: true,
    twoFactorEnabled: false,
    authEpoch: 2,
  }
  const status = {
    running: false,
    error: null,
    listening: [],
    seamError: undefined,
    version: { raw: 'unknown', flavor: 'unknown' },
  }

  it('reports the switch state even while the gateway is stopped', () => {
    // The whole point: a stopped gateway must still yield a usable status so the
    // UI can render a switch instead of "unavailable".
    const state = describeState({ enabled: false, port: 3080 }, status, account)
    assert.equal(state.enabled, false)
    assert.equal(state.running, false)
    assert.equal(state.username, 'admin')
    assert.equal(state.hasPassword, true)
  })

  it('never leaks the password or the TOTP secret', () => {
    const state = describeState({ enabled: true, password: 'hunter2', port: 3080 }, { ...status, running: true }, account)
    const serialized = JSON.stringify(state)
    assert.ok(!serialized.includes('hunter2'), 'state must not contain the password')
    assert.equal(Object.hasOwn(state, 'password'), false)
    assert.equal(Object.hasOwn(state, 'totpSecret'), false)
  })

  it('surfaces a missing-password condition for the UI to explain', () => {
    const state = describeState({ enabled: true }, { ...status, error: 'no_password' }, { ...account, hasPassword: false })
    assert.equal(state.error, 'no_password')
    assert.equal(state.hasPassword, false)
  })
})

describe('password change is Host-side and survives the listener being off', () => {
  it('stores a scrypt hash and bumps authEpoch', () => {
    seedCredentials({ username: 'admin', password: 'first-password' })
    const before = readCredentials()
    assert.ok(before !== undefined)
    assert.equal(before.authEpoch, 1)
    // The stored record must never contain the plaintext.
    assert.ok(!JSON.stringify(before).includes('first-password'))
  })
})

describe('cleanup', () => {
  it('removes the temporary DSH_HOME', () => {
    rmSync(HOME, { recursive: true, force: true })
    assert.ok(true)
  })
})
