/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s step).
 *
 * Ported from `@yiln-dsh/dsh-plugin-auth-webserver@0.7.6` `lib/totp.js`; the
 * algorithm is unchanged. `node:crypto` only, no third-party dependency.
 *
 * The ±1 step window in `verifyTotp` is what makes a phone clock a few seconds
 * off still usable. Replay protection is the caller's job (the gateway keeps a
 * used-code cache for 90 s).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const OTP_DIGITS = 6
const OTP_PERIOD_SECONDS = 30
/** Minimum decoded key length (RFC 4226 requires >= 128 bits). */
const MIN_KEY_BYTES = 16

/** Encode bytes (or a string/Buffer) as unpadded RFC 4648 base32. */
export function base32Encode(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  let output = ''
  let bits = 0
  let buffer = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]
      bits -= 5
      buffer &= (1 << bits) - 1
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31]
  return output
}

/** Decode base32 (spaces, dashes and padding tolerated); `null` when invalid. */
export function base32Decode(value) {
  if (typeof value !== 'string') return null
  const normalized = value.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (normalized === '' || !/^[A-Z2-7]+$/.test(normalized)) return null

  const bytes = []
  let bits = 0
  let buffer = 0
  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character)
    bits += 5
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255)
      bits -= 8
      buffer &= (1 << bits) - 1
    }
  }
  return Buffer.from(bytes)
}

/** A fresh 160-bit enrollment secret in base32 (32 characters). */
export function generateTotpSecret() {
  return base32Encode(randomBytes(20))
}

/** The 6-digit code for `timestamp` (ms), or `null` for an unusable secret. */
export function totpCode(secret, timestamp = Date.now()) {
  const key = base32Decode(secret)
  if (key === null || key.length < MIN_KEY_BYTES) return null
  const counter = Math.floor(timestamp / 1000 / OTP_PERIOD_SECONDS)
  const message = Buffer.alloc(8)
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0)
  message.writeUInt32BE(counter % 0x100000000, 4)
  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  return String(binary % 10 ** OTP_DIGITS).padStart(OTP_DIGITS, '0')
}

/**
 * Verify a submitted code against the previous, current and next 30 s step.
 * Comparison is constant time and never throws on malformed input.
 */
export function verifyTotp(secret, submitted, timestamp = Date.now()) {
  const code = typeof submitted === 'string' ? submitted.replace(/[\s-]/g, '') : ''
  if (!/^\d{6}$/.test(code)) return false
  const stepMs = OTP_PERIOD_SECONDS * 1000
  const counterTimestamp = Math.floor(timestamp / stepMs) * stepMs
  const submittedBuffer = Buffer.from(code, 'utf8')
  for (const offset of [-1, 0, 1]) {
    const expected = totpCode(secret, counterTimestamp + offset * stepMs)
    if (expected === null) continue
    const expectedBuffer = Buffer.from(expected, 'utf8')
    if (expectedBuffer.length === submittedBuffer.length
      && timingSafeEqual(expectedBuffer, submittedBuffer)) return true
  }
  return false
}

export const TOTP_PERIOD_SECONDS_VALUE = OTP_PERIOD_SECONDS
export const TOTP_DIGITS = OTP_DIGITS
