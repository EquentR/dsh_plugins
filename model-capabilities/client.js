// client.js — Model Capabilities 插件 Client 半
// 用法:把本文件整个内容粘贴到 cordis_define 的 code.client 字段(纯 JS 函数体,返回 Cordis Plugin)。
// 注册 settings.section 新页面「模型能力」:为已配置的第三方模型配置推理等级与图片支持,
// 并展示 DeepSeek 官方供应商的提供商级推理设置。

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const OFFICIAL_LEVELS = ['off', 'high', 'max']

function ModelCapabilitiesPage() {
  const [state, setState] = React.useState({ status: 'loading', providers: [], error: null, notice: null })
  const [draft, setDraft] = React.useState(null)
  const [busy, setBusy] = React.useState(false)

  const load = () => {
    setState((current) => ({ ...current, status: 'loading' }))
    host.call('model-caps:list', {}).then((res) => {
      if (res && res.ok === true) {
        const next = {}
        for (const provider of res.value.providers) {
          next[provider.provider] = {
            provider: provider.provider,
            displayName: provider.displayName,
            kind: provider.kind,
            thinkingEnabled: provider.thinkingEnabled,
            defaultEffort: provider.defaultEffort ?? null,
            models: provider.models.map((model) => ({
              id: model.id,
              name: model.name,
              reasoningEnabled: model.reasoningEfforts !== false,
              reasoningEfforts:
                model.reasoningEfforts && typeof model.reasoningEfforts === 'object'
                  ? { ...model.reasoningEfforts }
                  : { low: 'low', high: 'high', off: null },
              input: Array.isArray(model.input) ? [...model.input] : ['text'],
            })),
          }
        }
        setDraft(next)
        setState({ status: 'ready', providers: res.value.providers, error: null, notice: null })
      } else {
        setState({ status: 'error', providers: [], error: res && res.error ? res.error : '加载失败', notice: null })
      }
    }).catch((error) => {
      setState({ status: 'error', providers: [], error: String((error && error.message) || error), notice: null })
    })
  }

  React.useEffect(() => { load() }, [])

  if (state.status === 'loading') return React.createElement('div', { className: 'mcap-note' }, '加载模型能力…')
  if (state.status === 'error' || draft === null) {
    return React.createElement('div', { className: 'mcap-note' },
      React.createElement('p', { className: 'mcap-error' }, state.error || '无法加载'),
      React.createElement('button', { className: 'mcap-btn', onClick: load }, '重试')
    )
  }

  const setDefault = (provider, value) => {
    setDraft((current) => ({ ...current, [provider]: { ...current[provider], defaultEffort: value === '' ? null : value } }))
  }
  const setModel = (provider, modelId, patch) => {
    setDraft((current) => ({
      ...current,
      [provider]: {
        ...current[provider],
        models: current[provider].models.map((model) => model.id === modelId ? { ...model, ...patch } : model),
      },
    }))
  }
  const toggleLevel = (provider, modelId, level) => {
    const model = draft[provider].models.find((item) => item.id === modelId)
    const next = { ...model.reasoningEfforts }
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
    const model = draft[provider].models.find((item) => item.id === modelId)
    const current = Array.isArray(model.input) ? model.input : ['text']
    const hasImage = current.includes('image')
    setModel(provider, modelId, {
      input: image ? (hasImage ? current : [...current, 'image']) : (hasImage ? current.filter((item) => item !== 'image') : current),
    })
  }

  const save = () => {
    const providers = Object.entries(draft)
    if (providers.length === 0) {
      setState((current) => ({ ...current, notice: '没有已配置的提供商,无需保存' }))
      return
    }
    for (const [, provider] of providers) {
      if (provider.kind === 'deepseek') continue
      for (const model of provider.models) {
        if (model.reasoningEnabled && !Object.keys(model.reasoningEfforts).some((level) => level !== 'off')) {
          setState((current) => ({ ...current, notice: '模型必须至少选择一个思考等级(off 之外),或关闭"支持推理"' }))
          return
        }
      }
    }
    setBusy(true)
    const calls = providers.map(([provider, entry]) => host.call('model-caps:save', {
      provider,
      defaultEffort: entry.defaultEffort,
      models: entry.models.map((model) => ({
        id: model.id,
        name: model.name,
        reasoningEfforts: model.reasoningEnabled ? model.reasoningEfforts : false,
        input: model.input,
      })),
    }))
    Promise.all(calls).then((results) => {
      setBusy(false)
      const failed = results.find((result) => !(result && result.ok === true))
      if (failed) setState((current) => ({ ...current, notice: '保存失败: ' + ((failed && failed.error) || '未知错误') }))
      else {
        setState((current) => ({ ...current, notice: '已保存,模型选择器已更新' }))
        load()
      }
    }).catch((error) => {
      setBusy(false)
      setState((current) => ({ ...current, notice: '保存失败: ' + String((error && error.message) || error) }))
    })
  }

  const renderLevels = (provider, model) => {
    const levels = provider.kind === 'deepseek' ? OFFICIAL_LEVELS : THINKING_LEVELS
    return React.createElement('div', { className: 'mcap-levels' }, levels.map((level) =>
      React.createElement('label', { key: level, className: 'mcap-level' },
        React.createElement('input', {
          type: 'checkbox',
          checked: level in model.reasoningEfforts,
          onChange: () => toggleLevel(provider.provider, model.id, level),
          disabled: provider.kind === 'deepseek',
        }),
        ' ' + level
      )
    ))
  }
  const renderNameField = (provider, model) => {
    return React.createElement('label', { className: 'mcap-name-field' },
      '显示名称 ',
      React.createElement('input', {
        className: 'mcap-name-input',
        value: model.name || '',
        placeholder: model.id,
        onChange: (event) => setModel(provider.provider, model.id, { name: event.target.value }),
      })
    )
  }
  const renderModel = (provider, model) => {
    if (provider.kind === 'deepseek') {
      return React.createElement('div', { key: model.id, className: 'mcap-model' },
        React.createElement('div', { className: 'mcap-model-head' },
          renderNameField(provider, model),
          React.createElement('code', { className: 'mcap-model-id' }, model.id),
          React.createElement('span', { className: 'mcap-disabled' }, '官方适配器:所有模型共用提供商级推理设置,不支持图片输入')
        )
      )
    }
    return React.createElement('div', { key: model.id, className: 'mcap-model' },
      React.createElement('div', { className: 'mcap-model-head' },
        renderNameField(provider, model),
        React.createElement('code', { className: 'mcap-model-id' }, model.id),
        React.createElement('label', { className: 'mcap-switch' },
          React.createElement('input', { type: 'checkbox', checked: model.reasoningEnabled, onChange: (event) => toggleReasoning(provider.provider, model.id, event.target.checked) }),
          ' 支持推理'
        ),
        React.createElement('label', { className: 'mcap-switch' },
          React.createElement('input', { type: 'checkbox', checked: model.input.includes('image'), onChange: (event) => toggleImage(provider.provider, model.id, event.target.checked) }),
          ' 支持图片'
        )
      ),
      model.reasoningEnabled ? renderLevels(provider, model) : null
    )
  }

  const empty = Object.keys(draft).length === 0
  return React.createElement('div', { className: 'mcap-root' },
    React.createElement('div', { className: 'mcap-head' },
      React.createElement('h3', { className: 'mcap-title' }, '模型能力'),
      React.createElement('p', { className: 'mcap-sub' }, '为每个已配置的第三方模型配置支持的推理等级与图片输入。保存后模型选择器会按配置显示推理等级下拉,并在附加图片时校验支持。'),
      React.createElement('button', { className: 'mcap-btn mcap-btn-primary', onClick: save, disabled: busy }, busy ? '保存中…' : '保存全部')
    ),
    state.notice ? React.createElement('p', { className: 'mcap-notice' }, state.notice) : null,
    empty ? React.createElement('p', { className: 'mcap-note' }, '暂无已配置的提供商。请先在「模型」设置页添加提供商与模型,再回来配置其能力。') : Object.values(draft).map((provider) =>
      React.createElement('div', { key: provider.provider, className: 'mcap-card' },
        React.createElement('div', { className: 'mcap-card-head' },
          React.createElement('div', { className: 'mcap-provider-title' },
            React.createElement('span', { className: 'mcap-provider' }, provider.displayName || provider.provider),
            React.createElement('code', { className: 'mcap-provider-id' }, provider.provider)
          ),
          React.createElement('label', { className: 'mcap-field' },
            provider.kind === 'deepseek' ? '官方默认推理等级 ' : '默认推理等级 ',
            React.createElement('select', {
              className: 'mcap-select',
              value: provider.defaultEffort === null ? '' : provider.defaultEffort,
              onChange: (event) => setDefault(provider.provider, event.target.value),
            },
              React.createElement('option', { value: '' }, '不设置(继承)'),
              (provider.kind === 'deepseek' ? OFFICIAL_LEVELS : THINKING_LEVELS).map((level) => React.createElement('option', { key: level, value: level }, level))
            )
          )
        ),
        provider.models.length === 0 ? React.createElement('p', { className: 'mcap-note' }, '该提供商暂无模型') : provider.models.map((model) => renderModel(provider, model))
      )
    ),
    React.createElement('p', { className: 'mcap-foot' }, '说明:推理等级为每模型能力;wire 值默认取等级名(off 为省略)。官方 DeepSeek 适配器的推理等级为提供商级统一设置。')
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
.mcap-provider-title { display: flex; align-items: baseline; gap: 8px; }
.mcap-provider { font-weight: 600; font-size: 14px; }
.mcap-provider-id { font-size: 11px; opacity: .6; }
.mcap-field { font-size: 12px; display: inline-flex; align-items: center; gap: 6px; }
.mcap-select { font-size: 12px; padding: 2px 6px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; }
.mcap-model { border-top: 1px solid rgba(128,128,128,.15); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.mcap-model-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.mcap-model-name { font-size: 13px; font-weight: 600; }
.mcap-model-id { font-size: 11px; opacity: .6; }
.mcap-name-field { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; }
.mcap-name-input { width: 180px; min-width: 120px; font-size: 12px; padding: 3px 6px; border-radius: 6px; border: 1px solid rgba(128,128,128,.4); background: transparent; }
.mcap-switch { font-size: 12px; display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.mcap-disabled { font-size: 11px; opacity: .6; }
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
