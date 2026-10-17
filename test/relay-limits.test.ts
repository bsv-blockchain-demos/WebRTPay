import { afterEach, beforeAll, describe, expect, it } from '@jest/globals'
import type { RelayServer } from '../server/index.js'
import { addressGroup } from '../server/ip.js'
import {
  authenticate,
  env,
  hmacBase64,
  inbox,
  party,
  relayFixtures,
  upgradeError,
  waitFor
} from './helpers/relay.js'
import type { Party, Raw } from './helpers/relay.js'

describe('relay limits', () => {
  let alice: Party
  let bob: Party
  let carol: Party
  const { relay, signaler, rawAt, defer, cleanup } = relayFixtures()

  beforeAll(async () => {
    ;[alice, bob, carol] = await Promise.all([party(), party(), party()])
  })

  afterEach(cleanup)

  /** A raw socket authenticated as `p`, past its `ready` and `ice` frames. */
  async function authed(r: RelayServer, p: Party, headers?: Record<string, string>): Promise<Raw> {
    const c = rawAt(r.url, { headers })
    await authenticate(c, p, r.url)
    expect(await c.next()).toEqual({ t: 'ready', identityKey: p.key })
    expect((await c.next()).t).toBe('ice')
    return c
  }

  /** Open a raw socket and wait for its challenge, i.e. until the relay accepted it. */
  async function accepted(r: RelayServer, headers?: Record<string, string>): Promise<Raw> {
    const c = rawAt(r.url, { headers })
    expect((await c.next()).t).toBe('challenge')
    return c
  }

  describe('write buffers and liveness', () => {
    it('terminates a recipient that stops reading and reports the signal it could not take as not delivered', async () => {
      const r = await relay({
        limits: {
          maxBufferedBytes: 64 * 1024,
          rateMessages: 100000,
          signalsPerRecipientPerMinute: 100000
        }
      })
      const b = await authed(r, bob)
      b.ws.pause()
      const a = await authed(r, alice)

      // The kernel's socket buffers take the first few hundred KiB; then the relay's own grows.
      const ciphertext = 'A'.repeat(16000)
      let delivered = 0
      let reply: Record<string, unknown> = {}
      while (delivered < 4000) {
        const e = env(ciphertext)
        a.send({ t: 'signal', to: bob.key, envelope: e })
        reply = await a.next()
        if (reply.t !== 'sent') {
          expect(reply).toEqual({ t: 'error', code: 'offline', ref: e.sid })
          break
        }
        delivered++
      }
      expect(reply.t).toBe('error')
      expect(delivered).toBeGreaterThan(0)
      await waitFor(() => r.stats().identities === 1)
      expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
      b.ws.resume()
      expect(await b.closed).toBe(1006)
    })

    it('stops answering a client that stops reading and terminates it', async () => {
      // Each `turn` frame (no TURN configured) is answered with this ~16 KiB STUN list.
      // Large replies reach the relay's own buffer quickly; tiny ones (an error per
      // junk frame) work the same way, but some kernels absorb a hundred megabytes of
      // them on loopback first.
      const stunUrls = Array.from({ length: 16 }, (_, i) => `stun:${'s'.repeat(1000)}${i}.example`)
      const r = await relay({
        stunUrls,
        limits: { maxBufferedBytes: 64 * 1024, rateMessages: 100000 }
      })
      const a = await authed(r, alice)
      a.ws.pause()
      let frames = 0
      while (r.stats().sockets === 1 && frames < 10000) {
        a.send({ t: 'turn' })
        if (++frames % 20 === 0) await new Promise(res => setTimeout(res, 1))
      }
      await waitFor(() => r.stats().sockets === 0)
      expect(frames).toBeLessThan(10000)
      a.ws.resume()
      expect(await a.closed).toBe(1006)
    })

    it('drops a socket that sends pongs it was not asked for or with the wrong payload', async () => {
      const r = await relay({ limits: { pingIntervalMs: 250 } })
      const healthy = await authed(r, carol)

      const unsolicited = rawAt(r.url, { autoPong: false })
      await authenticate(unsolicited, alice, r.url)
      expect(await unsolicited.next()).toEqual({ t: 'ready', identityKey: alice.key })
      const pongs = setInterval(() => unsolicited.ws.pong(), 50)
      defer(() => clearInterval(pongs))

      const wrong = rawAt(r.url, { autoPong: false })
      wrong.ws.on('ping', () => wrong.ws.pong(Buffer.from('not your payload')))
      await authenticate(wrong, bob, r.url)
      expect(await wrong.next()).toEqual({ t: 'ready', identityKey: bob.key })

      expect(await unsolicited.closed).toBe(1006)
      expect(await wrong.closed).toBe(1006)
      await waitFor(() => r.stats().sockets === 1)
      expect(healthy.ws.readyState).toBe(healthy.ws.OPEN)
      expect(r.stats()).toEqual({ sockets: 1, identities: 1 })
    })
  })

  describe('admission', () => {
    it('validates the trusted address header and the new limits', async () => {
      await expect(relay({ trustedIpHeader: 'not a header' })).rejects.toThrow(TypeError)
      for (const limits of [
        { maxBufferedBytes: 0 },
        { maxSocketsPerIp: -1 },
        { turnPerHour: Number.NaN }
      ]) {
        await expect(relay({ limits })).rejects.toThrow(RangeError)
      }
    })

    it('refuses the 21st socket from one address before upgrading it', async () => {
      const r = await relay()
      const twenty: Raw[] = []
      for (let i = 0; i < 20; i++) twenty.push(await accepted(r))
      expect(await upgradeError(r.url)).toContain('429')
      expect(r.stats().sockets).toBe(20)

      twenty[0].ws.close()
      await waitFor(() => r.stats().sockets === 19)
      await accepted(r)
    })

    it('limits new connections per address per minute', async () => {
      const r = await relay({ limits: { connectionsPerIpPerMinute: 3 } })
      for (let i = 0; i < 3; i++) (await accepted(r)).ws.close()
      await waitFor(() => r.stats().sockets === 0)
      expect(await upgradeError(r.url)).toContain('429')
    })

    it('takes the client address from a header only when that header is configured', async () => {
      const limits = { maxSocketsPerIp: 1 }
      const plain = await relay({ limits })
      await accepted(plain, { 'cf-connecting-ip': '203.0.113.1' })
      // Without trustedIpHeader both come from 127.0.0.1, whatever the header says.
      expect(await upgradeError(plain.url, { 'cf-connecting-ip': '203.0.113.2' })).toContain('429')

      const proxied = await relay({ trustedIpHeader: 'CF-Connecting-IP', limits })
      await accepted(proxied, { 'cf-connecting-ip': '203.0.113.1' })
      await accepted(proxied, { 'cf-connecting-ip': '203.0.113.2' })
      for (const ip of ['203.0.113.1', '::ffff:203.0.113.1', '198.51.100.9, 203.0.113.2']) {
        expect(await upgradeError(proxied.url, { 'cf-connecting-ip': ip })).toContain('429')
      }
      // a missing or malformed header falls back to the peer address
      await accepted(proxied)
      expect(await upgradeError(proxied.url, { 'cf-connecting-ip': 'nonsense' })).toContain('429')
    })

    it('groups IPv6 clients by /64', async () => {
      const r = await relay({ trustedIpHeader: 'x-client-ip', limits: { maxSocketsPerIp: 1 } })
      await accepted(r, { 'x-client-ip': '2001:db8:1:2::1' })
      for (const ip of ['2001:db8:1:2:ffff:ffff:ffff:ffff', '2001:DB8:1:2:0:0:0:9']) {
        expect(await upgradeError(r.url, { 'x-client-ip': ip })).toContain('429')
      }
      await accepted(r, { 'x-client-ip': '2001:db8:1:3::1' })
    })

    it('caps unauthenticated sockets across all addresses', async () => {
      const r = await relay({
        trustedIpHeader: 'x-client-ip',
        limits: { maxUnauthenticatedSockets: 2 }
      })
      const a = rawAt(r.url, { headers: { 'x-client-ip': '203.0.113.1' } })
      await accepted(r, { 'x-client-ip': '203.0.113.2' })
      await waitFor(() => r.stats().sockets === 2)
      expect(await upgradeError(r.url, { 'x-client-ip': '203.0.113.3' })).toContain('503')

      await authenticate(a, alice, r.url)
      expect(await a.next()).toEqual({ t: 'ready', identityKey: alice.key })
      await accepted(r, { 'x-client-ip': '203.0.113.3' })
    })

    it('limits signals to one recipient per minute across senders and reports the excess as not delivered', async () => {
      const r = await relay({ limits: { signalsPerRecipientPerMinute: 3 } })
      const bobBox = inbox()
      await signaler(r, bob).listen(bobBox.fn)
      const carolBox = inbox()
      await signaler(r, carol).listen(carolBox.fn)
      const a = signaler(r, alice)
      const c = signaler(r, carol)

      await a.send(bob.key, env())
      await a.send(bob.key, env())
      await c.send(bob.key, env())
      await expect(a.send(bob.key, env())).rejects.toMatchObject({ code: 'peer_unreachable' })
      await expect(c.send(bob.key, env())).rejects.toMatchObject({ code: 'peer_unreachable' })
      await a.send(carol.key, env())
      await waitFor(() => carolBox.got.length === 1)
      expect(bobBox.got).toHaveLength(3)
    })
  })

  describe('TURN issuance', () => {
    const turn = { secret: 'turn-secret', urls: ['turn:127.0.0.1:3478'] }
    const stun = { urls: ['stun:127.0.0.1:3478'] }

    /** Deliver one signal from `c` to bob, who must be listening. */
    async function deliver(c: Raw): Promise<void> {
      const e = env()
      c.send({ t: 'signal', to: bob.key, envelope: e })
      expect(await c.next()).toEqual({ t: 'sent', ref: e.sid })
    }

    async function requestTurn(c: Raw): Promise<Record<string, unknown>> {
      c.send({ t: 'turn' })
      return c.next()
    }

    it('issues TURN credentials only to a socket that delivered a signal', async () => {
      const r = await relay({ stunUrls: stun.urls, turn })
      await signaler(r, bob).listen(() => {})
      const a = await authed(r, alice)
      expect(await requestTurn(a)).toEqual({ t: 'error', code: 'forbidden' })
      const e = env()
      a.send({ t: 'signal', to: carol.key, envelope: e })
      expect(await a.next()).toEqual({ t: 'error', code: 'offline', ref: e.sid })
      expect(await requestTurn(a)).toEqual({ t: 'error', code: 'forbidden' })

      await deliver(a)
      const before = Math.floor(Date.now() / 1000)
      const reply = await requestTurn(a)
      const after = Math.floor(Date.now() / 1000)
      expect(reply.t).toBe('ice')
      const servers = reply.iceServers as RTCIceServer[]
      expect(servers).toHaveLength(2)
      expect(servers[0]).toEqual(stun)
      expect(servers[1].urls).toEqual(turn.urls)
      const username = servers[1].username as string
      const [expiry, pseudonym] = username.split(':')
      expect(pseudonym).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(username).not.toContain(alice.key)
      // the relay's default lifetime is 10 minutes
      expect(Number(expiry)).toBeGreaterThanOrEqual(before + 600)
      expect(Number(expiry)).toBeLessThanOrEqual(after + 600)
      expect(servers[1].credential).toBe(hmacBase64(turn.secret, username))
    })

    it('hands RelaySignaler the full list on requestTurn and keeps it as iceServers()', async () => {
      const r = await relay({ stunUrls: stun.urls, turn: { ...turn, ttlSeconds: 120 } })
      await signaler(r, bob).listen(() => {})
      const seen: RTCIceServer[][] = []
      const a = signaler(r, alice, { onIceServers: s => seen.push(s) })
      await a.connect()
      await expect(a.requestTurn()).rejects.toMatchObject({ code: 'rejected' })
      expect(a.iceServers()).toEqual([stun])

      // replies stay matched to requests when a turn request sits between sends
      const [, servers] = await Promise.all([
        a.send(bob.key, env()),
        a.requestTurn(),
        a.send(bob.key, env())
      ])
      expect(servers).toHaveLength(2)
      expect(servers[1]).toMatchObject({ urls: turn.urls, username: expect.any(String) })
      expect(a.iceServers()).toEqual(servers)
      expect(seen).toEqual([[stun], servers])
    })

    it('stops issuing once the last delivered signal is older than the window', async () => {
      const r = await relay({ turn, limits: { turnAfterSentMs: 300 } })
      await signaler(r, bob).listen(() => {})
      const a = await authed(r, alice)
      await deliver(a)
      expect((await requestTurn(a)).t).toBe('ice')
      await new Promise(res => setTimeout(res, 400))
      expect(await requestTurn(a)).toEqual({ t: 'error', code: 'forbidden' })
    })

    it('limits issuance per source address and in total', async () => {
      const r = await relay({
        turn,
        trustedIpHeader: 'x-client-ip',
        limits: { turnPerIpPerHour: 2, turnPerHour: 3 }
      })
      await signaler(r, bob).listen(() => {})
      const from = async (ip: string): Promise<Raw> => {
        const c = await authed(r, alice, { 'x-client-ip': ip })
        await deliver(c)
        return c
      }
      const one = await from('203.0.113.1')
      expect((await requestTurn(one)).t).toBe('ice')
      expect((await requestTurn(one)).t).toBe('ice')
      expect(await requestTurn(one)).toEqual({ t: 'error', code: 'rate_limited' })
      // another socket from the same address shares its budget
      const sameAddress = await from('203.0.113.1')
      expect(await requestTurn(sameAddress)).toEqual({ t: 'error', code: 'rate_limited' })

      const two = await from('203.0.113.2')
      expect((await requestTurn(two)).t).toBe('ice')
      // the relay-wide budget of 3 is spent
      const three = await from('203.0.113.3')
      expect(await requestTurn(three)).toEqual({ t: 'error', code: 'rate_limited' })
    })

    it('answers turn with the STUN servers when no TURN is configured', async () => {
      const r = await relay({ stunUrls: stun.urls })
      const a = await authed(r, alice)
      expect(await requestTurn(a)).toEqual({ t: 'ice', iceServers: [stun] })
    })
  })
})

describe('addressGroup', () => {
  it('keeps IPv4 addresses, unmaps IPv4-mapped IPv6 and groups other IPv6 by /64', () => {
    const cases: Array<[string, string]> = [
      ['203.0.113.7', '203.0.113.7'],
      ['::ffff:203.0.113.7', '203.0.113.7'],
      ['::ffff:cb00:7107', '203.0.113.7'],
      ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
      ['2001:DB8:1:2:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
      ['2001:db8::1', '2001:db8:0:0::/64'],
      ['[2001:db8:0:1::5]', '2001:db8:0:1::/64'],
      ['fe80::1%en0', 'fe80:0:0:0::/64'],
      ['::1', '0:0:0:0::/64'],
      ['::', '0:0:0:0::/64'],
      ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4::/64'],
      ['not an address', 'not an address'],
      ['', '']
    ]
    for (const [address, group] of cases)
      expect([address, addressGroup(address)]).toEqual([address, group])
  })
})
