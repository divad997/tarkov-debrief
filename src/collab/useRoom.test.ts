// Unit tests for useRoom hook.
// Uses a mock WebSocket via src/test/mockWebSocket.ts (created here for P3.1).
//
// Design reference: claudedocs/design_p3_multiplayer.md §6

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRoom, getOrCreatePeerId } from './useRoom';

// ---- MockWebSocket ---------------------------------------------------------

type EventCallback = (event?: unknown) => void;

class MockWebSocket {
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  url: string;
  // Stores every message sent by the client
  sent: string[] = [];

  private listeners: Record<string, EventCallback[]> = {};

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastInstance = this;
    // Simulate async open on next tick
    setTimeout(() => this.dispatchOpen(), 0);
  }

  addEventListener(type: string, cb: EventCallback): void {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchClose(true);
  }

  // Test helpers to simulate server events
  dispatchOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    (this.listeners['open'] ?? []).forEach((cb) => cb());
  }

  dispatchMessage(data: unknown): void {
    (this.listeners['message'] ?? []).forEach((cb) =>
      cb({ data: JSON.stringify(data) } as unknown),
    );
  }

  dispatchClose(wasClean = false): void {
    (this.listeners['close'] ?? []).forEach((cb) => cb({ wasClean } as unknown));
  }

  dispatchError(): void {
    (this.listeners['error'] ?? []).forEach((cb) => cb());
  }

  static lastInstance: MockWebSocket | null = null;
}

// ---- Setup -----------------------------------------------------------------

const ROOM_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const PEER_ID = 'aaaa-bbbb-cccc-dddd-eeee';

beforeEach(() => {
  vi.useFakeTimers();
  // Patch global WebSocket
  vi.stubGlobal('WebSocket', MockWebSocket);
  MockWebSocket.lastInstance = null;
  // Provide crypto.randomUUID
  vi.stubGlobal('crypto', { randomUUID: vi.fn().mockReturnValue(PEER_ID) });
  // Clear sessionStorage peerId so getOrCreatePeerId always starts fresh
  sessionStorage.removeItem('tarkov-debrief:peerId');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---- getOrCreatePeerId -----------------------------------------------------

describe('getOrCreatePeerId', () => {
  it('generates and stores a UUID on first call', () => {
    const id = getOrCreatePeerId();
    expect(id).toBe(PEER_ID);
    expect(sessionStorage.getItem('tarkov-debrief:peerId')).toBe(PEER_ID);
  });

  it('returns the stored UUID on subsequent calls', () => {
    sessionStorage.setItem('tarkov-debrief:peerId', 'existing-id');
    const id = getOrCreatePeerId();
    expect(id).toBe('existing-id');
  });
});

// ---- useRoom ---------------------------------------------------------------

describe('useRoom', () => {
  it('is idle when roomId is null', () => {
    const { result } = renderHook(() => useRoom(null, PEER_ID, null));
    expect(result.current.status).toBe('idle');
    expect(result.current.peers).toEqual([]);
  });

  it('transitions to connected after WebSocket opens', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    expect(result.current.status).toBe('connecting');

    await act(async () => {
      vi.advanceTimersByTime(0); // flush the setTimeout in MockWebSocket constructor
    });

    expect(result.current.status).toBe('connected');
  });

  it('sends a join message after connecting', async () => {
    renderHook(() => useRoom(ROOM_ID, PEER_ID, 'alpha'));

    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    const ws = MockWebSocket.lastInstance!;
    expect(ws.sent.length).toBeGreaterThan(0);
    const join = JSON.parse(ws.sent[0]);
    expect(join.type).toBe('join');
    expect(join.peerId).toBe(PEER_ID);
    expect(join.operatorId).toBe('alpha');
  });

  it('populates peers from a snapshot message', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));

    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    act(() => {
      MockWebSocket.lastInstance!.dispatchMessage({
        type: 'snapshot',
        canvas: [],
        peers: [{ id: 'bob', operatorId: 'bravo', cursor: null }],
        seq: 0,
      });
    });

    expect(result.current.peers).toEqual([
      { id: 'bob', operatorId: 'bravo', cursor: null },
    ]);
  });

  it('adds a peer on peer:joined', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      MockWebSocket.lastInstance!.dispatchMessage({
        type: 'peer:joined', peerId: 'charlie', operatorId: 'charlie', ts: 1,
      });
    });

    expect(result.current.peers.some((p) => p.id === 'charlie')).toBe(true);
  });

  it('does not duplicate a peer on repeated peer:joined', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      MockWebSocket.lastInstance!.dispatchMessage({
        type: 'peer:joined', peerId: 'dupe', operatorId: null, ts: 1,
      });
      MockWebSocket.lastInstance!.dispatchMessage({
        type: 'peer:joined', peerId: 'dupe', operatorId: null, ts: 2,
      });
    });

    expect(result.current.peers.filter((p) => p.id === 'dupe')).toHaveLength(1);
  });

  it('removes a peer on peer:left', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      MockWebSocket.lastInstance!.dispatchMessage({
        type: 'peer:joined', peerId: 'eve', operatorId: null, ts: 1,
      });
    });
    act(() => {
      MockWebSocket.lastInstance!.dispatchMessage({
        type: 'peer:left', peerId: 'eve', ts: 2,
      });
    });

    expect(result.current.peers.some((p) => p.id === 'eve')).toBe(false);
  });

  it('schedules a reconnect after an unclean close', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });

    expect(result.current.status).toBe('connected');

    act(() => {
      MockWebSocket.lastInstance!.dispatchClose(/* wasClean= */ false);
    });

    expect(result.current.status).toBe('connecting');

    // First backoff is 1000ms.
    // Advance in two steps: the reconnect timer fires at 1000ms and schedules
    // a new MockWebSocket open event via setTimeout(0). Advancing by 1ms on
    // the second step catches that 0ms timer regardless of whether
    // advanceTimersByTime fires timers created at exactly clock.now.
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await act(async () => {
      vi.advanceTimersByTime(1); // fire the 0ms open timer from the reconnect
    });

    expect(result.current.status).toBe('connected');
  });

  it('does not reconnect after a clean close', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      MockWebSocket.lastInstance!.dispatchClose(/* wasClean= */ true);
    });

    expect(result.current.status).toBe('idle');

    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(result.current.status).toBe('idle');
  });

  it('returns to idle when roomId becomes null', async () => {
    let roomId: string | null = ROOM_ID;
    const { result, rerender } = renderHook(() => useRoom(roomId, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(result.current.status).toBe('connected');

    roomId = null;
    rerender();
    expect(result.current.status).toBe('idle');
    expect(result.current.peers).toEqual([]);
  });

  it('send is a no-op when disconnected', () => {
    const { result } = renderHook(() => useRoom(null, PEER_ID, null));
    expect(() =>
      result.current.send({ type: 'cursor', peerId: PEER_ID, x: 0, y: 0 }),
    ).not.toThrow();
  });

  it('send transmits a message when connected', async () => {
    const { result } = renderHook(() => useRoom(ROOM_ID, PEER_ID, null));
    await act(async () => { vi.advanceTimersByTime(0); });

    act(() => {
      result.current.send({ type: 'cursor', peerId: PEER_ID, x: 42, y: 7 });
    });

    const ws = MockWebSocket.lastInstance!;
    const lastSent = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(lastSent.type).toBe('cursor');
    expect(lastSent.x).toBe(42);
  });
});

// Silence unused-var lint for Mock type
void (undefined as unknown as Mock);
