import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

/**
 * The address `req` comes from. With a `trustedHeader` (a lowercase header name),
 * that header's value when it is a valid IP address; for a list such as
 * `X-Forwarded-For`, its last entry, the one the nearest proxy added. Otherwise,
 * and when the header is missing or malformed, the socket's peer address ('' once
 * the socket has closed).
 */
export function clientAddress(req: IncomingMessage, trustedHeader?: string): string {
  if (trustedHeader !== undefined) {
    const value = req.headers[trustedHeader]
    const list = Array.isArray(value) ? value.join(',') : (value ?? '')
    const last = bare(list.slice(list.lastIndexOf(',') + 1))
    if (isIP(last) !== 0) return last
  }
  return req.socket.remoteAddress ?? ''
}

/**
 * The key per-source limits count `address` under: an IPv4 address as is (also
 * when it is IPv4-mapped IPv6), and an IPv6 address as its /64 prefix, e.g.
 * `2001:db8:0:1::/64`, because one subscriber is usually handed a whole /64. Any
 * other string is returned unchanged.
 */
export function addressGroup(address: string): string {
  const a = bare(address)
  const family = isIP(a)
  if (family === 4) return a
  if (family !== 6) return address
  const g = ipv6Groups(a)
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.')
  }
  return `${g
    .slice(0, 4)
    .map(x => x.toString(16))
    .join(':')}::/64`
}

/** `address` trimmed, without IPv6 brackets or a zone index. */
function bare(address: string): string {
  let a = address.trim()
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1)
  const zone = a.indexOf('%')
  return zone === -1 ? a : a.slice(0, zone)
}

/** The eight 16-bit groups of a valid IPv6 address (`isIP(a) === 6`). */
function ipv6Groups(a: string): number[] {
  let s = a.toLowerCase()
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const [b0, b1, b2, b3] = tail.split('.').map(Number)
    const hi = ((b0 << 8) | b1).toString(16)
    const lo = ((b2 << 8) | b3).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }
  const [head, rest] = s.split('::')
  const left = head === '' ? [] : head.split(':')
  if (rest === undefined) return left.map(h => parseInt(h, 16))
  const right = rest === '' ? [] : rest.split(':')
  const zeros = new Array<string>(8 - left.length - right.length).fill('0')
  return [...left, ...zeros, ...right].map(h => parseInt(h, 16))
}
