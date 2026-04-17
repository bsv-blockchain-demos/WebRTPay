import { useState, useEffect } from "react";
import { WalletClient, WalletInterface, PublicKey, P2PKH } from "@bsv/sdk";
import QRCode from "qrcode";
import { useSignaling } from "./hooks/useSignaling";
import { useWebRTC } from "./hooks/useWebRTC";
import {
  ChannelMessage,
  PaymentRequest,
  PaymentResponse,
  PaymentDeclined,
} from "./types";

type PaymentHistoryEntry = {
  requestId: string;
  direction: "sent" | "received";
  amount: number;
  description: string;
  status: "pending" | "paid" | "declined" | "cancelled";
  txid?: string;
};

function App() {
  const [wallet, setWallet] = useState<WalletInterface | null>(null);
  const [myIdentityKey, setMyIdentityKey] = useState<string | null>(null);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [amountInput, setAmountInput] = useState("");
  const [descriptionInput, setDescriptionInput] = useState("");
  const [incomingRequest, setIncomingRequest] = useState<PaymentRequest | null>(null);
  const [paymentHistory, setPaymentHistory] = useState<PaymentHistoryEntry[]>([]);
  const [isRequesting, setIsRequesting] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [peerSearch, setPeerSearch] = useState("");

  const signalingUrl = import.meta.env.VITE_SIGNALING_URL ?? "http://localhost:8080";
  const { socket, peers, roomId, error: signalingError } = useSignaling(wallet, signalingUrl);
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
      .then((result) => {
        setWallet(client);
        setMyIdentityKey(result.publicKey);
      })
      .catch(() =>
        setWalletError("Could not connect to wallet. Is BSV Desktop running?"),
      );
  }, []);

  useEffect(() => {
    QRCode.toDataURL(window.location.href, { width: 200, margin: 1 }).then(setQrDataUrl);
  }, [roomId]);

  useEffect(() => {
    if (!dataChannel || !connectedPeerIdentityKey) return;
    dataChannel.onmessage = (event: MessageEvent) => {
      let msg: ChannelMessage;
      try {
        msg = JSON.parse(event.data as string) as ChannelMessage;
      } catch {
        return;
      }
      switch (msg.type) {
        case "payment-request":
          setIncomingRequest(msg);
          break;
        case "payment-response":
          setPaymentHistory((prev) =>
            prev.map((e) =>
              e.requestId === msg.requestId
                ? { ...e, status: "paid" as const, txid: msg.txid }
                : e,
            ),
          );
          break;
        case "payment-declined":
          setPaymentHistory((prev) =>
            prev.map((e) =>
              e.requestId === msg.requestId
                ? { ...e, status: "declined" as const }
                : e,
            ),
          );
          break;
        case "payment-cancel":
          setIncomingRequest((prev) =>
            prev?.requestId === msg.requestId ? null : prev,
          );
          break;
      }
    };
  }, [dataChannel, connectedPeerIdentityKey]);

  const handleCall = (socketId: string, identityKey: string) => {
    call(socketId, identityKey);
  };

  const handleDisconnect = () => {
    setIncomingRequest(null);
    setPaymentHistory([]);
    setPaymentError(null);
    disconnect();
  };

  const handleRequestPayment = async () => {
    if (!wallet || !dataChannel || !connectedPeerIdentityKey || !myIdentityKey) return;
    const amount = parseInt(amountInput);
    if (isNaN(amount) || amount <= 0) return;

    setIsRequesting(true);
    setPaymentError(null);
    try {
      const requestId = crypto.randomUUID();
      const expiresAt = Date.now() + 10 * 60 * 1000;

      const encoder = new TextEncoder();
      const data = Array.from(encoder.encode(requestId + connectedPeerIdentityKey));
      const { hmac } = await wallet.createHmac({
        data,
        protocolID: [2, "payment request auth"],
        keyID: requestId,
        counterparty: connectedPeerIdentityKey,
      });

      const requestProof = Array.from(hmac)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const request: PaymentRequest = {
        type: "payment-request",
        requestId,
        senderIdentityKey: myIdentityKey,
        amount,
        description: descriptionInput.trim() || "Payment request",
        expiresAt,
        requestProof,
      };

      dataChannel.send(JSON.stringify(request));
      setPaymentHistory((prev) => [
        ...prev,
        {
          requestId,
          direction: "sent",
          amount,
          description: request.description,
          status: "pending",
        },
      ]);
      setAmountInput("");
      setDescriptionInput("");
    } catch {
      setPaymentError("Failed to send payment request.");
    } finally {
      setIsRequesting(false);
    }
  };

  const handleAcceptPayment = async () => {
    if (!wallet || !dataChannel || !incomingRequest || !connectedPeerIdentityKey) return;
    setPaymentError(null);
    try {
      const pubKey = PublicKey.fromString(connectedPeerIdentityKey);
      const lockingScript = new P2PKH().lock(pubKey.toAddress());

      const result = await wallet.createAction({
        description: incomingRequest.description,
        outputs: [
          {
            lockingScript: lockingScript.toHex(),
            satoshis: incomingRequest.amount,
            outputDescription: incomingRequest.description,
          },
        ],
      });

      const response: PaymentResponse = {
        type: "payment-response",
        requestId: incomingRequest.requestId,
        txid: result.txid ?? "",
      };
      dataChannel.send(JSON.stringify(response));
      setPaymentHistory((prev) => [
        ...prev,
        {
          requestId: incomingRequest.requestId,
          direction: "received",
          amount: incomingRequest.amount,
          description: incomingRequest.description,
          status: "paid",
          txid: result.txid,
        },
      ]);
      setIncomingRequest(null);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : "Payment failed. Check your wallet balance.");
    }
  };

  const handleDeclinePayment = () => {
    if (!dataChannel || !incomingRequest) return;
    const msg: PaymentDeclined = {
      type: "payment-declined",
      requestId: incomingRequest.requestId,
    };
    dataChannel.send(JSON.stringify(msg));
    setIncomingRequest(null);
  };

  const showPaymentView = (connected || peerDisconnected) && connectedPeerIdentityKey;

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
              onClick={() => setShowQr((prev) => !prev)}
              title="Show QR code"
            >
              {showQr ? "Hide QR" : "QR"}
            </button>
          </div>
        )}
      </header>

      {walletError && <div className="alert alert-error">{walletError}</div>}
      {signalingError && <div className="alert alert-error">{signalingError}</div>}
      {callRejected && <div className="alert alert-error">Your connection request was rejected.</div>}
      {paymentError && <div className="alert alert-error">{paymentError}</div>}

      {connecting && connectedPeerIdentityKey && (
        <div className="connecting-banner">
          <div className="spinner connecting-spinner" />
          Waiting for{" "}
          <span className="connecting-key">{connectedPeerIdentityKey.slice(0, 16)}...</span>{" "}
          to accept
        </div>
      )}

      {incomingCall && (
        <div className="incoming-call-card">
          <div className="peer-avatar incoming-call-avatar">
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

      {wallet && !showPaymentView && (
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
              {peers
                .filter((p) =>
                  p.identityKey.toLowerCase().includes(peerSearch.toLowerCase()),
                )
                .map((peer) => (
                  <button
                    key={peer.socketId}
                    className="peer-item"
                    onClick={() => handleCall(peer.socketId, peer.identityKey)}
                  >
                    <div className="peer-avatar">
                      {peer.identityKey.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="peer-info">
                      <div className="peer-key">{peer.identityKey.slice(0, 16)}...</div>
                      <div className="peer-history">Click to connect</div>
                    </div>
                    <div className="peer-arrow">→</div>
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {showPaymentView && connectedPeerIdentityKey && (
        <div className="card payment-card">
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
                >
                  {connectedPeerIdentityKey.slice(0, 16)}...
                </div>
                <div className={`connection-status ${peerDisconnected ? "disconnected" : "connected"}`}>
                  {peerDisconnected ? "Disconnected" : "Connected"}
                </div>
              </div>
            </div>
            <button className="disconnect-btn" onClick={handleDisconnect}>
              {peerDisconnected ? "Back" : "Disconnect"}
            </button>
          </div>

          {incomingRequest && !peerDisconnected && (
            <div className="payment-request-card">
              <div className="payment-request-header">
                <span className="payment-request-label">Payment requested</span>
                <span className="payment-amount">
                  {incomingRequest.amount.toLocaleString()} sats
                </span>
              </div>
              <p className="payment-description">{incomingRequest.description}</p>
              <div className="payment-request-actions">
                <button className="accept-btn" onClick={handleAcceptPayment}>Pay</button>
                <button className="reject-btn" onClick={handleDeclinePayment}>Decline</button>
              </div>
            </div>
          )}

          <div className="payment-history">
            {paymentHistory.length === 0 && (
              <div className="empty-state">
                <p>No payments yet.</p>
                <p className="empty-hint">Request a payment using the form below.</p>
              </div>
            )}
            {paymentHistory.map((entry) => (
              <div
                key={entry.requestId}
                className={`payment-entry payment-entry-${entry.direction}`}
              >
                <div className="payment-entry-top">
                  <span className="payment-entry-direction">
                    {entry.direction === "sent" ? "You requested" : "You paid"}
                  </span>
                  <span className="payment-entry-amount">
                    {entry.amount.toLocaleString()} sats
                  </span>
                </div>
                <p className="payment-entry-description">{entry.description}</p>
                <div className={`payment-entry-status status-${entry.status}`}>
                  {entry.status === "pending" && "Waiting for payment..."}
                  {entry.status === "paid" &&
                    `Paid${entry.txid ? ` · ${entry.txid.slice(0, 12)}...` : ""}`}
                  {entry.status === "declined" && "Declined"}
                  {entry.status === "cancelled" && "Cancelled"}
                </div>
              </div>
            ))}
          </div>

          {connected && (
            <div className="payment-form">
              <input
                className="chat-input"
                type="number"
                min="1"
                value={amountInput}
                onChange={(e) => setAmountInput(e.target.value)}
                placeholder="Amount (satoshis)"
              />
              <input
                className="chat-input"
                value={descriptionInput}
                onChange={(e) => setDescriptionInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleRequestPayment()}
                placeholder="Description (optional)"
              />
              <button
                className="send-btn"
                onClick={handleRequestPayment}
                disabled={!amountInput || isRequesting}
              >
                {isRequesting ? "Sending..." : "Request Payment"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
