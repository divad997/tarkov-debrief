// Pure room data model — no WebSocket imports so functions are unit-testable
// without a live server. The index.ts layer owns all ws.WebSocket references.
//
// Design reference: claudedocs/design_p3_multiplayer.md §5

import type {
  FabricJSON,
  PeerInfo,
  DeltaAddedMessage,
  DeltaModifiedMessage,
} from '../../src/collab/protocol.js';

// ---- Types -----------------------------------------------------------------

export type CanvasObject = {
  id: string;
  data: FabricJSON;
  // Server-assigned monotonic timestamp of the last modification; used to
  // reject out-of-order delta:modified messages (last-write-wins). §4.5
  lastModifiedTs: number;
};

export type Peer = {
  id: string;
  operatorId: string | null;
  cursor: { x: number; y: number } | null;
  // Opaque handle supplied by the caller (index.ts). Kept as `unknown` here
  // so rooms.ts remains import-free of the ws package.
  socket: unknown;
};

export type Room = {
  id: string;
  peers: Map<string, Peer>;
  // Canonical canvas state keyed by __id. Used to build join snapshots. §5.3
  objects: Map<string, CanvasObject>;
  // Monotonic event sequence counter; written into every relayed delta as
  // `seq` so clients can discard buffered events after a snapshot. §4.4
  seq: number;
  // Timeout handle for the 24-hour TTL after the last peer leaves. §5.4
  ttlHandle: ReturnType<typeof setTimeout> | null;
};

// ---- Validation ------------------------------------------------------------

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Validates roomId before use as a Map key to prevent path-traversal-style
// injection. Only UUID v4 strings are accepted. §5.5
export function isValidRoomId(id: string): boolean {
  return UUID_V4_RE.test(id);
}

// ---- Room lifecycle --------------------------------------------------------

const rooms = new Map<string, Room>();

const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24h §5.4

export function getOrCreateRoom(id: string): Room {
  let room = rooms.get(id);
  if (!room) {
    room = { id, peers: new Map(), objects: new Map(), seq: 0, ttlHandle: null };
    rooms.set(id, room);
  }
  // If a peer re-joins before TTL fires, cancel the pending destruction. §5.4
  cancelTtl(room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function startTtl(room: Room): void {
  cancelTtl(room);
  room.ttlHandle = setTimeout(() => {
    rooms.delete(room.id);
  }, ROOM_TTL_MS);
}

export function cancelTtl(room: Room): void {
  if (room.ttlHandle !== null) {
    clearTimeout(room.ttlHandle);
    room.ttlHandle = null;
  }
}

// ---- Peer management -------------------------------------------------------

export function addPeer(room: Room, peer: Peer): void {
  room.peers.set(peer.id, peer);
}

export function removePeer(room: Room, peerId: string): void {
  room.peers.delete(peerId);
}

// ---- Snapshot builder ------------------------------------------------------

// Builds the full-canvas snapshot sent to a newly joined peer. §5.3
export function buildSnapshot(
  room: Room,
  excludePeerId: string,
): { canvas: FabricJSON[]; peers: PeerInfo[]; seq: number } {
  const canvas = Array.from(room.objects.values()).map((o) => o.data);
  const peers: PeerInfo[] = Array.from(room.peers.values())
    .filter((p) => p.id !== excludePeerId)
    .map((p) => ({ id: p.id, operatorId: p.operatorId, cursor: p.cursor }));
  return { canvas, peers, seq: room.seq };
}

// ---- Canvas delta appliers -------------------------------------------------
// These update the server's canonical canvas mirror so late-joining peers
// get a complete picture without replaying the full event log. §5.3

export function applyDeltaAdded(
  room: Room,
  msg: Pick<DeltaAddedMessage, 'obj'>,
): void {
  const id = (msg.obj['__id'] as string | undefined) ?? '';
  if (!id) return;
  // Don't overwrite if already present — handles replay on reconnect. §7.3
  if (!room.objects.has(id)) {
    room.objects.set(id, { id, data: msg.obj, lastModifiedTs: room.seq });
  }
}

export function applyDeltaModified(
  room: Room,
  msg: Pick<DeltaModifiedMessage, 'id' | 'patch' | 'ts'>,
): boolean {
  const existing = room.objects.get(msg.id);
  if (!existing) return false; // Object unknown — client may be out of sync; reject
  // Last-write-wins: reject if an equal or later modification is already recorded. §4.5
  const incomingTs = msg.ts ?? 0;
  if (existing.lastModifiedTs >= incomingTs) return false;
  // Shallow-merge the patch rather than replacing the whole object, so fields
  // not included in the patch (e.g. __operatorId) are preserved.
  existing.data = { ...existing.data, ...msg.patch };
  existing.lastModifiedTs = incomingTs;
  return true;
}

export function applyDeltaRemoved(room: Room, id: string): void {
  room.objects.delete(id);
}

// ---- Broadcast helper ------------------------------------------------------

// `send` is injected by index.ts so rooms.ts stays free of ws imports.
export function broadcastTo(
  room: Room,
  payload: unknown,
  excludePeerId: string | null,
  send: (socket: unknown, data: string) => void,
): void {
  const text = JSON.stringify(payload);
  for (const peer of room.peers.values()) {
    if (peer.id === excludePeerId) continue;
    try {
      send(peer.socket, text);
    } catch {
      // Socket may have closed between check and send; ignore stale entries.
      // The disconnect handler in index.ts will clean them up on the next event.
    }
  }
}

// ---- Sequence counter ------------------------------------------------------

export function nextSeq(room: Room): number {
  return ++room.seq;
}
