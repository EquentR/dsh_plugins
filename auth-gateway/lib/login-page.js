/**
 * Login page rendering for @dsh-plugins/auth-gateway.
 *
 * Renders one self-contained, password-manager-friendly HTML document with a
 * username/password form, an optional authenticator-code field, an inline error
 * area, and a language switcher.
 *
 * Scope note: the upstream plugin this was ported from also injected a PWA
 * bootstrap, a passkey ceremony, and a mobile drawer layout. All three are out
 * of scope here (see CONTRACT.md §0), so this module neither imports `pwa.js`
 * or `mobile.js` nor emits passkey markup.
 *
 * Every interpolated value is HTML-escaped. `realm`, `error`, and the language
 * links all derive from request-controlled data, so escaping them is a security
 * requirement rather than a formatting detail.
 */

const LOGIN_TEXT = Object.freeze({
  en: Object.freeze({
    htmlLang: 'en',
    title: 'DeepSeek Harness - Sign in',
    heading: 'DeepSeek Harness',
    username: 'Username',
    password: 'Password',
    otp: 'Authenticator code',
    submit: 'Sign in',
    invalid: 'Invalid username, password, or authenticator code',
    networkError: 'Unable to sign in. Please try again.',
    methodNotAllowed: 'Method not allowed',
    contentType: 'Content-Type must be application/json',
    invalidBody: 'Invalid request body',
    rateLimited: 'Too many login attempts',
    language: 'Language',
    chinese: '中文',
    english: 'English',
  }),
  zh: Object.freeze({
    htmlLang: 'zh-CN',
    title: 'DeepSeek Harness - 登录',
    heading: 'DeepSeek Harness',
    username: '用户名',
    password: '密码',
    otp: '验证码',
    submit: '登录',
    invalid: '用户名、密码或验证码无效',
    networkError: '登录失败，请稍后重试。',
    methodNotAllowed: '请求方法不被允许',
    contentType: '请求内容类型必须是 application/json',
    invalidBody: '请求内容无效',
    rateLimited: '登录尝试次数过多',
    language: '语言',
    chinese: '中文',
    english: 'English',
  }),
})

/** Locales this page can render, in switcher order. */
export const loginLocales = Object.freeze(['zh', 'en'])

/** Map one BCP 47 tag onto a supported locale, or undefined when unsupported. */
function languageOfTag(value) {
  const tag = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (tag === 'zh' || tag.startsWith('zh-')) return 'zh'
  if (tag === 'en' || tag.startsWith('en-')) return 'en'
  return undefined
}

/** The request target, falling back to the root for a malformed request. */
function requestUrl(req) {
  return typeof req?.url === 'string' && req.url !== '' ? req.url : '/'
}

/** Parse a request target without letting a malformed one throw. */
function safeUrl(rawUrl) {
  try {
    return new URL(String(rawUrl ?? '/'), 'http://dsh.internal')
  } catch {
    return new URL('http://dsh.internal/')
  }
}

/**
 * Select the login page language: an explicit `?lang=` wins, then the browser's
 * weighted `Accept-Language` preference, then English.
 *
 * @param {{ url?: string, headers?: Record<string, unknown> } | undefined} req - incoming node:http request (or a test double).
 * @returns {string} one of {@link loginLocales}.
 */
export function selectLoginLocale(req) {
  const url = safeUrl(requestUrl(req))
  const explicit = languageOfTag(url.searchParams.get('lang'))
  if (explicit !== undefined) return explicit

  const rawHeader = req?.headers?.['accept-language']
  const header = Array.isArray(rawHeader) ? rawHeader.join(',') : rawHeader
  const preferences = String(header ?? '')
    .split(',')
    .map((part, order) => {
      const pieces = part.trim().split(';')
      const locale = languageOfTag(pieces[0])
      const qualityPart = pieces.slice(1).find((piece) => /^\s*q\s*=/iu.test(piece))
      const quality = qualityPart === undefined ? 1 : Number(qualityPart.replace(/^\s*q\s*=\s*/iu, ''))
      return { locale, quality: Number.isFinite(quality) ? quality : 0, order }
    })
    .filter((entry) => entry.locale !== undefined && entry.quality > 0)
    .sort((left, right) => right.quality - left.quality || left.order - right.order)
  return preferences[0]?.locale ?? 'en'
}

/** Escape a value for use in HTML text or a double-quoted attribute. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** Resolve one locale's message table, falling back to English. */
function loginMessages(locale) {
  return LOGIN_TEXT[locale] ?? LOGIN_TEXT.en
}

/**
 * One localized message, falling back to English and then to the key itself.
 *
 * @param {string} locale - requested locale.
 * @param {string} key - message key.
 * @returns {string}
 */
export function loginErrorMessage(locale, key) {
  return loginMessages(locale)[key] ?? LOGIN_TEXT.en[key] ?? key
}

/**
 * Build the language-switcher target for one locale, preserving the rest of the
 * request target so mode query parameters survive the round trip.
 */
function languageHref(rawUrl, locale) {
  const url = safeUrl(rawUrl)
  url.searchParams.set('lang', locale)
  return `${url.pathname}${url.search}`
}

/**
 * Render the login document.
 *
 * @param {object} options - render inputs.
 * @param {string} [options.realm] - realm/description shown under the heading; escaped.
 * @param {boolean} [options.twoFactorEnabled] - whether to render the authenticator-code field.
 * @param {string} [options.locale] - one of {@link loginLocales}; anything else falls back to English.
 * @param {string} [options.rawRequestUrl] - original request target, used to preserve query parameters in the language links.
 * @param {string} [options.error] - message to show in the error area on first paint; escaped.
 * @returns {string} a complete HTML document.
 */
export function renderLoginPage({ realm, twoFactorEnabled = false, locale = 'en', rawRequestUrl = '/', error } = {}) {
  const language = LOGIN_TEXT[locale] === undefined ? 'en' : locale
  const text = loginMessages(language)
  const safeRealm = escapeHtml(realm ?? 'DeepSeek Harness Authentication')
  const loginAction = `/api/auth.login?lang=${encodeURIComponent(language)}`
  const zhHref = escapeHtml(languageHref(rawRequestUrl, 'zh'))
  const enHref = escapeHtml(languageHref(rawRequestUrl, 'en'))
  const initialError = typeof error === 'string' && error !== '' ? error : ''
  const errorStyle = initialError === '' ? '' : ' style="display: block"'
  const otpField = twoFactorEnabled
    ? `
    <label for="otp">${text.otp}</label>
    <input id="otp" name="totp" type="text" inputmode="numeric" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" pattern="[0-9]{6}" maxlength="6" required>`
    : ''
  return `<!doctype html>
<html lang="${text.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text.title}</title>
  <style>
    :root { color-scheme: dark; --bg: #0a0d14; --panel: #121826; --line: #334155; --text: #e2e8f0; --muted: #94a3b8; --accent: #3b82f6; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; padding: 20px; }
    form { width: 100%; max-width: 360px; padding: 28px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); }
    h1 { margin: 0 0 6px; font-size: 20px; }
    p { margin: 0 0 22px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    label { display: block; margin: 12px 0 6px; font-size: 13px; color: var(--muted); }
    input { width: 100%; height: 40px; padding: 0 12px; border: 1px solid var(--line); border-radius: 8px; background: #0b1120; color: var(--text); outline: none; }
    input:focus { border-color: var(--accent); }
    button { width: 100%; height: 42px; margin-top: 20px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .65; cursor: default; }
    .language { display: flex; justify-content: flex-end; gap: 10px; margin: 0 0 18px; font-size: 12px; }
    .language a { color: var(--muted); text-decoration: none; }
    .language a:hover, .language a[aria-current="page"] { color: var(--text); text-decoration: underline; }
    #error { display: none; margin-top: 14px; padding: 8px 10px; border-radius: 8px; background: rgba(239, 68, 68, 0.15); color: #f87171; font-size: 13px; }
  </style>
</head>
<body>
  <form id="login" method="post" action="${escapeHtml(loginAction)}" autocomplete="on">
    <nav class="language" aria-label="${text.language}">
      <a href="${zhHref}" lang="zh-CN"${language === 'zh' ? ' aria-current="page"' : ''}>${text.chinese}</a>
      <a href="${enHref}" lang="en"${language === 'en' ? ' aria-current="page"' : ''}>${text.english}</a>
    </nav>
    <h1>${text.heading}</h1>
    <p>${safeRealm}</p>
    <label for="username">${text.username}</label>
    <input id="username" name="username" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" autofocus required>
    <label for="password">${text.password}</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>${otpField}
    <button type="submit">${text.submit}</button>
    <div id="error" role="alert"${errorStyle} data-default-error="${escapeHtml(text.invalid)}" data-network-error="${escapeHtml(text.networkError)}">${escapeHtml(initialError)}</div>
  </form>
  <script>
    const form = document.getElementById("login");
    const error = document.getElementById("error");
    const defaultError = error.dataset.defaultError;
    const networkError = error.dataset.networkError;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.style.display = "none";
      const button = form.querySelector("button[type=submit]");
      button.disabled = true;
      try {
        const response = await fetch(${JSON.stringify(loginAction)}, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: document.getElementById("username").value,
            password: document.getElementById("password").value,
            totp: document.getElementById("otp")?.value ?? ""
          })
        });
        const data = await response.json();
        if (data.ok) {
          window.location.reload();
        } else {
          error.textContent = data.error || defaultError;
          error.style.display = "block";
          button.disabled = false;
        }
      } catch {
        error.textContent = networkError;
        error.style.display = "block";
        button.disabled = false;
      }
    });
  </script>
</body>
</html>`
}
