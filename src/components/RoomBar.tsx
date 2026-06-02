// P3 room connection status bar. Sits between the header and the canvas area.
//
// Shows: room ID input, connection status pill, peer count.
// The user can type or paste a UUID to join a room; "New" generates a fresh
// one; "Copy link" writes a shareable URL to the clipboard.
//
// Design reference: claudedocs/design_p3_multiplayer.md §9.2

import React, { useCallback, useRef } from 'react';
import type { RoomStatus } from '../collab/useRoom';
import './RoomBar.css';

interface RoomBarProps {
  roomId: string | null;
  status: RoomStatus;
  peerCount: number;
  onChange: (roomId: string | null) => void;
}

const STATUS_LABELS: Record<RoomStatus, string> = {
  idle: 'offline',
  connecting: 'connecting…',
  connected: 'live',
  error: 'error',
};

export function RoomBar({ roomId, status, peerCount, onChange }: RoomBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleNew = useCallback(() => {
    const id = crypto.randomUUID();
    onChange(id);
  }, [onChange]);

  const handleLeave = useCallback(() => {
    onChange(null);
  }, [onChange]);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value.trim();
      // Only accept when value looks like a UUID — prevents typo-driven
      // partial connections. The user must paste or type a full UUID.
      const UUID_V4_RE =
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (UUID_V4_RE.test(val)) {
        onChange(val);
      } else if (val === '') {
        onChange(null);
      }
    },
    [onChange],
  );

  const handleCopy = useCallback(() => {
    if (!roomId) return;
    // Build a shareable URL by appending the room ID as a query param to the
    // current hash URL. The receiver pastes the room ID from the URL into their
    // RoomBar. Full URL-based auto-join is a P3.N concern.
    const url = `${window.location.href.split('?')[0]}?room=${roomId}`;
    navigator.clipboard.writeText(url).catch(() => {
      // Clipboard API requires user gesture in some browsers; fall back to
      // showing the ID in the input so the user can copy it manually.
    });
  }, [roomId]);

  return (
    <div className="RoomBar" role="toolbar" aria-label="Multiplayer room">
      <span className="RoomBar-label">Room</span>
      <input
        ref={inputRef}
        className="RoomBar-input"
        type="text"
        placeholder="paste room ID to join…"
        value={roomId ?? ''}
        onChange={handleInputChange}
        // Selecting the text on focus makes it easy to paste over
        onFocus={(e) => e.currentTarget.select()}
        spellCheck={false}
        aria-label="Room ID"
      />
      {!roomId ? (
        <button className="RoomBar-btn" onClick={handleNew} title="Create a new room">
          New
        </button>
      ) : (
        <>
          <button className="RoomBar-btn" onClick={handleCopy} title="Copy shareable link">
            Copy link
          </button>
          <button className="RoomBar-btn RoomBar-btn--leave" onClick={handleLeave} title="Leave room">
            Leave
          </button>
        </>
      )}
      <span
        className={`RoomBar-status RoomBar-status--${status}`}
        aria-live="polite"
        aria-label={`Connection status: ${STATUS_LABELS[status]}`}
      >
        {STATUS_LABELS[status]}
      </span>
      {status === 'connected' && (
        <span className="RoomBar-peers" aria-label={`${peerCount} peer${peerCount !== 1 ? 's' : ''} connected`}>
          {peerCount} peer{peerCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}
