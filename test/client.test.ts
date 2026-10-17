import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet, PublicKey } from '@bsv/sdk'
import { PeerLink } from '../src/channel/PeerLink.js'
import { decodeCode, encodeAnswerCode } from '../src/codec/codes.js'
import { DirectPayClient } from '../src/client/DirectPayClient.js'
import type { DirectPayClientOptions, ReceiveHandlers } from '../src/client/DirectPayClient.js'
import { DEFAULT_INBOUND_LIMITS, InboundLimiter } from '../src/client/limits.js'
import { acceptDirectPayment } from '../src/payments/accept.js'
import type { SeenStore } from '../src/payments/accept.js'
import { createPaymentRequestProof } from '../src/payments/requests.js'
import type { AuthenticatedPeer } from '../src/session/AuthenticatedPeer.js'
import { sealSignal } from '../src/signaling/envelope.js'
import { createMemoryHub } from '../src/signaling/MemorySignaler.js'
import type { MemoryHub } from '../src/signaling/MemorySignaler.js'
import type { Signaler } from '../src/signaling/types.js'
import { PAYMENT_PROTOCOL_ID } from '../src/types.js'
import type {
  IncomingPayment,
  IncomingPaymentRequest,
  PaymentToken,
  WalletLike
} from '../src/types.js'
import { randomBytes, toBase64, toBase64Url } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import { cleanupRtc, nodeRtc } from './helpers/rtc.js'
import type { NodeRtcOptions } from './helpers/rtc.js'
import { makePaymentTx } from './helpers/tx.js'

// File scope so a filtered run (-t) still releases node-datachannel's native threads.
afterAll(cleanupRtc)

let rtc: NodeRtcOptions
beforeAll(async () => {
  rtc = await nodeRtc()
})

/** Every client a test created; closed after each test so no peer or timer outlives it. */
const clients: DirectPayClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map(c => c.close()))
})

interface TestWallet {
  wallet: WalletLike
  identityKey: string
  internalizeAction: ReturnType<typeof jest.fn<WalletLike['internalizeAction']>>
}

/** A ProtoWallet (real keys, signatures and encryption) with a jest-mocked internalizeAction. */
async function makeWallet(): Promise<TestWallet> {
  const internalizeAction = jest.fn<WalletLike['internalizeAction']>(async () => ({
    accepted: true
  }))
  const wallet: WalletLike = Object.assign(new ProtoWallet(PrivateKey.fromRandom()), {
    internalizeAction
  })
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, identityKey: publicKey, internalizeAction }
}

/** A client with loopback WebRTC and short timeouts, closed after the test. */
function client(w: TestWallet, o: Partial<DirectPayClientOptions> = {}): DirectPayClient {
  const c = new DirectPayClient({
    wallet: w.wallet,
    rtc,
    timeouts: { connectMs: 3000, ackMs: 10000 },
    ...o
  })
  clients.push(c)
  return c
}

/** A client that signals through `hub` as its wallet's identity. */
function hubClient(
  hub: MemoryHub,
  w: TestWallet,
  o: Partial<DirectPayClientOptions> = {}
): DirectPayClient {
  return client(w, { signaler: hub.signaler(w.identityKey), ...o })
}

/** A payer-built token paying `satoshis` to the payee's BRC-29 derived key at output 0. */
async function makeToken(
  payer: TestWallet,
  payeeKey: string,
  satoshis: number,
  padBytes?: number
): Promise<{ token: PaymentToken; txid: string }> {
  const derivationPrefix = toBase64(randomBytes(32))
  const derivationSuffix = toBase64(randomBytes(32))
  const { publicKey } = await payer.wallet.getPublicKey({
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payeeKey
  })
  const { beef, txid } = makePaymentTx(PublicKey.fromString(publicKey), satoshis, { padBytes })
  return {
    token: {
      customInstructions: { derivationPrefix, derivationSuffix },
      transaction: beef,
      amount: satoshis,
      outputIndex: 0
    },
    txid
  }
}

function memorySeen(): SeenStore {
  const keys = new Set<string>()
  return {
    has: key => keys.has(key),
    add: key => {
      keys.add(key)
    }
  }
}

/** Handlers that accept every valid payment through `acceptDirectPayment`. */
function accepting(payee: TestWallet, seen?: SeenStore): ReceiveHandlers {
  return {
    onPayment: async p => {
      await acceptDirectPayment(payee.wallet, p, { seen })
      return 'accepted'
    }
  }
}

/** The WebRTPayError a promise rejects with; anything else fails the test. */
async function failure(p: Promise<unknown>): Promise<WebRTPayError> {
  try {
    await p
  } catch (e) {
    if (e instanceof WebRTPayError) return e
    throw e
  }
  throw new Error('Expected a rejection')
}

function closeOf(peer: AuthenticatedPeer): Promise<WebRTPayError | undefined> {
  return new Promise(resolve => peer.onClose(resolve))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry `fn` every 100 ms until it resolves, up to `attempts` tries. */
async function eventually<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= attempts) throw e
      await sleep(100)
    }
  }
}

/** An identity that listens on `hub` and never answers; resolves `heard` on the first signal. */
async function silentListener(hub: MemoryHub): Promise<{
  identityKey: string
  heard: Promise<void>
  stop: () => Promise<void>
}> {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
  let hear!: () => void
  const heard = new Promise<void>(resolve => (hear = resolve))
  const stop = await hub.signaler(identityKey).listen(() => hear())
  return { identityKey, heard, stop }
}

function key(): string {
  return PrivateKey.fromRandom().toPublicKey().toString()
}

// ---------------------------------------------------------------- inbound limiter

describe('InboundLimiter', () => {
  const T0 = 1_792_240_000_000
  const A = key()
  const B = key()

  it('defaults match the spec inbound limits', () => {
    expect(DEFAULT_INBOUND_LIMITS).toEqual({
      maxConcurrent: 3,
      offersPerMinute: 10,
      offersPerMinutePerSender: 3,
      maxMessageBytes: 16 * 1024 * 1024,
      idleTimeoutMs: 60000
    })
    expect(Object.isFrozen(DEFAULT_INBOUND_LIMITS)).toBe(true)
  })

  it('admits up to maxConcurrent sessions and frees a slot on release', () => {
    const l = new InboundLimiter(DEFAULT_INBOUND_LIMITS)
    expect([key(), key(), key()].map(k => l.tryAdmit(k, T0))).toEqual([true, true, true])
    expect(l.tryAdmit(A, T0)).toBe(false)
    l.release()
    expect(l.tryAdmit(A, T0)).toBe(true)
  })

  it('admits at most offersPerMinutePerSender from one sender per rolling minute', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 100 })
    for (let i = 0; i < 3; i++) expect(l.tryAdmit(A, T0 + i)).toBe(true)
    expect(l.tryAdmit(A, T0 + 10)).toBe(false)
    expect(l.tryAdmit(B, T0 + 10)).toBe(true)
    expect(l.tryAdmit(A, T0 + 59_999)).toBe(false)
    // the first admission (T0) is a minute old
    expect(l.tryAdmit(A, T0 + 60_000)).toBe(true)
    expect(l.tryAdmit(A, T0 + 60_000)).toBe(false)
  })

  it('admits at most offersPerMinute in total per rolling minute', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 100 })
    for (let i = 0; i < 10; i++) expect(l.tryAdmit(key(), T0 + i)).toBe(true)
    expect(l.tryAdmit(A, T0 + 1000)).toBe(false)
    expect(l.tryAdmit(A, T0 + 60_000)).toBe(true)
  })

  it('does not count refused offers against the sender or the total', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 1 })
    expect(l.tryAdmit(A, T0)).toBe(true)
    for (let i = 0; i < 20; i++) expect(l.tryAdmit(B, T0)).toBe(false)
    l.release()
    expect(l.tryAdmit(B, T0)).toBe(true)
  })

  it('never releases below zero', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 1 })
    l.release()
    l.release()
    expect(l.tryAdmit(A, T0)).toBe(true)
    expect(l.tryAdmit(B, T0)).toBe(false)
  })

  it('rejects invalid limits with RangeError', () => {
    const bad = [
      { maxConcurrent: 0 },
      { offersPerMinute: 1.5 },
      { offersPerMinutePerSender: -1 },
      { maxMessageBytes: 0 },
      { maxMessageBytes: Number.MAX_SAFE_INTEGER + 1 },
      { idleTimeoutMs: Number.NaN },
      { idleTimeoutMs: 0 },
      { idleTimeoutMs: 2 ** 31 }
    ]
    for (const b of bad) {
      expect(() => new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, ...b })).toThrow(RangeError)
    }
  })
})

// ---------------------------------------------------------------- remote payments

describe('DirectPayClient remote payments (MemoryHub, loopback WebRTC)', () => {
  it('full remote payment: acceptDirectPayment on the payee, ack accepted', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const contexts: Array<{ note?: string; txid: string }> = []
    const sessions: string[] = []
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving({
      onPayment: async (p, ctx) => {
        contexts.push(ctx)
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      },
      onSession: k => sessions.push(k)
    })
    expect(receiver.receiving).toBe(true)
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const peer = await sender.connect(payee.identityKey)
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
    expect(peer.localIdentityKey).toBe(payer.identityKey)
    const ack = await sender.sendPayment(peer, token, { note: 'lunch' })

    expect(ack).toEqual({ t: 'payment.ack', id: ack.id, status: 'accepted', txid })
    expect(ack.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(contexts).toEqual([{ note: 'lunch', txid }])
    expect(sessions).toEqual([payer.identityKey])
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
    const [args] = payee.internalizeAction.mock.calls[0]
    expect(args.outputs[0].paymentRemittance?.senderIdentityKey).toBe(payer.identityKey)
    // the payer ends the session once it has the ack (Ruling 21)
    await closeOf(peer)
    expect(await sender.getIdentityKey()).toBe(payer.identityKey)
  })

  it('connect to offline recipient rejects with peer_unreachable within budget', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const sender = hubClient(hub, payer)

    // nobody listening for that identity: the carrier refuses at once
    let started = Date.now()
    expect((await failure(sender.connect(key()))).code).toBe('peer_unreachable')
    expect(Date.now() - started).toBeLessThan(3000)

    // the carrier takes the offer but nobody answers: the budget (connectMs 3000) runs out
    const silent = await silentListener(hub)
    started = Date.now()
    const e = await failure(sender.connect(silent.identityKey))
    const elapsed = Date.now() - started
    expect(e.code).toBe('peer_unreachable')
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(elapsed).toBeLessThan(4500)
    await silent.stop()
  })

  it('receive disabled: peer_unreachable or rejected, and the payee creates no PeerLink', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    try {
      const hub = createMemoryHub()
      const payer = await makeWallet()
      const payee = await makeWallet()
      const sender = hubClient(hub, payer)
      const receiver = hubClient(hub, payee)
      expect(receiver.receiving).toBe(false)

      // not listening at all
      expect((await failure(sender.connect(payee.identityKey))).code).toBe('peer_unreachable')

      // listening only for the answer to its own dial
      const silent = await silentListener(hub)
      const ownDial = failure(receiver.connect(silent.identityKey, { timeoutMs: 2000 }))
      await silent.heard
      const refused = await failure(sender.connect(payee.identityKey))
      expect(refused.code).toBe('rejected')
      expect(refused.message).toContain('not_receiving')
      expect((await ownDial).code).toBe('peer_unreachable')
      await silent.stop()

      // receiving switched on and off again
      await receiver.startReceiving(accepting(payee))
      await receiver.stopReceiving()
      expect(receiver.receiving).toBe(false)
      expect((await failure(sender.connect(payee.identityKey))).code).toBe('peer_unreachable')

      expect(acceptOffer).not.toHaveBeenCalled()
    } finally {
      acceptOffer.mockRestore()
    }
  })

  it('limiter: 4th concurrent offer gets rejected with reason busy', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    try {
      const hub = createMemoryHub()
      const payee = await makeWallet()
      const receiver = hubClient(hub, payee)
      await receiver.startReceiving(accepting(payee))
      const senders = await Promise.all(
        [1, 2, 3, 4].map(async () => hubClient(hub, await makeWallet()))
      )

      const peers: AuthenticatedPeer[] = []
      for (const s of senders.slice(0, 3)) peers.push(await s.connect(payee.identityKey))
      const busy = await failure(senders[3].connect(payee.identityKey))
      expect(busy.code).toBe('rejected')
      expect(busy.message).toContain('busy')
      // refused without gathering ICE
      expect(acceptOffer).toHaveBeenCalledTimes(3)

      // a session that ends frees its slot
      peers[0].close()
      const peer = await eventually(() => senders[3].connect(payee.identityKey))
      expect(peer.peerIdentityKey).toBe(payee.identityKey)
    } finally {
      acceptOffer.mockRestore()
    }
  })

  it("payer gets 'closed' error and keeps token when payee drops after receiving", async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const received: IncomingPayment[] = []
    const first = hubClient(hub, payee)
    await first.startReceiving({
      onPayment: async p => {
        received.push(p)
        // the payee goes away after receiving, before it acks (Ruling 6)
        await first.close()
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1500)
    const before = JSON.stringify(token)

    const e = await failure(sender.sendPayment(await sender.connect(payee.identityKey), token))
    expect(e.code).toBe('closed')
    expect(received).toHaveLength(1)
    expect(received[0].sender).toBe(payer.identityKey)
    expect(payee.internalizeAction).not.toHaveBeenCalled()
    expect(JSON.stringify(token)).toBe(before)

    // the same token is delivered once the payee is back
    const second = hubClient(hub, payee)
    await second.startReceiving(accepting(payee, memorySeen()))
    const ack = await sender.sendPayment(await sender.connect(payee.identityKey), token)
    expect(ack).toMatchObject({ status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('second delivery of same token acks accepted once internalized once', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving(accepting(payee, memorySeen()))
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 2000)

    const first = await sender.sendPayment(await sender.connect(payee.identityKey), token)
    const second = await sender.sendPayment(await sender.connect(payee.identityKey), token)

    expect(first).toMatchObject({ status: 'accepted', txid })
    expect(second).toMatchObject({ status: 'accepted', txid })
    expect(second.id).not.toBe(first.id)
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('2 MiB transaction payload delivered (chunking end to end)', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving(accepting(payee))
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 5000, 2 * 1024 * 1024)
    expect(token.transaction.length).toBeGreaterThan(2 * 1024 * 1024)

    const ack = await sender.sendPayment(await sender.connect(payee.identityKey), token)

    expect(ack).toMatchObject({ status: 'accepted', txid })
    const [args] = payee.internalizeAction.mock.calls[0]
    expect(toBase64(Uint8Array.from(args.tx))).toBe(toBase64(Uint8Array.from(token.transaction)))
  })

  it('acks rejected with a reason for an invalid payment or a refusing handler', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const handled: number[] = []
    const receiver = hubClient(hub, payee, { limits: { offersPerMinutePerSender: 10 } })
    await receiver.startReceiving({
      onPayment: async p => {
        handled.push(p.token.amount)
        if (p.token.amount === 777) return { status: 'rejected', reason: 'x'.repeat(600) }
        if (p.token.amount === 778) throw new Error('database is locked at /home/someone')
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const pay = async (token: PaymentToken) =>
      sender.sendPayment(await sender.connect(payee.identityKey), token)

    // decodePayment refuses it before the handler sees it
    const { token: valid } = await makeToken(payer, payee.identityKey, 1000)
    const zero = await pay({ ...valid, amount: 0 })
    expect(zero).toMatchObject({ status: 'rejected', reason: expect.any(String) })
    expect(zero.reason!.length).toBeGreaterThan(0)
    expect(handled).toEqual([])

    // the output pays a key derived for someone else: acceptDirectPayment throws invalid_payment
    const stranger = await makeWallet()
    const { token: misdirected } = await makeToken(payer, stranger.identityKey, 1000)
    const wrong = await pay(misdirected)
    expect(wrong).toMatchObject({ status: 'rejected' })
    expect(wrong.reason).toContain('does not pay')

    // the handler's own rejection, cut to the 500 characters an ack may carry
    const { token: refused } = await makeToken(payer, payee.identityKey, 777)
    const own = await pay(refused)
    expect(own).toMatchObject({ status: 'rejected', reason: 'x'.repeat(500) })

    // an unexpected handler error is not passed on to the payer
    const { token: failing } = await makeToken(payer, payee.identityKey, 778)
    const hidden = await pay(failing)
    expect(hidden.status).toBe('rejected')
    expect(hidden.reason).not.toContain('/home/someone')

    expect(handled).toEqual([1000, 777, 778])
    expect(payee.internalizeAction).not.toHaveBeenCalled()
  })

  it('hands payment requests to onPaymentRequest with the proof checked', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const requests: Array<IncomingPaymentRequest & { proofValid: boolean }> = []
    let gotTwo!: () => void
    const two = new Promise<void>(resolve => (gotTwo = resolve))
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving({
      ...accepting(payee),
      onPaymentRequest: async r => {
        requests.push(r)
        if (requests.length === 2) gotTwo()
      }
    })
    const sender = hubClient(hub, payer)
    const peer = await sender.connect(payee.identityKey)
    const proof = await createPaymentRequestProof(payer.wallet, 'req-1', payee.identityKey)
    const base = {
      senderIdentityKey: payer.identityKey,
      amount: 2500,
      description: 'Invoice 7',
      expiresAt: Date.now() + 60000,
      requestProof: proof
    }

    await peer.send({ t: 'request', request: { ...base, requestId: 'req-1' } })
    // a proof made for another request ID does not verify
    await peer.send({ t: 'request', request: { ...base, requestId: 'req-2' } })
    // cancellations are not handed on
    await peer.send({
      t: 'request',
      request: {
        requestId: 'req-1',
        senderIdentityKey: payer.identityKey,
        requestProof: proof,
        cancelled: true
      }
    })
    await two

    const common = {
      sender: payer.identityKey,
      amount: 2500,
      description: 'Invoice 7',
      expiresAt: base.expiresAt
    }
    expect(requests).toEqual([
      { ...common, messageId: expect.any(String), requestId: 'req-1', proofValid: true },
      { ...common, messageId: expect.any(String), requestId: 'req-2', proofValid: false }
    ])

    // a request in another identity's name ends the session
    await peer.send({
      t: 'request',
      request: { ...base, senderIdentityKey: key(), requestId: 'r' }
    })
    await closeOf(peer)
    expect(requests).toHaveLength(2)
  })

  it('closes an idle inbound session and frees its slot', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee, { limits: { idleTimeoutMs: 300, maxConcurrent: 1 } })
    await receiver.startReceiving(accepting(payee))
    const sender = hubClient(hub, payer)

    const started = Date.now()
    const peer = await sender.connect(payee.identityKey)
    expect((await closeOf(peer))?.code).toBe('closed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)

    const again = await sender.connect(payee.identityKey)
    expect(again.peerIdentityKey).toBe(payee.identityKey)
  })

  it('sendPayment rejects timeout and closes the session when no ack comes', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving({
      onPayment: async () => {
        await held
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const { token } = await makeToken(payer, payee.identityKey, 1000)
    const peer = await sender.connect(payee.identityKey)

    const e = await failure(sender.sendPayment(peer, token, { timeoutMs: 500 }))

    expect(e.code).toBe('timeout')
    expect((await closeOf(peer))?.code).toBe('timeout')
    release()
  })

  it('marks the signaler active while dialing and listens only while needed', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const a = await silentListener(hub)
    const b = await silentListener(hub)
    const base = hub.signaler(payer.identityKey)
    const active: boolean[] = []
    let listens = 0
    let listening = 0
    const signaler: Signaler = {
      send: (to, e) => base.send(to, e),
      listen: async fn => {
        listens++
        listening++
        const stop = await base.listen(fn)
        return async () => {
          listening--
          await stop()
        }
      },
      setActive: v => {
        active.push(v)
      }
    }
    const sender = client(payer, { signaler })

    const codes = await Promise.all([
      failure(sender.connect(a.identityKey, { timeoutMs: 800 })),
      failure(sender.connect(b.identityKey, { timeoutMs: 1200 }))
    ])

    expect(codes.map(e => e.code)).toEqual(['peer_unreachable', 'peer_unreachable'])
    expect(active).toEqual([true, false])
    expect(listens).toBe(1)
    // stopReceiving queues behind the pending unsubscribe, so it has run by now
    await sender.stopReceiving()
    expect(listening).toBe(0)
    await a.stop()
    await b.stop()
  })

  it('ignores an answer to a dial from anyone but the recipient', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const intruder = await makeWallet()
    const silent = await silentListener(hub)
    const base = hub.signaler(payer.identityKey)
    let sid = ''
    let sent!: () => void
    const offered = new Promise<void>(resolve => (sent = resolve))
    const signaler: Signaler = {
      send: async (to, e) => {
        sid = e.sid
        sent()
        await base.send(to, e)
      },
      listen: fn => base.listen(fn)
    }
    const sender = client(payer, { signaler })
    const dial = failure(sender.connect(silent.identityKey, { timeoutMs: 1000 }))
    await offered

    // the sid travels in the clear, so whoever sees the envelope can answer with it
    const forged = await sealSignal(intruder.wallet, {
      v: 1,
      kind: 'answer',
      sid,
      from: intruder.identityKey,
      to: payer.identityKey,
      ts: Date.now(),
      purpose: 'payment',
      sdp: 'v=0\r\n'
    })
    await hub.signaler(intruder.identityKey).send(payer.identityKey, forged)

    expect((await dial).code).toBe('peer_unreachable')
    await silent.stop()
  })

  it('close() ends a pending dial with closed and refuses new work', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const silent = await silentListener(hub)
    const sender = hubClient(hub, payer)
    const dial = failure(sender.connect(silent.identityKey, { timeoutMs: 10000 }))
    await silent.heard

    const started = Date.now()
    await sender.close()

    expect((await dial).code).toBe('closed')
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await failure(sender.connect(silent.identityKey))).code).toBe('closed')
    expect((await failure(sender.startReceiving(accepting(await makeWallet())))).code).toBe(
      'closed'
    )
    expect((await failure(sender.createOfferCode({ chain: 'test' }))).code).toBe('closed')
    await silent.stop()
  })

  it('needs a signaler, an identity key and a valid timeout to dial', async () => {
    const w = await makeWallet()
    const c = client(w)
    expect((await failure(c.connect(key()))).code).toBe('unsupported')
    expect((await failure(c.startReceiving(accepting(w)))).code).toBe('unsupported')
    expect(c.receiving).toBe(false)
    const withSignaler = hubClient(createMemoryHub(), w)
    await expect(withSignaler.connect('not a key')).rejects.toThrow(TypeError)
    await expect(withSignaler.connect(key(), { timeoutMs: 0 })).rejects.toThrow(RangeError)
  })
})

// ---------------------------------------------------------------- code exchange

describe('DirectPayClient code exchange (no signaler)', () => {
  it('code exchange: offer code, answer code, payment delivered and acked', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = client(payee)
    const sender = client(payer)
    const sessions: string[] = []

    const offer = await receiver.createOfferCode({
      chain: 'test',
      amount: 1000,
      handlers: { ...accepting(payee), onSession: k => sessions.push(k) }
    })
    expect(offer.code.startsWith('webrtpay1:')).toBe(true)
    expect(offer.sid).toBe(toBase64Url(decodeCode(offer.code).sid))
    expect(offer.sid).toMatch(/^[A-Za-z0-9_-]{22}$/)

    const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'test' })
    expect(answer.offer).toMatchObject({
      kind: 'offer',
      identityKey: payee.identityKey,
      chain: 'test',
      amount: 1000
    })
    expect(decodeCode(answer.answerCode)).toMatchObject({
      kind: 'answer',
      identityKey: payer.identityKey
    })

    const [payeeSide, payerSide] = await Promise.all([
      offer.complete(answer.answerCode),
      answer.connected
    ])
    expect(payeeSide.peerIdentityKey).toBe(payer.identityKey)
    expect(payerSide.peerIdentityKey).toBe(payee.identityKey)

    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)
    const ack = await sender.sendPayment(payerSide, token)
    expect(ack).toMatchObject({ status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
    expect(sessions).toEqual([payer.identityKey])
  })

  it('uses the receive handlers when createOfferCode is given none', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving(accepting(payee))
    const sender = client(payer)

    const offer = await receiver.createOfferCode({ chain: 'main', expiresInMs: 120000 })
    const decoded = decodeCode(offer.code)
    expect(decoded.kind === 'offer' ? decoded.expiresAt : 0).toBeGreaterThan(Date.now() + 100000)
    const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'main' })
    const [, payerSide] = await Promise.all([offer.complete(answer.answerCode), answer.connected])
    const { token } = await makeToken(payer, payee.identityKey, 1200)

    expect((await sender.sendPayment(payerSide, token)).status).toBe('accepted')
  })

  it('refuses a wrong network, swapped code kinds, a foreign answer and missing handlers', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = client(payee)
    const sender = client(payer)
    const offer = await receiver.createOfferCode({ chain: 'test' })

    expect(
      (await failure(sender.answerOfferCode(offer.code, { expectedChain: 'main' }))).code
    ).toBe('invalid_code')
    const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'test' })
    expect((await failure(sender.answerOfferCode(answer.answerCode))).code).toBe('invalid_code')

    const foreign = encodeAnswerCode({
      sid: randomBytes(16),
      identityKey: payer.identityKey,
      sdp: decodeCode(answer.answerCode).sdp
    })
    expect((await failure(offer.complete(foreign))).code).toBe('invalid_code')
    expect((await failure(offer.complete(offer.code))).code).toBe('invalid_code')
    // no handlers passed and not receiving
    expect((await failure(offer.complete(answer.answerCode))).code).toBe('unsupported')

    answer.cancel()
    offer.cancel()
    expect((await failure(answer.connected)).code).toBe('closed')
  })

  it('takes the network from the client options and needs one for an offer', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    await expect(client(payee).createOfferCode()).rejects.toThrow(TypeError)

    const offer = await client(payee, { chain: 'main' }).createOfferCode()
    expect(decodeCode(offer.code)).toMatchObject({ kind: 'offer', chain: 'main' })
    // the client's own network is the default expectedChain
    const e = await failure(client(payer, { chain: 'test' }).answerOfferCode(offer.code))
    expect(e.code).toBe('invalid_code')
    offer.cancel()
  })

  it('builds links with the RTC options given to updateRtc', async () => {
    const payee = await makeWallet()
    const c = client(payee, { chain: 'test' })
    let constructed = 0
    const Base = rtc.RTCPeerConnection
    class Counting extends Base {
      constructor(config?: RTCConfiguration) {
        super(config)
        constructed++
      }
    }
    c.updateRtc({ ...rtc, RTCPeerConnection: Counting })

    const offer = await c.createOfferCode()

    expect(constructed).toBe(1)
    offer.cancel()
  })
})
