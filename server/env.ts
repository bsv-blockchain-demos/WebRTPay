import type { RelayServerOptions } from './relay.js'

/**
 * Relay options from environment variables: `PORT` (default 8787), `HOST`
 * (default 0.0.0.0), and comma-separated `PUBLIC_URLS`, `STUN_URLS` and
 * `TURN_URLS`; `TURN_SECRET` and `TURN_URLS` go together, `TURN_TTL` is in
 * seconds. Empty variables count as unset. Throws `Error` naming the variable
 * on an invalid value.
 */
export function relayOptionsFromEnv(env: Record<string, string | undefined>): RelayServerOptions {
  const o: RelayServerOptions = {
    port: env.PORT ? wholeNumber('PORT', env.PORT, 0, 65535) : 8787,
    host: env.HOST?.trim() || '0.0.0.0'
  }
  const publicUrls = list(env.PUBLIC_URLS)
  if (publicUrls.length > 0) o.publicUrls = publicUrls
  const stunUrls = list(env.STUN_URLS)
  if (stunUrls.length > 0) o.stunUrls = stunUrls

  const secret = env.TURN_SECRET ?? ''
  const turnUrls = list(env.TURN_URLS)
  if (secret !== '' || turnUrls.length > 0 || env.TURN_TTL) {
    if (secret === '') throw new Error('TURN_SECRET is required when TURN_URLS or TURN_TTL is set')
    if (turnUrls.length === 0) throw new Error('TURN_URLS is required when TURN_SECRET is set')
    o.turn = { secret, urls: turnUrls }
    if (env.TURN_TTL) o.turn.ttlSeconds = wholeNumber('TURN_TTL', env.TURN_TTL, 1, 2 ** 31 - 1)
  }
  return o
}

function list(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')
}

function wholeNumber(name: string, v: string, min: number, max: number): number {
  const n = /^\d+$/.test(v.trim()) ? Number(v.trim()) : Number.NaN
  if (!(n >= min && n <= max)) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}`)
  }
  return n
}
