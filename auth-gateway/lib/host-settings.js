/**
 * Rewrite the HTML the core serves so a remote-but-authenticated browser is
 * treated like the desktop shell's own carrier.
 *
 * ## Why this exists
 *
 * `dsh-client-connection` decides whether the page "owns" its Host here:
 *
 *   isLoopback: transport?.ownsHost === true
 *            || pageLocation === void 0
 *            || isLoopbackHostname(pageLocation.hostname)
 *
 * The desktop shell injects `__DSH_TRANSPORT__ = { ownsHost: true }`, so its
 * page always looks local. A plain npm deployment reached over the LAN does not,
 * the hostname is not loopback, and `dsh-client-ui-settings` then hard-codes:
 *
 *   const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
 *
 * `persistence: "memory"` starts every form as `unavailable` and never sends a
 * request, so the Models page reports
 * "settings are unavailable in this browser".
 *
 * That is an intentional upstream safety default for *unauthenticated* remote
 * pages. Behind this gateway the page has already passed account authentication,
 * so it is entitled to the same host-settings access the local browser has —
 * which is exactly what the legacy gateway's `allowRemoteSettings` provided.
 *
 * ## Why not patch the shipped bundle
 *
 * The legacy plugin rewrote a string inside `dsh-client-ui-settings/lib/client.js`.
 * That breaks on any upstream change to that line. This module instead sets a
 * value the client already reads, so it survives upgrades as long as
 * `ownsHost` remains the documented carrier flag.
 */

/** Global the dsh client reads its carrier facts from. */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/**
 * Script injected into an authenticated page.
 *
 * It must run BEFORE the client entry reads `__DSH_TRANSPORT__`, and it must not
 * clobber any transport the deployment already provides (the desktop shell sets
 * its own). Only `ownsHost` is forced, and only when the page has none.
 */
export const HOST_SETTINGS_SCRIPT = `(function () {
  var g = globalThis;
  var existing = g.${TRANSPORT_GLOBAL};
  if (existing !== null && typeof existing === 'object') {
    // Preserve streamBaseUrl and any custom carrier; only claim host ownership.
    if (existing.ownsHost !== true) existing.ownsHost = true;
    return;
  }
  g.${TRANSPORT_GLOBAL} = { ownsHost: true };
})();`

/**
 * Whether a response body should be rewritten.
 *
 * Only the HTML document is touched: assets, JSON APIs and plugin bundles must
 * pass through byte-for-byte.
 */
export function isHtmlDocument(headers) {
  const raw = headers['content-type']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return false
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'text/html'
}

/** Whether the upstream response is going to be compressed (skip rewriting). */
export function isEncoded(headers) {
  const raw = headers['content-encoding']
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' && value.trim() !== '' && value.trim().toLowerCase() !== 'identity'
}

/**
 * Whether this request is a document navigation whose body we intend to splice.
 *
 * Only such a request is asked for an uncompressed body. A browser always sends
 * `Accept-Encoding`, and the core answers with gzip, so without this the rewrite
 * was skipped for every real browser while a plain `curl` looked fine.
 *
 * @param req - the inbound request.
 * @returns true for a GET navigation that negotiates HTML.
 */
export function wantsDocument(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const accept = req.headers.accept
  const value = Array.isArray(accept) ? accept[0] : accept
  return typeof value === 'string' && value.toLowerCase().includes('text/html')
}

/**
 * Insert the carrier script at the very start of `<head>`.
 *
 * Placing it first guarantees it runs before the module loader and before the
 * application entry, no matter what the core injects later.
 *
 * @param html - decoded document body.
 * @returns the rewritten document, unchanged when there is no `<head>`.
 */
export function injectOwnsHost(html) {
  const marker = /<head[^>]*>/iu.exec(html)
  if (marker === null) return html
  const at = marker.index + marker[0].length
  const script = `<script>${HOST_SETTINGS_SCRIPT}</script>`
  return `${html.slice(0, at)}${script}${html.slice(at)}`
}

/**
 * Decide whether to rewrite this response, and return the new body.
 *
 * Kept pure so the proxy can stay a thin passthrough and the decision is unit
 * testable without sockets.
 *
 * @param options.statusCode - upstream status.
 * @param options.headers - upstream response headers.
 * @param options.body - decoded body (only read when the decision is `rewrite`).
 * @param options.enabled - operator switch for remote host-settings access.
 * @returns `{ rewrite: false }` or `{ rewrite: true, body }`.
 */
export function planHtmlRewrite({ statusCode, headers, body, enabled }) {
  if (enabled !== true) return { rewrite: false }
  if (statusCode !== 200) return { rewrite: false }
  if (!isHtmlDocument(headers)) return { rewrite: false }
  // A compressed body cannot be spliced without inflating it first; let the
  // proxy skip rewriting rather than corrupt the response.
  if (isEncoded(headers)) return { rewrite: false }
  if (typeof body !== 'string' || body === '') return { rewrite: false }
  const next = injectOwnsHost(body)
  return next === body ? { rewrite: false } : { rewrite: true, body: next }
}
