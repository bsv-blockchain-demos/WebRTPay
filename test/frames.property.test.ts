import { describe, expect, it } from '@jest/globals'
import fc from 'fast-check'
import { FRAME_HEADER_BYTES, FrameDecoder, encodeMessage } from '../src/channel/frames.js'
import { DEFAULTS } from '../src/types.js'
import { utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

// Graphemes only: a lone surrogate would not survive stringify -> UTF-8 -> parse.
const text = fc.string({ unit: 'grapheme', maxLength: 40 })
const message = fc.object({
  key: text,
  values: [
    text,
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.constant(null)
  ],
  maxDepth: 3,
  maxKeys: 6
})
const chunkSize = fc.oneof(
  fc.integer({ min: FRAME_HEADER_BYTES + 1, max: 64 }),
  fc.constant(DEFAULTS.chunkBytes)
)

/** What the receiver should see: the JSON round trip normalises -0 and similar. */
function normalised(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value))
}

function seqOf(frame: Uint8Array): number {
  return new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false)
}

/** Push every frame; return what came out or the error that stopped the stream. */
function run(
  decoder: FrameDecoder,
  frames: Uint8Array[]
): { messages: unknown[]; error?: WebRTPayError; at?: number } {
  const messages: unknown[] = []
  for (let i = 0; i < frames.length; i++) {
    try {
      const m = decoder.push(frames[i])
      if (m !== undefined) messages.push(m)
    } catch (e) {
      // Anything but a WebRTPayError is a bug in the decoder: let it fail the property.
      if (!(e instanceof WebRTPayError)) throw e
      return { messages, error: e, at: i }
    }
  }
  return { messages }
}

function isPlainObject(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

describe('frames: round trips', () => {
  it('random message sequences survive chunking and reassembly in order', () => {
    fc.assert(
      fc.property(
        fc.array(message, { minLength: 1, maxLength: 6 }),
        chunkSize,
        (messages, chunk) => {
          const decoder = new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes })
          const all: Uint8Array[] = []
          messages.forEach((m, seq) => {
            const frames = encodeMessage(seq, m, chunk)
            const length = utf8Encode(JSON.stringify(m)).length
            expect(frames).toHaveLength(Math.ceil(length / (chunk - FRAME_HEADER_BYTES)))
            frames.forEach((f, i) => {
              expect(f.length).toBeLessThanOrEqual(chunk)
              expect(f[0]).toBe(1)
              expect(f[1]).toBe(i === frames.length - 1 ? 1 : 0)
              expect(seqOf(f)).toBe(seq)
            })
            all.push(...frames)
          })
          const result = run(decoder, all)
          expect(result.error).toBeUndefined()
          expect(result.messages).toEqual(messages.map(normalised))
        }
      )
    )
  })

  it('a stream starting at any sequence number other than 0 is a protocol error', () => {
    fc.assert(
      fc.property(message, fc.integer({ min: 1, max: 0xffffffff }), chunkSize, (m, seq, chunk) => {
        const result = run(
          new FrameDecoder({ maxMessageBytes: DEFAULTS.maxMessageBytes }),
          encodeMessage(seq, m, chunk)
        )
        expect(result.error?.code).toBe('protocol')
        expect(result.at).toBe(0)
        expect(result.messages).toEqual([])
      })
    )
  })

  it('the cap fires on exactly the first frame whose running total passes it', () => {
    fc.assert(
      fc.property(
        message,
        fc.integer({ min: FRAME_HEADER_BYTES + 1, max: 48 }),
        fc.integer({ min: 0, max: 400 }),
        (m, chunk, cap) => {
          const frames = encodeMessage(0, m, chunk)
          const length = utf8Encode(JSON.stringify(m)).length
          const result = run(new FrameDecoder({ maxMessageBytes: cap }), frames)
          if (length <= cap) {
            expect(result.error).toBeUndefined()
            expect(result.messages).toEqual([normalised(m)])
          } else {
            const per = chunk - FRAME_HEADER_BYTES
            expect(result.error?.code).toBe('too_large')
            expect(result.at).toBe(Math.floor(cap / per))
            expect(result.messages).toEqual([])
          }
        }
      )
    )
  })
})

describe('frames: hostile input', () => {
  const rawFrames = fc.array(fc.uint8Array({ maxLength: 48 }), { maxLength: 24 })

  const headeredFrame = fc
    .record({
      flags: fc.oneof(fc.constant(0), fc.constant(1), fc.integer({ min: 0, max: 255 })),
      seq: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 0xffffffff })),
      payload: fc.oneof(
        fc.uint8Array({ maxLength: 48 }),
        fc.constantFrom('{}', '{"a":', '1}', '[]', 'null', '{"a":1}', '').map(utf8Encode)
      )
    })
    .map(({ flags, seq, payload }) => {
      const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length)
      frame[0] = 1
      frame[1] = flags
      new DataView(frame.buffer).setUint32(2, seq, false)
      frame.set(payload, FRAME_HEADER_BYTES)
      return frame
    })

  function assertOnlyWebRTPayErrors(frames: Uint8Array[], cap: number): void {
    const decoder = new FrameDecoder({ maxMessageBytes: cap })
    let failed: WebRTPayError | undefined
    for (const frame of frames) {
      try {
        const m = decoder.push(frame)
        // Once failed, the decoder must never accept anything again.
        expect(failed).toBeUndefined()
        if (m !== undefined) expect(isPlainObject(m)).toBe(true)
      } catch (e) {
        expect(e).toBeInstanceOf(WebRTPayError)
        const err = e as WebRTPayError
        expect(['protocol', 'too_large']).toContain(err.code)
        if (failed) expect(err).toBe(failed)
        failed = err
      }
    }
  }

  it('random byte frames only ever throw WebRTPayError', () => {
    fc.assert(
      fc.property(rawFrames, fc.integer({ min: 0, max: 64 }), (frames, cap) => {
        assertOnlyWebRTPayErrors(frames, cap)
      })
    )
  })

  it('well-formed headers with random payloads only ever throw WebRTPayError', () => {
    fc.assert(
      fc.property(
        fc.array(headeredFrame, { maxLength: 24 }),
        fc.integer({ min: 0, max: 64 }),
        (frames, cap) => {
          assertOnlyWebRTPayErrors(frames, cap)
        }
      )
    )
  })

  it('corrupted, truncated, dropped, duplicated and reordered streams only ever throw WebRTPayError', () => {
    const stream = fc
      .tuple(fc.array(message, { minLength: 1, maxLength: 4 }), fc.integer({ min: 7, max: 40 }))
      .map(([messages, chunk]) => messages.flatMap((m, seq) => encodeMessage(seq, m, chunk)))
    const mutation = fc.oneof(
      fc.record({
        kind: fc.constant('flip' as const),
        at: fc.nat(),
        offset: fc.nat(),
        value: fc.integer({ min: 0, max: 255 })
      }),
      fc.record({ kind: fc.constant('truncate' as const), at: fc.nat(), keep: fc.nat() }),
      fc.record({ kind: fc.constant('drop' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('duplicate' as const), at: fc.nat() }),
      fc.record({ kind: fc.constant('swap' as const), at: fc.nat(), other: fc.nat() })
    )

    fc.assert(
      fc.property(
        stream,
        fc.array(mutation, { minLength: 1, maxLength: 3 }),
        (frames, mutations) => {
          let out = frames.map(f => f.slice())
          for (const m of mutations) {
            const i = m.at % out.length
            if (m.kind === 'flip') {
              const f = out[i]
              f[m.offset % f.length] = m.value
            } else if (m.kind === 'truncate') {
              out[i] = out[i].subarray(0, m.keep % (out[i].length + 1))
            } else if (m.kind === 'drop') {
              out = out.filter((_, j) => j !== i)
            } else if (m.kind === 'duplicate') {
              out = [...out.slice(0, i + 1), out[i], ...out.slice(i + 1)]
            } else {
              const j = m.other % out.length
              ;[out[i], out[j]] = [out[j], out[i]]
            }
            if (out.length === 0) return
          }
          assertOnlyWebRTPayErrors(out, 4096)
        }
      )
    )
  })
})
