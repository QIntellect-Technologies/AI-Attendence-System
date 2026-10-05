/**
 * BranchSelector.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The dropdown panel is rendered via a React portal into `document.body`,
 * positioned with `position: fixed` viewport coordinates (useDropdownPosition)
 * instead of `position: absolute` inside this component's own DOM subtree.
 * See ModernSelect.tsx for the full rationale (stacking-context immunity).
 *
 * Anchoring: align "end" — the panel's right edge tracks the trigger's right
 * edge, growing leftward, since the panel (minWidth 220) can be wider than
 * the compact trigger button to fit full branch names.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MapPin, ChevronDown } from "lucide-react";
import { T } from "./theme";
import { Badge } from "./DashboardComponents";
import { useDropdownTransition } from "../../hooks/useDropdownTransition";
import { useDropdownPosition } from "../../hooks/useDropdownPosition";

export interface BranchSelectorOption {
  id: number;
  name: string;
  city: string;
}

export interface BranchSelectorProps {
  branches: BranchSelectorOption[];
  selected: BranchSelectorOption;
  onChange: (branch: BranchSelectorOption) => void;
}

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  branches,
  selected,
  onChange,
}) => {
  const [open, setOpen] = useState(false);
  // Wraps the button. Used for (a) measuring position, (b) outside-click
  // detection on the trigger side. The panel itself now lives in a portal,
  // so it's checked separately in the outside-click handler below.
  const triggerRef = useRef<HTMLDivElement>(null);
  const { shouldRender, panelRef, contentRef } = useDropdownTransition<
    HTMLDivElement,
    HTMLDivElement
  >(open);
  const position = useDropdownPosition(triggerRef, open, {
    align: "end",
    gap: 4,
    minWidth: 220,
  });

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedTrigger = triggerRef.current?.contains(target);
      // Panel is portaled to document.body — NOT a DOM descendant of
      // triggerRef — so it must be checked independently, or every click
      // on a branch row would register as "outside" and close the panel
      // out from under the click.
      const clickedPanel = panelRef.current?.contains(target);
      if (!clickedTrigger && !clickedPanel) setOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [panelRef]);

  return (
    <div ref={triggerRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          padding: "6px 12px",
          background: T.teal50,
          border: `1px solid ${open ? T.teal600 : T.border}`,
          borderRadius: 9,
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 600,
          color: T.head,
          fontFamily: "inherit",
          transition: "border-color .15s",
          boxShadow: open ? `0 0 0 3px ${T.teal100}` : "none",
        }}
      >
        <MapPin size={12} color={T.teal600} strokeWidth={2} />
        {selected.name}
        {selected.city && (
          <span style={{ fontSize: 10, color: T.muted, fontWeight: 400 }}>
            · {selected.city}
          </span>
        )}
        <ChevronDown
          size={12}
          color={T.muted}
          style={{
            marginLeft: 2,
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform .2s",
          }}
        />
      </button>

      {shouldRender &&
        position &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            style={{
              position: "fixed",
              top: position.top,
              right: position.right,
              minWidth: position.minWidth,
              zIndex: 100,
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              boxShadow: "0 8px 24px rgba(0,0,0,0.1)",
              // overflow + height are owned imperatively by useDropdownTransition
            }}
          >
            <div ref={contentRef}>
              <div
                data-dropdown-row
                style={{
                  padding: "7px 12px",
                  borderBottom: `1px solid ${T.teal50}`,
                  fontSize: 10,
                  fontWeight: 700,
                  color: T.muted,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                }}
              >
                Switch Branch
              </div>

              {branches.map((b) => {
                const sel = b.id === selected.id;
                return (
                  <div
                    key={b.id}
                    data-dropdown-row
                    onClick={() => {
                      onChange(b);
                      setOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 14px",
                      cursor: "pointer",
                      background: sel ? T.teal100 : "transparent",
                      borderLeft: `3px solid ${sel ? T.teal600 : "transparent"}`,
                      transition: "background .1s",
                    }}
                    onMouseEnter={(e) => {
                      if (!sel)
                        (e.currentTarget as HTMLDivElement).style.background =
                          T.teal50;
                    }}
                    onMouseLeave={(e) => {
                      if (!sel)
                        (e.currentTarget as HTMLDivElement).style.background =
                          "transparent";
                    }}
                  >
                    <div
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: sel ? T.teal600 : T.muted,
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: sel ? 700 : 500,
                          color: sel ? T.teal700 : T.head,
                        }}
                      >
                        {b.name}
                      </div>
                      {b.city && (
                        <div style={{ fontSize: 10, color: T.muted }}>
                          {b.city}
                        </div>
                      )}
                    </div>
                    {sel && <Badge variant="teal">Active</Badge>}
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default BranchSelector;
