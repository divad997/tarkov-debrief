# P3 Multiplayer Co-Editing — Design Document

**Created:** 2026-05-27
**Revised:** 2026-05-27 (second pass — see §0 for corrections)
**Inputs:** `claudedocs/research_ergonomic_input_2026-05-10.md`,
`claudedocs/tactical_input_design_2026-05-10.md`,
`claudedocs/design_p0_slice.md`,
codebase review of `src/tools/metadata.ts`, `src/tools/undo.ts`,
`package.json`, `.github/workflows/ci.yml`
**Output type:** Architecture / component design — implementation
will follow via `/sc:implement`.
**Scope:** Real-time co-editing for a squad (2–5 people) on a
shared canvas during a live voice-chat debrief.

---

## 0. Decisions resolved before writing this draft

### 0a. Original design decisions

| Tension | Decision |
|---|---|
| CRDT vs. WebSocket relay | **WebSocket relay (server-authoritative relay room)** for P3. Squad debriefs are synchronous — everyone is live on voice. Offline-first CRDT adds ~3× complexity for zero benefit. CRDT can be retrofitted in P4 if async annotation becomes a use case. |
| Conflict resolution model | **Commutative-object model.** Each fabric object has a globally unique `__id` (already assigned by `tagObject` in `metadata.ts` since P2). Simultaneous `add` of different objects = no conflict. Simultaneous `modify` of the same object = last server-timestamp wins. Simultaneous `delete` of the same object = silent no-op on the duplicate. |
| Undo semantics | **Personal undo only.** Each peer's undo stack is filtered to that peer's own actions. Remote deltas are applied without touching the local undo stack — achieved by checking a flag in `useUndo`'s listeners, mirroring the existing `REPLAY` and `TRANSIENT` sentinel patterns. |
| Cursor presence | **Ghost cursors — always on, but soft.** Small colored dot (30 % opacity) + operator name label per connected peer. Fade out after 2 s of inactivity. The local peer's own cursor stays full-opacity and is never echoed back. |
| Operator chip ownership | **Claim-on-join, override allowed.** Auto-assign the first unclaimed chip. Any peer can manually switch their active chip mid-session. Per-chip: `ownedBy: peerId \| null`. Unclaimed chips are available to all. |
| Session lifecycle | **URL-based room, no host concept.** Room created lazily on first join. Room stays alive as long as any peer is connected + 24 h TTL after last disconnect. No host-transfer, no permissions. |
| Persistence | **Server holds canonical canvas for TTL; export on demand.** New joiners receive a full snapshot before the delta stream begins. Export (JSON / PNG download) works from any peer at any time. |
| Latency feel | **Optimistic local commit + fire-and-forget broadcast.** Local action commits to fabric immediately. Server re-broadcasts to peers. Remote strokes appear with ~50 ms lag — imperceptible for tactical narration. Freehand paths are streamed as partial-path deltas mid-draw for live feel. |
| Transport auth | **None for P3.** Join by URL only. View-only link variant is a P4 concern. |
| Mobile multiplayer | **Desktop only for P3.** Touch clients can join as viewer (receive deltas, pan/zoom) but the drawing tools are not adapted for touch co-editing in this slice. |

### 0b. Corrections made in this second pass

These were bugs or gaps in the first draft, found by reading the
actual codebase (`undo.ts`, `metadata.ts`, `package.json`, CI):

| Issue | Correction |
|---|---|
| Server runtime: Bun listed as primary, Node.js as fallback | **Inverted.** CI uses Node.js 20; `ws@8.18.3` is already in `node_modules` as a transitive dep. Node.js + `ws` is the correct primary. No dual entry points needed. See §5.1. |
| `fabric.util.enlivenObjects` used with a callback | **fabric v7 API is Promise-based**, not callback-based. All `enlivenObjects` call sites updated. See §7.3. |
| `REMOTE` sentinel set permanently on `delta:modified` target | **Permanent flag breaks local modifications** to that object after any remote edit. Fix: `clearRemote` after the operation, mirroring how `REPLAY` is set/cleared in `undo.ts`. See §7.1. |
| Ghost path `__peerId` not set on creation, but cleanup looks for it | **Silent cleanup failure.** Ghost path must write `__peerId = msg.peerId` at creation. See §8.3, §8.4. |
| Canvas event off-handlers in §7.6 used anonymous lambdas | **`canvas.off(event)` with no handler removes ALL listeners** for that event (verified against `undo.ts` which already uses named refs correctly). Broadcast effect must follow the same named-ref pattern. See §7.6. |
| `delta:modified` patch uses fixed property list for all object types | **Fabric Groups** (e.g., arrow groups) need full serialization, not just transform props. The patch content is object-type-dependent. See §7.4. |
| Server-side `delta:modified` handler had no stale-check | Server should also track `lastModifiedTs` per object and reject stale incoming modifies before broadcasting. See §5.3. |
| `roomId` unvalidated on server | Must validate as UUID format before use to prevent path traversal / garbage keys. See §5.3. |
| Server transport: `ws://` URL in protocol spec | **Mixed content blocked.** Client is hosted at `https://debrief.jrkt.dev`; browser blocks `ws://` from HTTPS pages. Server must run behind TLS (`wss://`). See §4.1 and §5.6. |
| Tab-close / crash disconnect handling missing | `useEffect` cleanup does not run on tab crash. A `beforeunload` listener on the window is needed for clean WebSocket closure. The server must also handle the raw connection `close` event for crash detection. See §6.3. |
| `GhostCursorLayer` prop was `zoom` only | **Pan+zoom together** are expressed by `viewportTransform` (a 6-element affine matrix). The prop should be `viewportTransform: number[]`, not a scalar `zoom`. See §9.1. |

---

## 1. What this slice ships

**P3.1 — Room infrastructure.** Node.js 20 + `ws` WebSocket relay
server. `useRoom` hook manages the WebSocket lifecycle, peer
registry, and reconnection. Room URL injected as `?room=<uuid>`
query param; first visitor creates the room lazily.

**P3.2 — Remote delta application.** `useRemoteCanvas` hook
listens to the room's incoming delta stream and applies
`object:added`, `object:modified`, and `object:removed` deltas
to the local fabric canvas without touching the local undo stack.
Conflict resolution (last-server-timestamp-wins on modify) lives
here.

**P3.3 — Ghost cursors.** A floating HTML overlay per connected
peer. Small colored dot + operator name; 30 % opacity; fades
after 2 s inactivity. Cursor positions broadcast throttled to
30 fps.

**P3.4 — Partial-path streaming.** During freehand draw,
intermediate point arrays are broadcast at ~60 fps. Remote peers
render a live "ghost path" that resolves to the committed object
on `delta:added`. Covers both the pencil and arrow tool paths.

**P3.5 — Operator chip claim + peer presence UI.** Join flow
auto-assigns an operator chip. The chip strip gains a "claimed
by" indicator per connected peer. A room URL bar in the header
shows connection status and a "Copy link" action.

## 2. What this slice does NOT ship

- **Voice / video** — use Discord.
- **Per-chip permission locks** (read-only viewers, host
  controls). P4.
- **Async / offline annotation** (CRDT, conflict-free offline
  edits). P4.
- **End-to-end encryption.** P4.
- **Mobile drawing in multiplayer.** Touch clients can join and
  view but the drawing tools are not adapted for touch co-editing.
- **Replay scrubber sync** — the scrubber is local in P3; peers
  scrub independently. Synchronized playback (presenter-driven)
  is P4.
- **User accounts / persistent identities.** Peer identity is a
  session-scoped UUID.
- **Room discovery UI.** Rooms are joined by URL only.
- **Server deployment pipeline.** The server is designed and
  documented but its hosting target (see §5.6) is separate from
  the client's GitHub Pages deploy and must be set up as a P3.1
  pre-requisite.

---

## 3. Architecture Overview

### 3.1 Current state (recap)

The app is a single-page React app on a fabric.js canvas. State
lives in `App.tsx` + localStorage. All hooks take the canvas and
relevant state; they register fabric event listeners and tear them
down on cleanup. Keyboard and mouse handling is centralized in
`useKeyboardShortcuts` (P0). The `useUndo` hook already uses
named handler references for `canvas.on`/`canvas.off` — this
pattern is load-bearing for P3 (see R15, §7.6). There is no
network layer. P2 added `__id` and `__seq` to every fabric object
via `tagObject` in `metadata.ts` — P3 uses `__id` as the primary
conflict-resolution key without any change to that system.

### 3.2 New architecture (after P3)

```
                       App.tsx
                          │
     ┌────────────────────┼──────────────────────────┐
     │                    │                          │
 canvas state        room state                operator state
 (existing)         (new: useRoom)              (existing + peer ownership)
     │                    │
     │          ┌─────────┴───────────────────────┐
     │          │                                 │
     │    useRemoteCanvas                 GhostCursorLayer
     │    (apply deltas to fabric,        (HTML overlay, coordinate-
     │     bypass undo stack)              converted via viewportTransform)
     │          │
     └──────────┤
                │
        usePartialPath
        (stream in-progress strokes
         mid-draw via brush._points)

  Node.js WS server
    ├── /room/:id  (WebSocket upgrade — UUID-validated)
    ├── GET /room/:id  (HTTP pre-check)
    └── canvas cache (in-memory per room, TTL-gated)

  <RoomBar />           ← new: connection status + copy-link
  <OperatorChips />     ← extended: per-chip peer badge
  <GhostCursorLayer />  ← new: HTML overlay, pointer-events: none
```

The existing tool hooks are unchanged. Broadcast is centralized
in App.tsx via named fabric event handlers (§7.6); the only
per-hook change is adding `isApplyingRemote()` guards to
`useUndo` (§7.1).

### 3.3 Existing patterns reused

| Pattern | Source | Reused for |
|---|---|---|
| `REPLAY` / `TRANSIENT` sentinels — set, operate, clear | `useUndo` | `applyingRemote` module flag in `useRemoteCanvas` (same semantics; see §7.1) |
| Named handler refs for `canvas.on`/`canvas.off` | `useUndo` lines 153–250 | All new `canvas.on` calls in broadcast effect (§7.6) |
| Ref-mirror for live state in fabric handlers | `usePan`, `usePencil` | `useRoom` keeps a `roomRef` so fabric handlers always see current connection state |
| Custom properties on fabric objects (`__id` from P2) | `metadata.ts` | Primary conflict-resolution key for `delta:modified` and `delta:removed` |
| `unerasable: Set<string>` | `App.tsx` | Remote objects respect the same unerasable set |
| `tagObject` idempotent on `__id` | `metadata.ts` | `__id` is already stable from P2; no new ID generation needed at broadcast time |

---

## 4. Protocol Specification

### 4.1 Transport

WebSocket over TLS (`wss://`), one connection per peer per room.
The client is served from `https://debrief.jrkt.dev` — browsers
block `ws://` (unencrypted) mixed content from HTTPS pages, so
the server must be behind TLS termination. See §5.6 for hosting
options.

URL:

```
wss://<server-host>/room/<roomId>
```

All messages are UTF-8 JSON frames. Binary frames are not used.
The server adds a server-side `ts` (Unix ms, `Date.now()`) to
every message before relaying, so clients never need to trust
client clocks for conflict resolution. The server broadcasts each
message to all peers in the room **except** the sender.

### 4.2 Message types

All messages share a discriminated union on `type`.

```ts
// src/collab/protocol.ts — shared types (used by client and server)

// ---- Client → server ----------------------------------------

// Lifecycle
{ type: 'join';    peerId: string; operatorId: string | null }
{ type: 'leave';   peerId: string }  // graceful disconnect only

// Canvas deltas (ts added by server before relay)
{ type: 'delta:added';    peerId: string; obj: FabricJSON }
{ type: 'delta:modified'; peerId: string; id: string;
                          patch: FabricJSON; isGroup: boolean }
{ type: 'delta:removed';  peerId: string; id: string }

// Partial-path streaming (freehand mid-draw)
{ type: 'path:stroke'; peerId: string; id: string;
                       operatorId: string | null;
                       phase: 'plan' | 'record';
                       points: number[] }     // flat [x0,y0, x1,y1, ...]
{ type: 'path:commit'; peerId: string; id: string }

// Cursor presence (not stored in canvas mirror; ephemeral)
{ type: 'cursor'; peerId: string; x: number; y: number }

// Chip ownership
{ type: 'chip:claim';   peerId: string; operatorId: string }
{ type: 'chip:release'; peerId: string; operatorId: string }

// ---- Server → client ----------------------------------------

{ type: 'peer:joined'; peerId: string; operatorId: string | null }
{ type: 'peer:left';   peerId: string }
{ type: 'snapshot';    canvas: FabricJSON[]; peers: PeerInfo[];
                       seq: number }  // sent to new joiner only
{ type: 'error';       code: string; message: string }

// All relayed client messages also carry ts: number (server-stamped)
```

`FabricJSON` is the output of `fabric.FabricObject.toObject()`
with the extras array `['__id', '__operatorId', '__phase',
'__seq', '__markType', '__arrowTip']` — fabric's built-in
serialization extended with the custom properties from
`metadata.ts` (all of which are already written by `tagObject`
and `tagMarkType` in P0/P1/P2).

**`isGroup` flag on `delta:modified`:** Fabric Groups (e.g.,
the arrow group produced by `arrow.ts`'s `appendArrowhead`) need
full re-serialization when modified, not just transform properties,
because their internal path/polygon geometry may change. When the
modified object is a `fabric.Group`, `isGroup: true` is set and
`patch` contains the full `toObject()` output. When `isGroup:
false`, `patch` contains only the changed transform properties
(`left`, `top`, `scaleX`, `scaleY`, `angle`). Receivers switch
on `isGroup` (see §7.4).

### 4.3 Ordering guarantees

Node.js's event loop is single-threaded per process. Messages
are broadcast in arrival order. This gives **causal ordering
within a single peer's stream** — a peer's own `delta:added`
always arrives before any subsequent `delta:modified` from that
peer.

There is **no cross-peer ordering guarantee** — two peers drawing
simultaneously may have their adds arrive in any order at a third
peer. This is acceptable because adds are commutative (unique
`__id` per object).

The critical invariant — **modify never arrives before its
preceding add** — is upheld client-side: `delta:modified` is
only broadcast from `object:modified`, which fabric only fires
after the object is on the canvas (post-`object:added`). Late
joiners always receive a full snapshot before the delta stream
starts, so they cannot see a modify without the prior add.

### 4.4 Snapshot protocol

On `join`, the server sends a `snapshot` message to the joining
peer before relaying any further deltas. The snapshot contains:

- `canvas`: the current serialized fabric object array from the
  room's in-memory canvas mirror.
- `peers`: current peer list with peerId, operatorId, and last
  known cursor position.
- `seq`: the server's current monotonic event counter. The
  joining client discards any buffered messages with
  `seq ≤ snapshot.seq`; replays the rest in order.

The client applies the snapshot by setting a module-level
`applyingRemote = true` flag (same mechanism as the broadcast
guard in §7.1), calling `canvas.loadFromJSON`, and clearing the
flag in the returned Promise's `.then()` callback. This prevents
the broadcast effect from re-broadcasting every loaded object to
the room.

After the snapshot is applied, the client processes the delta
stream normally.

---

## 5. Server Component Design

### 5.1 Tech choice: Node.js 20 + `ws`

**Node.js 20** with the `ws` package. This matches the project's
existing stack exactly:

- CI runs `actions/setup-node@v4` with `node-version: 20`. No
  Bun setup exists anywhere in the repo.
- `ws@8.18.3` is **already present** in `node_modules` as a
  transitive dependency (installed by jsdom for tests). Adding
  it as a direct `server/` dependency costs nothing new in the
  lockfile.
- TypeScript 5.x is already configured; the server uses the same
  `tsconfig.json` base extended with `"module": "nodenext"`.
- Bun would require a new CI step (`setup-bun`), a separate
  lockfile, and a different WS API surface — all cost, no benefit
  for a relay-only server.

The server is a single Node.js process. For P3's scale (2–5
peers, tens of rooms), this is more than sufficient. Horizontal
scaling (multiple processes behind a load balancer with Redis
pub/sub) is a P4 concern.

### 5.2 Room model

```ts
// server/rooms.ts

type Peer = {
  id: string;
  operatorId: string | null;
  ws: WebSocket;
  lastCursor: { x: number; y: number } | null;
};

type CanvasObject = {
  json: Record<string, unknown>;  // full FabricJSON
  lastModifiedTs: number;         // server-stamped; used for stale-modify rejection
};

type Room = {
  id: string;
  peers: Map<string, Peer>;
  // Canvas mirror: keyed by __id for O(1) lookup on modify/remove.
  objects: Map<string, CanvasObject>;
  seq: number;
  lastActivity: number;
  ttlTimer: ReturnType<typeof setTimeout> | null;
};

const rooms = new Map<string, Room>();
```

**Object mirror as a `Map<string, CanvasObject>`** (keyed by
`__id`) rather than a flat array: `delta:modified` and
`delta:removed` look up by `__id`, so O(1) vs O(n) on a flat
array matters at scale. The snapshot serializes `Map.values()`
into an array before sending.

### 5.3 Message routing

```
client → server: message frame
server:
  1. Parse JSON; on parse error → send error to sender, discard.
  2. Validate roomId is UUID format (see §5.5); reject otherwise.
  3. Validate `type` is a known ClientMessage type; reject unknown.
  4. Stamp with server ts = Date.now(); increment room.seq.
  5. Dispatch:
     delta:added    → push to room.objects[obj.__id]
                       with lastModifiedTs = ts
     delta:modified → if obj.lastModifiedTs >= msg.ts: discard (stale)
                       else merge patch into room.objects[msg.id].json,
                       update lastModifiedTs = ts
     delta:removed  → delete room.objects[msg.id]
     cursor         → update peer.lastCursor; NOT mirrored to canvas state
     path:stroke    → relay only; not mirrored to canvas state
     path:commit    → relay only; not mirrored to canvas state
     chip:claim     → update peer.operatorId in room.peers
     chip:release   → clear peer.operatorId in room.peers
     join / leave   → handled separately (lifecycle, see §6.3)
  6. Broadcast stamped message to all peers in room EXCEPT sender.
  7. For `join` only: additionally send snapshot back to sender.
```

No rate limiting or authentication in P3. Add both if the server
becomes public-facing.

### 5.4 Canvas persistence and TTL

- Room is created lazily on first WebSocket connection.
- `room.ttlTimer` is set when the last peer disconnects.
  Duration: 24 h (`ROOM_TTL_MS` env var, default `86400000`).
- On timer fire: `rooms.delete(roomId)`. Canvas gone.
- If any peer reconnects before the timer fires, the timer is
  cancelled and the room survives.
- **No file-system or database persistence in P3.** A server
  restart wipes all rooms. The UI must communicate this clearly
  (§11.1).

### 5.5 HTTP endpoints and roomId validation

```
GET  /room/:id   → 200 { exists: bool, peerCount: number }
WS   /room/:id   → WebSocket upgrade
GET  /health     → 200 "ok"
```

`roomId` is validated as a UUID (v4 format: `/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`) before use as a `rooms` Map key. Invalid IDs receive a `400` HTTP response on the HTTP endpoint, or a `{ type: 'error', code: 'invalid_room_id' }` WebSocket message followed by close on the WS endpoint.

### 5.6 Deployment (pre-requisite for P3.1)

The client (`https://debrief.jrkt.dev`) is served from GitHub
Pages, which is static-only — it cannot host a WebSocket server.
The server must be deployed separately **before** P3.1 can be
tested. Recommended options (all support `wss://` with
auto-TLS):

- **Fly.io** — free tier, native WebSocket support, easy TLS,
  Docker-based deploy.
- **Railway** — similar; Node.js native deployment, no Docker
  needed.
- **Render.com** — free tier with spin-down on inactivity (bad
  for always-on rooms; only acceptable if teams can tolerate a
  cold-start delay).

The server URL is configured in the client via a Vite env
variable (`VITE_WS_HOST`). Local dev uses `ws://localhost:3001`
(HTTP is fine on localhost); production uses `wss://<host>`.

A deploy script (`server/deploy.sh`) is part of P3.1 but the
hosting account setup is out of scope for this design doc.

### 5.7 Disconnect handling

On WebSocket `close` event (triggered by clean close, crash, or
network loss), the server:

1. Removes the peer from `room.peers`.
2. Broadcasts `{ type: 'peer:left', peerId }` to remaining peers.
3. If `room.peers` is now empty, starts the TTL timer.

There is no heartbeat / ping-pong for P3. The server's
socket-level `keepalive` is sufficient for detecting dead
connections on most networks. A `ping/pong` heartbeat can be
added in P4 if LAN environments don't trigger TCP keepalive.

---

## 6. Client: `useRoom` Hook

### 6.1 Purpose

Owns the WebSocket lifecycle, peer registry, and the broadcast
API. Returned from a single hook call in `App.tsx` and passed
(as a stable ref) into `useRemoteCanvas`, `GhostCursorLayer`,
and `usePartialPath`.

### 6.2 API surface

```ts
// src/collab/useRoom.ts — DESIGN

type PeerInfo = {
  id: string;
  operatorId: string | null;
  cursor: { x: number; y: number } | null;
};

type RoomState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; roomId: string; peerId: string;
      peers: Map<string, PeerInfo> }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'error'; message: string };

type Room = {
  state: RoomState;
  stateRef: React.RefObject<RoomState>;  // ref-mirror for use in fabric handlers
  broadcast: (msg: Omit<ClientMessage, 'peerId'>) => void;
  onMessage: (handler: (msg: ServerMessage) => void) => () => void;
};

function useRoom(
  roomId: string | null,   // null = solo mode (no WebSocket opened)
  peerId: string,
  operatorId: string | null,
): Room;
```

When `roomId` is `null`, the hook is a no-op and returns a
disconnected room with a no-op `broadcast`. Solo mode requires
no guard anywhere else.

### 6.3 Internal details

**WebSocket URL.** `import.meta.env.VITE_WS_HOST` provides the
host. Absent in development → falls back to `ws://localhost:3001`.
Present in production → must be `wss://...`.

**WebSocket lifecycle.** Effect depends on `[roomId, peerId]`.
Opens the socket on mount; sends `join` in the `open` handler.
Sends `leave` in the effect cleanup (graceful browser-controlled
unmount). Additionally registers a `beforeunload` DOM event
listener that calls `ws.close(1000)` — this is the only path
that runs for tab close and navigation away. The server also
handles the raw socket `close` event independently (§5.7), so a
crash (where neither cleanup nor `beforeunload` runs) is also
handled.

**Reconnection.** On `close` event where `wasClean === false`
(unexpected disconnect), exponential backoff: 1 s → 2 s → 4 s,
capped at 30 s. Status transitions to `reconnecting`. On
reconnect, the join flow repeats and the client receives a fresh
snapshot. Deltas buffered during the disconnect window are
irrelevant (snapshot covers them). The `beforeunload`-triggered
close sets `wasClean = true` (code 1000) — clean close does
NOT trigger reconnection.

**Peer registry.** Updated on `peer:joined`, `peer:left`, and
`cursor` messages. Stored in both a ref (for fabric handlers that
need non-stale access) and React state (for `<OperatorChips />`
and `<GhostCursorLayer />` which need re-renders).

**Broadcast.** `ws.send(JSON.stringify({...msg, peerId}))`.
No-ops if `ws.readyState !== WebSocket.OPEN`.

**peerId generation.** `sessionStorage.getItem('tarkov-debrief:peerId') ?? crypto.randomUUID()`. Stored in `sessionStorage`: tabs get separate peer identities, but a reload in the same tab reuses the same identity (consistent chip assignment across reconnects).

---

## 7. Client: Remote Delta Application (`useRemoteCanvas`)

### 7.1 Undo bypass: `applyingRemote` module flag

`useUndo` already has two sentinels (`REPLAY`, `TRANSIENT`) for
suppressing stack updates in special situations. P3 adds a third
mechanism — a **module-scoped flag** rather than a per-object
property — for remote delta application:

```ts
// src/collab/useRemoteCanvas.ts
let applyingRemote = false;

/** Wrap any canvas mutations that should not enter the undo stack. */
function withRemote(fn: () => void): void {
  applyingRemote = true;
  try { fn(); } finally { applyingRemote = false; }
}

export function isApplyingRemote(): boolean { return applyingRemote; }
```

Why a module flag rather than a per-object sentinel (the
`REPLAY`/`TRANSIENT` approach)?

- Per-object sentinel on `delta:modified` is **permanently sticky**:
  once `__remote = true` is set on a fabric object, the object
  is excluded from undo and broadcast forever — even for
  subsequent _local_ user edits. This was a bug in the first
  draft.
- A module flag is scoped to the exact duration of the apply
  operation (set → synchronous mutation → clear). It cannot leak
  across operations.
- `delta:added` is asynchronous (uses `enlivenObjects` Promise);
  the flag is set before the `.then()` and cleared inside it, so
  the async boundary is covered.

`useUndo` gains one guard per listener, all identical in form:

```ts
// inside useUndo (undo.ts) — three additions only
const onAdd = ({ target }) => {
  if (isApplyingRemote()) return;   // ← new
  if (isFlagged(target, REPLAY)) return;
  if (isFlagged(target, TRANSIENT)) return;
  ...
};
const onRemove = ({ target }) => {
  if (isApplyingRemote()) return;   // ← new
  if (isFlagged(target, REPLAY)) return;
  ...
};
const onModified = ({ target }) => {
  if (isApplyingRemote()) return;   // ← new
  if (isFlagged(target, REPLAY)) return;
  ...
};
```

The broadcast effect in App.tsx (§7.6) uses the same guard:
`if (isApplyingRemote()) return` in each of its named handlers.

### 7.2 API surface

```ts
// src/collab/useRemoteCanvas.ts — DESIGN
function useRemoteCanvas(
  canvas: fabric.Canvas | null,
  room: Room,
  unerasable: Set<string>,
): void;
```

### 7.3 Applying `delta:added`

```ts
// fabric v7: enlivenObjects returns Promise<FabricObject[]>, not callback
room.onMessage(msg => {
  if (msg.type !== 'delta:added') return;

  const id: string = msg.obj.__id;

  // Idempotency guard.
  if (canvas.getObjects().some(o => (o as any).__id === id)) return;

  fabric.util.enlivenObjects([msg.obj]).then(([fabricObj]) => {
    // Re-check after async gap: object may have arrived via snapshot
    // while enlivenObjects was pending.
    if (canvas.getObjects().some(o => (o as any).__id === id)) return;

    withRemote(() => {
      canvas.add(fabricObj);
      canvas.requestRenderAll();
    });
  });
});
```

Note: `enlivenObjects` in fabric v7 is `Promise<FabricObject[]>`,
not the old two-argument callback `(objs, namespace, reviver, cb)`
form. All call sites must use `.then()` or `await`.

### 7.4 Applying `delta:modified`

```ts
room.onMessage(msg => {
  if (msg.type !== 'delta:modified') return;

  const target = canvas.getObjects().find(o => (o as any).__id === msg.id);
  if (!target) return;

  // Conflict check: last-server-timestamp-wins.
  // The server has already performed this check before broadcasting
  // (§5.3), but the client-side check handles the rare case where
  // a modify arrives out of order due to buffering during reconnect.
  const localTs: number = (target as any).__lastModifiedTs ?? 0;
  if (msg.ts !== undefined && msg.ts <= localTs) return;

  if (msg.isGroup) {
    // Full group replacement: reconstruct via enlivenObjects and swap.
    fabric.util.enlivenObjects([msg.patch]).then(([newObj]) => {
      const current = canvas.getObjects().find(o => (o as any).__id === msg.id);
      if (!current) return;
      withRemote(() => {
        canvas.remove(current);
        canvas.add(newObj);
        canvas.requestRenderAll();
      });
    });
  } else {
    // Transform-only patch: apply in-place.
    withRemote(() => {
      target.set(msg.patch);
      target.setCoords();
      (target as any).__lastModifiedTs = msg.ts ?? Date.now();
      canvas.requestRenderAll();
    });
  }
});
```

`target.set(msg.patch)` with a transform patch does **not** fire
`object:modified` — fabric only fires that event in response to
user interaction via selection handles. So `withRemote` is
present for correctness but the undo guard is the critical one
(it handles programmatic mutations that other code paths might
trigger via selection events).

### 7.5 Applying `delta:removed`

```ts
room.onMessage(msg => {
  if (msg.type !== 'delta:removed') return;

  const target = canvas.getObjects().find(o => (o as any).__id === msg.id);
  if (!target) return;

  withRemote(() => {
    canvas.remove(target);
    canvas.requestRenderAll();
  });

  // Check if the removed object was the top of the local undo stack.
  // useUndo stores the object by reference. canvas.remove inside
  // withRemote means the remove event is skipped by undo's listener,
  // so the undo stack still contains an 'add' entry for this object.
  // A subsequent undo by the local peer will call canvas.add(target)
  // which re-adds the removed mark — this is correct (local peer
  // reverting their own work; if a teammate deleted it, it comes back
  // from the local peer's perspective).
  // Show a toast only if the object's __peerId matches the local
  // peer's own id, i.e. it was the local peer's stroke that got
  // deleted remotely.
});
```

### 7.6 Broadcasting local actions

> **Verify before coding P3.2 — two checks:**
>
> **Check A — `REPLAY` / `TRANSIENT` exports.**
> The broadcast effect needs `isFlagged(target, REPLAY)` and
> `isFlagged(target, TRANSIENT)`. Both constants and the helper
> are currently **module-private** in `undo.ts` (not exported).
> Before writing the broadcast effect, export them:
> ```ts
> // undo.ts — add to exports
> export { isFlagged, REPLAY, TRANSIENT };
> ```
> Alternative: inline the check as `(target as any).__undoReplay`
> and `(target as any).__transient`, but exporting is cleaner
> and keeps a single source of truth.
>
> **Check B — `canvas.off(event)` with no handler.**
> R15 assumes `canvas.off('object:added')` (no handler arg)
> removes ALL handlers. Verify against fabric v7's Observable:
> ```
> node_modules/fabric/src/Observable.ts
> ```
> If `.off(event)` with no handler is a no-op (standard Node.js
> EventEmitter behaviour), R15's severity drops to Low and named
> refs are still best practice but not critical. If it does remove
> all handlers, R15 stays High. Either way, use named refs.

The broadcast effect in App.tsx subscribes to fabric events using
**named function references** — the pattern established by
`useUndo` (see `undo.ts` lines 153–250). Anonymous lambdas must
NOT be used because `canvas.off(event, fn)` requires the exact
same function reference, and `canvas.off(event)` with no function
may remove all handlers for that event (nukes `useUndo`'s listeners
— see Check B above).

```ts
// Inside App.tsx — new effect (DESIGN)
useEffect(() => {
  if (!canvas || !room) return;

  const onAdd = ({ target }: { target: fabric.FabricObject }) => {
    if (isApplyingRemote()) return;
    if (isFlagged(target, REPLAY) || isFlagged(target, TRANSIENT)) return;
    room.broadcast({
      type: 'delta:added',
      obj: target.toObject(['__id', '__operatorId', '__phase',
                            '__seq', '__markType', '__arrowTip']),
    });
  };

  const onModified = ({ target }: { target: fabric.FabricObject }) => {
    if (isApplyingRemote()) return;
    if (isFlagged(target, REPLAY) || isFlagged(target, TRANSIENT)) return;
    const isGroup = target instanceof fabric.Group;
    const ts = Date.now();
    (target as any).__lastModifiedTs = ts;
    room.broadcast({
      type: 'delta:modified',
      id: (target as any).__id,
      isGroup,
      patch: isGroup
        ? target.toObject(['__id', '__operatorId', '__phase',
                           '__seq', '__markType', '__arrowTip'])
        : target.toObject(['left', 'top', 'scaleX', 'scaleY', 'angle']),
    });
  };

  const onRemoved = ({ target }: { target: fabric.FabricObject }) => {
    if (isApplyingRemote()) return;
    if (isFlagged(target, REPLAY) || isFlagged(target, TRANSIENT)) return;
    const id = (target as any).__id;
    if (!id) return; // untagged objects (map image) have no __id
    room.broadcast({ type: 'delta:removed', id });
  };

  canvas.on('object:added', onAdd);
  canvas.on('object:modified', onModified);
  canvas.on('object:removed', onRemoved);

  return () => {
    canvas.off('object:added', onAdd);
    canvas.off('object:modified', onModified);
    canvas.off('object:removed', onRemoved);
  };
}, [canvas, room]);
```

`isFlagged` and the `REPLAY`/`TRANSIENT` constants are imported
from `undo.ts` (they are already exported as part of the `UndoApi`
type's supporting module, or can be re-exported from `metadata.ts`
at implementation time).

The `REPLAY` check on `object:removed` prevents the undo/redo
mechanism from broadcasting a "remove" when restoring a prior
state — that would incorrectly delete the object on all remote
peers' canvases.

---

## 8. Partial-Path Streaming (`usePartialPath`)

> **Verify before coding P3.4 — two checks, run as spikes first:**
>
> **Check C — `fabric.Polyline` live point-update.**
> §8.3 updates ghost paths with `ghost.set({ points }); ghost.setCoords()`.
> In fabric v7, `Polyline` may not recalculate its bounding box
> or repaint from a plain `.set({ points })` — it may need
> `ghost._setPositionDimensions({})` or a full remove + re-add.
> Spike: create a `fabric.Polyline`, add it to a canvas, call
> `.set({ points: [...newPoints] })` + `setCoords()` +
> `requestRenderAll()`, and confirm the shape visually updates.
> If it doesn't, the fallback is:
> ```ts
> canvas.remove(ghost);
> ghost = new fabric.Polyline(points, { ...opts });
> canvas.add(ghost);
> ghostPaths.set(msg.id, ghost);
> ```
> This is heavier (one remove + add per streamed frame) but
> unambiguously correct. Decide in P3.4; update §8.3 accordingly.
>
> **Check D — `PencilBrush._points` field name in fabric 7.3.1.**
> §8.2 reads `(brush as any)._points`. Verify the actual field
> name in the installed source:
> ```
> node_modules/fabric/src/brushes/pencil_brush.ts
> ```
> It may be `_points`, `points`, or something else. If the field
> is absent or renamed, an alternative is to listen to the brush's
> own events rather than reading private state — but check the
> simple case first. Update §8.2 and the `expectType` assertion
> in `usePartialPath.test.ts` with the confirmed name.

### 8.1 Why partial paths

Without streaming, remote peers see nothing while a teammate
draws, then a complete committed stroke appears instantly. This
breaks the "I can see Bravo drawing" social presence. Streaming
intermediate points gives a live "ink on paper" effect.

### 8.2 Sending (local side)

`PencilBrush` accumulates points in a private `_points` array
during the draw. We tap into `mouse:move` while
`canvas.isDrawingMode` is true:

```ts
// Inside usePartialPath — DESIGN
// activePathId: ref set to crypto.randomUUID() on mouse:down while
// isDrawingMode, cleared in path:created handler.

let lastSend = 0;
const onMove = (e: fabric.TPointerEvent) => {
  if (!canvas.isDrawingMode) return;
  if (!activePathId.current) return;
  if (!room || room.state.status !== 'connected') return;

  const now = Date.now();
  if (now - lastSend < 16) return; // ~60 fps
  lastSend = now;

  const brush = canvas.freeDrawingBrush;
  // _points is private in PencilBrush (fabric v7); access via cast.
  // Add an expectType assertion in the test file to catch breakage
  // on fabric version bumps (R7).
  const pts = (brush as any)._points as fabric.Point[] | undefined;
  if (!pts?.length) return;

  room.broadcast({
    type: 'path:stroke',
    id: activePathId.current,
    operatorId: activeOperatorIdRef.current,
    phase: phaseRef.current,
    points: pts.flatMap(p => [p.x, p.y]),
  });
};

canvas.on('mouse:move', onMove);
```

On `path:created`, broadcast `path:commit` so remote peers
replace the ghost path. The `delta:added` for the committed
object is broadcast by the App.tsx broadcast effect independently.

### 8.3 Receiving (remote side)

```ts
// Ghost path registry: pathId → fabric.Polyline
const ghostPaths = new Map<string, fabric.Polyline>();

room.onMessage(msg => {
  if (msg.type === 'path:stroke') {
    const points = [] as fabric.Point[];
    for (let i = 0; i < msg.points.length; i += 2) {
      points.push(new fabric.Point(msg.points[i], msg.points[i + 1]));
    }

    let ghost = ghostPaths.get(msg.id);
    if (!ghost) {
      const operator = operators.find(o => o.id === msg.operatorId);
      ghost = new fabric.Polyline(points, {
        stroke: operator?.color ?? PENCIL_COLOR,
        strokeWidth: 2,
        fill: 'transparent',
        evented: false,
        selectable: false,
        strokeDashArray: msg.phase === 'plan' ? [10, 5] : undefined,
      });
      // __peerId is required for the peer:left cleanup in §8.4.
      // __ghostId is used to match path:commit messages.
      (ghost as any).__peerId = msg.peerId;
      (ghost as any).__ghostId = msg.id;
      ghostPaths.set(msg.id, ghost);
      withRemote(() => {
        canvas.add(ghost!);
        canvas.requestRenderAll();
      });
    } else {
      ghost.set({ points });
      ghost.setCoords();
      canvas.requestRenderAll();
    }
  }

  if (msg.type === 'path:commit') {
    const ghost = ghostPaths.get(msg.id);
    if (ghost) {
      withRemote(() => canvas.remove(ghost!));
      ghostPaths.delete(msg.id);
      canvas.requestRenderAll();
    }
    // delta:added for the final object arrives shortly after
    // (broadcast by the drawing peer's App.tsx onAdd handler).
  }
});
```

Ghost paths are `evented: false, selectable: false` — immune to
eraser, selection, and export. They are applied via `withRemote`
so they bypass the undo stack.

### 8.4 Ghost path cleanup on disconnect

```ts
room.onMessage(msg => {
  if (msg.type !== 'peer:left') return;
  for (const [id, ghost] of ghostPaths) {
    if ((ghost as any).__peerId === msg.peerId) {
      withRemote(() => canvas.remove(ghost));
      ghostPaths.delete(id);
    }
  }
  canvas.requestRenderAll();
});
```

`__peerId` is set on every ghost path at creation (§8.3). Without
it, this cleanup silently no-ops — which was the bug in the first
draft.

---

## 9. Ghost Cursors

### 9.1 Rendering approach — HTML overlay, not fabric

Ghost cursors are rendered as an absolute-positioned HTML layer
over the canvas, not as fabric objects. Reasons:

1. Fabric objects would need to be excluded from undo, export,
   replay timeline, and eraser — too many carve-outs.
2. HTML overlay uses CSS `transition` and `opacity` for smooth
   fade without touching the fabric render loop.
3. `pointer-events: none` on the overlay means it doesn't
   intercept canvas mouse events.

```tsx
// src/collab/GhostCursorLayer.tsx — DESIGN
type Props = {
  room: Room;
  viewportTransform: number[];  // canvas.viewportTransform — 6-element affine matrix
};

export function GhostCursorLayer({ room, viewportTransform }: Props) {
  return (
    <div style={{ position: 'absolute', inset: 0,
                  pointerEvents: 'none', zIndex: 10 }}>
      {[...room.state.peers.values()].map(peer =>
        peer.cursor
          ? <GhostCursor key={peer.id} peer={peer}
                         viewportTransform={viewportTransform} />
          : null
      )}
    </div>
  );
}
```

Each `<GhostCursor>` converts the peer's canvas-coordinate cursor
to screen coordinates:

```ts
// canvas coords → screen coords
const [a, b, c, d, e, f] = viewportTransform;
const screenX = a * canvasX + c * canvasY + e;
const screenY = b * canvasX + d * canvasY + f;
```

It renders a 6 px radius dot in the operator's color (30 %
opacity) and a Bender 10 px name label. `viewportTransform` is
passed down from App.tsx, which reads it from
`canvas.viewportTransform` on every `viewport:transformed` event
and stores it in React state for re-render.

**Why `viewportTransform` not `zoom`:** The transform is a 2D
affine matrix that encodes both pan and zoom. Passing only `zoom`
(a scalar) would position cursors correctly at zoom = 1 but
incorrectly once the user has panned (translation components
`e`, `f` would be ignored).

### 9.2 Fade behavior

CSS `transition: opacity 0.3s ease` on the dot + label. A ref
per peer tracks the last received cursor timestamp. A 2 s
`setTimeout` sets the peer's CSS `data-active="false"` →
`opacity: 0.15`. When a new cursor message arrives, it resets
to `opacity: 0.30`. The dot never fully disappears — 15 %
opacity signals "connected but idle."

### 9.3 Cursor broadcast

```ts
// In App.tsx — mousemove handler on the canvas container
const lastCursorSend = useRef(0);

canvasContainerRef.current.addEventListener('mousemove', e => {
  if (room.state.status !== 'connected') return;
  const now = Date.now();
  if (now - lastCursorSend.current < 33) return; // 30 fps
  lastCursorSend.current = now;

  const pt = canvas.restorePointerVpt(
    new fabric.Point(e.offsetX, e.offsetY)
  );
  room.broadcast({ type: 'cursor', x: pt.x, y: pt.y });
});
```

Cursor messages are never stored in the server's canvas mirror
and are not included in snapshots. They are ephemeral.

---

## 10. Operator Chip Ownership

### 10.1 Claim-on-join

On `join`, the client includes its current `operatorId`. The
server relays `peer:joined` to all others. On the joining client
side: the first chip in `DEFAULT_OPERATORS` order whose `ownedBy`
is `null` is claimed. If all four chips are claimed, join without
claiming (can still draw on any manually-selected chip). Chip
claim is UI-only — it shows who is "piloting" each chip but
does not gate drawing.

### 10.2 Simultaneous claim conflicts

Two peers join simultaneously and both auto-assign `op-alpha`.
Both `chip:claim` messages arrive. Both are valid — objects
tagged `__operatorId: 'op-alpha'` belong to whoever drew them.
The chip UI shows the last-arriving peer as current claimer, with
no error. The behavior is "everyone can draw as any operator; the
badge is cosmetic."

### 10.3 Chip strip extension for P3

`<OperatorChips />` gains a `peers: Map<string, PeerInfo>` prop.
Each chip whose `operatorId` matches any peer renders a small
owner badge (12 px circle with the peer's initials) at the
upper-right corner. Multiple peers on the same chip stack badges
left-to-right.

---

## 11. UI Additions

### 11.1 Room URL bar (`<RoomBar />`)

A 24 px slim bar between the header and canvas. Hidden in solo
mode. Visible when `room.state.status !== 'disconnected'`.

```
[ tarkovdebrief.app/?room=abc12345...  [Copy]  ]  2 peers  ● connected
```

States:
- **connecting** — `○ connecting…` (gray, pulsing)
- **connected** — `● connected` (green) + peer count
- **reconnecting** — `○ reconnecting… (attempt 2)` (amber)
- **error** — `✕ disconnected` (red) + [Retry] button

Note prominently: "Rooms expire 24 h after everyone leaves.
Export to save permanently." This is load-bearing given the
no-persistence design (R11).

### 11.2 Join flow

Page loads with `?room=<uuid>`:

1. `useRoom` auto-connects. No modal.
2. Chip-claim toast for 3 s: "You're drawing as Alpha — tap a
   chip to change." Auto-dismisses.
3. If the HTTP pre-check returns `{ exists: false }`: `<RoomBar />`
   shows "Room not found or expired. [Start new room]" and the
   `?room` param is removed from the URL.

"Start new room" button (shown in solo mode): generates a UUID,
appends `?room=<uuid>` to the URL, copies URL to clipboard, opens
WebSocket.

### 11.3 Peer count

Includes the local peer ("2 peers" = 1 remote + you). On first
join with no others: "1 peer (just you)."

---

## 12. Modified and New Files

### 12.1 New files

```
server/
  package.json          (name: debrief-server; deps: ws, typescript)
  tsconfig.json         (extends root, module: nodenext)
  src/
    index.ts            (entry point — creates HTTP + WS server)
    rooms.ts            (Room model, canvas mirror, message routing)
    rooms.test.ts

src/
  collab/
    protocol.ts         (shared message type definitions — client + server)
    useRoom.ts          (WebSocket lifecycle, peer registry)
    useRoom.test.ts
    useRemoteCanvas.ts  (apply remote deltas, applyingRemote flag)
    useRemoteCanvas.test.ts
    usePartialPath.ts   (stream in-progress freehand strokes)
    usePartialPath.test.ts
    GhostCursorLayer.tsx
    GhostCursorLayer.css
    GhostCursorLayer.test.tsx
  components/
    RoomBar.tsx
    RoomBar.css
    RoomBar.test.tsx
```

`protocol.ts` is the canonical type definition imported by both
the client (`src/collab/`) and the server (`server/src/`). It
contains no runtime logic — only types — so it's safe to import
in either environment.

### 12.2 Modified files

| File | Change |
|---|---|
| `src/tools/undo.ts` | Add `if (isApplyingRemote()) return` as first guard in `onAdd`, `onRemove`, `onModified` listeners |
| `src/App.tsx` | Wire `useRoom`, `useRemoteCanvas`, `usePartialPath`. Add broadcast effect with named handlers (§7.6). Mount `<RoomBar />` and `<GhostCursorLayer />`. Pass `peers` prop to `<OperatorChips />`. Track `viewportTransform` in React state (subscribe to canvas `viewport:transformed`). Add cursor broadcast handler. |
| `src/components/OperatorChips.tsx` | Accept `peers: Map<string, PeerInfo>` prop; render per-chip owner badges |
| `src/components/OperatorChips.css` | Owner badge styles |
| `src/App.css` | Reserve 24 px for `<RoomBar />` when visible |
| `pnpm-workspace.yaml` | Add `server` to workspace packages |
| `.github/workflows/ci.yml` | Add `server` typecheck + test step (Node.js 20 matches existing setup-node) |
| `vite.config.js` | Expose `VITE_WS_HOST` env variable |

### 12.3 No-change-needed files

All existing tool hooks (`usePencil`, `useArrow`, `useEraser`,
`useStamp`, `usePan`, `useMark`, etc.) are unchanged. The
broadcast effect is centralized in App.tsx. The `useUndo`
change is additive (three one-line guards).

### 12.4 Tech debt queued (not in P3)

- Redis-backed room registry for multi-process server scaling.
- View-only join link (`?room=<uuid>&view=1`).
- Server-side rate limiting and message size caps.
- Synchronized replay scrubber (presenter-driven).
- Heartbeat/ping-pong for aggressive NAT environments.

---

## 13. Sequencing (P3.1 → P3.5)

**P3.1 — Server + room infrastructure.**
Ship `server/`, the `useRoom` hook, and `<RoomBar />`.
No canvas sync yet. Test: two browser tabs in the same room;
`<RoomBar />` shows "2 peers connected"; one tab closes → "1 peer."

**P3.2 — Remote delta application.**
Land `useRemoteCanvas` and the App.tsx broadcast effect. Test:
draw in tab 1 → stroke appears in tab 2. Undo in tab 1 removes
only tab 1's last stroke. Draw simultaneously in both tabs → both
strokes appear with no crash.

**P3.3 — Ghost cursors.**
Land `GhostCursorLayer`. Test: cursor dot tracks peer's mouse
position after pan/zoom (coordinate conversion validates). Fades
after 2 s inactivity. Disappears on disconnect.

**P3.4 — Partial-path streaming.**
Land `usePartialPath`. Test: live growing path visible in tab 2
while tab 1 draws. Commit resolves to final stroke without flash.
Disconnect mid-stroke cleans up ghost path.

**P3.5 — Operator chip claims + join flow.**
Land chip ownership UI, "Start new room" button, join-flow toast.
Test: second tab joins → auto-assigned chip → badge appears on
first tab's chip strip.

---

## 14. Risk Register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | Remote delta arrives before snapshot; `enlivenObjects` races with `loadFromJSON` | High | Buffer incoming deltas (keyed by seq) until snapshot's `.then()` fires; apply buffered deltas in seq order after load completes |
| R2 | Two peers delete the same object simultaneously | Med | `delta:removed` handler has `if (!target) return` no-op guard (§7.5) |
| R3 | `delta:modified` arrives for an object not yet in local canvas (network reorder) | Med | `if (!target) return` no-op; object arrives in snapshot on next reconnect |
| R4 | Ghost paths not cleaned up on mid-stroke disconnect | Med | `peer:left` handler iterates `ghostPaths` by `__peerId` (§8.4); `__peerId` is set on every ghost at creation (§8.3, corrected in this revision) |
| R5 | Local undo re-adds an object that a remote peer deleted | Low–Med | Correct behavior: local peer's undo restores their own work. Document explicitly in validation checklist and in the undo action's code comment. |
| R6 | Remote delete of local peer's most-recent object surprises them | Low | Toast: "A teammate removed your [MarkType]. Undo has no effect." Show once. |
| R7 | `PencilBrush._points` is private in fabric v7 and may change | Med | Access via cast; verify field name before P3.4 (Check D in §8); add `expectType` assertion in `usePartialPath.test.ts`; review on every fabric version bump |
| R8 | Ghost cursor misaligns after pan/zoom | Med | Pass full `viewportTransform` array (not scalar zoom) to `GhostCursorLayer`; recalculate on every `cursor` message and on canvas `viewport:transformed` event (§9.1, corrected in this revision) |
| R9 | Cursor broadcast floods WebSocket | Med | 30 fps throttle in `mousemove` handler (§9.3) |
| R10 | Partial-path broadcast floods WebSocket | Med | 60 fps throttle in `mouse:move` handler (§8.2) |
| R11 | Server restart wipes all rooms without warning | Med | Prominent UI note in `<RoomBar />`: "Rooms expire 24 h after everyone leaves. Export to save." |
| R12 | Two peers simultaneously auto-claim the same chip | Low | Chip claim is UI-only; both claims land; last-arrival wins the badge display. No correctness impact. |
| R13 | `toObject` with custom property extras silently drops them on fabric version change | Med | Integration test: serialize → `enlivenObjects` round-trip; assert `__id`, `__operatorId`, `__phase` survive |
| R14 | Remote `delta:modified` for a `fabric.Group` (arrow group): `target.set(patch)` can't reconstruct internal geometry | High | `isGroup` flag in protocol (§4.2); receiver uses full `enlivenObjects` + swap for groups (§7.4). Validated in P3.2 test. |
| R15 | Broadcast effect cleanup nukes all fabric event handlers | High (verify Check B — may be lower) | Named function references (`const onAdd = ...`) in broadcast effect, matching `undo.ts` pattern exactly. `canvas.off('object:added', onAdd)` removes only this handler. Actual severity depends on whether `canvas.off(event)` (no handler) is a no-op or removes all — see Check B in §7.6. |
| R16 | `isDrawingMode` true for both pencil and arrow; ghost path streamed for both | Low | Desired — both stream. Arrow's `appendArrowhead` group-swap fires after `path:created`; ghost is removed by `path:commit` before the group appears. Validate in P3.4. |
| R17 | Snapshot `canvas.loadFromJSON` triggers broadcast of all loaded objects | High | `withRemote` wraps the entire snapshot load; broadcast effect checks `isApplyingRemote()` and returns early. |
| R18 | `ws://` blocked by browser mixed-content policy when client is HTTPS | High | `VITE_WS_HOST` env var uses `wss://` in production. Local dev on `localhost` is exempt from mixed-content policy. |
| R19 | Tab close does not trigger `useEffect` cleanup; `leave` message never sent | Med | `beforeunload` DOM listener calls `ws.close(1000)`, which triggers the server's socket `close` event and broadcasts `peer:left` (§5.7, §6.3). |
| R20 | `roomId` path traversal or injection via WebSocket URL | Med | UUID format validation on server before using as Map key (§5.5). Non-UUID `roomId` → 400 HTTP / error WS frame + close. |
| R21 | `enlivenObjects` async gap: object added to canvas between the sync guard and the `.then()` handler | Med | Second idempotency check inside `.then()` before `canvas.add` (§7.3, "re-check after async gap" comment). |
| R22 | `toObject` for a non-fabric-Group arrow produces `path` + `points` list, both needed for replay | Med | Broadcast `patch` for non-group includes `path` in the extras when the mark type is `arrow` (detected via `readMarkType`). Validate serialize/deserialize round-trip in P3.2 test. |
| R23 | `viewportTransform` state stale during rapid pan/zoom; ghost cursors lag behind | Low | Subscribe to `viewport:transformed` canvas event; update React state synchronously. Cursor positions re-render on next `cursor` message, so lag is bounded by cursor broadcast rate (33 ms). |

---

## 15. Validation Checklist

Before merging each sub-slice:

- [ ] `pnpm typecheck` clean (client + server)
- [ ] `pnpm lint` clean
- [ ] `pnpm test` clean (Vitest)
- [ ] `pnpm test:e2e` clean (existing smoke spec untouched)

**P3.1 (Server + useRoom + RoomBar)**
- [ ] Manual: two tabs in same room → `<RoomBar />` shows "2 peers connected"
- [ ] Manual: one tab closes → other shows "1 peer"
- [ ] Manual: `?room=<nonexistent>` → "Room not found or expired" message
- [ ] Manual: "Start new room" copies URL and connects; pasting URL in second tab joins
- [ ] Manual: server restarted while room active → both tabs show reconnecting → reconnect → canvas preserved on client (server has no canvas; clients show what they had locally)
- [ ] **Manual: invalid roomId (`/room/../secret`) → 400 response, no crash** (R20)

**P3.2 (Remote delta application)**
- [ ] Manual: draw in tab 1 → stroke appears in tab 2
- [ ] Manual: undo in tab 1 → removes only tab 1's last stroke; tab 2 unaffected
- [ ] Manual: tab 1 erases tab 2's stroke → removal propagates
- [ ] Manual: both tabs draw simultaneously → both strokes appear in both tabs; no crash
- [ ] Manual: move an arrow handle in tab 1 → arrow repositioned in tab 2
- [ ] **Manual: `delta:modified` for an arrow group does not crash or corrupt** (R14)
- [ ] **Manual: snapshot load does not re-broadcast to the room** (R17, log the WS traffic)
- [ ] **Manual: undo after remote delete re-adds the object locally** (R5 — confirm expected behavior)
- [ ] **Test: serialize → `enlivenObjects` round-trip preserves `__id`, `__operatorId`, `__phase`** (R13)

**P3.3 (Ghost cursors)**
- [ ] Manual: cursor dot tracks peer's mouse in tab 2
- [ ] Manual: pan canvas in tab 2 → ghost cursor stays anchored to correct canvas location (R8)
- [ ] Manual: zoom canvas in tab 2 → ghost cursor scales correctly
- [ ] Manual: no cursor movement for 2 s → dot fades to 15 % opacity; resumes on movement
- [ ] Manual: tab 1 disconnects → ghost cursor disappears from tab 2

**P3.4 (Partial-path streaming)**
- [ ] Manual: draw stroke in tab 1 → live growing polyline visible in tab 2 mid-draw
- [ ] Manual: commit stroke → ghost path replaced by final stroke; no flash
- [ ] Manual: tab 1 crashes mid-stroke → ghost path cleaned up in tab 2 (R4)
- [ ] **Manual: arrow ghost path resolves to arrow group without visible flash** (R16)

**P3.5 (Chip claims + join flow)**
- [ ] Manual: second tab joins → auto-assigned chip; badge appears on first tab
- [ ] Manual: two tabs join simultaneously → both get chip badges; no crash (R12)
- [ ] Manual: chip claim toast appears, auto-dismisses after 3 s
- [ ] Manual: peer count in `<RoomBar />` updates on join and leave

---

## 16. Open Questions for User Observation

Resolve before P3.5 ships widely:

1. **Operator chip auto-assignment vs. prompt.** Auto-assign is
   convenient but "I'm always Bravo" squads may fight it. Validate:
   does "tap a chip to change" recovers fast enough, or should the
   join flow include a one-click chip picker?

2. **Phase sync across peers.** Currently phase is personal. Should
   the narrator broadcast their current phase to all peers? The
   `chip:claim` event can be extended to carry `phase` cheaply.
   Validate: do squadmates actually want to be in sync on
   plan/record, or do they narrate independently?

3. **Room TTL length and visibility.** Does 24 h match actual use?
   If squads return the next day to review the canvas, 24 h is
   too short. Validate: observe one session end-to-end and check
   if "re-opening after a day" is a real pattern.

4. **Snapshot load latency on large canvases.** `canvas.loadFromJSON`
   with 300+ objects blocks the main thread ~50–150 ms. For a
   5-minute debrief this is unlikely to be felt; for a 30-minute
   session it might. Validate: time a realistic snapshot load; if
   > 200 ms, design a chunked progressive apply.

5. **Cursor visibility preference.** Ghost cursors are always
   visible (just faded at low opacity). Some users may find them
   distracting during narration. Consider a "hide cursors" toggle
   in `<RoomBar />` — trivial to add, but only worth the UI clutter
   if observation confirms it's needed.

---

## 17. Boundary

Per `/sc:design` contract, this document defines the design but
ships **no code**. The `/sc:implement` pass should execute
P3.1–P3.5 in order, validate against §15, and resolve §16 before
marking P3 complete. Server hosting must be provisioned (§5.6)
before P3.1 can be integration-tested.
