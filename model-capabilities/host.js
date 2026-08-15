// host.js — Model Capabilities 插件 Host 半
// 用法:把本文件整个内容粘贴到 cordis_define 的 code.host 字段(纯 JS 函数体,返回 Cordis Plugin)。
// 提供两个包私有 RPC:
//   model-caps:list  — 读取已配置的 pi-ai provider 与 DeepSeek 官方供应商及其模型/能力
//   model-caps:save  — 仅对已配置 route 合并编辑并 settings.mutate 持久化

return {
  apply(ctx) {
    const readSection = (ns) => {
      const settings = ctx.get('settings')
      return settings === undefined ? undefined : settings.get(ns)
    }
    // 动态插件运行在独立 vm realm,字面量/展开对象的原型不是宿主 Object.prototype,
    // 会被 settings 的 isPlainObject 校验拒绝。递归转成 proto === null 的 plain 树。
    const toPlain = (value) => {
      if (value === null || typeof value !== 'object') return value
      if (Array.isArray(value)) return value.map(toPlain)
      const out = Object.create(null)
      for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) out[key] = toPlain(entry)
      }
      return out
    }
    // settings path op:proto === null 对象,通过宿主 isPlainObject 校验。
    const makeOp = (op, path, value) => {
      const entry = Object.create(null)
      entry.op = op
      entry.path = path
      if (value !== undefined) entry.value = value
      return entry
    }
    // 基线模型列表:优先用已解析配置的 models(含 base/catalog 层),
    // 否则向适配器查询 listModels;再合并 modelOverrides 的字段。
    const loadPiModels = async (provider, profile) => {
      const llm = ctx.get('llm')
      let models = Array.isArray(profile?.models) && profile.models.length > 0
        ? profile.models.map((model) => ({ ...model }))
        : null
      if (models === null && llm !== undefined) {
        try {
          const listed = await llm.listModels(provider)
          models = listed.map((model) => ({
            id: model.id,
            name: model.name,
            ...(Array.isArray(model.inputModalities) ? { input: [...model.inputModalities] } : {}),
          }))
        } catch (error) {
          models = []
        }
      }
      if (models === null) models = []
      const overrides = profile?.modelOverrides
      if (overrides !== undefined) {
        models = models.map((model) => ({ ...model, ...(overrides[model.id] ?? {}) }))
      }
      return models
    }
    // DeepSeek 官方适配器(独立命名空间/路由)的模型列表。
    const loadOfficialModels = async (profile) => {
      const llm = ctx.get('llm')
      if (Array.isArray(profile?.models) && profile.models.length > 0) {
        return profile.models.map((model) => ({ ...model }))
      }
      if (llm === undefined) return []
      try {
        return (await llm.listModels('deepseek-official')).map((model) => ({
          id: model.id,
          name: model.name,
          input: ['text'],
        }))
      } catch (error) {
        return []
      }
    }
    // RPC 返回必须是纯 JSON:缺省字段用条件展开跳过,绝不带 undefined 值。
    const normalizeModel = (model) => ({
      id: model.id,
      name: model.name,
      ...(Array.isArray(model.input) ? { input: [...model.input] } : {}),
      ...(model.reasoningEfforts !== undefined ? { reasoningEfforts: model.reasoningEfforts } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    })
    // 已配置的 pi-ai provider route 集合(settings.yaml 的 providers keys)。
    // 注意:pi-ai 内置目录含大量未配置候选,绝不能把它们当可编辑目标。
    const configuredProviders = (section) => {
      const providers = section?.providers
      if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) return []
      return Object.keys(providers)
    }

    harness.handle('model-caps:list', async () => {
      const llm = ctx.get('llm')
      const settings = ctx.get('settings')
      if (llm === undefined || settings === undefined) {
        return { ok: false, error: 'llm/settings 服务不可用' }
      }
      const piSection = readSection('llm-pi-ai')
      const out = []
      for (const provider of configuredProviders(piSection)) {
        const profile = piSection?.providers?.[provider]
        const models = await loadPiModels(provider, profile)
        out.push({
          provider,
          displayName: typeof profile?.displayName === 'string' ? profile.displayName : provider,
          kind: 'pi-ai',
          defaultEffort: typeof profile?.reasoning === 'string' ? profile.reasoning : null,
          models: models.map(normalizeModel),
        })
      }
      // 官方适配器拥有独立命名空间和路由;命名空间已注册时才列出。
      const official = readSection('llm-deepseek')
      if (official !== undefined) {
        const models = await loadOfficialModels(official)
        const defaultEffort = typeof official.reasoningEffort === 'string' ? official.reasoningEffort : null
        out.unshift({
          provider: 'deepseek-official',
          displayName: 'DeepSeek 官方',
          kind: 'deepseek',
          thinkingEnabled: official.thinking !== 'disabled',
          defaultEffort,
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
      // DeepSeek 官方:推理等级是提供商级统一设置,写入 llm-deepseek 命名空间。
      if (provider === 'deepseek-official') {
        const profile = readSection('llm-deepseek')
        if (profile === undefined) return { ok: false, error: '官方供应商未配置,跳过' }
        const defaultEffort = args?.defaultEffort
        const ops = []
        if (defaultEffort === null || defaultEffort === undefined) {
          ops.push(makeOp('unset', ['reasoningEffort']))
        } else {
          ops.push(makeOp('set', ['reasoningEffort'], defaultEffort))
        }
        try {
          await settings.mutate('llm-deepseek', ops)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
      // pi-ai 自定义提供商:仅允许保存已配置的 route。
      const section = readSection('llm-pi-ai')
      const profile = section?.providers?.[provider]
      if (profile === undefined) return { ok: false, error: `provider "${provider}" 未配置,跳过` }
      const base = await loadPiModels(provider, profile)
      const next = base.map((model) => ({ ...model }))
      for (const edit of edits) {
        if (typeof edit?.id !== 'string') continue
        const at = next.findIndex((model) => model.id === edit.id)
        if (at < 0) continue
        const merged = { ...next[at] }
        if (edit.reasoningEfforts !== undefined) merged.reasoningEfforts = edit.reasoningEfforts
        if (edit.input !== undefined) merged.input = edit.input
        next[at] = merged
      }
      const ops = [makeOp('set', ['providers', provider, 'models'], toPlain(next))]
      const defaultEffort = args?.defaultEffort
      if (defaultEffort !== undefined) {
        if (defaultEffort === null) ops.push(makeOp('unset', ['providers', provider, 'reasoning']))
        else ops.push(makeOp('set', ['providers', provider, 'reasoning'], defaultEffort))
      }
      try {
        await settings.mutate('llm-pi-ai', ops)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  },
}
