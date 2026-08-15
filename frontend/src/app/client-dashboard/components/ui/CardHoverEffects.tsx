// components/shared/CardHoverEffects.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Pure overlay renderer — drop inside any card to get the full premium
// hover treatment (inner glow, cursor spotlight, shimmer sweep, floating dots).
// The ROTATING BORDER has been intentionally removed.
// ─────────────────────────────────────────────────────────────────────────────

import React from "react";
import { C } from "../../pages/onboarding/shared/wizardTheme";

interface CardHoverEffectsProps {
  isHovered: boolean;
  spotX: number;
  spotY: number;
  /** Override the accent color — defaults to C.primary */
  accentColor?: string;
}

const SPOT_SIZE = 250;

/** All hover overlay layers. Render as the first children of a `position:relative` card. */
const CardHoverEffects: React.FC<CardHoverEffectsProps> = ({
  isHovered,
  spotX,
  spotY,
  accentColor = C.primary,
}) => {
  if (!isHovered) return null;

  const hex = accentColor; // re-alias for readability

  return (
    <>
      {/* ── 1. Inner top-edge glow ─────────────────────────────────────── */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          background: `radial-gradient(circle at 50% 0%, ${hex}25, transparent 65%)`,
          opacity: 0.8,
          animation: "chGlowPulse 2.5s ease-in-out infinite",
          pointerEvents: "none",
          zIndex: 0,
        }}
      />

      {/* ── 2. Cursor-tracking spotlight ──────────────────────────────── */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          width: SPOT_SIZE,
          height: SPOT_SIZE,
          background: `radial-gradient(circle, ${hex}30, ${hex}10, transparent)`,
          borderRadius: "50%",
          left: spotX - SPOT_SIZE / 2,
          top: spotY - SPOT_SIZE / 2,
          pointerEvents: "none",
          filter: "blur(50px)",
          zIndex: 1,
          opacity: 0.7,
          // No transition so the spotlight tracks the cursor instantly
        }}
      />

      {/* ── 3. Shimmer sweep ──────────────────────────────────────────── */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "inherit",
          background:
            "linear-gradient(135deg, transparent 0%, rgba(255,255,255,.15) 50%, transparent 100%)",
          animation: "chShimmer 3.5s ease-in-out infinite",
          pointerEvents: "none",
          zIndex: 1,
        }}
      />

      {/* ── 4. Floating micro-particles ───────────────────────────────── */}
      <Particle top="10%" right="12%" size={3} opacity={0.6} delay="0s" />
      <Particle
        bottom="15%"
        left="10%"
        size={2}
        opacity={0.5}
        delay="0.5s"
        reverse
      />
      <Particle top="50%" right="8%" size={2.5} opacity={0.4} delay="1s" />
    </>
  );
};

// ── Tiny helper so particle JSX stays DRY ────────────────────────────────────
interface ParticleProps {
  top?: string;
  bottom?: string;
  left?: string;
  right?: string;
  size: number;
  opacity: number;
  delay: string;
  reverse?: boolean;
}

const Particle: React.FC<ParticleProps> = ({
  top,
  bottom,
  left,
  right,
  size,
  opacity,
  delay,
  reverse,
}) => (
  <div
    aria-hidden
    style={{
      position: "absolute",
      width: size,
      height: size,
      background: C.primary,
      borderRadius: "50%",
      top,
      bottom,
      left,
      right,
      opacity,
      animation: `chFloat 3s ease-in-out ${delay} infinite${reverse ? " reverse" : ""}`,
      zIndex: 1,
      pointerEvents: "none",
    }}
  />
);

// ── Global keyframes (inject once via a <style> tag in the root layout) ──────
export const CARD_HOVER_KEYFRAMES = `
  @keyframes chGlowPulse {
    0%, 100% { opacity: 0.6; transform: scale(1);    }
    50%       { opacity: 0.9; transform: scale(1.05); }
  }
  @keyframes chShimmer {
    0%   { transform: translateX(-100%); }
    100% { transform: translateX(200%);  }
  }
  @keyframes chFloat {
    0%, 100% { transform: translateY(0px);   opacity: 0.4; }
    50%       { transform: translateY(-12px); opacity: 0.8; }
  }
`;

export default CardHoverEffects;
