import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isValidRoomId,
  getOrCreateRoom,
  getRoom,
  addPeer,
  removePeer,
  buildSnapshot,
  applyDeltaAdded,
  applyDeltaModified,
  applyDeltaRemoved,
  broadcastTo,
  nextSeq,
  startTtl,
  cancelTtl,
  type Room,
  type Peer,
} from './rooms.js';

// ---- isValidRoomId ---------------------------------------------------------

describe('isValidRoomId', () => {
  it('accepts a well-formed UUID v4', () => {
    // UUID v1 — third group starts with '1', not '4'
    expect(isValidRoomId('550e8400-e29b-11d4-a716-446655440000')).toBe(false);
    expect(isValidRoomId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidRoomId('')).toBe(false);
  });

  it('rejects path-traversal strings', () => {
    expect(isValidRoomId('../etc/passwd')).toBe(false);
    expect(isValidRoomId('../../foo')).toBe(false);
  });

  it('rejects non-UUID strings', () => {
    expect(isValidRoomId('hello-world')).toBe(false);
    expect(isValidRoomId('12345')).toBe(false);
  });

  it('accepts UUID v4 with uppercase hex', () => {
    expect(isValidRoomId('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true);
  });
});

// ---- Room lifecycle --------------------------------------------------------

describe('getOrCreateRoom', () => {
  const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

  it('creates a new room on first call', () => {
    const room = getOrCreateRoom(id);
    expect(room.id).toBe(id);
    expect(room.peers.size).toBe(0);
    expect(room.objects.size).toBe(0);
    expect(room.seq).toBe(0);
  });

  it('returns the same room on subsequent calls', () => {
    const a = getOrCreateRoom(id);
    const b = getOrCreateRoom(id);
    expect(a).toBe(b);
  });
});

describe('getRoom', () => {
  it('returns undefined for unknown room', () => {
    expect(getRoom('f47ac10b-58cc-4372-b567-0e02b2c3d479')).toBeUndefined();
  });
});

// ---- Peer management -------------------------------------------------------

function makeRoom(): Room {
  // Use a fresh UUID each time to avoid cross-test state leakage via the
  // module-level rooms Map.
  const id = crypto.randomUUID();
  return getOrCreateRoom(id);
}

function makePeer(id = 'peer-1', socket: unknown = {}): Peer {
  return { id, operatorId: null, cursor: null, socket };
}

describe('addPeer / removePeer', () => {
  it('adds and removes peers', () => {
    const room = makeRoom();
    const peer = makePeer();
    addPeer(room, peer);
    expect(room.peers.has('peer-1')).toBe(true);
    removePeer(room, 'peer-1');
    expect(room.peers.has('peer-1')).toBe(false);
  });

  it('removing a non-existent peer is a no-op', () => {
    const room = makeRoom();
    expect(() => removePeer(room, 'ghost')).not.toThrow();
  });
});

// ---- Snapshot builder ------------------------------------------------------

describe('buildSnapshot', () => {
  it('excludes the requesting peer from the peers list', () => {
    const room = makeRoom();
    addPeer(room, makePeer('alice'));
    addPeer(room, makePeer('bob'));
    const snap = buildSnapshot(room, 'alice');
    expect(snap.peers.map((p) => p.id)).toEqual(['bob']);
  });

  it('includes all canvas objects', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'obj-1', type: 'rect' } });
    applyDeltaAdded(room, { obj: { __id: 'obj-2', type: 'circle' } });
    const snap = buildSnapshot(room, 'anyone');
    expect(snap.canvas).toHaveLength(2);
  });

  it('reflects current seq', () => {
    const room = makeRoom();
    nextSeq(room);
    nextSeq(room);
    const snap = buildSnapshot(room, 'anyone');
    expect(snap.seq).toBe(2);
  });
});

// ---- Canvas delta appliers -------------------------------------------------

describe('applyDeltaAdded', () => {
  it('adds an object to the mirror', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'x1', type: 'line' } });
    expect(room.objects.has('x1')).toBe(true);
  });

  it('ignores objects without __id', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { type: 'line' } });
    expect(room.objects.size).toBe(0);
  });

  it('does not overwrite an existing object (idempotent add)', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'dup', color: 'red' } });
    applyDeltaAdded(room, { obj: { __id: 'dup', color: 'blue' } });
    expect((room.objects.get('dup')?.data as { color: string }).color).toBe('red');
  });
});

describe('applyDeltaModified', () => {
  it('merges a patch into the existing object', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'm1', left: 0, top: 0 } });
    const accepted = applyDeltaModified(room, { id: 'm1', patch: { left: 50 }, ts: 1 });
    expect(accepted).toBe(true);
    expect((room.objects.get('m1')?.data as { left: number }).left).toBe(50);
  });

  it('rejects a modification with equal or older timestamp (LWW)', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'lww', left: 0 } });
    applyDeltaModified(room, { id: 'lww', patch: { left: 10 }, ts: 100 });
    const rejected = applyDeltaModified(room, { id: 'lww', patch: { left: 99 }, ts: 100 });
    expect(rejected).toBe(false);
    expect((room.objects.get('lww')?.data as { left: number }).left).toBe(10);
  });

  it('returns false for unknown object id', () => {
    const room = makeRoom();
    const result = applyDeltaModified(room, { id: 'nope', patch: {}, ts: 1 });
    expect(result).toBe(false);
  });

  it('preserves fields not included in the patch', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'p1', __operatorId: 'alpha', left: 0 } });
    applyDeltaModified(room, { id: 'p1', patch: { left: 5 }, ts: 1 });
    expect((room.objects.get('p1')?.data as { __operatorId: string }).__operatorId).toBe('alpha');
  });
});

describe('applyDeltaRemoved', () => {
  it('removes an object from the mirror', () => {
    const room = makeRoom();
    applyDeltaAdded(room, { obj: { __id: 'del-me', type: 'line' } });
    applyDeltaRemoved(room, 'del-me');
    expect(room.objects.has('del-me')).toBe(false);
  });

  it('removing a non-existent id is a no-op', () => {
    const room = makeRoom();
    expect(() => applyDeltaRemoved(room, 'ghost')).not.toThrow();
  });
});

// ---- broadcastTo -----------------------------------------------------------

describe('broadcastTo', () => {
  it('calls send for all peers except excluded', () => {
    const room = makeRoom();
    const sockA = {};
    const sockB = {};
    const sockC = {};
    addPeer(room, makePeer('a', sockA));
    addPeer(room, makePeer('b', sockB));
    addPeer(room, makePeer('c', sockC));

    const sends: unknown[] = [];
    broadcastTo(room, { type: 'test' }, 'a', (sock, _data) => {
      sends.push(sock);
    });

    expect(sends).toContain(sockB);
    expect(sends).toContain(sockC);
    expect(sends).not.toContain(sockA);
  });

  it('sends to all peers when excludePeerId is null', () => {
    const room = makeRoom();
    const socks = [{}, {}];
    addPeer(room, makePeer('x', socks[0]));
    addPeer(room, makePeer('y', socks[1]));

    const sent: unknown[] = [];
    broadcastTo(room, { type: 'peer:left', peerId: 'z' }, null, (sock, _data) => {
      sent.push(sock);
    });

    expect(sent).toHaveLength(2);
  });

  it('does not throw when send throws (stale socket)', () => {
    const room = makeRoom();
    addPeer(room, makePeer('err'));
    expect(() =>
      broadcastTo(room, {}, null, () => {
        throw new Error('socket closed');
      }),
    ).not.toThrow();
  });
});

// ---- nextSeq ---------------------------------------------------------------

describe('nextSeq', () => {
  it('increments and returns the new sequence number', () => {
    const room = makeRoom();
    expect(nextSeq(room)).toBe(1);
    expect(nextSeq(room)).toBe(2);
    expect(room.seq).toBe(2);
  });
});

// ---- TTL -------------------------------------------------------------------

describe('startTtl / cancelTtl', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('TTL fires after 24h and deletes the room', () => {
    const room = makeRoom();
    startTtl(room);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(getRoom(room.id)).toBeUndefined();
  });

  it('cancelTtl prevents deletion', () => {
    const room = makeRoom();
    startTtl(room);
    cancelTtl(room);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    expect(getRoom(room.id)).toBeDefined();
  });
});
