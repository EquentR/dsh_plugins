/**
 * Unit tests for the gateway's page-internal directory picker.
 *
 * These cover the two halves the gateway owns: the document splice that defines
 * `__DSH_DIRECTORY_PICKER__` and the host filesystem primitives behind its
 * routes. The end-to-end route behaviour lives in gateway.e2e.test.js.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CARRIER_PICKER_GLOBAL,
  CARRIER_PICKER_SCRIPT,
  CarrierPickerError,
  PICKER_ROUTES,
  createDirectory,
  fullyQualified,
  injectCarrierPicker,
  listDirectory,
} from '../lib/carrier-picker.js'

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-carrier-picker-'))
  mkdirSync(join(root, 'alpha'))
  mkdirSync(join(root, 'zeta'))
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, 'note.txt'), 'not a directory')
  return {
    root,
    cleanup() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

describe('fullyQualified', () => {
  it('accepts drive-qualified and complete UNC paths on Windows', () => {
    assert.equal(fullyQualified('C:\\Users\\demo', 'win32'), true)
    assert.equal(fullyQualified('c:/Users/demo', 'win32'), true)
    assert.equal(fullyQualified('\\\\server\\share\\demo', 'win32'), true)
  })

  it('rejects rooted drive-less and incomplete UNC paths on Windows', () => {
    assert.equal(fullyQualified('\\foo', 'win32'), false)
    assert.equal(fullyQualified('/foo', 'win32'), false)
    assert.equal(fullyQualified('\\\\', 'win32'), false)
    assert.equal(fullyQualified('\\\\server', 'win32'), false)
    assert.equal(fullyQualified('relative\\dir', 'win32'), false)
  })

  it('accepts only absolute paths on POSIX', () => {
    assert.equal(fullyQualified('/home/demo', 'linux'), true)
    assert.equal(fullyQualified('home/demo', 'linux'), false)
  })
})

describe('document splice', () => {
  it('defines the carrier global before the rest of the head', () => {
    const html = '<html><head><meta charset="utf-8"></head><body>core</body></html>'
    const output = injectCarrierPicker(html)
    assert.ok(output.startsWith('<html><head><script>(function () {'), output.slice(0, 80))
    assert.ok(output.includes(`${CARRIER_PICKER_GLOBAL} = { pick: pick };`))
    assert.ok(output.includes(PICKER_ROUTES.list))
    assert.ok(output.includes(PICKER_ROUTES.mkdir))
  })

  it('leaves a document without a head untouched', () => {
    const html = '<html><body>no head</body></html>'
    assert.equal(injectCarrierPicker(html), html)
  })

  it('keeps a real carrier authoritative', () => {
    // The desktop shell's preload already defines the global; the injected
    // script must be a no-op there, which it enforces at runtime.
    assert.match(CARRIER_PICKER_SCRIPT, /if \(g\.__DSH_DIRECTORY_PICKER__ !== void 0\) return;/u)
  })

  it('is safe to inline in an HTML script element', () => {
    assert.ok(!CARRIER_PICKER_SCRIPT.includes('</script>'))
    assert.ok(!CARRIER_PICKER_SCRIPT.includes('<!--'))
  })

  it('is syntactically valid JavaScript after template interpolation', () => {
    // A stray backslash in the template literal would be consumed by the
    // template before the browser ever sees it (a real bug caught here once).
    assert.doesNotThrow(() => new Function(CARRIER_PICKER_SCRIPT))
  })
})

describe('listDirectory', () => {
  it('lists child directories with paths, hidden flags and crumbs', async () => {
    const fixture = workspace()
    try {
      const listing = await listDirectory(fixture.root)
      assert.equal(listing.path, resolve(fixture.root))
      assert.ok(listing.home.length > 0)
      assert.equal(listing.truncated, false)
      assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ['.hidden', 'alpha', 'zeta'])
      assert.equal(listing.entries.find((entry) => entry.name === '.hidden').hidden, true)
      assert.equal(listing.entries.find((entry) => entry.name === 'alpha').path, join(resolve(fixture.root), 'alpha'))
      assert.equal(listing.crumbs.at(-1).path, resolve(fixture.root))
      assert.ok(listing.crumbs.length >= 2, 'crumbs start at the filesystem root')
    } finally {
      fixture.cleanup()
    }
  })

  it('never lists plain files', async () => {
    const fixture = workspace()
    try {
      const listing = await listDirectory(fixture.root)
      assert.ok(listing.entries.every((entry) => entry.name !== 'note.txt'))
    } finally {
      fixture.cleanup()
    }
  })

  it('reports truncated levels', async () => {
    const fixture = workspace()
    try {
      const listing = await listDirectory(fixture.root, { maxEntries: 1 })
      assert.equal(listing.truncated, true)
      assert.equal(listing.entries.length, 1)
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a relative path', async () => {
    await assert.rejects(() => listDirectory('relative'), (error) => {
      assert.ok(error instanceof CarrierPickerError)
      assert.equal(error.code, 'bad-request')
      return true
    })
  })

  it('reports an unreadable directory', async () => {
    const fixture = workspace()
    try {
      const missing = join(fixture.root, 'missing')
      await assert.rejects(() => listDirectory(missing), (error) => {
        assert.ok(error instanceof CarrierPickerError)
        assert.equal(error.code, 'directory-unreadable')
        return true
      })
    } finally {
      fixture.cleanup()
    }
  })
})

describe('createDirectory', () => {
  it('creates one child directory and returns its absolute path', async () => {
    const fixture = workspace()
    try {
      const created = await createDirectory(fixture.root, 'new-folder')
      assert.equal(created, join(resolve(fixture.root), 'new-folder'))
      const listing = await listDirectory(fixture.root)
      assert.ok(listing.entries.some((entry) => entry.name === 'new-folder'))
    } finally {
      fixture.cleanup()
    }
  })

  it('reports an existing name as a conflict', async () => {
    const fixture = workspace()
    try {
      await assert.rejects(() => createDirectory(fixture.root, 'alpha'), (error) => {
        assert.ok(error instanceof CarrierPickerError)
        assert.equal(error.code, 'directory-exists')
        return true
      })
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses names that are not one path segment', async () => {
    const fixture = workspace()
    try {
      for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b']) {
        await assert.rejects(() => createDirectory(fixture.root, name), (error) => {
          assert.ok(error instanceof CarrierPickerError)
          assert.equal(error.code, 'bad-request')
          return true
        })
      }
    } finally {
      fixture.cleanup()
    }
  })

  it('refuses a relative parent path', async () => {
    await assert.rejects(() => createDirectory('relative', 'child'), (error) => {
      assert.ok(error instanceof CarrierPickerError)
      assert.equal(error.code, 'bad-request')
      return true
    })
  })
})
