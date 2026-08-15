// client.js — Model Capabilities 插件 Client 半
// 用法:把本文件整个内容粘贴到 cordis_define 的 code.client 字段(纯 JS 函数体,返回 Cordis Plugin)。
// 注册 settings.section 新页面「模型能力」:为每个第三方模型配置推理等级与图片支持。

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function ModelCapabilitiesPage() {
  const [state, setState] = React.useState({ status: 'loading', providers: [], error: null, notice: null })
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const load = () => {
    setState((s) => ({ ...s, status: 'loading' }))
    host.call('model-caps:list', {}).then((res) => {
      if (res && res.ok === true) {
        const d = {}
        for (const p of res.value.providers) {
          d[p.provider] = {
            defaultEffort: p.defaultEffort ?? null,
            models: p.models.map((m) => ({
              id: m.id,
              name: m.name,
              reasoningEnabled: m.reasoningEfforts !== false,
              reasoningEfforts:
                m.reasoningEfforts && typeof m.reasoningEfforts === 'object'
                  ? { ...m.reasoningEfforts }
                  : { low: 'low', high: 'high', off: null },
              input: Array.isArray(m.input) ? [...m.input] : ['text'],
            })),
          }
        }
        setDraft(d)
        setState({ status: 'ready', providers: res.value.providers, error: null, notice: null })
      } else {
        setState({ status: 'error', providers: [], error: res && res.error ? res.error : '加载失败', notice: null })
      }
    }).catch((e) => {
      setState({ status: 'error', providers: [], error: String((e && e.message) || e), notice: null })
    })
  }

  React.useEffect(() => { load() }, [])

  if (state.status === 'loading') {
    return React.createElement('div', { className: 'mcap-note' }, '加载模型能力…')
  }
  if (state.status === 'error' || draft === null) {
    return React.createElement('div', { className: 'mcap-note' },
      React.createElement('p', { className: 'mcap-error' }, state.error || '无法加载'),
      React.createElement('button', { className: 'mcap-btn', onClick: load }, '重试')
    )
  }

  const setDefault = (provider, value) => {
    setDraft((d) => ({ ...d, [provider]: { ...d[provider], defaultEffort: value === '' ? null : value } }))
  }
  const setModel = (provider, modelId, patch) => {
    setDraft((d) => ({
      ...d,
      [provider]: {
        ...d[provider],
        models: d[provider].models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)),
      },
    }))
  }
  const toggleLevel = (provider, modelId, level) => {
    const p = draft[provider]
    const m = p.models.find((x) => x.id === modelId)
    const next = { ...m.reasoningEfforts }
    if (level in next) delete next[level]
    else next[level] = level === 'off' ? null : level
    setModel(provider, modelId, { reasoningEfforts: next })
  }
  const toggleReasoning = (provider, modelId, enabled) => {
    setModel(provider, modelId, {
      reasoningEnabled: enabled,
      reasoningEfforts: enabled ? { low: 'low', high: 'high', off: null } : {},
    })
  }
  const toggleImage = (provider, modelId, image) => {
    const has = (arr) => Array.isArray(arr) && arr.includes('image')
    const cur = draft[provider].models.find((x) => x.id === modelId).input
    setModel(provider, modelId, {
      input: image ? (has(cur) ? cur : [...cur, 'image']) : (has(cur) ? cur.filter((x) => x !== 'image') : cur),
    })
  }

  const save = () => {
    const providers = Object.entries(draft)
    if (providers.length === 0) {
      setState((s) => ({ ...s, notice: '没有已配置的提供商,无需保存' }))
      return
    }
    for (const [, p] of providers) {
      for (const m of p.models) {
        if (m.reasoningEnabled) {
          const hasThinking = Object.keys(m.reasoningEfforts).some((l) => l !== 'off')
          if (!hasThinking) {
            setState((s) => ({ ...s, notice: '模型必须至少选择一个思考等级(off 之外),或关闭"支持推理"' }))
            return
          }
        }
      }
    }
    setBusy(true)
    const calls = providers.map(([provider, d]) =>
      host.call('model-caps:save', {
        provider,
        defaultEffort: d.defaultEffort,
        models: d.models.map((m) => ({
          id: m.id,
          reasoningEfforts: m.reasoningEnabled ? m.reasoningEfforts : false,
          input: m.input,
        })),
      })
    )
    Promise.all(calls).then((results) => {
      setBusy(false)
      const failed = results.find((r) => !(r && r.ok === true))
      if (failed) setState((s) => ({ ...s, notice: '保存失败: ' + ((failed && failed.error) || '未知错误') }))
      else {
        setState((s) => ({ ...s, notice: '已保存,模型选择器已更新' }))
        load()
      }
    }).catch((e) => {
      setBusy(false)
      setState((s) => ({ ...s, notice: '保存失败: ' + String((e && e.message) || e) }))
    })
  }

  const empty = draft && Object.keys(draft).length === 0
  return React.createElement('div', { className: 'mcap-root' },
    React.createElement('div', { className: 'mcap-head' },
      React.createElement('h3', { className: 'mcap-title' }, '模型能力'),
      React.createElement('p', { className: 'mcap-sub' },
        '为每个已配置的第三方模型配置支持的推理等级与图片输入。保存后模型选择器会按配置显示推理等级下拉,并在附加图片时校验支持。'),
      React.createElement('button', { className: 'mcap-btn mcap-btn-primary', onClick: save, disabled: busy },
        busy ? '保存中…' : '保存全部')
    ),
    state.notice ? React.createElement('p', { className: 'mcap-notice' }, state.notice) : null,
    empty
      ? React.createElement('p', { className: 'mcap-note' }, '暂无已配置的提供商。请先在「模型」设置页添加提供商与模型,再回来配置其能力。')
      : Object.entries(draft).map(([provider, d]) =>
          React.createElement('div', { key: provider, className: 'mcap-card' },
            React.createElement('div', { className: 'mcap-card-head' },
              React.createElement('span', { className: 'mcap-provider' }, d.provider),
              React.createElement('label', { className: 'mcap-field' },
                '默认推理等级 ',
                React.createElement('select', {
                  className: 'mcap-select',
                  value: d.defaultEffort === null ? '' : d.defaultEffort,
                  onChange: (e) => setDefault(provider, e.target.value),
                },
                  React.createElement('option', { value: '' }, '不设置(继承)'),
                  THINKING_LEVELS.map((l) => React.createElement('option', { key: l, value: l }, l))
                )
              )
            ),
            d.models.length === 0
              ? React.createElement('p', { className: 'mcap-note' }, '该提供商暂无模型')
              : d.models.map((m) =>
                  React.createElement('div', { key: m.id, className: 'mcap-model' },
                    React.createElement('div', { className: 'mcap-model-head' },
                      React.createElement('span', { className: 'mcap-model-name' }, m.name || m.id),
                      React.createElement('code', { className: 'mcap-model-id' }, m.id),
                      React.createElement('label', { className: 'mcap-switch' },
                        React.createElement('input', {
                          type: 'checkbox',
                          checked: m.reasoningEnabled,
                          onChange: (e) => toggleReasoning(provider, m.id, e.target.checked),
                        }),
                        ' 支持推理'),
                      React.createElement('label', { className: 'mcap-switch' },
                        React.createElement('input', {
                          type: 'checkbox',
                          checked: Array.isArray(m.input) && m.input.includes('image'),
                          onChange: (e) => toggleImage(provider, m.id, e.target.checked),
                        }),
                        ' 支持图片')
                    ),
                    m.reasoningEnabled
                      ? React.createElement('div', { className: 'mcap-levels' },
                          THINKING_LEVELS.map((l) =>
                            React.createElement('label', { key: l, className: 'mcap-level' },
                              React.createElement('input', {
                                type: 'checkbox',
                                checked: l in m.reasoningEfforts,
                                onChange: () => toggleLevel(provider, m.id, l),
                              }),
                              ' ' + l
                            )
                          )
                        )
                      : null
                  )
                )
          )
        ),
    React.createElement('p', { className: 'mcap-foot' },
      '说明:推理等级为每模型能力;wire 值默认取等级名(off 为省略)。如需自定义 wire 拼写,可在 settings.yaml 中直接编辑 reasoningEfforts。')
  )
}

return {
  apply(ctx) {
    styles.insert(`
.mcap-root { display: flex; flex-direction: column; gap: 12px; padding: 4px 2px; }
.mcap-head { display: flex; flex-direction: column; gap: 6px; }
.mcap-title { margin: 0; font-size: 15px; font-weight: 600; }
.mcap-sub { margin: 0; font-size: 12px; opacity: .75; }
.mcap-notice, .mcap-error { margin: 0; font-size: 13px; }
.mcap-notice { color: #2e7d32; }
.mcap-error { color: #c62828; }
.mcap-note { font-size: 13px; opacity: .8; }
.mcap-btn { font-size: 13px; padding: 4px 12px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(128,128,128,.4); background: transparent; }
.mcap-btn:disabled { opacity: .5; cursor: default; }
.mcap-btn-primary { background: #4f46e5; color: #fff; border-color: #4f46e5; }
.mcap-card { border: 1px solid rgba(128,128,128,.3); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.mcap-card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.mcap-provider { font-weight: 600; font-size: 14px; }
.mcap-field { font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
.mcap-select { font-size: 12px; padding: 2px 6px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; }
.mcap-model { border-top: 1px solid rgba(128,128,128,.15); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.mcap-model-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mcap-model-name { font-size: 13px; font-weight: 600; }
.mcap-model-id { font-size: 11px; opacity: .6; }
.mcap-switch { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.mcap-levels { display: flex; flex-wrap: wrap; gap: 6px; }
.mcap-level { font-size: 12px; display: inline-flex; align-items: center; gap: 3px; cursor: pointer; }
.mcap-foot { font-size: 11px; opacity: .6; }
`)
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'model-capabilities', order: 11, label: () => '模型能力' },
      () => React.createElement(ModelCapabilitiesPage)
    ))
  },
}
