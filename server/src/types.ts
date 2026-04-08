export interface JoinRoomPayload {
  roomId: string
}

export interface ForwardPayload {
  to: string
  sdp: unknown
}

export interface IceCandidatePayload {
  to: string
  candidate: unknown
}

export interface PeerInfo {
  socketId: string
  identityKey: string
}

export interface PeerLeftPayload {
  socketId: string
  identityKey: string | undefined
}

export interface ErrorPayload {
  message: string
}
