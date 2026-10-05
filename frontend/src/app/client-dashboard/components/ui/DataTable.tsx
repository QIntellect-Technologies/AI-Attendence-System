/**
 * DataTable.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Unified table design system for the SK Embroidery dashboard.
 *
 * Exports:
 *   DataTable          – scroll-safe wrapper (card border + overflow scroll)
 *   DataTableHeader    – <th> with optional sort chevrons
 *   DataTableRow       – <tr> with hover/highlight/selected states
 *   DataTableCell      – <td> with alignment + font helpers
 *   DataTableBadge     – status pill (success/warning/danger/info/neutral/navy)
 *   DataTableActionBtn – small icon action button
 *   DataTableLoading   – shimmer skeleton rows
 *   DataTableEmpty     – centered empty-state cell
 *   TableAvatar        – name + avatar combo cell
 *   TABLE_THEME        – shared design tokens
 *   TABLE_TH_STYLE     – raw th CSSProperties object
 *   TABLE_TD_STYLE     – raw td CSSProperties object
 */

import React, { type FC, type ReactNode, useState } from "react";
import { ChevronUp, ChevronDown } from "lucide-react";

// ─── Design Tokens ────────────────────────────────────────────────────────────

export const TABLE_THEME = {
  bgCard: "#ffffff",
  bgPage: "#f5f6fa",
  bgHead: "#f3f7fb",
  bgHover: "#f8fcfd",
  bgHighlight: "#fff7ed",
  navy700: "#173f67",
  navy600: "#1f5b86",
  teal600: "#118d97",
  teal200: "#b9e2e7",
  teal100: "#e2f3f6",
  teal50: "#eef9fb",
  textHeading: "#102a3f",
  textBody: "#3f556c",
  textMuted: "#6b7d8f",
  textLight: "#94a3b8",
  green600: "#16a34a",
  green50: "#f0fdf4",
  green100: "#dcfce7",
  amber600: "#d97706",
  amber50: "#fffbeb",
  amber100: "#fef3c7",
  red600: "#e11d48",
  red50: "#fff1f2",
  red100: "#ffe4e6",
  border: "#d2dce4",
  borderSubtle: "#eaf0f5",
  shadow: "0 1px 3px rgba(15,45,74,0.06), 0 1px 2px rgba(15,45,74,0.04)",
  fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
} as const;

// ─── Shared style helpers ─────────────────────────────────────────────────────

export const TABLE_TH_STYLE: React.CSSProperties = {
  padding: "11px 16px",
  fontSize: 10,
  fontWeight: 900,
  color: TABLE_THEME.textMuted,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  background: TABLE_THEME.bgHead,
  borderBottom: `1px solid ${TABLE_THEME.border}`,
  whiteSpace: "nowrap",
  userSelect: "none",
  fontFamily: TABLE_THEME.fontFamily,
};

export const TABLE_TD_STYLE: React.CSSProperties = {
  padding: "12px 16px",
  fontSize: 13,
  color: TABLE_THEME.textBody,
  borderBottom: `1px solid ${TABLE_THEME.borderSubtle}`,
  verticalAlign: "middle",
  fontFamily: TABLE_THEME.fontFamily,
};

// ─── DataTableHeader ─────────────────────────────────────────────────────────

export interface DataTableHeaderProps {
  label: ReactNode;
  align?: "left" | "center" | "right";
  sortable?: boolean;
  sortDir?: "asc" | "desc" | null;
  onSort?: () => void;
  style?: React.CSSProperties;
}

export const DataTableHeader: FC<DataTableHeaderProps> = ({
  label,
  align = "left",
  sortable = false,
  sortDir = null,
  onSort,
  style,
}) => (
  <th
    onClick={sortable && onSort ? onSort : undefined}
    style={{
      ...TABLE_TH_STYLE,
      textAlign: align,
      cursor: sortable ? "pointer" : "default",
      ...style,
    }}
  >
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        justifyContent:
          align === "right"
            ? "flex-end"
            : align === "center"
              ? "center"
              : "flex-start",
        width: "100%",
      }}
    >
      {label}
      {sortable && (
        <span
          style={{
            display: "inline-flex",
            flexDirection: "column",
            gap: 0,
            opacity: sortDir ? 1 : 0.35,
            marginLeft: 2,
          }}
        >
          <ChevronUp
            size={9}
            color={
              sortDir === "asc"
                ? TABLE_THEME.teal600
                : TABLE_THEME.textMuted
            }
            strokeWidth={3}
          />
          <ChevronDown
            size={9}
            color={
              sortDir === "desc"
                ? TABLE_THEME.teal600
                : TABLE_THEME.textMuted
            }
            strokeWidth={3}
            style={{ marginTop: -3 }}
          />
        </span>
      )}
    </span>
  </th>
);

// ─── DataTableRow ─────────────────────────────────────────────────────────────

export interface DataTableRowProps {
  children: ReactNode;
  highlighted?: boolean;
  selected?: boolean;
  onClick?: () => void;
  style?: React.CSSProperties;
  className?: string;
  id?: string;
}

export const DataTableRow: FC<DataTableRowProps> = ({
  children,
  highlighted = false,
  selected = false,
  onClick,
  style,
  className,
  id,
}) => {
  const [hovered, setHovered] = useState(false);

  const bg = highlighted
    ? TABLE_THEME.bgHighlight
    : selected
      ? TABLE_THEME.teal50
      : hovered
        ? TABLE_THEME.bgHover
        : "transparent";

  const leftAccent = highlighted
    ? "inset 3px 0 0 #f97316"
    : selected
      ? `inset 3px 0 0 ${TABLE_THEME.teal600}`
      : "none";

  return (
    <tr
      id={id}
      className={className}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        background: bg,
        boxShadow: leftAccent,
        cursor: onClick ? "pointer" : "default",
        transition: "background 0.12s ease",
        ...style,
      }}
    >
      {children}
    </tr>
  );
};

// ─── DataTableCell ─────────────────────────────────────────────────────────────

export interface DataTableCellProps {
  children?: ReactNode;
  align?: "left" | "center" | "right";
  bold?: boolean;
  muted?: boolean;
  color?: string;
  nowrap?: boolean;
  style?: React.CSSProperties;
  title?: string;
  onClick?: (e: React.MouseEvent) => void;
  colSpan?: number;
}

export const DataTableCell: FC<DataTableCellProps> = ({
  children,
  align = "left",
  bold = false,
  muted = false,
  color,
  nowrap = false,
  style,
  title,
  onClick,
  colSpan,
}) => (
  <td
    title={title}
    onClick={onClick}
    colSpan={colSpan}
    style={{
      ...TABLE_TD_STYLE,
      textAlign: align,
      fontWeight: bold ? 700 : 500,
      color: color ?? (muted ? TABLE_THEME.textMuted : TABLE_THEME.textBody),
      whiteSpace: nowrap ? "nowrap" : undefined,
      ...style,
    }}
  >
    {children}
  </td>
);

// ─── DataTableBadge ───────────────────────────────────────────────────────────

type BadgeVariant =
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral"
  | "navy";

const BADGE_V: Record<BadgeVariant, { bg: string; color: string; border: string }> = {
  success: { bg: TABLE_THEME.green50, color: TABLE_THEME.green600, border: TABLE_THEME.green100 },
  warning: { bg: TABLE_THEME.amber50, color: TABLE_THEME.amber600, border: TABLE_THEME.amber100 },
  danger:  { bg: TABLE_THEME.red50,   color: TABLE_THEME.red600,   border: TABLE_THEME.red100   },
  info:    { bg: TABLE_THEME.teal50,  color: TABLE_THEME.teal600,  border: TABLE_THEME.teal100  },
  neutral: { bg: "#f8fafc",           color: TABLE_THEME.textMuted, border: TABLE_THEME.border  },
  navy:    { bg: "#f0f5fa",           color: TABLE_THEME.navy600,  border: "#c9dced"            },
};

export interface DataTableBadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  bg?: string;
  color?: string;
  border?: string;
  icon?: ReactNode;
}

export const DataTableBadge: FC<DataTableBadgeProps> = ({
  children,
  variant = "neutral",
  bg,
  color,
  border,
  icon,
}) => {
  const v = BADGE_V[variant];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.01em",
        background: bg ?? v.bg,
        color: color ?? v.color,
        border: `1px solid ${border ?? v.border}`,
        whiteSpace: "nowrap",
        fontFamily: TABLE_THEME.fontFamily,
      }}
    >
      {icon && (
        <span style={{ display: "flex", alignItems: "center" }}>{icon}</span>
      )}
      {children}
    </span>
  );
};

// ─── DataTableActionBtn ───────────────────────────────────────────────────────

export interface DataTableActionBtnProps {
  children?: ReactNode;
  icon?: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  disabled?: boolean;
  variant?: "default" | "danger" | "primary";
  "aria-label"?: string;
}

export const DataTableActionBtn: FC<DataTableActionBtnProps> = ({
  children,
  icon,
  onClick,
  title,
  disabled = false,
  variant = "default",
  "aria-label": ariaLabel,
}) => {
  const [hovered, setHovered] = useState(false);

  const s: Record<string, React.CSSProperties> = {
    default: {
      background: hovered ? TABLE_THEME.teal50 : "#fff",
      border: `1px solid ${hovered ? TABLE_THEME.teal200 : TABLE_THEME.border}`,
      color: hovered ? TABLE_THEME.teal600 : TABLE_THEME.textBody,
    },
    primary: {
      background: hovered ? TABLE_THEME.teal600 : TABLE_THEME.teal50,
      border: `1px solid ${TABLE_THEME.teal200}`,
      color: hovered ? "#fff" : TABLE_THEME.teal600,
    },
    danger: {
      background: hovered ? TABLE_THEME.red50 : "#fff",
      border: `1px solid ${hovered ? TABLE_THEME.red100 : TABLE_THEME.border}`,
      color: hovered ? TABLE_THEME.red600 : TABLE_THEME.textMuted,
    },
  };

  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...s[variant],
        borderRadius: 8,
        width: children ? undefined : 30,
        height: 30,
        minWidth: children ? undefined : 30,
        padding: children ? "0 10px" : 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: 12,
        fontWeight: 700,
        transition: "all 0.12s ease",
        fontFamily: TABLE_THEME.fontFamily,
      }}
    >
      {icon}
      {children}
    </button>
  );
};

// ─── DataTableLoading ─────────────────────────────────────────────────────────

export interface DataTableLoadingProps {
  colSpan: number;
  rows?: number;
  label?: string;
}

export const DataTableLoading: FC<DataTableLoadingProps> = ({
  colSpan,
  rows = 5,
  label = "Loading…",
}) => (
  <>
    {Array.from({ length: rows }).map((_, idx) => (
      <tr key={`sk-loading-${idx}`} style={{ opacity: 1 - idx * 0.12 }}>
        {Array.from({ length: colSpan }).map((__, ci) => (
          <td
            key={ci}
            style={{ ...TABLE_TD_STYLE, padding: "14px 16px" }}
          >
            <div
              style={{
                height: 11,
                width:
                  ci === 0 ? "38%" : ci === 1 ? "62%" : `${60 - ci * 8}%`,
                background:
                  "linear-gradient(90deg,#e8f0f5 25%,#f4f8fb 50%,#e8f0f5 75%)",
                backgroundSize: "200% 100%",
                borderRadius: 6,
                animation: "sk-shimmer 1.4s ease-in-out infinite",
                animationDelay: `${idx * 0.07}s`,
              }}
            />
          </td>
        ))}
      </tr>
    ))}
    <tr>
      <td
        colSpan={colSpan}
        style={{
          padding: "8px 16px 16px",
          textAlign: "center",
          fontSize: 12,
          color: TABLE_THEME.textLight,
          borderBottom: `1px solid ${TABLE_THEME.borderSubtle}`,
        }}
      >
        {label}
      </td>
    </tr>
  </>
);

// ─── DataTableEmpty ───────────────────────────────────────────────────────────

export interface DataTableEmptyProps {
  colSpan: number;
  icon?: ReactNode;
  title?: string;
  message?: string;
}

export const DataTableEmpty: FC<DataTableEmptyProps> = ({
  colSpan,
  icon,
  title = "No records found",
  message,
}) => (
  <tr>
    <td
      colSpan={colSpan}
      style={{
        padding: "52px 24px",
        textAlign: "center",
        borderBottom: `1px solid ${TABLE_THEME.borderSubtle}`,
      }}
    >
      {icon && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            marginBottom: 14,
            opacity: 0.2,
          }}
        >
          {icon}
        </div>
      )}
      <div
        style={{
          fontSize: 14,
          fontWeight: 700,
          color: TABLE_THEME.textMuted,
          marginBottom: message ? 6 : 0,
          fontFamily: TABLE_THEME.fontFamily,
        }}
      >
        {title}
      </div>
      {message && (
        <div
          style={{
            fontSize: 12,
            color: TABLE_THEME.textLight,
            fontFamily: TABLE_THEME.fontFamily,
          }}
        >
          {message}
        </div>
      )}
    </td>
  </tr>
);

// ─── DataTable wrapper ────────────────────────────────────────────────────────

export interface DataTableProps {
  style?: React.CSSProperties;
  head: ReactNode;
  children: ReactNode;
  minWidth?: number;
  caption?: string;
  radius?: number;
}

export const DataTable: FC<DataTableProps> = ({
  style,
  head,
  children,
  minWidth = 700,
  caption,
  radius = 12,
}) => (
  <div
    style={{
      background: TABLE_THEME.bgCard,
      border: `1px solid ${TABLE_THEME.border}`,
      borderRadius: radius,
      boxShadow: TABLE_THEME.shadow,
      overflow: "hidden",
      ...style,
    }}
  >
    <div style={{ overflowX: "auto" }}>
      <table
        style={{
          width: "100%",
          minWidth,
          borderCollapse: "collapse",
          fontFamily: TABLE_THEME.fontFamily,
          fontSize: 13,
        }}
      >
        {caption && (
          <caption style={{ display: "none" }}>{caption}</caption>
        )}
        <thead>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  </div>
);

// ─── TableAvatar ──────────────────────────────────────────────────────────────

export interface TableAvatarProps {
  name: string;
  src?: string | null;
  sub?: string | null;
}

export const TableAvatar: FC<TableAvatarProps> = ({ name, src, sub }) => {
  const initials = name
    .split(" ")
    .map((w) => w[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        minWidth: 0,
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          background: `linear-gradient(135deg, ${TABLE_THEME.teal600}, ${TABLE_THEME.navy600})`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 12,
          fontWeight: 800,
          color: "#fff",
          flexShrink: 0,
          overflow: "hidden",
        }}
      >
        {src ? (
          <img
            src={src}
            alt={name}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          initials
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: TABLE_THEME.textHeading,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        {sub && (
          <div
            style={{
              fontSize: 11,
              color: TABLE_THEME.textLight,
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        )}
      </div>
    </div>
  );
};
