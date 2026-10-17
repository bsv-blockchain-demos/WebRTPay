import { RELAY_PROTOCOL_ID } from '../types.js'
import type { PubKeyHex, WalletLike } from '../types.js'
import { toHex, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import type { WebRTPayErrorCode } from '../util/errors.js'
import { dispatchSignal } from './dispatch.js'
import type { SignalSubscription } from './dispatch.js'
import { isSignalEnvelope } from './envelope.js'
import type { SignalEnvelope, Signaler } from './types.js'

/** Domain separation for the relay authentication message. */
export const RELAY_AUTH_PREFIX = 'webrtpay-relay/1|'

/** Why the relay refused a frame or a socket. */
export type RelayErrorCode =
  'offline' | 'rate_limited' | 'too_large' | 'bad_request' | 'auth_failed'

/** An ICE server as the relay hands it out. */
export interface RelayIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/** JSON text frames a client sends to the relay. */
export type RelayClientFrame =
  /** Answer to the challenge: a hex DER signature by `identityKey` over {@link relayAuthData}. */
  | { t: 'auth'; identityKey: PubKeyHex; signature: string }
  | { t: 'signal'; to: PubKeyHex; envelope: SignalEnvelope }

/**
 * JSON text frames the relay sends to a client. Every client `signal` frame gets
 * exactly one reply, `sent` or `error`, in the order the frames were sent; `ref`
 * is the envelope sid when the frame carried a well-formed envelope.
 */
export type RelayServerFrame =
  | { t: 'challenge'; nonce: string }
  | { t: 'ready'; identityKey: PubKeyHex }
  | { t: 'ice'; iceServers: RelayIceServer[] }
  | { t: 'signal'; from: PubKeyHex; envelope: SignalEnvelope }
  | { t: 'sent'; ref?: string }
  | { t: 'error'; code: RelayErrorCode; ref?: string }

/** `url` without trailing slashes, the form both ends sign and verify. */
export function normalizeRelayUrl(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--
  return url.slice(0, end)
}

/**
 * The bytes a client signs to authenticate to the relay at `url`:
 * UTF-8 of `"webrtpay-relay/1|" + url + "|" + nonce`, with the url normalized.
 */
export function relayAuthData(url: string, nonce: string): number[] {
  return Array.from(utf8Encode(RELAY_AUTH_PREFIX + normalizeRelayUrl(url) + '|' + nonce))
}

export interface RelaySignalerOptions {
  /** Relay WebSocket URL (`ws:` or `wss:`); it is signed without trailing slashes. */
  url: string
  /** Signs the relay's challenge with the identity key. */
  wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature'>
  originator?: string
  /** WebSocket constructor; defaults to the global one (browsers, Node 22 and later). */
  WebSocket?: typeof WebSocket
  /** Called with the ICE servers the relay hands out on every (re)connection. */
  onIceServers?: (servers: RTCIceServer[]) => void
}

/** Time allowed to open, authenticate and receive ICE servers. */
const CONNECT_TIMEOUT_MS = 15000
/** Time the relay has to confirm a signal before the connection is dropped. */
const SEND_TIMEOUT_MS = 10000
/** Time `close()` waits for the closing handshake. */
const CLOSE_WAIT_MS = 2000
const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30000
/** Longest challenge nonce accepted (it becomes a BRC-43 key ID). */
const MAX_NONCE_CHARS = 256
const CLOSED = 3
const RELAY_URL_RE = /^wss?:\/\/[^/?#\s]+/i

const RELAY_ERRORS: Record<RelayErrorCode, [WebRTPayErrorCode, string]> = {
  offline: ['peer_unreachable', 'Peer is not connected to the relay'],
  rate_limited: ['rate_limited', 'Relay rate limit reached'],
  too_large: ['too_large', 'Signal envelope is too large for the relay'],
  bad_request: ['protocol', 'Relay rejected the frame as malformed'],
  auth_failed: ['auth_failed', 'Relay authentication failed']
}

/**
 * Carries signal envelopes through a `@bsv/webrtpay/server` relay over one
 * authenticated WebSocket.
 *
 * The socket is held only while it is needed: while at least one `listen`
 * subscription exists, while a `send` is in flight, or after an explicit
 * `connect()`. Otherwise it is closed, so the relay reports this identity as
 * offline and a peer's `send` fails fast with `peer_unreachable`. While
 * listening, a dropped connection is reopened after 1 s, doubling per failed
 * attempt up to 30 s.
 *
 * Failures reject `WebRTPayError`: `peer_unreachable` (relay unreachable, the
 * connection dropped, or the peer is offline), `auth_failed`, `rate_limited`
 * (also for too many sockets for this identity), `too_large`, `protocol` and,
 * after `close()`, `closed`.
 */
export class RelaySignaler implements Signaler {
  private readonly url: string
  private readonly wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature'>
  private readonly originator: string | undefined
  private readonly WS: typeof WebSocket
  private readonly onIceServers: ((servers: RTCIceServer[]) => void) | undefined
  private readonly subs = new Set<SignalSubscription>()
  private conn: RelayConnection | undefined
  private ice: RTCIceServer[] | undefined
  private explicit = false
  private sending = 0
  private failures = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private closing: Promise<void> | undefined

  constructor(o: RelaySignalerOptions) {
    if (typeof o.url !== 'string' || !RELAY_URL_RE.test(o.url)) {
      throw new TypeError('Relay url must be a ws: or wss: URL')
    }
    const WS = o.WebSocket ?? globalThis.WebSocket
    if (typeof WS !== 'function') {
      throw new WebRTPayError('unsupported', 'No WebSocket implementation is available')
    }
    this.url = o.url
    this.wallet = o.wallet
    this.originator = o.originator
    this.WS = WS
    this.onIceServers = o.onIceServers
  }

  /** Open and authenticate now, and keep the connection until `close()`. */
  async connect(): Promise<void> {
    this.explicit = true
    await this.open()
  }

  /** Close the connection for good; later calls reject `closed`. */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.clearTimer()
      this.subs.clear()
      const conn = this.conn
      this.conn = undefined
      this.closing = conn?.close(closedError()) ?? Promise.resolve()
    }
    return this.closing
  }

  /** The ICE servers from the most recent connection; undefined before the first. */
  iceServers(): RTCIceServer[] | undefined {
    return this.ice === undefined ? undefined : copyIceServers(this.ice)
  }

  /** Forward `e` to every socket of `to`; resolves once the relay confirms. */
  async send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    this.sending++
    try {
      const conn = await this.open()
      await conn.send(to, e)
    } finally {
      this.sending--
      void this.release()
    }
  }

  /** Subscribe; resolves once the connection is authenticated and rejects if it cannot be. */
  async listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>> {
    if (this.closing !== undefined) throw closedError()
    const sub: SignalSubscription = { fn }
    this.subs.add(sub)
    try {
      await this.open()
    } catch (err) {
      this.subs.delete(sub)
      void this.release()
      throw err
    }
    return async () => {
      if (this.subs.delete(sub)) await this.release()
    }
  }

  private open(): Promise<RelayConnection> {
    if (this.closing !== undefined) return Promise.reject(closedError())
    const conn = this.conn ?? this.start()
    return conn.ready.then(() => conn)
  }

  private start(): RelayConnection {
    this.clearTimer()
    const conn = new RelayConnection({
      url: this.url,
      WS: this.WS,
      wallet: this.wallet,
      originator: this.originator,
      onSignal: (from, e) => dispatchSignal(this.subs, from, e),
      onIce: servers => {
        this.ice = servers
        this.onIceServers?.(copyIceServers(servers))
      },
      onEnd: opened => this.ended(conn, opened)
    })
    this.conn = conn
    conn.ready.then(
      () => {
        if (this.conn === conn) this.failures = 0
      },
      () => {}
    )
    conn.open()
    return conn
  }

  /** The current connection ended; reconnect while anyone is listening. */
  private ended(conn: RelayConnection, opened: boolean): void {
    if (this.conn !== conn) return
    this.conn = undefined
    if (!opened) this.failures++
    if (this.closing !== undefined || this.subs.size === 0) return
    const delay = Math.min(MIN_BACKOFF_MS * 2 ** this.failures, MAX_BACKOFF_MS)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.conn === undefined && this.closing === undefined && this.subs.size > 0) {
        this.start()
      }
    }, delay)
  }

  /** Close the connection when nothing holds it any more. */
  private release(): Promise<void> {
    if (this.subs.size === 0) this.clearTimer()
    if (this.subs.size > 0 || this.sending > 0 || this.explicit) return Promise.resolve()
    const conn = this.conn
    this.conn = undefined
    if (conn === undefined) return Promise.resolve()
    return conn.close(new WebRTPayError('closed', 'Relay connection is no longer needed'))
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }
}

interface ConnectionHooks {
  url: string
  WS: typeof WebSocket
  wallet: Pick<WalletLike, 'getPublicKey' | 'createSignature'>
  originator: string | undefined
  onSignal(from: PubKeyHex, e: SignalEnvelope): void
  onIce(servers: RTCIceServer[]): void
  /** Called once when the connection ends; `opened` when its handshake had completed. */
  onEnd(opened: boolean): void
}

interface PendingSend {
  resolve(): void
  reject(err: WebRTPayError): void
}

/** One WebSocket to the relay: challenge, auth, ready, ice, then signals. */
class RelayConnection {
  readonly ready: Promise<void>
  private settle!: (err?: WebRTPayError) => void
  private ws: WebSocket | undefined
  private stage: 'challenge' | 'signing' | 'auth' | 'ice' | 'open' | 'ended' = 'challenge'
  private identityKey: PubKeyHex | undefined
  private readonly pending: PendingSend[] = []
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly socketClosed: Promise<void>
  private markSocketClosed!: () => void

  constructor(private readonly h: ConnectionHooks) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.settle = err => (err === undefined ? resolve() : reject(err))
    })
    // Rejections are delivered to whoever awaits `ready`; a reconnect may have no one.
    this.ready.catch(() => {})
    this.socketClosed = new Promise<void>(resolve => {
      this.markSocketClosed = resolve
    })
  }

  open(): void {
    this.handshakeTimer = setTimeout(
      () => this.end(new WebRTPayError('peer_unreachable', 'Relay handshake timed out')),
      CONNECT_TIMEOUT_MS
    )
    let ws: WebSocket
    try {
      ws = new this.h.WS(this.h.url)
    } catch (cause) {
      this.markSocketClosed()
      this.end(new WebRTPayError('peer_unreachable', 'Could not open the relay socket', { cause }))
      return
    }
    this.ws = ws
    ws.addEventListener('message', ev => this.onMessage(ev.data))
    ws.addEventListener('close', () => {
      this.markSocketClosed()
      this.end(
        new WebRTPayError(
          'peer_unreachable',
          this.stage === 'open' ? 'Relay connection closed' : 'Could not connect to the relay'
        )
      )
    })
    // A failed socket always fires close next; that is where it is handled.
    ws.addEventListener('error', () => {})
  }

  /** Send a signal frame and wait for the relay's reply to it. */
  send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    if (this.stage !== 'open') {
      return Promise.reject(new WebRTPayError('peer_unreachable', 'Relay connection closed'))
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          this.end(
            new WebRTPayError('peer_unreachable', 'Relay did not confirm the signal in time')
          ),
        SEND_TIMEOUT_MS
      )
      this.pending.push({
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: err => {
          clearTimeout(timer)
          reject(err)
        }
      })
      const envelope = { v: e.v, sid: e.sid, ciphertext: e.ciphertext }
      this.write({ t: 'signal', to, envelope })
    })
  }

  /** End with `err` and wait (briefly) for the socket's closing handshake. */
  close(err: WebRTPayError): Promise<void> {
    this.end(err)
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, CLOSE_WAIT_MS)
      void this.socketClosed.then(() => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private onMessage(data: unknown): void {
    if (this.stage === 'ended' || typeof data !== 'string') return
    let f: unknown
    try {
      f = JSON.parse(data)
    } catch {
      return
    }
    if (!isRecord(f)) return
    switch (f.t) {
      case 'challenge':
        if (this.stage === 'challenge') this.answer(f.nonce)
        return
      case 'ready':
        if (this.stage !== 'auth') return
        if (f.identityKey !== this.identityKey) {
          this.end(new WebRTPayError('protocol', 'Relay confirmed a different identity'))
          return
        }
        this.stage = 'ice'
        return
      case 'ice': {
        if (this.stage !== 'ice' && this.stage !== 'open') return
        const servers = iceServersOf(f.iceServers)
        if (servers === undefined) {
          // fails the handshake; a malformed refresh later on is ignored
          if (this.stage === 'ice') {
            this.end(new WebRTPayError('protocol', 'Relay sent bad ICE servers'))
          }
          return
        }
        this.h.onIce(servers)
        if (this.stage === 'ice') {
          this.stage = 'open'
          clearTimeout(this.handshakeTimer)
          this.settle()
        }
        return
      }
      case 'signal':
        if (this.stage === 'open' && typeof f.from === 'string' && isSignalEnvelope(f.envelope)) {
          this.h.onSignal(f.from, f.envelope)
        }
        return
      case 'sent':
        if (this.stage === 'open') this.pending.shift()?.resolve()
        return
      case 'error': {
        const err = relayError(f.code)
        if (this.stage === 'open') this.pending.shift()?.reject(err)
        else this.end(err)
        return
      }
    }
  }

  private answer(nonce: unknown): void {
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > MAX_NONCE_CHARS) {
      this.end(new WebRTPayError('protocol', 'Relay sent a malformed challenge'))
      return
    }
    this.stage = 'signing'
    this.sign(nonce).then(
      frame => {
        if (this.stage !== 'signing') return
        this.stage = 'auth'
        this.write(frame)
      },
      cause =>
        this.end(new WebRTPayError('auth_failed', 'Could not sign the relay challenge', { cause }))
    )
  }

  private async sign(nonce: string): Promise<RelayClientFrame> {
    const { wallet, originator } = this.h
    const { publicKey } = await wallet.getPublicKey({ identityKey: true }, originator)
    const { signature } = await wallet.createSignature(
      {
        data: relayAuthData(this.h.url, nonce),
        protocolID: RELAY_PROTOCOL_ID,
        keyID: nonce,
        counterparty: 'anyone'
      },
      originator
    )
    this.identityKey = publicKey
    return { t: 'auth', identityKey: publicKey, signature: toHex(Uint8Array.from(signature)) }
  }

  private write(frame: RelayClientFrame): void {
    try {
      this.ws?.send(JSON.stringify(frame))
    } catch (cause) {
      this.end(new WebRTPayError('peer_unreachable', 'Could not write to the relay', { cause }))
    }
  }

  private end(err: WebRTPayError): void {
    if (this.stage === 'ended') return
    const opened = this.stage === 'open'
    this.stage = 'ended'
    clearTimeout(this.handshakeTimer)
    this.settle(err)
    for (const p of this.pending.splice(0)) p.reject(err)
    if (this.ws !== undefined && this.ws.readyState !== CLOSED) {
      try {
        this.ws.close(1000)
      } catch {
        // already closing
      }
    }
    this.h.onEnd(opened)
  }
}

function relayError(code: unknown): WebRTPayError {
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(RELAY_ERRORS, code)) {
    const [mapped, message] = RELAY_ERRORS[code as RelayErrorCode]
    return new WebRTPayError(mapped, message)
  }
  return new WebRTPayError('protocol', 'Relay sent an unknown error')
}

/** A sanitized copy of the relay's ICE server list, or undefined when it is malformed. */
function iceServersOf(x: unknown): RTCIceServer[] | undefined {
  if (!Array.isArray(x)) return undefined
  const out: RTCIceServer[] = []
  for (const s of x as unknown[]) {
    if (!isRecord(s)) return undefined
    const { urls, username, credential } = s
    const urlsOk =
      typeof urls === 'string' || (Array.isArray(urls) && urls.every(u => typeof u === 'string'))
    if (
      !urlsOk ||
      (username !== undefined && typeof username !== 'string') ||
      (credential !== undefined && typeof credential !== 'string')
    ) {
      return undefined
    }
    const server: RTCIceServer = { urls: typeof urls === 'string' ? urls : [...(urls as string[])] }
    if (username !== undefined) server.username = username as string
    if (credential !== undefined) server.credential = credential as string
    out.push(server)
  }
  return out
}

function copyIceServers(servers: RTCIceServer[]): RTCIceServer[] {
  return servers.map(s => ({ ...s, urls: Array.isArray(s.urls) ? [...s.urls] : s.urls }))
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function closedError(): WebRTPayError {
  return new WebRTPayError('closed', 'Relay signaler is closed')
}
