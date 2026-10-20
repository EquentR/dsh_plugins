/**
 * Tests for Loader-entry-id discovery.
 *
 * The runtime id is NOT the id written in cordis.patch.yml: a row inserted
 * through an `include:` layer surfaces as `include:<patchId>` (verified against
 * the live desktop profile, where the patch says `dsh-auth-gateway` but
 * Config.listConfigs reports `include:dsh-auth-gateway`). `settings.update()`
 * keys on the runtime id, so guessing the patch id makes every save fail.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const { discoverNamespace, settingsNamespace } = await import('../lib/settings-rpc.js')

function ctxWith(configEditor, fiber = {}) {
  return {
    fiber,
    get(name) {
      if (name === 'configEditor') return configEditor
      return undefined
    },
  }
}

describe('discoverNamespace', () => {
  it('prefers the live entry id over the patch id', () => {
    const fiber = {}
    const ctx = ctxWith({
      entries: () => [
        { fiber: { other: true }, options: { id: 'some-other-row' } },
        { fiber, options: { id: 'include:dsh-auth-gateway' } },
      ],
    }, fiber)
    assert.equal(discoverNamespace(ctx), 'include:dsh-auth-gateway')
  })

  it('falls back to the composed configuration view', () => {
    const fiber = {}
    const ctx = ctxWith({
      configuration: () => [
        { entry: { id: 'include:dsh-auth-gateway', fiber }, inherited: {}, override: {} },
      ],
    }, fiber)
    assert.equal(discoverNamespace(ctx), 'include:dsh-auth-gateway')
  })

  it('accepts a bare `id` as well as `options.id`', () => {
    const fiber = {}
    const ctx = ctxWith({ entries: () => [{ id: 'include:dsh-auth-gateway', fiber }] }, fiber)
    assert.equal(discoverNamespace(ctx), 'include:dsh-auth-gateway')
  })

  it('returns undefined when the configEditor is missing', () => {
    assert.equal(discoverNamespace(ctxWith(undefined)), undefined)
  })

  it('returns undefined when no entry belongs to this fiber', () => {
    const ctx = ctxWith({ entries: () => [{ fiber: { other: true }, options: { id: 'x' } }] })
    assert.equal(discoverNamespace(ctx), undefined)
  })

  it('survives a throwing configEditor', () => {
    const ctx = ctxWith({
      entries() { throw new Error('boom') },
      configuration() { throw new Error('boom') },
    })
    assert.equal(discoverNamespace(ctx), undefined)
  })
})

describe('settingsNamespace', () => {
  it('returns the id with no reason when discovery succeeds', () => {
    const fiber = {}
    const ctx = ctxWith({ entries: () => [{ fiber, options: { id: 'include:dsh-auth-gateway' } }] }, fiber)
    const resolved = settingsNamespace(ctx)
    assert.equal(resolved.namespace, 'include:dsh-auth-gateway')
    assert.equal(resolved.reason, undefined)
  })

  it('returns a readable reason instead of silently guessing', () => {
    const resolved = settingsNamespace(ctxWith(undefined))
    assert.equal(resolved.namespace, undefined)
    assert.match(String(resolved.reason), /Loader entry id/)
  })
})
