import { DEFAULTS } from '../types.js'
import type { PubKeyHex } from '../types.js'

/** What a payee allows from peers that dial it by identity key (spec §6). */
export interface InboundLimits {
  /** Most inbound sessions open at once, handshake included. */
  maxConcurrent: number
  /** Most offers admitted from everyone per rolling minute. */
  offersPerMinute: number
  /** Most offers admitted from one sender per rolling minute. */
  offersPerMinutePerSender: number
  /** Largest message accepted from an inbound peer once it has authenticated, in bytes. */
  maxMessageBytes: number
  /** An inbound session with no traffic for this long is closed, in milliseconds. */
  idleTimeoutMs: number
}

/** 3 sessions, 10 offers a minute (3 per sender), 16 MiB messages, 60 s idle timeout. */
export const DEFAULT_INBOUND_LIMITS: Readonly<InboundLimits> = Object.freeze({
  maxConcurrent: 3,
  offersPerMinute: 10,
  offersPerMinutePerSender: 3,
  maxMessageBytes: DEFAULTS.inboundMaxMessageBytes,
  idleTimeoutMs: 60000
})

const WINDOW_MS = 60000
/** Longest delay `setTimeout` honours; anything larger fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

/**
 * Admission control for inbound offers. An offer is admitted when a session slot is free
 * and neither the overall nor the sender's offers in the last 60 s reach their limit; it
 * then takes a slot until {@link release}. Refused offers count against nothing, so a
 * sender that keeps being refused cannot use up anyone else's budget.
 */
export class InboundLimiter {
  private readonly limits: InboundLimits
  private active = 0
  /** Admission times within the window, oldest first. */
  private readonly admitted: number[] = []
  private readonly bySender = new Map<PubKeyHex, number[]>()

  /** @throws `RangeError` for a limit that is not a positive integer (or timer length). */
  constructor(l: InboundLimits) {
    for (const name of ['maxConcurrent', 'offersPerMinute', 'offersPerMinutePerSender'] as const) {
      if (!Number.isSafeInteger(l[name]) || l[name] < 1) {
        throw new RangeError(`${name} must be a positive integer`)
      }
    }
    if (!Number.isSafeInteger(l.maxMessageBytes) || l.maxMessageBytes < 1) {
      throw new RangeError('maxMessageBytes must be a positive integer')
    }
    if (!isTimerMs(l.idleTimeoutMs)) {
      throw new RangeError(`idleTimeoutMs must be a positive number up to ${MAX_TIMER_MS}`)
    }
    this.limits = { ...l }
  }

  /** Admit an offer from `sender` at `now` (ms) and take a session slot, or refuse it. */
  tryAdmit(sender: PubKeyHex, now: number = Date.now()): boolean {
    this.prune(now)
    const fromSender = this.bySender.get(sender) ?? []
    if (
      this.active >= this.limits.maxConcurrent ||
      this.admitted.length >= this.limits.offersPerMinute ||
      fromSender.length >= this.limits.offersPerMinutePerSender
    ) {
      return false
    }
    this.active++
    this.admitted.push(now)
    fromSender.push(now)
    this.bySender.set(sender, fromSender)
    return true
  }

  /** Give back the slot an admitted offer took, when its session ends. */
  release(): void {
    if (this.active > 0) this.active--
  }

  private prune(now: number): void {
    while (this.admitted.length > 0 && now - this.admitted[0] >= WINDOW_MS) this.admitted.shift()
    for (const [sender, times] of this.bySender) {
      while (times.length > 0 && now - times[0] >= WINDOW_MS) times.shift()
      if (times.length === 0) this.bySender.delete(sender)
    }
  }
}

/** A positive number of milliseconds that `setTimeout` can wait for. */
function isTimerMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIMER_MS
}
