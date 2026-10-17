import { PeerLink } from '../channel/PeerLink.js'
import type { PeerLinkOptions, RtcOptions } from '../channel/PeerLink.js'
import { decodeCode, encodeAnswerCode, encodeOfferCode } from '../codec/codes.js'
import type { OfferCode } from '../codec/codes.js'
import { normalizePaymentRequest, verifyPaymentRequestProof } from '../payments/requests.js'
import { decodePayment, encodePayment } from '../payments/wire.js'
import type { PaymentAck, PaymentWire, RequestWire, WireMessage } from '../payments/wire.js'
import type { AuthenticatedPeer } from '../session/AuthenticatedPeer.js'
import { authenticate } from '../session/handshake.js'
import { ReplayCache, openSignal, sealSignal } from '../signaling/envelope.js'
import type { SignalEnvelope, SignalKind, SignalPlaintext, Signaler } from '../signaling/types.js'
import { DEFAULTS, isIdentityKey } from '../types.js'
import type {
  IncomingPayment,
  IncomingPaymentRequest,
  PaymentRequestMessage,
  PaymentToken,
  PubKeyHex,
  WalletLike
} from '../types.js'
import { equalBytes, randomBytes, toBase64Url } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import { DEFAULT_INBOUND_LIMITS, InboundLimiter } from './limits.js'
import type { InboundLimits } from './limits.js'

/** What the app decides about one received payment; it becomes the `payment.ack` status. */
export type PaymentDecision = 'accepted' | 'received' | { status: 'rejected'; reason: string }

/** How a receiving client hands sessions, payments and requests to the app. */
export interface ReceiveHandlers {
  /**
   * Take custody of a payment from an authenticated peer (usually with
   * `acceptDirectPayment`). `p.sender` is the peer's proven identity key and `p.messageId`
   * the payment id. Resolve `accepted` once it is in the wallet, `received` when it is kept
   * for a local retry, or `rejected` with a reason for the payer. A handler that throws
   * makes the ack `rejected`: with the message of a `WebRTPayError` (such as
   * `invalid_payment`), with a generic reason otherwise.
   */
  onPayment(p: IncomingPayment, ctx: { note?: string; txid: string }): Promise<PaymentDecision>
  /**
   * A payment request from the peer, already bound to its identity, with whether its proof
   * verifies for this wallet. `messageId` is generated locally. Cancellations are not passed
   * on, nor is anything when this handler is absent.
   */
  onPaymentRequest?(r: IncomingPaymentRequest & { proofValid: boolean }): Promise<void>
  /** Failures of inbound sessions and handlers; never thrown back into the client. */
  onError?(e: unknown): void
  /** A peer finished the identity handshake and its session is being served. */
  onSession?(peerIdentityKey: PubKeyHex): void
}

export interface DirectPayClientOptions {
  wallet: WalletLike
  /** Passed to every wallet call. */
  originator?: string
  /** Carries offers and answers for {@link DirectPayClient.connect} and receiving. */
  signaler?: Signaler
  /** How links build their `RTCPeerConnection` (STUN/TURN servers, implementation). */
  rtc?: RtcOptions
  /**
   * The network this wallet is on, such as `'main'` or `'test'`. Offer codes carry it, and
   * answered offer codes must name it unless `expectedChain` says otherwise.
   */
  chain?: string
  /** Inbound limits; unset fields keep {@link DEFAULT_INBOUND_LIMITS}. */
  limits?: Partial<InboundLimits>
  /** `connectMs`: connect plus handshake (30 s); `ackMs`: wait for a payment's ack (45 s). */
  timeouts?: { connectMs?: number; ackMs?: number }
  /** Largest message accepted from a peer this client pays; defaults to 32 MiB. */
  maxMessageBytes?: number
}

/** Options for {@link DirectPayClient.createOfferCode}. */
export interface OfferCodeOptions {
  /** Network named in the code; defaults to the client's `chain`, one of them is required. */
  chain?: string
  /** Requested amount in satoshis. */
  amount?: number
  /** The code stops being valid this long from now; no expiry when absent. */
  expiresInMs?: number
  /** Serve the session with these instead of the active receive handlers. */
  handlers?: ReceiveHandlers
}

/** A payee's offer code waiting for the payer's answer code. */
export interface OfferHandle {
  /** The `webrtpay1:` offer code to show. */
  code: string
  /** The session id, base64url. */
  sid: string
  /**
   * Apply the payer's answer code, authenticate the payer (who must hold the key in the
   * answer code) and serve the session with the receive handlers. A code that is not an
   * answer to this offer rejects `invalid_code` and leaves the offer usable; without
   * handlers it rejects `unsupported`.
   */
  complete(answerCode: string): Promise<AuthenticatedPeer>
  /** Close the offer's link; a pending `complete` rejects `closed`. */
  cancel(): void
}

/** A payer's answer to an offer code. */
export interface AnswerHandle {
  /** The decoded offer: payee identity, network, amount. */
  offer: OfferCode
  /** The `webrtpay1:` answer code to show the payee. */
  answerCode: string
  /** Resolves once the payee applied the answer and proved the identity in the offer. */
  connected: Promise<AuthenticatedPeer>
  /** Close the link; `connected` rejects `closed`. */
  cancel(): void
}

/** Cap on a link until its peer has authenticated (Ruling 16); handshake messages are tiny. */
const PRE_AUTH_MAX_MESSAGE_BYTES = 65536
/** Longest reject reason from a peer passed on in an error message. */
const MAX_REJECT_REASON_CHARS = 200
/** Longest reason a `payment.ack` may carry. */
const MAX_ACK_REASON_CHARS = 500
/** Most messages from one inbound peer waiting to be handled before the session is closed. */
const MAX_PENDING_MESSAGES = 8
/** Ack reason when the handler failed in a way the payer should not see the details of. */
const NOT_PROCESSED = 'The payee could not process the payment'
const MAX_TIMER_MS = 2 ** 31 - 1
const SID_BYTES = 16

/** One dial waiting for its answer, keyed by sid. */
interface Dial {
  recipient: PubKeyHex
  /** The peer's answer or reject arrived. */
  reply(p: SignalPlaintext): void
  /** End the dial now (budget spent, client closed). */
  fail(e: WebRTPayError): void
}

/**
 * Direct wallet-to-wallet payments over WebRTC.
 *
 * Payer: {@link connect} dials a payee by identity key through the signaler (or
 * {@link answerOfferCode} answers a payee's offer code), then {@link sendPayment} delivers
 * a `PaymentToken` and returns the payee's ack. Connect before creating the transaction:
 * if the payee cannot be reached nothing has been spent.
 *
 * Payee: {@link startReceiving} answers offers that arrive through the signaler, within
 * the inbound limits, and serves each authenticated session with the handlers;
 * {@link createOfferCode} serves one session set up by exchanging codes, no signaler
 * needed.
 *
 * The signaler is subscribed only while receiving or while a dial waits for its answer,
 * so a client that does not receive is unreachable between payments. Every link starts
 * with a 64 KiB message cap that rises once the peer has authenticated.
 */
export class DirectPayClient {
  private readonly wallet: WalletLike
  private readonly originator: string | undefined
  private readonly signaler: Signaler | undefined
  private readonly chain: string | undefined
  private rtc: RtcOptions
  private readonly limits: InboundLimits
  private readonly limiter: InboundLimiter
  private readonly connectMs: number
  private readonly ackMs: number
  private readonly maxMessageBytes: number
  private readonly replay = new ReplayCache()
  private readonly dials = new Map<string, Dial>()
  private readonly links = new Set<PeerLink>()
  private identity: Promise<PubKeyHex> | undefined
  private handlers: ReceiveHandlers | undefined
  private dialCount = 0
  private unlisten: (() => Promise<void>) | undefined
  /** Tail of the subscribe/unsubscribe queue; never rejects. */
  private listenOps: Promise<void> = Promise.resolve()
  private closing: Promise<void> | undefined

  /** @throws `RangeError` for an invalid limit, timeout or message cap. */
  constructor(o: DirectPayClientOptions) {
    this.wallet = o.wallet
    this.originator = o.originator
    this.signaler = o.signaler
    this.chain = o.chain
    this.rtc = { ...o.rtc }
    this.limits = { ...DEFAULT_INBOUND_LIMITS, ...definedFields(o.limits) }
    this.limiter = new InboundLimiter(this.limits)
    this.connectMs = timerMs(o.timeouts?.connectMs, DEFAULTS.connectTimeoutMs, 'connectMs')
    this.ackMs = timerMs(o.timeouts?.ackMs, DEFAULTS.ackTimeoutMs, 'ackMs')
    this.maxMessageBytes = o.maxMessageBytes ?? DEFAULTS.maxMessageBytes
    if (!Number.isSafeInteger(this.maxMessageBytes) || this.maxMessageBytes < 1) {
      throw new RangeError('maxMessageBytes must be a positive integer')
    }
  }

  /** True between {@link startReceiving} and {@link stopReceiving} (or {@link close}). */
  get receiving(): boolean {
    return this.handlers !== undefined
  }

  /** This wallet's identity key (asked once, then remembered). */
  getIdentityKey(): Promise<PubKeyHex> {
    if (this.identity === undefined) {
      const asked = this.wallet
        .getPublicKey({ identityKey: true }, this.originator)
        .then(r => r.publicKey)
      this.identity = asked
      asked.catch(() => {
        if (this.identity === asked) this.identity = undefined
      })
    }
    return this.identity
  }

  /**
   * Answer offers from peers through the signaler, within the inbound limits, and serve
   * each session with `h`. Calling it again replaces the handlers for new sessions.
   *
   * @throws `WebRTPayError('unsupported')` without a signaler; `closed` after
   * {@link close}; whatever the signaler's `listen` throws (receiving is then off).
   */
  async startReceiving(h: ReceiveHandlers): Promise<void> {
    if (this.closing !== undefined) throw closedError()
    if (this.signaler === undefined) {
      throw new WebRTPayError('unsupported', 'Receiving by identity key needs a signaler')
    }
    if (typeof h?.onPayment !== 'function') throw new TypeError('onPayment must be a function')
    const previous = this.handlers
    this.handlers = h
    try {
      await this.syncListening()
    } catch (e) {
      if (this.handlers === h) this.handlers = previous
      throw e
    }
  }

  /**
   * Stop answering new offers; offers that still arrive while a dial is in progress are
   * refused with `not_receiving`. Sessions already open run until the peer says bye, closes
   * or goes idle.
   */
  async stopReceiving(): Promise<void> {
    this.handlers = undefined
    await this.syncListening()
  }

  /**
   * Dial `recipient` through the signaler and authenticate it: send an encrypted offer,
   * wait for the answer, open the channel and run the handshake pinned to `recipient`.
   *
   * @throws `WebRTPayError`: `unsupported` without a signaler; `peer_unreachable` when the
   * carrier cannot deliver or no answer arrives within `timeoutMs` (default `connectMs`,
   * 30 s); `rejected` when the recipient refused (the reason, at most 200 characters, is in
   * the message: `busy`, `not_receiving`); `timeout` when the answer came but the channel
   * and handshake did not finish in time; `auth_failed`, `closed` or `protocol` from the
   * channel and handshake; `closed` when the client closes first. `TypeError` for a
   * recipient that is not an identity key, `RangeError` for an invalid `timeoutMs`.
   */
  connect(recipient: PubKeyHex, o: { timeoutMs?: number } = {}): Promise<AuthenticatedPeer> {
    if (this.closing !== undefined) return Promise.reject(closedError())
    const signaler = this.signaler
    if (signaler === undefined) {
      return Promise.reject(
        new WebRTPayError('unsupported', 'Dialing by identity key needs a signaler')
      )
    }
    if (!isIdentityKey(recipient)) {
      return Promise.reject(new TypeError('recipient must be an identity key'))
    }
    let timeoutMs: number
    try {
      timeoutMs = timerMs(o.timeoutMs, this.connectMs, 'timeoutMs')
    } catch (e) {
      return Promise.reject(e)
    }

    const sid = newId()
    const deadline = Date.now() + timeoutMs
    let link: PeerLink | undefined
    let answered = false
    let failure: WebRTPayError | undefined
    let deliver!: (p: SignalPlaintext) => void
    let abandon!: (e: WebRTPayError) => void
    const reply = new Promise<SignalPlaintext>((resolve, reject) => {
      deliver = resolve
      abandon = reject
    })
    reply.catch(noop)

    const run = async (): Promise<AuthenticatedPeer> => {
      await this.syncListening()
      const me = await this.getIdentityKey()
      if (failure !== undefined) throw failure
      const offered = await PeerLink.createOffer(this.linkOptions())
      link = offered.link
      this.adopt(link)
      if (failure !== undefined) throw failure
      const envelope = await this.seal('offer', sid, me, recipient, { sdp: offered.sdp })
      if (failure !== undefined) throw failure
      await signaler.send(recipient, envelope)
      const p = await reply
      if (p.kind === 'reject') {
        const reason = truncate(p.reason ?? 'no reason given', MAX_REJECT_REASON_CHARS)
        throw new WebRTPayError('rejected', `Recipient refused the connection: ${reason}`)
      }
      if (p.sdp === undefined) throw new WebRTPayError('protocol', 'Answer carries no SDP')
      // Listen on the link before the channel can open, so the peer's hello is not missed.
      const session = authenticate(link, {
        wallet: this.wallet,
        originator: this.originator,
        expectedPeer: recipient,
        timeoutMs: Math.max(1, deadline - Date.now()),
        maxMessageBytes: this.maxMessageBytes
      })
      session.catch(noop)
      await link.acceptAnswer(p.sdp)
      return await session
    }

    return new Promise<AuthenticatedPeer>((resolve, reject) => {
      let settled = false
      const settle = (): boolean => {
        if (settled) return false
        settled = true
        clearTimeout(timer)
        this.dials.delete(sid)
        this.endDial()
        return true
      }
      const fail = (e: WebRTPayError): void => {
        if (failure !== undefined) return
        failure = e
        abandon(e)
        link?.close(e)
        if (settle()) reject(e)
      }
      const timer = setTimeout(() => {
        fail(
          answered
            ? new WebRTPayError('timeout', `Connection not established within ${timeoutMs} ms`)
            : new WebRTPayError(
                'peer_unreachable',
                `No answer from the recipient in ${timeoutMs} ms`
              )
        )
      }, timeoutMs)
      this.dials.set(sid, {
        recipient,
        reply: p => {
          answered = true
          deliver(p)
        },
        fail
      })
      this.beginDial()
      run().then(
        peer => {
          if (settle()) resolve(peer)
          else peer.close(failure)
        },
        (e: unknown) => {
          link?.close(asError(e))
          if (settle()) reject(e)
        }
      )
    })
  }

  /**
   * Send `token` as a `payment` and wait for the matching `payment.ack`. Once the ack is
   * in, the session is ended (bye, then close); a `rejected` ack resolves like any other,
   * the caller decides. A failure closes the session too.
   *
   * @throws `WebRTPayError`: `closed` (or the close reason) when the session closes before
   * the ack; `timeout` after `timeoutMs` (default `ackMs`, 45 s).
   */
  async sendPayment(
    peer: AuthenticatedPeer,
    token: PaymentToken,
    o: { note?: string; timeoutMs?: number } = {}
  ): Promise<PaymentAck> {
    const timeoutMs = timerMs(o.timeoutMs, this.ackMs, 'timeoutMs')
    const id = newId()
    const wire = encodePayment(id, token, o.note)
    const acked = peer.waitFor(
      (m): m is PaymentAck => m.t === 'payment.ack' && m.id === id,
      timeoutMs
    )
    let ack: PaymentAck
    try {
      ;[, ack] = await Promise.all([peer.send(wire), acked])
    } catch (e) {
      peer.close(asError(e))
      throw e
    }
    // The payee keeps the session until it hears this, so the ack can never be cut short.
    await peer.send({ t: 'bye' }).catch(noop)
    peer.close()
    return ack
  }

  /**
   * Start a face-to-face session as the payee: gather an offer and wrap it in a
   * `webrtpay1:` offer code naming this identity, the network and the optional amount.
   * The handlers come from `o.handlers`, else the active receive handlers when
   * {@link OfferHandle.complete} runs. The session does not count against inbound limits.
   *
   * @throws `TypeError` when neither `o.chain` nor the client's `chain` is set;
   * `RangeError` for an invalid amount or expiry; `WebRTPayError('too_large')` when the
   * SDP does not fit a code; `closed` after {@link close}.
   */
  async createOfferCode(o: OfferCodeOptions = {}): Promise<OfferHandle> {
    if (this.closing !== undefined) throw closedError()
    const chain = o.chain ?? this.chain
    if (typeof chain !== 'string') {
      throw new TypeError('An offer code names its network: pass chain here or to the client')
    }
    if (o.amount !== undefined && !(Number.isSafeInteger(o.amount) && o.amount >= 1)) {
      throw new RangeError('amount must be a positive safe integer number of satoshis')
    }
    const expiresAt =
      o.expiresInMs === undefined
        ? undefined
        : Date.now() + timerMs(o.expiresInMs, 0, 'expiresInMs')
    const me = await this.getIdentityKey()
    const sid = randomBytes(SID_BYTES)
    const { link, sdp } = await PeerLink.createOffer(this.linkOptions())
    this.adopt(link)
    let code: string
    try {
      code = encodeOfferCode({ sid, identityKey: me, chain, amount: o.amount, expiresAt, sdp })
    } catch (e) {
      link.close()
      throw e
    }

    let answered = false
    const complete = async (answerCode: string): Promise<AuthenticatedPeer> => {
      if (answered) throw new WebRTPayError('protocol', 'This offer was already answered')
      const answer = decodeCode(answerCode)
      if (answer.kind !== 'answer') {
        throw new WebRTPayError('invalid_code', 'This is an offer code, not an answer code')
      }
      if (!equalBytes(answer.sid, sid)) {
        throw new WebRTPayError('invalid_code', 'This answer code is for another offer')
      }
      const handlers = o.handlers ?? this.handlers
      if (handlers === undefined) {
        throw new WebRTPayError('unsupported', 'No receive handlers to serve this session')
      }
      answered = true
      const session = authenticate(link, {
        wallet: this.wallet,
        originator: this.originator,
        expectedPeer: answer.identityKey,
        timeoutMs: this.connectMs,
        maxMessageBytes: this.limits.maxMessageBytes
      })
      session.catch(noop)
      try {
        await link.acceptAnswer(answer.sdp)
      } catch (e) {
        link.close(asError(e))
        throw e
      }
      const peer = await session
      this.serve(peer, handlers, noop)
      return peer
    }

    return {
      code,
      sid: toBase64Url(sid),
      complete,
      cancel: () => link.close(new WebRTPayError('closed', 'Offer cancelled'))
    }
  }

  /**
   * Answer a payee's offer code as the payer: decode it, gather the answer and wrap it in
   * an answer code to show the payee. `connected` authenticates the payee against the
   * identity in the offer.
   *
   * @throws `WebRTPayError('invalid_code')` for a malformed or expired code, an answer
   * code, or an offer for another network than `expectedChain` (default: the client's
   * `chain`; no check when neither is set); `closed` after {@link close}.
   */
  async answerOfferCode(code: string, o: { expectedChain?: string } = {}): Promise<AnswerHandle> {
    if (this.closing !== undefined) throw closedError()
    const offer = decodeCode(code, { expectedChain: o.expectedChain ?? this.chain })
    if (offer.kind !== 'offer') {
      throw new WebRTPayError('invalid_code', 'This is an answer code, not an offer code')
    }
    const me = await this.getIdentityKey()
    const { link, sdp } = await PeerLink.acceptOffer(offer.sdp, this.linkOptions())
    this.adopt(link)
    const connected = authenticate(link, {
      wallet: this.wallet,
      originator: this.originator,
      expectedPeer: offer.identityKey,
      timeoutMs: this.connectMs,
      maxMessageBytes: this.maxMessageBytes
    })
    connected.catch(noop)
    let answerCode: string
    try {
      answerCode = encodeAnswerCode({ sid: offer.sid, identityKey: me, sdp })
    } catch (e) {
      link.close()
      throw e
    }
    return {
      offer,
      answerCode,
      connected,
      cancel: () => link.close(new WebRTPayError('closed', 'Answer cancelled'))
    }
  }

  /** Use these RTC options for links created from now on (new ICE servers, say). */
  updateRtc(rtc: RtcOptions): void {
    this.rtc = { ...rtc }
  }

  /**
   * Stop receiving, end pending dials with `closed`, close every link and session this
   * client opened and unsubscribe from the signaler (which stays open; it belongs to the
   * caller). Later calls to other methods reject `closed`.
   */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.handlers = undefined
      const reason = closedError()
      for (const dial of [...this.dials.values()]) dial.fail(reason)
      for (const link of [...this.links]) link.close(reason)
      this.closing = this.syncListening().catch(noop)
    }
    return this.closing
  }

  // ------------------------------------------------------------ signaling

  /** Subscribe while receiving or dialing, unsubscribe otherwise; one change at a time. */
  private syncListening(): Promise<void> {
    const op = this.listenOps.then(() => this.applyListening())
    this.listenOps = op.catch(noop)
    return op
  }

  private async applyListening(): Promise<void> {
    const want = this.closing === undefined && (this.handlers !== undefined || this.dialCount > 0)
    if (want && this.unlisten === undefined && this.signaler !== undefined) {
      this.unlisten = await this.signaler.listen((from, e) => this.onSignal(from, e))
    } else if (!want && this.unlisten !== undefined) {
      const stop = this.unlisten
      this.unlisten = undefined
      await stop()
    }
  }

  private beginDial(): void {
    if (++this.dialCount === 1) this.hintActive(true)
  }

  private endDial(): void {
    if (--this.dialCount === 0) this.hintActive(false)
    this.syncListening().catch(noop)
  }

  private hintActive(active: boolean): void {
    try {
      this.signaler?.setActive?.(active)
    } catch {
      // only a polling hint
    }
  }

  private onSignal(from: PubKeyHex, e: SignalEnvelope): void {
    this.handleSignal(from, e).catch(error => this.report(this.handlers, error))
  }

  private async handleSignal(from: PubKeyHex, e: SignalEnvelope): Promise<void> {
    if (this.closing !== undefined) return
    const me = await this.getIdentityKey()
    let p: SignalPlaintext
    try {
      p = await openSignal(this.wallet, from, e, {
        me,
        replay: this.replay,
        originator: this.originator
      })
    } catch {
      return // undecryptable, stale, replayed or misaddressed: dropped
    }
    if (this.closing !== undefined) return
    if (p.kind === 'offer') {
      await this.answerOffer(p, me)
      return
    }
    const dial = this.dials.get(p.sid)
    if (dial !== undefined && dial.recipient === p.from) dial.reply(p)
  }

  /** Answer an inbound offer, or refuse it without gathering ICE (no address disclosed). */
  private async answerOffer(p: SignalPlaintext, me: PubKeyHex): Promise<void> {
    const handlers = this.handlers
    if (handlers === undefined) return this.refuse(p, me, 'not_receiving')
    if (p.sdp === undefined) return
    if (!this.limiter.tryAdmit(p.from)) return this.refuse(p, me, 'busy')
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.limiter.release()
    }
    let link: PeerLink | undefined
    try {
      const accepted = await PeerLink.acceptOffer(p.sdp, this.linkOptions())
      link = accepted.link
      this.adopt(link)
      // Listen on the link before the answer goes out, so the peer's hello is not missed.
      const session = authenticate(link, {
        wallet: this.wallet,
        originator: this.originator,
        maxMessageBytes: this.limits.maxMessageBytes
      })
      session.catch(noop)
      const envelope = await this.seal('answer', p.sid, me, p.from, { sdp: accepted.sdp })
      await this.signaler!.send(p.from, envelope)
      this.serve(await session, handlers, release)
    } catch (e) {
      link?.close(asError(e))
      release()
      this.report(handlers, e)
    }
  }

  private async refuse(p: SignalPlaintext, me: PubKeyHex, reason: string): Promise<void> {
    const envelope = await this.seal('reject', p.sid, me, p.from, { reason })
    await this.signaler!.send(p.from, envelope)
  }

  private seal(
    kind: SignalKind,
    sid: string,
    from: PubKeyHex,
    to: PubKeyHex,
    extra: { sdp?: string; reason?: string }
  ): Promise<SignalEnvelope> {
    const p: SignalPlaintext = { v: 1, kind, sid, from, to, ts: Date.now(), purpose: 'payment' }
    if (extra.sdp !== undefined) p.sdp = extra.sdp
    if (extra.reason !== undefined) p.reason = extra.reason
    return sealSignal(this.wallet, p, this.originator)
  }

  // ------------------------------------------------------------ inbound sessions

  /**
   * Serve an authenticated inbound session: handle its messages one at a time, close it
   * after `idleTimeoutMs` without traffic or on `bye`/`error`, call `release` when it ends.
   */
  private serve(peer: AuthenticatedPeer, h: ReceiveHandlers, release: () => void): void {
    let ended = false
    let idle: ReturnType<typeof setTimeout> | undefined
    const touch = (): void => {
      clearTimeout(idle)
      if (ended) return
      idle = setTimeout(
        () => peer.close(new WebRTPayError('timeout', 'Session was idle')),
        this.limits.idleTimeoutMs
      )
    }
    peer.onClose(() => {
      ended = true
      clearTimeout(idle)
      release()
    })
    touch()

    let pending = 0
    let queue = Promise.resolve()
    peer.onMessage(m => {
      if (ended) return
      touch()
      if (++pending > MAX_PENDING_MESSAGES) {
        peer.close(new WebRTPayError('rate_limited', 'Peer sent too many messages at once'))
        return
      }
      queue = queue
        .then(() => this.handleMessage(peer, h, m))
        .catch(e => this.report(h, e))
        .then(() => {
          pending--
          touch()
        })
    })
    try {
      h.onSession?.(peer.peerIdentityKey)
    } catch (e) {
      this.report(h, e)
    }
  }

  private async handleMessage(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    m: WireMessage
  ): Promise<void> {
    switch (m.t) {
      case 'payment':
        return this.receivePayment(peer, h, m)
      case 'request':
        return this.receiveRequest(peer, h, m)
      case 'bye':
        peer.close()
        return
      case 'error':
        peer.close(new WebRTPayError('closed', `Peer reported an error: ${m.code}`))
        return
      default:
        // acks, responses and stray handshake messages mean nothing to the payee
        return
    }
  }

  private async receivePayment(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    w: PaymentWire
  ): Promise<void> {
    let decoded: ReturnType<typeof decodePayment>
    try {
      decoded = decodePayment(w)
    } catch (e) {
      await peer.send(ackOf(w.id, undefined, { status: 'rejected', reason: messageOf(e) }))
      return
    }
    const payment: IncomingPayment = {
      messageId: decoded.id,
      sender: peer.peerIdentityKey,
      token: decoded.token
    }
    const ctx =
      decoded.note === undefined
        ? { txid: decoded.txid }
        : { note: decoded.note, txid: decoded.txid }
    let decision: PaymentDecision
    try {
      decision = await h.onPayment(payment, ctx)
    } catch (e) {
      this.report(h, e)
      decision = { status: 'rejected', reason: messageOf(e) }
    }
    await peer.send(ackOf(decoded.id, decoded.txid, decision))
  }

  private async receiveRequest(
    peer: AuthenticatedPeer,
    h: ReceiveHandlers,
    w: RequestWire
  ): Promise<void> {
    let request: PaymentRequestMessage
    try {
      request = normalizePaymentRequest(w.request, peer.peerIdentityKey)
    } catch (cause) {
      // An authenticated peer speaking for another identity is not to be trusted further.
      const error = new WebRTPayError('protocol', 'Payment request names another sender', {
        cause
      })
      await peer.send({ t: 'error', code: 'protocol', message: error.message }).catch(noop)
      peer.close(error)
      return
    }
    if (request.cancelled === true || h.onPaymentRequest === undefined) return
    const proofValid = await verifyPaymentRequestProof(
      this.wallet,
      request,
      peer.localIdentityKey,
      peer.peerIdentityKey,
      this.originator
    )
    await h.onPaymentRequest({
      messageId: newId(),
      sender: peer.peerIdentityKey,
      requestId: request.requestId,
      amount: request.amount,
      description: request.description,
      expiresAt: request.expiresAt,
      proofValid
    })
  }

  // ------------------------------------------------------------ helpers

  private linkOptions(): PeerLinkOptions {
    return { ...this.rtc, maxMessageBytes: PRE_AUTH_MAX_MESSAGE_BYTES }
  }

  /** Track a new link so {@link close} reaches it; a link made after close is closed. */
  private adopt(link: PeerLink): void {
    if (this.closing !== undefined) {
      const reason = closedError()
      link.close(reason)
      throw reason
    }
    this.links.add(link)
    link.onClose(() => this.links.delete(link))
  }

  private report(h: ReceiveHandlers | undefined, e: unknown): void {
    try {
      h?.onError?.(e)
    } catch {
      // an error hook that throws must not break the client
    }
  }
}

function noop(): void {}

function closedError(): WebRTPayError {
  return new WebRTPayError('closed', 'Client is closed')
}

/** 16 random bytes, base64url: payment ids and signaling session ids (Ruling 18). */
function newId(): string {
  return toBase64Url(randomBytes(SID_BYTES))
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s
}

function asError(e: unknown): WebRTPayError | undefined {
  return e instanceof WebRTPayError ? e : undefined
}

/** A reason safe to show the peer: our own error messages only. */
function messageOf(e: unknown): string {
  return e instanceof WebRTPayError ? e.message : NOT_PROCESSED
}

function ackOf(id: string, txid: string | undefined, d: PaymentDecision): PaymentAck {
  const withTxid = txid === undefined ? {} : { txid }
  if (d === 'accepted' || d === 'received') return { t: 'payment.ack', id, status: d, ...withTxid }
  const reason =
    typeof d === 'object' && d !== null && d.status === 'rejected' && typeof d.reason === 'string'
      ? d.reason
      : NOT_PROCESSED
  return {
    t: 'payment.ack',
    id,
    status: 'rejected',
    ...withTxid,
    reason: truncate(reason, MAX_ACK_REASON_CHARS)
  }
}

/** `v`, or `fallback` when undefined; a positive number of ms `setTimeout` can wait for. */
function timerMs(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_TIMER_MS) {
    throw new RangeError(`${name} must be a positive number of milliseconds up to ${MAX_TIMER_MS}`)
  }
  return v
}

/** The fields of a partial object that are not `undefined`. */
function definedFields<T extends object>(o: Partial<T> | undefined): Partial<T> {
  const out: Partial<T> = {}
  if (o === undefined) return out
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}
