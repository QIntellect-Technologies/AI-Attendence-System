import React, { useCallback, useEffect, useRef } from "react";
import { Rocket, Check } from "lucide-react";
import { C } from "./wizardTheme";

// ─── Types ────────────────────────────────────────────────────────────────────

type LaunchPhase = "idle" | "loading" | "success";

interface LaunchButtonProps {
  onClick: () => void;
  phase: LaunchPhase;
  disabled?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PARTICLE_COLORS = [
  "#5eead4",
  "#99f6e4",
  "#2dd4bf",
  "#a7f3d0",
  "#6ee7b7",
  "#ffffff",
];

const PARTICLE_COUNT = 18;

const PHASE_LABEL: Record<LaunchPhase, string> = {
  idle: "Launch",
  loading: "Launching…",
  success: "Launched!",
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  button: (phase: LaunchPhase): React.CSSProperties => ({
    position: "relative",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: "0 36px",
    height: 54,
    minWidth: 220,
    border: "none",
    borderRadius: 14,
    cursor: phase === "idle" ? "pointer" : "not-allowed",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "0.01em",
    background:
      phase === "success"
        ? "#059669"
        : phase === "loading"
          ? "#0f766e"
          : C.primary,
    color: "#fff",
    overflow: "hidden",
    outline: "none",
    transition:
      "background 0.25s ease, transform 0.18s ease, box-shadow 0.18s ease",
    transform: "translateY(0)",
  }),

  layer: (visible: boolean): React.CSSProperties => ({
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(8px)",
    transition: "opacity 0.2s ease, transform 0.2s ease",
    pointerEvents: "none",
  }),

  idleLayer: (visible: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    opacity: visible ? 1 : 0,
    transform: visible ? "translateY(0)" : "translateY(-8px)",
    transition: "opacity 0.2s ease, transform 0.2s ease",
  }),

  particles: {
    position: "absolute" as const,
    inset: 0,
    pointerEvents: "none" as const,
    overflow: "hidden",
    borderRadius: 14,
  },

  shimmer: {
    position: "absolute" as const,
    inset: 0,
    background:
      "linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.15) 50%, transparent 60%)",
    borderRadius: 14,
    pointerEvents: "none" as const,
  },

  spinner: {
    width: 18,
    height: 18,
    borderRadius: "50%",
    border: "2.5px solid rgba(255,255,255,0.3)",
    borderTopColor: "#fff",
    animation: "lbSpin 0.75s linear infinite",
  } as React.CSSProperties,
} as const;

// ─── Particle spawner ─────────────────────────────────────────────────────────

function spawnParticles(container: HTMLDivElement): void {
  container.innerHTML = "";

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const el = document.createElement("div");
    const size = 3 + Math.random() * 4;

    Object.assign(el.style, {
      position: "absolute",
      width: `${size}px`,
      height: `${size}px`,
      borderRadius: "50%",
      background:
        PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      left: `${10 + Math.random() * 80}%`,
      bottom: `${Math.random() * 30}%`,
      opacity: "0",
      animation: `lbBurst ${0.6 + Math.random() * 0.5}s ease-out ${Math.random() * 0.3}s forwards`,
    });

    container.appendChild(el);
  }
}

// ─── Keyframe injection (singleton) ──────────────────────────────────────────

let keyframesInjected = false;

function ensureKeyframes(): void {
  if (keyframesInjected) return;
  keyframesInjected = true;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes lbSpin   { to { transform: rotate(360deg); } }
    @keyframes lbBurst  { 0% { opacity: .9; transform: translateY(0) scale(1); } 100% { opacity: 0; transform: translateY(-60px) scale(.3); } }
    @keyframes lbShimmer{ 0% { transform: translateX(-100%); } 100% { transform: translateX(200%); } }
    .lb-btn:hover .lb-shimmer { animation: lbShimmer 0.6s ease forwards; }
    .lb-btn:hover:not(:disabled) { transform: translateY(-2px) !important; box-shadow: 0 8px 24px rgba(13,148,136,0.35) !important; }
    .lb-btn:active:not(:disabled) { transform: scale(0.97) !important; }
    .lb-rocket { transition: transform 0.3s ease; }
    .lb-btn:hover:not(:disabled) .lb-rocket { transform: translateY(-2px) rotate(-5deg); }
  `;
  document.head.appendChild(style);
}

// ─── Component ────────────────────────────────────────────────────────────────

const LaunchButton: React.FC<LaunchButtonProps> = ({
  onClick,
  phase,
  disabled = false,
}) => {
  const particlesRef = useRef<HTMLDivElement>(null);
  const prevPhaseRef = useRef<LaunchPhase>(phase);

  useEffect(() => {
    ensureKeyframes();
  }, []);

  useEffect(() => {
    if (
      phase === "loading" &&
      prevPhaseRef.current === "idle" &&
      particlesRef.current
    ) {
      spawnParticles(particlesRef.current);
    }
    prevPhaseRef.current = phase;
  }, [phase]);

  const handleClick = useCallback(() => {
    if (phase !== "idle" || disabled) return;
    onClick();
  }, [phase, disabled, onClick]);

  const isIdle = phase === "idle";
  const isLoading = phase === "loading";
  const isSuccess = phase === "success";

  return (
    <button
      className="lb-btn"
      style={styles.button(phase)}
      onClick={handleClick}
      disabled={phase !== "idle" || disabled}
      aria-label={PHASE_LABEL[phase]}
      aria-busy={isLoading}
    >
      {/* Shimmer */}
      <div className="lb-shimmer" style={styles.shimmer} aria-hidden="true" />

      {/* Particle container */}
      <div ref={particlesRef} style={styles.particles} aria-hidden="true" />

      {/* Idle state */}
      <div style={styles.idleLayer(isIdle)} aria-hidden={!isIdle}>
        <Rocket
          className="lb-rocket"
          size={18}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span>{PHASE_LABEL.idle}</span>
      </div>

      {/* Loading state */}
      <div style={styles.layer(isLoading)} aria-hidden={!isLoading}>
        <div style={styles.spinner} aria-hidden="true" />
        <span>{PHASE_LABEL.loading}</span>
      </div>

      {/* Success state */}
      <div style={styles.layer(isSuccess)} aria-hidden={!isSuccess}>
        <Check size={18} strokeWidth={2.5} aria-hidden="true" />
        <span>{PHASE_LABEL.success}</span>
      </div>
    </button>
  );
};

export default LaunchButton;
export type { LaunchPhase, LaunchButtonProps };
