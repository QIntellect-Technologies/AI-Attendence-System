/**
 * ModernSelect.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * The dropdown panel is rendered via a React portal into `document.body`,
 * positioned with `position: fixed` viewport coordinates (useDropdownPosition)
 * instead of `position: absolute` inside this component's own DOM subtree.
 *
 * Why: any ancestor anywhere in the app that sets a `transform` (even a
 * settled, at-rest `translateY(0)` left over from an entrance animation)
 * creates a new CSS stacking context. A non-positioned transformed ancestor
 * paints in an earlier layer than ANY sibling that has `position` set, no
 * matter how high the panel's own z-index is — so a panel nested inside such
 * an ancestor can end up stuck behind unrelated UI elsewhere on the page.
 * Portaling to <body> sidesteps this category of bug entirely, rather than
 * requiring every future ancestor in the app to avoid `transform`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { T } from "./theme";
import { useDropdownTransition } from "../../hooks/useDropdownTransition";
import { useDropdownPosition } from "../../hooks/useDropdownPosition";

export interface ModernSelectOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

export interface ModernSelectProps {
  value: string;
  options: ModernSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  width?: number | string;
  minWidth?: number | string;
  disabled?: boolean;
  leadingIcon?: React.ReactNode;
  zIndex?: number;
}

const controlBase: React.CSSProperties = {
  height: 36,
  border: `1px solid ${T.border}`,
  borderRadius: 12,
  background: T.card,
  color: T.head,
  fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
  fontSize: 12,
  fontWeight: 700,
  outline: "none",
  boxShadow: "0 1px 2px rgba(15,23,42,0.04)",
};

const menuShadow =
  "0 18px 40px rgba(15,23,42,0.14), 0 4px 12px rgba(15,23,42,0.08)";

const ModernSelect: React.FC<ModernSelectProps> = ({
  value,
  options,
  onChange,
  placeholder = "Select",
  ariaLabel,
  width = "auto",
  minWidth = 120,
  disabled = false,
  leadingIcon,
  zIndex = 2200,
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
    align: "start",
    gap: 8,
    matchTriggerWidth: true,
  });

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value),
    [options, value],
  );

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedTrigger = triggerRef.current?.contains(target);
      // Panel is portaled to document.body — NOT a DOM descendant of
      // triggerRef — so it must be checked independently, or every click
      // on an option would register as "outside" and close the panel out
      // from under the click.
      const clickedPanel = panelRef.current?.contains(target);
      if (!clickedTrigger && !clickedPanel) setOpen(false);
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [panelRef]);

  return (
    <div
      ref={triggerRef}
      style={{
        position: "relative",
        width,
        minWidth,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => !disabled && setOpen((prev) => !prev)}
        style={{
          ...controlBase,
          width: "100%",
          padding: "0 10px 0 12px",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          transition: "border-color .18s ease, box-shadow .18s ease",
          borderColor: open ? T.teal600 : T.border,
          boxShadow: open ? `0 0 0 4px ${T.teal50}` : controlBase.boxShadow,
        }}
      >
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
            flex: 1,
          }}
        >
          {leadingIcon && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: T.teal600,
                flexShrink: 0,
              }}
            >
              {leadingIcon}
            </span>
          )}
          {selectedOption?.icon && (
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: T.teal600,
                flexShrink: 0,
              }}
            >
              {selectedOption.icon}
            </span>
          )}
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: selectedOption ? T.head : T.muted,
            }}
          >
            {selectedOption?.label ?? placeholder}
          </span>
        </span>

        <ChevronDown
          size={14}
          color={T.muted}
          style={{
            transform: open ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform .18s ease",
            flexShrink: 0,
          }}
        />
      </button>

      {shouldRender &&
        position &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={panelRef}
            role="listbox"
            aria-label={ariaLabel}
            style={{
              position: "fixed",
              top: position.top,
              left: position.left,
              width: position.width,
              zIndex,
              background: T.card,
              border: `1px solid ${T.border}`,
              borderRadius: 14,
              boxShadow: menuShadow,
              // overflow + height are owned imperatively by useDropdownTransition
            }}
          >
            <div ref={contentRef} style={{ padding: 6 }}>
              <div
                style={{
                  maxHeight: 280,
                  overflowY: "auto",
                }}
              >
                {options.map((option) => {
                  const active = option.value === value;

                  return (
                    <button
                      key={option.value}
                      type="button"
                      data-dropdown-row
                      onClick={() => {
                        onChange(option.value);
                        setOpen(false);
                      }}
                      role="option"
                      aria-selected={active}
                      style={{
                        width: "100%",
                        border: "none",
                        background: active ? T.teal50 : "transparent",
                        borderRadius: 10,
                        padding: "10px 12px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "background .14s ease",
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = "#f8fafc";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = "transparent";
                        }
                      }}
                    >
                      <span
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          minWidth: 0,
                          flex: 1,
                        }}
                      >
                        {(option.icon || active) && (
                          <span
                            style={{
                              width: 24,
                              height: 24,
                              borderRadius: 8,
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              background: active ? T.teal100 : "#f8fafc",
                              color: active ? T.teal600 : T.muted,
                              flexShrink: 0,
                            }}
                          >
                            {option.icon ?? <Check size={13} />}
                          </span>
                        )}
                        <span style={{ minWidth: 0 }}>
                          <span
                            style={{
                              display: "block",
                              fontSize: 12,
                              fontWeight: active ? 800 : 700,
                              color: active ? T.teal600 : T.head,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {option.label}
                          </span>
                          {option.description && (
                            <span
                              style={{
                                display: "block",
                                fontSize: 10,
                                color: T.muted,
                                marginTop: 2,
                              }}
                            >
                              {option.description}
                            </span>
                          )}
                        </span>
                      </span>

                      {active && <Check size={14} color={T.teal600} />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

export default ModernSelect;
