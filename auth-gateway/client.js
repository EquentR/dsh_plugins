window.__ModuleLoader__.load({
  id: '@dsh-plugins/auth-gateway',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    // The settings page talks to the Host over the core's shared `/api` route,
    // never over the gateway's own listener: the listener is off exactly when
    // the user needs the switch to turn it back on.
    const SHARED_API_ENDPOINT = 'auth-gateway'
    const RPC_VERSION = 1
    const LOCALE_NS = 'auth-gateway'
    const STYLE_ID = 'dsh-plugin-auth-gateway-style'

    const ZH_DICT = {
      sectionLabel: '认证网关',
      title: '认证网关',
      summary: '为一个独立的网关端口加上账号鉴权，核心 Web 服务仍只监听 loopback。',
      loading: '正在读取状态…',
      unavailable: '无法读取认证网关状态。',
      readOnly: '当前 Profile 不允许修改插件配置。',
      conflict: '配置已在别处修改，已重新读取，请再保存一次。',
      saveFailed: '保存失败，请查看 Host 日志。',
      transportError: '无法连接到 Host（共享 API 通道不可用）。',
      protocolError: 'Host 与页面版本不匹配，请刷新页面。',
      saved: '已保存并生效。',

      enable: '启用网关',
      enableHint: '打开后立即在下面的地址上监听，无需重启。',
      stateRunning: '运行中',
      stateStopped: '已停止',
      stateNoPassword: '未设置密码，网关不会启动',
      stateSeamError: '缺少必需的核心服务',
      listeningOn: '监听于',
      notListening: '未监听',

      upstream: '上游',
      upstreamHint: '必须是本机地址。端口 0 表示自动使用当前核心端口（桌面版必须用 0）。',
      listener: '监听设置',
      port: '网关端口',
      addresses: '绑定地址',
      addressesHint: '每行一个。留空表示自动枚举所有非 loopback 网卡。',
      allowedHosts: '允许的 Host',
      allowedHostsHint: '每行一个 host 或 host:port。经反向代理访问时必须填公网域名。',
      realm: '登录页标题',
      sessionMaxAge: '会话有效期（秒）',
      sessionIdle: '空闲超时（秒）',

      save: '保存',
      saving: '保存中…',
      reload: '刷新',

      passwordTitle: '账号密码',
      passwordState: '密码状态',
      hasPassword: '已设置',
      noPassword: '未设置',
      username: '用户名',
      currentPassword: '当前密码',
      newPassword: '新密码',
      newPasswordHint: '至少 8 个字符。修改后网关上的所有会话立即失效。',
      changePassword: '修改密码',
      changing: '修改中…',
      passwordChanged: '密码已修改；网关上的旧会话已全部失效，请重新登录。',
      passwordCreated: '密码已设置。现在可以启用网关了。',
      firstPassword: '设置密码',
      firstPasswordHint: '尚未设置密码。直接填写新密码即可完成初始化，无需旧密码。',
      passwordTooShort: '新密码至少需要 8 个字符。',

      totpTitle: '两步验证（TOTP）',
      totpState: '状态',
      totpOn: '已启用',
      totpOff: '未启用',
      totpBegin: '生成密钥',
      totpSecret: '密钥（请加入验证器应用）',
      totpCode: '6 位验证码',
      totpEnable: '验证并启用',
      totpDisable: '停用',
      totpHint: '启用后，网关登录需要额外输入验证器中的 6 位数字。',
      totpEnabled: '两步验证已启用。',
      totpDisabled: '两步验证已停用。',

      loginHint: '登录请打开网关地址，使用本插件的登录页；设置页不处理登录。',
      diagnose: '诊断 Host 接线',
      note: '核心 dsh 的进程令牌与 cookie 不受影响；网关自己持有核心会话，浏览器只会看到网关的会话 cookie。',
      enabled: '已启用',
      disabled: '已禁用',
    }

    const EN_DICT = {
      sectionLabel: 'Authentication gateway',
      title: 'Authentication gateway',
      summary: 'Adds account authentication on a separate gateway port. The core web server stays loopback-only.',
      loading: 'Reading status…',
      unavailable: 'Could not read the authentication gateway status.',
      readOnly: 'This profile does not allow editing the plugin config.',
      conflict: 'Settings changed elsewhere; reloaded, please save again.',
      saveFailed: 'Save failed; check the Host log.',
      transportError: 'Could not reach the Host (shared API channel unavailable).',
      protocolError: 'Host and page disagree on the protocol; reload the page.',
      saved: 'Saved and applied.',

      enable: 'Enable gateway',
      enableHint: 'Starts listening on the addresses below immediately, no restart.',
      stateRunning: 'Running',
      stateStopped: 'Stopped',
      stateNoPassword: 'No password set, so the gateway will not start',
      stateSeamError: 'A required core service is missing',
      listeningOn: 'Listening on',
      notListening: 'Not listening',

      upstream: 'Upstream',
      upstreamHint: 'Must be a local address. Port 0 uses the live core port (required on desktop).',
      listener: 'Listener',
      port: 'Gateway port',
      addresses: 'Bind addresses',
      addressesHint: 'One per line. Empty means every non-loopback interface.',
      allowedHosts: 'Allowed Hosts',
      allowedHostsHint: 'One host or host:port per line. Required for reverse-proxied access.',
      realm: 'Login page title',
      sessionMaxAge: 'Session lifetime (s)',
      sessionIdle: 'Idle timeout (s)',

      save: 'Save',
      saving: 'Saving…',
      reload: 'Refresh',

      passwordTitle: 'Account password',
      passwordState: 'Password',
      hasPassword: 'set',
      noPassword: 'not set',
      username: 'Username',
      currentPassword: 'Current password',
      newPassword: 'New password',
      newPasswordHint: 'At least 8 characters. Every gateway session is revoked immediately.',
      changePassword: 'Change password',
      changing: 'Changing…',
      passwordChanged: 'Password changed; all gateway sessions were revoked. Sign in again.',
      passwordCreated: 'Password set. You can enable the gateway now.',
      firstPassword: 'Set a password',
      firstPasswordHint: 'No password yet. Enter a new one to finish setup — no current password is needed.',
      passwordTooShort: 'The new password needs at least 8 characters.',

      totpTitle: 'Two-factor authentication (TOTP)',
      totpState: 'State',
      totpOn: 'enabled',
      totpOff: 'disabled',
      totpBegin: 'Generate secret',
      totpSecret: 'Secret (add it to your authenticator)',
      totpCode: '6-digit code',
      totpEnable: 'Verify and enable',
      totpDisable: 'Disable',
      totpHint: 'When enabled, signing in at the gateway also requires a code from your authenticator.',
      totpEnabled: 'Two-factor is enabled.',
      totpDisabled: 'Two-factor is disabled.',

      loginHint: 'To sign in, open the gateway address and use its login page; this page does not handle login.',
      diagnose: 'Diagnose Host wiring',
      note: 'The dsh core process token and cookie are untouched. The gateway holds the core session itself; browsers only ever see the gateway cookie.',
      enabled: 'Enabled',
      disabled: 'Disabled',
    }

    const STYLE = `
.dsh-auth-gateway { display: flex; flex-direction: column; gap: 14px; }
.dsh-auth-gateway h3 { margin: 0; font-size: 15px; }
.dsh-auth-gateway .ag-summary,
.dsh-auth-gateway .ag-note { margin: 0; opacity: .78; font-size: 12px; line-height: 1.5; }
.dsh-auth-gateway .ag-card { border: 1px solid rgba(128,128,128,.28); border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.dsh-auth-gateway .ag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
.dsh-auth-gateway .ag-field { display: flex; flex-direction: column; gap: 4px; }
.dsh-auth-gateway .ag-field > span { font-size: 12px; opacity: .8; }
.dsh-auth-gateway .ag-switch { display: flex; align-items: center; gap: 8px; }
.dsh-auth-gateway .ag-switch input { width: 16px; height: 16px; }
.dsh-auth-gateway input[type=text],
.dsh-auth-gateway input[type=password],
.dsh-auth-gateway input[type=number],
.dsh-auth-gateway textarea { padding: 6px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; font: inherit; }
.dsh-auth-gateway textarea { min-height: 56px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.dsh-auth-gateway input:disabled,
.dsh-auth-gateway textarea:disabled { opacity: .55; }
.dsh-auth-gateway small { font-size: 11px; opacity: .66; }
.dsh-auth-gateway .ag-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dsh-auth-gateway button { padding: 6px 12px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dsh-auth-gateway button.primary { border-color: rgba(88,166,255,.7); }
.dsh-auth-gateway button:disabled { opacity: .5; cursor: default; }
.dsh-auth-gateway .ag-status { font-size: 12px; min-height: 16px; }
.dsh-auth-gateway .ag-status.error { color: #e5534b; }
.dsh-auth-gateway .ag-status.ok { color: #3fb950; }
.dsh-auth-gateway .ag-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid rgba(128,128,128,.45); }
.dsh-auth-gateway .ag-badge.on { border-color: rgba(63,185,80,.7); color: #3fb950; }
.dsh-auth-gateway .ag-badge.off { opacity: .7; }
.dsh-auth-gateway .ag-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
`

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /** Newline-delimited text in, string array out. */
    function linesToArray(text) {
      return String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line !== '')
    }

    function arrayToLines(value) {
      return Array.isArray(value) ? value.join('\n') : ''
    }

    function createRpc(connection) {
      // `connection.rpc.call()` resolves to the ALREADY-NORMALIZED
      // `full.result`, i.e. exactly `{ ok: true, value }` or
      // `{ ok: false, error }` — it is NOT the `{ rpcId, result }` envelope.
      // Reading `carrier.result` here is always undefined, which reports every
      // call as a transport failure.
      //
      // The plugin's own `{ v, op, result }` contract therefore lives inside
      // `carrier.value`, matching the Host route in lib/settings-rpc.js.
      const call = (op, extra) => connection.rpc.call(
        '/api',
        SHARED_API_ENDPOINT,
        { v: RPC_VERSION, op, ...extra },
      ).then((carrier) => {
        if (carrier?.ok !== true) {
          const error = carrier?.error
          return { ok: false, code: error?.code ?? 'transport_failed', message: error?.message }
        }
        const envelope = isRecord(carrier.value) ? carrier.value : undefined
        if (envelope?.v !== RPC_VERSION || envelope?.op !== op) return { ok: false, code: 'protocol_error' }
        return { ok: true, result: envelope.result }
      }).catch(() => ({ ok: false, code: 'transport_failed' }))

      return {
        status() { return call('status', {}) },
        save(values, revision) { return call('save', { values, revision: revision ?? null }) },
        changePassword(currentPassword, newPassword) { return call('changePassword', { currentPassword, newPassword }) },
        totp(action, extra) { return call('totp', { action, ...extra }) },
        diagnose() { return call('diagnose', {}) },
      }
    }

    function createSettingsPage(t, rpc) {
      return function AuthGatewaySection() {
        const [phase, setPhase] = React.useState('loading')
        const [data, setData] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [note, setNote] = React.useState(null)
        const [noteOk, setNoteOk] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [revision, setRevision] = React.useState(null)

        const [currentPassword, setCurrentPassword] = React.useState('')
        const [newPassword, setNewPassword] = React.useState('')
        const [totpSecret, setTotpSecret] = React.useState('')
        const [totpCode, setTotpCode] = React.useState('')
        const [totpPassword, setTotpPassword] = React.useState('')

        function adopt(info) {
          setData(info)
          setDraft({
            enabled: info.enabled === true,
            port: info.port ?? 3080,
            targetHost: info.targetHost ?? '127.0.0.1',
            targetPort: info.targetPort ?? 0,
            addresses: arrayToLines(info.addresses),
            allowedHosts: arrayToLines(info.allowedHosts),
            realm: info.realm ?? '',
            username: info.username ?? '',
            sessionMaxAgeSeconds: info.sessionMaxAgeSeconds ?? 86400,
            sessionIdleTimeoutSeconds: info.sessionIdleTimeoutSeconds ?? 43200,
          })
        }

        function say(message, good) {
          setNote(message)
          setNoteOk(good === true)
        }

        /**
         * Turn one `call()` result into either a payload or a user-visible error.
         *
         * `call()` ALREADY unwraps everything: success is `{ ok:true, result:<payload> }`
         * and failure is `{ ok:false, code, message }`. Do not re-inspect
         * `result.ok` here — the payload has no such field, and doing so turned
         * every success into a failure with `code: undefined` (shown as
         * "(unknown)" in the UI).
         */
        function applyResponse(response) {
          if (response?.ok === true) return response.result

          const code = response?.code
          const detail = typeof response?.message === 'string' && response.message !== '' ? response.message : undefined
          if (code === 'protocol_error') say(t('protocolError'), false)
          else if (code === 'transport_failed') say(t('transportError'), false)
          else if (code === 'conflict') say(t('conflict'), false)
          else if (code === 'read_only') say(detail ?? t('readOnly'), false)
          else {
            // Show the code AND the raw payload: a generic message is what made
            // this take several rounds to diagnose.
            const raw = (() => {
              try {
                return JSON.stringify(response)
              } catch {
                return String(response)
              }
            })()
            say(`${detail ?? t('saveFailed')} [${String(code ?? 'no-code')}] ${raw}`, false)
          }
          if (code === 'conflict') void refresh()
          return false
        }

        async function refresh() {
          const response = await rpc.status()
          const value = applyResponse(response)
          if (value !== false) {
            adopt(value)
            setPhase('ready')
          } else if (phase === 'loading') {
            // Keep the page mounted on failure: replacing it removed the
            // diagnose button exactly when it was needed.
            setPhase('unavailable')
          }
        }

        React.useEffect(() => {
          void refresh()
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [])

        React.useEffect(() => {
          if (typeof document === 'undefined') return undefined
          if (document.getElementById(STYLE_ID) !== null) return undefined
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = STYLE
          document.head.append(style)
          return () => style.remove()
        }, [])

        async function run(action) {
          setBusy(true)
          setNote(null)
          try {
            await action()
          } catch (cause) {
            say(String(cause?.message ?? cause), false)
          } finally {
            setBusy(false)
          }
        }

        function update(key, value) {
          setDraft((current) => (current === null ? current : { ...current, [key]: value }))
        }

        const onSave = () => run(async () => {
          const response = await rpc.save({
            enabled: draft.enabled,
            port: Number(draft.port),
            targetHost: draft.targetHost,
            targetPort: Number(draft.targetPort),
            addresses: linesToArray(draft.addresses),
            allowedHosts: linesToArray(draft.allowedHosts),
            realm: draft.realm,
            username: draft.username,
            sessionMaxAgeSeconds: Number(draft.sessionMaxAgeSeconds),
            sessionIdleTimeoutSeconds: Number(draft.sessionIdleTimeoutSeconds),
          }, revision)
          const value = applyResponse(response)
          if (value !== false) {
            adopt(value)
            say(t('saved'), true)
          }
        })

        // Flipping the switch saves immediately: waiting for a separate Save
        // makes "enable" feel broken when nothing starts listening.
        const onToggle = (next) => run(async () => {
          setDraft((current) => (current === null ? current : { ...current, enabled: next }))
          const response = await rpc.save({ enabled: next }, revision)
          const value = applyResponse(response)
          if (value !== false) {
            adopt(value)
            say(next ? t('saved') : t('saved'), true)
          }
        })

        // Surfaces the real Host-side wiring so a failed save is diagnosable
        // from the page instead of requiring Host logs the desktop hides.
        const [diagnosis, setDiagnosis] = React.useState(null)
        const onDiagnose = () => run(async () => {
          const response = await rpc.diagnose()
          const value = applyResponse(response)
          if (value !== false) setDiagnosis(value)
        })

        const onChangePassword = () => run(async () => {
          if (newPassword.length < 8) {
            say(t('passwordTooShort'), false)
            return
          }
          // First-time setup has no current password to verify, so the Host
          // bootstraps the record instead of rejecting the save.
          const firstTime = data.hasPassword !== true
          const response = await rpc.changePassword(firstTime ? '' : currentPassword, newPassword)
          const value = applyResponse(response)
          if (value !== false) {
            setCurrentPassword('')
            setNewPassword('')
            say(t(firstTime ? 'passwordCreated' : 'passwordChanged'), true)
            await refresh()
          }
        })

        const onTotpBegin = () => run(async () => {
          // Generating a secret is local to the browser flow; the Host only
          // verifies it on enable, so reuse the gateway's generator shape here.
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
          const bytes = new Uint8Array(20)
          globalThis.crypto.getRandomValues(bytes)
          let secret = ''
          for (const byte of bytes) secret += alphabet[byte % 32]
          setTotpSecret(secret)
          say(t('totpSecret'), true)
        })

        const onTotpEnable = () => run(async () => {
          const response = await rpc.totp('enable', { secret: totpSecret, code: totpCode })
          const value = applyResponse(response)
          if (value !== false) {
            setTotpSecret('')
            setTotpCode('')
            say(t('totpEnabled'), true)
            await refresh()
          }
        })

        const onTotpDisable = () => run(async () => {
          const response = await rpc.totp('disable', { password: totpPassword })
          const value = applyResponse(response)
          if (value !== false) {
            setTotpPassword('')
            say(t('totpDisabled'), true)
            await refresh()
          }
        })

        // A failed status read must still render a usable page: the note carries
        // the concrete reason and the diagnose button stays reachable. Previously
        // this branch replaced the whole page, hiding both.
        if (phase === 'unavailable') {
          return React.createElement('div', { className: 'dsh-auth-gateway' },
            React.createElement('h3', null, t('title')),
            React.createElement('p', { className: 'ag-summary' }, t('unavailable')),
            React.createElement('div', { className: 'ag-status error', role: 'status' }, note ?? ''),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('button', { type: 'button', disabled: busy, onClick: () => void refresh() }, t('reload')),
              React.createElement('button', { type: 'button', disabled: busy, onClick: onDiagnose }, t('diagnose')),
            ),
            diagnosis !== null
              ? React.createElement('pre', { className: 'ag-mono', style: { whiteSpace: 'pre-wrap', margin: 0 } },
                  JSON.stringify(diagnosis, null, 2))
              : null,
            React.createElement('p', { className: 'ag-note' }, t('note')),
          )
        }
        if (phase === 'loading' || data === null || draft === null) {
          return React.createElement('div', { className: 'dsh-auth-gateway' },
            React.createElement('h3', null, t('title')),
            React.createElement('p', { className: 'ag-summary' }, t('loading')),
          )
        }

        const running = data.running === true
        const stateLabel = running
          ? t('stateRunning')
          : data.error === 'no_password' || data.hasPassword === false
            ? t('stateNoPassword')
            : data.seamError !== null && data.seamError !== undefined
              ? t('stateSeamError')
              : t('stateStopped')
        const stateClass = running ? 'on' : 'off'
        const addresses = Array.isArray(data.listening) && data.listening.length > 0
          ? data.listening.map((entry) => `${entry.address}:${entry.port}`).join(', ')
          : t('notListening')

        const formDisabled = busy

        const status = React.createElement(
          'div',
          { className: `ag-status${note === null ? '' : noteOk ? ' ok' : ' error'}`, role: 'status' },
          note ?? '',
        )

        const diagnosisPanel = React.createElement('div', { className: 'ag-card' },
          React.createElement('div', { className: 'ag-actions' },
            React.createElement('button', { type: 'button', disabled: formDisabled, onClick: onDiagnose }, t('diagnose')),
          ),
          diagnosis !== null
            ? React.createElement('pre', { className: 'ag-mono', style: { whiteSpace: 'pre-wrap', margin: 0 } },
                JSON.stringify(diagnosis, null, 2))
            : null,
        )

        return React.createElement('div', { className: 'dsh-auth-gateway' },
          React.createElement('h3', null, t('title')),
          React.createElement('p', { className: 'ag-summary' }, t('summary')),

          // --- the switch -------------------------------------------------
          React.createElement('div', { className: 'ag-card' },
            React.createElement('label', { className: 'ag-switch' },
              React.createElement('input', {
                type: 'checkbox',
                checked: draft.enabled === true,
                disabled: formDisabled,
                onChange: (event) => onToggle(event.target.checked),
                'aria-label': t('enable'),
              }),
              React.createElement('strong', null, t('enable')),
              React.createElement('span', { className: `ag-badge ${stateClass}` }, stateLabel),
            ),
            React.createElement('small', null, t('enableHint')),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('span', { className: 'ag-mono' }, `${t('listeningOn')}: ${addresses}`),
            ),
            data.error !== null && data.error !== undefined && data.error !== 'no_password'
              ? React.createElement('div', { className: 'ag-status error' }, String(data.error))
              : null,
            data.seamError !== null && data.seamError !== undefined
              ? React.createElement('div', { className: 'ag-status error' }, String(data.seamError))
              : null,
          ),

          // --- listener settings -----------------------------------------
          React.createElement('div', { className: 'ag-card' },
            React.createElement('h3', null, t('listener')),
            React.createElement('div', { className: 'ag-grid' },
              React.createElement('label', { className: 'ag-field' },
                React.createElement('span', null, t('port')),
                React.createElement('input', {
                  type: 'number', min: 1, max: 65535, value: draft.port, disabled: formDisabled,
                  onChange: (event) => update('port', event.target.value),
                }),
              ),
              React.createElement('label', { className: 'ag-field' },
                React.createElement('span', null, t('sessionMaxAge')),
                React.createElement('input', {
                  type: 'number', min: 300, value: draft.sessionMaxAgeSeconds, disabled: formDisabled,
                  onChange: (event) => update('sessionMaxAgeSeconds', event.target.value),
                }),
              ),
              React.createElement('label', { className: 'ag-field' },
                React.createElement('span', null, t('sessionIdle')),
                React.createElement('input', {
                  type: 'number', min: 60, value: draft.sessionIdleTimeoutSeconds, disabled: formDisabled,
                  onChange: (event) => update('sessionIdleTimeoutSeconds', event.target.value),
                }),
              ),
            ),
            React.createElement('label', { className: 'ag-field' },
              React.createElement('span', null, t('addresses')),
              React.createElement('textarea', {
                value: draft.addresses, disabled: formDisabled,
                placeholder: '192.168.1.10',
                onChange: (event) => update('addresses', event.target.value),
              }),
              React.createElement('small', null, t('addressesHint')),
            ),
            React.createElement('label', { className: 'ag-field' },
              React.createElement('span', null, t('allowedHosts')),
              React.createElement('textarea', {
                value: draft.allowedHosts, disabled: formDisabled,
                placeholder: 'dsh.example.com',
                onChange: (event) => update('allowedHosts', event.target.value),
              }),
              React.createElement('small', null, t('allowedHostsHint')),
            ),
            React.createElement('div', { className: 'ag-grid' },
              React.createElement('label', { className: 'ag-field' },
                React.createElement('span', null, t('upstream')),
                React.createElement('input', {
                  type: 'text', value: draft.targetHost, disabled: formDisabled,
                  onChange: (event) => update('targetHost', event.target.value),
                }),
              ),
              React.createElement('label', { className: 'ag-field' },
                React.createElement('span', null, 'targetPort'),
                React.createElement('input', {
                  type: 'number', min: 0, max: 65535, value: draft.targetPort, disabled: formDisabled,
                  onChange: (event) => update('targetPort', event.target.value),
                }),
              ),
            ),
            React.createElement('small', null, t('upstreamHint')),
            React.createElement('label', { className: 'ag-field' },
              React.createElement('span', null, t('realm')),
              React.createElement('input', {
                type: 'text', value: draft.realm, disabled: formDisabled,
                onChange: (event) => update('realm', event.target.value),
              }),
            ),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('button', {
                type: 'button', className: 'primary', disabled: formDisabled, onClick: onSave,
              }, busy ? t('saving') : t('save')),
              React.createElement('button', { type: 'button', disabled: formDisabled, onClick: () => void refresh() }, t('reload')),
            ),
          ),

          // --- account ----------------------------------------------------
          React.createElement('div', { className: 'ag-card' },
            React.createElement('h3', null, t('passwordTitle')),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('span', null, `${t('username')}: ${String(data.username ?? '')}`),
              React.createElement('span', { className: 'ag-badge' },
                `${t('passwordState')}: ${data.hasPassword === true ? t('hasPassword') : t('noPassword')}`),
            ),
            // The current password only exists once an account has been created;
            // showing it on first run is what made setup look broken.
            data.hasPassword === true
              ? React.createElement('label', { className: 'ag-field' },
                  React.createElement('span', null, t('currentPassword')),
                  React.createElement('input', {
                    type: 'password', value: currentPassword, disabled: formDisabled, autoComplete: 'current-password',
                    onChange: (event) => setCurrentPassword(event.target.value),
                  }),
                )
              : React.createElement('small', null, t('firstPasswordHint')),
            React.createElement('label', { className: 'ag-field' },
              React.createElement('span', null, t(data.hasPassword === true ? 'newPassword' : 'firstPassword')),
              React.createElement('input', {
                type: 'password', value: newPassword, disabled: formDisabled, autoComplete: 'new-password',
                onChange: (event) => setNewPassword(event.target.value),
              }),
              React.createElement('small', null, t('newPasswordHint')),
            ),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('button', { type: 'button', disabled: formDisabled, onClick: onChangePassword },
                busy ? t('changing') : t('changePassword')),
            ),
          ),

          // --- TOTP --------------------------------------------------------
          React.createElement('div', { className: 'ag-card' },
            React.createElement('h3', null, t('totpTitle')),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('span', { className: 'ag-badge' },
                `${t('totpState')}: ${data.twoFactorEnabled === true ? t('totpOn') : t('totpOff')}`),
              React.createElement('button', { type: 'button', disabled: formDisabled, onClick: onTotpBegin }, t('totpBegin')),
            ),
            React.createElement('small', null, t('totpHint')),
            totpSecret !== ''
              ? React.createElement('div', null,
                  React.createElement('small', null, t('totpSecret')),
                  React.createElement('div', { className: 'ag-mono' }, totpSecret),
                )
              : null,
            React.createElement('label', { className: 'ag-field' },
              React.createElement('span', null, t('totpCode')),
              React.createElement('input', {
                type: 'text', inputMode: 'numeric', value: totpCode, disabled: formDisabled,
                onChange: (event) => setTotpCode(event.target.value),
              }),
            ),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('button', {
                type: 'button', disabled: formDisabled || totpSecret === '', onClick: onTotpEnable,
              }, t('totpEnable')),
            ),
            React.createElement('label', { className: 'ag-field' },
              React.createElement('span', null, t('currentPassword')),
              React.createElement('input', {
                type: 'password', value: totpPassword, disabled: formDisabled, autoComplete: 'current-password',
                onChange: (event) => setTotpPassword(event.target.value),
              }),
            ),
            React.createElement('div', { className: 'ag-actions' },
              React.createElement('button', { type: 'button', disabled: formDisabled, onClick: onTotpDisable }, t('totpDisable')),
            ),
          ),

          status,
          React.createElement('p', { className: 'ag-note' }, t('loginHint')),
          React.createElement('p', { className: 'ag-note' }, t('note')),
          diagnosisPanel,
        )
      }
    }

    function apply(ctx) {
      const locale = ctx.locale
      const slots = ctx.slots
      const connection = ctx.connection
      if (locale === undefined || slots === undefined || connection === undefined) return

      ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh: ZH_DICT, en: EN_DICT }), 'auth gateway locale')
      const t = ctx.locale.bind(LOCALE_NS)
      const rpc = createRpc(connection)
      const SettingsPage = createSettingsPage(t, rpc)

      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'auth-gateway',
        order: 20,
        label: () => t('sectionLabel'),
        locale: LOCALE_NS,
        inject: () => ({ rpc }),
      }, SettingsPage)), 'auth gateway settings section')

      ctx.effect(() => () => {
        if (typeof document !== 'undefined') document.getElementById(STYLE_ID)?.remove()
      }, 'auth gateway stylesheet')
    }

    exports.inject = ['connection', 'locale', 'slots']
    exports.apply = apply
    return module.exports
  },
})
