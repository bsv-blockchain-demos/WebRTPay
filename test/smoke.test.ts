import { describe, expect, it } from '@jest/globals'
import * as api from '../src/index.js'
import { VERSION } from '../src/index.js'

describe('package scaffold', () => {
  it('exports the package version', () => {
    expect(VERSION).toBe('0.1.0')
  })

  it('exports the public API of every module and no internal helpers', () => {
    const names = Object.keys(api)
    const publicNames = [
      // types, util
      'DEFAULTS',
      'isIdentityKey',
      'CHANNEL_LABEL',
      'toBase64',
      'randomBytes',
      'Emitter',
      'WebRTPayError',
      // codec
      'sdpFingerprints',
      'encodeSdp',
      'decodeSdp',
      'encodeOfferCode',
      'encodeAnswerCode',
      'decodeCode',
      'MAX_CODE_LENGTH',
      // channel
      'encodeMessage',
      'FrameDecoder',
      'FRAME_HEADER_BYTES',
      'PeerLink',
      // session
      'authenticate',
      'bindingTranscript',
      'AuthenticatedPeer',
      // payments
      'parseWireMessage',
      'encodePayment',
      'decodePayment',
      'acceptDirectPayment',
      'verifyDirectPayment',
      'paymentKey',
      'createPaymentRequestProof',
      'verifyPaymentRequestProof',
      'normalizePaymentRequest',
      'normalizePaymentRequestResponse',
      // signaling
      'sealSignal',
      'openSignal',
      'ReplayCache',
      'isSignalEnvelope',
      'createMemoryHub',
      'MessageBoxSignaler',
      'RelaySignaler',
      'relayAuthData',
      'normalizeRelayUrl',
      // client
      'DirectPayClient',
      'InboundLimiter',
      'DEFAULT_INBOUND_LIMITS'
    ]
    expect(names).toEqual(expect.arrayContaining(publicNames))
    for (const internal of [
      'plainRecord',
      'tokenFields',
      'invalidPayment',
      'parsePaymentTransaction',
      'dispatchSignal'
    ]) {
      expect(names).not.toContain(internal)
    }
  })
})
