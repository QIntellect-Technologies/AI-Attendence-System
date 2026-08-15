// components/shared/ContinueButton.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Reusable animated Continue button for all 7 wizard steps.
//
// States:
//   idle     → default, ready to click
//   loading  → async work in progress (spinner + label)
//   success  → async resolved (check + label, auto-advances)
//   disabled → step not complete yet (muted, not clickable)
//
// Usage:
//   <ContinueButton onClick={handleNext} />
//   <ContinueButton onClick={saveAsync} label="Save & Continue" />
//   <ContinueButton onClick={handleNext} disabled={!isStepComplete} />
//   <ContinueButton onClick={handleNext} loading />
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Loader2 } from "lucide-react";
import { C } from "../../pages/onboarding/shared/wizardTheme";

// ─── Types ────────────────────────────────────────────────────────────────────

type ButtonState = "idle" | "loading" | "success";

export interface ContinueButtonProps {
  /** Called on click. May return a Promise — button enters loading state automatically. */
  onClick: () => void | Promise<void>;
  /** Button label — default "Continue" */
  label?: string;
  /** Label shown during loading — default "Please wait…" */
  loadingLabel?: string;
  /** Label shown on success — default "Done!" */
  successLabel?: string;
  /** Disables the button (step not complete) */
  disabled?: boolean;
  /** Force loading state from parent */
  loading?: boolean;
  /** Step index 1-7 — shows subtle step indicator inside the button */
  step?: number;
  /** Total steps — default 7 */
  totalSteps?: number;
}

// ─── Keyframes (injected once) ────────────────────────────────────────────────

const KEYFRAMES = `
  @keyframes cb-shimmer {
    0%   { transform: translateX(-100%) skewX(-15deg); opacity: 0;   }
    10%  { opacity: 1; }
    100% { transform: translateX(300%)  skewX(-15deg); opacity: 0;   }
  }
  @keyframes cb-spin {
    to { transform: rotate(360deg); }
  }
  @keyframes cb-pop-in {
    0%   { transform: scale(0) rotate(-45deg); opacity: 0; }
    60%  { transform: scale(1.3) rotate(8deg); opacity: 1; }
    100% { transform: scale(1)   rotate(0deg); opacity: 1; }
  }
  @keyframes cb-slide-up {
    from { transform: translateY(8px);  opacity: 0; }
    to   { transform: translateY(0px);  opacity: 1; }
  }
  @keyframes cb-slide-down {
    from { transform: translateY(-8px); opacity: 0; }
    to   { transform: translateY(0px);  opacity: 1; }
  }
  @keyframes cb-progress {
    from { width: 0%; }
    to   { width: 100%; }
  }
  @keyframes cb-ripple {
    0%   { transform: scale(0); opacity: 0.4; }
    100% { transform: scale(4); opacity: 0;   }
  }
  @keyframes cb-arrow-bounce {
    0%, 100% { transform: translateX(0px);  }
    50%       { transform: translateX(4px); }
  }
  @keyframes cb-success-bg {
    from { background-position: 0% 50%;   }
    to   { background-position: 100% 50%; }
  }
`;

// ─── Ripple ───────────────────────────────────────────────────────────────────

interface RippleItem {
  id: number;
  x: number;
  y: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

let _keyframesInjected = false;

const ContinueButton: React.FC<ContinueButtonProps> = ({
  onClick,
  label = "Continue",
  loadingLabel = "Please wait…",
  successLabel = "Done!",
  disabled = false,
  loading = false,
  step,
  totalSteps = 7,
}) => {
  // Inject keyframes once globally
  if (!_keyframesInjected) {
    const style = document.createElement("style");
    style.textContent = KEYFRAMES;
    document.head.appendChild(style);
    _keyframesInjected = true;
  }

  const [btnState, setBtnState] = useState<ButtonState>("idle");
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  // Sync external loading prop
  useEffect(() => {
    if (loading) setBtnState("loading");
    else if (btnState === "loading") setBtnState("idle");
  }, [loading]);

  // ── Click handler ──────────────────────────────────────────────────────────
  const handleClick = useCallback(async () => {
    if (disabled || btnState !== "idle") return;

    try {
      const result = onClick();

      if (result instanceof Promise) {
        setBtnState("loading");
        await result;
      }

      // No fake success delay. Return to idle immediately.
      setBtnState("idle");
    } catch {
      setBtnState("idle");
    }
  }, [disabled, btnState, onClick]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const isLoading = btnState === "loading";
  const isSuccess = btnState === "success";
  const isIdle = btnState === "idle";
  const isActive = !disabled && isIdle;

  // ── Styles ─────────────────────────────────────────────────────────────────
  const bg = isSuccess
    ? `linear-gradient(135deg, #0e9f6e, #057a55)`
    : disabled
      ? "#cbd5e1"
      : `linear-gradient(135deg, ${C.primary} 0%, #155e8a 100%)`;

  const scale = isPressed && isActive ? 0.96 : isHovered && isActive ? 1.03 : 1;

  const boxShadow = disabled
    ? "none"
    : isSuccess
      ? "0 4px 20px rgba(5, 122, 85, .35), 0 1px 4px rgba(0,0,0,.08)"
      : isHovered && isActive
        ? `0 8px 28px rgba(26,105,159,.38), 0 2px 8px rgba(26,105,159,.2)`
        : `0 4px 14px rgba(26,105,159,.25), 0 1px 4px rgba(0,0,0,.06)`;

  const cursorStyle = disabled ? "not-allowed" : isLoading ? "wait" : "pointer";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
      }}
    >
      {/* ── Step indicator dots ─────────────────────────────────────────── */}
      {step !== undefined && (
        <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
          {Array.from({ length: totalSteps }, (_, i) => (
            <div
              key={i}
              style={{
                width: i + 1 === step ? 18 : 6,
                height: 6,
                borderRadius: 3,
                background: i + 1 <= step ? C.primary : "#e2e8f0",
                transition: "all 380ms cubic-bezier(0.34, 1.56, 0.64, 1)",
              }}
            />
          ))}
        </div>
      )}

      {/* ── Button ─────────────────────────────────────────────────────── */}
      <button
        ref={btnRef}
        onClick={handleClick}
        onMouseEnter={() => !disabled && setIsHovered(true)}
        onMouseLeave={() => {
          setIsHovered(false);
          setIsPressed(false);
        }}
        onMouseDown={() => !disabled && setIsPressed(true)}
        onMouseUp={() => setIsPressed(false)}
        disabled={disabled}
        style={{
          position: "relative",
          overflow: "hidden",
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "13px 28px",
          borderRadius: 12,
          border: "none",
          background: bg,
          color: disabled ? "#94a3b8" : "#fff",
          fontSize: 15,
          fontWeight: 700,
          fontFamily: "inherit",
          letterSpacing: 0.3,
          cursor: cursorStyle,
          transform: `scale(${scale})`,
          transition: [
            "transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)",
            "box-shadow 200ms ease-out",
            "background 300ms ease-out",
          ].join(", "),
          boxShadow,
          userSelect: "none",
          WebkitUserSelect: "none",
          outline: "none",
          minWidth: 160,
          justifyContent: "center",
        }}
      >
        {/* ── Shimmer sweep (idle + hovered only) ── */}
        {isHovered && isActive && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "40%",
              height: "100%",
              background:
                "linear-gradient(90deg, transparent, rgba(255,255,255,.22), transparent)",
              animation: "cb-shimmer 1.1s ease-in-out infinite",
              pointerEvents: "none",
            }}
          />
        )}

        {/* ── Progress bar (loading) ── */}
        {isLoading && (
          <span
            aria-hidden
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              height: 3,
              borderRadius: "0 0 12px 12px",
              background: "rgba(255,255,255,.5)",
              animation: "cb-progress 1.6s ease-in-out infinite",
            }}
          />
        )}

        {/* ── Icon ── */}
        <span
          aria-hidden
          style={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            animation: isLoading
              ? "cb-spin 900ms linear infinite"
              : isSuccess
                ? "cb-pop-in 500ms cubic-bezier(0.34, 1.56, 0.64, 1) forwards"
                : isHovered && isActive
                  ? "cb-arrow-bounce 700ms ease-in-out infinite"
                  : "none",
          }}
        >
          {isLoading ? (
            <Loader2 size={18} strokeWidth={2.5} />
          ) : isSuccess ? (
            <Check size={18} strokeWidth={3} />
          ) : (
            <ArrowRight size={18} strokeWidth={2.5} />
          )}
        </span>

        {/* ── Label ── */}
        <span
          key={btnState} // re-mounts on state change → triggers slide-up animation
          style={{
            animation: "cb-slide-up 220ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          }}
        >
          {isLoading ? loadingLabel : isSuccess ? successLabel : label}
        </span>
      </button>
    </div>
  );
};

// ─── BackButton ───────────────────────────────────────────────────────────────

export interface BackButtonProps {
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}

export const BackButton: React.FC<BackButtonProps> = ({
  onClick,
  label = "← Back",
  disabled = false,
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isPressed, setIsPressed] = useState(false);

  const handleClick = useCallback(() => {
    if (disabled) return;
    onClick();
  }, [disabled, onClick]);

  const isActive = !disabled;
  const scale = isPressed && isActive ? 0.96 : isHovered && isActive ? 1.03 : 1;

  return (
    <button
      onClick={handleClick}
      onMouseEnter={() => !disabled && setIsHovered(true)}
      onMouseLeave={() => {
        setIsHovered(false);
        setIsPressed(false);
      }}
      onMouseDown={() => !disabled && setIsPressed(true)}
      onMouseUp={() => setIsPressed(false)}
      disabled={disabled}
      style={{
        position: "relative",
        overflow: "hidden",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "13px 28px",
        borderRadius: 12,
        border: `1.5px solid ${isHovered && isActive ? "#cbd5e1" : "#e2e8f0"}`,
        background: isHovered && isActive ? "#f8fafc" : "#ffffff",
        color: disabled ? "#cbd5e1" : "#475569",
        fontSize: 15,
        fontWeight: 600,
        fontFamily: "inherit",
        letterSpacing: 0.2,
        cursor: disabled ? "not-allowed" : "pointer",
        transform: `scale(${scale})`,
        transition: [
          "transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1)",
          "box-shadow 200ms ease-out",
          "background 200ms ease-out",
          "border-color 200ms ease-out",
        ].join(", "),
        boxShadow: disabled
          ? "none"
          : isHovered && isActive
            ? "0 4px 14px rgba(0,0,0,.08), 0 1px 4px rgba(0,0,0,.04)"
            : "0 1px 4px rgba(0,0,0,.05)",
        userSelect: "none",
        WebkitUserSelect: "none",
        outline: "none",
        minWidth: 120,
        justifyContent: "center",
      }}
    >
      {/* Shimmer on hover */}
      {isHovered && isActive && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "40%",
            height: "100%",
            background:
              "linear-gradient(90deg, transparent, rgba(26,105,159,.06), transparent)",
            animation: "cb-shimmer 1.1s ease-in-out infinite",
            pointerEvents: "none",
          }}
        />
      )}

      {label}
    </button>
  );
};

export default ContinueButton;
