/**
 * Core WebRTC connection manager
 * Handles peer connection lifecycle, ICE negotiation, and data channel management
 */

import {
  BootstrapToken,
  WebRTCConfig,
  ConnectionState,
  ConnectionEvent,
  ConnectionEventMap,
  EventListener,
  ConnectionRole,
  ErrorType,
  WebRTPayError,
  PaymentMessage
} from './types';

/**
 * Default WebRTC configuration with public STUN servers
 */
export const DEFAULT_WEBRTC_CONFIG: WebRTCConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceTransportPolicy: 'all',
  bundlePolicy: 'balanced'
};

export class WebRTCConnection {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private state: ConnectionState = ConnectionState.IDLE;
  private role: ConnectionRole | null = null;
  private eventListeners: Map<ConnectionEvent, Set<EventListener<any>>> = new Map();
  private iceCandidatesBuffer: RTCIceCandidate[] = [];
  private connectionId: string;
  private trickleIceEnabled: boolean = false;
  private pendingIceCandidates: RTCIceCandidateInit[] = [];

  constructor(
    private config: WebRTCConfig = DEFAULT_WEBRTC_CONFIG
  ) {
    this.connectionId = this.generateConnectionId();
  }

  /**
   * Generate unique connection identifier
   */
  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Filter problematic SDP attributes for cross-browser compatibility
   * Note: We keep a=sctp-port: because it's required for data channel negotiation
   */
  private filterSDP(sdp: string): string {
    return sdp
      .split('\n')
      .filter(line => !line.startsWith('a=max-message-size:'))
      // Do NOT filter a=sctp-port: - it's required for data channels!
      .join('\n');
  }

  /**
   * Get current connection state
   */
  public getState(): ConnectionState {
    return this.state;
  }

  /**
   * Get connection ID
   */
  public getConnectionId(): string {
    return this.connectionId;
  }

  /**
   * Register event listener
   */
  public on<T extends ConnectionEvent>(
    event: T,
    listener: EventListener<T>
  ): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  /**
   * Remove event listener
   */
  public off<T extends ConnectionEvent>(
    event: T,
    listener: EventListener<T>
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit event to all registered listeners
   */
  private emit<T extends ConnectionEvent>(
    event: T,
    payload: ConnectionEventMap[T]
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          listener(payload);
        } catch (error) {
          console.error(`Error in event listener for ${event}:`, error);
        }
      });
    }
  }

  /**
   * Update connection state and emit event
   */
  private setState(newState: ConnectionState): void {
    if (this.state !== newState) {
      this.state = newState;
      this.emit(ConnectionEvent.STATE_CHANGE, { state: newState });
    }
  }

  /**
   * Initialize peer connection with ICE server configuration
   */
  private initializePeerConnection(): RTCPeerConnection {
    if (this.peerConnection) {
      this.peerConnection.close();
    }

    const pc = new RTCPeerConnection(this.config);

    // Handle ICE candidate events
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`[ICE] New candidate (${this.role}):`, event.candidate.candidate);
        this.iceCandidatesBuffer.push(event.candidate);
        this.emit(ConnectionEvent.ICE_CANDIDATE, { candidate: event.candidate });

        // In trickle ICE mode, send candidates through data channel as they arrive
        if (this.trickleIceEnabled && this.dataChannel && this.dataChannel.readyState === 'open') {
          console.log('[ICE] Sending candidate through data channel');
          this.sendIceCandidateThroughDataChannel(event.candidate);
        } else if (this.trickleIceEnabled) {
          // Queue candidate to send when data channel opens
          console.log('[ICE] Queuing candidate for later (data channel not open yet)');
          this.pendingIceCandidates.push(event.candidate.toJSON());
        }
      } else {
        console.log(`[ICE] Gathering complete (${this.role})`);
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      console.log(`[PEER CONNECTION] State changed to: ${pc.connectionState} (role: ${this.role})`);
      switch (pc.connectionState) {
        case 'connected':
          console.log(`[PEER CONNECTION] Successfully connected! (role: ${this.role})`);
          this.setState(ConnectionState.CONNECTED);
          break;
        case 'disconnected':
          this.setState(ConnectionState.DISCONNECTED);
          break;
        case 'failed':
          this.setState(ConnectionState.FAILED);
          this.emit(ConnectionEvent.ERROR, {
            error: new WebRTPayError(
              ErrorType.CONNECTION_FAILED,
              'WebRTC connection failed'
            )
          });
          break;
        case 'closed':
          this.setState(ConnectionState.CLOSED);
          break;
      }
    };

    // Handle ICE connection state changes
    pc.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        this.emit(ConnectionEvent.ERROR, {
          error: new WebRTPayError(
            ErrorType.ICE_FAILED,
            'ICE connection failed - check STUN/TURN configuration'
          )
        });
      }
    };

    // Handle incoming data channels (answerer side)
    pc.ondatachannel = (event) => {
      console.log(`[DATA CHANNEL] Received data channel from peer (role: ${this.role})`);
      console.log(`[DATA CHANNEL] Channel label: ${event.channel.label}`);
      console.log(`[DATA CHANNEL] Channel state: ${event.channel.readyState}`);
      this.setupDataChannel(event.channel);
    };

    this.peerConnection = pc;
    return pc;
  }

  /**
   * Setup data channel event handlers
   */
  private setupDataChannel(channel: RTCDataChannel): void {
    this.dataChannel = channel;

    channel.onopen = () => {
      console.log(`[DATA CHANNEL] Opened (role: ${this.role}, trickle ICE: ${this.trickleIceEnabled})`);
      this.emit(ConnectionEvent.DATA_CHANNEL_OPEN, { channel });

      // If we're the answerer in trickle ICE mode, send answer through data channel
      if (this.trickleIceEnabled && this.role === ConnectionRole.ANSWERER && this.peerConnection) {
        console.log('[DATA CHANNEL] Answerer sending answer through data channel');
        this.sendAnswerThroughDataChannel();
      }

      // Send any pending ICE candidates
      if (this.trickleIceEnabled && this.pendingIceCandidates.length > 0) {
        console.log(`[DATA CHANNEL] Sending ${this.pendingIceCandidates.length} pending ICE candidates`);
        for (const candidate of this.pendingIceCandidates) {
          this.dataChannel!.send(JSON.stringify({
            __signaling: true,
            type: 'ice-candidate',
            candidate
          }));
        }
        this.pendingIceCandidates = [];
      }
    };

    channel.onclose = () => {
      console.log('Data channel closed');
      this.emit(ConnectionEvent.DATA_CHANNEL_CLOSE, { channel });
    };

    channel.onerror = (error) => {
      console.error('Data channel error:', error);
      this.emit(ConnectionEvent.ERROR, {
        error: new WebRTPayError(
          ErrorType.DATA_CHANNEL_FAILED,
          'Data channel error',
          error
        )
      });
    };

    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        // Check if this is a signaling message (answer or ICE candidate)
        if (data.__signaling) {
          this.handleSignalingMessage(data);
        } else {
          // Regular application message
          this.emit(ConnectionEvent.MESSAGE_RECEIVED, { data });
        }
      } catch (error) {
        console.error('Failed to parse message:', error);
        this.emit(ConnectionEvent.ERROR, {
          error: new WebRTPayError(
            ErrorType.MESSAGE_SEND_FAILED,
            'Failed to parse incoming message',
            error
          )
        });
      }
    };
  }

  /**
   * Enable trickle ICE mode for this connection
   */
  public enableTrickleICE(): void {
    this.trickleIceEnabled = true;
  }

  /**
   * Create bootstrap token as offerer
   * This generates the QR code payload or remote broadcast token
   * In trickle ICE mode, includes minimal or no ICE candidates
   */
  public async createBootstrapToken(useTrickleICE: boolean = false): Promise<BootstrapToken> {
    try {
      this.role = ConnectionRole.OFFERER;
      this.trickleIceEnabled = useTrickleICE;
      this.setState(ConnectionState.CREATING_OFFER);

      const pc = this.initializePeerConnection();

      // Create data channel (offerer creates it)
      console.log('[DATA CHANNEL] Creating data channel as offerer');
      const channel = pc.createDataChannel('payment-channel', {
        ordered: true,
        maxRetransmits: 3
      });
      console.log(`[DATA CHANNEL] Created channel with state: ${channel.readyState}`);
      this.setupDataChannel(channel);

      // Create offer
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Filter problematic SDP attributes for compatibility
      const cleanSDP = this.filterSDP(offer.sdp || '');

      // Log SDP to verify data channel is included
      console.log('[SDP] Offer SDP contains data channel:', cleanSDP.includes('m=application'));
      console.log('[SDP] Offer SDP contains SCTP:', cleanSDP.includes('sctp-port'));

      if (useTrickleICE) {
        // In trickle ICE mode, wait for at least one ICE candidate
        // We need at least one candidate to establish initial connection
        // Additional candidates can be sent through data channel
        console.log('Creating bootstrap token with trickle ICE (waiting for initial candidates)');

        await this.waitForInitialICECandidate(pc, 3000);

        this.setState(ConnectionState.AWAITING_ANSWER);

        const token: BootstrapToken = {
          offer: {
            type: offer.type,
            sdp: cleanSDP
          },
          iceCandidates: this.iceCandidatesBuffer.slice(0, 2).map(c => c.toJSON()), // Include first 2 candidates
          metadata: {
            timestamp: Date.now(),
            connectionId: this.connectionId,
            trickleIce: true
          }
        };

        return token;
      } else {
        // Traditional mode: wait for ICE gathering to complete or timeout
        await this.waitForICEGathering(pc, 5000);

        this.setState(ConnectionState.AWAITING_ANSWER);

        const token: BootstrapToken = {
          offer: {
            type: offer.type,
            sdp: cleanSDP
          },
          iceCandidates: this.iceCandidatesBuffer.map(c => c.toJSON()),
          metadata: {
            timestamp: Date.now(),
            connectionId: this.connectionId
          }
        };

        return token;
      }
    } catch (error) {
      this.setState(ConnectionState.FAILED);
      throw new WebRTPayError(
        ErrorType.BOOTSTRAP_GENERATION_FAILED,
        'Failed to create bootstrap token',
        error
      );
    }
  }

  /**
   * Wait for at least one ICE candidate (for trickle ICE)
   */
  private waitForInitialICECandidate(
    _pc: RTCPeerConnection,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve) => {
      // If we already have a candidate, resolve immediately
      if (this.iceCandidatesBuffer.length > 0) {
        console.log(`[ICE] Already have ${this.iceCandidatesBuffer.length} candidate(s), resolving immediately`);
        resolve();
        return;
      }

      console.log('[ICE] Waiting for initial ICE candidate...');
      const timer = setTimeout(() => {
        console.log('[ICE] Timeout waiting for candidates, continuing anyway');
        resolve(); // Continue anyway after timeout
      }, timeout);

      // Check periodically for candidates (since handler is already set up)
      const checkInterval = setInterval(() => {
        if (this.iceCandidatesBuffer.length > 0) {
          console.log(`[ICE] Got ${this.iceCandidatesBuffer.length} candidate(s)`);
          clearTimeout(timer);
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Wait for ICE gathering to complete
   */
  private waitForICEGathering(
    pc: RTCPeerConnection,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        pc.removeEventListener('icegatheringstatechange', checkState);
        resolve();
      }, timeout);

      const checkState = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timer);
          pc.removeEventListener('icegatheringstatechange', checkState);
          resolve();
        }
      };

      pc.addEventListener('icegatheringstatechange', checkState);
    });
  }

  /**
   * Connect using bootstrap token as answerer
   * This is called when scanning QR or receiving remote token
   * In trickle ICE mode, answer is sent through data channel
   * In traditional mode, returns answer that needs to be sent back to offerer
   */
  public async connectWithBootstrapToken(token: BootstrapToken): Promise<{
    answer: RTCSessionDescriptionInit;
    iceCandidates: RTCIceCandidateInit[];
  } | null> {
    try {
      this.role = ConnectionRole.ANSWERER;
      const isTrickleIce = token.metadata?.trickleIce === true;
      this.trickleIceEnabled = isTrickleIce;
      this.setState(ConnectionState.CONNECTING);

      // Clear previous ICE candidates
      this.iceCandidatesBuffer = [];

      const pc = this.initializePeerConnection();

      // Set remote description from offer
      console.log('[SDP] Received offer SDP contains data channel:', token.offer.sdp?.includes('m=application'));
      console.log('[SDP] Received offer SDP contains SCTP:', token.offer.sdp?.includes('sctp-port'));
      await pc.setRemoteDescription(new RTCSessionDescription(token.offer));

      // Add ICE candidates if provided (traditional mode)
      if (token.iceCandidates && token.iceCandidates.length > 0) {
        for (const candidate of token.iceCandidates) {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
      }

      // Create answer
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      console.log('>>> Answer created:', answer);
      console.log('>>> Trickle ICE mode:', isTrickleIce);

      if (isTrickleIce) {
        // In trickle ICE mode, answer will be sent through data channel when it opens
        // We don't need to return it
        console.log('Using trickle ICE - answer will be sent via data channel');
        return null;
      } else {
        // Traditional mode: wait for ICE gathering and return answer
        console.log('>>> Traditional mode: waiting for ICE gathering...');
        await this.waitForICEGathering(pc, 5000);

        console.log('>>> ICE candidates buffer:', this.iceCandidatesBuffer.length);
        const candidates = this.iceCandidatesBuffer.slice(0, 3).map(c => c.toJSON());
        console.log('>>> Returning candidates:', candidates.length);

        const result = {
          answer: {
            type: answer.type,
            sdp: answer.sdp
          },
          iceCandidates: candidates
        };

        console.log('>>> connectWithBootstrapToken returning:', result);
        return result;
      }
    } catch (error) {
      console.error('>>> ERROR in connectWithBootstrapToken:', error);
      console.error('>>> Error type:', (error as any).constructor.name);
      console.error('>>> Error message:', (error as any).message);
      this.setState(ConnectionState.FAILED);
      throw new WebRTPayError(
        ErrorType.CONNECTION_FAILED,
        'Failed to connect with bootstrap token',
        error
      );
    }
  }

  /**
   * Complete connection by receiving answer (offerer side)
   */
  public async receiveAnswer(
    answer: RTCSessionDescriptionInit,
    iceCandidates?: RTCIceCandidateInit[]
  ): Promise<void> {
    console.log('>>> receiveAnswer called');
    console.log('>>> Role:', this.role);
    console.log('>>> Answer:', answer);
    console.log('>>> ICE candidates:', iceCandidates?.length || 0);

    if (this.role !== ConnectionRole.OFFERER) {
      console.error('>>> ERROR: Not offerer role!');
      throw new WebRTPayError(
        ErrorType.CONNECTION_FAILED,
        'Only offerer can receive answer'
      );
    }

    if (!this.peerConnection) {
      console.error('>>> ERROR: No peer connection!');
      throw new WebRTPayError(
        ErrorType.CONNECTION_FAILED,
        'No peer connection initialized'
      );
    }

    try {
      console.log('>>> Setting remote description...');
      await this.peerConnection.setRemoteDescription(
        new RTCSessionDescription(answer)
      );
      console.log('>>> Remote description set successfully');

      // Add answerer's ICE candidates if provided
      if (iceCandidates && iceCandidates.length > 0) {
        console.log(`>>> Adding ${iceCandidates.length} ICE candidates...`);
        for (const candidate of iceCandidates) {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
          console.log('>>> ICE candidate added');
        }
      } else {
        console.log('>>> No ICE candidates to add');
      }

      console.log('>>> Setting state to CONNECTING');
      this.setState(ConnectionState.CONNECTING);
      console.log('>>> receiveAnswer completed successfully');
    } catch (error) {
      console.error('>>> ERROR in receiveAnswer:', error);
      this.setState(ConnectionState.FAILED);
      throw new WebRTPayError(
        ErrorType.CONNECTION_FAILED,
        'Failed to set remote answer',
        error
      );
    }
  }

  /**
   * Handle signaling messages received through data channel
   */
  private async handleSignalingMessage(message: any): Promise<void> {
    console.log(`[SIGNALING] Received message type: ${message.type} (role: ${this.role})`);

    try {
      if (message.type === 'answer') {
        // Offerer receives answer from answerer
        console.log('[SIGNALING] Setting remote answer from data channel');
        await this.peerConnection?.setRemoteDescription(
          new RTCSessionDescription(message.answer)
        );
        console.log('[SIGNALING] Remote answer set successfully');
        this.setState(ConnectionState.CONNECTING);
      } else if (message.type === 'ice-candidate') {
        // Received ICE candidate
        if (message.candidate && this.peerConnection) {
          console.log('[SIGNALING] Adding remote ICE candidate:', message.candidate.candidate);
          await this.peerConnection.addIceCandidate(
            new RTCIceCandidate(message.candidate)
          );
          console.log('[SIGNALING] Remote ICE candidate added');
        }
      }
    } catch (error) {
      console.error('[SIGNALING] Failed to handle signaling message:', error);
      this.emit(ConnectionEvent.ERROR, {
        error: new WebRTPayError(
          ErrorType.CONNECTION_FAILED,
          'Failed to handle signaling message',
          error
        )
      });
    }
  }

  /**
   * Send answer through data channel (answerer side in trickle ICE)
   */
  private async sendAnswerThroughDataChannel(): Promise<void> {
    if (!this.dataChannel || !this.peerConnection) {
      return;
    }

    const localDesc = this.peerConnection.localDescription;
    if (!localDesc) {
      return;
    }

    console.log('Sending answer through data channel');

    // Send answer
    this.dataChannel.send(JSON.stringify({
      __signaling: true,
      type: 'answer',
      answer: {
        type: localDesc.type,
        sdp: localDesc.sdp
      }
    }));

    // Send any pending ICE candidates
    for (const candidate of this.pendingIceCandidates) {
      this.dataChannel.send(JSON.stringify({
        __signaling: true,
        type: 'ice-candidate',
        candidate
      }));
    }
    this.pendingIceCandidates = [];
  }

  /**
   * Send ICE candidate through data channel
   */
  private sendIceCandidateThroughDataChannel(candidate: RTCIceCandidate): void {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      return;
    }

    console.log('Sending ICE candidate through data channel');
    this.dataChannel.send(JSON.stringify({
      __signaling: true,
      type: 'ice-candidate',
      candidate: candidate.toJSON()
    }));
  }

  /**
   * Send JSON message through data channel
   */
  public async sendMessage(message: PaymentMessage): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new WebRTPayError(
        ErrorType.MESSAGE_SEND_FAILED,
        'Data channel is not open'
      );
    }

    try {
      const serialized = JSON.stringify(message);
      this.dataChannel.send(serialized);
    } catch (error) {
      throw new WebRTPayError(
        ErrorType.MESSAGE_SEND_FAILED,
        'Failed to send message',
        error
      );
    }
  }

  /**
   * Check if connection is ready for messaging
   */
  public isReady(): boolean {
    return (
      this.state === ConnectionState.CONNECTED &&
      this.dataChannel !== null &&
      this.dataChannel.readyState === 'open'
    );
  }

  /**
   * Close connection and cleanup resources
   */
  public close(): void {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    this.setState(ConnectionState.CLOSED);
    this.eventListeners.clear();
    this.iceCandidatesBuffer = [];
  }

  /**
   * Get peer connection instance (for advanced usage)
   */
  public getPeerConnection(): RTCPeerConnection {
    if (!this.peerConnection) {
      throw new WebRTPayError(
        ErrorType.CONNECTION_FAILED,
        'Peer connection not initialized'
      );
    }
    return this.peerConnection;
  }

  /**
   * Get connection statistics
   */
  public async getStats(): Promise<RTCStatsReport | null> {
    if (!this.peerConnection) {
      return null;
    }
    return await this.peerConnection.getStats();
  }
}
