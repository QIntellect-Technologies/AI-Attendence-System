/**
 * useDropdownPosition.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Computes viewport-fixed coordinates for a portaled dropdown panel, anchored
 * to a trigger element. Exists specifically so dropdown panels can be rendered
 * via `createPortal(..., document.body)` and stay immune to ANY ancestor's
 * stacking context (transform, isolation, filter, opacity, etc.) — see the
 * BranchSelector/ModernSelect z-index investigation this was built to fix.
 *
 * Why `position: fixed` + getBoundingClientRect() instead of `position: absolute`:
 *   `getBoundingClientRect()` returns viewport-relative coordinates, which is
 *   exactly what `position: fixed` expects — no scrollX/scrollY math needed,
 *   and (unlike `absolute`) it isn't affected by any scrollable ancestor's
 *   own positioning context once portaled to <body>.
 *
 * Why requestAnimationFrame-throttled scroll/resize listeners:
 *   Scroll fires far more often than the browser can usefully repaint at.
 *   Recomputing on every event would do redundant layout reads; coalescing to
 *   one recompute per animation frame keeps the panel glued to the trigger
 *   without doing more work than the screen can show.
 *
 * Usage:
 *   const triggerRef = useRef<HTMLDivElement>(null);
 *   const position = useDropdownPosition(triggerRef, open, { align: "start", matchTriggerWidth: true });
 *
 *   {shouldRender && position && createPortal(
 *     <div style={{ position: "fixed", top: position.top, left: position.left, width: position.width }}>
 *       ...
 *     </div>,
 *     document.body,
 *   )}
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type React from "react";

export interface UseDropdownPositionOptions {
  /**
   * "start": panel's left edge aligns with the trigger's left edge (e.g. ModernSelect).
   * "end": panel's right edge aligns with the trigger's right edge, growing leftward
   *        if the panel is wider than the trigger (e.g. BranchSelector).
   * Default "start".
   */
  align?: "start" | "end";
  /** Vertical gap between trigger and panel, in px. Default 8. */
  gap?: number;
  /** If true, panel width is pinned to exactly the trigger's width (ModernSelect). Default false. */
  matchTriggerWidth?: boolean;
  /** Passed straight through to the returned position for convenience (BranchSelector's minWidth: 220). */
  minWidth?: number;
}

export interface DropdownPosition {
  top: number;
  left?: number;
  right?: number;
  width?: number;
  minWidth?: number;
}

export function useDropdownPosition<T extends HTMLElement>(
  triggerRef: React.RefObject<T | null>,
  open: boolean,
  {
    align = "start",
    gap = 8,
    matchTriggerWidth = false,
    minWidth,
  }: UseDropdownPositionOptions = {},
): DropdownPosition | null {
  const [position, setPosition] = useState<DropdownPosition | null>(null);
  const frameId = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const top = rect.bottom + gap;

    setPosition(
      align === "start"
        ? {
            top,
            left: rect.left,
            width: matchTriggerWidth ? rect.width : undefined,
            minWidth,
          }
        : {
            top,
            right: window.innerWidth - rect.right,
            minWidth,
          },
    );
  }, [triggerRef, align, gap, matchTriggerWidth, minWidth]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    // Synchronous first measurement so the panel never paints at (0,0) for a frame.
    recompute();

    const handleScrollOrResize = () => {
      if (frameId.current !== null) return; // already queued for this frame
      frameId.current = requestAnimationFrame(() => {
        frameId.current = null;
        recompute();
      });
    };

    // `capture: true` so scrolling INSIDE any nested scrollable ancestor
    // (a scrollable card, modal body, etc.) is caught too, not just window scroll.
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);

    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
      if (frameId.current !== null) cancelAnimationFrame(frameId.current);
    };
  }, [open, recompute]);

  return position;
}
