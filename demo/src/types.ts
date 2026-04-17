export interface Peer {
  socketId: string
  identityKey: string
}

export interface OfferMessage {
  from: string
  identityKey: string
  sdp: RTCSessionDescriptionInit
}

export interface AnswerMessage {
  from: string
  sdp: RTCSessionDescriptionInit
}

export interface IceCandidateMessage {
  from: string
  candidate: RTCIceCandidateInit
}

// --- Payment protocol (shapes borrowed from ts-message-box-client) ---

export interface PaymentRequest {
  type: 'payment-request'
  requestId: string          // unique ID, use crypto.randomUUID()
  senderIdentityKey: string  // requester's identity key
  amount: number             // satoshis
  description: string        // human-readable reason
  expiresAt: number          // Unix ms timestamp
  requestProof: string       // HMAC proof binding this request to the counterparty
}

export interface PaymentToken {
  customInstructions: {
    derivationPrefix: string
    derivationSuffix: string
  }
  transaction: number[]      // AtomicBEEF serialized as number array for JSON transport
  amount: number
  outputIndex?: number
}

export interface PaymentResponse {
  type: 'payment-response'
  requestId: string          // references the original PaymentRequest
  txid: string               // transaction ID for display
  token: PaymentToken        // full settlement token — receiver calls internalizeAction on this
}

export interface PaymentDeclined {
  type: 'payment-declined'
  requestId: string
}

export interface PaymentCancel {
  type: 'payment-cancel'
  requestId: string          // cancels a previously sent PaymentRequest
}

export type ChannelMessage =
  | PaymentRequest
  | PaymentResponse
  | PaymentDeclined
  | PaymentCancel
