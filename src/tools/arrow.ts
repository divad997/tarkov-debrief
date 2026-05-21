// Arrow tool — freehand path with an appended arrowhead.
//
// An "evolution of pencil" per design doc §5.1: same brush, same
// listener, same operator/phase tagging. The only delta is a
// path:created postprocess that:
//
//   1. Computes a tangent at the path's terminus.
//   2. Builds an arrowhead polygon aligned with that tangent.
//   3. Groups the path + arrowhead into a single fabric.Group.
//   4. Tags the group as a tactical-mark of type "arrow".
//   5. Updates `lastArrowTipRef` so the next sightline / cone has
//      an anchor.
//   6. Swaps the just-added path on the canvas for the group, in a
//      way the undo stack treats as a single "add arrow" action.
//
// Step 6 is intricate because fabric has *already* emitted
// `object:added` for the raw path by the time `path:created` fires.
// useUndo has recorded `{ type: 'add', object: path }`. To end up
// with a single `add group` entry instead, the postprocess:
//   - pops the path's auto-add via undo.popLastAction()
//   - marks the path transient so the upcoming canvas.remove(path)
//     is suppressed
//   - lets canvas.add(group) record normally
//
// See claudedocs/design_p1_slice.md §5.1 step 8 and §4.10 for the
// undo-API contract.

import * as fabric from "fabric";
import { useMemo } from "react";
import {
  useFreehand,
  type FreehandSpec,
  type FreehandPostprocessContext,
} from "./freehand/useFreehand";
import {
  computeTangent,
  buildArrowhead,
  lastPoint,
  tangentFromPoints,
  TANGENT_SAMPLE_COUNT,
  type Point as ArrowPoint,
  type Tangent,
} from "./freehand/arrowhead";
import { tagObject, tagMarkType, tagArrowTip } from "./metadata";
import type { Tool, SetToolFn } from "./tool";
import { ToolType } from "./tool";
import type { OperatorId } from "@/state/operators";
import type { Phase } from "@/state/phase";
import type { UndoApi } from "./undo";

/**
 * The path-array shape that fabric.Path.path exposes. Defined here
 * (rather than imported) because fabric's exported types fluctuate
 * across patch versions and we only need a narrow read-shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FabricPathCommands = readonly any[][];

/**
 * Compute the tangent at the path's terminus.
 *
 * Prefers `path.__rawPoints` — the post-decimation, pre-smoothing
 * point set the OutlinedPencilBrush stashed on the path when it
 * was created (see OutlinedBrush.ts `createPath`). Those are the
 * actual points the user drew.
 *
 * Falls back to walking the SVG path commands via `computeTangent`
 * when `__rawPoints` is missing — e.g., paths constructed in
 * tests via `new fabric.Path("M …")`, or paths loaded from a
 * serialized form that doesn't carry `__rawPoints`.
 *
 * Why we prefer raw points: fabric's `getSmoothPathFromPoints`
 * (util/path/index.ts in fabric@7) emits Q commands whose
 * ENDPOINTS are midpoints between consecutive captured points,
 * not the captured points themselves. Sampling the SVG endpoints
 * therefore averages chord directions over a midpoint-polyline,
 * not the user's actual gesture. Live preview already reads from
 * `_points` directly (see OutlinedPencilBrush `_renderLiveArrowhead`)
 * — committing to `__rawPoints` here makes the committed tangent
 * agree with the live preview's tangent.
 */
function pickTangent(
  path: fabric.Path,
  commands: FabricPathCommands,
): Tangent {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (path as any).__rawPoints as
    | ReadonlyArray<ArrowPoint>
    | undefined;
  if (raw && raw.length >= 2) {
    // Use the same trailing-window length the SVG-walking path
    // uses, so behavior is consistent across the two code paths.
    const tailLen = Math.min(raw.length, TANGENT_SAMPLE_COUNT + 1);
    return tangentFromPoints(raw.slice(raw.length - tailLen));
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return computeTangent(commands as any);
}

function appendArrowhead(
  path: fabric.Path,
  ctx: FreehandPostprocessContext,
): void {
  const commands = path.path as unknown as FabricPathCommands;
  if (commands.length === 0) {
    // A truly empty path shouldn't happen — fabric always emits at
    // least the initial M command. Bail out without grouping rather
    // than crashing; the raw path stays on the canvas.
    return;
  }
  const tangent = pickTangent(path, commands);
  // Endpoint stays read from the SVG commands (not `__rawPoints`)
  // so the chevron's tip coincides with the VISIBLE line end. The
  // last command is a fabric `L` whose endpoint is the final
  // captured point ± `width/1000` (a tiny correction fabric applies
  // in `getSmoothPathFromPoints`). Reading from the command keeps
  // the tip aligned with where the rendered stroke actually ends,
  // even though the tangent now comes from the un-smoothed point
  // set above.
  const endpoint = lastPoint(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commands[commands.length - 1] as any,
  );

  // Determine the arrowhead color. The path inherits its stroke
  // from the brush at draw time; the brush is configured at the
  // App level to follow the active operator (or the pencil's
  // current color when on legacy palette). Reuse the path's
  // realized stroke so the arrowhead always matches the line.
  const color = (path.stroke as string | undefined) ?? "#000000";
  // Pass the path's stroke width so the arrowhead scales with it
  // — fixed-pixel arrowheads were getting buried by wider strokes
  // (see ARROWHEAD_HEIGHT_RATIO comment in arrowhead.ts).
  const strokeWidth = (path.strokeWidth as number | undefined) ?? 5;
  const arrowhead = buildArrowhead(
    endpoint,
    tangent,
    color,
    strokeWidth,
  );

  // The path is currently on the canvas. fabric.Group's constructor
  // expects objects that are NOT currently rendered on a canvas
  // (it adopts them as children). To satisfy that, remove the path
  // first — but we have to make the remove invisible to useUndo
  // (the path's auto-add is also invisible after the popLastAction
  // call below).
  const undo = ctx.undo;
  if (undo) {
    // Retract the path's auto-recorded `add` action. After this,
    // the undo stack has whatever it had BEFORE the brush stroke
    // started — a clean baseline for the group's add to land on.
    undo.popLastAction();
    // Make the path's upcoming remove invisible to useUndo's
    // object:removed listener.
    undo.markTransient(path);
  }

  ctx.canvas.remove(path);

  // P2: tag the body and head with __role so the replay animator
  // (src/tools/marks/animators.ts) can identify them without
  // relying on the children-array order. Cheap forward-compat: if
  // arrow ever grows a third child (a label, a hover dot, …) the
  // animator still picks the right one. Pattern matches the
  // existing __operatorId / __phase / __markType custom-property
  // tagging convention; the type-cast through `any` is the same
  // shape eslint.config.js permits for fabric integration.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (path as any).__role = "body";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (arrowhead as any).__role = "head";

  // Now construct the group from path + arrowhead. fabric.Group
  // re-parents the children and computes its own bounding box.
  // We attach metadata to the group (not to its children) so
  // selection, eraser, and visibility logic dispatch on the group
  // as a whole.
  const group = new fabric.Group([path, arrowhead], {
    // The default is "selectable: true"; we explicitly preserve
    // that so the user can click-and-drag to translate the arrow
    // (move-by-body is the only direct manipulation in P1 per
    // §10.2).
    selectable: true,
    evented: true,
    // No custom controls in P1 (curved-path editing is deferred).
    // We still disable the default corner controls to avoid users
    // accidentally rotating/scaling the arrow into a weird shape.
    hasControls: false,
    hasBorders: true,
  });

  tagObject(group, ctx.operatorId, ctx.phase);
  tagMarkType(group, "arrow");
  // Stash the tip on the group itself so the App-level chain-anchor
  // recomputer can read it on canvas walks (see App.tsx's
  // `recomputeLastArrowTip` subscriber). Storing the tip ON the
  // object — rather than directly in an outside ref — is what
  // makes undo and eraser update the anchor automatically:
  // removing the arrow removes its tip; the recomputer picks the
  // next-most-recent arrow's tip (or null) on the very next
  // object:removed event.
  tagArrowTip(group, endpoint);

  // canvas.add(group) emits object:added → useUndo records it
  // normally as `{ type: 'add', object: group }`. Net effect on the
  // undo stack of this whole postprocess is +1 entry, undoing
  // which removes the arrow atomically. object:added also fires
  // App.tsx's `recomputeLastArrowTip` which reads the freshly-
  // tagged tip and updates `lastArrowTipRef`.
  ctx.canvas.add(group);
  ctx.canvas.requestRenderAll();
}

/**
 * Hook for the arrow tool. Wraps `useFreehand` with the
 * appendArrowhead postprocess. No `lastArrowTipRef` parameter
 * any more — the chain anchor is derived from canvas state (each
 * arrow group carries its own `__arrowTip`; App.tsx subscribes to
 * canvas object:added/object:removed and recomputes the ref by
 * walking objects in reverse), so undo and eraser update the
 * anchor automatically.
 */
export const useArrow = (
  canvas: fabric.Canvas | null,
  setTool: SetToolFn,
  tool: Tool,
  activeOperatorId: OperatorId | null,
  phase: Phase,
  undoApi: UndoApi | null,
) => {
  // Memoize the spec so its identity is stable across renders.
  // The postprocess closes over nothing mutable; the ref-mirror
  // pattern that useFreehand applies internally handles operator/
  // phase staleness for tag time.
  const spec = useMemo<FreehandSpec>(
    () => ({
      toolType: ToolType.arrow,
      markType: "arrow",
      onPathCreated: (path, ctx) => {
        appendArrowhead(path, ctx);
      },
    }),
    [],
  );

  return useFreehand(
    canvas,
    setTool,
    tool,
    spec,
    activeOperatorId,
    phase,
    undoApi,
  );
};
