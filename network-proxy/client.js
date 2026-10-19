window.__ModuleLoader__.load({
  id: '@dsh-plugins/network-proxy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const SHARED_API_ENDPOINT = 'network-proxy'
    const RPC_VERSION = 1
    const LOCALE_NS = 'network-proxy'
    const STYLE_ID = 'dsh-plugin-network-proxy-style'

    const ZH_DICT = {
      title: '网络代理',
      summary: '为 Host 的出站请求配置 HTTP 或 SOCKS5 代理；HTTP 模式支持用户名和密码鉴权。',
      loading: '正在读取网络代理设置…',
      unavailable: '网络代理设置当前不可用。',
      readOnly: '当前 Profile 的插件配置不可写；请直接编辑 dsh-network-proxy 行。',
      conflict: '设置已在其他位置修改，已重新读取，请再保存一次。',
      saveFailed: '设置未能写入 Profile 配置，请查看 Host 日志。',
      invalidSettings: '设置未通过校验，请检查主机、端口和鉴权信息。',
      invalidHost: '请填写代理主机，不要包含协议、路径或空格。',
      invalidPort: '端口必须是 1 到 65535 之间的整数。',
      invalidUsernamePassword: '填写密码时需要同时填写用户名。',
      saved: '已保存；代理策略已重新加载。',
      save: '保存',
      saving: '保存中…',
      test: '测试连接',
      testing: '测试中…',
      testOk: '连接成功（HTTP {status}，{ms} ms）',
      testFailed: '连接失败：{message}',
      testTimeout: '连接超时，请检查代理地址和端口。',
      testTarget: '测试会访问 {target}。',
      enabled: '启用代理',
      enabledHint: '关闭后保留配置，Host 恢复直连。',
      mode: '协议',
      modeHttp: 'HTTP',
      modeSocks5: 'SOCKS5',
      host: '代理主机',
      hostHint: '只填主机名或 IP，不要包含 http:// 或路径。',
      port: '端口',
      username: '用户名',
      password: '密码',
      optional: '可选',
      passwordPlaceholder: '可选；HTTP 代理鉴权密码',
      passwordSavedPlaceholder: '已保存；留空保持不变',
      clearPassword: '清除已保存的密码',
      noProxy: '不走代理的地址',
      noProxyHint: '用逗号或空格分隔；支持域名后缀和可选的端口。本机地址始终直连。',
      httpAuthHint: 'HTTP 代理支持 Basic 用户名/密码鉴权。',
      socks5AuthHint: 'SOCKS5 模式不提供鉴权；Chromium 也不支持 SOCKS5 用户名/密码鉴权。',
      scopeHint: '此设置作用于 Host 的出站 HTTP 请求（模型、网页抓取、MCP 等）。桌面端 Chromium 自身的流量不受影响；如需让 Chromium 走代理，请在启动时传入 --proxy-server。',
      envProxyHint: '检测到环境变量代理。环境变量代理可能对 web_fetch 优先；如需让此设置完全生效，请清除 HTTP_PROXY / HTTPS_PROXY 等变量后重启。',
      active: '已生效',
      inactive: '未生效',
      currentProxy: '当前策略：{proxy}',
      lastError: '最近一次应用失败：{message}',
      testResult: '测试结果',
      settingsSection: '网络代理',
    }

    const EN_DICT = {
      title: 'Network proxy',
      summary: 'Route Host outbound requests through an HTTP or SOCKS5 proxy. HTTP mode supports username and password authentication.',
      loading: 'Loading network proxy settings…',
      unavailable: 'Network proxy settings are unavailable.',
      readOnly: 'This Profile stores plugin configuration read-only; edit the dsh-network-proxy row instead.',
      conflict: 'These settings changed elsewhere. They were reloaded; save again.',
      saveFailed: 'The Profile configuration write failed; check the Host log.',
      invalidSettings: 'Settings did not pass validation. Check the host, port, and credentials.',
      invalidHost: 'Enter a proxy host without a scheme, path, or spaces.',
      invalidPort: 'The port must be an integer from 1 through 65535.',
      invalidUsernamePassword: 'A password requires a username.',
      saved: 'Saved; the proxy policy was reloaded.',
      save: 'Save',
      saving: 'Saving…',
      test: 'Test connection',
      testing: 'Testing…',
      testOk: 'Connected (HTTP {status}, {ms} ms)',
      testFailed: 'Connection failed: {message}',
      testTimeout: 'The connection timed out. Check the proxy host and port.',
      testTarget: 'The test visits {target}.',
      enabled: 'Enable proxy',
      enabledHint: 'When off, the configuration is kept and the Host connects directly.',
      mode: 'Protocol',
      modeHttp: 'HTTP',
      modeSocks5: 'SOCKS5',
      host: 'Proxy host',
      hostHint: 'Host name or IP only; no scheme or path.',
      port: 'Port',
      username: 'Username',
      password: 'Password',
      optional: 'Optional',
      passwordPlaceholder: 'Optional HTTP proxy password',
      passwordSavedPlaceholder: 'Saved; leave blank to keep it',
      clearPassword: 'Clear the saved password',
      noProxy: 'Bypass list',
      noProxyHint: 'Comma- or space-separated host suffixes with an optional port. Local addresses always connect directly.',
      httpAuthHint: 'HTTP proxies support Basic username/password authentication.',
      socks5AuthHint: 'SOCKS5 mode has no authentication; Chromium does not support SOCKS5 username/password authentication either.',
      scopeHint: 'This policy covers Host outbound HTTP requests (models, web fetch, MCP). Chromium traffic in the desktop shell is separate; pass --proxy-server at launch to proxy Chromium itself.',
      envProxyHint: 'Proxy environment variables are set. They may take precedence for web fetch; clear HTTP_PROXY / HTTPS_PROXY and restart to let this policy apply everywhere.',
      active: 'Active',
      inactive: 'Not active',
      currentProxy: 'Current policy: {proxy}',
      lastError: 'Last apply failure: {message}',
      testResult: 'Test result',
      settingsSection: 'Network proxy',
    }

    function record(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
    }

    function draftFrom(values) {
      const current = record(values) || {}
      return {
        enabled: current.enabled === true,
        mode: current.mode === 'socks5' ? 'socks5' : 'http',
        host: typeof current.host === 'string' ? current.host : '',
        port: String(current.port ?? (current.mode === 'socks5' ? 1080 : 8080)),
        username: typeof current.username === 'string' ? current.username : '',
        password: '',
        clearPassword: false,
        noProxy: typeof current.noProxy === 'string' ? current.noProxy : '',
      }
    }

    function changedFrom(draft, values) {
      const baseline = draftFrom(values)
      return draft.enabled !== baseline.enabled
        || draft.mode !== baseline.mode
        || draft.host !== baseline.host
        || draft.port !== baseline.port
        || draft.username !== baseline.username
        || draft.noProxy !== baseline.noProxy
        || draft.clearPassword
        || draft.password !== ''
    }

    function payloadFrom(draft, { forTest = false } = {}) {
      const values = {
        enabled: forTest ? true : draft.enabled,
        mode: draft.mode === 'socks5' ? 'socks5' : 'http',
        host: draft.host,
        port: Number(draft.port),
        username: draft.username,
        noProxy: draft.noProxy,
      }
      if (draft.mode === 'http') {
        if (draft.clearPassword) values.clearPassword = true
        if (draft.password !== '') values.password = draft.password
      }
      return values
    }

    function installStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = '@dsh-plugins/network-proxy'
      style.textContent = `
.network-proxy{box-sizing:border-box;display:flex;flex-direction:column;gap:14px;width:100%;max-width:820px;min-width:0;padding:2px 0 20px;color:var(--dsw-alias-label-primary,#171717);font:var(--dsw-font-xs-13,13px/1.5 system-ui,sans-serif)}
.network-proxy-header{display:flex;flex-direction:column;gap:4px;min-width:0}
.network-proxy-title{margin:0;font-size:18px;line-height:24px;font-weight:650;overflow-wrap:anywhere}
.network-proxy-summary{margin:0;color:var(--dsw-alias-label-secondary,#4b5563);overflow-wrap:anywhere}
.network-proxy-card{display:flex;flex-direction:column;gap:14px;min-width:0;padding:16px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff)}
.network-proxy-row{display:flex;align-items:center;gap:8px;min-width:0}
.network-proxy-row input[type=checkbox]{width:16px;height:16px;margin:0}
.network-proxy-row span{font-weight:600}
.network-proxy-hint{margin:0;color:var(--dsw-alias-label-tertiary,#6b7280);font-size:11px;line-height:16px;overflow-wrap:anywhere}
.network-proxy-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;min-width:0}
.network-proxy-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.network-proxy-field>label,.network-proxy-field>span{color:var(--dsw-alias-label-secondary,#4b5563);font-size:12px;font-weight:600}
.network-proxy-field input,.network-proxy-field select{box-sizing:border-box;width:100%;min-height:34px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit}
.network-proxy-field input:disabled,.network-proxy-field select:disabled{opacity:.6}
.network-proxy-check{display:flex;align-items:center;gap:8px;min-width:0;font-weight:400}
.network-proxy-check input{width:16px;height:16px;min-height:0;padding:0}
.network-proxy-note{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:6px;background:var(--dsw-alias-bg-layer-2,#f8fafc);color:var(--dsw-alias-label-secondary,#4b5563);overflow-wrap:anywhere}
.network-proxy-note.error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#b91c1c) 32%,var(--dsw-alias-border-l1,#e5e7eb));color:var(--dsw-alias-state-error-primary,#b91c1c)}
.network-proxy-note.success{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 32%,var(--dsw-alias-border-l1,#e5e7eb));color:var(--dsw-alias-state-success-primary,#15803d)}
.network-proxy-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.network-proxy-actions button{min-height:32px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#d1d5db);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#171717);font:inherit;cursor:pointer}
.network-proxy-actions button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#f3f4f6)}
.network-proxy-actions button:disabled{cursor:default;opacity:.55}
.network-proxy-status{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.network-proxy-badge{padding:2px 8px;border-radius:999px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2,#f3f4f6);color:var(--dsw-alias-label-secondary,#4b5563)}
.network-proxy-badge.active{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#15803d) 14%,transparent);color:var(--dsw-alias-state-success-primary,#15803d)}
.network-proxy-mono{font:var(--dsw-font-xxs-12,12px/1.5 ui-monospace,monospace);overflow-wrap:anywhere}
@media (max-width:640px){.network-proxy-card{padding:12px}}
      `
      document.head.appendChild(style)
    }

    function createRpc(connection) {
      const call = (op, extra, signal) => connection.rpc.call(
        '/api',
        SHARED_API_ENDPOINT,
        { v: RPC_VERSION, op, ...extra },
        signal,
      ).then((carrier) => {
        if (!carrier?.ok) return { ok: false, code: 'transport_failed' }
        const response = record(carrier.value)
        if (response?.v !== RPC_VERSION || response?.op !== op) return { ok: false, code: 'protocol_error' }
        return { ok: true, response }
      }).catch(() => ({ ok: false, code: 'transport_failed' }))

      return {
        read(signal) { return call('read', {}, signal) },
        save(values, revision, signal) { return call('save', { values, revision: revision ?? null }, signal) },
        test(values, signal) { return call('test', { values }, signal) },
      }
    }

    function createSettingsPage(t, rpc) {
      return function NetworkProxySettingsPage(props) {
        const [state, setState] = React.useState({
          loading: true,
          saving: false,
          testing: false,
          data: null,
          draft: null,
          error: null,
          saved: false,
          test: null,
        })
        const controller = React.useRef(null)

        const load = React.useCallback(async () => {
          setState((previous) => ({ ...previous, loading: true, error: null, saved: false }))
          controller.current?.abort()
          const next = new AbortController()
          controller.current = next
          const result = await rpc.read(next.signal)
          if (next.signal.aborted) return
          if (!result.ok) {
            setState((previous) => ({ ...previous, loading: false, error: 'unavailable' }))
            return
          }
          const view = result.response.result
          if (view?.kind !== 'settings') {
            setState((previous) => ({ ...previous, loading: false, error: view?.kind === 'fault' && view.code === 'read_only' ? 'readOnly' : 'unavailable' }))
            return
          }
          setState({
            loading: false,
            saving: false,
            testing: false,
            data: view,
            draft: draftFrom(view.values),
            error: null,
            saved: false,
            test: null,
          })
        }, [])

        React.useEffect(() => {
          installStyle()
          void load()
          return () => controller.current?.abort()
        }, [load])

        const draft = state.draft
        const data = state.data
        const update = (key, value) => setState((previous) => previous.draft === null
          ? previous
          : { ...previous, saved: false, error: null, draft: { ...previous.draft, [key]: value } })

        if (props?.view === 'summary') return t('summary')
        if (state.loading) {
          return React.createElement('div', { className: 'network-proxy-note', role: 'status' }, t('loading'))
        }
        if (state.error !== null && data === null) {
          return React.createElement('div', { className: 'network-proxy-note error', role: 'status' }, t(state.error))
        }
        if (draft === null || data === null) {
          return React.createElement('div', { className: 'network-proxy-note', role: 'status' }, t('unavailable'))
        }

        const port = Number(draft.port)
        const host = draft.host.trim()
        const hostValid = host !== '' && !/[\s/?#@\\]/u.test(host) && !host.includes('://')
        const portValid = Number.isSafeInteger(port) && port >= 1 && port <= 65535
        const credentialsValid = draft.mode === 'socks5' || draft.username !== '' || draft.password === ''
        const valid = hostValid && portValid && credentialsValid
        const changed = changedFrom(draft, data.values)
        const busy = state.saving || state.testing
        const readOnly = data.writable !== true
        const disabled = busy || readOnly
        const formDisabled = busy || readOnly

        const save = async () => {
          if (!valid || !changed) {
            setState((previous) => ({
              ...previous,
              error: !hostValid ? 'invalidHost' : !portValid ? 'invalidPort' : !credentialsValid ? 'invalidUsernamePassword' : null,
              saved: false,
            }))
            return
          }
          setState((previous) => ({ ...previous, saving: true, error: null, saved: false, test: null }))
          const result = await rpc.save(payloadFrom(draft), data.revision)
          const view = result.ok ? result.response.result : undefined
          if (view?.kind === 'settings') {
            setState({
              loading: false,
              saving: false,
              testing: false,
              data: { ...data, ...view, values: view.values },
              draft: draftFrom(view.values),
              error: null,
              saved: true,
              test: null,
            })
            return
          }
          if (view?.kind === 'fault' && view.code === 'conflict') {
            setState((previous) => ({ ...previous, saving: false, error: 'conflict', saved: false }))
            void load()
            return
          }
          const error = view?.kind === 'fault' && view.code === 'read_only' ? 'readOnly'
            : view?.kind === 'fault' && view.code === 'invalid_settings' ? 'invalidSettings'
              : view?.kind === 'fault' && view.code === 'save_failed' ? 'saveFailed'
                : 'unavailable'
          setState((previous) => ({ ...previous, saving: false, error, saved: false }))
        }

        const test = async () => {
          if (!valid) {
            setState((previous) => ({
              ...previous,
              error: !hostValid ? 'invalidHost' : !portValid ? 'invalidPort' : !credentialsValid ? 'invalidUsernamePassword' : null,
              test: null,
            }))
            return
          }
          setState((previous) => ({ ...previous, testing: true, error: null, saved: false, test: null }))
          const result = await rpc.test(payloadFrom(draft, { forTest: true }))
          const view = result.ok ? result.response.result : undefined
          if (view?.ok === true) {
            setState((previous) => ({ ...previous, testing: false, test: { kind: 'ok', ...view } }))
            return
          }
          setState((previous) => ({
            ...previous,
            testing: false,
            test: {
              kind: 'error',
              code: view?.code ?? 'failed',
              message: view?.message ?? '',
              target: view?.target,
            },
          }))
        }

        const modeField = React.createElement('label', { className: 'network-proxy-field' },
          React.createElement('span', null, t('mode')),
          React.createElement('select', {
            value: draft.mode,
            disabled: formDisabled,
            onChange: (event) => {
              const mode = event.target.value === 'socks5' ? 'socks5' : 'http'
              setState((previous) => previous.draft === null ? previous : {
                ...previous,
                saved: false,
                error: null,
                draft: {
                  ...previous.draft,
                  mode,
                  port: previous.draft.port === (mode === 'socks5' ? '8080' : '1080')
                    ? (mode === 'socks5' ? '1080' : '8080')
                    : previous.draft.port,
                  username: mode === 'socks5' ? '' : previous.draft.username,
                  password: mode === 'socks5' ? '' : previous.draft.password,
                  clearPassword: mode === 'socks5' ? false : previous.draft.clearPassword,
                },
              })
            },
            'aria-label': t('mode'),
          },
            React.createElement('option', { value: 'http' }, t('modeHttp')),
            React.createElement('option', { value: 'socks5' }, t('modeSocks5')),
          ),
        )

        const authFields = draft.mode === 'http'
          ? [
              React.createElement('label', { className: 'network-proxy-field', key: 'username' },
                React.createElement('span', null, t('username')),
                React.createElement('input', {
                  type: 'text',
                  value: draft.username,
                  autoComplete: 'username',
                  disabled: formDisabled,
                  onChange: (event) => update('username', event.target.value),
                  'aria-label': t('username'),
                }),
              ),
              React.createElement('label', { className: 'network-proxy-field', key: 'password' },
                React.createElement('span', null, t('password')),
                React.createElement('input', {
                  type: 'password',
                  value: draft.password,
                  autoComplete: 'new-password',
                  placeholder: data.values.hasPassword ? t('passwordSavedPlaceholder') : t('passwordPlaceholder'),
                  disabled: formDisabled || draft.clearPassword,
                  onChange: (event) => update('password', event.target.value),
                  'aria-label': t('password'),
                }),
                data.values.hasPassword
                  ? React.createElement('label', { className: 'network-proxy-check' },
                      React.createElement('input', {
                        type: 'checkbox',
                        checked: draft.clearPassword,
                        disabled: formDisabled,
                        onChange: (event) => setState((previous) => previous.draft === null ? previous : {
                          ...previous,
                          saved: false,
                          draft: { ...previous.draft, clearPassword: event.target.checked, password: event.target.checked ? '' : previous.draft.password },
                        }),
                      }),
                      React.createElement('span', null, t('clearPassword')),
                    )
                  : null,
              ),
            ]
          : null

        const status = state.test === null ? null : state.test.kind === 'ok'
          ? React.createElement('div', { className: 'network-proxy-note success', role: 'status', 'aria-live': 'polite' },
              t('testOk', { status: state.test.status, ms: state.test.latencyMs }))
          : React.createElement('div', { className: 'network-proxy-note error', role: 'status', 'aria-live': 'polite' },
              t(state.test.code === 'timeout' ? 'testTimeout' : 'testFailed', { message: state.test.message || t('unavailable') }))

        const applyState = data.active
          ? React.createElement('span', { className: 'network-proxy-badge active' }, t('active'))
          : React.createElement('span', { className: 'network-proxy-badge' }, t('inactive'))

        return React.createElement('div', { className: 'network-proxy', role: 'region', 'aria-label': t('title') },
          React.createElement('header', { className: 'network-proxy-header' },
            React.createElement('h2', { className: 'network-proxy-title' }, t('title')),
            React.createElement('p', { className: 'network-proxy-summary' }, t('summary')),
          ),
          React.createElement('section', { className: 'network-proxy-card' },
            React.createElement('label', { className: 'network-proxy-row' },
              React.createElement('input', {
                type: 'checkbox',
                checked: draft.enabled,
                disabled: formDisabled,
                onChange: (event) => update('enabled', event.target.checked),
              }),
              React.createElement('span', null, t('enabled')),
            ),
            React.createElement('p', { className: 'network-proxy-hint' }, t('enabledHint')),
            React.createElement('div', { className: 'network-proxy-grid' },
              modeField,
              React.createElement('label', { className: 'network-proxy-field' },
                React.createElement('span', null, t('host')),
                React.createElement('input', {
                  type: 'text',
                  value: draft.host,
                  disabled: formDisabled,
                  onChange: (event) => update('host', event.target.value),
                  'aria-label': t('host'),
                  spellCheck: false,
                }),
                React.createElement('small', { className: 'network-proxy-hint' }, t('hostHint')),
              ),
              React.createElement('label', { className: 'network-proxy-field' },
                React.createElement('span', null, t('port')),
                React.createElement('input', {
                  type: 'number',
                  min: 1,
                  max: 65535,
                  step: 1,
                  value: draft.port,
                  disabled: formDisabled,
                  onChange: (event) => update('port', event.target.value),
                  'aria-label': t('port'),
                }),
              ),
              authFields,
            ),
            React.createElement('p', { className: 'network-proxy-hint' }, t(draft.mode === 'http' ? 'httpAuthHint' : 'socks5AuthHint')),
            React.createElement('label', { className: 'network-proxy-field' },
              React.createElement('span', null, t('noProxy')),
              React.createElement('input', {
                type: 'text',
                value: draft.noProxy,
                disabled: formDisabled,
                placeholder: 'localhost, .internal.example, 127.0.0.1',
                onChange: (event) => update('noProxy', event.target.value),
                'aria-label': t('noProxy'),
                spellCheck: false,
              }),
              React.createElement('small', { className: 'network-proxy-hint' }, t('noProxyHint')),
            ),
            React.createElement('div', { className: 'network-proxy-status' },
              applyState,
              data.proxy !== null && data.proxy !== undefined
                ? React.createElement('span', { className: 'network-proxy-mono' }, t('currentProxy', { proxy: data.proxy }))
                : null,
            ),
            data.error !== null && data.error !== undefined
              ? React.createElement('div', { className: 'network-proxy-note error', role: 'status' }, t('lastError', { message: data.error }))
              : null,
            status,
            state.error !== null
              ? React.createElement('div', { className: 'network-proxy-note error', role: 'status', 'aria-live': 'polite' }, t(state.error))
              : null,
            state.saved
              ? React.createElement('div', { className: 'network-proxy-note success', role: 'status', 'aria-live': 'polite' }, t('saved'))
              : null,
            readOnly
              ? React.createElement('div', { className: 'network-proxy-note' }, t('readOnly'))
              : null,
            React.createElement('div', { className: 'network-proxy-actions' },
              React.createElement('button', {
                type: 'button',
                disabled: disabled || !changed || !valid,
                onClick: () => { void save() },
              }, state.saving ? t('saving') : t('save')),
              React.createElement('button', {
                type: 'button',
                disabled: busy || !valid,
                onClick: () => { void test() },
              }, state.testing ? t('testing') : t('test')),
            ),
            React.createElement('p', { className: 'network-proxy-hint' }, t('testTarget', { target: 'https://www.baidu.com/' })),
            data.envProxy === true
              ? React.createElement('div', { className: 'network-proxy-note' }, t('envProxyHint'))
              : null,
            React.createElement('div', { className: 'network-proxy-note' }, t('scopeHint')),
          ),
        )
      }
    }

    function apply(ctx) {
      const locale = ctx.locale
      const slots = ctx.slots
      const connection = ctx.connection
      if (locale === undefined || slots === undefined || connection === undefined) return

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'network proxy locale')
      const t = ctx.locale.bind(LOCALE_NS)
      const rpc = createRpc(connection)
      const SettingsPage = createSettingsPage(t, rpc)

      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'network-proxy',
        order: 22,
        label: () => t('settingsSection'),
        locale: LOCALE_NS,
        inject: () => ({ rpc }),
      }, SettingsPage)), 'network proxy settings section')

      ctx.effect(() => () => {
        if (typeof document !== 'undefined') document.getElementById(STYLE_ID)?.remove()
      }, 'network proxy stylesheet')
    }

    exports.inject = ['connection', 'locale', 'slots']
    exports.apply = apply
    return module.exports
  },
})
