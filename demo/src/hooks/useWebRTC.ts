import { useEffect, useRef, useState } from "react";
import { AuthSocketClient } from "@bsv/authsocket-client";
import { OfferMessage, AnswerMessage, IceCandidateMessage } from "../types";

const STUN_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

export interface IncomingCall {
  from: string;
  identityKey: string;
  sdp: RTCSessionDescriptionInit;
}

interface UseWebRTCResult {
  call: (socketId: string, identityKey: string) => Promise<void>;
  acceptCall: () => Promise<void>;
  rejectCall: () => void;
  disconnect: () => void;
  incomingCall: IncomingCall | null;
  callRejected: boolean;
  connecting: boolean;
  dataChannel: RTCDataChannel | null;
  connected: boolean;
  peerDisconnected: boolean;
  connectedPeerIdentityKey: string | null;
}

export function useWebRTC(
  socket: ReturnType<typeof AuthSocketClient> | null,
): UseWebRTCResult {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceCandidateBuffer = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSet = useRef(false);
  const pendingOfferRef = useRef<IncomingCall | null>(null);

  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [callRejected, setCallRejected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [connected, setConnected] = useState(false);
  const [peerDisconnected, setPeerDisconnected] = useState(false);
  const [connectedPeerIdentityKey, setConnectedPeerIdentityKey] = useState<
    string | null
  >(null);

  const getOrCreatePC = () => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection(STUN_CONFIG);
    pcRef.current = pc;
    return pc;
  };

  useEffect(() => {
    if (!socket) return;

    socket.on("offer", ({ from, identityKey, sdp }: OfferMessage) => {
      // Already connected — auto-reject the new offer
      if (pcRef.current) {
        socket.emit("reject", { to: from });
        return;
      }
      pendingOfferRef.current = { from, identityKey, sdp };
      setIncomingCall({ from, identityKey, sdp });
    });

    socket.on("answer", async ({ sdp }: AnswerMessage) => {
      await pcRef.current?.setRemoteDescription(new RTCSessionDescription(sdp));
      remoteDescriptionSet.current = true;

      for (const candidate of iceCandidateBuffer.current) {
        await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
      }
      iceCandidateBuffer.current = [];
    });

    socket.on("ice-candidate", async ({ candidate }: IceCandidateMessage) => {
      if (!remoteDescriptionSet.current) {
        iceCandidateBuffer.current.push(candidate);
        return;
      }
      await pcRef.current?.addIceCandidate(new RTCIceCandidate(candidate));
    });

    socket.on("rejected", () => {
      pcRef.current?.close();
      pcRef.current = null;
      setConnecting(false);
      setConnectedPeerIdentityKey(null);
      setCallRejected(true);
      setDataChannel(null);
      setConnected(false);
      setTimeout(() => setCallRejected(false), 3000);
    });

    return () => {
      pcRef.current?.close();
      pcRef.current = null;
      remoteDescriptionSet.current = false;
      iceCandidateBuffer.current = [];
    };
  }, [socket]);

  const acceptCall = async () => {
    const offer = pendingOfferRef.current;
    if (!offer || !socket) return;
    pendingOfferRef.current = null;
    setIncomingCall(null);

    const pc = getOrCreatePC();
    setPeerDisconnected(false);

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      const handleOpen = () => {
        setDataChannel(channel);
        setConnected(true);
        setConnectedPeerIdentityKey(offer.identityKey);
      };
      channel.onclose = () => {
        setDataChannel(null);
        setPeerDisconnected(true);
        pcRef.current = null;
        remoteDescriptionSet.current = false;
        iceCandidateBuffer.current = [];
      };
      // Channel may already be open by the time ondatachannel fires
      if (channel.readyState === "open") {
        handleOpen();
      } else {
        channel.onopen = handleOpen;
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit("ice-candidate", {
          to: offer.from,
          candidate: event.candidate,
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer.sdp));
    remoteDescriptionSet.current = true;

    for (const candidate of iceCandidateBuffer.current) {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
    iceCandidateBuffer.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer", { to: offer.from, sdp: answer });
  };

  const rejectCall = () => {
    const offer = pendingOfferRef.current;
    pendingOfferRef.current = null;
    setIncomingCall(null);
    if (offer && socket) {
      socket.emit("reject", { to: offer.from });
    }
  };

  const call = async (targetSocketId: string, targetIdentityKey: string) => {
    if (pcRef.current) {
      console.warn("Already connected to a peer");
      return;
    }

    setPeerDisconnected(false);
    setConnecting(true);
    setConnectedPeerIdentityKey(targetIdentityKey);

    const pc = getOrCreatePC();

    const channel = pc.createDataChannel("payments");
    channel.onopen = () => {
      setConnecting(false);
      setDataChannel(channel);
      setConnected(true);
    };
    channel.onclose = () => {
      setDataChannel(null);
      setPeerDisconnected(true);
      pcRef.current = null;
      remoteDescriptionSet.current = false;
      iceCandidateBuffer.current = [];
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket?.emit("ice-candidate", {
          to: targetSocketId,
          candidate: event.candidate,
        });
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket?.emit("offer", { to: targetSocketId, sdp: offer });
  };

  const disconnect = () => {
    pcRef.current?.close();
    pcRef.current = null;
    setConnecting(false);
    setDataChannel(null);
    setConnected(false);
    setPeerDisconnected(false);
    setConnectedPeerIdentityKey(null);
    iceCandidateBuffer.current = [];
    remoteDescriptionSet.current = false;
  };

  return {
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
  };
}
