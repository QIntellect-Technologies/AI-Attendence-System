/**
 * Sidebar.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Fully reusable modern sidebar component.
 *
 * Behaviour:
 * - Desktop: collapses to icon-rail (72px). Hovering expands to 240px.
 *   Clicking anywhere on the sidebar while expanded collapses it.
 * - Mobile (≤768px): hidden off-canvas; a hamburger in the host layout
 *   controls visibility via the `mobileOpen` / `onMobileClose` props.
 * - Active items highlight with a vibrant teal icon badge & glow indicator pill.
 * - Smooth micro-animations, tooltips when collapsed, and modern typography.
 */

import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { LogOut, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { T } from "./theme";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────

const D = {
  widthExpanded: 250,
  widthCollapsed: 84,
  duration: 260,
  easing: "cubic-bezier(0.16, 1, 0.3, 1)",
  borderRadius: { sm: 8, md: 10, lg: 12 },
  spacing: { xs: 4, sm: 8, md: 10, lg: 12 },
  colors: {
    activeText: "#0f766e", // teal-700
    activeBg: "linear-gradient(135deg, rgba(13, 148, 136, 0.12) 0%, rgba(20, 184, 166, 0.05) 100%)",
    activeIconBg: "linear-gradient(135deg, #0d9488 0%, #14b8a6 100%)",
    activeIconColor: "#ffffff",
    inactiveIconColor: "#64748b",
    inactiveText: "#475569",
    hoverBg: "rgba(241, 245, 249, 0.85)",
    logoutIconBg: "#ffe4e6",
    logoutIcon: "#e11d48",
    logoutText: "#dc2626",
    tooltipBg: "#0f172a",
  },
} as const;

const transition = `all ${D.duration}ms ${D.easing}`;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface SidebarItem {
  key: string;
  label: string;
  /** Absolute path, e.g. "/admin/attendance" */
  path: string;
  icon: React.ComponentType<{ size: number; color: string }>;
  /** Shown in tooltip when collapsed. Defaults to label. */
  tooltip?: string;
  /** Badge count (notifications, alerts) */
  badge?: number;
}

export interface SidebarGroup {
  id: string;
  /** Section heading shown only when expanded */
  label?: string;
  items: SidebarItem[];
  /** Render a horizontal rule above this group */
  divider?: boolean;
}

export interface SidebarProps {
  groups: SidebarGroup[];
  logo: React.ReactNode;
  brandName: string;
  brandSubtext?: string;
  onLogout: () => void;
  /** Mobile: controlled from the host layout */
  mobileOpen?: boolean;
  onMobileClose?: () => void;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL STYLE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function asideStyle(
  expanded: boolean,
  isMobile: boolean,
  mobileOpen: boolean,
): React.CSSProperties {
  if (isMobile) {
    return {
      position: "fixed",
      top: 0,
      left: 0,
      height: "100vh",
      width: D.widthExpanded,
      transform: mobileOpen ? "translateX(0)" : "translateX(-100%)",
      transition,
      background: "#ffffff",
      borderRight: `1px solid ${T.border}`,
      display: "flex",
      flexDirection: "column",
      zIndex: 50,
      overflowY: "auto",
      overflowX: "hidden",
      boxShadow: mobileOpen ? "4px 0 24px rgba(15, 23, 42, 0.15)" : "none",
    };
  }

  return {
    width: expanded ? D.widthExpanded : D.widthCollapsed,
    minWidth: expanded ? D.widthExpanded : D.widthCollapsed,
    transition,
    background: "#ffffff",
    borderRight: `1px solid ${T.border}`,
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    position: "sticky",
    top: 0,
    flexShrink: 0,
    overflowY: "auto",
    overflowX: "hidden",
    zIndex: 50,
    boxShadow: "2px 0 16px rgba(15, 23, 42, 0.03)",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TOOLTIP (shown when collapsed, on hover)
// ─────────────────────────────────────────────────────────────────────────────

interface TooltipProps {
  label: string;
  visible: boolean;
}

const Tooltip: React.FC<TooltipProps> = ({ label, visible }) => (
  <div
    role="tooltip"
    style={{
      position: "absolute",
      left: "calc(100% + 12px)",
      top: "50%",
      transform: "translateY(-50%)",
      background: D.colors.tooltipBg,
      color: "#ffffff",
      padding: "6px 12px",
      borderRadius: 8,
      fontSize: 12,
      fontWeight: 600,
      whiteSpace: "nowrap",
      zIndex: 200,
      pointerEvents: "none",
      opacity: visible ? 1 : 0,
      transition: `opacity ${D.duration}ms ${D.easing}, transform ${D.duration}ms ${D.easing}`,
      boxShadow: "0 4px 14px rgba(15, 23, 42, 0.22)",
      border: "1px solid rgba(255, 255, 255, 0.1)",
    }}
  >
    {label}
    {/* Arrow */}
    <div
      style={{
        position: "absolute",
        right: "100%",
        top: "50%",
        transform: "translateY(-50%)",
        borderWidth: 5,
        borderStyle: "solid",
        borderColor: `transparent ${D.colors.tooltipBg} transparent transparent`,
      }}
    />
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// NAV ITEM
// ─────────────────────────────────────────────────────────────────────────────

interface NavItemProps {
  item: SidebarItem;
  active: boolean;
  expanded: boolean;
  onClick?: () => void;
}

const NavItem: React.FC<NavItemProps> = ({
  item,
  active,
  expanded,
  onClick,
}) => {
  const [hovered, setHovered] = useState(false);
  const Icon = item.icon;
  const showTooltip = !expanded && hovered;

  const itemStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: expanded ? D.spacing.md : 0,
    padding: expanded ? "8px 10px" : "4px 0",
    margin: expanded ? "2px 8px" : "3px 0",
    justifyContent: expanded ? "flex-start" : "center",
    borderRadius: D.borderRadius.md,
    textDecoration: "none",
    background: active
      ? D.colors.activeBg
      : hovered
      ? D.colors.hoverBg
      : "transparent",
    transition,
    cursor: "pointer",
    boxSizing: "border-box",
    border: "none",
    fontFamily: "inherit",
    position: "relative",
    transform: hovered && expanded && !active ? "translateX(2px)" : "none",
  };

  const content = (
    <>
      {/* Active left glowing pill indicator */}
      {active && (
        <div
          style={{
            position: "absolute",
            left: expanded ? -8 : 0,
            top: "16%",
            bottom: "16%",
            width: 4,
            borderRadius: "0 4px 4px 0",
            background: "linear-gradient(180deg, #0d9488 0%, #14b8a6 100%)",
            boxShadow: "0 0 10px rgba(13, 148, 136, 0.6)",
          }}
        />
      )}

      {/* Icon wrapper badge */}
      <span
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: active
            ? D.colors.activeIconBg
            : hovered
            ? "#ffffff"
            : "transparent",
          boxShadow: active
            ? "0 3px 10px rgba(13, 148, 136, 0.35)"
            : hovered
            ? "0 2px 6px rgba(0, 0, 0, 0.05)"
            : "none",
          transition,
        }}
      >
        <Icon
          size={19}
          color={
            active
              ? D.colors.activeIconColor
              : hovered
              ? "#0f172a"
              : D.colors.inactiveIconColor
          }
        />
      </span>

      {/* Text Label */}
      {expanded && (
        <span
          style={{
            fontSize: 13,
            fontWeight: active ? 700 : 600,
            color: active ? D.colors.activeText : hovered ? "#0f172a" : D.colors.inactiveText,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            flex: 1,
            minWidth: 0,
            transition,
          }}
        >
          {item.label}
        </span>
      )}

      {/* Notification Badge */}
      {item.badge !== undefined && item.badge > 0 && expanded && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 6px",
            borderRadius: 999,
            background: "linear-gradient(135deg, #f43f5e, #e11d48)",
            boxShadow: "0 2px 6px rgba(225, 29, 72, 0.35)",
            color: "#ffffff",
            fontSize: 10,
            fontWeight: 800,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {item.badge > 99 ? "99+" : item.badge}
        </span>
      )}

      {/* Tooltip shown only when collapsed */}
      {!expanded && (
        <Tooltip label={item.tooltip ?? item.label} visible={showTooltip} />
      )}
    </>
  );

  const eventHandlers = {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onClick,
  };

  return (
    <Link
      to={item.path}
      className="dashboard-navigation-link"
      style={itemStyle}
      {...eventHandlers}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
    >
      {content}
    </Link>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION HEADING
// ─────────────────────────────────────────────────────────────────────────────

const SectionLabel: React.FC<{ label: string; expanded: boolean }> = ({
  label,
  expanded,
}) => (
  <div
    style={{
      padding: "10px 14px 4px",
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      color: T.muted,
      opacity: expanded ? 1 : 0,
      height: expanded ? "auto" : 0,
      overflow: "hidden",
      transition,
      whiteSpace: "nowrap",
    }}
  >
    {label}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// LOGOUT BUTTON
// ─────────────────────────────────────────────────────────────────────────────

const LogoutButton: React.FC<{ expanded: boolean; onLogout: () => void }> = ({
  expanded,
  onLogout,
}) => {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        padding: expanded ? "12px 10px" : "12px 0",
        borderTop: `1px solid ${T.border}`,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        onClick={onLogout}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        aria-label="Logout"
        style={{
          display: "flex",
          alignItems: "center",
          gap: expanded ? D.spacing.md : 0,
          padding: expanded ? "7px 10px" : "4px 0",
          justifyContent: expanded ? "flex-start" : "center",
          borderRadius: D.borderRadius.md,
          background: hovered ? "linear-gradient(135deg, #fef2f2, #ffe4e6)" : "transparent",
          border: "none",
          width: "100%",
          cursor: "pointer",
          transition,
          fontFamily: "inherit",
          boxSizing: "border-box",
        }}
      >
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: hovered ? D.colors.logoutIconBg : "#f8fafc",
            transition,
          }}
        >
          <LogOut size={19} color={D.colors.logoutIcon} />
        </span>
        {expanded && (
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: D.colors.logoutText,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              flex: 1,
              minWidth: 0,
              textAlign: "left",
            }}
          >
            Logout
          </span>
        )}
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE HAMBURGER BUTTON
// ─────────────────────────────────────────────────────────────────────────────

export const SidebarHamburger: React.FC<{
  onClick: () => void;
  style?: React.CSSProperties;
}> = ({ onClick, style }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Open navigation"
    style={{
      width: 38,
      height: 38,
      borderRadius: D.borderRadius.md,
      border: `1px solid ${T.border}`,
      background: "#ffffff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      flexShrink: 0,
      boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
      ...style,
    }}
  >
    <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
      <rect y="0" width="16" height="2" rx="1" fill="#475569" />
      <rect y="5" width="12" height="2" rx="1" fill="#475569" />
      <rect y="10" width="16" height="2" rx="1" fill="#475569" />
    </svg>
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SIDEBAR COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const MOBILE_BREAKPOINT = 768;

export const Sidebar: React.FC<SidebarProps> = ({
  groups,
  logo,
  brandName,
  brandSubtext,
  onLogout,
  mobileOpen = false,
  onMobileClose,
}) => {
  const location = useLocation();

  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.innerWidth <= MOBILE_BREAKPOINT,
  );

  // Persistent pinned state (saved in localStorage)
  const [isPinned, setIsPinned] = useState(() => {
    try {
      return localStorage.getItem("sidebar_pinned") === "true";
    } catch {
      return false;
    }
  });

  const togglePin = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    setIsPinned((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("sidebar_pinned", String(next));
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) {
        onMobileClose?.();
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [onMobileClose]);

  const handleMouseEnter = useCallback(() => {
    if (isMobile || isPinned) return;
    setHoverExpanded(true);
  }, [isMobile, isPinned]);

  const handleSidebarClick = useCallback(() => {
    if (isMobile || isPinned) return;
    if (hoverExpanded) {
      setHoverExpanded(false);
    }
  }, [isMobile, isPinned, hoverExpanded]);

  const handleMouseLeave = useCallback(() => {
    if (isMobile || isPinned) return;
    setHoverExpanded(false);
  }, [isMobile, isPinned]);

  const isExpanded = isMobile ? mobileOpen : (isPinned || hoverExpanded);

  const isActive = useCallback(
    (path: string) =>
      location.pathname === path || location.pathname.startsWith(`${path}/`),
    [location.pathname],
  );

  const handleItemClick = useCallback(() => {
    if (isMobile) {
      onMobileClose?.();
    } else if (!isPinned) {
      setHoverExpanded(false);
    }
  }, [isMobile, onMobileClose, isPinned]);

  return (
    <>
      {/* Mobile overlay */}
      {isMobile && mobileOpen && (
        <div
          onClick={onMobileClose}
          aria-hidden="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 40,
            background: "rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(4px)",
          }}
        />
      )}

      <aside
        style={asideStyle(isExpanded, isMobile, mobileOpen)}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleSidebarClick}
        aria-label="Main navigation"
      >
        {/* ── BRAND HEADER ── */}
        <div
          style={{
            padding: isExpanded ? "16px 14px 12px 14px" : "16px 0 12px 0",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: isExpanded ? "flex-start" : "center",
            gap: isExpanded ? D.spacing.md : 0,
            flexShrink: 0,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Logo Badge */}
          <div
            style={{
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {logo}
          </div>

          {/* Brand text */}
          {isExpanded && (
            <div
              style={{
                flex: 1,
                minWidth: 0,
                overflow: "hidden",
                transition,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 6,
              }}
            >
              <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 14,
                    fontWeight: 800,
                    color: T.head,
                    letterSpacing: "-0.4px",
                    lineHeight: 1.2,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                  title={brandName}
                >
                  {brandName}
                </p>
                {brandSubtext && (
                  <span
                    style={{
                      display: "inline-block",
                      margin: "3px 0 0",
                      fontSize: 10,
                      fontWeight: 700,
                      color: "#0f766e",
                      background: "rgba(13, 148, 136, 0.1)",
                      padding: "2px 7px",
                      borderRadius: 6,
                      whiteSpace: "nowrap",
                      letterSpacing: "0.01em",
                    }}
                  >
                    {brandSubtext}
                  </span>
                )}
              </div>

              {/* Pin / Unpin toggle button (desktop) */}
              {!isMobile && (
                <button
                  type="button"
                  onClick={togglePin}
                  title={
                    isPinned
                      ? "Unpin sidebar (enable auto-collapse)"
                      : "Pin sidebar open permanently"
                  }
                  aria-label={isPinned ? "Unpin sidebar" : "Pin sidebar"}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 7,
                    border: `1px solid ${isPinned ? "#0d9488" : "#cbd5e1"}`,
                    background: isPinned
                      ? "linear-gradient(135deg, #f0fdfa, #ccfbf1)"
                      : "#ffffff",
                    color: isPinned ? "#0d9488" : "#64748b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    transition: "all 0.15s ease-in-out",
                    flexShrink: 0,
                    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.06)",
                  }}
                >
                  {isPinned ? (
                    <PanelLeftClose size={15} color="#0d9488" />
                  ) : (
                    <PanelLeftOpen size={15} color="#64748b" />
                  )}
                </button>
              )}
            </div>
          )}
        </div>

        {/* ── NAV GROUPS ── */}
        <nav
          style={{
            padding: "10px 0",
            flex: 1,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {groups.map((group) => (
            <React.Fragment key={group.id}>
              {group.divider && (
                <div
                  style={{
                    height: 1,
                    background: T.border,
                    margin: "10px 14px",
                  }}
                />
              )}

              {group.label && (
                <SectionLabel label={group.label} expanded={isExpanded} />
              )}

              {group.items.map((item) => (
                <NavItem
                  key={item.key}
                  item={item}
                  active={isActive(item.path)}
                  expanded={isExpanded}
                  onClick={handleItemClick}
                />
              ))}
            </React.Fragment>
          ))}
        </nav>

        {/* ── LOGOUT ── */}
        <div onClick={(e) => e.stopPropagation()}>
          <LogoutButton expanded={isExpanded} onLogout={onLogout} />
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
