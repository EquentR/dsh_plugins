window.__ModuleLoader__.load({
  id: '@dsh-plugins/auth-gateway',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    // Use the core shared API even when the gateway listener is stopped.
    const SHARED_API_ENDPOINT = 'auth-gateway'
    const RPC_VERSION = 1
    const LOCALE_NS = 'auth-gateway'
    const STYLE_ID = 'dsh-plugin-auth-gateway-style'

    const ZH_DICT = {
      sectionLabel: '认证网关', title: '认证网关',
      summary: '为独立的网关端口加上账号鉴权，核心 Web 服务仍只监听 loopback。',
      loading: '正在读取状态…', unavailable: '无法读取认证网关状态。',
      readOnly: '当前 Profile 不允许修改插件配置。',
      conflict: '配置已在别处修改。已更新运行状态并保留草稿，请检查后重试。',
      saveFailed: '操作失败，请查看 Host 日志或展开诊断信息。',
      transportError: '无法连接到 Host（共享 API 通道不可用）。',
      protocolError: 'Host 与页面版本不匹配，请刷新页面。', saved: '已保存并生效。',
      enable: '启用网关', enableHint: '开关立即生效；其他字段修改后请保存。无需重启。',
      stateRunning: '运行中', stateStopped: '已停止', stateNoPassword: '未设置密码，网关不会启动',
      stateSeamError: '网关未能启动', listeningOn: '监听于', notListening: '未监听',
      upstream: '上游地址', targetPort: '上游端口',
      upstreamHint: '只支持 127.0.0.1 或 ::1。端口 0 表示自动使用当前核心端口（桌面版必须用 0）。',
      listener: '监听设置', port: '网关端口', addresses: '绑定地址',
      addressesHint: '每行一个。留空表示自动枚举所有非 loopback 网卡。',
      allowedHosts: '允许的 Host', allowedHostsHint: '每行一个 host 或 host:port。经反向代理访问时必须填公网域名。',
      realm: '登录页标题', sessionMaxAge: '会话有效期（秒）', sessionIdle: '空闲超时（秒）',
      sessionMaxAgeSeconds: '会话有效期', sessionIdleTimeoutSeconds: '空闲超时',
      integerRange: '请输入此范围内的整数：', invalidUpstream: '上游地址必须是 127.0.0.1 或 ::1。', realmRequired: '请填写登录页标题。',
      save: '保存', saving: '保存中…', reload: '重新读取设置',
      passwordTitle: '账号密码', passwordState: '密码状态', hasPassword: '已设置', noPassword: '未设置', username: '用户名',
      currentPassword: '当前密码', newPassword: '新密码', newPasswordHint: '至少 8 个字符。修改后网关上的所有会话立即失效。',
      changePassword: '修改密码', changing: '修改中…', passwordChanged: '密码已修改；网关上的旧会话已全部失效，请重新登录。',
      passwordCreated: '密码已设置。现在可以启用网关了。', firstPassword: '设置密码',
      firstPasswordHint: '尚未设置密码。直接填写新密码即可完成初始化，无需旧密码。',
      passwordTooShort: '新密码至少需要 8 个字符。', currentPasswordRequired: '请填写当前密码。', invalidCredentials: '当前密码不正确，请重试。',
      totpTitle: '两步验证（TOTP）', totpState: '状态', totpOn: '已启用', totpOff: '未启用', totpBegin: '生成密钥',
      totpSecret: '密钥（请加入验证器应用）', totpCode: '6 位验证码', totpEnable: '验证并启用', totpDisable: '停用',
      totpHint: '启用后，网关登录需要额外输入验证器中的 6 位数字。', totpEnabled: '两步验证已启用。', totpDisabled: '两步验证已停用。',
      secretRequired: '请先生成密钥并将其加入验证器应用。', invalidTotp: '请输入验证器中有效的 6 位数字验证码。',
      loginHint: '登录请打开网关地址，使用本插件的登录页；设置页不处理登录。',
      diagnose: '诊断 Host 接线', diagnosisReady: '诊断已完成，可展开查看。', diagnosisDetails: '查看诊断详情',
      note: '核心 dsh 的进程令牌与 cookie 不受影响；网关自己持有核心会话，浏览器只会看到网关的会话 cookie。',
    }

    const EN_DICT = {
      sectionLabel: 'Authentication gateway', title: 'Authentication gateway',
      summary: 'Adds account authentication on a separate gateway port. The core web server stays loopback-only.',
      loading: 'Reading status…', unavailable: 'Could not read the authentication gateway status.',
      readOnly: 'This profile does not allow editing the plugin config.',
      conflict: 'Settings changed elsewhere. Runtime state was updated and your draft was kept; review and retry.',
      saveFailed: 'Operation failed. Check the Host log or expand the diagnostics.',
      transportError: 'Could not reach the Host (shared API channel unavailable).',
      protocolError: 'Host and page disagree on the protocol; reload the page.', saved: 'Saved and applied.',
      enable: 'Enable gateway', enableHint: 'The switch applies immediately. Save other field changes below. No restart needed.',
      stateRunning: 'Running', stateStopped: 'Stopped', stateNoPassword: 'No password set, so the gateway will not start',
      stateSeamError: 'Gateway could not start', listeningOn: 'Listening on', notListening: 'Not listening',
      upstream: 'Upstream address', targetPort: 'Upstream port',
      upstreamHint: 'Only 127.0.0.1 or ::1 is supported. Port 0 uses the live core port (required on desktop).',
      listener: 'Listener', port: 'Gateway port', addresses: 'Bind addresses',
      addressesHint: 'One per line. Empty means every non-loopback interface.',
      allowedHosts: 'Allowed Hosts', allowedHostsHint: 'One host or host:port per line. Required for reverse-proxied access.',
      realm: 'Login page title', sessionMaxAge: 'Session lifetime (s)', sessionIdle: 'Idle timeout (s)',
      sessionMaxAgeSeconds: 'Session lifetime', sessionIdleTimeoutSeconds: 'Idle timeout',
      integerRange: 'Enter a whole number in this range:', invalidUpstream: 'The upstream address must be 127.0.0.1 or ::1.', realmRequired: 'Enter a login page title.',
      save: 'Save', saving: 'Saving…', reload: 'Reload settings',
      passwordTitle: 'Account password', passwordState: 'Password', hasPassword: 'set', noPassword: 'not set', username: 'Username',
      currentPassword: 'Current password', newPassword: 'New password', newPasswordHint: 'At least 8 characters. Every gateway session is revoked immediately.',
      changePassword: 'Change password', changing: 'Changing…', passwordChanged: 'Password changed; all gateway sessions were revoked. Sign in again.',
      passwordCreated: 'Password set. You can enable the gateway now.', firstPassword: 'Set a password',
      firstPasswordHint: 'No password yet. Enter a new one to finish setup; no current password is needed.',
      passwordTooShort: 'The new password needs at least 8 characters.', currentPasswordRequired: 'Enter the current password.', invalidCredentials: 'The current password is incorrect. Try again.',
      totpTitle: 'Two-factor authentication (TOTP)', totpState: 'State', totpOn: 'enabled', totpOff: 'disabled', totpBegin: 'Generate secret',
      totpSecret: 'Secret (add it to your authenticator)', totpCode: '6-digit code', totpEnable: 'Verify and enable', totpDisable: 'Disable',
      totpHint: 'When enabled, signing in at the gateway also requires a code from your authenticator.', totpEnabled: 'Two-factor is enabled.', totpDisabled: 'Two-factor is disabled.',
      secretRequired: 'Generate a secret and add it to your authenticator first.', invalidTotp: 'Enter a valid 6-digit code from your authenticator.',
      loginHint: 'To sign in, open the gateway address and use its login page; this page does not handle login.',
      diagnose: 'Diagnose Host wiring', diagnosisReady: 'Diagnostics are ready to expand.', diagnosisDetails: 'View diagnostic details',
      note: 'The dsh core process token and cookie are untouched. The gateway holds the core session itself; browsers only ever see the gateway cookie.',
    }
    const STYLE = `
.dsh-auth-gateway { box-sizing: border-box; width: 100%; max-width: 820px; display: flex; flex-direction: column; gap: 20px; color: var(--dsw-alias-label-primary); }
.dsh-auth-gateway * { box-sizing: border-box; }
.dsh-auth-gateway h3 { margin: 0; font-size: 15px; font-weight: 600; }
.dsh-auth-gateway .ag-summary, .dsh-auth-gateway .ag-note { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }
.dsh-auth-gateway .ag-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 16px; display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.dsh-auth-gateway .ag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 14px; }
.dsh-auth-gateway .ag-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dsh-auth-gateway .ag-field > span { font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dsh-auth-gateway .ag-switch { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; cursor: pointer; }
.dsh-auth-gateway .ag-switch input { appearance: none; position: relative; flex: 0 0 36px; width: 36px; height: 20px; margin: 0; border: 1px solid var(--dsw-alias-border-l2); border-radius: 999px; background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background .15s; }
.dsh-auth-gateway .ag-switch input::before { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform .15s; }
.dsh-auth-gateway .ag-switch input:checked { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-auth-gateway .ag-switch input:checked::before { background: var(--dsw-alias-bg-base); transform: translateX(16px); }
.dsh-auth-gateway input[type=text], .dsh-auth-gateway input[type=password], .dsh-auth-gateway input[type=number], .dsh-auth-gateway textarea { width: 100%; height: 38px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
.dsh-auth-gateway textarea { height: auto; min-height: 80px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.dsh-auth-gateway small { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.dsh-auth-gateway .ag-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.dsh-auth-gateway button { min-height: 38px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; cursor: pointer; }
.dsh-auth-gateway button.primary { color: var(--dsw-alias-brand-primary); border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 45%, var(--dsw-alias-border-l2)); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1)); font-weight: 600; }
.dsh-auth-gateway :is(button, input, textarea, summary):focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 3px; }
.dsh-auth-gateway :is(input, textarea, button):disabled { opacity: .5; cursor: not-allowed; }
.dsh-auth-gateway .ag-status { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.dsh-auth-gateway .ag-status.error { color: var(--dsw-alias-state-error-primary); }
.dsh-auth-gateway .ag-status.ok { color: var(--dsw-alias-state-success-primary); }
.dsh-auth-gateway .ag-badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 12px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dsh-auth-gateway .ag-badge.on { color: var(--dsw-alias-state-success-primary); }
.dsh-auth-gateway .ag-badge.warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-auth-gateway .ag-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
.dsh-auth-gateway summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 13px; }
.dsh-auth-gateway pre { white-space: pre-wrap; margin: 12px 0 0; padding: 12px; border-radius: 8px; background: var(--dsw-alias-bg-base); max-height: 320px; overflow: auto; }
@media (prefers-reduced-motion: reduce) { .dsh-auth-gateway .ag-switch input, .dsh-auth-gateway .ag-switch input::before { transition: none; } }
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
      // `{ ok: false, error }`, without the `{ rpcId, result }` envelope.
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
        save(values) { return call('save', { values }) },
        changePassword(currentPassword, newPassword) { return call('changePassword', { currentPassword, newPassword }) },
        totp(action, extra) { return call('totp', { action, ...extra }) },
        diagnose() { return call('diagnose', {}) },
      }
    }

    function createSettingsPage(t, rpc) {
      const h = React.createElement
      return function AuthGatewaySection() {
        const [phase, setPhase] = React.useState('loading')
        const [data, setData] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [notices, setNotices] = React.useState({})
        const [busy, setBusy] = React.useState(null)
        const busyRef = React.useRef(false)
        const mounted = React.useRef(false)
        const [currentPassword, setCurrentPassword] = React.useState('')
        const [newPassword, setNewPassword] = React.useState('')
        const [totpSecret, setTotpSecret] = React.useState('')
        const [totpCode, setTotpCode] = React.useState('')
        const [totpPassword, setTotpPassword] = React.useState('')
        const [diagnosis, setDiagnosis] = React.useState(null)

        function say(section, message, good = false) {
          if (mounted.current) setNotices((current) => ({ ...current, [section]: message ? { message, good } : null }))
        }
        function notice(section) {
          const value = notices[section]
          return value ? h('div', { className: `ag-status ${value.good ? 'ok' : 'error'}`, role: value.good ? 'status' : 'alert' }, value.message) : null
        }
        function toDraft(info) {
          return {
            port: info.port ?? 3080, targetHost: info.targetHost ?? '127.0.0.1', targetPort: info.targetPort ?? 0,
            addresses: arrayToLines(info.addresses), allowedHosts: arrayToLines(info.allowedHosts),
            realm: info.realm ?? '', sessionMaxAgeSeconds: info.sessionMaxAgeSeconds ?? 86400,
            sessionIdleTimeoutSeconds: info.sessionIdleTimeoutSeconds ?? 43200,
          }
        }
        function adopt(info, replaceDraft = false) {
          if (!mounted.current) return
          setData(info)
          setDraft((current) => replaceDraft || current === null ? toDraft(info) : current)
          setPhase('ready')
        }
        function errorMessage(response) {
          const keys = { protocol_error: 'protocolError', transport_failed: 'transportError', conflict: 'conflict', read_only: 'readOnly', invalid_credentials: 'invalidCredentials', invalid_totp: 'invalidTotp', no_password: 'stateNoPassword' }
          if (keys[response?.code]) return t(keys[response.code])
          return typeof response?.message === 'string' && response.message.trim() ? response.message : t('saveFailed')
        }
        async function result(section, response) {
          if (!mounted.current) return null
          if (response?.ok === true && isRecord(response.result)) return response.result
          say(section, errorMessage(response))
          // The Host does not expose a revision. Re-read runtime state on a
          // conflict, but retain the user's unsaved fields and the owning error.
          if (response?.code === 'conflict') {
            const latest = await rpc.status()
            if (latest.ok && isRecord(latest.result)) adopt(latest.result)
          }
          return null
        }
        function listenerNotice(info, saved = false) {
          const failure = info.seamError || info.error
          if (failure) say('listener', failure === 'no_password' ? t('stateNoPassword') : String(failure))
          else if (saved) say('listener', t('saved'), true)
        }
        async function refresh(replaceDraft = false) {
          const value = await result('listener', await rpc.status())
          if (value) { adopt(value, replaceDraft); listenerNotice(value) }
          else if (mounted.current) setPhase((current) => current === 'loading' ? 'unavailable' : current)
        }
        React.useEffect(() => {
          mounted.current = true
          void refresh()
          return () => { mounted.current = false }
        }, [])

        async function run(section, action) {
          if (busyRef.current) return
          busyRef.current = true
          setBusy(section)
          say(section, null)
          if (section === 'diagnostics') setDiagnosis(null)
          try { await action() }
          catch { say(section, t('transportError')) }
          finally {
            busyRef.current = false
            if (mounted.current) setBusy(null)
          }
        }
        function update(key, value) {
          setDraft((current) => ({ ...current, [key]: value }))
          say('listener', null)
        }
        function numberValid(value, min, max) {
          return String(value).trim() !== '' && Number.isSafeInteger(Number(value)) && Number(value) >= min && Number(value) <= max
        }
        function validateListener() {
          const limits = [['port', 1, 65535], ['targetPort', 0, 65535], ['sessionMaxAgeSeconds', 300, 2592000], ['sessionIdleTimeoutSeconds', 60, 2592000]]
          for (const [key, min, max] of limits) {
            if (!numberValid(draft[key], min, max)) return `${t(key)}: ${t('integerRange')} ${min}-${max}.`
          }
          // Mirror the existing loopback-only policy without broadening it.
          const host = draft.targetHost.trim().toLowerCase()
          if (host !== '127.0.0.1' && host !== '::1' && host !== '[::1]') return t('invalidUpstream')
          if (!draft.realm.trim()) return t('realmRequired')
          return null
        }
        const onSave = () => run('listener', async () => {
          const invalid = validateListener()
          if (invalid) { say('listener', invalid); return }
          const value = await result('listener', await rpc.save({
            port: Number(draft.port), targetHost: draft.targetHost.trim(), targetPort: Number(draft.targetPort),
            addresses: linesToArray(draft.addresses), allowedHosts: linesToArray(draft.allowedHosts), realm: draft.realm.trim(),
            sessionMaxAgeSeconds: Number(draft.sessionMaxAgeSeconds), sessionIdleTimeoutSeconds: Number(draft.sessionIdleTimeoutSeconds),
          }))
          if (value) { adopt(value, true); listenerNotice(value, true) }
        })
        const onToggle = (next) => run('listener', async () => {
          const value = await result('listener', await rpc.save({ enabled: next }))
          if (value) { adopt(value); listenerNotice(value, true) }
        })
        const onChangePassword = () => run('password', async () => {
          if (newPassword.length < 8) { say('password', t('passwordTooShort')); return }
          const firstTime = data.hasPassword !== true
          if (!firstTime && currentPassword === '') { say('password', t('currentPasswordRequired')); return }
          const value = await result('password', await rpc.changePassword(firstTime ? '' : currentPassword, newPassword))
          if (value) {
            adopt(value)
            setCurrentPassword('')
            setNewPassword('')
            setTotpPassword('')
            say('totp', null)
            say('password', t(firstTime ? 'passwordCreated' : 'passwordChanged'), true)
          }
        })
        const onTotpBegin = () => run('totp', async () => {
          if (!data.hasPassword) { say('totp', t('stateNoPassword')); return }
          const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
          const bytes = new Uint8Array(20)
          globalThis.crypto.getRandomValues(bytes)
          let secret = ''
          for (const byte of bytes) secret += alphabet[byte % 32]
          setTotpSecret(secret)
          setTotpCode('')
          say('totp', t('totpSecret'), true)
        })
        const onTotpEnable = () => run('totp', async () => {
          if (!totpSecret) { say('totp', t('secretRequired')); return }
          if (!/^\d{6}$/.test(totpCode)) { say('totp', t('invalidTotp')); return }
          const value = await result('totp', await rpc.totp('enable', { secret: totpSecret, code: totpCode }))
          if (value) {
            setData((current) => ({ ...current, twoFactorEnabled: value.twoFactorEnabled }))
            setTotpSecret(''); setTotpCode(''); setTotpPassword('')
            say('totp', t('totpEnabled'), true)
          }
        })
        const onTotpDisable = () => run('totp', async () => {
          if (!totpPassword) { say('totp', t('currentPasswordRequired')); return }
          const value = await result('totp', await rpc.totp('disable', { password: totpPassword }))
          if (value) {
            setData((current) => ({ ...current, twoFactorEnabled: value.twoFactorEnabled }))
            setTotpPassword(''); setTotpSecret(''); setTotpCode('')
            say('totp', t('totpDisabled'), true)
          }
        })
        const onDiagnose = () => run('diagnostics', async () => {
          const value = await result('diagnostics', await rpc.diagnose())
          if (value) { setDiagnosis(value); say('diagnostics', t('diagnosisReady'), true) }
        })
        const disabled = busy !== null
        const button = (label, action, primary = false) => h('button', { type: 'button', disabled, onClick: action, className: primary ? 'primary' : undefined }, label)
        function field(label, value, onChange, options = {}, hint) {
          const { multiline, ...props } = options
          return h('label', { className: 'ag-field' }, h('span', null, label),
            h(multiline ? 'textarea' : 'input', { type: multiline ? undefined : 'text', value, disabled, ...props, onChange: (event) => onChange(event.target.value) }),
            hint ? h('small', null, hint) : null)
        }
        const listenerField = (key, label, options, hint) => field(t(label), draft[key], (value) => update(key, value), options, hint ? t(hint) : undefined)
        const passwordField = (key, value, setter, section, options = {}, hint) => field(t(key), value, (next) => { setter(next); say(section, null) }, { type: 'password', ...options }, hint ? t(hint) : undefined)
        const diagnosisPanel = h('section', { className: 'ag-card', 'aria-label': t('diagnose') },
          h('h3', null, t('diagnose')),
          h('div', { className: 'ag-actions' }, button(t('diagnose'), onDiagnose)),
          notice('diagnostics'),
          diagnosis ? h('details', null, h('summary', null, t('diagnosisDetails')), h('pre', { className: 'ag-mono' }, JSON.stringify(diagnosis, null, 2))) : null)
        const header = h('header', null, h('h3', null, t('title')), h('p', { className: 'ag-summary' }, t('summary')))
        if (phase !== 'ready' || !data || !draft) {
          return h('div', { className: 'dsh-auth-gateway', 'aria-busy': phase === 'loading' }, header,
            h('section', { className: 'ag-card', 'aria-label': t('listener') },
              h('p', { className: 'ag-summary' }, t(phase === 'loading' ? 'loading' : 'unavailable')),
              notice('listener'), button(t('reload'), () => run('listener', () => refresh()))), diagnosisPanel)
        }
        const running = data.running === true
        const runtimeError = data.seamError || (data.error !== 'no_password' ? data.error : null)
        const stateLabel = running ? t('stateRunning') : data.error === 'no_password' || !data.hasPassword ? t('stateNoPassword') : runtimeError ? t('stateSeamError') : t('stateStopped')
        const addresses = Array.isArray(data.listening) && data.listening.length ? data.listening.map((entry) => `${entry.address}:${entry.port}`).join(', ') : t('notListening')
        return h('div', { className: 'dsh-auth-gateway' }, header,
          h('section', { className: 'ag-card', 'aria-label': t('listener') },
            h('label', { className: 'ag-switch' },
              h('input', { type: 'checkbox', role: 'switch', checked: data.enabled === true, 'aria-checked': data.enabled === true, disabled, onChange: (event) => onToggle(event.target.checked), 'aria-label': t('enable') }),
              h('strong', null, t('enable')), h('span', { className: `ag-badge ${running ? 'on' : runtimeError || !data.hasPassword ? 'warn' : 'off'}` }, stateLabel)),
            h('small', null, t('enableHint')),
            h('span', { className: 'ag-mono' }, `${t('listeningOn')}: ${addresses}`),
            h('h3', null, t('listener')),
            h('div', { className: 'ag-grid' },
              listenerField('port', 'port', { type: 'number', min: 1, max: 65535, step: 1 }),
              listenerField('sessionMaxAgeSeconds', 'sessionMaxAge', { type: 'number', min: 300, max: 2592000, step: 1 }),
              listenerField('sessionIdleTimeoutSeconds', 'sessionIdle', { type: 'number', min: 60, max: 2592000, step: 1 })),
            listenerField('addresses', 'addresses', { multiline: true, placeholder: '192.168.1.10' }, 'addressesHint'),
            listenerField('allowedHosts', 'allowedHosts', { multiline: true, placeholder: 'dsh.example.com' }, 'allowedHostsHint'),
            h('div', { className: 'ag-grid' }, listenerField('targetHost', 'upstream'), listenerField('targetPort', 'targetPort', { type: 'number', min: 0, max: 65535, step: 1 })),
            h('small', null, t('upstreamHint')), listenerField('realm', 'realm'),
            h('div', { className: 'ag-actions' }, button(busy === 'listener' ? t('saving') : t('save'), onSave, true), button(t('reload'), () => run('listener', async () => { await refresh(true) }))),
            notice('listener')),
          h('section', { className: 'ag-card', 'aria-label': t('passwordTitle') },
            h('h3', null, t('passwordTitle')),
            h('div', { className: 'ag-actions' }, h('span', null, `${t('username')}: ${data.username ?? ''}`), h('span', { className: 'ag-badge' }, `${t('passwordState')}: ${t(data.hasPassword ? 'hasPassword' : 'noPassword')}`)),
            data.hasPassword ? passwordField('currentPassword', currentPassword, setCurrentPassword, 'password', { autoComplete: 'current-password' }) : h('small', null, t('firstPasswordHint')),
            passwordField(data.hasPassword ? 'newPassword' : 'firstPassword', newPassword, setNewPassword, 'password', { autoComplete: 'new-password' }, 'newPasswordHint'),
            h('div', { className: 'ag-actions' }, button(busy === 'password' ? t('changing') : t(data.hasPassword ? 'changePassword' : 'firstPassword'), onChangePassword, true)), notice('password')),
          h('section', { className: 'ag-card', 'aria-label': t('totpTitle') },
            h('h3', null, t('totpTitle')), h('span', { className: 'ag-badge' }, `${t('totpState')}: ${t(data.twoFactorEnabled ? 'totpOn' : 'totpOff')}`),
            h('small', null, t('totpHint')),
            data.twoFactorEnabled ? h(React.Fragment, null,
              passwordField('currentPassword', totpPassword, setTotpPassword, 'totp', { autoComplete: 'current-password' }),
              h('div', { className: 'ag-actions' }, button(t('totpDisable'), onTotpDisable))) : h(React.Fragment, null,
              h('div', { className: 'ag-actions' }, button(t('totpBegin'), onTotpBegin)),
              totpSecret ? h(React.Fragment, null,
                h('div', null, h('small', null, t('totpSecret')), h('div', { className: 'ag-mono' }, totpSecret)),
                field(t('totpCode'), totpCode, (value) => { setTotpCode(value); say('totp', null) }, { inputMode: 'numeric', maxLength: 6, autoComplete: 'one-time-code' }),
                h('div', { className: 'ag-actions' }, button(t('totpEnable'), onTotpEnable, true))) : null),
            notice('totp')),
          diagnosisPanel, h('p', { className: 'ag-note' }, t('loginHint')), h('p', { className: 'ag-note' }, t('note')))
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

      ctx.effect(() => {
        if (typeof document === 'undefined') return undefined
        const previous = document.getElementById(STYLE_ID)
        const style = document.createElement('style')
        style.id = STYLE_ID
        style.textContent = STYLE
        previous?.remove()
        document.head.append(style)
        // Remove only this apply instance's node during disposal or reload.
        return () => style.remove()
      }, 'auth gateway stylesheet')

      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'auth-gateway',
        order: 20,
        label: () => t('sectionLabel'),
        locale: LOCALE_NS,
        inject: () => ({ rpc }),
      }, SettingsPage)), 'auth gateway settings section')

    }

    exports.inject = ['connection', 'locale', 'slots']
    exports.apply = apply
    return module.exports
  },
})
