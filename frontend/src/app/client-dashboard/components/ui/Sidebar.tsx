/**
 * Sidebar.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Fully reusable sidebar component.
 *
 * Behaviour:
 * - Desktop: collapses to icon-rail (72px). Hovering expands to 240px.
 *   Clicking anywhere on the sidebar while expanded collapses it.
 * - Mobile (≤768px): hidden off-canvas; a hamburger in the host layout
 *   controls visibility via the `mobileOpen` / `onMobileClose` props.
 * - No chevron/arrow icons on nav items.
 * - Collapsed icons are larger (20px) and teal-coloured for active items,
 *   slate-coloured otherwise — no grey ghost appearance.
 * - Tooltip label appears to the right of each icon while collapsed.
 * - Fully typed, zero `any`, DRY style constants.
 *
 * Usage (Admin):
 *   <Sidebar groups={adminGroups} logo={<Logo />} brandName="AttendAI"
 *            brandSubtext="Admin Panel" onLogout={handleLogout} />
 *
 * Usage (Support):
 *   <Sidebar groups={supportGroups} logo={<Logo />} brandName="AttendAI"
 *            brandSubtext="Support" onLogout={handleLogout} />
 */

import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { LogOut } from "lucide-react";
import { T } from "./theme";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────

const D = {
  widthExpanded: 240,
  widthCollapsed: 72,
  duration: 280,
  easing: "cubic-bezier(0.4, 0, 0.2, 1)",
  iconSizeCollapsed: 20,
  iconSizeExpanded: 17,
  borderRadius: { sm: 8, md: 10 },
  spacing: { xs: 4, sm: 8, md: 10, lg: 12 },
  colors: {
    activeIcon: "#0d9488", // teal-600
    activeIconBg: "#f0fdfa", // teal-50
    activeBorder: "#0d9488", // teal-600
    activeText: "#0f766e", // teal-700
    inactiveIcon: "#475569", // slate-600 — visible, not washed out
    hoverBg: "#f0fdfa", // teal-50
    logoutIcon: "#dc2626",
    logoutText: "#dc2626",
    tooltipBg: "#1e293b", // slate-800
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
// INTERNAL STYLE HELPERS (pure functions — avoids object recreation)
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
      background: "#fff",
      borderRight: `1px solid ${T.border}`,
      display: "flex",
      flexDirection: "column",
      zIndex: 50,
      overflowY: "auto",
      overflowX: "hidden",
      boxShadow: mobileOpen ? "4px 0 24px rgba(0,0,0,0.10)" : "none",
    };
  }

  return {
    width: expanded ? D.widthExpanded : D.widthCollapsed,
    minWidth: expanded ? D.widthExpanded : D.widthCollapsed,
    transition,
    background: "#fff",
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
  };
}

function navItemStyle(active: boolean, expanded: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: D.spacing.md,
    padding: expanded ? "9px 10px" : "9px 0",
    justifyContent: expanded ? "flex-start" : "center",
    borderRadius: D.borderRadius.sm,
    marginBottom: 2,
    textDecoration: "none",
    background: active ? D.colors.activeIconBg : "transparent",
    borderLeft: `3px solid ${active ? D.colors.activeBorder : "transparent"}`,
    transition,
    cursor: "pointer",
    width: "100%",
    boxSizing: "border-box",
    border: "none",
    fontFamily: "inherit",
    position: "relative",
  };
}

function labelStyle(active: boolean, expanded: boolean): React.CSSProperties {
  return {
    fontSize: 13,
    fontWeight: 700,
    color: active ? D.colors.activeText : T.navy700,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    flex: 1,
    minWidth: 0,
    opacity: expanded ? 1 : 0,
    width: expanded ? "auto" : 0,
    transition,
    pointerEvents: expanded ? "auto" : "none",
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
      color: "#fff",
      padding: "5px 10px",
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 600,
      whiteSpace: "nowrap",
      zIndex: 200,
      pointerEvents: "none",
      opacity: visible ? 1 : 0,
      transition: `opacity ${D.duration}ms ${D.easing}`,
      boxShadow: "0 2px 8px rgba(0,0,0,0.18)",
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
  const iconColor = active ? D.colors.activeIcon : D.colors.inactiveIcon;
  const iconSize = expanded ? D.iconSizeExpanded : D.iconSizeCollapsed;

  const commonStyle: React.CSSProperties = {
    ...navItemStyle(active, expanded),
    // Hover background when not active
    ...(hovered && !active ? { background: D.colors.hoverBg } : {}),
  };

  const content = (
    <>
      <span
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: `all ${D.duration}ms ${D.easing}`,
        }}
      >
        <Icon size={iconSize} color={iconColor} />
      </span>

      <span style={labelStyle(active, expanded)}>{item.label}</span>

      {/* Badge */}
      {item.badge !== undefined && item.badge > 0 && expanded && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            padding: "0 5px",
            borderRadius: 999,
            background: "#e11d48",
            color: "#fff",
            fontSize: 10,
            fontWeight: 900,
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

  // Use Link for navigation, button for actions
  return (
    <Link
      to={item.path}
      style={commonStyle}
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
      padding: "8px 10px 4px",
      fontSize: 10,
      fontWeight: 800,
      letterSpacing: "0.06em",
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
        padding: `${D.spacing.lg}px`,
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
          ...navItemStyle(false, expanded),
          justifyContent: expanded ? "flex-start" : "center",
          ...(hovered ? { background: "#fef2f2" } : {}),
        }}
      >
        <span
          style={{
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <LogOut
            size={expanded ? D.iconSizeExpanded : D.iconSizeCollapsed}
            color={D.colors.logoutIcon}
          />
        </span>
        <span
          style={{
            ...labelStyle(false, expanded),
            color: D.colors.logoutText,
          }}
        >
          Logout
        </span>
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE HAMBURGER BUTTON (exported so host layouts can place it in their header)
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
      background: "#fff",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      flexShrink: 0,
      ...style,
    }}
  >
    {/* Simple 3-bar icon */}
    <svg width="16" height="12" viewBox="0 0 16 12" fill="none">
      <rect y="0" width="16" height="2" rx="1" fill="#64748b" />
      <rect y="5" width="12" height="2" rx="1" fill="#64748b" />
      <rect y="10" width="16" height="2" rx="1" fill="#64748b" />
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

  // Desktop: hover-driven expansion
  const [hoverExpanded, setHoverExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(
    () => window.innerWidth <= MOBILE_BREAKPOINT,
  );

  // Responsive breakpoint detection
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`);
    const handler = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches);
      if (!e.matches) {
        // Reset mobile state when going back to desktop
        onMobileClose?.();
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [onMobileClose]);

  // Desktop: expand on hover (with 80ms delay to avoid flicker)
  const handleMouseEnter = useCallback(() => {
    if (isMobile) return;
    setHoverExpanded(true);
  }, [isMobile]);

  // Desktop: collapse when click anywhere inside sidebar
  const handleSidebarClick = useCallback(() => {
    if (isMobile) return;
    if (hoverExpanded) {
      setHoverExpanded(false);
    }
  }, [isMobile, hoverExpanded]);

  // Prevent collapse when just hovering out without click
  const handleMouseLeave = useCallback(() => {
    if (isMobile) return;
  }, [isMobile]);

  const isExpanded = isMobile ? mobileOpen : hoverExpanded;

  const isActive = useCallback(
    (path: string) =>
      location.pathname === path || location.pathname.startsWith(`${path}/`),
    [location.pathname],
  );

  const handleItemClick = useCallback(() => {
    if (isMobile) {
      onMobileClose?.();
    } else {
      // Click on nav item also collapses sidebar
      setHoverExpanded(false);
    }
  }, [isMobile, onMobileClose]);

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
            background: "rgba(15,23,42,0.4)",
            backdropFilter: "blur(2px)",
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
            padding: `${D.spacing.lg}px ${D.spacing.md}px ${D.spacing.sm}px`,
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            gap: D.spacing.md,
            flexShrink: 0,
            // Prevent header click from triggering sidebar collapse
            // since user may click the logo to navigate
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Logo — always visible */}
          <div style={{ flexShrink: 0 }}>{logo}</div>

          {/* Brand text — fades in when expanded */}
          <div
            style={{
              flex: 1,
              minWidth: 0,
              opacity: isExpanded ? 1 : 0,
              width: isExpanded ? "auto" : 0,
              overflow: "hidden",
              transition,
              pointerEvents: isExpanded ? "auto" : "none",
            }}
          >
            <p
              style={{
                margin: 0,
                fontSize: 13,
                fontWeight: 700,
                color: T.head,
                letterSpacing: "-0.3px",
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
              <p
                style={{
                  margin: "3px 0 0",
                  fontSize: 11,
                  color: T.muted,
                  whiteSpace: "nowrap",
                }}
              >
                {brandSubtext}
              </p>
            )}
          </div>
        </div>

        {/* ── NAV GROUPS ── */}
        <nav
          style={{ padding: D.spacing.lg, flex: 1 }}
          // Stop nav clicks from bubbling to aside (which would double-collapse)
          onClick={(e) => e.stopPropagation()}
        >
          {groups.map((group) => (
            <React.Fragment key={group.id}>
              {group.divider && (
                <div
                  style={{
                    height: 1,
                    background: T.border,
                    margin: "8px 0",
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
