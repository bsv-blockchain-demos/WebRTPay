import { useState, useEffect } from "react";
import { WalletClient, WalletInterface } from "@bsv/sdk";
import QRCode from "qrcode";
import { useSignaling } from "./hooks/useSignaling";
import { useWebRTC } from "./hooks/useWebRTC";

function App() {
  const [wallet, setWallet] = useState<WalletInterface | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  type ChatMessage = { sender: 'you' | 'peer'; text: string; timestamp: number };
  const [messages, setMessages] = useState<Record<string, ChatMessage[]>>({});

  const signalingUrl =
    import.meta.env.VITE_SIGNALING_URL ?? "http://localhost:8080";
  const { socket, peers, roomId, error: signalingError } = useSignaling(
    wallet,
    signalingUrl,
  );
  const {
    call,
    acceptCall,
    rejectCall,
    disconnect,
    incomingCall,
    callRejected,
    connecting,
    dataChannel,
    connected,
    peerDisconnected,
    connectedPeerIdentityKey,
  } = useWebRTC(socket);

  useEffect(() => {
    const client = new WalletClient();
    client
      .getPublicKey({ identityKey: true })
      .then(() => setWallet(client))
      .catch(() =>
        setWalletError("Could not connect to wallet. Is BSV Desktop running?"),
      );
  }, []);

  useEffect(() => {
    if (!dataChannel || !connectedPeerIdentityKey) return;
    dataChannel.onmessage = (event) => {
      setMessages((prev) => ({
        ...prev,
        [connectedPeerIdentityKey]: [
          ...(prev[connectedPeerIdentityKey] ?? []),
          { sender: 'peer', text: event.data, timestamp: Date.now() },
        ],
      }));
    };
  }, [dataChannel, connectedPeerIdentityKey]);

  const handleCall = (socketId: string, identityKey: string) => {
    setMessages((prev) => ({ ...prev, [identityKey]: prev[identityKey] ?? [] }));
    call(socketId, identityKey);
  };

  const handleDisconnect = () => {
    disconnect();
  };

  const handleSend = () => {
    if (!dataChannel || !messageInput.trim() || !connectedPeerIdentityKey) return;
    dataChannel.send(messageInput);
    setMessages((prev) => ({
      ...prev,
      [connectedPeerIdentityKey]: [
        ...(prev[connectedPeerIdentityKey] ?? []),
        { sender: 'you', text: messageInput, timestamp: Date.now() },
      ],
    }));
    setMessageInput("");
  };

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [peerSearch, setPeerSearch] = useState("");

  useEffect(() => {
    QRCode.toDataURL(window.location.href, { width: 200, margin: 1 }).then(setQrDataUrl);
  }, [roomId]);

  const activeMessages = connectedPeerIdentityKey
    ? (messages[connectedPeerIdentityKey] ?? [])
    : [];

  const showChat = (connected || peerDisconnected) && connectedPeerIdentityKey;

  return (
    <div className="app">
      <header className="app-header">
        <h1>WebRTPay</h1>
        {wallet && (
          <div className="room-badge">
            <span className="room-label">Room</span>
            <span className="room-id">{roomId.slice(0, 8)}...</span>
            <button
              className="copy-btn"
              onClick={() => navigator.clipboard.writeText(window.location.href)}
              title="Copy invite link"
            >
              Copy link
            </button>
            <button
              className="copy-btn"
              onClick={() => setShowQr(prev => !prev)}
              title="Show QR code"
            >
              {showQr ? 'Hide QR' : 'QR'}
            </button>
          </div>
        )}
      </header>

      {walletError && <div className="alert alert-error">{walletError}</div>}
      {signalingError && <div className="alert alert-error">{signalingError}</div>}
      {callRejected && <div className="alert alert-error">Your connection request was rejected.</div>}
      {connecting && connectedPeerIdentityKey && (
        <div className="connecting-banner">
          <div className="spinner connecting-spinner" />
          Waiting for <span className="connecting-key">{connectedPeerIdentityKey.slice(0, 16)}...</span> to accept
        </div>
      )}

      {incomingCall && (
        <div className="incoming-call-card">
          <div className="incoming-call-avatar">
            {incomingCall.identityKey.slice(0, 2).toUpperCase()}
          </div>
          <div className="incoming-call-info">
            <div className="incoming-call-label">Incoming connection</div>
            <div className="incoming-call-key">{incomingCall.identityKey.slice(0, 16)}...</div>
          </div>
          <div className="incoming-call-actions">
            <button className="accept-btn" onClick={acceptCall}>Accept</button>
            <button className="reject-btn" onClick={rejectCall}>Reject</button>
          </div>
        </div>
      )}

      {!wallet && !walletError && (
        <div className="loading">
          <div className="spinner" />
          <p>Connecting to wallet...</p>
        </div>
      )}

      {showQr && qrDataUrl && (
        <div className="qr-panel">
          <img src={qrDataUrl} alt="Room QR code" className="room-qr" />
          <p className="empty-hint">Scan to join this room</p>
        </div>
      )}

      {wallet && !showChat && (
        <div className="card">
          <div className="card-header">
            <h2>Peers in room</h2>
            <span className="peer-count">{peers.length} online</span>
          </div>

          {peers.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">👥</div>
              <p>Waiting for others to join...</p>
              <p className="empty-hint">Share the link to invite someone</p>
            </div>
          ) : (
            <div className="peer-list">
              <input
                className="peer-search"
                value={peerSearch}
                onChange={(e) => setPeerSearch(e.target.value)}
                placeholder="Search by identity key..."
              />
              {peers.filter(p => p.identityKey.toLowerCase().includes(peerSearch.toLowerCase())).map((peer) => {
                const history = messages[peer.identityKey];
                return (
                  <button
                    key={peer.socketId}
                    className="peer-item"
                    onClick={() => handleCall(peer.socketId, peer.identityKey)}
                  >
                    <div className="peer-avatar">
                      {peer.identityKey.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="peer-info">
                      <div className="peer-key">
                        {peer.identityKey.slice(0, 16)}...
                      </div>
                      {history?.length ? (
                        <div className="peer-history">
                          {history.length} previous message{history.length !== 1 ? 's' : ''}
                        </div>
                      ) : (
                        <div className="peer-history">Click to connect</div>
                      )}
                    </div>
                    <div className="peer-arrow">→</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {showChat && connectedPeerIdentityKey && (
        <div className="card chat-card">
          <div className="chat-header">
            <div className="chat-peer">
              <div className="peer-avatar">
                {connectedPeerIdentityKey.slice(0, 2).toUpperCase()}
              </div>
              <div>
                <div
                  className="peer-key peer-key-clickable"
                  onClick={() => navigator.clipboard.writeText(connectedPeerIdentityKey)}
                  title="Click to copy full identity key"
                >{connectedPeerIdentityKey.slice(0, 16)}...</div>
                <div className={`connection-status ${peerDisconnected ? 'disconnected' : 'connected'}`}>
                  {peerDisconnected ? 'Disconnected' : 'Connected'}
                </div>
              </div>
            </div>
            <button className="disconnect-btn" onClick={handleDisconnect}>
              {peerDisconnected ? 'Back' : 'Disconnect'}
            </button>
          </div>

          <div className="messages">
            {activeMessages.length === 0 && (
              <div className="empty-state">
                <p>No messages yet. Say hello!</p>
              </div>
            )}
            {activeMessages.map((msg, i) => {
              const isYou = msg.sender === 'you';
              const time = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              return (
                <div key={i} className={`message ${isYou ? 'message-you' : 'message-peer'}`}>
                  <div className="message-label">
                    {isYou ? 'You' : connectedPeerIdentityKey.slice(0, 10) + '...'}
                    <span className="message-time">{time}</span>
                  </div>
                  <div className="message-text">{msg.text}</div>
                </div>
              )
            })}
          </div>

          {connected && (
            <div className="chat-input-row">
              <input
                className="chat-input"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSend()}
                placeholder="Send a message..."
              />
              <button
                className="send-btn"
                onClick={handleSend}
                disabled={!messageInput.trim()}
              >
                Send
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
