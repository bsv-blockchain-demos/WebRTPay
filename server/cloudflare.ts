import type { RelayIceServer } from '../src/signaling/RelaySignaler.js'
import type { CloudflareTurnProvider, TurnIssuer } from './turn.js'

/** Longest lifetime Cloudflare gives TURN credentials: 48 hours, in seconds. */
export const CLOUDFLARE_MAX_TTL_SECONDS = 172800
/** Time Cloudflare has to answer a credentials request, body included. */
export const CLOUDFLARE_TIMEOUT_MS = 5000

const API_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys/'
/** A TURN key id, which becomes a path segment of the API url. */
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,256}$/
/** A bearer token: visible ASCII, without spaces. */
const API_TOKEN_RE = /^[\x21-\x7e]+$/
const STUN_URL_RE = /^stuns?:/i
const TURN_URL_RE = /^turns?:/i
/**
 * A url on port 53, Cloudflare's former alternate port. Browsers block it, so a gather that
 * does not trickle would wait for it to time out.
 */
const PORT_53_RE = /:53(?:[?/]|$)/

/** A failure whose message is fixed text: no secret, credential or url. */
class CloudflareTurnError extends Error {
  constructor(reason: string) {
    super(`Cloudflare TURN: ${reason}`)
    this.name = 'CloudflareTurnError'
  }
}

/**
 * An issuer that asks Cloudflare Realtime TURN for each set of credentials:
 * `POST https://rtc.live.cloudflare.com/v1/turn/keys/<keyId>/credentials/generate-ice-servers`
 * with `Authorization: Bearer <apiToken>` and `{ "ttl": <ttl> }`, the ttl capped at 48
 * hours. It never sends the identity key. A request has 5 s, its body included; an answer
 * other than 200 or 201, a timeout or a body without TURN credentials rejects. Cloudflare's
 * answer says nothing of the lifetime, so `expiresAt` is the time the request started plus
 * the ttl, which can only be early.
 */
export function cloudflareTurnIssuer(p: CloudflareTurnProvider, ttlSeconds: number): TurnIssuer {
  if (typeof p.keyId !== 'string' || !KEY_ID_RE.test(p.keyId)) {
    throw new TypeError('turn.keyId must be a Cloudflare TURN key id (letters, digits, - and _)')
  }
  if (typeof p.apiToken !== 'string' || !API_TOKEN_RE.test(p.apiToken)) {
    throw new TypeError('turn.apiToken must be a Cloudflare API token, without spaces')
  }
  const fetchFn = p.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') throw new TypeError('turn.fetch must be a fetch function')
  const ttl = Math.min(ttlSeconds, CLOUDFLARE_MAX_TTL_SECONDS)
  const url = `${API_URL}${p.keyId}/credentials/generate-ice-servers`
  const headers = { authorization: `Bearer ${p.apiToken}`, 'content-type': 'application/json' }
  const body = JSON.stringify({ ttl })
  return {
    kind: 'cloudflare',
    ttlSeconds: ttl,
    async issue() {
      const now = Date.now()
      try {
        const iceServers = await withDeadline(async signal => {
          const res = await fetchFn(url, { method: 'POST', headers, body, signal })
          if (res.status !== 200 && res.status !== 201) {
            res.body?.cancel().catch(() => {})
            throw new CloudflareTurnError(`HTTP ${Number(res.status)}`)
          }
          const text = await res.text()
          let answer: unknown
          try {
            answer = JSON.parse(text)
          } catch {
            throw new CloudflareTurnError('the answer is not JSON')
          }
          return cloudflareIceServers(answer)
        })
        return { iceServers, expiresAt: now + ttl * 1000 }
      } catch (e) {
        // Only this module's own messages leave it: what fetch or the body throws may hold
        // the url or more.
        throw e instanceof CloudflareTurnError ? e : new CloudflareTurnError('request failed')
      }
    }
  }
}

/**
 * The ICE servers in Cloudflare's answer, as the relay hands them out: one entry with
 * every STUN url, then each TURN entry with its urls and credentials. `iceServers` may be a
 * list (today's answer: a STUN entry and a TURN entry; until 2025 a single entry mixing
 * both) or one object (the older `/credentials/generate`). Entries are told apart by url
 * scheme, never by position; urls on port 53 and of other schemes are dropped, and so is a
 * TURN entry without a username and credential. Throws when no TURN url is left.
 */
export function cloudflareIceServers(answer: unknown): RelayIceServer[] {
  const listed = isRecord(answer) ? answer.iceServers : undefined
  const entries: unknown[] = Array.isArray(listed) ? listed : isRecord(listed) ? [listed] : []
  if (entries.length === 0) throw new CloudflareTurnError('the answer lists no ICE servers')
  const stun: string[] = []
  const turn: RelayIceServer[] = []
  for (const entry of entries) {
    if (!isRecord(entry)) continue
    const listedUrls: unknown[] = Array.isArray(entry.urls) ? entry.urls : [entry.urls]
    const urls = listedUrls.filter((u): u is string => typeof u === 'string' && !PORT_53_RE.test(u))
    for (const u of urls) if (STUN_URL_RE.test(u) && !stun.includes(u)) stun.push(u)
    const turnUrls = urls.filter(u => TURN_URL_RE.test(u))
    const { username, credential } = entry
    if (turnUrls.length > 0 && nonEmpty(username) && nonEmpty(credential)) {
      turn.push({ urls: turnUrls, username, credential })
    }
  }
  if (turn.length === 0) throw new CloudflareTurnError('the answer has no TURN server')
  return stun.length > 0 ? [{ urls: stun }, ...turn] : turn
}

/**
 * Run `work`, aborting its signal and rejecting once `CLOUDFLARE_TIMEOUT_MS` have passed,
 * even when `work` does not stop on the abort.
 */
async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new CloudflareTurnError(`no answer within ${CLOUDFLARE_TIMEOUT_MS / 1000} s`))
    }, CLOUDFLARE_TIMEOUT_MS)
    // a request still waiting does not keep a process that is shutting down alive
    ;(timer as { unref?: () => void }).unref?.()
  })
  try {
    // race() handles a rejection from whichever of the two loses
    return await Promise.race([work(controller.signal), expired])
  } finally {
    clearTimeout(timer)
  }
}

function nonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x !== ''
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
