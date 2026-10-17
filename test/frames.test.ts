import { describe, expect, it } from '@jest/globals'
import { FRAME_HEADER_BYTES, FrameDecoder, encodeMessage } from '../src/channel/frames.js'
import { DEFAULTS } from '../src/types.js'
import { concatBytes, utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import type { WebRTPayErrorCode } from '../src/util/errors.js'

/** Build a raw frame by hand so the tests do not depend on the encoder under test. */
function rawFrame(
  seq: number,
  final: boolean,
  payload: Uint8Array | string,
  header: { version?: number; flags?: number } = {}
): Uint8Array {
  const body = typeof payload === 'string' ? utf8Encode(payload) : payload
  const out = new Uint8Array(6 + body.length)
  out[0] = header.version ?? 1
  out[1] = header.flags ?? (final ? 1 : 0)
  new DataView(out.buffer).setUint32(2, seq, false)
  out.set(body, 6)
  return out
}

function codeOf(fn: () => unknown): WebRTPayErrorCode | undefined {
  try {
    fn()
  } catch (e) {
    if (e instanceof WebRTPayError) return e.code
    throw e
  }
  return undefined
}

function decoder(maxMessageBytes = 1_000_000): FrameDecoder {
  return new FrameDecoder({ maxMessageBytes })
}

function feed(d: FrameDecoder, frames: Uint8Array[]): unknown[] {
  const out: unknown[] = []
  for (const f of frames) {
    const m = d.push(f)
    if (m !== undefined) out.push(m)
  }
  return out
}

describe('encodeMessage', () => {
  it('uses a 6-byte header and a 16 KiB frame budget by default', () => {
    expect(FRAME_HEADER_BYTES).toBe(6)
    expect(DEFAULTS.chunkBytes).toBe(16384)
  })

  it('writes [version 1][flags][seq u32 big-endian][payload]', () => {
    const frames = encodeMessage(0x01020304, { a: 1 })
    expect(frames).toHaveLength(1)
    expect(Array.from(frames[0].subarray(0, 6))).toEqual([1, 1, 1, 2, 3, 4])
    expect(Array.from(frames[0].subarray(6))).toEqual(Array.from(utf8Encode('{"a":1}')))
  })

  it('encodes the largest sequence number', () => {
    const [frame] = encodeMessage(0xffffffff, {})
    expect(Array.from(frame.subarray(2, 6))).toEqual([255, 255, 255, 255])
  })

  it('emits a single final frame for an empty object', () => {
    const frames = encodeMessage(0, {})
    expect(frames).toHaveLength(1)
    expect(frames[0]).toHaveLength(FRAME_HEADER_BYTES + 2)
    expect(frames[0][1]).toBe(1)
  })

  it('splits a 1 MiB message into ceil(len / 16378) frames and decodes it back', () => {
    const message = { data: 'x'.repeat(1024 * 1024 - '{"data":""}'.length) }
    const json = utf8Encode(JSON.stringify(message))
    expect(json.length).toBe(1024 * 1024)

    const frames = encodeMessage(7, message)
    expect(frames).toHaveLength(Math.ceil(json.length / (16384 - 6)))
    frames.forEach((f, i) => {
      expect(f.length).toBeLessThanOrEqual(16384)
      if (i < frames.length - 1) expect(f.length).toBe(16384)
      expect(f[0]).toBe(1)
      expect(f[1]).toBe(i === frames.length - 1 ? 1 : 0)
      expect(new DataView(f.buffer, f.byteOffset, f.byteLength).getUint32(2, false)).toBe(7)
    })
    expect(concatBytes(...frames.map(f => f.subarray(6)))).toEqual(json)

    expect(feed(decoder(2 * 1024 * 1024), encodeMessage(0, message))).toEqual([message])
  })

  it('does not add a trailing empty frame when the payload is an exact multiple', () => {
    const per = 16384 - 6
    const one = { s: 'a'.repeat(per - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(one)).length).toBe(per)
    expect(encodeMessage(0, one)).toHaveLength(1)

    const two = { s: 'a'.repeat(2 * per - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(two)).length).toBe(2 * per)
    const frames = encodeMessage(0, two)
    expect(frames).toHaveLength(2)
    expect(frames.map(f => f[1])).toEqual([0, 1])
    expect(frames.every(f => f.length === 16384)).toBe(true)

    const over = { s: 'a'.repeat(per + 1 - '{"s":""}'.length) }
    expect(encodeMessage(0, over)).toHaveLength(2)
  })

  it('honours a custom chunk size', () => {
    const frames = encodeMessage(0, { k: 'abcdefghij' }, 10)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every(f => f.length <= 10)).toBe(true)
    expect(feed(decoder(), frames)).toEqual([{ k: 'abcdefghij' }])
  })

  it('splits multi-byte UTF-8 sequences across frames and reassembles them', () => {
    const message = { s: 'a€𝄞é' }
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 1)
    expect(frames).toHaveLength(utf8Encode(JSON.stringify(message)).length)
    expect(feed(decoder(), frames)).toEqual([message])
  })

  it('returns frames that own their bytes, so they can be handed to channel.send', () => {
    for (const f of encodeMessage(0, { s: 'a'.repeat(100) }, 40)) {
      expect(f.byteOffset).toBe(0)
      expect(f.buffer.byteLength).toBe(f.length)
    }
  })

  it('rejects a sequence number outside u32', () => {
    for (const seq of [-1, 1.5, 2 ** 32, Number.NaN, Infinity]) {
      expect(() => encodeMessage(seq, {})).toThrow(RangeError)
    }
  })

  it('rejects a chunk size that leaves no room for payload', () => {
    for (const chunk of [0, 5, 6, 6.5, Number.NaN]) {
      expect(() => encodeMessage(0, {}, chunk)).toThrow(RangeError)
    }
    expect(() => encodeMessage(0, {}, 7)).not.toThrow()
  })

  it('rejects a value that JSON cannot represent', () => {
    expect(() => encodeMessage(0, undefined)).toThrow(TypeError)
    expect(() => encodeMessage(0, () => 1)).toThrow(TypeError)
    expect(() => encodeMessage(0, Symbol('x'))).toThrow(TypeError)
  })
})

describe('FrameDecoder', () => {
  it('accepts consecutive sequence numbers from 0', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, true, '{"n":0}'))).toEqual({ n: 0 })
    expect(d.push(rawFrame(1, true, '{"n":1}'))).toEqual({ n: 1 })
    expect(d.push(rawFrame(2, true, '{"n":2}'))).toEqual({ n: 2 })
  })

  it('rejects a skipped sequence number', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, true, '{}'))).toEqual({})
    expect(codeOf(() => d.push(rawFrame(2, true, '{}')))).toBe('protocol')
  })

  it('requires the first message to be sequence 0', () => {
    expect(codeOf(() => decoder().push(rawFrame(1, true, '{}')))).toBe('protocol')
  })

  it('rejects a repeated or reversed sequence number', () => {
    const d = decoder()
    d.push(rawFrame(0, true, '{}'))
    d.push(rawFrame(1, true, '{}'))
    expect(codeOf(() => d.push(rawFrame(1, true, '{}')))).toBe('protocol')
    const e = decoder()
    e.push(rawFrame(0, true, '{}'))
    e.push(rawFrame(1, true, '{}'))
    expect(codeOf(() => e.push(rawFrame(0, true, '{}')))).toBe('protocol')
  })

  it('keeps every chunk of one message on the same sequence number', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, false, '{"a":'))).toBeUndefined()
    expect(codeOf(() => d.push(rawFrame(1, true, '1}')))).toBe('protocol')
  })

  it('advances the sequence number only when a message completes', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, false, '{"a":'))).toBeUndefined()
    expect(d.push(rawFrame(0, false, '1,"b"'))).toBeUndefined()
    expect(d.push(rawFrame(0, true, ':2}'))).toEqual({ a: 1, b: 2 })
    expect(d.push(rawFrame(1, true, '{"c":3}'))).toEqual({ c: 3 })
  })

  it('reassembles several multi-frame messages in a row without leftovers', () => {
    const d = decoder()
    const messages = [{ s: 'a'.repeat(50) }, { s: 'b'.repeat(70) }, { n: 1 }]
    const frames = messages.flatMap((m, i) => encodeMessage(i, m, 16))
    expect(frames.length).toBeGreaterThan(messages.length)
    expect(feed(d, frames)).toEqual(messages)
  })

  it('rejects a frame shorter than the header', () => {
    for (let n = 0; n < FRAME_HEADER_BYTES; n++) {
      expect(codeOf(() => decoder().push(new Uint8Array(n).fill(1)))).toBe('protocol')
    }
  })

  it('rejects an unknown version', () => {
    for (const version of [0, 2, 9, 255]) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, '{}', { version })))).toBe('protocol')
    }
  })

  it('rejects reserved flag bits', () => {
    for (const flags of [2, 3, 0x80, 0xff]) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, '{}', { flags })))).toBe('protocol')
    }
  })

  it('rejects a message that is not JSON', () => {
    for (const text of ['not json', '{"a":', '{a:1}', "{'a':1}", '{} {}', '{}x', '']) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
    }
  })

  it('rejects invalid UTF-8', () => {
    const bad = new Uint8Array([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])
    expect(codeOf(() => decoder().push(rawFrame(0, true, bad)))).toBe('protocol')
  })

  it('rejects a top level that is not an object', () => {
    for (const text of ['1', '"x"', 'true', 'null', '[]', '[{}]', '0']) {
      expect(codeOf(() => decoder().push(rawFrame(0, true, text)))).toBe('protocol')
    }
  })

  it('accepts an empty object and nested values', () => {
    expect(decoder().push(rawFrame(0, true, '{}'))).toEqual({})
    expect(decoder().push(rawFrame(0, true, '{"a":[1,{"b":null}],"c":"d"}'))).toEqual({
      a: [1, { b: null }],
      c: 'd'
    })
  })

  it('completes an empty object with a zero-length final frame', () => {
    const d = decoder()
    expect(d.push(rawFrame(0, false, '{}'))).toBeUndefined()
    expect(d.push(rawFrame(0, true, new Uint8Array(0)))).toEqual({})
    expect(d.push(rawFrame(1, true, '{"next":true}'))).toEqual({ next: true })
  })

  it('rejects a lone zero-length final frame', () => {
    expect(codeOf(() => decoder().push(rawFrame(0, true, new Uint8Array(0))))).toBe('protocol')
  })

  it('throws too_large on the frame that crosses the cap', () => {
    const message = { s: 'a'.repeat(2000 - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(message)).length).toBe(2000)
    // 500-byte payloads: 500, 1000 are within the 1000-byte cap, 1500 is not.
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 500)
    expect(frames).toHaveLength(4)

    const d = decoder(1000)
    expect(d.push(frames[0])).toBeUndefined()
    expect(d.push(frames[1])).toBeUndefined()
    expect(codeOf(() => d.push(frames[2]))).toBe('too_large')
  })

  it('accepts a message of exactly the cap', () => {
    const message = { s: 'a'.repeat(1000 - '{"s":""}'.length) }
    expect(utf8Encode(JSON.stringify(message)).length).toBe(1000)
    const d = decoder(1000)
    expect(feed(d, encodeMessage(0, message, FRAME_HEADER_BYTES + 500))).toEqual([message])
  })

  it('throws too_large for a single frame over the cap', () => {
    const frame = rawFrame(0, true, `{"s":"${'a'.repeat(1000)}"}`)
    expect(codeOf(() => decoder(1000).push(frame))).toBe('too_large')
  })

  it('applies the cap to each message separately', () => {
    const message = { s: 'a'.repeat(900 - '{"s":""}'.length) }
    const d = decoder(1000)
    expect(feed(d, [...encodeMessage(0, message), ...encodeMessage(1, message)])).toEqual([
      message,
      message
    ])
  })

  it('checks sequence before size', () => {
    const d = decoder(10)
    expect(codeOf(() => d.push(rawFrame(5, true, 'a'.repeat(100))))).toBe('protocol')
  })

  it('stays failed after an error', () => {
    const d = decoder()
    d.push(rawFrame(0, true, '{}'))
    expect(codeOf(() => d.push(rawFrame(7, true, '{}')))).toBe('protocol')
    // The frame that would have been next in order is no longer accepted.
    expect(codeOf(() => d.push(rawFrame(1, true, '{}')))).toBe('protocol')

    const big = decoder(10)
    expect(codeOf(() => big.push(rawFrame(0, true, 'a'.repeat(100))))).toBe('too_large')
    expect(codeOf(() => big.push(rawFrame(0, true, '{}')))).toBe('too_large')
  })

  it('reads frames that are views into a larger buffer', () => {
    const frame = rawFrame(0, true, '{"v":1}')
    const backing = new Uint8Array(frame.length + 10).fill(0xee)
    backing.set(frame, 5)
    const view = backing.subarray(5, 5 + frame.length)
    expect(view.byteOffset).toBe(5)
    expect(decoder().push(view)).toEqual({ v: 1 })
  })

  it('reads any binary view by its bytes', () => {
    const bytes = rawFrame(0, true, '{"v":1}')
    expect(decoder().push(Buffer.from(bytes))).toEqual({ v: 1 })
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    expect(decoder().push(dataView as unknown as Uint8Array)).toEqual({ v: 1 })
  })

  it('copies buffered payloads so a reused frame buffer cannot corrupt a message', () => {
    const d = decoder()
    const first = rawFrame(0, false, '{"a":')
    expect(d.push(first)).toBeUndefined()
    first.fill(0) // the transport recycles its buffer
    expect(d.push(rawFrame(0, true, '1}'))).toEqual({ a: 1 })
  })

  it('rejects a frame that is not binary', () => {
    for (const frame of ['{}', null, undefined, 42, {}, [1, 0, 0, 0, 0, 0]]) {
      expect(codeOf(() => decoder().push(frame as unknown as Uint8Array))).toBe('protocol')
    }
  })

  it('reassembles a message split into thousands of one-byte chunks', () => {
    const message = { s: 'z'.repeat(40_000), t: '€'.repeat(2000) }
    const frames = encodeMessage(0, message, FRAME_HEADER_BYTES + 1)
    expect(frames.length).toBeGreaterThan(40_000)
    expect(feed(decoder(), frames)).toEqual([message])
  })

  it('is not slowed or grown by endless empty non-final frames', () => {
    const d = decoder(1000)
    const empty = rawFrame(0, false, new Uint8Array(0))
    let completed = 0
    for (let i = 0; i < 200_000; i++) if (d.push(empty) !== undefined) completed++
    expect(completed).toBe(0)
    expect(d.push(rawFrame(0, true, '{"ok":1}'))).toEqual({ ok: 1 })
  })

  it('rejects an invalid cap', () => {
    for (const maxMessageBytes of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => new FrameDecoder({ maxMessageBytes })).toThrow(RangeError)
    }
    expect(() => new FrameDecoder({ maxMessageBytes: 0 })).not.toThrow()
  })
})
