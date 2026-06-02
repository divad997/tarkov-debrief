// WebSocket lifecycle hook for P3 multiplayer rooms.
//
// Manages the connection to the relay server, peer registry, and snapshot
// application. Canvas sync (delta broadcast + apply) lives in P3.2; this hook
// only covers room presence for the P3.1 milestone.
//
// Design reference: claudedocs/design_p3_multiplayer.md §6

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, InboundMessage, PeerInfo } from './protocol';

// Dev fallback to ws:// — prod must set VITE_WS_HOST to a wss:// URL because
// the client is served from HTTPS and browsers block ws:// mixed content. §5.6
const WS_BASE =
  typeof import.meta.env !== 'undefined' && import.meta.env.VITE_WS_HOST
    ? (import.meta.env.VITE_WS_HOST as string)
    : 'ws://localhost:3001';

// Exponential backoff delays (ms) for reconnect attempts. §6.3
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export type RoomStatus = 'idle' | 'connecting' | 'connected' | 'error';

export type UseRoomReturn = {
  status: RoomStatus;
  peers: PeerInfo[];
  /** Fire-and-forget send. Silently no-ops when disconnected. */
  send: (msg: ClientMessage) => void;
};

// Retrieves or generates the local peer ID from sessionStorage. Using
// sessionStorage (not localStorage) ensures a fresh peer ID per browser tab —
// two tabs opened to the same room will appear as two distinct peers. §6.1
export function getOrCreatePeerId(): string {
  const stored = sessionStorage.getItem('tarkov-debrief:peerId');
  if (stored) return stored;
  const id = crypto.randomUUID();
  sessionStorage.setItem('tarkov-debrief:peerId', id);
  return id;
}

export function useRoom(
  roomId: string | null,
  peerId: string,
  operatorId: string | null,
): UseRoomReturn {
  const [status, setStatus] = useState<RoomStatus>('idle');
  const [peers, setPeers] = useState<PeerInfo[]>([]);

  // Stable ref to the live WebSocket so the beforeunload handler and the
  // send callback can reach it without closing over a stale value. §6.3
  const wsRef = useRef<WebSocket | null>(null);
  // Reconnect attempt counter. Reset to 0 on a clean disconnect.
  const attemptRef = useRef(0);
  // Guards against scheduling a second reconnect while one is pending. §6.3
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Let the cleanup effect know whether the unmount was intentional (roomId
  // became null) or a transient reconnect scenario.
  const intentionalCloseRef = useRef(false);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  useEffect(() => {
    if (!roomId) {
      // Not in a room — tear down any existing connection cleanly.
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'left room');
        wsRef.current = null;
      }
      setPeers([]);
      setStatus('idle');
      return;
    }

    let active = true; // guards against stale-closure effects after cleanup

    function connect(): void {
      if (!active) return;
      setStatus('connecting');
      const url = `${WS_BASE}/room/${roomId}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      intentionalCloseRef.current = false;

      ws.addEventListener('open', () => {
        if (!active) { ws.close(); return; }
        attemptRef.current = 0;
        setStatus('connected');
        // Announce ourselves to the room. §4.2 JoinMessage
        const joinMsg: ClientMessage = { type: 'join', peerId, operatorId };
        ws.send(JSON.stringify(joinMsg));
      });

      ws.addEventListener('message', (event: MessageEvent<string>) => {
        if (!active) return;
        let msg: InboundMessage;
        try {
          msg = JSON.parse(event.data) as InboundMessage;
        } catch {
          return;
        }
        handleInbound(msg);
      });

      ws.addEventListener('close', (event) => {
        wsRef.current = null;
        if (!active) return;
        if (intentionalCloseRef.current) return;

        if (event.wasClean) {
          // Server closed normally (e.g. room TTL expired). Don't reconnect.
          setStatus('idle');
          setPeers([]);
          return;
        }

        // Unclean close (network drop, server crash) — attempt reconnect with
        // exponential backoff. §6.3
        setStatus('connecting');
        const delay = BACKOFF_MS[Math.min(attemptRef.current, BACKOFF_MS.length - 1)];
        attemptRef.current++;
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connect();
        }, delay);
      });

      ws.addEventListener('error', () => {
        // 'close' always fires after 'error'; reconnect logic lives there.
        setStatus('error');
      });
    }

    function handleInbound(msg: InboundMessage): void {
      switch (msg.type) {
        case 'snapshot':
          // Full canvas state + current peer list sent on join. Replace the
          // local peers list entirely. Canvas objects are handled in P3.2.
          setPeers(msg.peers);
          break;

        case 'peer:joined':
          setPeers((cur) => {
            // Guard against duplicate joins (e.g. on reconnect). §6.3
            if (cur.some((p) => p.id === msg.peerId)) return cur;
            return [...cur, { id: msg.peerId, operatorId: msg.operatorId, cursor: null }];
          });
          break;

        case 'peer:left':
          setPeers((cur) => cur.filter((p) => p.id !== msg.peerId));
          break;

        case 'cursor':
          // Update cursor position without triggering a full re-render of
          // peer-dependent UI — only GhostCursorLayer cares (P3.3).
          // For P3.1 we store it in the peers state so the data model is
          // correct; the ghost overlay that reads it is added in P3.3.
          setPeers((cur) =>
            cur.map((p) =>
              p.id === msg.peerId ? { ...p, cursor: { x: msg.x, y: msg.y } } : p,
            ),
          );
          break;

        case 'chip:claim':
          setPeers((cur) =>
            cur.map((p) =>
              p.id === msg.peerId ? { ...p, operatorId: msg.operatorId } : p,
            ),
          );
          break;

        case 'chip:release':
          setPeers((cur) =>
            cur.map((p) =>
              p.id === msg.peerId ? { ...p, operatorId: null } : p,
            ),
          );
          break;

        // delta:added / delta:modified / delta:removed / path:stroke /
        // path:commit / error — handled in P3.2+
        default:
          break;
      }
    }

    connect();

    // Register beforeunload so the server gets a clean close even on tab
    // crash. useEffect cleanup doesn't run on tab close. §6.3
    function onBeforeUnload(): void {
      intentionalCloseRef.current = true;
      const ws = wsRef.current;
      if (ws) {
        // Send an explicit leave so the server can broadcast peer:left
        // to remaining peers before the TCP connection drops. §4.2
        try {
          ws.send(JSON.stringify({ type: 'leave', peerId }));
        } catch {
          // Socket may already be closing.
        }
        ws.close(1000, 'page unload');
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload);

    return () => {
      active = false;
      intentionalCloseRef.current = true;
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.send(JSON.stringify({ type: 'leave', peerId }));
        } catch {
          // Best-effort.
        }
        ws.close(1000, 'unmount');
        wsRef.current = null;
      }
      setPeers([]);
    };
    // operatorId intentionally excluded from deps — a chip change after join
    // is sent via chip:claim, not by reconnecting. §6.1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, peerId]);

  return { status, peers, send };
}
