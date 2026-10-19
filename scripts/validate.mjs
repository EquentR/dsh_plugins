#!/usr/bin/env node
// Repository validation for every plugin in this collection.
//
// Three kinds of deliverable live here, and each gets the check that actually applies:
//
//   * persistent bundles (git-graph, delete-session, mentor) — real npm-shaped
//     packages. Checked: package.json parses, `dsh.bundle.patch` is declared,
//     every `files[]` entry exists, the bundle patch inserts exactly one Loader
//     row named after the package, the Client module id equals the package name,
//     every JS file parses as an ES module, and each locale carries meta.title
//     and meta.description.
//   * agent-preset bundles (obedient-preset) — real npm-shaped packages whose
//     single inserted row is a `@deepseek-ai/dsh-agent-preset` declaration
//     instead of a plugin named after the package. Checked: package.json
//     parses, `dsh.bundle.patch` is declared, every `files[]` entry exists, and
//     the patch inserts exactly one `@deepseek-ai/dsh-agent-preset` row whose
//     `config` block declares an id and a display name.
//   * dynamic-plugin function bodies (model-capabilities) — pasted into
//     `cordis_define` as `code.host` / `code.client`. Checked by compiling them
//     as a function body, which is exactly how the Harness consumes them.
//
// Nothing is imported or executed. Usage: node scripts/validate.mjs

import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BUNDLES = ['git-graph', 'delete-session', 'mentor']
const PRESETS = ['obedient-preset']
const FUNCTION_BODIES = ['model-capabilities']
const AGENT_PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

const failures = []
const notes = []
const fail = (message) => failures.push(message)
const label = (path) => relative(ROOT, path).replaceAll('\\', '/')

async function readOptional(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function exists(path) {
  return stat(path).then(() => true, () => false)
}

/** Collect every .js/.mjs file below a directory, skipping node_modules. */
async function collectJs(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return out
    throw error
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await collectJs(path))
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(path)
  }
  return out
}

// Node's own parser decides module validity; nothing is imported or executed.
// A scratch `.mjs` copy avoids the CommonJS goal that `--check file.js` assumes.
const scratch = await mkdtemp(join(tmpdir(), 'dsh-plugins-validate-'))
let scratchIndex = 0

async function parsesAsModule(file) {
  const copy = join(scratch, `m${scratchIndex += 1}.mjs`)
  await copyFile(file, copy)
  const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
  const message = (result.stderr || '').trim().split('\n').find((line) => line.includes('Error')) ?? ''
  return { ok: result.status === 0, message }
}

/**
 * Validate the Loader patch subset this repository uses: one top-level
 * `- insert:` sequence whose entries carry `id` / `name` / `inject` / `config`.
 * Anything outside that shape is reported rather than silently skipped.
 */
function parsePatchRows(text) {
  const rows = []
  let insertIndent = null
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (trimmed === '- insert:') {
      insertIndent = indent
      current = null
      continue
    }
    if (insertIndent === null) continue
    if (indent <= insertIndent) {
      insertIndent = null
      current = null
      continue
    }
    const idMatch = /^-\s+id:\s*(.+)$/.exec(trimmed)
    if (idMatch !== null) {
      current = { id: idMatch[1].replace(/^['"]|['"]$/g, ''), name: undefined }
      rows.push(current)
      continue
    }
    const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
    if (nameMatch !== null && current !== null && current.name === undefined) {
      current.name = nameMatch[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return rows
}

for (const pkg of BUNDLES) {
  const dir = join(ROOT, pkg)

  const manifestText = await readOptional(join(dir, 'package.json'))
  if (manifestText === undefined) {
    fail(`${pkg}: missing package.json`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    fail(`${pkg}: package.json is not valid JSON (${error.message})`)
    continue
  }

  if (typeof manifest?.name !== 'string' || !manifest.name.startsWith('@dsh-plugins/')) {
    fail(`${pkg}: package name must live under the @dsh-plugins scope, got ${JSON.stringify(manifest?.name)}`)
  }

  const patchPath = manifest?.dsh?.bundle?.patch
  if (typeof patchPath !== 'string') {
    fail(`${pkg}: package.json does not declare dsh.bundle.patch`)
  } else {
    const text = await readOptional(join(dir, patchPath))
    if (text === undefined) {
      fail(`${pkg}: bundle patch ${patchPath} does not exist`)
    } else {
      const rows = parsePatchRows(text)
      if (rows.length !== 1) fail(`${pkg}: bundle patch must insert exactly one Loader row, found ${rows.length}`)
      for (const row of rows) {
        if (row.name === undefined) fail(`${pkg}: patch row "${row.id}" has no name`)
        else if (row.name !== manifest.name) {
          fail(`${pkg}: patch row name "${row.name}" != package name "${manifest.name}"`)
        }
      }
    }
  }

  // A linked-directory install is not filtered by `files`, so a missing entry
  // means the manifest is already wrong rather than harmlessly over-declared.
  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    if (entry.includes('*')) continue
    if (!await exists(join(dir, entry.replace(/\/$/, '')))) {
      fail(`${pkg}: files[] entry does not exist: ${entry}`)
    }
  }

  const client = await readOptional(join(dir, 'client.js'))
  if (client === undefined) {
    note(`${pkg}: no client.js, Host-only bundle`)
  } else {
    const match = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(client)
    if (match === null) fail(`${pkg}: client.js does not register a __ModuleLoader__ id`)
    else if (match[1] !== manifest.name) {
      fail(`${pkg}: client module id "${match[1]}" != package name "${manifest.name}"`)
    }
  }

  for (const file of await collectJs(dir)) {
    const parsed = await parsesAsModule(file)
    if (!parsed.ok) fail(`${label(file)}: does not parse as an ES module ${parsed.message}`)
  }

  // Locale metadata is what the plugin inventory shows for an installed bundle.
  for (const locale of ['en', 'zh']) {
    const text = await readOptional(join(dir, 'locale', `${locale}.json`))
    if (text === undefined) {
      note(`${pkg}: no locale/${locale}.json`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      fail(`${pkg}: locale/${locale}.json is not valid JSON (${error.message})`)
      continue
    }
    for (const key of ['title', 'description']) {
      const value = parsed?.meta?.[key]
      if (typeof value !== 'string' || value.trim() === '') {
        fail(`${pkg}: locale/${locale}.json is missing meta.${key}`)
      }
    }
  }
}

/**
 * Read the declaration rows inserted by a preset bundle patch: the entries whose
 * `- id:` sits at the first indentation level below `- insert:`. Plugin entries
 * nested under `config.plugins` are deeper and are not rows of this patch.
 */
function parsePresetRows(text) {
  const rows = []
  let insertIndent = null
  let rowIndent = null
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (trimmed === '- insert:') {
      insertIndent = indent
      rowIndent = null
      current = null
      continue
    }
    if (insertIndent === null) continue
    if (indent <= insertIndent) {
      insertIndent = null
      current = null
      continue
    }
    const idMatch = /^-\s+id:\s*(.+)$/.exec(trimmed)
    if (idMatch !== null) {
      if (rowIndent === null) rowIndent = indent
      if (indent !== rowIndent) continue
      current = { id: idMatch[1].replace(/^['"]|['"]$/g, ''), name: undefined }
      rows.push(current)
      continue
    }
    const nameMatch = /^name:\s*(.+)$/.exec(trimmed)
    if (nameMatch !== null && current !== null && indent === rowIndent + 2 && current.name === undefined) {
      current.name = nameMatch[1].replace(/^['"]|['"]$/g, '')
    }
  }
  return rows
}

/**
 * Read the declaration fields directly under the inserted row's `config:` block.
 * Only `id` / `name` / `description` / `order` are needed to prove that the row
 * declares a preset rather than a bare plugin.
 */
function parsePresetConfig(text) {
  const fields = {}
  let rowIndent = null
  let configIndent = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (configIndent === null) {
      if (/^-\s+id:\s*(.+)$/.test(trimmed)) {
        if (rowIndent === null) rowIndent = indent
        continue
      }
      if (rowIndent !== null && indent > rowIndent && /^config:\s*$/.test(trimmed)) {
        configIndent = indent
      }
      continue
    }
    if (indent <= configIndent) break
    const field = /^(id|name|description|order):\s*(.+)$/.exec(trimmed)
    if (field !== null && fields[field[1]] === undefined) {
      fields[field[1]] = field[2].replace(/^['"]|['"]$/g, '')
    }
  }
  return fields
}

for (const pkg of PRESETS) {
  const dir = join(ROOT, pkg)

  const manifestText = await readOptional(join(dir, 'package.json'))
  if (manifestText === undefined) {
    fail(`${pkg}: missing package.json`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(manifestText)
  } catch (error) {
    fail(`${pkg}: package.json is not valid JSON (${error.message})`)
    continue
  }

  if (typeof manifest?.name !== 'string' || !manifest.name.startsWith('@dsh-plugins/')) {
    fail(`${pkg}: package name must live under the @dsh-plugins scope, got ${JSON.stringify(manifest?.name)}`)
  }

  const patchPath = manifest?.dsh?.bundle?.patch
  if (typeof patchPath !== 'string') {
    fail(`${pkg}: package.json does not declare dsh.bundle.patch`)
  } else {
    const text = await readOptional(join(dir, patchPath))
    if (text === undefined) {
      fail(`${pkg}: bundle patch ${patchPath} does not exist`)
    } else {
      const rows = parsePresetRows(text)
      if (rows.length !== 1) {
        fail(`${pkg}: bundle patch must insert exactly one declaration row, found ${rows.length}`)
      } else if (rows[0].name !== AGENT_PRESET_PLUGIN) {
        fail(`${pkg}: preset patch row name must be ${AGENT_PRESET_PLUGIN}, got ${JSON.stringify(rows[0].name)}`)
      }
      const declared = parsePresetConfig(text)
      if (declared.id === undefined || !/^[a-z0-9-]+$/.test(declared.id)) {
        fail(`${pkg}: preset config.id must be lowercase letters, digits and hyphens, got ${JSON.stringify(declared.id)}`)
      }
      if (declared.name === undefined || declared.name.trim() === '') {
        fail(`${pkg}: preset config.name is missing`)
      }
      if (declared.order !== undefined && !/^\d+$/.test(declared.order)) {
        fail(`${pkg}: preset config.order must be an integer, got ${JSON.stringify(declared.order)}`)
      }
    }
  }

  for (const entry of Array.isArray(manifest.files) ? manifest.files : []) {
    if (entry.includes('*')) continue
    if (!await exists(join(dir, entry.replace(/\/$/, '')))) {
      fail(`${pkg}: files[] entry does not exist: ${entry}`)
    }
  }
}

function note(message) {
  notes.push(message)
}

for (const pkg of FUNCTION_BODIES) {
  const dir = join(ROOT, pkg)

  const manifestText = await readOptional(join(dir, 'package.json'))
  if (manifestText === undefined) {
    fail(`${pkg}: missing package.json`)
    continue
  }
  try {
    JSON.parse(manifestText)
  } catch (error) {
    fail(`${pkg}: package.json is not valid JSON (${error.message})`)
  }

  for (const half of ['host.js', 'client.js']) {
    const source = await readOptional(join(dir, half))
    if (source === undefined) {
      fail(`${pkg}: missing ${half}`)
      continue
    }
    if (/^\s*(import|export)\s/m.test(source)) {
      fail(`${pkg}/${half}: a dynamic-plugin half is a function body and cannot use top-level import/export`)
      continue
    }
    try {
      // Compiling as a function body is exactly how the Harness consumes it;
      // nothing is called.
      new Function(source)
    } catch (error) {
      fail(`${pkg}/${half}: is not a valid function body (${error.message})`)
    }
  }
}

await rm(scratch, { recursive: true, force: true })

for (const message of notes) console.log(`note: ${message}`)
if (failures.length > 0) {
  for (const message of failures) console.error(`FAIL: ${message}`)
  console.error(`\n${failures.length} problem(s) found`)
  process.exit(1)
}
const total = BUNDLES.length + PRESETS.length + FUNCTION_BODIES.length
console.log(`validation passed: ${total} plugin(s) checked under ${resolve(ROOT)}`)
