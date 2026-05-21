// Outlined pencil brush + matching Path subclass.
//
// fabric doesn't natively support a crisp stroke outline (a colored
// border drawn behind the main stroke). Its `Shadow` is always a
// gaussian halo — no way to get a hard edge. So we render every
// stroke as two passes:
//
//   1. Wider stroke in `outlineColor` (solid, no dashArray) —
//      the "outline" backing.
//   2. Original stroke on top.
//
// Both passes happen during live drawing (OutlinedPencilBrush) and
// after the path is finalized (OutlinedPath). Live and finalized
// stay visually identical because they share the same constants.
//
// SCALING. The outline thickness is a fixed FRACTION of the
// stroke's `strokeWidth`, not a constant in screen pixels. That
// means the outline scales together with the stroke as the user
// zooms: a path drawn with strokeWidth=W canvas units gets an
// outline of `W * (1 + 2*outlineRatio)` canvas units. Zooming in
// makes both grow together; zooming out makes both shrink
// together. This is what "scale with zoom like everything else"
// gets you — the outline behaves like the rest of the canvas.
//
// LIVE PREVIEW. fabric's BaseBrush._render path is two methods:
// `_render` (full re-render of all captured points) and an
// incremental path used by `onMouseMove` that only draws the
// latest segment. The incremental path doesn't compose cleanly
// with our outline pass (the new segment's outline would overlap
// the previous segment's main stroke). So `needsFullRender` is
// forced to true — every move event triggers a full re-render.
// Performance is fine for the stroke counts a debrief produces.

import * as fabric from "fabric";
import type { Canvas } from "fabric";
import {
  arrowheadVertices,
  tangentFromPoints,
  TANGENT_SAMPLE_COUNT,
} from "./freehand/arrowhead";

// Default outline appearance. Tune by changing these constants
// (single source of truth — applies to both live and finalized).
export const DEFAULT_OUTLINE_COLOR = "#000000";
// Each side's outline adds this fraction of strokeWidth. Total
// outline width = strokeWidth * (1 + 2 * outlineRatio).
// 0.2 = 20% on each side = total 140% the stroke's width.
export const DEFAULT_OUTLINE_RATIO = 0.1;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOpts = any;

export class OutlinedPath extends fabric.Path {
  outlineColor: string = DEFAULT_OUTLINE_COLOR;
  outlineRatio: number = DEFAULT_OUTLINE_RATIO;

  constructor(path: AnyOpts, options?: AnyOpts) {
    super(path, options);
    if (options?.outlineColor) this.outlineColor = options.outlineColor;
    if (typeof options?.outlineRatio === "number") {
      this.outlineRatio = options.outlineRatio;
    }
  }

  // Override the renderer to draw two passes. We mutate `this`
  // properties between super._render calls because fabric's
  // Path/_renderStroke reads `this.stroke`, `this.strokeWidth`,
  // and `this.strokeDashArray` from the live instance each call.
  // Save & restore so the object's persisted state is unchanged
  // after rendering (otherwise serialization or any inspection
  // mid-render would see the outline-pass values).
  _render(ctx: CanvasRenderingContext2D) {
    const origStroke = this.stroke;
    const origWidth = this.strokeWidth;
    const origDash = this.strokeDashArray;

    // Pass 1: solid wider outline behind the main stroke.
    // strokeDashArray=null so the outline is continuous even when
    // the main stroke is dashed (plan mode).
    this.stroke = this.outlineColor;
    this.strokeWidth = origWidth * (1 + 2 * this.outlineRatio);
    this.strokeDashArray = null;
    super._render(ctx);

    // Pass 2: original stroke, including dash pattern.
    this.stroke = origStroke;
    this.strokeWidth = origWidth;
    this.strokeDashArray = origDash;
    super._render(ctx);
  }
}

export class OutlinedPencilBrush extends fabric.PencilBrush {
  outlineColor: string = DEFAULT_OUTLINE_COLOR;
  outlineRatio: number = DEFAULT_OUTLINE_RATIO;
  /**
   * When true, the live preview renders an arrowhead at the end of
   * the captured stroke (a filled triangle, sized via the same
   * `arrowheadVertices` math the finalized arrow uses — so live and
   * finalized read identically). Set externally by App.tsx based on
   * the active tool: arrow → true, pencil → false. Defaults to
   * false so legacy callers (pencil-only) are unaffected.
   *
   * P1 §5.1 ships this flag for the "arrowhead visible during
   * drawing" requirement that the static `appendArrowhead`
   * postprocess (which only runs after release) can't satisfy.
   */
  arrowhead: boolean = false;

  constructor(canvas: Canvas) {
    super(canvas);
  }

  // See header comment item LIVE PREVIEW for why this is forced
  // true. (We also union with the base's truthy conditions —
  // shadow / alpha < 1 / plan-phase dash via the additional
  // override in App.tsx — to stay forward-compatible.)
  needsFullRender(): boolean {
    return true;
  }

  /**
   * Pre-decimation snapshot of `_points`, taken at the top of
   * `_finalizeAndAddPath` and read by `createPath` (which fabric
   * calls synchronously inside `_finalizeAndAddPath`, AFTER fabric
   * has already mutated `_points` in place via `decimatePoints`).
   *
   * Without this snapshot, the committed arrowhead's tangent walks
   * a DIFFERENT trailing point set than the live preview:
   *
   *  - Live `_renderLiveArrowhead` reads `_points` directly during
   *    draw, sampling raw captured points.
   *  - Committed (before snapshot) read `_points` inside `createPath`
   *    — but `_points` had already been replaced with the decimated
   *    set, which drops points within `decimate` px of each other
   *    AND, due to a `for (i = 1; i < l - 1; …)` quirk in fabric's
   *    `decimatePoints` (see fabric PencilBrush.ts:255), drops the
   *    second-to-last raw point unconditionally.
   *
   * The misalignment is most visible on short gestures with quick
   * direction changes: decimation removes adjacent points, the
   * tangent windows diverge, and the chevron rotates between live
   * and committed.
   *
   * Lifecycle: non-null only during the synchronous window between
   * the snapshot and `super._finalizeAndAddPath` returning. Stored
   * as plain {x,y}[] (not fabric.Point[]) so the path can carry it
   * cheaply and so it round-trips through JSON if ever serialized.
   */
  private _preDecimationSnapshot:
    | Array<{ x: number; y: number }>
    | null = null;

  _finalizeAndAddPath(): void {
    this._preDecimationSnapshot = this._points.map((p) => ({
      x: p.x,
      y: p.y,
    }));
    try {
      super._finalizeAndAddPath();
    } finally {
      // Always clear so a future stroke that fails before reaching
      // createPath (e.g. fabric's empty-SVG short-circuit) can't
      // poison the next path with stale points.
      this._preDecimationSnapshot = null;
    }
  }

  // Two-pass live render. Same shape as OutlinedPath._render —
  // mutate brush properties between super._render calls. The
  // brush's _setBrushStyles reads this.color/width/strokeDashArray
  // each time.
  //
  // The default-parameter dance matches fabric's PencilBrush._render
  // signature exactly. BaseBrush declares `abstract _render(): void`
  // (no args), so without the default value TypeScript would refuse
  // to assign this subclass to a `BaseBrush` slot — see
  // PencilBrush.ts line 177 for the canonical pattern.
  _render(ctx: CanvasRenderingContext2D = this.canvas.contextTop) {
    const origColor = this.color;
    const origWidth = this.width;
    const origDash = this.strokeDashArray;

    this.color = this.outlineColor;
    this.width = origWidth * (1 + 2 * this.outlineRatio);
    this.strokeDashArray = null;
    super._render(ctx);

    this.color = origColor;
    this.width = origWidth;
    this.strokeDashArray = origDash;
    super._render(ctx);

    if (this.arrowhead) {
      this._renderLiveArrowhead(ctx, origColor, origWidth);
    }
  }

  /**
   * Draw a filled-triangle arrowhead at the end of the currently
   * captured points. Called from `_render` only when `arrowhead`
   * is true; sized and positioned via the same math the finalized
   * arrowhead uses (`arrowheadVertices`), so the live preview and
   * the committed mark look identical.
   *
   * Tangent comes from the last two points (a chord, not a curve
   * derivative — fabric's brush stores raw points before
   * Q-smoothing, so a chord is the right tangent approximation
   * for live preview).
   *
   * IMPORTANT: fabric's BaseBrush wraps each pass of `super._render`
   * in a save / `_saveAndTransform` / draw / restore cycle. By the
   * time `super._render(ctx)` returns, the ctx has been restored
   * out of scene-coord space and is back in screen-pixel space.
   * Drawing in scene coords without re-applying the viewport
   * transform leaves the arrowhead floating off in the corner
   * (the bug the user reported as "detached"). We replicate
   * fabric's transform here.
   */
  private _renderLiveArrowhead(
    ctx: CanvasRenderingContext2D,
    color: string,
    strokeWidth: number,
  ): void {
    // `_points` is fabric's captured-pointer array. We need at
    // least two points to compute a tangent direction.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const points = (this as any)._points as
      | Array<{ x: number; y: number }>
      | undefined;
    if (!points || points.length < 2) return;
    const last = points[points.length - 1]!;
    // Average the tangent over the last TANGENT_SAMPLE_COUNT+1
    // captured points (matching the committed-arrow path's
    // smoothing). Single-segment tangent was too twitchy — every
    // mouse-move noise tick snapped the arrowhead's orientation
    // to the latest segment, which the user perceives as jitter.
    // tangentFromPoints skips collapsed adjacent points internally
    // and returns the fallback if no usable chord exists.
    const tailLen = Math.min(points.length, TANGENT_SAMPLE_COUNT + 1);
    const tail = points.slice(points.length - tailLen);
    const tangent = tangentFromPoints(tail);
    const [tip, l, r] = arrowheadVertices(
      { x: last.x, y: last.y },
      tangent,
      strokeWidth,
    );
    // Apply the canvas viewport transform so scene-coord vertices
    // land at the right screen pixels. ctx is otherwise in screen
    // space at this point (fabric's super._render restored it).
    const v = this.canvas.viewportTransform;
    ctx.save();
    ctx.transform(v[0], v[1], v[2], v[3], v[4], v[5]);
    // Chevron shape: two strokes from tip → left and tip → right
    // (matches the committed `buildArrowhead` `OutlinedPath`
    // which uses path-data `M tip L left M tip L right`). Each
    // arm is drawn twice — wider black outline first, then the
    // user-colored stroke on top — mirroring the line body's
    // two-pass outline so the chevron reads as continuous with
    // the line.
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const drawArms = () => {
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(l.x, l.y);
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(r.x, r.y);
      console.log(`left tip: (${l.x}, ${l.y}`);
      console.log(`right tip: (${r.x}, ${r.y}`);
      ctx.stroke();
    };
    // Outline pass.
    ctx.strokeStyle = this.outlineColor;
    ctx.lineWidth = strokeWidth * (1 + 2 * this.outlineRatio);
    drawArms();
    // User-color pass on top.
    ctx.strokeStyle = color;
    ctx.lineWidth = strokeWidth;
    drawArms();
    ctx.restore();
  }

  // Have the brush emit OutlinedPath instances instead of plain
  // Path so the FINALIZED stroke renders the same two passes as
  // the live preview. This is a verbatim copy of fabric's
  // PencilBrush.createPath (PencilBrush.ts:223-238) except it
  // constructs an OutlinedPath and threads outlineColor/Ratio
  // through. If fabric ever changes createPath's body upstream
  // (e.g. adds new stroke properties to copy), this method needs
  // updating too — flagging that here so a future reader knows
  // to diff against fabric's source on upgrades.
  //
  // We also stash a plain {x,y}[] snapshot of the captured points
  // on the path as `__rawPoints`. The arrow tool's appendArrowhead
  // reads these instead of the SVG path's Q-endpoints, because
  // fabric's `getSmoothPathFromPoints` writes the MIDPOINT of
  // consecutive captured points as each Q's endpoint — so walking
  // SVG endpoints samples a midpoint polyline, not the user's
  // actual gesture.
  //
  // Source preference: `_preDecimationSnapshot` (taken at the top
  // of `_finalizeAndAddPath`, before fabric's `decimatePoints`
  // mutates `_points` in place) → falls back to `_points` if the
  // snapshot is missing (e.g. tests calling createPath directly).
  // The pre-decimation set is what the live preview's
  // `_renderLiveArrowhead` also samples; using it here keeps the
  // committed and live arrowheads aligned at the gesture's
  // terminus — particularly on short, zig-zagging gestures where
  // decimation drops nearby points and shifts the trailing chord
  // directions.
  //
  // See src/tools/freehand/arrowhead.ts `computeTangent` and the
  // `pickTangent` helper in src/tools/arrow.ts for the consumer
  // side.
  createPath(pathData: AnyOpts): fabric.Path {
    const path = new OutlinedPath(pathData, {
      fill: null,
      stroke: this.color,
      strokeWidth: this.width,
      strokeLineCap: this.strokeLineCap,
      strokeMiterLimit: this.strokeMiterLimit,
      strokeLineJoin: this.strokeLineJoin,
      strokeDashArray: this.strokeDashArray,
      outlineColor: this.outlineColor,
      outlineRatio: this.outlineRatio,
    });
    if (this.shadow) {
      this.shadow.affectStroke = true;
      path.shadow = new fabric.Shadow(this.shadow);
    }
    // Prefer the pre-decimation snapshot. Fall back to the current
    // (post-decimation) `_points` only if the snapshot is missing
    // — e.g. unit tests that call createPath directly without
    // going through _finalizeAndAddPath. The plain-object copy
    // in the fallback path avoids retaining fabric.Point method
    // state on the path.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (path as any).__rawPoints =
      this._preDecimationSnapshot ??
      this._points.map((p) => ({ x: p.x, y: p.y }));
    return path;
  }
}
