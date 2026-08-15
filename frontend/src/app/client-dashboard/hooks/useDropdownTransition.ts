/**
 * useDropdownTransition.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared open/close animation for dropdown panels (BranchSelector, ModernSelect,
 * and any future dropdown that wants this treatment).
 *
 * Behavior (matches the "expanding card" reference):
 *   - Panel height animates from 0 → measured content height on open, and back
 *     to 0 on close (not a simple opacity/scale fade) — gives the "unfurling
 *     card" feel instead of a generic popover fade.
 *   - Rows marked with `data-dropdown-row` inside the panel get a staggered
 *     fade + slide-in as the panel expands, for the cascading reveal effect.
 *   - The panel stays mounted for the duration of the close animation, then
 *     unmounts (same lifecycle-safety guarantee as before).
 *
 * Built on the native Web Animations API — no dependency, no global <style>
 * injection, no CSS class management. Height is read via
 * `getBoundingClientRect()` on a separate "content" element so we can animate
 * the wrapper without the content's own size interfering with the measurement.
 *
 * Usage:
 *   const { shouldRender, panelRef, contentRef } = useDropdownTransition(open);
 *
 *   {shouldRender && (
 *     <div ref={panelRef} style={{ position: "absolute", top: "100%", overflow: "hidden", ... }}>
 *       <div ref={contentRef}>
 *         <div data-dropdown-row>Row 1</div>
 *         <div data-dropdown-row>Row 2</div>
 *       </div>
 *     </div>
 *   )}
 *
 * Important: do NOT set `height` in the panel's React `style` prop — this hook
 * owns that property imperatively during the animation. Everything else
 * (position, border, borderRadius, background, width…) is the consumer's.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useLayoutEffect, useRef, useState } from "react";

const ROW_SELECTOR = "[data-dropdown-row]";
const ROW_STAGGER_STEP_MS = 34;
const ROW_STAGGER_CAP_MS = 170;
const ROW_REVEAL_DURATION_MS = 240;

const ENTER_EASING = "cubic-bezier(0.16, 1, 0.3, 1)";
const EXIT_EASING = "cubic-bezier(0.4, 0, 1, 1)";

export interface UseDropdownTransitionOptions {
  /** Duration of the expand animation in ms. Default 380. */
  enterDurationMs?: number;
  /** Duration of the collapse animation in ms. Default 280 (closes should still feel a touch quicker than opens). */
  exitDurationMs?: number;
}

export interface UseDropdownTransitionResult<
  P extends HTMLElement,
  C extends HTMLElement,
> {
  /** Whether the panel should currently be in the DOM (true during open + while the collapse animation plays). */
  shouldRender: boolean;
  /** Attach to the outer panel element — this is the node whose height gets animated. Must have `overflow: hidden` available to it (the hook sets this imperatively). Nullable before mount / after unmount, like any React ref. */
  panelRef: React.RefObject<P | null>;
  /** Attach to the inner content wrapper — its natural height is what the panel expands to. Nullable before mount / after unmount, like any React ref. */
  contentRef: React.RefObject<C | null>;
}

export function useDropdownTransition<
  P extends HTMLElement = HTMLDivElement,
  C extends HTMLElement = HTMLDivElement,
>(
  open: boolean,
  {
    enterDurationMs = 380,
    exitDurationMs = 280,
  }: UseDropdownTransitionOptions = {},
): UseDropdownTransitionResult<P, C> {
  const [shouldRender, setShouldRender] = useState(open);
  const panelRef = useRef<P>(null);
  const contentRef = useRef<C>(null);
  const wasOpen = useRef(open);

  // Mount on open; on close, collapse height to 0 then unmount.
  useLayoutEffect(() => {
    const panel = panelRef.current;

    if (open && !wasOpen.current) {
      wasOpen.current = true;
      setShouldRender(true);
      return;
    }

    if (!open && wasOpen.current) {
      wasOpen.current = false;

      if (!panel) {
        setShouldRender(false);
        return;
      }

      const fromHeight = panel.getBoundingClientRect().height;
      panel.style.overflow = "hidden";

      const heightAnim = panel.animate(
        [{ height: `${fromHeight}px` }, { height: "0px" }],
        { duration: exitDurationMs, easing: EXIT_EASING, fill: "forwards" },
      );

      // Content fades a touch faster than the height collapses so it doesn't
      // look like text getting guillotined by the closing edge.
      const fadeAnim = contentRef.current?.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        {
          duration: Math.round(exitDurationMs * 0.6),
          easing: EXIT_EASING,
          fill: "forwards",
        },
      );

      heightAnim.onfinish = () => setShouldRender(false);

      return () => {
        heightAnim.onfinish = null;
        heightAnim.cancel();
        fadeAnim?.cancel();
      };
    }
  }, [open, exitDurationMs]);

  // Expand height + stagger-reveal rows once the panel is in the DOM.
  useLayoutEffect(() => {
    if (!open || !shouldRender) return;

    const panel = panelRef.current;
    const content = contentRef.current;
    if (!panel || !content) return;

    const targetHeight = content.getBoundingClientRect().height;

    panel.style.overflow = "hidden";
    panel.style.height = "0px";

    const heightAnim = panel.animate(
      [{ height: "0px" }, { height: `${targetHeight}px` }],
      { duration: enterDurationMs, easing: ENTER_EASING, fill: "forwards" },
    );
    heightAnim.onfinish = () => {
      // Let content size flex naturally after the expand finishes (e.g. if
      // the option list changes height later without a full reopen).
      panel.style.overflow = "visible";
      panel.style.height = "auto";
    };

    const rowAnims: Animation[] = [];
    const rows = panel.querySelectorAll<HTMLElement>(ROW_SELECTOR);
    rows.forEach((row, index) => {
      const delay = Math.min(index * ROW_STAGGER_STEP_MS, ROW_STAGGER_CAP_MS);
      rowAnims.push(
        row.animate(
          [
            { opacity: 0, transform: "translateY(-4px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          {
            duration: ROW_REVEAL_DURATION_MS,
            delay,
            easing: ENTER_EASING,
            fill: "both",
          },
        ),
      );
    });

    return () => {
      heightAnim.onfinish = null;
      heightAnim.cancel();
      rowAnims.forEach((a) => a.cancel());
    };
  }, [open, shouldRender, enterDurationMs]);

  return { shouldRender, panelRef, contentRef };
}
