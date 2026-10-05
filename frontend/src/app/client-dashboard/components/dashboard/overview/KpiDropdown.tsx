/**
 * KpiDropdown.tsx
 * A floating department-breakdown panel that attaches below a KPI stat card.
 * Shows present/absent counts per department.
 */

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Building2 } from "lucide-react";
import { T } from "../../ui/theme";

const DEPT_COLORS = [
  "#0f766e",
  "#1a699f",
  "#7c3aed",
  "#d97706",
  "#e11d48",
  "#059669",
  "#6366f1",
  "#ea580c",
  "#0891b2",
  "#be185d",
];

export interface KpiDeptRow {
  name: string;
  count?: number;
  subtitle?: string;
  color: string;
}

interface KpiDropdownProps {
  rows: KpiDeptRow[];
  label: string;
  onNavigate?: () => void;
  triggerRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}

const KpiDropdown: React.FC<KpiDropdownProps> = ({
  rows,
  label,
  onNavigate,
  triggerRef,
  open,
  onClose,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 8,
      left: rect.left,
      width: Math.max(rect.width, 220),
    });
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const clickHandler = (e: MouseEvent) => {
      if (
        !panelRef.current?.contains(e.target as Node) &&
        !triggerRef.current?.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    
    // Close on any global scroll event to prevent floating detachment
    const scrollHandler = (e: Event) => {
      // Don't close if scrolling inside the panel itself
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };

    document.addEventListener("mousedown", clickHandler);
    // Use capture phase to catch scroll events on any scrollable container
    window.addEventListener("scroll", scrollHandler, { passive: true, capture: true });
    
    return () => {
      document.removeEventListener("mousedown", clickHandler);
      window.removeEventListener("scroll", scrollHandler, { capture: true });
    };
  }, [open, onClose, triggerRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: "fixed",
        top: pos.top,
        left: pos.left,
        width: pos.width,
        zIndex: 3000,
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        boxShadow: "0 18px 40px rgba(15,23,42,0.14), 0 4px 12px rgba(15,23,42,0.08)",
        overflow: "hidden",
        fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "10px 14px 8px",
          borderBottom: `1px solid ${T.border}`,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          color: T.muted,
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>

      {/* All Departments row */}
      <div
        style={{
          padding: "8px 10px",
          display: "flex",
          alignItems: "center",
          gap: 8,
          background: `${T.teal600}0d`,
          cursor: onNavigate ? "pointer" : "default",
        }}
        onClick={onNavigate}
        onMouseEnter={(e) => {
          if (onNavigate) e.currentTarget.style.background = `${T.teal600}20`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = `${T.teal600}0d`;
        }}
      >
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: `${T.teal600}1a`,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Building2 size={14} color={T.teal600} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: T.teal700, flex: 1 }}>
          All Departments
        </span>
      </div>

      {/* Department rows */}
      <div style={{ maxHeight: 220, overflowY: "auto", padding: "4px 6px" }}>
        {rows.length === 0 ? (
          <div
            style={{
              padding: "14px 10px",
              fontSize: 12,
              color: T.muted,
              textAlign: "center",
            }}
          >
            No department data
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row.name}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "7px 8px",
                borderRadius: 8,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = T.slate50;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = "transparent";
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: row.color,
                  flexShrink: 0,
                }}
              />
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "center",
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: T.head,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {row.name}
                </span>
                {row.subtitle && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: T.muted,
                      marginTop: -2,
                    }}
                  >
                    {row.subtitle}
                  </span>
                )}
              </div>
              {row.count !== undefined && (
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: T.muted,
                    background: T.slate50,
                    border: `1px solid ${T.border}`,
                    borderRadius: 20,
                    padding: "1px 8px",
                    flexShrink: 0,
                  }}
                >
                  {row.count}
                </span>
              )}
            </div>
          ))
        )}
      </div>

      {/* Footer */}
      {onNavigate && (
        <div
          onClick={onNavigate}
          style={{
            padding: "9px 14px",
            borderTop: `1px solid ${T.border}`,
            fontSize: 11,
            fontWeight: 700,
            color: T.teal600,
            cursor: "pointer",
            textAlign: "center",
            background: T.slate50,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = T.teal100;
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLDivElement).style.background = T.slate50;
          }}
        >
          View full attendance →
        </div>
      )}
    </div>,
    document.body,
  );
};

export { DEPT_COLORS };
export default KpiDropdown;
