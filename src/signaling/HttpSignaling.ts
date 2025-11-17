/**
 * HTTP-based signaling client for WebRTPay
 * Connects to the Express signaling server for offer/answer/ICE exchange
 */

import { WebRTPayError, ErrorType } from '../core/types';

export interface HttpSignalingConfig {
  serverUrl: string;
  pollingInterval?: number; // Interval for polling answer (ms)
  pollingTimeout?: number; // Max time to poll for answer (ms)
}

export interface SessionInfo {
  sessionId: string;
  sessionUrl: string;
}

export class HttpSignaling {
  private config: HttpSignalingConfig;
  private sessionId?: string;
  private role?: 'offerer' | 'answerer';
  private answerPollingInterval?: NodeJS.Timeout;

  constructor(config: HttpSignalingConfig) {
    this.config = {
      pollingInterval: 1000, // Poll every 1 second
      pollingTimeout: 60000, // Timeout after 60 seconds
      ...config
    };
  }

  /**
   * Create a new session (offerer side)
   * Returns session info with shareable URL
   */
  async createSession(
    offer: RTCSessionDescriptionInit,
    iceCandidates: RTCIceCandidateInit[] = []
  ): Promise<SessionInfo> {
    try {
      console.log('[HTTP SIGNALING] Creating session with offer');

      const response = await fetch(`${this.config.serverUrl}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offer, iceCandidates })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to create session');
      }

      const data = await response.json();
      this.sessionId = data.sessionId;
      this.role = 'offerer';

      console.log(`[HTTP SIGNALING] Session created: ${data.sessionId}`);
      console.log(`[HTTP SIGNALING] Shareable URL: ${data.sessionUrl}`);

      return data;
    } catch (error) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Failed to create signaling session',
        error
      );
    }
  }

  /**
   * Join an existing session (answerer side)
   * Returns the offer and offerer's ICE candidates
   */
  async joinSession(
    sessionId: string,
    answer: RTCSessionDescriptionInit,
    iceCandidates: RTCIceCandidateInit[] = []
  ): Promise<{ offer: RTCSessionDescriptionInit; offererCandidates: RTCIceCandidateInit[] }> {
    try {
      console.log(`[HTTP SIGNALING] Joining session ${sessionId}`);

      const response = await fetch(`${this.config.serverUrl}/api/sessions/${sessionId}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer, iceCandidates })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to join session');
      }

      const data = await response.json();
      this.sessionId = sessionId;
      this.role = 'answerer';

      console.log(`[HTTP SIGNALING] Joined session ${sessionId}`);
      console.log(`[HTTP SIGNALING] Received offer and ${data.offererCandidates.length} candidates`);

      return data;
    } catch (error) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Failed to join signaling session',
        error
      );
    }
  }

  /**
   * Poll for answer (offerer side)
   * Returns a promise that resolves when answer is available
   */
  async waitForAnswer(): Promise<{
    answer: RTCSessionDescriptionInit;
    answererCandidates: RTCIceCandidateInit[];
  }> {
    if (!this.sessionId || this.role !== 'offerer') {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Can only wait for answer as offerer'
      );
    }

    console.log(`[HTTP SIGNALING] Polling for answer on session ${this.sessionId}`);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let pollCount = 0;

      this.answerPollingInterval = setInterval(async () => {
        pollCount++;

        // Check timeout
        if (Date.now() - startTime > this.config.pollingTimeout!) {
          this.stopPolling();
          reject(new WebRTPayError(
            ErrorType.SIGNALING_FAILED,
            'Timeout waiting for answer'
          ));
          return;
        }

        try {
          const response = await fetch(
            `${this.config.serverUrl}/api/sessions/${this.sessionId}/answer`
          );

          if (response.status === 404) {
            // Answer not yet available, continue polling
            if (pollCount % 10 === 0) {
              console.log(`[HTTP SIGNALING] Still waiting for answer... (${pollCount}s)`);
            }
            return;
          }

          if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to get answer');
          }

          const data = await response.json();
          this.stopPolling();

          console.log(`[HTTP SIGNALING] Received answer after ${pollCount} polls`);
          console.log(`[HTTP SIGNALING] Received ${data.answererCandidates.length} answerer candidates`);

          resolve(data);
        } catch (error) {
          this.stopPolling();
          reject(new WebRTPayError(
            ErrorType.SIGNALING_FAILED,
            'Failed to poll for answer',
            error
          ));
        }
      }, this.config.pollingInterval!);
    });
  }

  /**
   * Send ICE candidate to server
   */
  async sendCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.sessionId || !this.role) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Must create or join session before sending candidates'
      );
    }

    try {
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${this.sessionId}/candidates`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ candidate, role: this.role })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to send candidate');
      }

      console.log(`[HTTP SIGNALING] Sent ${this.role} candidate`);
    } catch (error) {
      console.error('[HTTP SIGNALING] Error sending candidate:', error);
      // Don't throw - ICE candidates are optional for trickle ICE
    }
  }

  /**
   * Get ICE candidates from the other party
   */
  async getCandidates(role: 'offerer' | 'answerer'): Promise<RTCIceCandidateInit[]> {
    if (!this.sessionId) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Must create or join session before getting candidates'
      );
    }

    try {
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${this.sessionId}/candidates?role=${role}`
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to get candidates');
      }

      const data = await response.json();
      console.log(`[HTTP SIGNALING] Retrieved ${data.candidates.length} ${role} candidates`);

      return data.candidates;
    } catch (error) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Failed to get candidates',
        error
      );
    }
  }

  /**
   * Get session status
   */
  async getSessionStatus(): Promise<{
    hasOffer: boolean;
    hasAnswer: boolean;
    offererCandidateCount: number;
    answererCandidateCount: number;
  }> {
    if (!this.sessionId) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'No session ID available'
      );
    }

    try {
      const response = await fetch(
        `${this.config.serverUrl}/api/sessions/${this.sessionId}`
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to get session status');
      }

      return await response.json();
    } catch (error) {
      throw new WebRTPayError(
        ErrorType.SIGNALING_FAILED,
        'Failed to get session status',
        error
      );
    }
  }

  /**
   * Clean up session
   */
  async cleanup(): Promise<void> {
    this.stopPolling();

    if (!this.sessionId) {
      return;
    }

    try {
      await fetch(`${this.config.serverUrl}/api/sessions/${this.sessionId}`, {
        method: 'DELETE'
      });
      console.log(`[HTTP SIGNALING] Cleaned up session ${this.sessionId}`);
    } catch (error) {
      console.error('[HTTP SIGNALING] Error cleaning up session:', error);
    }

    this.sessionId = undefined;
    this.role = undefined;
  }

  /**
   * Stop polling for answer
   */
  private stopPolling(): void {
    if (this.answerPollingInterval) {
      clearInterval(this.answerPollingInterval);
      this.answerPollingInterval = undefined;
    }
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * Get current role
   */
  getRole(): 'offerer' | 'answerer' | undefined {
    return this.role;
  }
}
