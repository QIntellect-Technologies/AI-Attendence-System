import React from "react";
import { GitBranch, Trash2 } from "lucide-react";

/**
 * Shared presentational primitives for the Client Dashboard Settings page
 * (colors, form/button styling, cards, branch tabs, chip lists).
 *
 * Extracted out of Settings.tsx so other Settings-area screens (e.g.
 * DepartmentDesignationEditor) can reuse the exact same design system
 * instead of duplicating it. Settings.tsx imports these back rather than
 * defining them locally — do not redefine any of this in Settings.tsx.
 *
 * This file must not import from Settings.tsx or any of its sibling
 * screens: it sits below them in the dependency graph so nothing here can
 * create a circular import.
 */

export const C = {
  primary: "#1a699f",
  primaryDark: "#155580",
  bg: "#eef8fc",
  card: "#ffffff",
  border: "#dbe8f0",
  text: "#0f172a",
  textSub: "#475569",
  textMuted: "#94a3b8",
  danger: "#dc2626",
  success: "#16a34a",
  tealPale: "#f0f8fc",
  tealLight: "#e6f3f9",
} as const;

// UX-only guard; support_db_client_users.py's _validate_group_item_name (and
// the equivalent designation/department name validation) is the real
// boundary that stops an oversized paste from being persisted.
export const GROUP_NAME_MAX_LENGTH = 100;

export function cardStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    background: C.card,
    border: `1.5px solid ${C.border}`,
    borderRadius: 16,
    boxShadow: "0 8px 26px rgba(15,45,74,.07)",
    ...extra,
  };
}

export function inputStyle(extra?: React.CSSProperties): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 42,
    border: `1.5px solid ${C.border}`,
    borderRadius: 10,
    background: C.card,
    padding: "0 12px",
    fontFamily: "inherit",
    fontSize: 13,
    color: C.text,
    outline: "none",
    ...extra,
  };
}

export function buttonStyle(
  variant: "primary" | "secondary" | "danger" = "primary",
): React.CSSProperties {
  const primary = variant === "primary";
  const danger = variant === "danger";
  return {
    minHeight: 42,
    border: primary || danger ? "none" : `1.5px solid ${C.border}`,
    borderRadius: 10,
    padding: "0 14px",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    background: danger ? C.danger : primary ? C.primary : C.card,
    color: primary || danger ? "#fff" : C.textSub,
    fontSize: 13,
    fontWeight: 900,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };
}

export function sectionTitle(): React.CSSProperties {
  return {
    margin: 0,
    fontSize: 12,
    color: C.primaryDark,
    fontWeight: 950,
    textTransform: "uppercase",
    letterSpacing: ".08em",
  };
}

export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "grid", gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          color: C.textSub,
          fontWeight: 850,
          textTransform: "uppercase",
          letterSpacing: ".05em",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

export function BranchTabs({
  branches,
  activeBranchId,
  onChange,
  hideTabs,
}: {
  branches: { id: string; name: string }[];
  activeBranchId: string;
  onChange: (branchId: string) => void;
  hideTabs?: boolean;
}) {
  if (hideTabs || !branches || branches.length <= 1) {
    return null;
  }

  return (
    <div
      style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 18 }}
    >
      {branches.map((branch) => {
        const active = branch.id === activeBranchId;
        return (
          <button
            key={branch.id}
            type="button"
            onClick={() => onChange(branch.id)}
            style={{
              ...buttonStyle("secondary"),
              borderColor: active ? C.primary : C.border,
              background: active ? C.tealLight : C.card,
              color: active ? C.primaryDark : C.textSub,
              minHeight: 34,
            }}
          >
            <GitBranch size={13} /> {branch.name}
          </button>
        );
      })}
    </div>
  );
}

export function ConfigCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={cardStyle({ padding: 18 })}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 16,
        }}
      >
        <span style={{ color: C.primary }}>{icon}</span>
        <h2 style={sectionTitle()}>{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function ReadOnlyLine({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        background: C.tealPale,
        border: `1px solid ${C.border}`,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 850,
          color: C.textSub,
          textTransform: "uppercase",
          letterSpacing: ".05em",
        }}
      >
        {label}
      </div>
      <div
        style={{ fontSize: 14, fontWeight: 900, color: C.text, marginTop: 4 }}
      >
        {value}
      </div>
    </div>
  );
}

export function EmptyText({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 13,
        color: C.textMuted,
        fontStyle: "italic",
        padding: "10px 0",
      }}
    >
      {text}
    </div>
  );
}

/**
 * Pill/chip list. `onRemove` is always required (every existing usage lets
 * the user delete an item). `onSelect` + `isSelected` are optional additions
 * so a chip can also act as a single-select control (e.g. "which department
 * am I currently editing designations for") without changing how any
 * existing caller renders — omit them and a chip behaves exactly as before.
 */
export function ChipList<T extends { id: string; name: string }>({
  items,
  empty,
  onRemove,
  onSelect,
  isSelected,
  disabled,
}: {
  items: T[];
  empty: string;
  onRemove: (id: string) => void;
  onSelect?: (id: string) => void;
  isSelected?: (item: T) => boolean;
  disabled?: boolean;
}) {
  if (!items.length) return <EmptyText text={empty} />;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 9 }}>
      {items.map((item) => {
        const selected = isSelected?.(item) ?? false;
        return (
          <span
            key={item.id}
            onClick={onSelect ? () => onSelect(item.id) : undefined}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 11px",
              borderRadius: 999,
              background: selected ? C.primary : C.tealPale,
              border: `1px solid ${selected ? C.primary : C.border}`,
              color: selected ? "#fff" : C.primaryDark,
              fontSize: 13,
              fontWeight: 800,
              cursor: onSelect ? "pointer" : "default",
            }}
          >
            {item.name}
            <button
              type="button"
              aria-label={`Remove ${item.name}`}
              onClick={(event) => {
                event.stopPropagation();
                if (!disabled) onRemove(item.id);
              }}
              disabled={disabled}
              style={{
                border: "none",
                background: "transparent",
                color: selected ? "rgba(255,255,255,.85)" : C.textMuted,
                cursor: disabled ? "default" : "pointer",
                display: "grid",
                placeItems: "center",
              }}
            >
              <Trash2 size={13} />
            </button>
          </span>
        );
      })}
    </div>
  );
}
