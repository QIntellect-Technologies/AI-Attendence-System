import React from "react";
import type { LucideIcon } from "lucide-react";
import { T } from "../../components/ui/theme";
import JellyButton from "../../components/ui/JellyButton";

export interface ActionButtonProps {
  label: string;
  Icon?: LucideIcon | React.ElementType;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}

export const ActionButton: React.FC<ActionButtonProps> = ({
  label,
  Icon,
  onClick,
  variant = "primary",
  disabled = false,
}) => (
  <JellyButton
    type="button"
    variant={variant === "danger" ? "ghost" : variant}
    disabled={disabled}
    onClick={onClick}
    leftIcon={Icon ? <Icon size={14} /> : undefined}
    style={
      variant === "danger"
        ? {
            color: "#e11d48",
            borderColor: "#fecdd3",
            background: "#fff1f2",
          }
        : undefined
    }
  >
    {label}
  </JellyButton>
);

export interface EmptyStateProps {
  Icon?: LucideIcon | React.ElementType;
  title: string;
  sub?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  Icon,
  title,
  sub,
  action,
}) => (
  <div
    style={{
      minHeight: 260,
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      background: T.card,
      border: `1px solid ${T.border}`,
      borderRadius: 16,
      color: T.muted,
      textAlign: "center",
      padding: 24,
    }}
  >
    {Icon && (
      <span
        style={{
          width: 48,
          height: 48,
          borderRadius: 16,
          background: T.teal50,
          color: T.teal600,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon size={22} />
      </span>
    )}
    <div style={{ fontSize: 15, fontWeight: 900, color: T.head }}>{title}</div>
    {sub && <div style={{ fontSize: 12, maxWidth: 360 }}>{sub}</div>}
    {action && (
      <JellyButton type="button" variant="primary" onClick={action.onClick}>
        {action.label}
      </JellyButton>
    )}
  </div>
);

// ─── Loading skeleton ───────────────────────────────────────────────────────
// Added: ModuleRenderer.tsx already imports { LoadingSkeleton } from this
// file as its Suspense fallback body, but this file never defined or
// exported it — every lazy-loaded module's loading state was hitting an
// unresolved import. This is a plain, dependency-free skeleton so it needs
// nothing beyond the theme tokens already used elsewhere in this file.

const pulseKeyframes = `
@keyframes moduleShellSkeletonPulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}`;

export interface LoadingSkeletonProps {
  /** Number of placeholder rows to render. */
  rows?: number;
  /** Height of each row in px. */
  rowHeight?: number;
}

export const LoadingSkeleton: React.FC<LoadingSkeletonProps> = ({
  rows = 6,
  rowHeight = 18,
}) => (
  <div role="status" aria-label="Loading" style={{ display: "grid", gap: 12 }}>
    <style>{pulseKeyframes}</style>
    {Array.from({ length: rows }).map((_, index) => (
      <div
        key={index}
        style={{
          height: rowHeight,
          borderRadius: 8,
          background: T.teal100,
          // Slight width variation so the skeleton doesn't look like a
          // uniform, obviously-fake block — the last row of a run is
          // narrower, mirroring how real content (e.g. a table's last cell,
          // a paragraph's last line) commonly ends short.
          width: index === rows - 1 ? "70%" : "100%",
          animation: "moduleShellSkeletonPulse 1.4s ease-in-out infinite",
          animationDelay: `${index * 60}ms`,
        }}
      />
    ))}
  </div>
);

export interface ModuleShellProps {
  title: string;
  Icon?: LucideIcon | React.ElementType;
  total?: number | string;
  stats?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export const ModuleShell: React.FC<ModuleShellProps> = ({
  title,
  Icon,
  total,
  stats,
  actions,
  children,
}) => (
  <section style={{ display: "grid", gap: 16 }}>
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-start",
        gap: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {Icon && (
          <span
            style={{
              width: 38,
              height: 38,
              borderRadius: 14,

              color: T.teal600,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon
              className="h-6 w-6"
              strokeWidth={2.25}
              size={22}
              color={T.teal600}
            />
          </span>
        )}
        <div>
          <h1
            style={{
              margin: 0,
              color: T.textHeading,
              fontSize: 22,
              fontWeight: 900,
            }}
          >
            {title}
          </h1>
        </div>
      </div>
      {actions && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          {actions}
        </div>
      )}
    </header>
    {stats}
    {children}
  </section>
);

export default ModuleShell;
