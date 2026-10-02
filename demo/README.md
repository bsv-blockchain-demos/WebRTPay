# WebRTPay payment demo

React application for connecting BSV wallet users in a shared room and exchanging BRC-29 payments over a WebRTC data channel. The active application is [`src/App.tsx`](src/App.tsx); `App.cp.tsx` is an older implementation and is not the entry point.

## Setup

Follow the [root setup](../README.md#run-the-payment-demo) to install dependencies and start the authenticated signalling server on port 8080. The demo also needs root dependencies for older demo files that import the library source.

From `demo/`:

```sh
npm ci
cp .env.example .env
npm run dev
```

Set `VITE_SIGNALING_URL` to the signalling server origin, normally `http://localhost:8080` for local development. Optional TURN settings are `VITE_TURN_URL`, `VITE_TURN_USERNAME` and `VITE_TURN_CREDENTIAL`; all three are needed to add a TURN server.

Open [localhost:3000](http://localhost:3000) with a compatible BRC-100 wallet. The app requests the wallet's public identity key before connecting to signalling.

## Try a payment

1. Open the application and connect the first wallet.
2. Copy the full invitation URL, including the `#room-id` fragment, or share the displayed QR code.
3. Open that invitation with a second wallet identity. Both participants should appear in the same room.
4. Select the peer and accept the incoming connection on the other device.
5. Enter a positive whole-number amount in satoshis and send a payment request.
6. Accept or decline on the receiving side. Acceptance spends from that wallet and sends the settlement transaction to the requester, whose wallet imports it.

Requests expire after ten minutes. The interface displays payment status and transaction identifiers. Payment history is held in React state and is cleared on disconnection or page reload; it is not a persistent accounting ledger.

The QR code shares a room URL. The active application does not use the older library's in-page camera scanning or username lookup flow.

## Two-device configuration

Both devices must reach the frontend and signalling server. A phone cannot use the development computer's `localhost` address. Use HTTPS and secure signalling for a hosted or tunnelled setup, set `VITE_SIGNALING_URL` accordingly, and allow the frontend origin in the server's `CORS_ORIGIN`.

Vite's allowed development hosts are listed in [`vite.config.ts`](vite.config.ts). Add your chosen tunnel hostname if necessary. Public STUN servers are configured in [`src/hooks/useWebRTC.ts`](src/hooks/useWebRTC.ts); provide TURN settings for networks that require a relay.

Frontend environment values are embedded when Vite builds the bundle. Rebuild after changing a deployed signalling URL or TURN configuration.

## Checks

```sh
npm run build
npm run type-check
npm run preview
```

`build` writes static assets to `dist/`. The preview server serves that bundle; it does not start signalling.

The current Vite build passes, but the TypeScript check fails on unused declarations and an outdated call in `App.cp.tsx`, plus unused declarations in `useSignaling.ts` and the root `WebRTCConnection.ts`. There is no automated test script. Wallet settlement and connectivity require a functional check with two participants.

## Source map

- [`src/App.tsx`](src/App.tsx): wallet connection, invitations, requests and BRC-29 settlement
- [`src/hooks/useSignaling.ts`](src/hooks/useSignaling.ts): authenticated room membership and peer discovery
- [`src/hooks/useWebRTC.ts`](src/hooks/useWebRTC.ts): offers, answers, ICE candidates and data channel lifecycle
- [`src/types.ts`](src/types.ts): signalling and payment message types

## Troubleshooting

- **Wallet connection fails:** start a compatible wallet and approve the app's identity-key request.
- **No peers appear:** use the same complete invitation URL, check the signalling server, and verify its allowed origin.
- **A peer appears but connection fails:** check STUN/TURN reachability and browser WebRTC support.
- **Payment fails:** check the payer's funds, both wallets' network selection and the reported wallet error.
- **Port 3000 is occupied:** use `npm run dev -- --port 3001` and update the server's allowed frontend origin.

## Licence

The root library declares the **MIT licence**. This demo's [package.json](package.json) has no separate licence declaration. See the [repository licence section](../README.md#licence) for component declarations. No standalone licence file is included in this repository.
