import { DEFAULTS, SIGNALS_MESSAGEBOX } from '../types.js'
import type { PubKeyHex } from '../types.js'
import { WebRTPayError } from '../util/errors.js'
import { dispatchSignal } from './dispatch.js'
import type { SignalSubscription } from './dispatch.js'
import { isSignalEnvelope } from './envelope.js'
import type { SignalEnvelope, Signaler } from './types.js'

/**
 * The `MessageBoxClient` (`@bsv/message-box-client`) methods this signaler uses,
 * typed structurally so the package does not depend on it.
 */
export interface MessageBoxLike {
  sendMessage(
    a: { recipient: string; messageBox: string; body: string },
    overrideHost?: string
  ): Promise<unknown>
  listMessages(a: {
    messageBox: string
    host?: string
  }): Promise<Array<{ messageId: string; sender: string; body: string | Record<string, unknown> }>>
  acknowledgeMessage(a: { messageIds: string[]; host?: string }): Promise<unknown>
}

export interface MessageBoxSignalerOptions {
  /** Box that carries the envelopes; defaults to `webrtpay_signals`. */
  messageBox?: string
  /** Poll interval while no dial is in progress; defaults to 2500 ms. */
  idlePollMs?: number
  /** Poll interval while `setActive(true)`; defaults to 1000 ms. */
  activePollMs?: number
  /**
   * MessageBox host to list and acknowledge on. Sending always resolves the
   * recipient's own host, so payer and payee may use different servers.
   */
  host?: string
}

/** Longest wait between polls after consecutive errors. */
const MAX_BACKOFF_MS = 30000
/** Most message IDs `MessageBoxClient.acknowledgeMessage` accepts per call. */
const MAX_ACK_IDS = 1000
/** Message IDs remembered for dedupe. */
const MAX_SEEN_IDS = 10000

/**
 * Carries signal envelopes through MessageBox. `send` posts over HTTP to the
 * recipient's host. Listening polls `listMessages`, delivers each new envelope
 * once and acknowledges every message it reads, including ones that are not
 * envelopes, so nothing lingers on the server. One poll loop serves all
 * listeners and runs while at least one is subscribed; errors double the wait
 * (up to 30 s) and never escape the loop.
 */
export class MessageBoxSignaler implements Signaler {
  private readonly messageBox: string
  private readonly idlePollMs: number
  private readonly activePollMs: number
  private readonly host: string | undefined
  private readonly subs = new Set<SignalSubscription>()
  /** messageId → whether the server has confirmed its acknowledgement; oldest first. */
  private readonly seen = new Map<string, boolean>()
  private active = false
  private polling = false
  private failures = 0
  private lastPollAt = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly client: MessageBoxLike,
    o: MessageBoxSignalerOptions = {}
  ) {
    this.messageBox = o.messageBox ?? SIGNALS_MESSAGEBOX
    this.idlePollMs = pollInterval(o.idlePollMs, DEFAULTS.payeePollMs, 'idlePollMs')
    this.activePollMs = pollInterval(o.activePollMs, DEFAULTS.payerPollMs, 'activePollMs')
    this.host = o.host
  }

  /** Post `e` to `to`'s box; any failure rejects `WebRTPayError('peer_unreachable')`. */
  async send(to: PubKeyHex, e: SignalEnvelope): Promise<void> {
    const body = JSON.stringify({ v: e.v, sid: e.sid, ciphertext: e.ciphertext })
    try {
      await this.client.sendMessage({ recipient: to, messageBox: this.messageBox, body })
    } catch (cause) {
      throw new WebRTPayError('peer_unreachable', 'MessageBox could not deliver the signal', {
        cause
      })
    }
  }

  /** Subscribe; the first subscription polls at once and starts the loop. */
  async listen(fn: (from: PubKeyHex, e: SignalEnvelope) => void): Promise<() => Promise<void>> {
    const sub: SignalSubscription = { fn }
    this.subs.add(sub)
    if (this.timer === undefined && !this.polling) this.poll()
    return async () => {
      if (this.subs.delete(sub) && this.subs.size === 0) this.clearTimer()
    }
  }

  /** Poll every `activePollMs` while true (a dial is waiting for its answer). */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    this.schedule()
  }

  private poll(): void {
    this.polling = true
    this.pollOnce()
      .then(
        () => {
          this.failures = 0
        },
        () => {
          this.failures++
        }
      )
      .then(() => {
        this.polling = false
        this.lastPollAt = Date.now()
        this.schedule()
      })
  }

  /** (Re)arm the timer for the next poll, measured from the end of the last one. */
  private schedule(): void {
    this.clearTimer()
    if (this.subs.size === 0 || this.polling) return
    const base = this.active ? this.activePollMs : this.idlePollMs
    const wait = Math.min(base * 2 ** this.failures, Math.max(base, MAX_BACKOFF_MS))
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        this.poll()
      },
      Math.max(0, this.lastPollAt + wait - Date.now())
    )
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async pollOnce(): Promise<void> {
    const listed: unknown = await this.client.listMessages(
      this.host === undefined
        ? { messageBox: this.messageBox }
        : { messageBox: this.messageBox, host: this.host }
    )
    if (!Array.isArray(listed)) throw new TypeError('listMessages did not return an array')

    const toAck = new Set<string>()
    for (const m of listed as unknown[]) {
      // Nobody is listening any more: leave the rest on the server for the next listener.
      if (this.subs.size === 0) break
      if (typeof m !== 'object' || m === null) continue
      const { messageId, sender, body } = m as Record<string, unknown>
      if (typeof messageId !== 'string') continue
      const acked = this.seen.get(messageId)
      if (acked === undefined) {
        this.seen.set(messageId, false)
        const e = envelopeOf(body)
        if (e !== undefined && typeof sender === 'string') dispatchSignal(this.subs, sender, e)
      }
      if (acked !== true) toAck.add(messageId)
    }

    const ids = [...toAck]
    for (let i = 0; i < ids.length; i += MAX_ACK_IDS) {
      const messageIds = ids.slice(i, i + MAX_ACK_IDS)
      await this.client.acknowledgeMessage(
        this.host === undefined ? { messageIds } : { messageIds, host: this.host }
      )
      for (const id of messageIds) this.seen.set(id, true)
    }
    while (this.seen.size > MAX_SEEN_IDS) {
      this.seen.delete(this.seen.keys().next().value as string)
    }
  }
}

/** The envelope in a message body (JSON text or an object the client already parsed). */
function envelopeOf(body: unknown): SignalEnvelope | undefined {
  let value = body
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body)
    } catch {
      return undefined
    }
  }
  return isSignalEnvelope(value) ? value : undefined
}

function pollInterval(v: number | undefined, fallback: number, name: string): number {
  if (v === undefined) return fallback
  if (!Number.isFinite(v) || v <= 0) {
    throw new RangeError(`${name} must be a positive number of milliseconds`)
  }
  return v
}
