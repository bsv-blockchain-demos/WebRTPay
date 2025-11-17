import express, { Request, Response } from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { SessionStore } from './SessionStore';
import {
  CreateSessionRequest,
  CreateSessionResponse,
  JoinSessionRequest,
  JoinSessionResponse,
  AddCandidateRequest,
  GetCandidatesResponse,
  SessionStatusResponse
} from './types';

const app = express();
const PORT = process.env.PORT || 3001;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Large limit for SDP payloads

// Session store
const sessionStore = new SessionStore();

/**
 * Health check
 */
app.get('/health', (req: Request, res: Response) => {
  const stats = sessionStore.getStats();
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    ...stats
  });
});

/**
 * Create a new session (offerer creates and gets session ID)
 * POST /api/sessions
 * Body: { offer, iceCandidates? }
 * Returns: { sessionId, sessionUrl }
 */
app.post('/api/sessions', (req: Request, res: Response) => {
  try {
    const { offer, iceCandidates = [] } = req.body as CreateSessionRequest;

    if (!offer || !offer.sdp || !offer.type) {
      return res.status(400).json({ error: 'Invalid offer' });
    }

    const sessionId = uuidv4();
    sessionStore.createSession(sessionId, offer, iceCandidates);

    const response: CreateSessionResponse = {
      sessionId,
      sessionUrl: `${BASE_URL}/session/${sessionId}`
    };

    console.log(`[API] Created session ${sessionId} with ${iceCandidates.length} initial candidates`);

    res.status(201).json(response);
  } catch (error) {
    console.error('[API] Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * Get session status
 * GET /api/sessions/:sessionId
 */
app.get('/api/sessions/:sessionId', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = sessionStore.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    const response: SessionStatusResponse = {
      sessionId: session.sessionId,
      hasOffer: !!session.offer,
      hasAnswer: !!session.answer,
      offererCandidateCount: session.offererCandidates.length,
      answererCandidateCount: session.answererCandidates.length,
      createdAt: session.createdAt,
      answeredAt: session.answeredAt
    };

    res.json(response);
  } catch (error) {
    console.error('[API] Error getting session:', error);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

/**
 * Join a session (answerer posts answer)
 * POST /api/sessions/:sessionId/join
 * Body: { answer, iceCandidates? }
 * Returns: { offer, offererCandidates }
 */
app.post('/api/sessions/:sessionId/join', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { answer, iceCandidates = [] } = req.body as JoinSessionRequest;

    if (!answer || !answer.sdp || !answer.type) {
      return res.status(400).json({ error: 'Invalid answer' });
    }

    const session = sessionStore.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (session.answer) {
      return res.status(409).json({ error: 'Session already answered' });
    }

    const success = sessionStore.setAnswer(sessionId, answer, iceCandidates);

    if (!success) {
      return res.status(500).json({ error: 'Failed to set answer' });
    }

    const response: JoinSessionResponse = {
      offer: session.offer!,
      offererCandidates: session.offererCandidates
    };

    console.log(`[API] Session ${sessionId} joined with ${iceCandidates.length} initial candidates`);

    res.json(response);
  } catch (error) {
    console.error('[API] Error joining session:', error);
    res.status(500).json({ error: 'Failed to join session' });
  }
});

/**
 * Get answer for a session (offerer polls for answer)
 * GET /api/sessions/:sessionId/answer
 * Returns: { answer, answererCandidates } or 404
 */
app.get('/api/sessions/:sessionId/answer', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const session = sessionStore.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (!session.answer) {
      return res.status(404).json({ error: 'Answer not yet available' });
    }

    res.json({
      answer: session.answer,
      answererCandidates: session.answererCandidates
    });
  } catch (error) {
    console.error('[API] Error getting answer:', error);
    res.status(500).json({ error: 'Failed to get answer' });
  }
});

/**
 * Add ICE candidate
 * POST /api/sessions/:sessionId/candidates
 * Body: { candidate, role: 'offerer' | 'answerer' }
 */
app.post('/api/sessions/:sessionId/candidates', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const { candidate, role } = req.body as AddCandidateRequest;

    if (!candidate || !candidate.candidate) {
      return res.status(400).json({ error: 'Invalid candidate' });
    }

    if (role !== 'offerer' && role !== 'answerer') {
      return res.status(400).json({ error: 'Role must be "offerer" or "answerer"' });
    }

    const success = sessionStore.addCandidate(sessionId, candidate, role);

    if (!success) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    res.status(201).json({ success: true });
  } catch (error) {
    console.error('[API] Error adding candidate:', error);
    res.status(500).json({ error: 'Failed to add candidate' });
  }
});

/**
 * Get ICE candidates (for the other party)
 * GET /api/sessions/:sessionId/candidates?role=offerer|answerer
 * Query param 'role' specifies which candidates to fetch
 * Returns: { candidates: [...] }
 */
app.get('/api/sessions/:sessionId/candidates', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const role = req.query.role as 'offerer' | 'answerer';

    if (role !== 'offerer' && role !== 'answerer') {
      return res.status(400).json({ error: 'Query param "role" must be "offerer" or "answerer"' });
    }

    const session = sessionStore.getSession(sessionId);

    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    const candidates = role === 'offerer'
      ? session.offererCandidates
      : session.answererCandidates;

    const response: GetCandidatesResponse = {
      candidates
    };

    res.json(response);
  } catch (error) {
    console.error('[API] Error getting candidates:', error);
    res.status(500).json({ error: 'Failed to get candidates' });
  }
});

/**
 * Delete a session (cleanup)
 * DELETE /api/sessions/:sessionId
 */
app.delete('/api/sessions/:sessionId', (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const deleted = sessionStore.deleteSession(sessionId);

    if (!deleted) {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[API] Error deleting session:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║                                                        ║
║   WebRTPay Signaling Server                           ║
║                                                        ║
║   Server running on port ${PORT}                        ║
║   Base URL: ${BASE_URL}              ║
║                                                        ║
║   API Endpoints:                                       ║
║   - POST   /api/sessions                  (create)    ║
║   - GET    /api/sessions/:id              (status)    ║
║   - POST   /api/sessions/:id/join         (answer)    ║
║   - GET    /api/sessions/:id/answer       (poll)      ║
║   - POST   /api/sessions/:id/candidates   (add ICE)   ║
║   - GET    /api/sessions/:id/candidates   (get ICE)   ║
║   - DELETE /api/sessions/:id              (cleanup)   ║
║                                                        ║
╚════════════════════════════════════════════════════════╝
  `);
});
