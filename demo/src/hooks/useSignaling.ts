import { AuthSocketClient } from "@bsv/authsocket-client";
import { WalletInterface } from "@bsv/sdk";
import { useEffect, useRef, useState } from "react";
import { Peer } from "../types";

interface UseSignalingResult {
  socket: ReturnType<typeof AuthSocketClient> | null;
  peers: Peer[];
  roomId: string;
  error: string | null;
}

export function useSignaling(
  wallet: WalletInterface | null,
  serverUrl: string,
): UseSignalingResult {
  const [socket, setSocket] = useState<ReturnType<
    typeof AuthSocketClient
  > | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [roomId] = useState<string>(() => {
    const existing = window.location.hash.replace("#", "");
    if (existing) return existing;

    const generated = crypto.randomUUID();
    window.location.hash = generated;

    return generated;
  });

  useEffect(() => {
    if (!wallet) return;

    const socket = AuthSocketClient(serverUrl, { wallet });
    setSocket(socket);

    socket.on("connect", () => {
      socket.emit("join-room", { roomId });
    });

    socket.on("peers", (peerList: Peer[]) => {
      setPeers(peerList);
    });

    socket.on("peer-joined", (peer: Peer) => {
      setPeers((prev) => [...prev, peer]);
    });

    socket.on("peer-left", ({ socketId }: { socketId: string }) => {
      setPeers((prev) => prev.filter((p) => p.socketId !== socketId));
    });

    socket.on("error", ({ message }: { message: string }) => {
      setError(message);
    });

    return () => {
      socket.disconnect();
      setSocket(null);
    };
  }, [wallet, serverUrl, roomId]);

  return { socket, peers, roomId, error };
}
