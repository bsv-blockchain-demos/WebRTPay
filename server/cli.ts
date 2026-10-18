#!/usr/bin/env node
import { relayOptionsFromEnv } from './env.js'
import { createRelayServer } from './relay.js'

// webrtpay-relay: configured by PORT, HOST, PUBLIC_URLS, TRUSTED_IP_HEADER,
// STUN_URLS, TURN_SECRET, TURN_URLS and TURN_TTL (see relayOptionsFromEnv). It
// refuses to start without PUBLIC_URLS unless HOST is a loopback address. SIGTERM
// or SIGINT closes it.
try {
  const relay = await createRelayServer({
    ...relayOptionsFromEnv(process.env),
    log: msg => console.log(msg)
  })
  const stop = (): void => {
    relay.close().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error(err)
        process.exit(1)
      }
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
} catch (err) {
  console.error(`webrtpay-relay: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
