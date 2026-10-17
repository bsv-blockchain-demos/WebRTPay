import type { PeerLink } from '../channel/PeerLink.js'
import { parseWireMessage } from '../payments/wire.js'
import type { Auth, Hello, WireMessage } from '../payments/wire.js'
import { CHANNEL_PROTOCOL_ID, DEFAULTS } from '../types.js'
import type { PubKeyHex, WalletLike } from '../types.js'
import { fromHex, randomBytes, toBase64, toHex, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import { AuthenticatedPeer } from './AuthenticatedPeer.js'

/** First line of every channel-binding transcript. */
const BINDING_LABEL = 'webrtpay/1 channel-binding'
const NONCE_BYTES = 32

/** What one side signs, or checks the other side signed, for a channel. */
export interface BindingTranscriptInput {
  /** DTLS fingerprints (`"<alg> <lowercase hex>"`) from the signer's own SDP. */
  signerFingerprints: string[]
  /** DTLS fingerprints from the verifier's own SDP. */
  verifierFingerprints: string[]
  signerNonce: string
  verifierNonce: string
  signerKey: PubKeyHex
  verifierKey: PubKeyHex
}

/**
 * The bytes an identity signs to bind itself to one data channel: UTF-8 of seven lines
 * joined by `\n` — `webrtpay/1 channel-binding`, the signer's fingerprints, the
 * verifier's fingerprints (each list sorted and joined by `,`), the signer's nonce, the
 * verifier's nonce, the signer's key and the verifier's key. Both sides compute the same
 * bytes for a given signer only when they see the same DTLS certificates, so a relay that
 * terminates DTLS on each side cannot pass one side's signature to the other.
 */
export function bindingTranscript(a: BindingTranscriptInput): number[] {
  const text = [
    BINDING_LABEL,
    [...a.signerFingerprints].sort().join(','),
    [...a.verifierFingerprints].sort().join(','),
    a.signerNonce,
    a.verifierNonce,
    a.signerKey,
    a.verifierKey
  ].join('\n')
  return Array.from(utf8Encode(text))
}

/** Options for {@link authenticate}. */
export interface AuthenticateOptions {
  wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature' | 'verifySignature'>
  /** Passed to every wallet call. */
  originator?: string
  /** Fail unless the peer proves this identity key (lowercase hex). */
  expectedPeer?: PubKeyHex
  /**
   * Time for the whole handshake, waiting for the channel to open included; defaults to
   * 15 s.
   */
  timeoutMs?: number
  /**
   * Largest message accepted from the peer once it has authenticated; defaults to 32 MiB.
   * Until then the link keeps the cap it was created with.
   */
  maxMessageBytes?: number
}

/**
 * Prove this wallet's identity key to the peer on `link` and check the peer's, bound to
 * the DTLS certificates of this connection (spec §4).
 *
 * Each side sends `hello` (identity key, fresh 32-byte nonce), then on the peer's hello an
 * `auth` signing {@link bindingTranscript} with `protocolID [2, 'webrtpay channel']`,
 * `keyID` its own nonce and `counterparty` the peer's key. Once the peer's `auth`
 * verifies, the link's cap rises to `maxMessageBytes` and this side sends `ready`. The
 * session is handed over when this side's check passed and the peer's `ready` arrived.
 *
 * Call it as soon as the link exists (before `waitOpen`), so the peer's hello cannot
 * arrive while nobody is listening.
 *
 * @throws `WebRTPayError('auth_failed')` — link closed — when the peer's signature does
 * not verify, its key is not `expectedPeer`, its hello is malformed (a non-canonical key,
 * say) or repeats this side's nonce, it sends anything out of turn, or the wallet fails;
 * `WebRTPayError('timeout')` — link closed — after `timeoutMs`; the link's close reason
 * (or `closed`) when it closes first; `RangeError` for an invalid `maxMessageBytes`.
 */
export function authenticate(link: PeerLink, o: AuthenticateOptions): Promise<AuthenticatedPeer> {
  const cap = o.maxMessageBytes ?? DEFAULTS.maxMessageBytes
  if (!Number.isSafeInteger(cap) || cap < 0) {
    return Promise.reject(new RangeError(`Invalid message size cap: ${cap}`))
  }
  return new Promise((resolve, reject) => new Handshake(link, o, cap, resolve, reject))
}

function authFailed(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('auth_failed', message, cause === undefined ? undefined : { cause })
}

/** One run of the handshake on one link; settles exactly once. */
class Handshake {
  /** The peer message expected next; they always come hello, auth, ready. */
  private expecting: 'hello' | 'auth' | 'ready' = 'hello'
  /** Peer messages not yet handled, oldest first. */
  private readonly inbox: unknown[] = []
  /** True while a step (or the setup) awaits the wallet or the link. */
  private busy = true
  private settled = false
  private localKey = ''
  private readonly localNonce = toBase64(randomBytes(NONCE_BYTES))
  private peer: Hello | undefined
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly offMessage: () => void
  private readonly offClose: () => void

  constructor(
    private readonly link: PeerLink,
    private readonly o: AuthenticateOptions,
    private readonly cap: number,
    private readonly resolve: (peer: AuthenticatedPeer) => void,
    private readonly reject: (error: unknown) => void
  ) {
    // Listen before anything else: the link drops messages nobody is listening for.
    this.offMessage = link.onMessage(m => {
      this.inbox.push(m)
      this.pump()
    })
    this.offClose = link.onClose(reason => {
      this.fail(reason ?? new WebRTPayError('closed', 'Link closed during the handshake'))
    })
    const timeoutMs = o.timeoutMs ?? DEFAULTS.handshakeTimeoutMs
    this.timer = setTimeout(() => {
      this.fail(new WebRTPayError('timeout', `Handshake not finished within ${timeoutMs} ms`))
    }, timeoutMs)
    this.run(this.start(timeoutMs))
  }

  /** Learn our key, wait for the channel, say hello. */
  private async start(timeoutMs: number): Promise<void> {
    const { publicKey } = await this.o.wallet.getPublicKey({ identityKey: true }, this.o.originator)
    this.localKey = publicKey
    await this.link.waitOpen(timeoutMs)
    if (this.settled) return
    const hello: Hello = { t: 'hello', v: 1, identityKey: publicKey, nonce: this.localNonce }
    await this.link.send(hello)
  }

  /** Handle queued messages one at a time; a step that awaits holds the rest back. */
  private pump(): void {
    while (!this.busy && !this.settled && this.inbox.length > 0) {
      let step: Promise<void> | undefined
      try {
        step = this.step(this.inbox.shift())
      } catch (error) {
        this.fail(error)
        return
      }
      if (step) {
        this.busy = true
        this.run(step)
      }
    }
  }

  private run(step: Promise<void>): void {
    step.then(
      () => {
        this.busy = false
        this.pump()
      },
      error => this.fail(error)
    )
  }

  private step(raw: unknown): Promise<void> | undefined {
    let m: WireMessage
    try {
      m = parseWireMessage(raw)
    } catch (cause) {
      throw authFailed('Peer sent a malformed handshake message', cause)
    }
    if (m.t !== this.expecting) {
      throw authFailed(`Peer sent '${m.t}' while the handshake expected '${this.expecting}'`)
    }
    if (m.t === 'hello') return this.onHello(m)
    if (m.t === 'auth') return this.onAuth(m)
    this.finish()
    return undefined
  }

  private async onHello(hello: Hello): Promise<void> {
    if (this.o.expectedPeer !== undefined && hello.identityKey !== this.o.expectedPeer) {
      throw authFailed('Peer is not the identity this session expects')
    }
    if (hello.nonce === this.localNonce) throw authFailed('Peer repeated our nonce')
    this.peer = hello
    this.expecting = 'auth'
    const signerFingerprints = this.link.localFingerprints()
    const verifierFingerprints = this.link.remoteFingerprints()
    if (signerFingerprints.length === 0 || verifierFingerprints.length === 0) {
      throw authFailed('No DTLS fingerprint to bind the session to')
    }
    const data = bindingTranscript({
      signerFingerprints,
      verifierFingerprints,
      signerNonce: this.localNonce,
      verifierNonce: hello.nonce,
      signerKey: this.localKey,
      verifierKey: hello.identityKey
    })
    let signature: number[]
    try {
      const signed = await this.o.wallet.createSignature(
        {
          data,
          protocolID: CHANNEL_PROTOCOL_ID,
          keyID: this.localNonce,
          counterparty: hello.identityKey
        },
        this.o.originator
      )
      signature = signed.signature
    } catch (cause) {
      throw authFailed('Wallet could not sign the channel binding', cause)
    }
    if (this.settled) return
    const auth: Auth = { t: 'auth', signature: toHex(Uint8Array.from(signature)) }
    await this.link.send(auth)
  }

  private async onAuth(auth: Auth): Promise<void> {
    const peer = this.peer!
    const data = bindingTranscript({
      signerFingerprints: this.link.remoteFingerprints(),
      verifierFingerprints: this.link.localFingerprints(),
      signerNonce: peer.nonce,
      verifierNonce: this.localNonce,
      signerKey: peer.identityKey,
      verifierKey: this.localKey
    })
    let valid: boolean
    try {
      // Wallets throw (ERR_INVALID_SIGNATURE) rather than return { valid: false }.
      const checked = await this.o.wallet.verifySignature(
        {
          data,
          signature: Array.from(fromHex(auth.signature)),
          protocolID: CHANNEL_PROTOCOL_ID,
          keyID: peer.nonce,
          counterparty: peer.identityKey
        },
        this.o.originator
      )
      valid = checked.valid
    } catch (cause) {
      throw authFailed('Peer signature does not verify', cause)
    }
    if (valid !== true) throw authFailed('Peer signature does not verify')
    if (this.settled) return
    this.link.setMaxMessageBytes(this.cap)
    this.expecting = 'ready'
    await this.link.send({ t: 'ready' })
  }

  private finish(): void {
    this.settled = true
    clearTimeout(this.timer)
    // The session subscribes before the handshake lets go, so no message falls between.
    const session = new AuthenticatedPeer(
      this.link,
      { localIdentityKey: this.localKey, peerIdentityKey: this.peer!.identityKey },
      this.inbox.splice(0)
    )
    this.offMessage()
    this.offClose()
    this.resolve(session)
  }

  private fail(error: unknown): void {
    if (this.settled) return
    this.settled = true
    clearTimeout(this.timer)
    this.offMessage()
    this.offClose()
    const reason = error instanceof WebRTPayError ? error : authFailed('Handshake failed', error)
    this.link.close(reason)
    this.reject(reason)
  }
}
