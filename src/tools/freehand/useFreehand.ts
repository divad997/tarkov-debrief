// Shared continuous-capture hook for pencil and arrow.
//
// Both tools use fabric's freeDrawingBrush to capture every point
// along the cursor path, producing a single fabric.Path on
// mouse:up. The lifecycle is identical for both — what differs is
// an optional postprocess step on path:created (arrow appends an
// arrowhead and groups; pencil does nothing).
//
// Distinct from `useMark` (./marks/useMark.ts), which serves the
// discrete-gesture tools (sightline single-click commits, cone
// drag-defines-arc, point marks, text labels). Two factories with
// clear boundaries was preferred over one factory with internal
// branching — see claudedocs/design_p1_slice.md §3.2 and the
// design-review discussion around it.
//
// Why operator + phase are passed as raw values (not refs): we
// mirror them into refs *inside* this hook, mirroring the same
// pattern usePencil uses today. Callers don't have to know about
// the ref-mirror requirement.
//
// Design references:
//   - claudedocs/design_p1_slice.md §5.1 (arrow uses this factory)
//   - claudedocs/design_p1_slice.md §3.2 (factory split rationale)

import * as fabric from "fabric";
import { useCallback, useEffect, useRef } from "react";
import { tagObject, tagMarkType, type MarkType } from "@/tools/metadata";
import { Tool, ToolType, SetToolFn } from "@/tools/tool";
import type { OperatorId } from "@/state/operators";
import type { Phase } from "@/state/phase";
import type { UndoApi } from "@/tools/undo";

/**
 * Context handed to a freehand spec's postprocess. Lets the
 * postprocess (e.g. arrow's appendArrowhead) interact with the
 * canvas and the undo stack without having to import them globally
 * or thread additional params through useFreehand.
 */
export interface FreehandPostprocessContext {
  canvas: fabric.Canvas;
  /**
   * Non-null only when the parent threaded one in. Arrow's
   * path→group swap depends on the undo API (popLastAction +
   * markTransient — see design doc §5.1 step 8). Pencil works fine
   * with this absent.
   */
  undo: UndoApi | null;
  /** The active operator at path:created time. Tagged for you already. */
  operatorId: OperatorId | null;
  /** The current phase. Tagged for you already. */
  phase: Phase;
}

export interface FreehandSpec {
  /** The ToolType that activates this freehand variant. */
  toolType: ToolType;
  /**
   * Optional metadata tag. Pencil leaves this undefined (legacy P0
   * pencil strokes carry no markType); arrow sets "arrow" so its
   * group lands in the registry-aware code paths (modify support
   * in the future, color-rule lookups, eraser-level logging, etc.).
   */
  markType?: MarkType;
  /**
   * Optional postprocess. Called immediately after tagObject so the
   * postprocess can read tags via metadata.ts helpers if needed.
   * Returning a fabric object replaces the just-created path on the
   * canvas with the returned object (used by arrow to swap the path
   * for a group containing the path + arrowhead — design doc §5.1
   * step 8). Returning void leaves the path as-is.
   */
  onPathCreated?: (
    path: fabric.Path,
    ctx: FreehandPostprocessContext,
  ) => fabric.FabricObject | void;
}

export function useFreehand(
  canvas: fabric.Canvas | null,
  setTool: SetToolFn,
  tool: Tool,
  spec: FreehandSpec,
  activeOperatorId: OperatorId | null,
  phase: Phase,
  undoApi: UndoApi | null,
) {
  // Ref-mirror so the path:created handler reads live values, not
  // a stale closure captured at effect-mount time. Same pattern as
  // tools/pan.ts toolRef and the prior pencil.ts implementation.
  const operatorRef = useRef<OperatorId | null>(activeOperatorId);
  const phaseRef = useRef<Phase>(phase);
  const undoRef = useRef<UndoApi | null>(undoApi);
  operatorRef.current = activeOperatorId;
  phaseRef.current = phase;
  undoRef.current = undoApi;

  // Static fields (spec.toolType, spec.onPathCreated) don't need
  // ref-mirroring — they're stable across the spec's lifetime.

  const onChoice = useCallback(() => {
    setTool({ ...tool, type: spec.toolType, cursor: null });
  }, [setTool, tool, spec.toolType]);

  useEffect(() => {
    if (!canvas || tool.type !== spec.toolType) return;

    canvas.isDrawingMode = true;

    // Tag freshly-created paths with the current operator + phase.
    // fabric's `before:path:created` fires once before stroke is added to the canvas,
    const onBeforePathCreated = (opt: { path: fabric.Path }) => {
      const path = opt.path;
      tagObject(path, operatorRef.current, phaseRef.current);
      if (spec.markType !== undefined) {
        tagMarkType(path, spec.markType);
      }
    }

    // As opposed to onBeforePathCreated, `path:created` runs
    // AFTER fabric has already emitted `object:added` for the raw
    // path and added it to the canvas. That ordering matters for
    // the arrow postprocess's path→group swap (see design doc
    // §4.10 + §5.1 step 8): the path is already on the undo stack
    // by the time we get here.
    //
    // Note: strokeDashArray is intentionally NOT applied here.
    // It's set on the brush itself by the "Brush strokeDashArray
    // follows phase" effect in src/App.tsx, and fabric's
    // PencilBrush.createPath copies brush.strokeDashArray onto the
    // finalized Path automatically. This keeps the live preview
    // in sync with the finalized stroke.
    const onPathCreated = (opt: { path: fabric.Path }) => {
      const path = opt.path;
      if (spec.onPathCreated) {
        spec.onPathCreated(path, {
          canvas,
          undo: undoRef.current,
          operatorId: operatorRef.current,
          phase: phaseRef.current,
        });
      }
    };
    canvas.on("before:path:created", onBeforePathCreated);
    canvas.on("path:created", onPathCreated);

    return () => {
      canvas.isDrawingMode = false;
      canvas.off("before:path:created", onBeforePathCreated);
      canvas.off("path:created", onPathCreated);
    };
    // `spec` is treated as stable; if the caller swaps the entire
    // spec at runtime, they should remount the consumer. The
    // existing tool effect re-runs only on canvas/tool.type
    // changes, mirroring how P0's usePencil did it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, tool.type, spec.toolType]);

  return { onChoice };
}
