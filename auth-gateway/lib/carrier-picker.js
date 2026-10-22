/**
 * Page-internal directory picker for browsers served through the gateway.
 *
 * ## Why this exists
 *
 * dsh picks its directory interaction once, at host boot:
 * `dsh-host-directory-picker-auto` resolves `native` when the Host is a
 * desktop platform bound to loopback with no remote-authority trust, and mounts
 * the native backend plus its renderless browser surface. On Windows the native
 * backend opens an `IFileOpenDialog` in a subprocess **on the Host machine**.
 *
 * That is correct for the desktop window, whose preload exposes
 * `__DSH_DIRECTORY_PICKER__` and answers with an Electron dialog. It is wrong
 * for a browser that reached the Host through this gateway: the browser has no
 * preload, so the native surface falls back to the Host RPC and the dialog pops
 * up on a screen the operator is not looking at. The npm reference deployment
 * sidesteps this by pinning the browse picker in its profile — but pinning it on
 * the desktop profile would also replace the desktop window's native dialog,
 * because both carriers share one client module table.
 *
 * The gateway is the carrier for remote browsers, so it supplies the missing
 * carrier fact itself: the authenticated document gets a tiny script that
 * defines `__DSH_DIRECTORY_PICKER__` (only when the page has none) backed by an
 * in-page directory browser. The browser talks to two gateway-owned routes for
 * listing and creating directories, so no upstream code, profile or client
 * bundle changes.
 *
 * ## Security
 *
 * Both routes run behind the gateway's fence and session authentication, which
 * is the same owner-level authority the proxied Workspace UI already has: the
 * gateway hands that page the Host's own core cookie. Listing is read-only;
 * creating a directory additionally requires the session's CSRF value. Paths
 * must be fully qualified, and a create name must be a single path segment.
 */

import { mkdir, opendir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'

/** Gateway-owned routes used by the injected picker. */
export const PICKER_ROUTES = Object.freeze({
  list: '/_dsh/auth-gateway/fs/list',
  mkdir: '/_dsh/auth-gateway/fs/mkdir',
})

/** Preload/carrier global the native client surface reads. */
export const CARRIER_PICKER_GLOBAL = '__DSH_DIRECTORY_PICKER__'

/** Bound on one listing level, mirrored from the browse backend's default. */
export const MAX_ENTRIES = 1000

const MAX_CREATE_NAME = 255

/**
 * A picker failure with the seam's closed vocabulary, so the routes can map it
 * onto an HTTP status without leaking filesystem internals.
 */
export class CarrierPickerError extends Error {
  /**
   * @param {'directory-unreadable' | 'directory-exists' | 'directory-create-failed'} code - closed code.
   * @param {string} path - the path the failure is about.
   * @param {string} message - operator-facing text.
   */
  constructor(code, path, message) {
    super(message)
    this.name = 'CarrierPickerError'
    this.code = code
    this.path = path
  }
}

/**
 * True when the path names one fixed filesystem location regardless of process
 * state: absolute on POSIX; drive-qualified or complete UNC on Windows. Rooted
 * drive-less forms (`\foo`, `/foo`) resolve against the current drive, so they
 * are rejected exactly like the browse backend rejects them.
 * @param {string} value - candidate path.
 * @param {string} [platform] - replaces `process.platform` for deterministic tests.
 * @returns {boolean} whether the path is fully qualified.
 */
export function fullyQualified(value, platform = process.platform) {
  return platform === 'win32'
    ? win32.isAbsolute(value) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/u.test(value)
    : posix.isAbsolute(value)
}

/** Ancestor chain from the filesystem root to `target` inclusive. */
function ancestryCrumbs(target) {
  const crumbs = []
  let current = target
  for (;;) {
    const parent = dirname(current)
    crumbs.unshift({ name: parent === current ? current : basename(current), path: current })
    if (parent === current) return crumbs
    current = parent
  }
}

/**
 * List one directory level for the page-internal picker.
 *
 * Entries are child directories only (the picker selects directories), sorted
 * by name and capped at {@link MAX_ENTRIES} with a `truncated` flag. Symlinks
 * are followed so a linked directory is enterable; broken links are skipped.
 *
 * @param {string | undefined} path - absolute directory; absent lists the home directory.
 * @param {{ maxEntries?: number }} [options] - listing bound.
 * @returns {Promise<{ path: string, home: string, crumbs: Array<{name: string, path: string}>, entries: Array<{name: string, path: string, hidden: boolean}>, truncated: boolean }>} the listing.
 */
export async function listDirectory(path, options = {}) {
  const maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : MAX_ENTRIES
  if (path !== undefined && (typeof path !== 'string' || !fullyQualified(path))) {
    throw new CarrierPickerError('bad-request', String(path), 'the directory path must be absolute')
  }
  const home = homedir()
  const target = resolve(path ?? home)
  const entries = []
  let truncated = false
  let level
  try {
    level = await opendir(target)
  } catch (error) {
    throw new CarrierPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
  }
  try {
    for (;;) {
      const dirent = await level.read()
      if (dirent === null) break
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue
      if (entries.length === maxEntries) {
        truncated = true
        break
      }
      const child = join(target, dirent.name)
      if (dirent.isSymbolicLink()) {
        try {
          const info = await stat(child)
          if (!info.isDirectory()) continue
        } catch {
          continue
        }
      }
      entries.push({ name: dirent.name, path: child, hidden: dirent.name.startsWith('.') })
    }
  } catch (error) {
    throw new CarrierPickerError('directory-unreadable', target, `cannot list ${target}: ${messageOf(error)}`)
  } finally {
    await level.close().catch(() => {})
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { path: target, home, crumbs: ancestryCrumbs(target), entries, truncated }
}

/**
 * Create one child directory for the page-internal picker.
 *
 * @param {string} path - absolute existing parent directory.
 * @param {string} name - a single non-blank path segment.
 * @returns {Promise<string>} the created absolute path.
 */
export async function createDirectory(path, name) {
  if (typeof path !== 'string' || !fullyQualified(path)) {
    throw new CarrierPickerError('bad-request', String(path), 'the parent path must be absolute')
  }
  if (typeof name !== 'string' || name.trim() === '' || name === '.' || name === '..'
    || name.length > MAX_CREATE_NAME || /[/\\]/u.test(name)) {
    throw new CarrierPickerError('bad-request', String(path), 'the folder name must be a single non-blank path segment')
  }
  const parent = resolve(path)
  const target = join(parent, name)
  try {
    await mkdir(target)
    return target
  } catch (error) {
    if (isCode(error, 'EEXIST')) {
      throw new CarrierPickerError('directory-exists', target, `${target} already exists`)
    }
    throw new CarrierPickerError('directory-create-failed', target, `cannot create ${target}: ${messageOf(error)}`)
  }
}

/** Whether an unknown rejection carries one Node error code. */
function isCode(error, code) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Message of an unknown rejection. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Insert the carrier script at the very start of `<head>`.
 *
 * The script must run before the client entry reads the carrier global, and
 * first-in-head guarantees that regardless of what the core injects later.
 * A document without a `<head>` is left untouched.
 *
 * @param {string} html - decoded document body.
 * @returns {string} the rewritten document.
 */
export function injectCarrierPicker(html) {
  const marker = /<head[^>]*>/iu.exec(html)
  if (marker === null) return html
  const at = marker.index + marker[0].length
  return `${html.slice(0, at)}<script>${CARRIER_PICKER_SCRIPT}</script>${html.slice(at)}`
}

/**
 * The injected carrier script.
 *
 * It never clobbers a real carrier: the desktop shell's preload already defines
 * `__DSH_DIRECTORY_PICKER__`, and a page that has one keeps it. The picker is a
 * self-contained modal (no framework, no external assets) that lists directories
 * through {@link PICKER_ROUTES} and resolves the operator's choice exactly like
 * the upstream browse surface: a path, or `null` on cancel.
 */
export const CARRIER_PICKER_SCRIPT = `(function () {
  var g = globalThis;
  if (g.${CARRIER_PICKER_GLOBAL} !== void 0) return;
  var ROUTES = ${JSON.stringify(PICKER_ROUTES)};
  var zh = String(navigator.language || 'en').toLowerCase().indexOf('zh') === 0;
  var TEXT = zh ? {
    title: '选择工作区目录',
    up: '上一级',
    home: '主目录',
    newFolder: '新建文件夹',
    namePlaceholder: '文件夹名称',
    create: '创建',
    cancel: '取消',
    open: '打开',
    hidden: '显示隐藏项',
    loading: '正在读取…',
    empty: '没有子文件夹',
    truncated: '条目过多，仅显示前 1000 个',
    pathPlaceholder: '输入绝对路径后按回车'
  } : {
    title: 'Choose a workspace folder',
    up: 'Up',
    home: 'Home',
    newFolder: 'New folder',
    namePlaceholder: 'Folder name',
    create: 'Create',
    cancel: 'Cancel',
    open: 'Open',
    hidden: 'Show hidden items',
    loading: 'Loading…',
    empty: 'No subfolders',
    truncated: 'Too many entries; showing the first 1000',
    pathPlaceholder: 'Type an absolute path and press Enter'
  };

  var CSS = ''
    + '.dsh-cp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;'
    + 'background:rgba(12,14,18,.48);font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
    + '.dsh-cp-dialog{width:min(680px,92vw);height:min(520px,84vh);display:flex;flex-direction:column;overflow:hidden;'
    + 'border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.45);background:#fff;color:#1c1f24;border:1px solid rgba(0,0,0,.12)}'
    + '.dsh-cp-dialog.dsh-cp-dark{background:#1d2026;color:#e6e9ef;border-color:rgba(255,255,255,.14)}'
    + '.dsh-cp-head{display:flex;align-items:center;gap:8px;padding:12px 14px 8px;font-weight:600;font-size:14px}'
    + '.dsh-cp-close{margin-left:auto;border:0;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;'
    + 'width:28px;height:28px;border-radius:6px}.dsh-cp-close:hover{background:rgba(127,127,127,.18)}'
    + '.dsh-cp-path{display:flex;gap:6px;padding:0 14px 8px}'
    + '.dsh-cp-path input{flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid rgba(127,127,127,.45);'
    + 'background:transparent;color:inherit;font:inherit}.dsh-cp-path input:focus{outline:2px solid #4c8dff;outline-offset:-1px}'
    + '.dsh-cp-btn{padding:6px 12px;border-radius:6px;border:1px solid rgba(127,127,127,.45);background:transparent;'
    + 'color:inherit;font:inherit;cursor:pointer;white-space:nowrap}.dsh-cp-btn:hover{background:rgba(127,127,127,.16)}'
    + '.dsh-cp-btn[disabled]{opacity:.5;cursor:default}'
    + '.dsh-cp-btn.dsh-cp-primary{background:#2f6fed;border-color:#2f6fed;color:#fff}'
    + '.dsh-cp-btn.dsh-cp-primary:hover{background:#2a63d4}'
    + '.dsh-cp-crumbs{display:flex;flex-wrap:wrap;gap:2px;padding:0 14px 8px;max-height:56px;overflow:auto}'
    + '.dsh-cp-crumb{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 4px;border-radius:4px;'
    + 'opacity:.8}.dsh-cp-crumb:hover{background:rgba(127,127,127,.16);opacity:1}'
    + '.dsh-cp-sep{opacity:.45;padding:2px 0}'
    + '.dsh-cp-list{flex:1;overflow:auto;margin:0 14px;border:1px solid rgba(127,127,127,.32);border-radius:8px;padding:4px}'
    + '.dsh-cp-row{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;cursor:pointer;user-select:none}'
    + '.dsh-cp-row:hover{background:rgba(127,127,127,.16)}'
    + '.dsh-cp-row[aria-selected="true"]{background:rgba(47,111,237,.18);box-shadow:inset 0 0 0 1px rgba(47,111,237,.55)}'
    + '.dsh-cp-icon{width:16px;height:16px;flex:none;opacity:.85}'
    + '.dsh-cp-empty,.dsh-cp-note{padding:10px 8px;opacity:.65}'
    + '.dsh-cp-create{display:flex;gap:6px;padding:8px 14px 0}'
    + '.dsh-cp-create[hidden]{display:none}'
    + '.dsh-cp-create input{flex:1;min-width:0;padding:6px 8px;border-radius:6px;'
    + 'border:1px solid rgba(127,127,127,.45);background:transparent;color:inherit;font:inherit}'
    + '.dsh-cp-foot{display:flex;align-items:center;gap:10px;padding:10px 14px}'
    + '.dsh-cp-foot label{display:flex;align-items:center;gap:5px;cursor:pointer;opacity:.85}'
    + '.dsh-cp-status{margin-left:auto;opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-cp-error{color:#d93a3a;padding:6px 14px 0;min-height:18px}'
    + '.dsh-cp-dialog.dsh-cp-dark .dsh-cp-error{color:#ff7b7b}';

  var FOLDER_SVG = '<svg class="dsh-cp-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" '
    + 'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';

  var state = { open: false, resolve: null, listing: null, selected: null, showHidden: false, busy: false }
  var dom = {}

  function element(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== void 0) node.textContent = text
    return node
  }

  function prefersDark() {
    try {
      var value = String(getComputedStyle(document.body).backgroundColor || '')
      if (value.indexOf('rgb') === 0) {
        var parts = value.replace(/[^0-9,.]/g, '').split(',')
        if (parts.length >= 3) {
          var luminance = (Number(parts[0]) * 0.299 + Number(parts[1]) * 0.587 + Number(parts[2]) * 0.114) / 255
          return luminance < 0.5
        }
      }
    } catch (error) {}
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch (error) {
      return false
    }
  }

  function cookieValue(name) {
    var parts = String(document.cookie || '').split(';')
    for (var index = 0; index < parts.length; index += 1) {
      var part = parts[index].trim()
      var equals = part.indexOf('=')
      if (equals > 0 && part.slice(0, equals) === name) return part.slice(equals + 1)
    }
    return ''
  }

  function csrfToken() {
    return cookieValue('dsh_gw_csrf') || cookieValue('__Host-dsh_gw_csrf')
  }

  function jsonRequest(url, init) {
    return fetch(url, init).then(function (response) {
      return response.json().catch(function () {
        throw new Error('gateway returned an invalid directory response')
      }).then(function (payload) {
        if (!payload || payload.ok !== true) {
          var failure = payload && payload.error ? payload.error : {}
          throw new Error(failure.message || 'directory request failed')
        }
        return payload
      })
    })
  }

  function setBusy(value) {
    state.busy = value
    if (dom.openButton) dom.openButton.disabled = value
    if (dom.upButton) dom.upButton.disabled = value
    if (dom.hiddenToggle) dom.hiddenToggle.disabled = value
    if (dom.newButton) dom.newButton.disabled = value
  }

  function setError(message) {
    if (!dom.error) return
    dom.error.textContent = message || ''
  }

  function setStatus(message) {
    if (dom.status) dom.status.textContent = message || ''
  }

  function load(path) {
    setError('')
    setStatus(TEXT.loading)
    setBusy(true)
    var url = ROUTES.list
    if (typeof path === 'string' && path !== '') url += '?path=' + encodeURIComponent(path)
    return jsonRequest(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (payload) {
        state.listing = payload.listing
        state.selected = null
        render()
      })
      .catch(function (error) {
        setError(error && error.message ? error.message : String(error))
        setStatus('')
      })
      .then(function () {
        setBusy(false)
      })
  }

  function renderCrumbs() {
    dom.crumbs.textContent = ''
    if (!state.listing) return
    var crumbs = state.listing.crumbs || []
    crumbs.forEach(function (crumb, index) {
      if (index > 0) dom.crumbs.appendChild(element('span', 'dsh-cp-sep', '/'))
      var button = element('button', 'dsh-cp-crumb', crumb.name || crumb.path)
      button.type = 'button'
      button.title = crumb.path
      button.addEventListener('click', function () { void load(crumb.path) })
      dom.crumbs.appendChild(button)
    })
  }

  function renderList() {
    dom.list.textContent = ''
    if (!state.listing) return
    var entries = (state.listing.entries || []).filter(function (entry) {
      return state.showHidden || !entry.hidden
    })
    if (entries.length === 0) {
      dom.list.appendChild(element('div', 'dsh-cp-empty', TEXT.empty))
    }
    entries.forEach(function (entry) {
      var row = element('div', 'dsh-cp-row')
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', 'false')
      row.tabIndex = 0
      row.innerHTML = FOLDER_SVG
      row.appendChild(element('span', '', entry.name))
      row.title = entry.path
      row.addEventListener('click', function () {
        select(entry, row)
      })
      row.addEventListener('dblclick', function () {
        void load(entry.path)
      })
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault()
          void load(entry.path)
        } else if (event.key === ' ') {
          event.preventDefault()
          select(entry, row)
        }
      })
      dom.list.appendChild(row)
    })
    if (state.listing.truncated) dom.list.appendChild(element('div', 'dsh-cp-note', TEXT.truncated))
  }

  function select(entry, row) {
    state.selected = entry.path
    var rows = dom.list.querySelectorAll('.dsh-cp-row')
    for (var index = 0; index < rows.length; index += 1) rows[index].setAttribute('aria-selected', 'false')
    row.setAttribute('aria-selected', 'true')
    setStatus(entry.path)
  }

  function render() {
    if (!state.listing) return
    dom.pathInput.value = state.listing.path
    dom.upButton.disabled = false
    setStatus(state.listing.path)
    renderCrumbs()
    renderList()
  }

  function createFolder() {
    if (!state.listing) return
    var name = dom.createInput.value.trim()
    if (name === '') return
    var parent = state.selected || state.listing.path
    setError('')
    setBusy(true)
    jsonRequest(ROUTES.mkdir, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-dsh-csrf': csrfToken() },
      body: JSON.stringify({ path: parent, name: name })
    }).then(function (payload) {
      hideCreate()
      return load(payload.path ? parent : state.listing.path)
    }).catch(function (error) {
      setError(error && error.message ? error.message : String(error))
      setBusy(false)
    })
  }

  function showCreate() {
    if (!state.listing) return
    dom.createRow.hidden = false
    dom.createInput.value = ''
    dom.createInput.focus()
  }

  function hideCreate() {
    dom.createRow.hidden = true
    dom.createInput.value = ''
  }

  function finish(path) {
    var resolve = state.resolve
    teardown()
    if (resolve) resolve(path)
  }

  function onDocumentKey(event) {
    if (!state.open || event.key !== 'Escape') return
    event.preventDefault()
    if (dom.createRow && !dom.createRow.hidden) hideCreate()
    else finish(null)
  }

  function teardown() {
    state.open = false
    state.resolve = null
    state.listing = null
    state.selected = null
    state.showHidden = false
    document.removeEventListener('keydown', onDocumentKey, true)
    if (dom.overlay && dom.overlay.parentNode) dom.overlay.parentNode.removeChild(dom.overlay)
    if (dom.previousFocus && typeof dom.previousFocus.focus === 'function') dom.previousFocus.focus()
    dom = {}
  }

  function choose() {
    if (!state.listing) return
    finish(state.selected || state.listing.path)
  }

  function goUp() {
    if (!state.listing) return
    var crumbs = state.listing.crumbs || []
    var parent = crumbs.length > 1 ? crumbs[crumbs.length - 2].path : state.listing.path
    void load(parent)
  }

  function goHome() {
    if (!state.listing) return
    void load(state.listing.home)
  }

  function build() {
    var style = document.createElement('style')
    style.textContent = CSS
    document.head.appendChild(style)

    var overlay = element('div', 'dsh-cp-overlay')
    var dialog = element('div', 'dsh-cp-dialog')
    dialog.tabIndex = -1
    if (prefersDark()) dialog.classList.add('dsh-cp-dark')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('aria-label', TEXT.title)

    var head = element('div', 'dsh-cp-head')
    head.appendChild(element('span', '', TEXT.title))
    var close = element('button', 'dsh-cp-close', '\u00d7')
    close.type = 'button'
    close.title = TEXT.cancel
    close.setAttribute('aria-label', TEXT.cancel)
    close.addEventListener('click', function () { finish(null) })
    head.appendChild(close)

    var pathRow = element('div', 'dsh-cp-path')
    var upButton = element('button', 'dsh-cp-btn', TEXT.up)
    upButton.type = 'button'
    upButton.addEventListener('click', goUp)
    var homeButton = element('button', 'dsh-cp-btn', TEXT.home)
    homeButton.type = 'button'
    homeButton.addEventListener('click', goHome)
    var pathInput = element('input')
    pathInput.spellcheck = false
    pathInput.setAttribute('aria-label', TEXT.pathPlaceholder)
    pathInput.placeholder = TEXT.pathPlaceholder
    pathInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        var value = pathInput.value.trim()
        if (value !== '') void load(value)
      }
    })
    pathRow.appendChild(upButton)
    pathRow.appendChild(homeButton)
    pathRow.appendChild(pathInput)

    var crumbs = element('div', 'dsh-cp-crumbs')

    var list = element('div', 'dsh-cp-list')
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', TEXT.title)

    var error = element('div', 'dsh-cp-error')
    var status = element('span', 'dsh-cp-status')

    var createRow = element('div', 'dsh-cp-create')
    createRow.hidden = true
    var createInput = element('input')
    createInput.placeholder = TEXT.namePlaceholder
    createInput.setAttribute('aria-label', TEXT.namePlaceholder)
    var createButton = element('button', 'dsh-cp-btn', TEXT.create)
    createButton.type = 'button'
    createButton.addEventListener('click', createFolder)
    var cancelCreate = element('button', 'dsh-cp-btn', TEXT.cancel)
    cancelCreate.type = 'button'
    cancelCreate.addEventListener('click', hideCreate)
    createInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault()
        createFolder()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        hideCreate()
      }
    })
    createRow.appendChild(createInput)
    createRow.appendChild(createButton)
    createRow.appendChild(cancelCreate)

    var foot = element('div', 'dsh-cp-foot')
    var hiddenLabel = element('label')
    var hiddenToggle = document.createElement('input')
    hiddenToggle.type = 'checkbox'
    hiddenToggle.addEventListener('change', function () {
      state.showHidden = hiddenToggle.checked
      renderList()
    })
    hiddenLabel.appendChild(hiddenToggle)
    hiddenLabel.appendChild(document.createTextNode(TEXT.hidden))
    var newButton = element('button', 'dsh-cp-btn', TEXT.newFolder)
    newButton.type = 'button'
    newButton.addEventListener('click', showCreate)
    var cancelButton = element('button', 'dsh-cp-btn', TEXT.cancel)
    cancelButton.type = 'button'
    cancelButton.addEventListener('click', function () { finish(null) })
    var openButton = element('button', 'dsh-cp-btn dsh-cp-primary', TEXT.open)
    openButton.type = 'button'
    openButton.addEventListener('click', choose)
    foot.appendChild(hiddenLabel)
    foot.appendChild(newButton)
    foot.appendChild(status)
    foot.appendChild(cancelButton)
    foot.appendChild(openButton)

    dialog.appendChild(head)
    dialog.appendChild(pathRow)
    dialog.appendChild(crumbs)
    dialog.appendChild(list)
    dialog.appendChild(createRow)
    dialog.appendChild(error)
    dialog.appendChild(foot)
    overlay.appendChild(dialog)

    document.addEventListener('keydown', onDocumentKey, true)
    document.body.appendChild(overlay)
    dialog.focus && dialog.focus()
    dom = {
      overlay: overlay,
      dialog: dialog,
      pathInput: pathInput,
      crumbs: crumbs,
      list: list,
      error: error,
      status: status,
      createRow: createRow,
      createInput: createInput,
      upButton: upButton,
      newButton: newButton,
      openButton: openButton,
      hiddenToggle: hiddenToggle,
      previousFocus: document.activeElement
    }
    return overlay
  }

  function pick() {
    if (state.open) {
      return new Promise(function (resolve) {
        var previous = state.resolve
        state.resolve = function (path) {
          if (previous) previous(path)
          resolve(path)
        }
      })
    }
    return new Promise(function (resolve) {
      state.open = true
      state.resolve = resolve
      try {
        build()
      } catch (error) {
        teardown()
        resolve(null)
        return
      }
      void load()
    })
  }

  g.${CARRIER_PICKER_GLOBAL} = { pick: pick };
})();`
