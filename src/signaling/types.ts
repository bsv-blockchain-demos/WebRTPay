import type { PubKeyHex } from '../types.js'

/**
 * What a carrier transports: an end-to-end encrypted {@link SignalPlaintext}. The
 * `sid` travels in the clear because it is also the encryption key ID.
 */
export interface SignalEnvelope {
  v: 1
  sid: string
  /** Standard base64 of the BRC-2 ciphertext of the JSON plaintext. */
  ciphertext: string
}

/** The kind of signal: an SDP offer, the SDP answer to it, or a refusal to answer. */
export type SignalKind = 'offer' | 'answer' | 'reject'

/** The decrypted content of a {@link SignalEnvelope}. */
export interface SignalPlaintext {
  v: 1
  kind: SignalKind
  /** Session ID shared by an offer and its answer or reject; 16 random bytes, base64url. */
  sid: string
  from: PubKeyHex
  to: PubKeyHex
  /** Sender clock, Unix milliseconds. */
  ts: number
  purpose: 'payment'
  /** Full SDP text (offer and answer only). */
  sdp?: string
  /** Why the peer refused (reject only). */
  reason?: string
}

/**
 * A carrier for signal envelopes between identities. It never sees plaintext; the
 * `from` it reports is the identity the carrier asserts, which `openSignal` checks
 * against the encrypted content.
 */
export interface Signaler {
  /** Send an already-encrypted envelope to a peer identity. */
  send(to: PubKeyHex, e: SignalEnvelope): Promise<void>
  /**
   * Receive envelopes addressed to us. Resolves once listening has started, with a
   * function that stops this subscription.
   */
  listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>>
  /** Hint that a dial is in progress, so answers should be picked up faster. */
  setActive?(active: boolean): void
}
