// hooks/useCardHover.ts
// ─────────────────────────────────────────────────────────────────────────────
// Lightweight card hover — scale + tilt only. No glow, no overlays.
// Drop { state, handlers } onto any card for app-wide consistency.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useRef, useState } from "react";

export interface CardHoverState {
  isHovered: boolean;
  isPressed: boolean;
  /** CSS transform string — apply directly to the card element */
  transform: string;
}

export interface CardHoverHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
  onMouseDown: () => void;
  onMouseUp: () => void;
}

export interface UseCardHoverOptions {
  /** Max tilt in degrees — default 15 */
  maxTilt?: number;
  /** Scale factor on hover — default 1.06 */
  hoverScale?: number;
  /** Scale factor when pressed — default 0.97 */
  pressScale?: number;
}

export function useCardHover(opts: UseCardHoverOptions = {}) {
  const { maxTilt = 15, hoverScale = 1.06, pressScale = 0.97 } = opts;

  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const [tiltX, setTiltX] = useState(0); // rotateX
  const [tiltY, setTiltY] = useState(0); // rotateY

  const rafRef = useRef<number | null>(null);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width; // 0 → 1
      const ny = (e.clientY - rect.top) / rect.height; // 0 → 1

      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        setTiltY((nx - 0.5) * maxTilt * 2); // left ↔ right tilt
        setTiltX((ny - 0.5) * -maxTilt * 2); // top  ↕ bottom tilt
      });
    },
    [maxTilt],
  );

  const transform = isPressed
    ? `perspective(300px) scale(${pressScale})`
    : isHovered
      ? `perspective(300px) scale(${hoverScale}) rotateX(${tiltX}deg) rotateY(${tiltY}deg)`
      : "perspective(300px) scale(1)";

  const state: CardHoverState = { isHovered, isPressed, transform };

  const handlers: CardHoverHandlers = {
    onMouseEnter: () => setIsHovered(true),
    onMouseLeave: () => {
      setIsHovered(false);
      setIsPressed(false);
      setTiltX(0);
      setTiltY(0);
    },
    onMouseMove,
    onMouseDown: () => setIsPressed(true),
    onMouseUp: () => setIsPressed(false),
  };

  return { state, handlers };
}
