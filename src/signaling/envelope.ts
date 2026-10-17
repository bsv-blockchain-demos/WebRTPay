import { DEFAULTS, SIGNALING_PROTOCOL_ID, isIdentityKey } from '../types.js'
import type { PubKeyHex, WalletLike } from '../types.js'
import { fromBase64, toBase64, utf8Decode, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import type { SignalEnvelope, SignalKind, SignalPlaintext } from './types.js'

/** Longest `sdp` accepted in a signal, in characters. */
export const MAX_SIGNAL_SDP_CHARS = 16384
/** Longest `sid` accepted in an envelope, in characters (a 16-byte base64url sid is 22). */
export const MAX_SIGNAL_SID_CHARS = 64

const KINDS: readonly SignalKind[] = ['offer', 'answer', 'reject']

/**
 * Remembers session IDs so each signal is opened once. Entries expire after
 * `ttlMs` (comfortably longer than the ±120 s freshness window) and the oldest is
 * dropped beyond `max`.
 */
export class ReplayCache {
  /** sid → time it was first seen; insertion order is oldest first. */
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly ttlMs = 600000,
    private readonly max = 10000
  ) {}

  /** Record `sid`; true when it has not been seen within the ttl. */
  check(sid: string, now = Date.now()): boolean {
    for (const [key, at] of this.seen) {
      if (now - at < this.ttlMs) break
      this.seen.delete(key)
    }
    const at = this.seen.get(sid)
    if (at !== undefined && now - at < this.ttlMs) return false
    this.seen.delete(sid)
    this.seen.set(sid, now)
    while (this.seen.size > this.max) {
      this.seen.delete(this.seen.keys().next().value as string)
    }
    return true
  }
}

/** True for a well-formed envelope: `v` 1, a non-empty bounded `sid`, a string `ciphertext`. */
export function isSignalEnvelope(x: unknown): x is SignalEnvelope {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return (
    e.v === 1 &&
    typeof e.sid === 'string' &&
    e.sid.length > 0 &&
    e.sid.length <= MAX_SIGNAL_SID_CHARS &&
    typeof e.ciphertext === 'string'
  )
}

/**
 * Encrypt a signal for `p.to` (BRC-2, protocol `[2, 'webrtpay signaling']`, key ID
 * `p.sid`). Only the {@link SignalPlaintext} fields are carried.
 */
export async function sealSignal(
  wallet: Pick<WalletLike, 'encrypt'>,
  p: SignalPlaintext,
  originator?: string
): Promise<SignalEnvelope> {
  const plaintext: SignalPlaintext = {
    v: 1,
    kind: p.kind,
    sid: p.sid,
    from: p.from,
    to: p.to,
    ts: p.ts,
    purpose: p.purpose,
    sdp: p.sdp,
    reason: p.reason
  }
  const { ciphertext } = await wallet.encrypt(
    {
      plaintext: Array.from(utf8Encode(JSON.stringify(plaintext))),
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: p.sid,
      counterparty: p.to
    },
    originator
  )
  return { v: 1, sid: p.sid, ciphertext: toBase64(Uint8Array.from(ciphertext)) }
}

/**
 * Decrypt and check a signal received from `from` (the identity the carrier
 * asserts). The plaintext must name the same sender, be addressed to `me`, carry
 * the envelope's sid, be within ±120 s of `now`, have an sdp of at most 16384
 * characters and a sid not seen before. The sid is recorded only when every
 * other check passes. Any failure rejects with `WebRTPayError('invalid_signal')`.
 */
export async function openSignal(
  wallet: Pick<WalletLike, 'decrypt'>,
  from: PubKeyHex,
  e: SignalEnvelope,
  o: { me: PubKeyHex; now?: number; replay: ReplayCache; originator?: string }
): Promise<SignalPlaintext> {
  if (!isSignalEnvelope(e)) throw invalid('Malformed signal envelope')
  if (!isIdentityKey(from)) throw invalid('Signal sender is not an identity key')

  let decoded: unknown
  try {
    const { plaintext } = await wallet.decrypt(
      {
        ciphertext: Array.from(fromBase64(e.ciphertext)),
        protocolID: SIGNALING_PROTOCOL_ID,
        keyID: e.sid,
        counterparty: from
      },
      o.originator
    )
    decoded = JSON.parse(utf8Decode(Uint8Array.from(plaintext)))
  } catch (cause) {
    throw invalid('Signal cannot be decrypted', cause)
  }

  const p = toPlaintext(decoded)
  if (p === undefined) throw invalid('Malformed signal')
  if (p.from !== from) throw invalid('Signal sender does not match the carrier')
  if (p.to !== o.me) throw invalid('Signal is not addressed to us')
  if (p.sid !== e.sid) throw invalid('Signal sid does not match its envelope')
  const now = o.now ?? Date.now()
  if (Math.abs(now - p.ts) > DEFAULTS.signalMaxSkewMs) throw invalid('Signal is stale')
  if (p.sdp !== undefined && p.sdp.length > MAX_SIGNAL_SDP_CHARS) {
    throw invalid('Signal sdp is too long')
  }
  if (!o.replay.check(p.sid, now)) throw invalid('Signal was replayed')
  return p
}

/** The known fields of a decrypted signal, or undefined when it is not one. */
function toPlaintext(x: unknown): SignalPlaintext | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (
    r.v !== 1 ||
    !KINDS.includes(r.kind as SignalKind) ||
    typeof r.sid !== 'string' ||
    typeof r.from !== 'string' ||
    typeof r.to !== 'string' ||
    typeof r.ts !== 'number' ||
    !Number.isFinite(r.ts) ||
    r.purpose !== 'payment' ||
    (r.sdp !== undefined && typeof r.sdp !== 'string') ||
    (r.reason !== undefined && typeof r.reason !== 'string')
  ) {
    return undefined
  }
  const p: SignalPlaintext = {
    v: 1,
    kind: r.kind as SignalKind,
    sid: r.sid,
    from: r.from,
    to: r.to,
    ts: r.ts,
    purpose: 'payment'
  }
  if (r.sdp !== undefined) p.sdp = r.sdp as string
  if (r.reason !== undefined) p.reason = r.reason as string
  return p
}

function invalid(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('invalid_signal', message, cause === undefined ? undefined : { cause })
}
