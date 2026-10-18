/**
 * Ruling 24 (audit F5): no real network address may be published with the package's tests
 * or docs. Every IPv4 and IPv6 literal under `test/`, `docs/` and `examples/` and in
 * `README.md` must be loopback, private, link-local, unspecified or from a documentation
 * range. A captured SDP has to be scrubbed before it is pasted in as a fixture.
 */
import { describe, expect, it } from '@jest/globals'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { BlockList, isIP } from 'node:net'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Paths, relative to the package root, whose IP literals are checked. */
const SCANNED = ['test', 'docs', 'examples', 'README.md']

/** The address ranges a literal may come from. */
const SAFE = new BlockList()
for (const [network, prefix] of [
  ['0.0.0.0', 32], // unspecified
  ['127.0.0.0', 8], // loopback
  ['10.0.0.0', 8], // RFC 1918
  ['172.16.0.0', 12], // RFC 1918
  ['192.168.0.0', 16], // RFC 1918
  ['169.254.0.0', 16], // link-local
  ['192.0.2.0', 24], // RFC 5737 TEST-NET-1
  ['198.51.100.0', 24], // RFC 5737 TEST-NET-2
  ['203.0.113.0', 24] // RFC 5737 TEST-NET-3
] as const) {
  SAFE.addSubnet(network, prefix, 'ipv4')
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['fe80::', 10], // link-local
  ['fc00::', 7], // unique local (private)
  ['2001:db8::', 32] // RFC 3849 documentation
] as const) {
  SAFE.addSubnet(network, prefix, 'ipv6')
}

/** True when `address` (a valid IP literal) lies in one of the {@link SAFE} ranges. */
function isSafeAddress(address: string): boolean {
  // IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is checked against the IPv4 ranges.
  return SAFE.check(address, isIP(address) === 4 ? 'ipv4' : 'ipv6')
}

/** A dotted quad that is not part of a longer dotted or alphanumeric run, nor a section (`§`). */
const IPV4_CANDIDATE = /(?<![\w.§])\d{1,3}(?:\.\d{1,3}){3}(?!\.?\d)/g
/**
 * Maximal runs of the characters IPv6 text is written with. Taking whole runs means a long
 * colon-separated value, such as a DTLS fingerprint, is judged as one and never yields an
 * address from its middle.
 */
const IPV6_CANDIDATE = /[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*/g

/** Every valid IPv4 and IPv6 literal in `text`, as written. */
function ipLiterals(text: string): string[] {
  const found: string[] = []
  for (const [v4] of text.matchAll(IPV4_CANDIDATE)) {
    if (isIP(v4) === 4) found.push(v4)
  }
  for (const [run] of text.matchAll(IPV6_CANDIDATE)) {
    // A run may start or end with a colon or dot of the surrounding text (`addr:2001:db8::1`,
    // an address at the end of a sentence); `::` belongs to the address.
    const v6 = run.replace(/^:(?!:)/, '').replace(/(?<!:):$|\.$/, '')
    if (isIP(v6) === 6) found.push(v6)
  }
  return found
}

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return []
  if (!statSync(path).isDirectory()) return [path]
  return readdirSync(path).flatMap(name => filesUnder(join(path, name)))
}

describe('IP literals in tests and docs (Ruling 24)', () => {
  it('finds IPv4 and IPv6 literals wherever they are written', () => {
    // Public samples are assembled at run time so this file passes its own scan.
    const publicV4 = [9, 9, 9, 9].join('.')
    const publicV6 = ['2620', 'fe', '', 'fe'].join(':')
    const text = [
      `a=candidate:1 1 udp 2122260223 ${publicV4} 50000 typ srflx raddr 0.0.0.0 rport 0`,
      `c=IN IP4 ${publicV4}`,
      `stun:${publicV4}:3478 turn:[${publicV6}]:3478 addr:${publicV6}.`,
      "'::ffff:203.0.113.7' '::ffff:cb00:7107' '2001:db8:0:0::/64' [::1]:8787 '::'",
      'a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3',
      'version 4.18.0-alpine3.24, 1.2.3.4.5, 127.0.0.256, RFC 8445 §5.1.2.1, 12:30, deadbeef'
    ].join('\n')
    expect(ipLiterals(text)).toEqual([
      publicV4,
      '0.0.0.0',
      publicV4,
      publicV4,
      '203.0.113.7',
      publicV6,
      publicV6,
      '::ffff:203.0.113.7',
      '::ffff:cb00:7107',
      '2001:db8:0:0::',
      '::1',
      '::'
    ])
  })

  it('accepts only loopback, private, link-local, unspecified and documentation addresses', () => {
    const safe = [
      '0.0.0.0',
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.5',
      '169.254.1.1',
      '192.0.2.4',
      '198.51.100.1',
      '203.0.113.7',
      '::',
      '::1',
      'fe80::1',
      'fd12:3456::1',
      '2001:db8::1',
      '2001:DB8:1:2:ffff:ffff:ffff:ffff',
      '::ffff:127.0.0.1',
      '::ffff:cb00:7107'
    ]
    // Assembled at run time, like the samples above.
    const unsafe = [
      [128, 0, 0, 1],
      [172, 32, 0, 1],
      [192, 0, 3, 1],
      [100, 64, 0, 1]
    ]
      .map(octets => octets.join('.'))
      .concat(
        [
          ['2620', 'fe', '', 'fe'],
          ['1', '2', '3', '4', '', ''],
          ['2001', 'db9', '', '1'],
          ['', '', '2'],
          ['', '', 'ffff', '808', '808']
        ].map(groups => groups.join(':'))
      )
    expect(safe.filter(a => !isSafeAddress(a))).toEqual([])
    expect(unsafe.filter(isSafeAddress)).toEqual([])
  })

  it('finds no other address in test/, docs/, examples/ or README.md', () => {
    const files = SCANNED.flatMap(p => filesUnder(join(ROOT, p)))
    const literals = files.flatMap(file =>
      ipLiterals(readFileSync(file, 'utf8')).map(address => ({
        file: relative(ROOT, file),
        address
      }))
    )
    // The scan reaches the fixtures: the loopback peers alone are written dozens of times.
    expect(literals.length).toBeGreaterThan(50)
    expect(literals.filter(l => !isSafeAddress(l.address))).toEqual([])
  })
})
