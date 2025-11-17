# WebRTPay Signaling Server

HTTP-based signaling server for WebRTPay WebRTC connections. Provides a simple rendezvous point for exchanging SDP offers/answers and ICE candidates.

## Features

- 📡 **Session-based signaling** - Create sessions with unique IDs
- 🔄 **Offer/Answer exchange** - Full SDP negotiation support
- ❄️ **ICE candidate trickling** - Progressive candidate exchange
- ⏰ **Auto-cleanup** - Expired sessions are automatically removed
- 🚀 **Simple REST API** - Easy to integrate with any client
- 🔒 **CORS enabled** - Works with browser clients

## Quick Start

### Install Dependencies

```bash
npm install
```

### Development Mode

```bash
npm run dev
```

Server runs on `http://localhost:3001`

### Production Mode

```bash
npm run build
npm start
```

## API Endpoints

### Create Session (Offerer)

Create a new signaling session and get a shareable URL.

```http
POST /api/sessions
Content-Type: application/json

{
  "offer": {
    "type": "offer",
    "sdp": "v=0\r\no=..."
  },
  "iceCandidates": [...]  // Optional
}

Response:
{
  "sessionId": "uuid",
  "sessionUrl": "http://localhost:3001/session/uuid"
}
```

### Join Session (Answerer)

Join an existing session with your answer.

```http
POST /api/sessions/:sessionId/join
Content-Type: application/json

{
  "answer": {
    "type": "answer",
    "sdp": "v=0\r\no=..."
  },
  "iceCandidates": [...]  // Optional
}

Response:
{
  "offer": {...},
  "offererCandidates": [...]
}
```

### Get Answer (Offerer polls)

Poll for the answerer's response.

```http
GET /api/sessions/:sessionId/answer

Response:
{
  "answer": {...},
  "answererCandidates": [...]
}
```

### Add ICE Candidate

Send additional ICE candidates (trickle ICE).

```http
POST /api/sessions/:sessionId/candidates
Content-Type: application/json

{
  "candidate": {
    "candidate": "candidate:...",
    "sdpMid": "0",
    "sdpMLineIndex": 0
  },
  "role": "offerer"  // or "answerer"
}
```

### Get ICE Candidates

Retrieve ICE candidates from the other party.

```http
GET /api/sessions/:sessionId/candidates?role=offerer

Response:
{
  "candidates": [...]
}
```

### Get Session Status

Check session status and metadata.

```http
GET /api/sessions/:sessionId

Response:
{
  "sessionId": "uuid",
  "hasOffer": true,
  "hasAnswer": false,
  "offererCandidateCount": 2,
  "answererCandidateCount": 0,
  "createdAt": 1234567890,
  "answeredAt": null
}
```

### Delete Session

Clean up a session (optional - sessions auto-expire).

```http
DELETE /api/sessions/:sessionId
```

### Health Check

```http
GET /health

Response:
{
  "status": "ok",
  "timestamp": 1234567890,
  "totalSessions": 5,
  "activeSessions": 3
}
```

## Configuration

Set environment variables:

```bash
PORT=3001                          # Server port
BASE_URL=http://localhost:3001     # Base URL for session links
```

## Session Lifecycle

1. **Offerer** creates session → gets `sessionId` and `sessionUrl`
2. **Offerer** shares URL with answerer (QR code, copy/paste, etc.)
3. **Answerer** navigates to URL or extracts `sessionId`
4. **Answerer** joins session with answer
5. **Both parties** exchange ICE candidates via trickle ICE
6. **Session** auto-expires after 30 minutes of inactivity

## Architecture

```
┌─────────────┐                    ┌──────────────────┐                    ┌─────────────┐
│             │                    │                  │                    │             │
│  Offerer    │───── POST ────────▶│   Signaling      │◀───── GET ────────│  Answerer   │
│  (Device A) │      /sessions     │   Server         │      /sessions/:id │  (Device B) │
│             │                    │                  │      /join         │             │
│             │◀──── sessionUrl ───│  (Express/Node)  │─────▶              │             │
│             │                    │                  │                    │             │
│             │                    │  SessionStore    │                    │             │
│             │◀──────────────────▶│  (in-memory)     │◀──────────────────▶│             │
│             │  Trickle ICE       │                  │  Trickle ICE       │             │
│             │  /candidates       │                  │  /candidates       │             │
└─────────────┘                    └──────────────────┘                    └─────────────┘
```

## Security Considerations

⚠️ **This is a basic implementation for development/demo purposes.**

For production use, consider adding:

- **Authentication** - Verify session participants
- **Rate limiting** - Prevent abuse
- **HTTPS** - Encrypt signaling traffic
- **Persistent storage** - Redis or database instead of in-memory
- **Session validation** - Verify session ownership
- **CORS restrictions** - Limit allowed origins
- **Input validation** - Sanitize all inputs
- **Logging** - Audit trail for debugging

## Deployment

### Docker (Recommended)

```bash
docker build -t webrtpay-signaling .
docker run -p 3001:3001 webrtpay-signaling
```

### Cloud Platforms

- **Heroku**: `git push heroku main`
- **Railway**: Connect GitHub repo
- **Render**: Deploy from dashboard
- **AWS/GCP/Azure**: Use container service

## Client Integration

See [HttpSignaling.ts](../src/signaling/HttpSignaling.ts) for the client implementation.

Example usage:

```typescript
import { createConnectionManager } from 'webrtpay';

// Offerer side
const manager = createConnectionManager({
  httpSignaling: {
    serverUrl: 'http://localhost:3001'
  }
});

const { sessionUrl } = await manager.createHttpSession();
console.log('Share this URL:', sessionUrl);

// Answerer side
const manager = createConnectionManager({
  httpSignaling: {
    serverUrl: 'http://localhost:3001'
  }
});

await manager.joinHttpSession(sessionId);
```

## Troubleshooting

### Connection not establishing

- Check that both clients can reach the signaling server
- Verify STUN/TURN server configuration in WebRTC config
- Check browser console for ICE candidate errors

### Sessions expiring too quickly

- Increase `SESSION_TIMEOUT` in `SessionStore.ts`
- Currently set to 30 minutes

### Memory usage growing

- Check `CLEANUP_INTERVAL` in `SessionStore.ts`
- Sessions are cleaned every 5 minutes by default
- Consider using Redis for production

## License

MIT
