import { useEffect, useRef, useState } from "react";
import { AuthSocketClient } from "@bsv/authsocket-client";
import { OfferMessage, AnswerMessage, IceCandidateMessage } from "../types";

const STUN_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ],
};

interface UseWebRTCResult {
  call: (socketId: string) => Promise<void>;
  dataChannel: RTCDataChannel | null;
  connected: boolean;
}

export function useWebRTC(
  socket: ReturnType<typeof AuthSocketClient> | null,
): UseWebRTCResult {
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceCandidateBuffer = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescriptionSet = useRef(false);

  const [dataChannel, setDataChannel] = useState<RTCDataChannel | null>(null);
  const [connected, setConnected] = useState(false);

  const getOrCreatePC = () => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection(STUN_CONFIG);
    pcRef.current = pc;

    return pc;
  };

  useEffect(() => {
    if (!socket) return;

    socket.on("offer", async ({ from, sdp }: OfferMessage) => {
      const pc = getOrCreatePC();

      pc.ondatachannel = (event) => {
        const channel = event.channel;
        channel.onopen = () => {
          setDataChannel(channel);
          setConnected(true);
        };
        channel.onclose = () => {
          setDataChannel(null);
          setConnected(false);
        };
      };

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit("ice-candidate", {
            to: from,
            candidate: event.candidate,
          });
        }
      };

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      remoteDescriptionSet.current = true;

      // flush buffered candidates
      for (const candidate of iceCandidateBuffer.current) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
      iceCandidateBuffer.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("answer", { to: from, sdp: answer });
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

    return () => {
      pcRef.current?.close();
      pcRef.current = null;
      remoteDescriptionSet.current = false;
      iceCandidateBuffer.current = [];
    };
  }, [socket]);

  const call = async (targetSocketId: string) => {
    // reject any other connection if already connected
    if (pcRef.current) {
      console.warn("Already connected to a peer");
      return;
    }

    const pc = getOrCreatePC();

    const channel = pc.createDataChannel("payments");
    channel.onopen = () => {
      setDataChannel(channel);
      setConnected(true);
    };
    channel.onclose = () => {
      setDataChannel(null);
      setConnected(false);
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

  return { call, dataChannel, connected };
}
