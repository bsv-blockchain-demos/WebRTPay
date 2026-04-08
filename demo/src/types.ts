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
