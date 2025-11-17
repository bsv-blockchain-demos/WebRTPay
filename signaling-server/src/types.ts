/**
 * Types for WebRTPay HTTP Signaling Server
 */

export interface SignalingSession {
  sessionId: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  offererCandidates: RTCIceCandidateInit[];
  answererCandidates: RTCIceCandidateInit[];
  createdAt: number;
  answeredAt?: number;
  expiresAt: number;
}

export interface CreateSessionRequest {
  offer: RTCSessionDescriptionInit;
  iceCandidates?: RTCIceCandidateInit[];
}

export interface CreateSessionResponse {
  sessionId: string;
  sessionUrl: string;
}

export interface JoinSessionRequest {
  answer: RTCSessionDescriptionInit;
  iceCandidates?: RTCIceCandidateInit[];
}

export interface JoinSessionResponse {
  offer: RTCSessionDescriptionInit;
  offererCandidates: RTCIceCandidateInit[];
}

export interface AddCandidateRequest {
  candidate: RTCIceCandidateInit;
  role: 'offerer' | 'answerer';
}

export interface GetCandidatesResponse {
  candidates: RTCIceCandidateInit[];
}

export interface SessionStatusResponse {
  sessionId: string;
  hasOffer: boolean;
  hasAnswer: boolean;
  offererCandidateCount: number;
  answererCandidateCount: number;
  createdAt: number;
  answeredAt?: number;
}
