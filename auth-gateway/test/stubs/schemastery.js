// Minimal stand-in for @deepseek-ai/schemastery.
//
// The real package is injected by the dsh host at runtime and is not resolvable
// from this repository, so tests that exercise index.js import this stub
// instead. It implements only the chainable builder shape index.js uses; real
// validation belongs to the Loader.
const chain = () => {
  const api = {
    default: () => api,
    volatile: () => api,
    role: () => api,
    min: () => api,
    max: () => api,
    step: () => api,
    required: () => api,
  }
  return api
}

const z = {
  boolean: chain,
  natural: chain,
  string: chain,
  array: chain,
  object: () => ({ default: () => ({}) }),
  union: chain,
  const: chain,
}

export default z
export { z }
