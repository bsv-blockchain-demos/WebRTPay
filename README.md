# @bsv/webrtpay

Direct wallet-to-wallet BSV payments over WebRTC data channels, authenticated with BRC-100
identity keys.

A payer hands the payee the same `PaymentToken` that PeerPay sends through MessageBox (Atomic
BEEF plus the BRC-29 derivation prefix and suffix), but over an encrypted peer-to-peer data
channel: no server stores it or can read it (when two networks need a TURN relay, the relay
carries only DTLS ciphertext). Both sides prove their identity key bound to the DTLS session,
so whoever carries the signaling cannot read, change, withhold or redirect a payment.

- Browser-safe root entry: no Node builtins; `RTCPeerConnection` from the platform or injected
  (node-datachannel in Node, react-native-webrtc in React Native).
- `@bsv/sdk` is the only (peer) dependency of the root entry. `@bsv/webrtpay/server` (Node) adds
  a small relay and depends on `ws`.
- Status: 0.1.0, experimental. The byte-level protocol is in [docs/protocol.md](docs/protocol.md).

## Why there is still a signaling step

STUN servers cannot coordinate two parties into a WebRTC channel. STUN (RFC 8489) only tells a
client its own public address; it carries no messages between parties. To open a channel each
side needs the other's ICE username fragment and password, DTLS certificate fingerprint and
candidate addresses (RFC 8445 §5.3, §7.2.2), which is the SDP offer and answer, and they have
to travel **both ways** over a channel that already works. TURN (RFC 8656) relays the data
when two NATs cannot be punched through; it does not carry signaling either. A peer that never
receives the answer stays in `checking` forever, and the answerer gives up after about 15 s
(Chromium) or 31 s (libdatachannel).

So the **payment** never needs a server, but the two SDPs (about 1 KB, encrypted) need a
carrier. This package makes the carrier a plug-in:

- in person, two QR codes (`webrtpay1:` offer and answer codes), no server at all;
- remotely, by identity key, through MessageBox or a small relay (`@bsv/webrtpay/server`).

## Install

0.1.0 is not on npm yet. Build a tarball and install that:

```sh
npm ci && npm run build && npm pack      # bsv-webrtpay-0.1.0.tgz
npm install /path/to/bsv-webrtpay-0.1.0.tgz @bsv/sdk
```

Requirements: Node 22 or later, or a browser; `@bsv/sdk` `^2.8.6 || ^3.0.0`; a BRC-100 wallet
(`WalletClient`, a wallet-toolbox `Wallet`, anything with the methods in `WalletLike`). In Node,
inject a WebRTC implementation such as `node-datachannel/polyfill` through `rtc`.

## Quick start

### Receive (payee)

```ts
import { DirectPayClient, MessageBoxSignaler, acceptDirectPayment } from '@bsv/webrtpay'

const originator = 'wallet.example.com'
const client = new DirectPayClient({
  wallet, // a BRC-100 wallet
  originator,
  signaler: new MessageBoxSignaler(messageBoxClient), // a @bsv/message-box-client client
  rtc: { iceServers: [{ urls: 'stun:stun.example.com:3478' }] },
  chain: 'main'
})

const seen = new Set<string>() // persist this: it is what makes a re-delivered payment harmless
await client.startReceiving({
  async onPayment(p) {
    // Checks that output p.token.outputIndex pays this wallet's BRC-29 key for p.sender,
    // then internalizes it once.
    await acceptDirectPayment(wallet, p, {
      originator,
      seen: { has: key => seen.has(key), add: key => void seen.add(key) }
    })
    return 'accepted' // or 'received' (kept for a local retry), or { status: 'rejected', reason }
  },
  onError: e => console.warn('direct payment session failed', e)
})
```

`p.sender` is the identity key the payer proved in the handshake. A handler that throws makes
the ack `rejected`, but by then the payer has usually broadcast the transaction: when a payment
verifies and only internalizing fails for a passing reason (wallet locked, storage down), keep
it, retry locally and return `'received'`. Receiving answers offers
automatically within the inbound limits (3 sessions, 1 per sender, 10 offers a minute, 3 per
sender); see [Security and privacy](#security-and-privacy) before turning it on for users.

### Pay (payer)

Connect first, then create the transaction: if the payee cannot be reached, nothing is spent.

```ts
import { P2PKH, PublicKey } from '@bsv/sdk'
import { PAYMENT_PROTOCOL_ID, randomBytes, toBase64 } from '@bsv/webrtpay'
import type { PaymentToken } from '@bsv/webrtpay'

// 1. Dial and authenticate (30 s budget). Rejects peer_unreachable, rejected ('busy',
//    'not_receiving'), timeout or auth_failed.
const peer = await client.connect(payeeKey)

// 2. Build the payment as PeerPay does: P2PKH to the payee's BRC-29 key for a fresh derivation.
const derivationPrefix = toBase64(randomBytes(32))
const derivationSuffix = toBase64(randomBytes(32))
const { publicKey } = await wallet.getPublicKey(
  {
    protocolID: PAYMENT_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: payeeKey
  },
  originator
)
const lockingScript = new P2PKH().lock(PublicKey.fromString(publicKey).toHash()).toHex()
const { tx } = await wallet.createAction(
  {
    description: 'Direct payment',
    outputs: [{ satoshis: 1000, lockingScript, outputDescription: 'Payment' }],
    options: { randomizeOutputs: false }
  },
  originator
)
const token: PaymentToken = {
  customInstructions: { derivationPrefix, derivationSuffix },
  transaction: tx!,
  amount: 1000,
  outputIndex: 0
}

// 3. Deliver it and wait for the payee's ack (45 s); the session then ends.
const ack = await client.sendPayment(peer, token)
// ack.status: 'accepted' | 'received' | 'rejected' (ack.reason)
```

If `sendPayment` fails after the transaction was broadcast (the channel dropped, the ack timed
out), keep the token: delivering the same token again, directly or through MessageBox, is safe
because the payee acknowledges a payment it already has without internalizing it twice.

### Face to face (code exchange, no server)

The payee shows an offer code; the payer scans it and shows an answer code; the payee scans
that. The payee is the offerer because an offer can wait for minutes while the answer must be
applied within about 15 s (the answerer's ICE timer), and the payee is the one scanning then.
Pasting codes through a chat app usually misses that window.

```ts
// showQr, scanQr and confirmWithUser stand for your UI.

// Payee: no signaler needed. `handlers` are ReceiveHandlers, as for startReceiving.
const offer = await client.createOfferCode({ amount: 1000, expiresInMs: 5 * 60_000, handlers })
showQr(offer.code)
const payerSession = await offer.complete(await scanQr()) // payerSession.peerIdentityKey

// Payer: refuses an expired code and one for another network than `chain`.
const answer = await client.answerOfferCode(await scanQr())
await confirmWithUser(answer.offer.identityKey, answer.offer.amount) // who, and how much
showQr(answer.answerCode)
const peer = await answer.connected // the payee proved answer.offer.identityKey
const ack = await client.sendPayment(peer, token)
```

An offer code carries the payee's identity key, network, optional amount and expiry and its
SDP in a compact binary form (roughly 250 characters for a typical browser offer, a QR code of
version 10 or so). An answer code carries only the session id and the SDP: the payer's
identity comes from the handshake.

A runnable version of the remote flow is [examples/demo-node.ts](examples/demo-node.ts): two
wallets in one process, a real WebRTC channel, an in-memory signaler.

```sh
npm run build && node --experimental-strip-types examples/demo-node.ts
```

## Signalers

A `Signaler` carries already-encrypted envelopes between identity keys; it never sees an SDP.

| Signaler | Server | Use |
| --- | --- | --- |
| code exchange (`createOfferCode`, `answerOfferCode`) | none | in person, by QR |
| `MessageBoxSignaler(client, options?)` | an existing MessageBox | remote, no new infrastructure |
| `RelaySignaler(options)` | `@bsv/webrtpay/server` | remote, low latency, can vend TURN credentials |
| `createMemoryHub().signaler(key)` | none (one process) | tests and demos |

**`MessageBoxSignaler`** is typed structurally against the `MessageBoxClient` methods it uses
(`sendMessage`, `listMessages`, `acknowledgeMessage`), so there is no dependency on
`@bsv/message-box-client`; a `PeerPayClient` works too. It sends over HTTP to the recipient's
own host, polls box `webrtpay_signals` every 2.5 s (1 s while dialing) and acknowledges every
message as soon as it reads it. Options: `messageBox`, `idlePollMs`, `activePollMs`, and
`host`, the MessageBox host to list and acknowledge on (sending always resolves the
recipient's host, so payer and payee may use different servers).

**`RelaySignaler`** keeps one authenticated WebSocket to a relay, and only while it is needed:
while subscribed, while a send is in flight, or after `connect()`. Options: `url` (`ws:` or
`wss:`), `wallet`, `originator`, `WebSocket` (defaults to the global one), `onIceServers`,
`onStateChange` and `random`.

- `listen()` resolves once the connection is authenticated or the first attempt has failed. The
  subscription stays either way, and while it lasts a lost or refused connection is retried in
  the background after a random delay whose cap doubles with each failure, up to 30 s.
  `onStateChange` reports `connecting`, `online` and `offline` (`RelayConnectionState`); use it
  for a "receiving" indicator.
- The relay answers each frame in order; a reply that does not match ends the connection with
  `protocol` rather than being matched to a later frame.
- `requestTurn()` asks for TURN credentials and resolves with the full ICE server list;
  `iceServers()` returns the latest list without expired TURN entries.

Anything with `send`, `listen` and optionally `setActive` can be a signaler; see `Signaler` in
`src/signaling/types.ts`.

## ICE servers and TURN

`rtc.iceServers` (STUN and TURN servers) applies to every link; `updateRtc()` changes it for
links created later. For short-lived TURN credentials pass `iceServersProvider`, which is asked
before every ICE gather (dialing, answering an offer, creating or answering an offer code):

```ts
const relay = new RelaySignaler({ url: 'wss://relay.example.com', wallet, originator })
const client = new DirectPayClient({
  wallet,
  originator,
  signaler: relay,
  chain: 'main',
  rtc: { iceServers: [{ urls: 'stun:stun.example.com:3478' }] },
  iceServersProvider: async () => {
    // Every requestTurn() spends one of this address's credentials (6 an hour by default):
    // reuse the last ones while they are valid.
    const held = relay.iceServers() ?? []
    const hasTurn = held.some(s => [s.urls].flat().some(url => /^turns?:/.test(url)))
    return hasTurn ? held : relay.requestTurn()
  }
})
```

The provider's servers are merged with `rtc.iceServers`; an entry with the same set of urls is
replaced by the provider's. A provider that throws, rejects, returns something other than an
array or takes more than 5 s is passed over and the gather uses `rtc.iceServers` alone, so a
dial never fails because of it.

## Security model

- **Identity bound to the channel.** After the data channel opens, each side sends `hello`
  (identity key, fresh 32-byte nonce), then `auth`: a signature under protocol
  `[2, 'webrtpay channel']` over a transcript of both sides' DTLS fingerprints, both nonces and
  both keys. A man in the middle has to terminate DTLS separately with each side, so each sees
  a different remote fingerprint and neither signature verifies; the session closes before any
  payment byte is sent. Each side then raises its message cap from 64 KiB to the full size and
  sends `ready`; nothing else may be sent before both `ready`s. Fingerprint verification is
  never disabled.
- **Pinned peers.** The payer pins the identity it means to pay (the dialed key, or the key in
  the offer code); any other key closes the session. The payee learns the payer from the
  handshake, as MessageBox gives it the authenticated sender.
- **Funds safety does not depend on any of that.** The payee accepts a payment only if output
  `outputIndex` is P2PKH to its own key derived with `[2, '3241645161d8']`, keyID
  `"<prefix> <suffix>"`, counterparty the payer, and carries exactly the stated amount.
- **Encrypted signaling.** Offers, answers and rejects are BRC-2 encrypted under
  `[2, 'webrtpay signaling']` to the recipient, must name the carrier's sender and recipient,
  must be within ±120 s, and each session id is accepted once. A carrier sees only
  `{ v, sid, ciphertext }`.
- **Hostile input.** Frames, codes, envelopes and messages are parsed with fixed bounds (frame
  and message caps, JSON depth 32 and 4096 structural tokens before `JSON.parse`, strict
  base64/hex/UTF-8, unknown fields dropped). A violation closes the session with an error code;
  nothing throws out of the client.
- **Connect first, then pay; deliver idempotently.** The payer spends only after the payee has
  authenticated. `acceptDirectPayment` records each payment it internalizes
  (`txid:outputIndex:prefix:suffix`) in the `seen` store it is given and reports a re-delivery
  as `duplicate` without a second `internalizeAction`; the client decides concurrent deliveries
  of one payment once.

## Security and privacy

Read this before enabling receiving for users.

- **What carriers learn.** The MessageBox host or relay, and Cloudflare or any proxy that
  terminates TLS in front of them, see both identity keys, both IP addresses, the timing and
  the size of every offer, answer and reject. MessageBox stores each encrypted signal until it
  is acknowledged (the signaler acknowledges as soon as it reads); a receiving wallet polls it
  every 2.5 s, which shows when it is online. Carriers never see the payment.
- **Receiving reveals your IP address and online status.** While receiving is on, any wallet
  that knows your identity key can send an offer and get an answer containing your public IP
  address, and learn that your wallet is online, without paying you. The inbound limits bound
  the load, not this disclosure (offers refused by the limits gather no addresses). Make
  receiving opt-in; BSV Desktop has it off by default.
- **Dialing reveals the payer's IP address to the payee**, and both codes in a face-to-face
  exchange show the sender's candidate addresses to anyone who can read the QR code. Browsers
  hide LAN addresses behind mDNS names; Electron apps must allow that (BSV Desktop installs a
  permission check handler); Node does not hide them. The STUN and TURN servers you configure
  see the address of each side that gathers.
- **The relay is a presence oracle.** Its `offline` reply tells any authenticated key whether
  another identity is connected right now. It is a known trade-off, kept so that a dial to a
  payee who is not listening fails at once instead of after 30 s; `RelaySignaler` holds a
  socket only while receiving or dialing, so the oracle shows exactly that. A client that is
  dialing but not receiving answers offers with `not_receiving`, which also shows it is online.
- **The protocol IDs are ordinary BRC-43 protocols.** `[2, 'webrtpay channel']`,
  `[2, 'webrtpay signaling']` and `[2, 'webrtpay relay']` can be used by any originator the
  wallet allows. The channel binding therefore proves "an originator with signing permission
  for `[2, 'webrtpay channel']` (for this counterparty) on this key's wallet controls the
  endpoint". Wallets should prompt other originators before signing under
  `[2, 'webrtpay channel']`, and a wallet that answers automatically should use its own admin
  originator.
- **TURN.** Relay-issued TURN usernames are pseudonyms (`<expiry>:<HMAC of the identity key>`),
  but they travel in the clear on `turn:` urls. Do not run coturn verbose or with its Redis
  stats database, which log them.

## Relay server

`@bsv/webrtpay/server` is a stateless WebSocket rendezvous: it authenticates sockets by
identity key, forwards envelopes between them, and can issue ephemeral TURN credentials for a
coturn server. It stores nothing and never logs payloads.

```sh
PUBLIC_URLS=wss://relay.example.com TRUSTED_IP_HEADER=cf-connecting-ip npx webrtpay-relay
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | Port to listen on. |
| `HOST` | `0.0.0.0` | Address to listen on. |
| `PUBLIC_URLS` | — | Comma-separated `wss://` urls clients dial; clients sign the one they use. **Required in production**: the relay refuses to start without it unless `HOST` is a loopback address, because otherwise clients sign a url built from the `Host` header, which the client chooses. Set it whenever a proxy fronts the relay, even on loopback. |
| `TRUSTED_IP_HEADER` | — | Header the outermost proxy sets to the client's single address, for the per-source limits: `cf-connecting-ip` behind Cloudflare. Without it every client behind a proxy shares the proxy's limits. `x-forwarded-for` is right only behind exactly one proxy that overwrites it. |
| `STUN_URLS` | — | Comma-separated STUN urls handed to every authenticated socket. |
| `TURN_SECRET` | — | coturn `static-auth-secret`; requires `TURN_URLS`. |
| `TURN_URLS` | — | Comma-separated TURN urls to issue credentials for; requires `TURN_SECRET`. |
| `TURN_TTL` | `600` | Lifetime of issued TURN credentials, in seconds. |

- `GET /health` answers `{"status":"ok"}`. `SIGTERM` or `SIGINT` closes every socket and exits.
- At startup it warns when there are no public urls (development only) and when `PUBLIC_URLS`
  is set without `TRUSTED_IP_HEADER`.
- Connections are admitted per source address (IPv6 by /64) before the WebSocket upgrade:
  more than 20 sockets or 30 new connections a minute from one source get `HTTP 429`; more
  than 10000 sockets, or 1000 not yet authenticated, get `HTTP 503`.
- An authenticated socket may send 20 frames per 10 s; an identity may hold 5 sockets and
  receive 30 signals a minute from all senders together.
- TURN credentials are issued only on request (`{ t: 'turn' }`), at most 6 an hour per source
  address and 600 an hour in total, valid for `TURN_TTL`. The username is `<expiry>:<pseudonym>`
  (`credential = base64(HMAC-SHA1(secret, username))`), so coturn needs `use-auth-secret`.
  Identities are free, so in production also give coturn its own quotas (`--total-quota`,
  `--max-bps`, `--denied-peer-ip` for private ranges); `--user-quota` alone does not stop
  fresh keys.

In code, `createRelayServer(options)` takes the same settings (`port`, `host`, `publicUrls`,
`trustedIpHeader`, `stunUrls`, `turn: { secret, urls, ttlSeconds }`) plus `server` (attach to
an existing HTTP server), `path`, `limits` (see `DEFAULT_RELAY_LIMITS`), `log` and, for
development only, `trustHostHeader`. It resolves to `{ url, port, close(), stats() }`.
`docker/relay.Dockerfile` builds an image running `dist/server/cli.js` as a non-root user.

## Running the local STUN/TURN stack

`docker/` runs coturn (STUN and TURN with REST credentials) and the relay, for development and
the TURN tests:

```sh
docker compose -f docker/docker-compose.yml up -d --build
npm run test:turn
docker compose -f docker/docker-compose.yml down
```

- coturn 4.18.0 listens on `127.0.0.1:3478` (UDP and TCP) with relay ports 49160–49200; the
  relay on `ws://127.0.0.1:8787` hands out `stun:127.0.0.1:3478` and credentials for
  `turn:127.0.0.1:3478`. Everything is published on 127.0.0.1 only. The secret
  `webrtpay-dev-secret` is public: never deploy this stack.
- coturn has a fixed address, 172.30.78.10 on subnet 172.30.78.0/24; if that clashes with a
  network on your machine, change it in `docker-compose.yml` (two places) and `turnserver.conf`.
- `external-ip=127.0.0.1/172.30.78.10` has a private half on purpose. coturn maps a peer address
  equal to its advertised address back to its relay address; with a bare `external-ip` and a
  `0.0.0.0` listener that relay address is `0.0.0.0` and coturn refuses every peer with
  `403 Forbidden IP`. `allowed-peer-ip=172.30.78.10` is a development-only exception to the
  private-range deny list.
- `npm run test:turn` runs the normal suite plus `test/turn.test.ts`: two relay-only peers,
  a full payment over TURN with `RelaySignaler.requestTurn` as `iceServersProvider`, and the
  compose relay's credentials against the compose coturn. That last test spends one of the
  relay's 6 credentials an hour for Docker's gateway address; if a run fails with
  `rate_limited`, run `docker compose -f docker/docker-compose.yml restart relay`.
- node-datachannel's polyfill hands TURN servers to libdatachannel as
  `turn:<username>:<credential>@host` urls, which cuts a REST username at its colon, and coturn
  then refuses it. `turnRtc()` in `test/helpers/rtc.ts` passes TURN servers as native
  `IceServer` objects instead; a Node app that uses relay-issued TURN with node-datachannel
  needs the same.

## React Native

Inject the platform's peer connection:

```ts
import { RTCPeerConnection } from 'react-native-webrtc'

const client = new DirectPayClient({
  wallet,
  signaler,
  rtc: { RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection }
})
```

The root entry also needs `TextEncoder`, `TextDecoder` with `{ fatal: true }`,
`crypto.getRandomValues` (for example from `react-native-get-random-values`) and
`queueMicrotask`; `RelaySignaler` uses the global `WebSocket` unless given one. It uses no
Node builtins, `Buffer` or `process` (`test/browser-safety.test.ts` enforces this). It has not
been run on React Native.

## Development

| Command | What |
| --- | --- |
| `npm run build` | Compile `src/` and `server/` to `dist/` (`dist/src/index.js`, `dist/server/cli.js`). |
| `npm test` | All tests (jest, ESM); the TURN suite is skipped. |
| `npm run test:turn` | Also the TURN suite (needs the Docker stack). |
| `npm run typecheck` | `tsc --noEmit` over `src/`, `server/`, `test/` and `examples/`. |
| `npm run format:check` | Prettier (no semicolons, single quotes, width 100). |

Node tests run real WebRTC with node-datachannel bound to `127.0.0.1`.

## Verification

What the test suite exercises (`npm test`: 651 tests at 0.1.0; `npm run test:turn` adds 3 TURN
tests):

- codes, compact SDP, frames: unit tests plus fast-check property suites with hostile input
  (truncation, oversized and out-of-order frames, JSON depth and width bombs);
- the identity handshake with real keys (`ProtoWallet`) over real node-datachannel loopback
  connections: swapped fingerprints, a relay forwarding the handshake between two links, wrong
  keys, an echoed nonce, messages before authentication, the published transcript test vector;
- full payments between two `DirectPayClient`s over loopback WebRTC, through the in-memory hub
  and through a real relay over `ws`, and by code exchange: a 2 MiB transaction, acks, the
  payee dropping mid-payment, duplicate and concurrent delivery, offline and refusing payees,
  inbound limits and intake budgets, timeouts;
- the relay: authentication and URL binding, limits, TURN issuance, admission, liveness;
- `MessageBoxSignaler` against a fake MessageBox client;
- the relayed path through a real coturn 4.18.0 in Docker (`npm run test:turn`);
- the examples in `docs/protocol.md`, recomputed from the code (`test/protocol-doc.test.ts`);
- the demo, `examples/demo-node.ts`, which pays through the built package and prints an
  `accepted` ack.

Not verified:

- any browser end to end: no Chromium, Firefox or Safari peer connected to another peer in
  these tests. A research prototype of the compact SDP was accepted by Chromium as both offer
  and answer; whether Chromium accepts the rebuilt `raddr ::` for IPv6 candidates is unchecked;
- React Native;
- real networks: the test sandbox drops UDP to non-loopback addresses, so NAT traversal and
  Electron-to-Electron across networks are untested;
- TURN in production (only the local coturn), and a real MessageBox server;
- real BRC-100 wallets other than `ProtoWallet` (`internalizeAction` is mocked in the tests);
- that the redeclared PeerPay types stay assignable to `@bsv/message-box-client`'s (kept by
  hand; no type-level test, since it is not a dependency).

## License

Open BSV License Version 6; see [LICENSE.txt](LICENSE.txt).
