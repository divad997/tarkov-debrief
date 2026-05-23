// Arrowhead geometry for the arrow tool.
//
// Given a freehand fabric.Path produced by fabric's freeDrawingBrush,
// compute the path's terminal tangent and build an isoceles-triangle
// arrowhead aligned with that tangent. The arrowhead's tip sits at
// the path's endpoint; the base sits 14px behind, perpendicular to
// the tangent, 10px wide.
//
// Why we compute tangent from path commands (not from a precomputed
// endpoint pair): fabric's PencilBrush emits a sequence of quadratic
// Bézier (`Q`) commands. The path's *visual* direction at the final
// point is the derivative of the last `Q` at t=1, which is
// `normalize(endpoint - lastControlPoint)`. Sampling
// (last - second-to-last) point coordinates would orient the head
// along the chord of the final curve segment, not the tangent —
// noticeable on tight curves.
//
// Design reference: claudedocs/design_p1_slice.md §5.1 step 2–3.

import {
  DEFAULT_OUTLINE_COLOR,
  DEFAULT_OUTLINE_RATIO,
  OutlinedPath,
} from "@/tools/OutlinedBrush";

// The shape of a fabric path command is `[string, ...numbers]` —
// the first element is the SVG-style command letter, the rest are
// numeric arguments. fabric v7's TS types model this as a heterogeneous
// tuple; we treat them more loosely here because the only operations
// we need are "read by index" and "read the first element as a
// string." Specifically `cmd[0]` is the command letter and the
// remaining slots are numbers (or null for the unused tail slots in
// some fabric versions, but we never read those).
export type Command = [string, ...(number | null)[]];

export interface Tangent {
  /** Unit-length direction at the path's terminus. */
  dx: number;
  dy: number;
}

export interface Point {
  x: number;
  y: number;
}

const FALLBACK_TANGENT: Tangent = { dx: 1, dy: 0 };

/**
 * Number of segments to average the tangent over.
 *
 * Single-segment tangent jitters with every mouse-move noise tick;
 * averaging across the last N segments smooths it without
 * introducing noticeable lag. fabric's PencilBrush captures points
 * at ~30-60 Hz with our decimate=4 setting, so 5 samples ≈ 20 px
 * of recent path — enough to absorb hand jitter while still tracking
 * intentional curves quickly.
 */
export const TANGENT_SAMPLE_COUNT = 30;
// Arrowhead size is computed relative to stroke width at draw time
// (see arrowheadVertices). The earlier draft used fixed pixel values
// (height=14, half-base=5) that happened to be smaller than the
// freehand brush's stroke width (~13.89 canvas units at default
// zoom), so the head sat invisibly inside the line. Sizing
// proportionally keeps the head readable across zoom and brush
// settings.
//
// Height ratio: how far the tip extends PAST the line's endpoint,
// expressed as a multiple of strokeWidth. Half-base ratio: how wide
// each side of the base is, also as a multiple of strokeWidth.
//
// Empirical tuning: at HEIGHT_RATIO=2 and HALF_BASE_RATIO=1.5, the
// arrowhead reads as a clear chevron at the end of any reasonable
// stroke width. Total base width = 3×stroke ⇒ visibly wider than
// the line; height = 2×stroke ⇒ pronounced point.
const ARROWHEAD_HEIGHT_RATIO = 4.0;
const ARROWHEAD_HALF_BASE_RATIO = 2;
// Minimum absolute dimensions (canvas units), in case strokeWidth is
// unexpectedly small (e.g., a configuration with a 1px brush).
const ARROWHEAD_MIN_HEIGHT = 10;
const ARROWHEAD_MIN_HALF_BASE = 6;

/**
 * Read the (x, y) at the end of a path command. The endpoint is
 * always at the last two numeric arguments — the same convention
 * SVG and fabric both use:
 *   - `M x y`            → endpoint (x, y)
 *   - `L x y`            → endpoint (x, y)
 *   - `Q cx cy x y`      → endpoint (x, y)
 *   - `C c1x c1y c2x c2y x y` → endpoint (x, y)
 */
export function lastPoint(cmd: Command): Point {
  // Filter out trailing nulls (some fabric versions pad commands).
  // Look from the right for the last numeric pair.
  for (let i = cmd.length - 1; i >= 1; i--) {
    const y = cmd[i];
    const x = cmd[i - 1];
    if (typeof x === "number" && typeof y === "number") {
      return { x, y };
    }
  }
  // Degenerate command — caller will likely fall back to the
  // default tangent anyway. Returning origin keeps the type honest.
  return { x: 0, y: 0 };
}

/**
 * Return the control point that determines the tangent at the
 * command's endpoint, or null if there isn't one (M/L commands).
 *
 *   - `Q cx cy x y`            → (cx, cy)
 *   - `C c1x c1y c2x c2y x y`  → (c2x, c2y)   // second control governs
 *                                              //  the t=1 tangent
 */
export function tangentControlOf(cmd: Command): Point | null {
  switch (cmd[0]) {
    case "Q": {
      const cx = cmd[1];
      const cy = cmd[2];
      if (typeof cx === "number" && typeof cy === "number") {
        return { x: cx, y: cy };
      }
      return null;
    }
    case "C": {
      const cx = cmd[3];
      const cy = cmd[4];
      if (typeof cx === "number" && typeof cy === "number") {
        return { x: cx, y: cy };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Compute a unit tangent averaged over the chord directions of the
 * last several segments of a polyline. Used for both the committed-
 * arrow path's tangent (via `computeTangent`, which extracts
 * endpoints from fabric path commands) and the live preview's
 * tangent (via OutlinedPencilBrush, which feeds in raw captured
 * `_points`).
 *
 * Algorithm:
 *   - For each consecutive pair of points, compute the unit chord
 *     direction.
 *   - Sum all unit tangents and renormalize.
 *   - Skip zero-length chords (collapsed adjacent points — fabric
 *     stores duplicates on slow moves and at gesture start).
 *   - Fall back to `(+1, 0)` if no usable chord exists or if the
 *     summed tangents cancel out (≈ zero net direction).
 *
 * Averaging UNIT vectors (not raw chord vectors) weighs each
 * segment equally regardless of length — so a slow draw with many
 * short segments isn't dominated by one accidentally-long jump.
 */
export function tangentFromPoints(points: readonly Point[]): Tangent {
  if (points.length < 2) return FALLBACK_TANGENT;
  let sumDx = 0;
  let sumDy = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    sumDx += dx / len;
    sumDy += dy / len;
  }
  const sumLen = Math.hypot(sumDx, sumDy);
  if (sumLen < 1e-9) return FALLBACK_TANGENT;
  return { dx: sumDx / sumLen, dy: sumDy / sumLen };
}

/**
 * Compute a unit tangent at the path's terminus by averaging over
 * the last `TANGENT_SAMPLE_COUNT` segments. Earlier drafts of this
 * function used the single last segment (either via the Bézier
 * control point or the chord into the final point). That gave
 * twitchy arrowhead orientation — every mouse-move noise tick
 * snapped the head to the latest segment's direction. Averaging
 * across recent segments smooths the orientation without lagging
 * intentional curves.
 *
 * Returns `(+1, 0)` for degenerate paths (no segments at all).
 */
export function computeTangent(commands: readonly Command[]): Tangent {
  if (commands.length === 0) return FALLBACK_TANGENT;
  // Collect endpoints of the last (TANGENT_SAMPLE_COUNT + 1)
  // commands. We need one more endpoint than samples because
  // tangent[i] is the chord between endpoint[i-1] and endpoint[i].
  const endpoints: Point[] = [];
  for (
    let i = commands.length - 1;
    i >= 0 && endpoints.length < TANGENT_SAMPLE_COUNT + 1;
    i--
  ) {
    endpoints.unshift(lastPoint(commands[i]!));
  }
  return tangentFromPoints(endpoints);
}

/**
 * Compute the three vertices of an arrowhead chevron aligned with
 * the tangent. Returns absolute canvas coordinates (not relative to
 * a group); the caller wraps them in an `OutlinedPath`.
 *
 * Geometry: tip COINCIDES with the line's endpoint, and the two
 * arms point BACK along -tangent. The line and arrowhead meet at a
 * single point — visually:
 *
 *       \
 *        \
 *  ───────● ← endpoint == tip
 *        /
 *       /
 *
 *   - Tip       = endpoint                        ← AT the line end
 *   - Base-axis = endpoint - height * tangent     ← behind the
 *                                                   line end
 *   - Base-left = base-axis + halfBase * perpendicular(tangent)
 *   - Base-right = base-axis - halfBase * perpendicular(tangent)
 *
 * Sizes scale with `strokeWidth`: the arrowhead's base is always
 * wider than the line's stroke, so each arm visually reads as a
 * distinct chevron arm rather than a continuation of the line.
 *
 * `perpendicular((dx, dy)) = (-dy, dx)` — a 90° CCW rotation in
 * math convention; in fabric's Y-down screen coords this rotates
 * CW visually. The base's left/right symmetry makes the visual
 * handedness irrelevant.
 */
export function arrowheadVertices(
  endpoint: Point,
  tangent: Tangent,
  strokeWidth: number,
): [Point, Point, Point] {
  const height = Math.max(
    strokeWidth * ARROWHEAD_HEIGHT_RATIO,
    ARROWHEAD_MIN_HEIGHT,
  );
  const halfBase = Math.max(
    strokeWidth * ARROWHEAD_HALF_BASE_RATIO,
    ARROWHEAD_MIN_HALF_BASE,
  );
  // Base-axis = endpoint - height * tangent (behind the endpoint).
  const baseX = endpoint.x - height * tangent.dx;
  const baseY = endpoint.y - height * tangent.dy;
  const perpX = -tangent.dy;
  const perpY = tangent.dx;
  return [
    { x: endpoint.x, y: endpoint.y },
    {
      x: baseX + halfBase * perpX,
      y: baseY + halfBase * perpY,
    },
    {
      x: baseX - halfBase * perpX,
      y: baseY - halfBase * perpY,
    },
  ];
}

/**
 * Build an `OutlinedPath` for the arrowhead, given the underlying
 * path's stroke color (so the head and the line match visually).
 *
 * The arrowhead is drawn as a CHEVRON — two line segments meeting
 * at the tip, like `^` — rather than a filled triangle. Each arm
 * runs from the tip to one of the base vertices. Reusing
 * `OutlinedPath` means the chevron gets the same two-pass outline
 * (wider black underneath, user-colored stroke on top) as the line
 * body, so the head reads as a visually continuous extension of
 * the stroke.
 *
 * The path-data string is two disjoint subpaths — `M tip L
 * baseLeft M tip L baseRight` — joined as a single `OutlinedPath`
 * so the eraser and undo treat it atomically. The selectable=
 * false / evented=false flags keep the chevron from being picked
 * out of its parent group during selection.
 */
export function buildArrowhead(
  endpoint: Point,
  tangent: Tangent,
  color: string,
  strokeWidth: number,
): OutlinedPath {
  const [tip, left, right] = arrowheadVertices(endpoint, tangent, strokeWidth);
  const d =
    `M ${tip.x} ${tip.y} L ${left.x} ${left.y} ` +
    `M ${tip.x} ${tip.y} L ${right.x} ${right.y}`;
  return new OutlinedPath(d, {
    fill: null,
    stroke: color,
    strokeWidth,
    // Match the line body's stroke linecaps / joins so the chevron
    // tips and the body's free end look continuous.
    strokeLineCap: "round",
    strokeLineJoin: "round",
    // Same outline scheme as the body — OutlinedPath._render
    // draws the wider black outline pass first, then the colored
    // stroke on top.
    outlineColor: DEFAULT_OUTLINE_COLOR,
    outlineRatio: DEFAULT_OUTLINE_RATIO,
    selectable: false,
    evented: false,
    objectCaching: true,
  });
}
