/**
 * Core type definitions for WebRTPay connection system
 */

/**
 * Connection bootstrap payload that can be transmitted via QR or remote lookup
 */
export interface BootstrapToken {
  /** WebRTC offer SDP */
  offer: RTCSessionDescriptionInit;
  /** ICE candidates collected during offer creation */
  iceCandidates?: RTCIceCandidateInit[];
  /** Optional metadata for connection context */
  metadata?: {
    /** Timestamp when token was created */
    timestamp: number;
    /** Connection identifier */
    connectionId: string;
    /** Additional custom fields */
    [key: string]: unknown;
  };
}

/**
 * Configuration for STUN/TURN servers
 */
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * WebRTC connection configuration
 */
export interface WebRTCConfig {
  /** ICE servers for NAT traversal */
  iceServers: IceServerConfig[];
  /** ICE transport policy */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** Bundle policy */
  bundlePolicy?: RTCBundlePolicy;
  /** RTC configuration */
  rtcpMuxPolicy?: RTCRtcpMuxPolicy;
}

/**
 * Connection states during lifecycle
 */
export enum ConnectionState {
  IDLE = 'idle',
  CREATING_OFFER = 'creating_offer',
  AWAITING_ANSWER = 'awaiting_answer',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  FAILED = 'failed',
  CLOSED = 'closed'
}

/**
 * Data channel states
 */
export enum DataChannelState {
  CONNECTING = 'connecting',
  OPEN = 'open',
  CLOSING = 'closing',
  CLOSED = 'closed'
}

/**
 * Connection event types
 */
export enum ConnectionEvent {
  STATE_CHANGE = 'stateChange',
  ICE_CANDIDATE = 'iceCandidate',
  DATA_CHANNEL_OPEN = 'dataChannelOpen',
  DATA_CHANNEL_CLOSE = 'dataChannelClose',
  MESSAGE_RECEIVED = 'messageReceived',
  ERROR = 'error'
}

/**
 * Event payloads
 */
export interface ConnectionEventMap {
  [ConnectionEvent.STATE_CHANGE]: { state: ConnectionState };
  [ConnectionEvent.ICE_CANDIDATE]: { candidate: RTCIceCandidate };
  [ConnectionEvent.DATA_CHANNEL_OPEN]: { channel: RTCDataChannel };
  [ConnectionEvent.DATA_CHANNEL_CLOSE]: { channel: RTCDataChannel };
  [ConnectionEvent.MESSAGE_RECEIVED]: { data: unknown };
  [ConnectionEvent.ERROR]: { error: Error };
}

/**
 * Event listener type
 */
export type EventListener<T extends ConnectionEvent> = (
  payload: ConnectionEventMap[T]
) => void;

/**
 * JSON message structure
 */
export interface PaymentMessage {
  /** Message type identifier */
  type: string;
  /** Message payload */
  payload: unknown;
  /** Message timestamp */
  timestamp: number;
  /** Message ID for tracking */
  messageId: string;
}

/**
 * Remote bootstrap service configuration
 */
export interface RemoteBootstrapConfig {
  /** Topic broadcaster service URL */
  broadcasterUrl: string;
  /** Lookup resolver service URL */
  lookupUrl: string;
  /** Token validity in milliseconds */
  tokenValidityMs?: number;
}

/**
 * Connection role in the handshake
 */
export enum ConnectionRole {
  OFFERER = 'offerer',
  ANSWERER = 'answerer'
}

/**
 * Error types
 */
export enum ErrorType {
  BOOTSTRAP_GENERATION_FAILED = 'bootstrap_generation_failed',
  BOOTSTRAP_PARSE_FAILED = 'bootstrap_parse_failed',
  CONNECTION_FAILED = 'connection_failed',
  ICE_FAILED = 'ice_failed',
  DATA_CHANNEL_FAILED = 'data_channel_failed',
  MESSAGE_SEND_FAILED = 'message_send_failed',
  TIMEOUT = 'timeout',
  REMOTE_SERVICE_ERROR = 'remote_service_error',
  SIGNALING_FAILED = 'signaling_failed'
}

/**
 * Custom error class for WebRTPay errors
 */
export class WebRTPayError extends Error {
  constructor(
    public type: ErrorType,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'WebRTPayError';
  }
}
