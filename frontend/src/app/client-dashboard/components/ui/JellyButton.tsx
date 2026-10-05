/**
 * JellyButton.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Generic animated button built on useJellyHoverFill.
 * Covers every button use-case in the dashboard: primary, secondary, ghost,
 * danger, icon-only. Specialized wrappers (ExportCsvButton, etc.) sit on top
 * of this — they own domain logic; this owns animation + visual design.
 *
 * Design system tokens mirror the existing T (theme) object:
 *   teal-600  → primary fill / icon accent
 *   slate-700 → secondary text
 *   red-600   → danger fill
 *   All transitions GPU-composited via useJellyHoverFill (transform only).
 *
 * ── Quick usage ─────────────────────────────────────────────────────────────
 *
 *   // Primary (teal fill on hover)
 *   <JellyButton variant="primary" onClick={save}>Save</JellyButton>
 *
 *   // Secondary (slate fill on hover)
 *   <JellyButton variant="secondary" leftIcon={<RefreshCw size={14} />}
 *                onClick={refresh} loading={refreshing}>Refresh</JellyButton>
 *
 *   // Danger
 *   <JellyButton variant="danger" leftIcon={<Trash2 size={14} />}>Delete</JellyButton>
 *
 *   // Ghost (transparent, border only)
 *   <JellyButton variant="ghost" leftIcon={<Download size={14} />}>Export</JellyButton>
 *
 *   // Icon-only (square, no label)
 *   <JellyButton variant="primary" iconOnly leftIcon={<Plus size={16} />} aria-label="Add" />
 *
 *   // As a link
 *   <JellyButton as="a" href="/admin/settings" variant="ghost">Settings</JellyButton>
 *
 * ── Props ───────────────────────────────────────────────────────────────────
 *   variant        → "primary" | "secondary" | "ghost" | "danger" | "success"
 *   size           → "sm" | "md" | "lg"  (default: "md")
 *   leftIcon       → ReactNode rendered before the label
 *   rightIcon      → ReactNode rendered after the label
 *   iconOnly       → removes padding asymmetry, renders square
 *   loading        → shows spinner, disables interaction
 *   fullWidth      → width: 100%
 *   as             → "button" | "a" (renders an anchor with href)
 *   fillColor      → override the hover fill color
 *   All native button / anchor attributes are forwarded.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useMemo } from "react";
import {
  useJellyHoverFill,
  JELLY_HOST_BASE_STYLE,
  JELLY_FILL_BASE_STYLE,
  JELLY_CONTENT_BASE_STYLE,
  type UseJellyHoverFillOptions,
} from "../../hooks/useJellyHoverFill";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// Keep these in sync with T (theme.ts). Inlined here so JellyButton can be
// imported by files that don't have direct access to the T object.
// ─────────────────────────────────────────────────────────────────────────────

const TOKENS = {
  // Fill colors (the sweeping layer)
  fillPrimary: "#0d9488", // teal-600
  fillNavy: "#173f67",
  fillSecondary: "#334155", // slate-700
  fillDanger: "#dc2626", // red-600
  fillSuccess: "#16a34a", // green-600
  fillGhost: "#0d9488", // teal-600 (ghost hover fills teal too)

  // Resting background
  bgPrimary: "#0d9488",
  bgSecondary: "#ffffff",
  bgDanger: "#dc2626",
  bgSuccess: "#16a34a",
  bgGhost: "#ffffff",

  // Resting text / icon (before hover)
  textOnPrimary: "#ffffff",
  textOnSecondary: "#334155",
  textOnDanger: "#ffffff",
  textOnSuccess: "#ffffff",
  textOnGhost: "#0d9488",

  // Hovered text / icon (after fill sweeps in)
  textHoveredPrimary: "#ffffff",
  textHoveredSecondary: "#ffffff",
  textHoveredDanger: "#ffffff",
  textHoveredSuccess: "#ffffff",
  textHoveredGhost: "#ffffff",

  // Borders
  borderPrimary: "transparent",
  borderSecondary: "#cbd5e1",
  borderDanger: "transparent",
  borderSuccess: "transparent",
  borderGhost: "#cbd5e1",

  transition: "color 180ms ease-out",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// SIZE TOKENS
// ─────────────────────────────────────────────────────────────────────────────

const SIZE = {
  sm: {
    padding: "6px 12px",
    paddingIconOnly: "6px",
    fontSize: 12,
    iconSize: 13,
    borderRadius: 8,
    gap: 6,
    spinnerSize: 12,
  },
  md: {
    padding: "9px 16px",
    paddingIconOnly: "9px",
    fontSize: 13,
    iconSize: 15,
    borderRadius: 9,
    gap: 8,
    spinnerSize: 14,
  },
  lg: {
    padding: "12px 22px",
    paddingIconOnly: "12px",
    fontSize: 14,
    iconSize: 17,
    borderRadius: 10,
    gap: 10,
    spinnerSize: 16,
  },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type JellyButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "danger"
  | "success";

export type JellyButtonSize = "sm" | "md" | "lg";

/** Props shared by both button and anchor renders. */
interface JellyButtonBaseProps {
  variant?: JellyButtonVariant;
  size?: JellyButtonSize;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  /** Square layout; padding becomes uniform. No label needed (use aria-label). */
  iconOnly?: boolean;
  /** Shows a spinner, blocks interaction. */
  loading?: boolean;
  /** Expand to container width. */
  fullWidth?: boolean;
  /** Override the hover fill color. Defaults to the variant's fill. */
  fillColor?: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/** Button-specific props. */
export type JellyButtonAsButton = JellyButtonBaseProps & {
  as?: "button";
} & Omit<
    React.ButtonHTMLAttributes<HTMLButtonElement>,
    keyof JellyButtonBaseProps | "as"
  >;

/** Anchor-specific props. */
export type JellyButtonAsAnchor = JellyButtonBaseProps & {
  as: "a";
  href: string;
} & Omit<
    React.AnchorHTMLAttributes<HTMLAnchorElement>,
    keyof JellyButtonBaseProps | "as"
  >;

export type JellyButtonProps = JellyButtonAsButton | JellyButtonAsAnchor;

// ─────────────────────────────────────────────────────────────────────────────
// LOADING SPINNER
// Inline SVG — no dependency, no layout shift, GPU-composited rotation.
// ─────────────────────────────────────────────────────────────────────────────

const SpinnerStyle: React.CSSProperties = {
  display: "inline-block",
  animation: "jellySpinner 700ms linear infinite",
  flexShrink: 0,
};

// Inject the keyframe once globally (idempotent guard via dataset attribute).
function ensureSpinnerKeyframe(): void {
  if (document.querySelector("[data-jelly-spinner-kf]")) return;
  const style = document.createElement("style");
  style.dataset["jellySpinnerKf"] = "1";
  style.textContent = `
    @keyframes jellySpinner {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}

interface SpinnerProps {
  size: number;
  color: string;
}

const Spinner: React.FC<SpinnerProps> = ({ size, color }) => {
  // Inject once on first mount of any Spinner.
  React.useEffect(() => {
    ensureSpinnerKeyframe();
  }, []);

  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      style={SpinnerStyle}
    >
      <circle
        cx="8"
        cy="8"
        r="6"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray="28"
        strokeDashoffset="10"
        opacity="0.9"
      />
    </svg>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// VARIANT HELPERS  (pure, memoisation-friendly)
// ─────────────────────────────────────────────────────────────────────────────

function variantFillColor(
  variant: JellyButtonVariant,
  override?: string,
): string {
  if (override) return override;
  const map: Record<JellyButtonVariant, string> = {
    primary: TOKENS.fillPrimary,
    secondary: TOKENS.fillSecondary,
    danger: TOKENS.fillDanger,
    success: TOKENS.fillSuccess,
    ghost: TOKENS.fillGhost,
  };
  return map[variant];
}

interface VariantColors {
  bg: string;
  border: string;
  textIdle: string;
  textHovered: string;
}

function variantColors(variant: JellyButtonVariant): VariantColors {
  const map: Record<JellyButtonVariant, VariantColors> = {
    primary: {
      bg: TOKENS.bgPrimary,
      border: TOKENS.borderPrimary,
      textIdle: TOKENS.textOnPrimary,
      textHovered: TOKENS.textHoveredPrimary,
    },
    secondary: {
      bg: TOKENS.bgSecondary,
      border: TOKENS.borderSecondary,
      textIdle: TOKENS.textOnSecondary,
      textHovered: TOKENS.textHoveredSecondary,
    },
    ghost: {
      bg: TOKENS.bgGhost,
      border: TOKENS.borderGhost,
      textIdle: TOKENS.textOnGhost,
      textHovered: TOKENS.textHoveredGhost,
    },
    danger: {
      bg: TOKENS.bgDanger,
      border: TOKENS.borderDanger,
      textIdle: TOKENS.textOnDanger,
      textHovered: TOKENS.textHoveredDanger,
    },
    success: {
      bg: TOKENS.bgSuccess,
      border: TOKENS.borderSuccess,
      textIdle: TOKENS.textOnSuccess,
      textHovered: TOKENS.textHoveredSuccess,
    },
  };
  return map[variant];
}

// ─────────────────────────────────────────────────────────────────────────────
// ICON WRAPPER
// Clones a ReactElement icon to inject size + color props if it exposes them
// (Lucide icons do). Falls back to wrapping in a styled span for any ReactNode.
// ─────────────────────────────────────────────────────────────────────────────

interface IconWrapProps {
  icon: React.ReactNode;
  size: number;
  color: string;
}

const IconWrap: React.FC<IconWrapProps> = ({ icon, size, color }) => {
  // If icon is a valid React element with props we can clone (e.g. Lucide),
  // inject size + color so callers don't have to specify them.
  if (React.isValidElement<{ size?: number; color?: string }>(icon)) {
    return React.cloneElement(icon, { size, color });
  }
  // Otherwise wrap in a span with forced dimensions.
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        color,
        flexShrink: 0,
      }}
    >
      {icon}
    </span>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JellyButton — animated button for every use-case in the dashboard.
 * Uses a discriminated union on `as` so TypeScript enforces the correct
 * native attributes (button vs anchor) at the call site.
 */
export const JellyButton = React.forwardRef<
  HTMLButtonElement | HTMLAnchorElement,
  JellyButtonProps
>(function JellyButton(props, forwardedRef) {
  const {
    variant = "secondary",
    size = "md",
    leftIcon,
    rightIcon,
    iconOnly = false,
    loading = false,
    fullWidth = false,
    fillColor: fillColorOverride,
    className,
    style: styleProp,
    children,
    as = "button",
    ...rest
  } = props;

  // Determine disabled state (button disabled or loading).
  const nativeDisabled =
    as === "button"
      ? ((rest as React.ButtonHTMLAttributes<HTMLButtonElement>).disabled ??
        false)
      : false;
  const isDisabled = nativeDisabled || loading;

  // Animation hook
  const resolvedFillColor = useMemo(
    () => variantFillColor(variant, fillColorOverride),
    [variant, fillColorOverride],
  );

  const hookOptions = useMemo<UseJellyHoverFillOptions>(
    () => ({
      fillColor: resolvedFillColor,
      enterDurationMs: 520,
      exitDurationMs: 380,
      disabled: isDisabled,
    }),
    [resolvedFillColor, isDisabled],
  );

  // We type the refs broadly here; the hook's generic params handle specifics.
  const { hostRef, fillRef, contentRef, hovered } =
    useJellyHoverFill<HTMLButtonElement>(hookOptions);

  // Merge forwarded ref with hook ref using a callback ref
  const mergedRef = React.useCallback(
    (node: HTMLButtonElement | null) => {
      // Assign to hook's internal ref
      (hostRef as React.MutableRefObject<HTMLButtonElement | null>).current =
        node;
      // Forward to consumer's ref
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
      } else if (forwardedRef) {
        (
          forwardedRef as React.MutableRefObject<
            HTMLButtonElement | HTMLAnchorElement | null
          >
        ).current = node;
      }
    },
    [forwardedRef, hostRef],
  );

  const sz = SIZE[size];
  const colors = variantColors(variant);

  // ── Style composition ──────────────────────────────────────────────────────

  const hostStyle = useMemo<React.CSSProperties>(
    () => ({
      // Layout
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: sz.gap,
      width: fullWidth ? "100%" : undefined,

      // Size
      padding: iconOnly ? sz.paddingIconOnly : sz.padding,
      borderRadius: sz.borderRadius,
      fontSize: sz.fontSize,

      // Typography
      fontFamily: "inherit",
      fontWeight: 700,
      letterSpacing: "0.01em",
      lineHeight: 1,
      whiteSpace: "nowrap" as const,
      textDecoration: "none",

      // Visual
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      boxShadow:
        variant === "secondary" || variant === "ghost"
          ? "0 1px 3px rgba(15,45,74,0.07), 0 1px 2px rgba(15,45,74,0.04)"
          : "none",

      // Interaction
      cursor: isDisabled ? "not-allowed" : "pointer",
      userSelect: "none" as const,
      opacity: isDisabled ? 0.52 : 1,

      // Animation host requirements (position + overflow + isolation)
      ...JELLY_HOST_BASE_STYLE,

      // Consumer overrides last
      ...styleProp,
    }),
    [sz, fullWidth, iconOnly, colors, variant, isDisabled, styleProp],
  );

  const textColor = hovered ? colors.textHovered : colors.textIdle;
  const iconColor = textColor; // icon always matches text

  // ── Content rendering ──────────────────────────────────────────────────────

  const contentNode = (
    <>
      {/* Fill layer — must be first child so z-index stacking works */}
      <span ref={fillRef} style={JELLY_FILL_BASE_STYLE} />

      {/* Visible content */}
      <span ref={contentRef} style={JELLY_CONTENT_BASE_STYLE}>
        {loading ? (
          <Spinner size={sz.spinnerSize} color={iconColor} />
        ) : (
          <>
            {leftIcon && (
              <IconWrap icon={leftIcon} size={sz.iconSize} color={iconColor} />
            )}
            {!iconOnly && children && (
              <span
                style={{
                  color: textColor,
                  transition: TOKENS.transition,
                }}
              >
                {children}
              </span>
            )}
            {rightIcon && !iconOnly && (
              <IconWrap icon={rightIcon} size={sz.iconSize} color={iconColor} />
            )}
          </>
        )}
      </span>
    </>
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  if (as === "a") {
    const { href, ...anchorRest } = rest as JellyButtonAsAnchor;
    return (
      <a
        href={href}
        className={className}
        style={hostStyle}
        aria-disabled={isDisabled || undefined}
        {...anchorRest}
      >
        {contentNode}
      </a>
    );
  }

  const { disabled: _disabled, ...buttonRest } =
    rest as React.ButtonHTMLAttributes<HTMLButtonElement>;

  return (
    <button
      ref={mergedRef}
      type="button"
      className={className}
      style={hostStyle}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...buttonRest}
    >
      {contentNode}
    </button>
  );
});

JellyButton.displayName = "JellyButton";

export default JellyButton;
