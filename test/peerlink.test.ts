import { afterAll, afterEach, describe, expect, it } from '@jest/globals'
import { FrameDecoder } from '../src/channel/frames.js'
import { PeerLink } from '../src/channel/PeerLink.js'
import type { PeerLinkOptions } from '../src/channel/PeerLink.js'
import { sdpFingerprints } from '../src/codec/sdp.js'
import { CHANNEL_LABEL } from '../src/types.js'
import { WebRTPayError } from '../src/util/errors.js'
import { cleanupRtc, nodeRtc } from './helpers/rtc.js'

// File scope so a filtered run (-t) still releases node-datachannel's native threads.
afterAll(cleanupRtc)

/** Every link a test opened; closed after each test so no peer outlives it. */
const liveLinks: PeerLink[] = []
const rawPeers: RTCPeerConnection[] = []

afterEach(() => {
  for (const link of liveLinks.splice(0)) link.close()
  for (const pc of rawPeers.splice(0)) pc.close()
})

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

function track(link: PeerLink): PeerLink {
  liveLinks.push(link)
  return link
}

/** Connect an offerer A and an answerer B over loopback and wait for both to open. */
async function connectPair(
  a: Partial<PeerLinkOptions> = {},
  b: Partial<PeerLinkOptions> = {}
): Promise<{ a: PeerLink; b: PeerLink; offer: string; answer: string }> {
  const rtc = await nodeRtc()
  const offered = await PeerLink.createOffer({ ...rtc, ...a })
  track(offered.link)
  const answered = await PeerLink.acceptOffer(offered.sdp, { ...rtc, ...b })
  track(answered.link)
  await offered.link.acceptAnswer(answered.sdp)
  await Promise.all([offered.link.waitOpen(10000), answered.link.waitOpen(10000)])
  return { a: offered.link, b: answered.link, offer: offered.sdp, answer: answered.sdp }
}

function nextMessage(link: PeerLink, ms = 10000): Promise<unknown> {
  return withTimeout(
    new Promise<unknown>(resolve => {
      const off = link.onMessage(m => {
        off()
        resolve(m)
      })
    }),
    ms,
    'message'
  )
}

function closeOf(link: PeerLink, ms = 10000): Promise<WebRTPayError | undefined> {
  return withTimeout(
    new Promise<WebRTPayError | undefined>(resolve => link.onClose(resolve)),
    ms,
    'close'
  )
}

/** Deterministic text that any reordering, loss or duplication of a chunk would change. */
function patterned(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let x = 0x9e3779b9
  let out = ''
  for (let i = 0; i < length; i++) {
    x = (x ^ (x << 13)) >>> 0
    x = (x ^ (x >>> 17)) >>> 0
    x = (x ^ (x << 5)) >>> 0
    out += alphabet[x & 63]
  }
  return out
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  return withTimeout(
    new Promise<void>(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve()
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve()
      })
    }),
    5000,
    'ICE gathering'
  )
}

describe('PeerLink over loopback', () => {
  it('connects two links and exchanges a message both ways', async () => {
    const { a, b } = await connectPair()
    expect(a.isOpen).toBe(true)
    expect(b.isOpen).toBe(true)

    const atB = nextMessage(b)
    await a.send({ a: 1 })
    expect(await atB).toEqual({ a: 1 })

    const atA = nextMessage(a)
    await b.send({ a: 1 })
    expect(await atA).toEqual({ a: 1 })
  })

  it('delivers several messages in order', async () => {
    const { a, b } = await connectPair()
    const got: unknown[] = []
    const all = withTimeout(
      new Promise<void>(resolve => {
        b.onMessage(m => {
          got.push(m)
          if (got.length === 5) resolve()
        })
      }),
      10000,
      'five messages'
    )
    // Not awaited one by one: concurrent sends must not interleave their frames.
    await Promise.all([0, 1, 2, 3, 4].map(n => a.send({ n, pad: 'x'.repeat(n * 20000) })))
    await all
    expect(got.map(m => (m as { n: number }).n)).toEqual([0, 1, 2, 3, 4])
  })

  it('delivers a 3 MiB message intact', async () => {
    const { a, b } = await connectPair()
    const text = patterned(3 * 1024 * 1024)
    const atB = nextMessage(b, 30000)
    await a.send({ text })
    const got = (await atB) as { text: string }
    expect(got.text.length).toBe(text.length)
    expect(got.text === text).toBe(true)
  })

  it('never hands the channel a frame while more than 1 MiB is queued', async () => {
    const rtc = await nodeRtc()
    // Record the queue depth each time the offerer's channel is given a frame.
    const queuedBeforeSend: number[] = []
    let lowThreshold = -1
    class SpyPeerConnection extends rtc.RTCPeerConnection {
      createDataChannel(label: string, init?: RTCDataChannelInit): RTCDataChannel {
        const channel = super.createDataChannel(label, init)
        const send = channel.send.bind(channel) as (data: Uint8Array) => void
        channel.send = ((data: Uint8Array) => {
          lowThreshold = channel.bufferedAmountLowThreshold
          queuedBeforeSend.push(channel.bufferedAmount)
          send(data)
        }) as RTCDataChannel['send']
        return channel
      }
    }
    const { a, b } = await connectPair({ RTCPeerConnection: SpyPeerConnection })
    const atB = nextMessage(b, 30000)
    await a.send({ text: patterned(3 * 1024 * 1024) })
    await atB

    expect(lowThreshold).toBe(256 * 1024)
    expect(queuedBeforeSend.length).toBeGreaterThan(190)
    // Without the wait, loopback queues about 2 MiB here.
    expect(Math.max(...queuedBeforeSend)).toBeLessThanOrEqual(1024 * 1024)
  })

  it('rejects waitOpen with timeout when the answer is never applied', async () => {
    const rtc = await nodeRtc()
    const { link } = await PeerLink.createOffer(rtc)
    track(link)
    const started = Date.now()
    await expect(link.waitOpen(2000)).rejects.toMatchObject({
      name: 'WebRTPayError',
      code: 'timeout'
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900)
    expect(link.isOpen).toBe(false)
  })

  it("reports A's local fingerprints as B's remote ones and the reverse", async () => {
    const { a, b, offer, answer } = await connectPair()
    expect(a.localFingerprints()).toEqual(sdpFingerprints(offer))
    expect(b.localFingerprints()).toEqual(sdpFingerprints(answer))
    expect(a.localFingerprints()).toEqual(b.remoteFingerprints())
    expect(b.localFingerprints()).toEqual(a.remoteFingerprints())
    expect(a.localFingerprints()).not.toEqual(a.remoteFingerprints())
    expect(a.localFingerprints()[0]).toMatch(/^sha-256 [0-9a-f]{64}$/)
  })

  it("fires B's onClose once within 10 s when A closes", async () => {
    const { a, b } = await connectPair()
    let calls = 0
    b.onClose(() => calls++)
    const bClosed = closeOf(b)
    const aClosed = closeOf(a)

    a.close()
    expect(await aClosed).toBeUndefined()
    const err = await bClosed
    expect(err).toBeInstanceOf(WebRTPayError)
    expect(err?.code).toBe('closed')
    expect(b.isOpen).toBe(false)
    expect(a.isOpen).toBe(false)

    // The data channel and the peer connection both report the close; one call only.
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(calls).toBe(1)
  })

  it('closes the receiver with protocol when the peer sends a malformed frame', async () => {
    const { a, b } = await connectPair()
    const bClosed = closeOf(b)
    a._sendRaw(new Uint8Array([9]))
    const err = await bClosed
    expect(err).toBeInstanceOf(WebRTPayError)
    expect(err?.code).toBe('protocol')
    expect(b.isOpen).toBe(false)
    // The receiver tears the connection down, so the sender learns of it too.
    expect((await closeOf(a))?.code).toBe('closed')
  })

  it('closes the receiver with protocol when the peer sends text', async () => {
    const { a, b } = await connectPair()
    const bClosed = closeOf(b)
    a._sendRaw('{"a":1}')
    expect((await bClosed)?.code).toBe('protocol')
  })

  it('applies setMaxMessageBytes to the messages that follow', async () => {
    const { a, b } = await connectPair({}, { maxMessageBytes: 1024 })
    b.setMaxMessageBytes(128 * 1024)
    const big = nextMessage(b)
    await a.send({ s: 'x'.repeat(64 * 1024) })
    expect(((await big) as { s: string }).s.length).toBe(64 * 1024)

    b.setMaxMessageBytes(1024)
    const bClosed = closeOf(b)
    await a.send({ s: 'x'.repeat(2048) })
    expect((await bClosed)?.code).toBe('too_large')
  })

  it('rejects setMaxMessageBytes with a value that is not a size', async () => {
    const { b } = await connectPair()
    expect(() => b.setMaxMessageBytes(-1)).toThrow(RangeError)
    expect(() => b.setMaxMessageBytes(1.5)).toThrow(RangeError)
  })

  it('rejects send with closed once the link is closed', async () => {
    const { a } = await connectPair()
    a.close(new WebRTPayError('timeout', 'idle'))
    expect(a.isOpen).toBe(false)
    await expect(a.send({ a: 1 })).rejects.toMatchObject({ code: 'timeout' })
  })

  it('rejects send before the channel opens', async () => {
    const rtc = await nodeRtc()
    const { link } = await PeerLink.createOffer(rtc)
    track(link)
    await expect(link.send({ a: 1 })).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects a pending waitOpen with the close reason', async () => {
    const rtc = await nodeRtc()
    const { link } = await PeerLink.createOffer(rtc)
    track(link)
    const waiting = link.waitOpen(10000)
    link.close(new WebRTPayError('rejected', 'peer declined'))
    await expect(waiting).rejects.toMatchObject({ code: 'rejected' })
    await expect(link.waitOpen(10000)).rejects.toMatchObject({ code: 'rejected' })
  })

  it('calls an onClose registered after the close with the same reason', async () => {
    const { a } = await connectPair()
    const reason = new WebRTPayError('protocol', 'bad peer')
    a.close(reason)
    a.close(new WebRTPayError('timeout'))
    expect(await closeOf(a)).toBe(reason)
  })

  it('isolates a throwing message listener from the link and other listeners', async () => {
    const { a, b } = await connectPair()
    b.onMessage(() => {
      throw new Error('listener bug')
    })
    const atB = nextMessage(b)
    await a.send({ ok: true })
    expect(await atB).toEqual({ ok: true })
    expect(b.isOpen).toBe(true)
  })

  it('closes with protocol when the offerer opens a channel with another label', async () => {
    const rtc = await nodeRtc()
    const pc = new rtc.RTCPeerConnection({ iceServers: rtc.iceServers, ...rtc.extraConfig })
    rawPeers.push(pc)
    pc.createDataChannel(`${CHANNEL_LABEL}-other`)
    await pc.setLocalDescription(await pc.createOffer())
    await gathered(pc)

    const { link, sdp } = await PeerLink.acceptOffer(pc.localDescription!.sdp, rtc)
    track(link)
    const closed = closeOf(link)
    await pc.setRemoteDescription({ type: 'answer', sdp })
    expect((await closed)?.code).toBe('protocol')
  })

  it('rejects acceptOffer with protocol for an SDP the peer connection refuses', async () => {
    const rtc = await nodeRtc()
    await expect(PeerLink.acceptOffer('not an sdp', rtc)).rejects.toMatchObject({
      code: 'protocol'
    })
  })

  it('rejects a second acceptAnswer with protocol', async () => {
    const { a, answer } = await connectPair()
    await expect(a.acceptAnswer(answer)).rejects.toMatchObject({ code: 'protocol' })
  })

  it('rejects with unsupported when no RTCPeerConnection is available', async () => {
    expect(globalThis.RTCPeerConnection).toBeUndefined()
    await expect(PeerLink.createOffer({})).rejects.toMatchObject({ code: 'unsupported' })
  })
})

/** A data channel whose queue depth the test controls. */
class FakeChannel extends EventTarget {
  readonly label = CHANNEL_LABEL
  readonly ordered = true
  readonly maxRetransmits = null
  readonly maxPacketLifeTime = null
  binaryType = 'blob'
  bufferedAmountLowThreshold = 0
  bufferedAmount = 0
  readyState: RTCDataChannelState = 'connecting'
  readonly sent: Uint8Array[] = []

  send(data: Uint8Array): void {
    this.sent.push(data)
    this.bufferedAmount += data.byteLength
  }

  close(): void {}

  open(): void {
    this.readyState = 'open'
    this.dispatchEvent(new Event('open'))
  }

  drain(): void {
    this.bufferedAmount = 0
    this.dispatchEvent(new Event('bufferedamountlow'))
  }
}

/** Just enough of RTCPeerConnection for an offerer link, with no network. */
class FakePeerConnection extends EventTarget {
  static last: FakePeerConnection | undefined
  readonly channel = new FakeChannel()
  readonly config: RTCConfiguration
  readonly channelInit: (RTCDataChannelInit | undefined)[] = []
  connectionState: RTCPeerConnectionState = 'new'
  iceGatheringState: RTCIceGatheringState = 'complete'
  localDescription = { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n' }

  constructor(config: RTCConfiguration) {
    super()
    this.config = config
    FakePeerConnection.last = this
  }

  createDataChannel(_label: string, init?: RTCDataChannelInit): FakeChannel {
    this.channelInit.push(init)
    return this.channel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'offer', sdp: this.localDescription.sdp }
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: 'answer', sdp: this.localDescription.sdp }
  }

  async setLocalDescription(): Promise<void> {}

  async setRemoteDescription(): Promise<void> {}

  close(): void {
    this.connectionState = 'closed'
  }
}

async function fakeOfferer(
  o: Partial<PeerLinkOptions> = {}
): Promise<{ link: PeerLink; pc: FakePeerConnection }> {
  const { link } = await PeerLink.createOffer({
    RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection,
    ...o
  })
  return { link, pc: FakePeerConnection.last! }
}

const FAKE_OFFER = 'v=0\r\na=fingerprint:sha-256 EF:01\r\n'

async function fakeAnswerer(): Promise<{ link: PeerLink; pc: FakePeerConnection }> {
  const { link } = await PeerLink.acceptOffer(FAKE_OFFER, {
    RTCPeerConnection: FakePeerConnection as unknown as typeof RTCPeerConnection
  })
  return { link, pc: FakePeerConnection.last! }
}

function announce(pc: FakePeerConnection, channel: FakeChannel): void {
  pc.dispatchEvent(Object.assign(new Event('datachannel'), { channel }))
}

function tick(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

describe('PeerLink with a fake peer connection', () => {
  it('builds the configuration from the options and creates an ordered reliable channel', async () => {
    const iceServers = [{ urls: 'turn:turn.example:3478', username: 'u', credential: 'c' }]
    const { link, pc } = await fakeOfferer({
      iceServers,
      iceTransportPolicy: 'relay',
      extraConfig: { bindAddress: '127.0.0.1' }
    })
    expect(pc.config).toEqual({
      bindAddress: '127.0.0.1',
      iceServers,
      iceTransportPolicy: 'relay'
    })
    // Copied, so an implementation that normalises it in place cannot change the caller's.
    expect(pc.config.iceServers![0]).not.toBe(iceServers[0])
    expect(pc.channelInit).toEqual([{ ordered: true }])
    expect(pc.channel.binaryType).toBe('arraybuffer')
    expect(pc.channel.bufferedAmountLowThreshold).toBe(256 * 1024)
    expect(link.localFingerprints()).toEqual(['sha-256 abcd'])
    expect(link.remoteFingerprints()).toEqual([])
    link.close()

    const plain = await fakeOfferer()
    expect(plain.pc.config).toEqual({ iceServers: [] })
    plain.link.close()
  })

  it('holds frames while more than 1 MiB is queued and resumes on bufferedamountlow', async () => {
    const { link, pc } = await fakeOfferer({ chunkBytes: 1024 })
    pc.channel.open()
    pc.channel.bufferedAmount = 1024 * 1024 + 1
    const message = { s: 'x'.repeat(3000) }
    let done = false
    const sending = link.send(message).then(() => {
      done = true
    })
    await tick()
    expect(pc.channel.sent).toHaveLength(0)
    expect(done).toBe(false)

    pc.channel.drain()
    await sending
    expect(pc.channel.sent.length).toBe(3)
    const decoder = new FrameDecoder({ maxMessageBytes: 1 << 20 })
    expect(pc.channel.sent.map(f => decoder.push(f)).filter(m => m !== undefined)).toEqual([
      message
    ])
    link.close()
  })

  it('keeps a later send behind one waiting for the queue, even once there is room', async () => {
    const { link, pc } = await fakeOfferer({ chunkBytes: 1024 })
    pc.channel.open()
    pc.channel.bufferedAmount = 2 * 1024 * 1024
    const first = { s: 'a'.repeat(3000) }
    const sendingFirst = link.send(first)
    await tick()
    // The queue drained below 1 MiB but has not yet reached the low-water mark.
    pc.channel.bufferedAmount = 512 * 1024
    const sendingSecond = link.send({ b: 2 })
    await tick()
    expect(pc.channel.sent).toHaveLength(0)

    pc.channel.drain()
    await Promise.all([sendingFirst, sendingSecond])
    const decoder = new FrameDecoder({ maxMessageBytes: 1 << 20 })
    expect(pc.channel.sent.map(f => decoder.push(f)).filter(m => m !== undefined)).toEqual([
      first,
      { b: 2 }
    ])
    link.close()
  })

  it('sends a frame when exactly 1 MiB is queued', async () => {
    const { link, pc } = await fakeOfferer()
    pc.channel.open()
    pc.channel.bufferedAmount = 1024 * 1024
    await link.send({ a: 1 })
    expect(pc.channel.sent).toHaveLength(1)
    link.close()
  })

  it('rejects a send waiting for the queue with the close reason', async () => {
    const { link, pc } = await fakeOfferer()
    pc.channel.open()
    pc.channel.bufferedAmount = 2 * 1024 * 1024
    const first = link.send({ a: 1 })
    const second = link.send({ a: 2 })
    await tick()
    link.close(new WebRTPayError('timeout', 'idle'))
    await expect(first).rejects.toMatchObject({ code: 'timeout' })
    await expect(second).rejects.toMatchObject({ code: 'timeout' })
    expect(pc.channel.sent).toHaveLength(0)
  })

  it('closes once with closed when the connection fails', async () => {
    const { link, pc } = await fakeOfferer()
    pc.channel.open()
    const reasons: (WebRTPayError | undefined)[] = []
    link.onClose(e => reasons.push(e))
    pc.connectionState = 'failed'
    pc.dispatchEvent(new Event('connectionstatechange'))
    pc.channel.dispatchEvent(new Event('close'))
    expect(reasons).toHaveLength(1)
    expect(reasons[0]?.code).toBe('closed')
    expect(link.isOpen).toBe(false)
  })

  it('ignores the transient disconnected state', async () => {
    const { link, pc } = await fakeOfferer()
    pc.channel.open()
    pc.connectionState = 'disconnected'
    pc.dispatchEvent(new Event('connectionstatechange'))
    expect(link.isOpen).toBe(true)
    link.close()
  })

  it('closes with closed when the channel refuses a frame', async () => {
    const { link, pc } = await fakeOfferer()
    pc.channel.open()
    pc.channel.send = () => {
      throw new DOMException('queue full', 'OperationError')
    }
    const closed = closeOf(link)
    await expect(link.send({ a: 1 })).rejects.toMatchObject({ code: 'closed' })
    expect((await closed)?.code).toBe('closed')
  })

  it('opens an answerer whose channel is already open when it is announced', async () => {
    const { link, pc } = await fakeAnswerer()
    expect(link.remoteFingerprints()).toEqual(['sha-256 ef01'])
    expect(link.localFingerprints()).toEqual(['sha-256 abcd'])
    pc.channel.readyState = 'open'
    announce(pc, pc.channel)
    await link.waitOpen(100)
    expect(link.isOpen).toBe(true)
    expect(pc.channel.binaryType).toBe('arraybuffer')
    link.close()
  })

  it('closes with protocol when the answerer is offered a second channel', async () => {
    const { link, pc } = await fakeAnswerer()
    announce(pc, pc.channel)
    pc.channel.open()
    const closed = closeOf(link)
    announce(pc, new FakeChannel())
    expect((await closed)?.code).toBe('protocol')
  })

  it('closes with protocol when the answerer is offered an unreliable channel', async () => {
    const { link, pc } = await fakeAnswerer()
    const closed = closeOf(link)
    const lossy = Object.assign(new FakeChannel(), { maxRetransmits: 3 })
    announce(pc, lossy)
    expect((await closed)?.code).toBe('protocol')
  })

  it('closes with protocol when the offerer is offered a channel', async () => {
    const { link, pc } = await fakeOfferer()
    const closed = closeOf(link)
    announce(pc, new FakeChannel())
    expect((await closed)?.code).toBe('protocol')
  })

  it('rejects acceptAnswer on an answerer', async () => {
    const { link } = await fakeAnswerer()
    await expect(link.acceptAnswer(FAKE_OFFER)).rejects.toMatchObject({ code: 'protocol' })
    link.close()
  })

  it('rejects options that cannot frame or cap a message', async () => {
    await expect(fakeOfferer({ chunkBytes: 6 })).rejects.toThrow(RangeError)
    await expect(fakeOfferer({ maxMessageBytes: -1 })).rejects.toThrow(RangeError)
    expect(FakePeerConnection.last!.connectionState).toBe('closed')
  })
})
