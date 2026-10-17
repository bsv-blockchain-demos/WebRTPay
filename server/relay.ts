import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { TLSSocket } from 'node:tls'
import { ProtoWallet } from '@bsv/sdk'
import { WebSocketServer, WebSocket as WsSocket } from 'ws'
import type { RawData } from 'ws'
import { isSignalEnvelope } from '../src/signaling/envelope.js'
import { normalizeRelayUrl, relayAuthData } from '../src/signaling/RelaySignaler.js'
import type {
  RelayErrorCode,
  RelayIceServer,
  RelayServerFrame
} from '../src/signaling/RelaySignaler.js'
import { RELAY_PROTOCOL_ID, isIdentityKey } from '../src/types.js'
import type { PubKeyHex } from '../src/types.js'
import { fromHex } from '../src/util/bytes.js'
import { turnCredentials } from './turn.js'

/** Per-socket and global limits; sizes in bytes, durations in milliseconds. */
export interface RelayLimits {
  /** Largest envelope forwarded, measured as the UTF-8 JSON of `{ v, sid, ciphertext }`. */
  maxEnvelopeBytes: number
  /** Time a new socket has to authenticate. */
  authTimeoutMs: number
  /** Frames a socket may send per `rateWindowMs` (a token bucket refilled continuously). */
  rateMessages: number
  rateWindowMs: number
  /** Authenticated sockets one identity may hold at once. */
  maxSocketsPerIdentity: number
  /** Sockets the relay holds at once, authenticated or not. */
  maxSockets: number
  /** Ping interval; a socket that has not answered the previous ping is dropped. */
  pingIntervalMs: number
}

export const DEFAULT_RELAY_LIMITS: Readonly<RelayLimits> = Object.freeze({
  maxEnvelopeBytes: 16384,
  authTimeoutMs: 10000,
  rateMessages: 20,
  rateWindowMs: 10000,
  maxSocketsPerIdentity: 5,
  maxSockets: 10000,
  pingIntervalMs: 30000
})

export interface RelayServerOptions {
  /** Port to listen on (0 picks a free one); default 8787. Ignored with `server`. */
  port?: number
  /** Address to listen on; default all interfaces. Ignored with `server`. */
  host?: string
  /**
   * Attach to this HTTP server instead of creating one. The relay only takes
   * WebSocket upgrades on `path`; it never answers the server's requests and
   * never closes it. Resolves once the server is listening.
   */
  server?: Server
  /** Path of the WebSocket endpoint; default `/`. */
  path?: string
  /**
   * URLs clients may sign (`wss://relay.example`). When set, the Host header is
   * not trusted; otherwise the signed URL must be `ws://` (or `wss://` behind
   * `x-forwarded-proto: https`) + Host + path, without trailing slashes.
   */
  publicUrls?: string[]
  /** Hand authenticated sockets coturn REST credentials for these TURN urls. */
  turn?: { secret: string; urls: string[]; ttlSeconds?: number }
  /** STUN urls handed to authenticated sockets. */
  stunUrls?: string[]
  limits?: Partial<RelayLimits>
  /** Operational messages (never payloads). */
  log?: (msg: string) => void
}

export interface RelayServer {
  /** Local WebSocket URL of the relay, e.g. `ws://127.0.0.1:8787`. */
  url: string
  port: number
  /** Close every socket and, unless attached to a caller's server, stop listening. */
  close(): Promise<void>
  /** Open sockets (authenticated or not) and distinct authenticated identities. */
  stats(): { sockets: number; identities: number }
}

interface Client {
  ws: WsSocket
  stage: 'auth' | 'verifying' | 'open' | 'closed'
  identityKey: PubKeyHex | undefined
  nonce: string
  /** URLs this socket may have signed. */
  authUrls: string[]
  tokens: number
  refilledAt: number
  alive: boolean
  authTimer: ReturnType<typeof setTimeout> | undefined
}

/** Hex DER signature: 1 to 80 bytes. */
const SIGNATURE_HEX = /^(?:[0-9a-f]{2}){1,80}$/
/** Time `close()` waits for a socket's closing handshake before dropping it. */
const CLOSE_WAIT_MS = 1000

/**
 * Start a stateless WebSocket rendezvous for {@link RelaySignaler}s. A socket is
 * challenged with a nonce and must sign it (see `relayAuthData`) within the auth
 * timeout; afterwards it may send `signal` frames, which are forwarded with the
 * authenticated key as `from` to every socket of the recipient. Nothing is stored
 * and payloads are never logged. `GET /health` answers `{"status":"ok"}` on a
 * server the relay created.
 */
export async function createRelayServer(o: RelayServerOptions = {}): Promise<RelayServer> {
  const limits = relayLimits(o.limits)
  const path = trimPath(o.path ?? '/')
  if (!path.startsWith('/')) throw new TypeError('path must start with "/"')
  const pathPart = path === '/' ? '' : path
  const publicUrls = (o.publicUrls ?? []).map(normalizeRelayUrl)
  const stunUrls = [...(o.stunUrls ?? [])]
  const turn = o.turn
  if (turn !== undefined) {
    if (!Array.isArray(turn.urls) || turn.urls.length === 0) {
      throw new TypeError('turn.urls must list at least one TURN url')
    }
    // Validates the secret and ttl now rather than on the first connection.
    turnCredentials({ secret: turn.secret, identityKey: '', ttlSeconds: turn.ttlSeconds })
  }
  const log = o.log ?? (() => {})

  const owned = o.server === undefined
  const http = o.server ?? createServer(health)
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxEnvelopeBytes * 4 })
  const verifier = new ProtoWallet('anyone')
  const clients = new Set<Client>()
  const identities = new Map<PubKeyHex, Set<Client>>()

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (trimPath(requestPath(req)) !== path) {
      if (owned) refuse(socket, '404 Not Found')
      return
    }
    if (clients.size >= limits.maxSockets) {
      refuse(socket, '503 Service Unavailable')
      return
    }
    wss.handleUpgrade(req, socket, head, ws => accept(ws, req))
  }

  function accept(ws: WsSocket, req: IncomingMessage): void {
    const client: Client = {
      ws,
      stage: 'auth',
      identityKey: undefined,
      nonce: randomBytes(32).toString('base64url'),
      authUrls: publicUrls.length > 0 ? publicUrls : requestUrls(req),
      tokens: limits.rateMessages,
      refilledAt: Date.now(),
      alive: true,
      authTimer: undefined
    }
    clients.add(client)
    ws.on('error', () => {})
    ws.on('pong', () => {
      client.alive = true
    })
    ws.on('close', () => forget(client))
    ws.on('message', (data, isBinary) => onFrame(client, data, isBinary))
    client.authTimer = setTimeout(() => refuseAuth(client), limits.authTimeoutMs)
    send(client, { t: 'challenge', nonce: client.nonce })
  }

  /** The URL a client behind this request signs when no public urls are configured. */
  function requestUrls(req: IncomingMessage): string[] {
    const host = req.headers.host
    if (host === undefined || host === '') return []
    const proto = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim()
      .toLowerCase()
    const secure = proto === 'https' || (req.socket as TLSSocket).encrypted === true
    return [normalizeRelayUrl(`${secure ? 'wss' : 'ws'}://${host}${pathPart}`)]
  }

  function onFrame(client: Client, data: RawData, isBinary: boolean): void {
    const allowed = takeToken(client)
    switch (client.stage) {
      case 'auth':
        void authenticate(client, data, isBinary)
        return
      case 'verifying':
        refuseAuth(client)
        return
      case 'open':
        if (allowed) relaySignal(client, data, isBinary)
        else sendError(client, 'rate_limited')
        return
    }
  }

  async function authenticate(client: Client, data: RawData, isBinary: boolean): Promise<void> {
    client.stage = 'verifying'
    const f = isBinary ? undefined : parseJson(data)
    if (
      !isRecord(f) ||
      f.t !== 'auth' ||
      !isIdentityKey(f.identityKey) ||
      typeof f.signature !== 'string' ||
      !SIGNATURE_HEX.test(f.signature)
    ) {
      refuseAuth(client)
      return
    }
    const identityKey = f.identityKey
    const signature = Array.from(fromHex(f.signature))
    let valid = false
    for (const url of client.authUrls) {
      try {
        const result = await verifier.verifySignature({
          data: relayAuthData(url, client.nonce),
          signature,
          protocolID: RELAY_PROTOCOL_ID,
          keyID: client.nonce,
          counterparty: identityKey
        })
        valid = result.valid
      } catch {
        // verifySignature throws for a signature that does not verify
      }
      if (valid) break
    }
    if (client.stage !== 'verifying') return
    if (!valid) {
      refuseAuth(client)
      return
    }
    const sockets = identities.get(identityKey) ?? new Set<Client>()
    if (sockets.size >= limits.maxSocketsPerIdentity) {
      sendError(client, 'rate_limited')
      closeClient(client, 1013, 'too many sockets for this identity')
      return
    }
    clearTimeout(client.authTimer)
    client.stage = 'open'
    client.identityKey = identityKey
    sockets.add(client)
    identities.set(identityKey, sockets)
    send(client, { t: 'ready', identityKey })
    send(client, { t: 'ice', iceServers: iceServersFor(identityKey) })
  }

  function relaySignal(client: Client, data: RawData, isBinary: boolean): void {
    const f = isBinary ? undefined : parseJson(data)
    const envelope = isRecord(f) ? f.envelope : undefined
    if (!isSignalEnvelope(envelope)) {
      sendError(client, 'bad_request')
      return
    }
    const ref = envelope.sid
    if (!isRecord(f) || f.t !== 'signal' || !isIdentityKey(f.to)) {
      sendError(client, 'bad_request', ref)
      return
    }
    const forward = { v: 1, sid: envelope.sid, ciphertext: envelope.ciphertext }
    if (Buffer.byteLength(JSON.stringify(forward)) > limits.maxEnvelopeBytes) {
      sendError(client, 'too_large', ref)
      return
    }
    const frame = JSON.stringify({ t: 'signal', from: client.identityKey, envelope: forward })
    let delivered = 0
    for (const peer of identities.get(f.to) ?? []) {
      if (peer.ws.readyState === WsSocket.OPEN) {
        peer.ws.send(frame)
        delivered++
      }
    }
    if (delivered > 0) send(client, { t: 'sent', ref })
    else sendError(client, 'offline', ref)
  }

  function iceServersFor(identityKey: PubKeyHex): RelayIceServer[] {
    const servers: RelayIceServer[] = []
    if (stunUrls.length > 0) servers.push({ urls: [...stunUrls] })
    if (turn !== undefined) {
      const { username, credential } = turnCredentials({
        secret: turn.secret,
        identityKey,
        ttlSeconds: turn.ttlSeconds
      })
      servers.push({ urls: [...turn.urls], username, credential })
    }
    return servers
  }

  /** Spend one token from the socket's bucket; false when it is empty. */
  function takeToken(client: Client): boolean {
    const now = Date.now()
    const refill = ((now - client.refilledAt) * limits.rateMessages) / limits.rateWindowMs
    client.tokens = Math.min(limits.rateMessages, client.tokens + refill)
    client.refilledAt = now
    if (client.tokens < 1) return false
    client.tokens -= 1
    return true
  }

  function send(client: Client, frame: RelayServerFrame): void {
    if (client.ws.readyState === WsSocket.OPEN) client.ws.send(JSON.stringify(frame))
  }

  function sendError(client: Client, code: RelayErrorCode, ref?: string): void {
    send(client, ref === undefined ? { t: 'error', code } : { t: 'error', code, ref })
  }

  function refuseAuth(client: Client): void {
    if (client.stage === 'open' || client.stage === 'closed') return
    sendError(client, 'auth_failed')
    closeClient(client, 1008, 'auth_failed')
  }

  function closeClient(client: Client, code: number, reason: string): void {
    client.stage = 'closed'
    clearTimeout(client.authTimer)
    client.ws.close(code, reason)
  }

  function forget(client: Client): void {
    client.stage = 'closed'
    clearTimeout(client.authTimer)
    clients.delete(client)
    if (client.identityKey === undefined) return
    const sockets = identities.get(client.identityKey)
    sockets?.delete(client)
    if (sockets?.size === 0) identities.delete(client.identityKey)
  }

  function ping(): void {
    for (const client of clients) {
      if (!client.alive) {
        client.ws.terminate()
        continue
      }
      client.alive = false
      if (client.ws.readyState === WsSocket.OPEN) client.ws.ping()
    }
  }

  http.on('upgrade', onUpgrade)
  try {
    await listening(http, owned ? { port: o.port ?? 8787, host: o.host } : undefined)
  } catch (err) {
    http.off('upgrade', onUpgrade)
    wss.close()
    throw err
  }
  const pinger = setInterval(ping, limits.pingIntervalMs)
  pinger.unref()

  const address = http.address() as AddressInfo
  const url = `ws://${displayHost(address)}:${address.port}${pathPart}`
  log(
    `webrtpay relay listening on ${url}` +
      (publicUrls.length > 0 ? ` (public: ${publicUrls.join(', ')})` : '')
  )

  let closing: Promise<void> | undefined
  async function shutdown(): Promise<void> {
    clearInterval(pinger)
    http.off('upgrade', onUpgrade)
    await Promise.all([...clients].map(closeForShutdown))
    await new Promise<void>(resolve => wss.close(() => resolve()))
    if (owned) {
      await new Promise<void>((resolve, reject) => {
        http.close(err => (err === undefined ? resolve() : reject(err)))
        http.closeAllConnections()
      })
    }
    log('webrtpay relay closed')
  }

  function closeForShutdown(client: Client): Promise<void> {
    return new Promise<void>(resolve => {
      if (client.ws.readyState === WsSocket.CLOSED) {
        resolve()
        return
      }
      const timer = setTimeout(() => client.ws.terminate(), CLOSE_WAIT_MS)
      client.ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      closeClient(client, 1001, 'relay closing')
    })
  }

  return {
    url,
    port: address.port,
    close() {
      closing ??= shutdown()
      return closing
    },
    stats() {
      return { sockets: clients.size, identities: identities.size }
    }
  }
}

function relayLimits(partial: Partial<RelayLimits> = {}): RelayLimits {
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...partial }
  for (const [name, value] of Object.entries(limits)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new RangeError(`limits.${name} must be a positive number`)
    }
  }
  return limits
}

function health(req: IncomingMessage, res: ServerResponse): void {
  if ((req.method === 'GET' || req.method === 'HEAD') && requestPath(req) === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"status":"ok"}')
    return
  }
  res.writeHead(404)
  res.end()
}

function requestPath(req: IncomingMessage): string {
  return (req.url ?? '/').split('?')[0]
}

/** `p` without trailing slashes; `/` stays `/`. */
function trimPath(p: string): string {
  return normalizeRelayUrl(p) || '/'
}

function refuse(socket: Duplex, status: string): void {
  socket.on('error', () => {})
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/** Resolve once `http` is listening, starting it on `at` when given. */
function listening(http: Server, at?: { port: number; host?: string }): Promise<void> {
  if (http.listening) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      http.off('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      http.off('error', onError)
      resolve()
    }
    http.once('error', onError)
    http.once('listening', onListening)
    if (at !== undefined) http.listen(at.port, at.host)
  })
}

/** A host to reach `a` from this machine: loopback for the unspecified addresses. */
function displayHost(a: AddressInfo): string {
  if (a.address === '0.0.0.0' || a.address === '::') return '127.0.0.1'
  return a.family === 'IPv6' ? `[${a.address}]` : a.address
}

function parseJson(data: RawData): unknown {
  const bytes = Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data)
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return undefined
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}
