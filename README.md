# WebRTPay

A BSV wallet payment demonstration that exchanges payment requests and transaction data over WebRTC. An authenticated signalling server introduces peers in a shared room; their browsers then use a WebRTC data channel for the payment exchange.

The repository also contains an earlier TypeScript connection library with QR and remote bootstrap helpers. The current payment demo uses its own signalling and WebRTC hooks, so the two entry points have different connection flows.

## Repository layout

| Location | Purpose |
| --- | --- |
| `demo/` | React payment application with wallet connection, room invitations and BRC-29 settlement |
| `server/` | Express and `@bsv/authsocket` signalling service; keeps rooms and peers in memory |
| `src/` | Earlier connection library, QR helpers and JSON message protocol |
| `docker-compose.yml` | Local Coturn and demo services; does not include the signalling server |

## Run the payment demo

Use Node.js 22, npm, Bun for the server's committed lockfile, and two compatible BRC-100 wallet identities. Both wallets must use the same network. Accepting a payment request creates an actual wallet payment, so use wallets funded for your chosen demonstration.

```sh
git clone https://github.com/bsv-blockchain-demos/WebRTPay.git
cd WebRTPay
npm ci
npm --prefix demo ci
```

Install the signalling server using its Bun lockfile:

```sh
cd server
bun install --frozen-lockfile
cp .env.example .env
```

Set these values in `server/.env`:

| Variable | Purpose |
| --- | --- |
| `SERVER_PRIVATE_KEY` | Dedicated server identity private key in hex, required for authenticated sockets. |
| `CORS_ORIGIN` | Allowed frontend origin, for example `http://localhost:3000`. |
| `PORT` | Signalling port, default `8080`. |

Start it from `server/`:

```sh
npm run dev
```

In a second terminal, enter `demo/`, copy `.env.example` to `.env`, and configure:

| Variable | Purpose |
| --- | --- |
| `VITE_SIGNALING_URL` | Browser-reachable signalling origin, default `http://localhost:8080`. |
| `VITE_TURN_URL` | Optional TURN URL for peers that cannot connect directly. |
| `VITE_TURN_USERNAME` | TURN username, used with the URL and credential. |
| `VITE_TURN_CREDENTIAL` | TURN credential. This is delivered to browsers in the frontend bundle. |

```sh
npm run dev
```

Open [localhost:3000](http://localhost:3000). Share the full page URL, including its `#room-id` fragment, with the second participant. The QR code contains this invitation URL. Both peers need the same room; independently opening the bare URL creates separate rooms.

Select a peer, accept the connection, then request an amount in satoshis. The payer can accept or decline. Acceptance builds a BRC-29 payment, sends its Atomic BEEF and remittance data over the channel, and lets the recipient wallet import it. The interface tracks pending, paid, declined and expired requests.

See the [demo README](demo/README.md) for device testing and troubleshooting.

## Network configuration

Localhost works for two browser sessions on one computer. For separate devices, use browser-reachable frontend and signalling URLs, HTTPS for the frontend, and secure signalling. Update `demo/vite.config.ts` if your development hostname is not allowed.

The demo uses public STUN servers by default. Configure all three TURN variables when relay connectivity is needed. `docker compose up -d coturn` starts the supplied local TURN service, but its test credentials and local configuration need to be replaced for a shared deployment. Compose does not start the authenticated signalling server.

Rooms and peer membership are in memory. Restarting the server disconnects signalling sessions, and the server is not configured for multiple coordinated instances. The room link identifies a room, rather than defining a persistent access-control policy.

## Connection library

The root package is named `webrtpay` and builds its TypeScript library into `dist/`:

```sh
npm run build
npm run type-check
```

[`src/index.ts`](src/index.ts) exports the connection manager, bootstrap helpers, protocol and types. The main APIs include:

| API | Purpose |
| --- | --- |
| `createConnectionManager(config)` | Create the connection and message manager |
| `createQRConnection(useTrickleICE)` | Generate an offer and QR data |
| `joinQRConnection(token)` | Consume an offer and produce the answer in traditional mode |
| `completeQRConnection(answerToken)` | Apply the answer on the offerer's side |
| `publishRemoteConnection(username)` / `joinRemoteConnection(username)` | Use separately supplied remote publish and lookup services |
| `send(type, payload)` / `onMessage(type, handler)` | Exchange structured messages over an established channel |
| `getState()` / `isReady()` / `close()` | Inspect or close the connection |

The library's default QR mode attempts to return its answer over the data channel that is still being established. It is experimental. The current demo avoids this path by exchanging offers, answers and ICE candidates through `server/`. The remote bootstrap HTTP APIs are also separate from that server's socket room protocol.

The library's generic payment messages do not by themselves execute wallet transfers. The actual BRC-29 settlement integration is in `demo/src/App.tsx`.

## Checks and known issues

- Root `npm run build` and `npm run type-check` compile the connection library.
- In `server/`, `bun install --frozen-lockfile` uses the committed dependency versions. A fresh `npm install` currently resolves a newer `@bsv/authsocket` that conflicts with the pinned SDK; there is no server npm lockfile.
- In `demo/`, `npm run build` bundles successfully, while `npm run type-check` currently reports errors in `App.cp.tsx`, `useSignaling.ts` and the root `WebRTCConnection.ts`. A Vite build alone is not a clean type check.
- No automated test suite is configured. A full demonstration needs two wallets and a working signalling connection; build checks do not verify settlement or mobile connectivity.

Older guides such as [GETTING_STARTED.md](GETTING_STARTED.md), [EXAMPLES.md](EXAMPLES.md) and [TRICKLE_ICE.md](TRICKLE_ICE.md) describe the earlier library workflow. Use this README and the demo README for the current payment application.

## Licence

**Library licence declaration: MIT.** See the [root package manifest](package.json). The [demo](demo/package.json) and [signalling server](server/package.json) packages have no separate licence declaration. No standalone licence file is included in this repository.

## Contributions

See [CONTRIBUTING.md](CONTRIBUTING.md) for the existing contribution guide. Report reproducible problems through the [repository issues](https://github.com/bsv-blockchain-demos/WebRTPay/issues), including which component and commands were involved.
