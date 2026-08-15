/**
 * useJellyHoverFill.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable "liquid fill" hover effect for buttons: a colored layer sweeps up
 * from the bottom with a slight skew + elastic overshoot, fully covering the
 * button, then recedes the same way on mouse-leave. Desktop/hover-only by
 * design (no touch fallback).
 *
 * Built on the native Web Animations API, animating only `transform`
 * (translateY for fill, translateY + scaleY jiggle for content) —
 * GPU-composited, no layout thrash, no dependency.
 *
 * The hook gives you:
 *   - `fillRef`    → attach to the fill layer span (first child of button)
 *   - `contentRef` → attach to the content wrapper span (icon + label)
 *   - `hovered`    → boolean to drive color transitions on children
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   const { hostRef, fillRef, contentRef, hovered } =
 *     useJellyHoverFill<HTMLButtonElement>({ fillColor: "#0d9488" });
 *
 *   <button ref={hostRef} style={{ ...DEFAULT_STYLE, ...JELLY_HOST_BASE_STYLE }}>
 *     <span ref={fillRef} style={JELLY_FILL_BASE_STYLE} />
 *     <span ref={contentRef} style={JELLY_CONTENT_BASE_STYLE}>
 *       <Download size={14} style={{ color: hovered ? "#fff" : "#0d9488", transition: "color 220ms ease" }} />
 *       <span style={{ color: hovered ? "#fff" : "#334155", transition: "color 220ms ease" }}>
 *         Export CSV
 *       </span>
 *     </span>
 *   </button>
 *
 * Notes:
 *   - `JELLY_HOST_BASE_STYLE` sets `position: relative`, `overflow: hidden`,
 *     `isolation: isolate` — required so the fill layer clips to the button's
 *     border-radius. Spread it AFTER your own style object.
 *   - Content jiggle: text stays fully inside the button. On fill-enter it
 *     compresses down then springs back elastically. On fill-exit it lifts
 *     slightly then settles. Physics is baked into multi-stop `offset` keyframes
 *     with `easing: "linear"` so each stop lands precisely.
 *   - `fillColor` is applied imperatively by the hook — don't set `background`
 *     on the fill span yourself.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useState } from "react";
import type React from "react";

// ── Easing constants ────────────────────────────────────────────────────────
const ENTER_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)"; // elastic overshoot for fill
const EXIT_EASING = "cubic-bezier(0.4, 0, 0.2, 1)"; // snappy standard ease-in-out

// ── Public types ────────────────────────────────────────────────────────────
export interface UseJellyHoverFillOptions {
  /** Background color of the fill layer (e.g. "#0d9488"). Applied imperatively to fillRef. */
  fillColor: string;
  /** Duration of the fill sweeping in, in ms. Default 580. */
  enterDurationMs?: number;
  /** Duration of the fill receding, in ms. Default 420. */
  exitDurationMs?: number;
  /** Skip all animation/listeners — use for disabled buttons. */
  disabled?: boolean;
}

export interface UseJellyHoverFillResult<
  H extends HTMLElement = HTMLButtonElement,
  F extends HTMLElement = HTMLSpanElement,
  C extends HTMLElement = HTMLSpanElement,
> {
  /** Attach to the button element itself. */
  hostRef: React.RefObject<H | null>;
  /** Attach to the fill layer span — render as first child of button, before content. */
  fillRef: React.RefObject<F | null>;
  /** Attach to the content wrapper span (icon + label). Drives the jiggle animation. */
  contentRef: React.RefObject<C | null>;
  /** True while fill is covering the button — use to recolor icon/label. */
  hovered: boolean;
}

// ── Exported style constants ────────────────────────────────────────────────

/** Spread onto the button's own style object (after your own styles). */
export const JELLY_HOST_BASE_STYLE: React.CSSProperties = {
  position: "relative",
  overflow: "hidden",
  isolation: "isolate",
};

/** Spread onto the fill span. Color is applied by the hook — don't set `background` here. */
export const JELLY_FILL_BASE_STYLE: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  zIndex: 0,
  pointerEvents: "none",
  transform: "translate3d(0, 101%, 0)",
  willChange: "transform",
};

/** Spread onto the wrapper around your button's visible content (icon + label). */
export const JELLY_CONTENT_BASE_STYLE: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "inherit",
  willChange: "transform", // promotes to compositor layer for jiggle animation
};

// ── Fill keyframes ──────────────────────────────────────────────────────────
const FILL_ENTER_KF: Keyframe[] = [
  { transform: "translate3d(0, 101%, 0)" },
  { transform: "translate3d(0, 0%, 0)" },
];

const FILL_EXIT_KF: Keyframe[] = [
  { transform: "translate3d(0, 0%, 0)" },
  { transform: "translate3d(0, 101%, 0)" },
];

// ── Content jiggle keyframes ────────────────────────────────────────────────
// Text stays fully inside the button. Physics is baked into offset stops;
// the animation itself uses easing: "linear" so each stop lands precisely.
//
// Enter: fill sweeps up from below → content squishes down (compress) →
//        elastic rebound up → settles at rest.
// Exit:  fill pulls away downward → content lifts slightly (release) →
//        drops back → settles at rest.

const CONTENT_ENTER_KF: Keyframe[] = [
  { transform: "translateY(0%)    scaleY(1)", offset: 0 },
  { transform: "translateY(6%)    scaleY(0.88)", offset: 0.18 }, // fill arrives — compress
  { transform: "translateY(-5%)   scaleY(1.07)", offset: 0.45 }, // elastic spring up
  { transform: "translateY(2%)    scaleY(0.97)", offset: 0.65 }, // settle down
  { transform: "translateY(-1%)   scaleY(1.01)", offset: 0.82 }, // micro bounce
  { transform: "translateY(0%)    scaleY(1)", offset: 1 }, // rest
];

const CONTENT_EXIT_KF: Keyframe[] = [
  { transform: "translateY(0%)    scaleY(1)", offset: 0 },
  { transform: "translateY(-5%)   scaleY(1.06)", offset: 0.2 }, // fill recedes — lift
  { transform: "translateY(3%)    scaleY(0.95)", offset: 0.48 }, // drop back
  { transform: "translateY(-1.5%) scaleY(1.02)", offset: 0.7 }, // micro bounce
  { transform: "translateY(0%)    scaleY(1)", offset: 1 }, // rest
];

// ── Hook ────────────────────────────────────────────────────────────────────
export function useJellyHoverFill<
  H extends HTMLElement = HTMLButtonElement,
  F extends HTMLElement = HTMLSpanElement,
  C extends HTMLElement = HTMLSpanElement,
>({
  fillColor,
  enterDurationMs = 580,
  exitDurationMs = 420,
  disabled = false,
}: UseJellyHoverFillOptions): UseJellyHoverFillResult<H, F, C> {
  const hostRef = useRef<H | null>(null);
  const fillRef = useRef<F | null>(null);
  const contentRef = useRef<C | null>(null);
  const [hovered, setHovered] = useState(false);

  const fillAnimRef = useRef<Animation | null>(null);
  const contentAnimRef = useRef<Animation | null>(null);

  // Sync fill color imperatively — separate effect so a color-only change
  // doesn't tear down and re-attach the mouseenter/mouseleave listeners.
  useEffect(() => {
    const fill = fillRef.current;
    if (fill) fill.style.background = fillColor;
  }, [fillColor]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || disabled) return;

    const playFill = (
      kf: Keyframe[],
      duration: number,
      easing: string,
    ): void => {
      const fill = fillRef.current;
      if (!fill) return;
      fillAnimRef.current?.cancel();
      fillAnimRef.current = fill.animate(kf, {
        duration,
        easing,
        fill: "forwards",
      });
    };

    const playContent = (kf: Keyframe[], duration: number): void => {
      const el = contentRef.current;
      if (!el) return;
      contentAnimRef.current?.cancel();
      // "linear" easing — the multi-stop offsets carry the physics themselves.
      contentAnimRef.current = el.animate(kf, {
        duration,
        easing: "linear",
        fill: "forwards",
      });
    };

    const handleEnter = (): void => {
      setHovered(true);
      playFill(FILL_ENTER_KF, enterDurationMs, ENTER_EASING);
      playContent(CONTENT_ENTER_KF, enterDurationMs);
    };

    const handleLeave = (): void => {
      setHovered(false);
      playFill(FILL_EXIT_KF, exitDurationMs, EXIT_EASING);
      playContent(CONTENT_EXIT_KF, exitDurationMs);
    };

    host.addEventListener("mouseenter", handleEnter);
    host.addEventListener("mouseleave", handleLeave);

    return () => {
      host.removeEventListener("mouseenter", handleEnter);
      host.removeEventListener("mouseleave", handleLeave);
      fillAnimRef.current?.cancel();
      contentAnimRef.current?.cancel();
    };
  }, [disabled, enterDurationMs, exitDurationMs]);

  return {
    hostRef,
    fillRef,
    contentRef,
    hovered: disabled ? false : hovered,
  };
}
