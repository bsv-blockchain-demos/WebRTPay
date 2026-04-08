import express from "express";
import { createServer } from "http";
import { AuthSocketServer, AuthSocket } from "@bsv/authsocket";
import { ProtoWallet, PrivateKey, WalletInterface } from "@bsv/sdk";
import "dotenv/config";
import {
  JoinRoomPayload,
  ForwardPayload,
  IceCandidatePayload,
  PeerInfo,
  PeerLeftPayload,
  ErrorPayload,
} from "./types";

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT ?? 8080;

const serverPrivateKey = process.env.SERVER_PRIVATE_KEY;
if (!serverPrivateKey)
  throw new Error("SERVER_PRIVATE_KEY env var is required");
const privateKey = PrivateKey.fromString(serverPrivateKey);
const wallet = new ProtoWallet(privateKey) as unknown as WalletInterface;

const io = new AuthSocketServer(httpServer, {
  wallet,
  cors: { origin: process.env.CORS_ORIGIN },
});

// maps roomId to Map<socketId, identityKey>
const rooms = new Map<string, Map<string, string>>();
const sockets = new Map<string, AuthSocket>();

io.on("connection", (socket) => {
  console.log("[+] connected: ", socket.id);
  sockets.set(socket.id, socket);

  socket.on("join-room", ({ roomId }: JoinRoomPayload) => {
    if (
      typeof roomId !== "string" ||
      roomId.length === 0 ||
      roomId.length > 128
    ) {
      console.warn(`[room] invalid roomId from ${socket.id}`);
      const err: ErrorPayload = { message: "Invalid roomId" };
      socket.emit("error", err);
      return;
    }

    const identityKey = socket.identityKey ?? "unknown";
    console.log(`[room:${roomId}] ${identityKey.slice(0, 8)}... joined`);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }
    const room = rooms.get(roomId)!; // at this point this will be defined

    // notify existing peers that someone joined
    room.forEach((_, peerId) => {
      const joined: PeerInfo = { socketId: socket.id, identityKey }
      sockets.get(peerId)?.emit("peer-joined", joined);
    });

    // send current peer list to joining socket
    const peers: PeerInfo[] = Array.from(room.entries()).map(([socketId, ik]) => ({
      socketId,
      identityKey: ik,
    }));
    socket.emit("peers", peers);

    room.set(socket.id, identityKey);
  });

  // sdp and candidate are typed as unknown — server only routes them, never reads them
  socket.on("offer", ({ to, sdp }: ForwardPayload) => {
    sockets.get(to)?.emit("offer", { from: socket.id, identityKey: socket.identityKey, sdp });
  });

  socket.on("answer", ({ to, sdp }: ForwardPayload) => {
    sockets.get(to)?.emit("answer", { from: socket.id, sdp });
  });

  socket.on("ice-candidate", ({ to, candidate }: IceCandidatePayload) => {
    sockets.get(to)?.emit("ice-candidate", { from: socket.id, candidate });
  });

  socket.ioSocket.on("disconnect", () => {
    console.log("[-] disconnected: ", socket.id);
    sockets.delete(socket.id);

    rooms.forEach((room, roomId) => {
      if (!room.has(socket.id)) return;

      const identityKey = room.get(socket.id);
      room.delete(socket.id);
      const left: PeerLeftPayload = { socketId: socket.id, identityKey };
      room.forEach((_, peerId) => {
        sockets.get(peerId)?.emit("peer-left", left);
      });
      if (room.size === 0) rooms.delete(roomId);
    });
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", rooms: rooms.size, peers: sockets.size });
});

httpServer.listen(PORT, () => {
  console.log(`Signaling server on http://localhost:${PORT}`);
});
