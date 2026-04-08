import { useState, useEffect, useRef } from "react";
import {
  createConnectionManager,
  ConnectionManager,
  ConnectionState,
  ConnectionEvent,
  PaymentMessage,
  PaymentMessageTypes,
  QRBootstrap,
  isWebRTCSupported,
  getBrowserInfo,
} from "../../src";
import { WalletClient, WalletInterface } from "@bsv/sdk";
import { useSignaling } from "./hooks/useSignaling";
import { useWebRTC } from "./hooks/useWebRTC";

type Mode = "create" | "join";
type Method = "qr" | "remote";

function App() {
  const [wallet, setWallet] = useState<WalletInterface | null>(null);
  const [mode, setMode] = useState<Mode>("create");
  const [method, setMethod] = useState<Method>("qr");
  const [manager, setManager] = useState<ConnectionManager | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    ConnectionState.IDLE,
  );
  const [qrCodeUrl, setQrCodeUrl] = useState<string>("");
  const [answerQRCodeUrl, setAnswerQRCodeUrl] = useState<string>("");
  const [waitingForAnswer, setWaitingForAnswer] = useState(false);
  const [username, setUsername] = useState<string>("");
  const [remoteUsername, setRemoteUsername] = useState<string>("");
  const [messages, setMessages] = useState<PaymentMessage[]>([]);
  const [messageInput, setMessageInput] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isScanning, setIsScanning] = useState(false);
  const [scannerReady, setScannerReady] = useState(false);
  const [stats, setStats] = useState({ sent: 0, received: 0 });
  const [tokenJson, setTokenJson] = useState<string>("");
  const [pasteInput, setPasteInput] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<any>(null);

  const {
    socket,
    peers,
    roomId,
    error: signalingError,
  } = useSignaling(wallet, "http://localhost:8080");

  console.log({ socket });
  console.log({ peers });
  console.log({ roomId });
  console.log({ signalingError });

  const { call, dataChannel, connected } = useWebRTC(socket);
  console.log({ dataChannel });
  console.log({ connected });

  useEffect(() => {
    const client = new WalletClient();
    client
      .getPublicKey({ identityKey: true })
      .then(() => {
        setWallet(client);
        console.log("DASDADADASDAD");
      })
      .catch(() =>
        setError("Could not connect to wallet. Is BSV Desktop running?"),
      );
  }, []);

  // Check WebRTC support on mount
  useEffect(() => {
    if (!isWebRTCSupported()) {
      setError("WebRTC is not supported in this browser");
    }

    const info = getBrowserInfo();
    console.log("Browser info:", info);
  }, []);

  // Initialize connection manager
  const initializeManager = () => {
    if (manager) {
      manager.close();
    }

    const newManager = createConnectionManager({
      connectionTimeout: 30000,
      autoRetry: true,
      maxRetries: 3,
    });

    // Setup event listeners
    newManager.getConnection().on(ConnectionEvent.STATE_CHANGE, ({ state }) => {
      console.log("Connection state:", state);
      setConnectionState(state);

      if (state === ConnectionState.FAILED) {
        setError("Connection failed. Please try again.");
      }
    });

    newManager.onAnyMessage((message) => {
      console.log("Message received:", message);
      setMessages((prev) => [...prev, message]);
      setStats((prev) => ({ ...prev, received: prev.received + 1 }));
    });

    setManager(newManager);
    return newManager;
  };

  // Create QR connection (Step 1: Offerer generates QR)
  const handleCreateQR = async () => {
    try {
      setError("");
      const mgr = initializeManager();

      // Use trickle ICE mode (single QR code with answer via data channel)
      const { qrCodeDataUrl, token, isTrickleICE } =
        await mgr.createQRConnection(true);
      setQrCodeUrl(qrCodeDataUrl);
      setTokenJson(JSON.stringify(token));
      // In trickle ICE mode, no need to wait for answer QR code

      // Log payload size for debugging
      const payloadSize = QRBootstrap.estimatePayloadSize(token);
      console.log(
        `QR code payload size: ${payloadSize} bytes (${(payloadSize / 1024).toFixed(2)} KB)`,
      );
      console.log(
        `ICE candidates included: ${token.iceCandidates?.length || 0}`,
      );
      console.log(`Trickle ICE mode (single QR code): ${isTrickleICE}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Start scanning QR code (Step 2: Answerer scans offer QR)
  const handleStartScan = () => {
    setError("");
    setIsScanning(true);
  };

  // Copy token JSON to clipboard
  const handleCopyToken = async () => {
    try {
      await navigator.clipboard.writeText(tokenJson);
      alert("Token copied to clipboard!");
    } catch (err) {
      console.error("Failed to copy:", err);
      setError("Failed to copy to clipboard");
    }
  };

  // Connect using pasted token JSON
  const handlePasteConnect = async () => {
    try {
      setError("");
      const token = JSON.parse(pasteInput);
      const mgr = manager || initializeManager();
      const result = await mgr.joinQRConnection(token);

      if (result.isTrickleICE) {
        console.log(
          ">>> Trickle ICE mode: answer will be sent via data channel",
        );
      } else if (result.answerQRCode) {
        console.log(">>> Traditional mode: showing answer QR code");
        setAnswerQRCodeUrl(result.answerQRCode);
      }
      setPasteInput("");
    } catch (err) {
      console.error("Failed to connect with pasted token:", err);
      setError((err as Error).message);
    }
  };

  // Start scanning answer QR code (Step 3: Offerer scans answer QR)
  const handleScanAnswer = () => {
    setError("");
    setWaitingForAnswer(false);
    setIsScanning(true);
  };

  // Initialize scanner when video element is ready
  useEffect(() => {
    if (!isScanning || !videoRef.current || scannerRef.current) {
      console.log("Scanner init skipped:", {
        isScanning,
        hasVideo: !!videoRef.current,
        hasScanner: !!scannerRef.current,
      });
      return;
    }

    console.log("Initializing scanner...");
    let mounted = true;

    const initScanner = async () => {
      try {
        console.log("Creating scanner on video element");

        // Create scanner with callbacks
        const scanner = await QRBootstrap.createScanner(
          videoRef.current!,
          async (data) => {
            if (!mounted) return;
            console.log("========================================");
            console.log("QR code scanned successfully!");
            console.log("Data type:", typeof data);
            console.log("Data keys:", Object.keys(data));
            console.log("Full data:", JSON.stringify(data, null, 2));
            console.log('Has "a" key:', "a" in data);
            console.log('Has "i" key:', "i" in data);
            console.log('Has "offer" key:', "offer" in data);
            console.log("========================================");

            // Successfully scanned
            stopScanner();

            try {
              // Check if this is an answer QR code or offer QR code
              if ("a" in data && "i" in data) {
                // This is an answer QR code (Step 3)
                console.log(">>> DETECTED: Answer QR code");
                console.log(">>> Manager exists:", !!manager);
                if (manager) {
                  console.log(">>> Calling completeQRConnection...");
                  await manager.completeQRConnection(data as any);
                  console.log(
                    ">>> completeQRConnection completed successfully",
                  );
                } else {
                  console.error(">>> ERROR: No manager available!");
                  setError("Connection manager not initialized");
                }
              } else {
                // This is an offer QR code (Step 2)
                console.log(">>> DETECTED: Offer QR code");
                const mgr = manager || initializeManager();
                const result = await mgr.joinQRConnection(data);

                // Check if this is trickle ICE or traditional mode
                if (result.isTrickleICE) {
                  console.log(
                    ">>> Trickle ICE mode: answer will be sent via data channel",
                  );
                  // No QR code to show - answer sent through data channel
                } else if (result.answerQRCode) {
                  console.log(">>> Traditional mode: showing answer QR code");
                  setAnswerQRCodeUrl(result.answerQRCode);
                } else {
                  setError("Failed to generate answer QR code");
                }
              }
            } catch (err) {
              console.error(">>> ERROR during QR processing:", err);
              setError((err as Error).message);
            }
          },
          (error) => {
            console.error("Scan error:", error);
            // Continue scanning on errors
          },
        );

        if (mounted) {
          console.log("Scanner created successfully");
          scannerRef.current = scanner;
          setScannerReady(true);
        } else {
          scanner.stop();
          scanner.destroy();
        }
      } catch (err) {
        console.error("Failed to initialize scanner:", err);
        if (mounted) {
          setError((err as Error).message);
          setIsScanning(false);
        }
      }
    };

    initScanner();

    return () => {
      mounted = false;
    };
  }, [isScanning, manager]);

  // Stop scanner
  const stopScanner = () => {
    if (scannerRef.current) {
      QRBootstrap.stopScanner(scannerRef.current);
      scannerRef.current = null;
    }
    setIsScanning(false);
    setScannerReady(false);
  };

  // Create remote connection
  const handleCreateRemote = async () => {
    if (!username || username.length < 3) {
      setError("Username must be at least 3 characters");
      return;
    }

    try {
      setError("");
      const mgr = initializeManager();

      await mgr.publishRemoteConnection(username);
      setError(""); // Success
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Join remote connection
  const handleJoinRemote = async () => {
    if (!remoteUsername || remoteUsername.length < 3) {
      setError("Username must be at least 3 characters");
      return;
    }

    try {
      setError("");
      const mgr = initializeManager();

      await mgr.joinRemoteConnection(remoteUsername);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Send message
  const handleSendMessage = async () => {
    if (!manager || !messageInput.trim()) return;

    try {
      await manager.send(PaymentMessageTypes.PAYMENT_REQUEST, {
        text: messageInput,
        amount: 100,
        currency: "USD",
        recipient: "demo-recipient",
      });

      setMessageInput("");
      setStats((prev) => ({ ...prev, sent: prev.sent + 1 }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Send test payment
  const handleTestPayment = async () => {
    if (!manager) return;

    try {
      await manager.send(PaymentMessageTypes.PAYMENT_REQUEST, {
        amount: 50.0,
        currency: "USD",
        recipient: "test-user",
        description: "Test payment",
      });

      setStats((prev) => ({ ...prev, sent: prev.sent + 1 }));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Close connection
  const handleClose = () => {
    if (manager) {
      manager.close();
      setManager(null);
    }
    setConnectionState(ConnectionState.IDLE);
    setQrCodeUrl("");
    setAnswerQRCodeUrl("");
    setWaitingForAnswer(false);
    setMessages([]);
    setStats({ sent: 0, received: 0 });
    stopScanner();
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (manager) {
        manager.close();
      }
      stopScanner();
    };
  }, [manager]);

  return (
    <div className="app">
      <h1>WebRTPay Demo</h1>

      {/* Status Card */}
      <div className="card">
        <h2>Connection Status</h2>
        <div className={`status ${connectionState}`}>
          {connectionState.toUpperCase()}
        </div>

        {error && <div className="error">{error}</div>}

        <div>Room: {roomId}</div>
        <div>Peers: {peers.length}</div>
        {peers.map((peer) => (
          <button key={peer.socketId} onClick={() => call(peer.socketId)}>
            Connect to {peer.identityKey.slice(0, 8)}...
          </button>
        ))}
        {connected && <div>Connected!</div>}

        {connectionState === ConnectionState.IDLE && (
          <>
            <div className="tabs">
              <button
                className={`tab ${mode === "create" ? "active" : ""}`}
                onClick={() => setMode("create")}
              >
                Create
              </button>
              <button
                className={`tab ${mode === "join" ? "active" : ""}`}
                onClick={() => setMode("join")}
              >
                Join
              </button>
            </div>

            <div className="tabs">
              <button
                className={`tab ${method === "qr" ? "active" : ""}`}
                onClick={() => setMethod("qr")}
              >
                QR Code
              </button>
              <button
                className={`tab ${method === "remote" ? "active" : ""}`}
                onClick={() => setMethod("remote")}
              >
                Remote
              </button>
            </div>

            {/* Create Mode */}
            {mode === "create" && (
              <>
                {method === "qr" ? (
                  <>
                    <p className="info-text">
                      Generate a QR code for another device to scan
                    </p>
                    <button className="button" onClick={handleCreateQR}>
                      Generate QR Code
                    </button>
                  </>
                ) : (
                  <>
                    <p className="info-text">
                      Publish your connection to a remote server
                    </p>
                    <input
                      type="text"
                      className="input"
                      placeholder="Enter your username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                    />
                    <button className="button" onClick={handleCreateRemote}>
                      Publish Connection
                    </button>
                  </>
                )}
              </>
            )}

            {/* Join Mode */}
            {mode === "join" && (
              <>
                {method === "qr" ? (
                  <>
                    <p className="info-text">
                      Scan a QR code from another device or paste token JSON
                    </p>
                    <button className="button" onClick={handleStartScan}>
                      Start Camera
                    </button>
                    <div
                      style={{
                        marginTop: "20px",
                        borderTop: "1px solid #ccc",
                        paddingTop: "20px",
                      }}
                    >
                      <p className="info-text" style={{ marginBottom: "10px" }}>
                        Or paste token JSON:
                      </p>
                      <textarea
                        className="input"
                        placeholder="Paste token JSON here..."
                        value={pasteInput}
                        onChange={(e) => setPasteInput(e.target.value)}
                        style={{
                          minHeight: "80px",
                          fontFamily: "monospace",
                          fontSize: "12px",
                          marginBottom: "10px",
                        }}
                      />
                      <button
                        className="button"
                        onClick={handlePasteConnect}
                        disabled={!pasteInput.trim()}
                      >
                        Connect with Pasted Token
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="info-text">
                      Lookup and connect to a remote user
                    </p>
                    <input
                      type="text"
                      className="input"
                      placeholder="Enter username to connect"
                      value={remoteUsername}
                      onChange={(e) => setRemoteUsername(e.target.value)}
                    />
                    <button className="button" onClick={handleJoinRemote}>
                      Connect
                    </button>
                  </>
                )}
              </>
            )}
          </>
        )}

        {connectionState !== ConnectionState.IDLE &&
          !answerQRCodeUrl &&
          !waitingForAnswer && (
            <button className="button secondary" onClick={handleClose}>
              Close Connection
            </button>
          )}
      </div>

      {/* Offer QR Code Display (Step 1) */}
      {qrCodeUrl && !answerQRCodeUrl && (
        <div className="card">
          <h2>Step 1: Show QR Code</h2>
          <div className="qr-container">
            <img src={qrCodeUrl} alt="QR Code" className="qr-code" />
            <p className="info-text">Have the other device scan this code</p>
          </div>
          <button className="button secondary" onClick={handleCopyToken}>
            Copy Token JSON
          </button>
          <details style={{ marginTop: "10px" }}>
            <summary style={{ cursor: "pointer", padding: "5px" }}>
              Show Token JSON
            </summary>
            <textarea
              readOnly
              value={tokenJson}
              style={{
                width: "100%",
                minHeight: "100px",
                fontFamily: "monospace",
                fontSize: "10px",
                marginTop: "10px",
                padding: "8px",
              }}
            />
          </details>
        </div>
      )}

      {/* Answer QR Code Display (Step 2) */}
      {answerQRCodeUrl && (
        <div className="card">
          <h2>Step 2: Show This Answer QR Code</h2>
          <div className="qr-container">
            <img
              src={answerQRCodeUrl}
              alt="Answer QR Code"
              className="qr-code"
            />
            <p className="info-text">
              Show this code to the other device to complete the connection
            </p>
          </div>
        </div>
      )}

      {/* Video Scanner */}
      {isScanning && (
        <div className="card">
          <h2>
            {scannerReady ? "Scanning QR Code..." : "Initializing Camera..."}
          </h2>
          <div className="video-container" style={{ position: "relative" }}>
            <video
              ref={videoRef}
              className="video"
              autoPlay
              playsInline
              muted
              style={{ width: "100%", maxWidth: "100%", display: "block" }}
            />
            {!scannerReady && (
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  bottom: 0,
                  background: "rgba(0,0,0,0.7)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontSize: "16px",
                }}
              >
                Starting camera...
              </div>
            )}
          </div>
          <p className="info-text">
            {scannerReady
              ? "Point your camera at the QR code"
              : "Please allow camera access when prompted"}
          </p>
          <button className="button secondary" onClick={stopScanner}>
            Cancel
          </button>
        </div>
      )}

      {/* Messaging */}
      {connectionState === ConnectionState.CONNECTED && (
        <div className="card">
          <h2>Messages</h2>

          <div className="stats">
            <div className="stat">
              <div className="stat-value">{stats.sent}</div>
              <div className="stat-label">Sent</div>
            </div>
            <div className="stat">
              <div className="stat-value">{stats.received}</div>
              <div className="stat-label">Received</div>
            </div>
          </div>

          <div className="messages">
            {messages.map((msg, idx) => (
              <div key={idx} className="message received">
                <div className="message-type">{msg.type}</div>
                <pre>{JSON.stringify(msg.payload, null, 2)}</pre>
                <div className="message-time">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>

          <input
            type="text"
            className="input"
            placeholder="Enter message"
            value={messageInput}
            onChange={(e) => setMessageInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSendMessage()}
          />
          <button className="button" onClick={handleSendMessage}>
            Send Message
          </button>
          <button className="button secondary" onClick={handleTestPayment}>
            Send Test Payment
          </button>
        </div>
      )}
    </div>
  );
}

export default App;
