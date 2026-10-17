/**
 * Real WebRTC for Node tests, backed by node-datachannel's W3C polyfill.
 *
 * The sandbox drops UDP to non-loopback addresses, so every peer binds to 127.0.0.1.
 */

/**
 * The shape A4's `RtcOptions` will take. Defined locally until that type exists.
 */
export interface RtcOptionsLike {
  RTCPeerConnection: typeof globalThis.RTCPeerConnection
  iceServers: RTCIceServer[]
  extraConfig: Record<string, unknown>
}

/** RTC options for a node-datachannel peer bound to loopback, with no STUN or TURN. */
export async function nodeRtc(): Promise<RtcOptionsLike> {
  const { RTCPeerConnection } = await import('node-datachannel/polyfill')
  return {
    // The polyfill implements the DOM interface; only its static side differs.
    RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
    iceServers: [],
    extraConfig: { bindAddress: '127.0.0.1' }
  }
}

/**
 * Release node-datachannel's native threads so jest can exit. Call from `afterAll`
 * once every peer connection in the file is closed; later files can create peers again.
 */
export async function cleanupRtc(): Promise<void> {
  const { cleanup } = await import('node-datachannel')
  cleanup()
}
