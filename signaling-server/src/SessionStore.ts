import { SignalingSession } from './types';

/**
 * In-memory session store for WebRTC signaling
 * In production, replace with Redis or database
 */
export class SessionStore {
  private sessions: Map<string, SignalingSession> = new Map();
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

  constructor() {
    // Start periodic cleanup of expired sessions
    setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
  }

  /**
   * Create a new session with an offer
   */
  createSession(sessionId: string, offer: RTCSessionDescriptionInit, offererCandidates: RTCIceCandidateInit[] = []): SignalingSession {
    const now = Date.now();
    const session: SignalingSession = {
      sessionId,
      offer,
      offererCandidates: [...offererCandidates],
      answererCandidates: [],
      createdAt: now,
      expiresAt: now + this.SESSION_TIMEOUT
    };

    this.sessions.set(sessionId, session);
    console.log(`[SESSION] Created session ${sessionId}`);

    return session;
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): SignalingSession | undefined {
    const session = this.sessions.get(sessionId);

    if (!session) {
      return undefined;
    }

    // Check if expired
    if (Date.now() > session.expiresAt) {
      console.log(`[SESSION] Session ${sessionId} expired`);
      this.sessions.delete(sessionId);
      return undefined;
    }

    return session;
  }

  /**
   * Set the answer for a session
   */
  setAnswer(sessionId: string, answer: RTCSessionDescriptionInit, answererCandidates: RTCIceCandidateInit[] = []): boolean {
    const session = this.getSession(sessionId);

    if (!session) {
      console.log(`[SESSION] Session ${sessionId} not found for answer`);
      return false;
    }

    session.answer = answer;
    session.answererCandidates = [...answererCandidates];
    session.answeredAt = Date.now();

    console.log(`[SESSION] Session ${sessionId} answered`);
    return true;
  }

  /**
   * Add an ICE candidate to a session
   */
  addCandidate(sessionId: string, candidate: RTCIceCandidateInit, role: 'offerer' | 'answerer'): boolean {
    const session = this.getSession(sessionId);

    if (!session) {
      console.log(`[SESSION] Session ${sessionId} not found for candidate`);
      return false;
    }

    if (role === 'offerer') {
      session.offererCandidates.push(candidate);
      console.log(`[SESSION] Added offerer candidate to ${sessionId} (total: ${session.offererCandidates.length})`);
    } else {
      session.answererCandidates.push(candidate);
      console.log(`[SESSION] Added answerer candidate to ${sessionId} (total: ${session.answererCandidates.length})`);
    }

    return true;
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    const deleted = this.sessions.delete(sessionId);
    if (deleted) {
      console.log(`[SESSION] Deleted session ${sessionId}`);
    }
    return deleted;
  }

  /**
   * Clean up expired sessions
   */
  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now > session.expiresAt) {
        this.sessions.delete(sessionId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[SESSION] Cleaned up ${cleaned} expired session(s)`);
    }
  }

  /**
   * Get store statistics
   */
  getStats(): { totalSessions: number; activeSessions: number } {
    return {
      totalSessions: this.sessions.size,
      activeSessions: Array.from(this.sessions.values()).filter(s => s.answeredAt).length
    };
  }
}
