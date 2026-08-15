// host.js — Model Capabilities 插件 Host 半
// 用法:把本文件整个内容粘贴到 cordis_define 的 code.host 字段(纯 JS 函数体,返回 Cordis Plugin)。
// 提供两个包私有 RPC:
//   model-caps:list  — 读取所有 pi-ai provider 的模型及当前能力
//   model-caps:save  — 合并编辑并 settings.mutate('llm-pi-ai', ops) 持久化

return {
  apply(ctx) {
    const readSection = () => {
      const settings = ctx.get('settings')
      return settings === undefined ? undefined : settings.get('llm-pi-ai')
    }
    // 基线模型列表:优先用已解析配置的 models(含 base/catalog 层),
    // 否则向适配器查询 listModels;再合并 modelOverrides 的字段。
    const loadModels = async (provider, profile) => {
      const llm = ctx.get('llm')
      let models = Array.isArray(profile?.models) && profile.models.length > 0
        ? profile.models.map((m) => ({ ...m }))
        : null
      if (models === null && llm !== undefined) {
        try {
          const listed = await llm.listModels(provider)
          models = listed.map((m) => ({
            id: m.id,
            name: m.name,
            ...(Array.isArray(m.inputModalities) ? { input: [...m.inputModalities] } : {}),
          }))
        } catch (e) {
          models = []
        }
      }
      if (models === null) models = []
      const overrides = profile?.modelOverrides
      if (overrides !== undefined) {
        models = models.map((m) => ({ ...m, ...(overrides[m.id] ?? {}) }))
      }
      return models
    }
    // RPC 返回必须是纯 JSON:缺省字段用条件展开跳过,绝不带 undefined 值。
    const normalizeModel = (m) => ({
      id: m.id,
      name: m.name,
      ...(Array.isArray(m.input) ? { input: [...m.input] } : {}),
      ...(m.reasoningEfforts !== undefined ? { reasoningEfforts: m.reasoningEfforts } : {}),
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
      ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    })

    harness.handle('model-caps:list', async () => {
      const llm = ctx.get('llm')
      const settings = ctx.get('settings')
      if (llm === undefined || settings === undefined) {
        return { ok: false, error: 'llm/settings 服务不可用' }
      }
      const section = readSection()
      const providers = llm.listConfigurableProviders()
      const out = []
      for (const p of providers) {
        const profile = section?.providers?.[p.provider]
        const models = await loadModels(p.provider, profile)
        out.push({
          provider: p.provider,
          displayName: typeof profile?.displayName === 'string' ? profile.displayName : p.displayName,
          declared: p.declared === true,
          defaultEffort: typeof profile?.reasoning === 'string' ? profile.reasoning : null,
          models: models.map(normalizeModel),
        })
      }
      return { ok: true, value: { providers: out } }
    })

    harness.handle('model-caps:save', async (args) => {
      const settings = ctx.get('settings')
      if (settings === undefined) return { ok: false, error: 'settings 服务不可用' }
      const provider = args?.provider
      const edits = args?.models
      if (typeof provider !== 'string' || !Array.isArray(edits)) {
        return { ok: false, error: 'invalid request: provider and models[] required' }
      }
      const section = readSection()
      const profile = section?.providers?.[provider]
      const base = await loadModels(provider, profile)
      const next = base.map((m) => ({ ...m }))
      for (const edit of edits) {
        if (typeof edit?.id !== 'string') continue
        const at = next.findIndex((m) => m.id === edit.id)
        if (at < 0) continue
        const merged = { ...next[at] }
        if (edit.reasoningEfforts !== undefined) merged.reasoningEfforts = edit.reasoningEfforts
        if (edit.input !== undefined) merged.input = edit.input
        next[at] = merged
      }
      const ops = [{ op: 'set', path: ['providers', provider, 'models'], value: next }]
      const defaultEffort = args?.defaultEffort
      if (defaultEffort !== undefined) {
        if (defaultEffort === null) ops.push({ op: 'unset', path: ['providers', provider, 'reasoning'] })
        else ops.push({ op: 'set', path: ['providers', provider, 'reasoning'], value: defaultEffort })
      }
      try {
        await settings.mutate('llm-pi-ai', ops)
        return { ok: true }
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })
  },
}
