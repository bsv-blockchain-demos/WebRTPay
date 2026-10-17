import { createHmac } from 'node:crypto'

/** Ephemeral TURN credentials in coturn's REST API (`use-auth-secret`) format. */
export interface TurnCredentials {
  /** `"<unix expiry seconds>:<identityKey>"`. */
  username: string
  /** Standard base64 of HMAC-SHA1(secret, username). */
  credential: string
  /** When the credentials stop working, in Unix milliseconds. */
  expiresAt: number
}

/** Default lifetime of TURN credentials, in seconds. */
const TURN_TTL_SECONDS = 3600

/**
 * Mint TURN credentials for `identityKey` that coturn accepts when configured with
 * `use-auth-secret` and `static-auth-secret=<secret>`.
 *
 * @param o.ttlSeconds - Lifetime; a positive whole number, default 3600.
 * @param o.now - Current time in Unix milliseconds; defaults to `Date.now()`.
 */
export function turnCredentials(o: {
  secret: string
  identityKey: string
  ttlSeconds?: number
  now?: number
}): TurnCredentials {
  if (typeof o.secret !== 'string' || o.secret.length === 0) {
    throw new TypeError('TURN secret must be a non-empty string')
  }
  const ttl = o.ttlSeconds ?? TURN_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new RangeError('ttlSeconds must be a positive whole number of seconds')
  }
  const expiry = Math.floor((o.now ?? Date.now()) / 1000) + ttl
  const username = `${expiry}:${o.identityKey}`
  return {
    username,
    credential: createHmac('sha1', o.secret).update(username).digest('base64'),
    expiresAt: expiry * 1000
  }
}
