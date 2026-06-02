// P3 WebSocket relay server — Node.js 20 + ws.
//
// Each room is a broadcast group: every message from a peer is stamped with
// `ts` (server monotonic time) and re-broadcast to all other peers in the room.
// The server also maintains a canonical canvas mirror so late-joining peers
// receive a full snapshot on join instead of replaying the full event log.
//
// Design reference: claudedocs/design_p3_multiplayer.md §5

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  isValidRoomId,
  getOrCreateRoom,
  addPeer,
  removePeer,
  buildSnapshot,
  applyDeltaAdded,
  applyDeltaModified,
  applyDeltaRemoved,
  broadcastTo,
  nextSeq,
  startTtl,
} from './rooms.js';
import type { ClientMessage } from '../../src/collab/protocol.js';

const PORT = Number(process.env.PORT ?? 3001);

// ---- HTTP health-check server ---------------------------------------------

const http = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

// ---- WebSocket server ------------------------------------------------------

// Path: /room/{roomId}  — any other path is rejected with code 4400.
const wss = new WebSocketServer({ noServer: true });

http.on('upgrade', (req, socket, head) => {
  const match = /^\/room\/([^/?#]+)/.exec(req.url ?? '');
  const roomId = match?.[1] ?? '';

  if (!isValidRoomId(roomId)) {
    // Upgrade rejected — not a valid UUID v4. §5.5
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, roomId);
  });
});

// Helper so rooms.ts doesn't import ws directly. §5 (broadcastTo contract)
function send(socket: unknown, data: string): void {
  const ws = socket as WebSocket;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

wss.on('connection', (ws: WebSocket, _req: unknown, roomId: string) => {
  const room = getOrCreateRoom(roomId);
  // peerId is unknown until the client sends `join`; track the socket so we
  // can clean up on close even if `join` never arrives.
  let peerId: string | null = null;

  ws.on('message', (raw: Buffer | string) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: 'error', code: 'PARSE_ERROR', message: 'Invalid JSON' }));
      return;
    }

    const ts = Date.now();

    switch (msg.type) {
      case 'join': {
        peerId = msg.peerId;
        addPeer(room, {
          id: msg.peerId,
          operatorId: msg.operatorId,
          cursor: null,
          socket: ws,
        });

        // Send the full canvas snapshot to the newly joined peer first, then
        // notify everyone else. Order matters: the joiner needs its baseline
        // before it processes any subsequent deltas. §4.4
        const snapshot = buildSnapshot(room, msg.peerId);
        ws.send(JSON.stringify({ type: 'snapshot', ...snapshot }));

        broadcastTo(
          room,
          { type: 'peer:joined', peerId: msg.peerId, operatorId: msg.operatorId, ts },
          msg.peerId,
          send,
        );
        break;
      }

      case 'leave': {
        if (peerId) handleLeave(peerId);
        break;
      }

      case 'delta:added': {
        const seq = nextSeq(room);
        applyDeltaAdded(room, msg);
        broadcastTo(room, { ...msg, ts, seq }, msg.peerId, send);
        break;
      }

      case 'delta:modified': {
        const seq = nextSeq(room);
        const msgTs = msg.ts ?? ts;
        // Server stamps ts if client omitted it (spec §4.2 allows client to
        // include its own timestamp for latency estimation). The mirror always
        // uses the server-assigned ts for LWW comparisons.
        const stamped = { ...msg, ts: msgTs, seq };
        const accepted = applyDeltaModified(room, { ...msg, ts: msgTs });
        if (accepted) {
          broadcastTo(room, stamped, msg.peerId, send);
        }
        break;
      }

      case 'delta:removed': {
        const seq = nextSeq(room);
        applyDeltaRemoved(room, msg.id);
        broadcastTo(room, { ...msg, ts, seq }, msg.peerId, send);
        break;
      }

      // Pass-through messages — not applied to canvas mirror, just relayed.
      // cursor / path:stroke / path:commit / chip:claim / chip:release
      case 'cursor': {
        // Update the peer's cursor in the room mirror so late-joiners get
        // current positions in their snapshot. §9.1
        const peer = room.peers.get(msg.peerId);
        if (peer) {
          peer.cursor = { x: msg.x, y: msg.y };
        }
        broadcastTo(room, { ...msg, ts }, msg.peerId, send);
        break;
      }

      case 'path:stroke':
      case 'path:commit':
      case 'chip:claim':
      case 'chip:release': {
        broadcastTo(room, { ...msg, ts }, msg.peerId, send);
        break;
      }

      default: {
        // Exhaustive check — TypeScript would catch unhandled variants at
        // compile time, but guard here so a misbehaving client doesn't crash
        // the server.
        ws.send(
          JSON.stringify({ type: 'error', code: 'UNKNOWN_TYPE', message: 'Unknown message type' }),
        );
      }
    }
  });

  ws.on('close', () => {
    if (peerId) handleLeave(peerId);
  });

  ws.on('error', (err) => {
    console.error(`[ws] error from peer ${peerId ?? '(unknown)'}:`, err.message);
    if (peerId) handleLeave(peerId);
  });

  function handleLeave(id: string): void {
    removePeer(room, id);
    broadcastTo(room, { type: 'peer:left', peerId: id, ts: Date.now() }, null, send);
    // Start TTL countdown if this was the last peer. §5.4
    if (room.peers.size === 0) {
      startTtl(room);
    }
    // Prevent double-handling if ws.on('close') fires after explicit 'leave'
    peerId = null;
  }
});

// ---- Start -----------------------------------------------------------------

http.listen(PORT, () => {
  console.log(`[debrief-server] listening on :${PORT}`);
});
