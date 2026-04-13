# TURN Server Setup Guide

This guide explains how to set up and use the local TURN server for WebRTPay development and testing.

## Quick Start

### Using Docker Compose (Recommended)

1. **Start the TURN server:**

```bash
docker-compose up -d coturn
```

2. **Check if it's running:**

```bash
docker-compose ps
docker-compose logs coturn
```

3. **Stop the server:**

```bash
docker-compose down
```

### Start Both TURN Server and Demo

```bash
# Start everything
docker-compose up -d

# View logs
docker-compose logs -f

# Stop everything
docker-compose down
```

## Configuration

### Default Credentials

The local TURN server is configured with:

- **Server:** `turn:localhost:3478`
- **Username:** `testuser`
- **Password:** `testpass`
- **Realm:** `webrtpay.local`

### Using in WebRTPay

Update your connection configuration to use the local TURN server:

```typescript
import { createConnectionManager } from 'webrtpay';

const manager = createConnectionManager({
  webrtc: {
    iceServers: [
      // Public STUN server
      { urls: 'stun:stun.l.google.com:19302' },

      // Local TURN server
      {
        urls: [
          'turn:localhost:3478',
          'turn:localhost:3478?transport=tcp'
        ],
        username: 'testuser',
        credential: 'testpass'
      }
    ],

    // Optional: Force TURN relay for testing
    // iceTransportPolicy: 'relay'
  }
});
```

### Using with Remote Devices

If you want to test from a mobile device on your local network:

1. **Find your local IP address:**

```bash
# macOS/Linux
ifconfig | grep "inet " | grep -v 127.0.0.1

# Windows
ipconfig
```

2. **Update the TURN server URL to use your local IP:**

```typescript
{
  urls: 'turn:192.168.1.100:3478', // Replace with your IP
  username: 'testuser',
  credential: 'testpass'
}
```

3. **Update `turnserver.conf`:**

Uncomment and set the external IP:

```conf
external-ip=192.168.1.100
```

4. **Restart the TURN server:**

```bash
docker-compose restart coturn
```

## Testing the TURN Server

### Method 1: Using WebRTC Test Page

1. Open: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

2. Add your TURN server configuration:
   ```
   STUN or TURN URI: turn:localhost:3478
   Username: testuser
   Credential: testpass
   ```

3. Click "Add Server" and then "Gather candidates"

4. Look for relay candidates (type: relay) in the results

### Method 2: Using WebRTPay Demo

1. **Force TURN relay mode:**

```typescript
// In demo/src/App.tsx
const manager = createConnectionManager({
  webrtc: {
    iceServers: [
      {
        urls: 'turn:localhost:3478',
        username: 'testuser',
        credential: 'testpass'
      }
    ],
    // Force all traffic through TURN
    iceTransportPolicy: 'relay'
  }
});
```

2. **Run the demo and check browser console:**

Look for ICE candidates with type "relay"

3. **Check TURN server logs:**

```bash
docker-compose logs -f coturn
```

You should see allocation requests and relay traffic.

### Method 3: Using curl (Basic Test)

```bash
# Test STUN binding request
curl -v http://localhost:3478
```

## Troubleshooting

### Server Won't Start

**Check if ports are in use:**

```bash
# Check port 3478
lsof -i :3478

# Check port range
lsof -i :49152-49200
```

**Solution:** Stop conflicting services or change ports in `docker-compose.yml`

### Can't Connect from Mobile Device

1. **Check firewall:**

```bash
# macOS: Allow incoming connections
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/libexec/rapportd

# Linux: Allow ports
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:49200/udp
```

2. **Verify mobile device is on same network**

3. **Use IP address, not localhost**

### Relay Candidates Not Appearing

1. **Check ICE transport policy:**

```typescript
// Don't filter out TURN
iceTransportPolicy: 'all'
```

2. **Verify TURN credentials are correct**

3. **Check TURN server logs for errors:**

```bash
docker-compose logs coturn | grep -i error
```

### High CPU/Memory Usage

The TURN server can be resource-intensive under load.

**Limit resources in docker-compose.yml:**

```yaml
coturn:
  # ... existing config ...
  deploy:
    resources:
      limits:
        cpus: '0.50'
        memory: 512M
      reservations:
        cpus: '0.25'
        memory: 256M
```

## Production Deployment

### DO NOT use this configuration in production!

> **Security note:** The current dev setup exposes TURN credentials via `VITE_TURN_*` environment variables, which are baked into the client JS bundle at build time. Anyone can extract them and abuse your relay. For production, replace static credentials with **server-issued short-lived tokens** using coturn's time-limited credential mechanism:
> 1. Set `use-auth-secret` and `static-auth-secret=<strong-secret>` in `turnserver.conf`
> 2. Add a `/turn-credentials` endpoint to the signaling server that computes `HMAC-SHA1(timestamp:username, secret)` and returns tokens expiring in ~1 hour
> 3. Have the client fetch credentials from that endpoint instead of reading from `import.meta.env`
> 4. coturn independently verifies the HMAC — expired or forged tokens are rejected

For production deployments:

1. **Enable TLS/DTLS:**

```conf
# In turnserver.conf
cert=/path/to/fullchain.pem
pkey=/path/to/privkey.pem
tls-listening-port=5349
```

2. **Use strong credentials:**

```bash
# Generate secure credentials
turnadmin -k -u username -r your-realm.com -p $(openssl rand -base64 32)
```

3. **Configure external IP:**

```conf
external-ip=YOUR_PUBLIC_IP
```

4. **Use a database for credentials:**

```conf
userdb=/var/lib/turn/turndb
# Or use Redis/PostgreSQL
redis-userdb="ip=127.0.0.1 dbname=0 password=secret connect_timeout=30"
```

5. **Enable authentication:**

Remove or comment out:
```conf
# allow-loopback-peers
# no-auth
```

6. **Set up monitoring:**

```conf
prometheus
prometheus-port=9641
```

7. **Configure rate limiting:**

```conf
max-bps=1000000
total-quota=100
user-quota=10
```

### Recommended Production TURN Providers

Instead of self-hosting, consider:

- **[Twilio TURN](https://www.twilio.com/stun-turn)** - $0.40/GB
- **[Xirsys](https://xirsys.com/)** - Free tier + paid plans
- **[Metered TURN](https://www.metered.ca/turn-server)** - $0.50/GB
- **[Open Relay Project](https://www.metered.ca/tools/openrelay/)** - Free public TURN

## Advanced Configuration

### Multiple TURN Servers (Redundancy)

```typescript
const manager = createConnectionManager({
  webrtc: {
    iceServers: [
      // STUN
      { urls: 'stun:stun.l.google.com:19302' },

      // Primary TURN
      {
        urls: 'turn:turn1.example.com:3478',
        username: 'user1',
        credential: 'pass1'
      },

      // Backup TURN
      {
        urls: 'turn:turn2.example.com:3478',
        username: 'user2',
        credential: 'pass2'
      }
    ]
  }
});
```

### Geographic Distribution

Place TURN servers near your users:

```typescript
// Detect user location and select nearest TURN server
const turnServers = {
  'us-east': 'turn:us-east.example.com:3478',
  'eu-west': 'turn:eu-west.example.com:3478',
  'ap-south': 'turn:ap-south.example.com:3478'
};

const region = detectUserRegion(); // Implement this
const turnUrl = turnServers[region];
```

### REST API for Dynamic Credentials

For better security, generate temporary credentials:

```typescript
// Server-side (Node.js example)
const crypto = require('crypto');

function generateTurnCredentials(username) {
  const secret = 'your-static-auth-secret';
  const ttl = 24 * 3600; // 24 hours
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const turnUsername = `${timestamp}:${username}`;

  const hmac = crypto.createHmac('sha1', secret);
  hmac.update(turnUsername);
  const turnPassword = hmac.digest('base64');

  return {
    urls: 'turn:turn.example.com:3478',
    username: turnUsername,
    credential: turnPassword
  };
}

// Client-side
const turnConfig = await fetch('/api/turn-credentials').then(r => r.json());
const manager = createConnectionManager({
  webrtc: {
    iceServers: [turnConfig]
  }
});
```

## Monitoring

### View Real-time Logs

```bash
# All logs
docker-compose logs -f coturn

# Only errors
docker-compose logs coturn | grep -i error

# Only allocations
docker-compose logs coturn | grep -i allocate
```

### Metrics (if Prometheus enabled)

Access metrics at: http://localhost:9641/metrics

### Admin CLI

Connect to admin interface:

```bash
docker exec -it webrtpay-turn telnet localhost 5766
# Password: admin

# Show sessions
ps

# Show statistics
stats
```

## Docker-Free Alternative

If you prefer not to use Docker:

### macOS (Homebrew)

```bash
# Install coturn
brew install coturn

# Edit config
nano /usr/local/etc/turnserver.conf

# Start server
turnserver -c /usr/local/etc/turnserver.conf
```

### Linux (apt)

```bash
# Install coturn
sudo apt-get update
sudo apt-get install coturn

# Enable service
sudo systemctl enable coturn

# Edit config
sudo nano /etc/turnserver.conf

# Start service
sudo systemctl start coturn
```

### Windows

Download from: https://github.com/coturn/coturn/releases

Or use WSL2 with Linux instructions above.

## Useful Commands

```bash
# Start in foreground with verbose logging
docker-compose up coturn

# Restart server
docker-compose restart coturn

# View configuration
docker exec webrtpay-turn cat /etc/coturn/turnserver.conf

# Access container shell
docker exec -it webrtpay-turn sh

# Remove everything
docker-compose down -v

# Check resource usage
docker stats webrtpay-turn
```

## References

- [Coturn Documentation](https://github.com/coturn/coturn)
- [RFC 5766 - TURN Protocol](https://tools.ietf.org/html/rfc5766)
- [WebRTC ICE](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Connectivity)
- [STUN/TURN Explained](https://www.html5rocks.com/en/tutorials/webrtc/infrastructure/)

---

**Need Help?** Open an issue on GitHub or check the troubleshooting section above.
