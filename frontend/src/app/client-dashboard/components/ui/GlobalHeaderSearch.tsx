import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  MapPin,
  Search,
  User,
  X,
} from "lucide-react";
import { useOrg } from "../../contexts/OrgConfigContext";
import { useBackendStore, type StaffMember } from "../../contexts/ModuleContext";
import { useAuth } from "../../contexts/useAuth";
import { getEnabledModules, MODULE_REGISTRY } from "../../config/moduleRegistry";
import { getFirstPaintModuleKeys, isStaffUser } from "../../utils/moduleAccess";
import { resolvePeopleRenderingModel } from "../../utils/templateRendering";
import { T } from "./theme";

export const GlobalHeaderSearch: React.FC = () => {
  const navigate = useNavigate();
  const {
    visibleBranches,
    cfg,
    isOrgReady,
    selectedPeopleType,
  } = useOrg();
  const { user } = useAuth();
  const staffStore = useBackendStore<StaffMember>();

  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isStaffDashboard = isStaffUser(user);

  const searchBranches = useMemo(() => {
    if (!isStaffDashboard) return visibleBranches;

    const allowedIds = Array.isArray(user?.allowedBranchIds)
      ? user.allowedBranchIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
      : [];
    const branchId = Number(user?.branchId ?? user?.branch_id);
    const scopedIds = new Set(
      allowedIds.length > 0
        ? allowedIds
        : Number.isFinite(branchId) && branchId > 0
          ? [branchId]
          : [],
    );
    return visibleBranches.filter((branch) => scopedIds.has(branch.id));
  }, [isStaffDashboard, user, visibleBranches]);

  // Keyboard shortcut: Ctrl+K or Cmd+K or / to focus search input
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        setIsOpen(true);
      } else if (e.key === "Escape") {
        setIsOpen(false);
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const pagesIndex = useMemo(() => {
    const enabledKeys = getFirstPaintModuleKeys(
      user,
      cfg.modules,
      isOrgReady,
      isStaffDashboard,
    );
    const modules =
      enabledKeys.length > 0
        ? getEnabledModules({
            enabledKeys,
            bizType: cfg.bizType ?? undefined,
            scope: isStaffDashboard ? "branch" : "global",
          })
        : [];
    const scopedModules =
      isStaffDashboard || searchBranches.length > 1
        ? modules
        : modules.filter((module) => module.key !== "branches");
    const branchModule = MODULE_REGISTRY.find(
      (module) => module.key === "branches",
    );

    if (
      !isStaffDashboard &&
      enabledKeys.length > 0 &&
      searchBranches.length > 1 &&
      branchModule &&
      !scopedModules.some((module) => module.key === "branches")
    ) {
      scopedModules.push(branchModule);
    }

    const peopleModel = resolvePeopleRenderingModel(cfg, selectedPeopleType);
    const moduleDescriptions: Record<string, string> = {
      employees: "People records, shift allocation, & profiles",
      attendance: "Attendance logs, exceptions, & manual overrides",
      leave: "Leave requests, quotas, & approvals",
      overtime: "Overtime requests, review, & approvals",
      payroll: "Salary calculations, bonuses, & processing",
      reports: "Exportable attendance, payroll, & people reports",
      cctv: "Live camera monitoring & face recognition",
      liveattendance: "Live attendance monitoring",
      branches: "Compare activity and metrics across branches",
      settings: "Organization profile, shifts, & preferences",
    };

    return [
      {
        id: "page-overview",
        category: "page" as const,
        title: "Dashboard Overview",
        subtitle: "Main metrics, live activity, & departmental stats",
        icon: <LayoutDashboard size={16} color="#0d9488" />,
        action: () => navigate("/admin"),
      },
      ...scopedModules.map((module) => {
        const branchId = Number(
          user?.branchId ?? user?.branch_id ?? user?.allowedBranchIds?.[0],
        );
        const modulePath =
          isStaffDashboard && Number.isFinite(branchId) && branchId > 0
            ? module.branchPath(branchId)
            : module.fullPath;
        return {
          id: `page-${module.key}`,
          category: "page" as const,
          title: module.key === "employees" ? peopleModel.directoryTitle : module.label,
          subtitle: moduleDescriptions[module.key] ?? `${module.label} tools and records`,
          icon: <module.Icon size={16} color="#3b82f6" />,
          action: () => navigate(modulePath),
        };
      }),
    ];
  }, [
    navigate,
    user,
    isStaffDashboard,
    cfg.modules,
    cfg.bizType,
    cfg,
    selectedPeopleType,
    isOrgReady,
    searchBranches,
  ]);

  // Branch results
  const branchResults = useMemo(() => {
    if (!Array.isArray(searchBranches) || searchBranches.length <= 1) return [];
    return searchBranches.map((branch) => ({
      id: `branch-${branch.id}`,
      category: "branch" as const,
      title: `${branch.name} Branch`,
      subtitle: `View dashboard for ${branch.name}`,
      icon: <MapPin size={16} color="#0284c7" />,
      action: () => navigate(`/admin/branch/${branch.id}`),
    }));
  }, [searchBranches, navigate]);

  // Staff results
  const staffResults = useMemo(() => {
    const list = Object.values(staffStore.items || {});
    return list.map((member) => ({
      id: `staff-${member.id}`,
      category: "staff" as const,
      title: member.name,
      subtitle: `${member.employeeId || member.code || "Staff"} · ${member.department || "No Department"} · ${member.designation || "Employee"}`,
      icon: <User size={16} color="#0f766e" />,
      action: () => navigate(`/admin/employees?highlight=${member.id}`),
    }));
  }, [staffStore.items, navigate]);

  // Filtered search items
  const filteredResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return pagesIndex;
    }

    const matchedPages = pagesIndex.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q),
    );

    const matchedBranches = branchResults.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q),
    );

    const matchedStaff = staffResults.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        item.subtitle.toLowerCase().includes(q),
    );

    return [...matchedPages, ...matchedBranches, ...matchedStaff].slice(0, 12);
  }, [query, pagesIndex, branchResults, staffResults]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen || filteredResults.length === 0) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % filteredResults.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredResults.length) % filteredResults.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const target = filteredResults[selectedIndex];
      if (target) {
        target.action();
        setIsOpen(false);
        setQuery("");
      }
    }
  };

  return (
    <div style={{ position: "relative", flex: "1 1 360px", maxWidth: 460, minWidth: 200 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          height: 38,
          padding: "0 12px",
          borderRadius: 10,
          backgroundColor: isOpen ? "#ffffff" : "#f8fafc",
          border: `1px solid ${isOpen ? "#0d9488" : "#cbd5e1"}`,
          boxShadow: isOpen
            ? "0 0 0 3px rgba(13, 148, 136, 0.12), 0 2px 8px rgba(0,0,0,0.04)"
            : "0 1px 2px rgba(0,0,0,0.02)",
          transition: "all 0.15s ease-in-out",
        }}
      >
        <Search size={16} color={isOpen ? "#0d9488" : "#64748b"} style={{ flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleInputKeyDown}
          placeholder="Search staff, pages, attendance, payroll... (Ctrl+K)"
          aria-label="Global search"
          style={{
            border: "none",
            outline: "none",
            background: "transparent",
            width: "100%",
            fontSize: 13,
            fontWeight: 500,
            color: T.head,
            fontFamily: "inherit",
          }}
        />

        {query ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            aria-label="Clear search query"
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: 2,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#94a3b8",
            }}
          >
            <X size={14} />
          </button>
        ) : (
          <kbd
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#64748b",
              backgroundColor: isOpen ? "#f1f5f9" : "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: 5,
              padding: "2px 6px",
              fontFamily: "inherit",
              whiteSpace: "nowrap",
              userSelect: "none",
              boxShadow: "0 1px 1px rgba(0,0,0,0.05)",
            }}
          >
            Ctrl K
          </kbd>
        )}
      </div>

      {/* Floating Results Dropdown */}
      {isOpen && (
        <div
          ref={dropdownRef}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            backgroundColor: "#ffffff",
            borderRadius: 14,
            border: "1px solid #cbd5e1",
            boxShadow: "0 12px 32px rgba(15, 23, 42, 0.16)",
            zIndex: 1000,
            overflow: "hidden",
            maxHeight: 420,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {query.trim() === "" && (
            <div
              style={{
                padding: "8px 14px 4px",
                fontSize: 10,
                fontWeight: 800,
                color: "#94a3b8",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                borderBottom: "1px solid #f1f5f9",
              }}
            >
              Suggested Quick Navigation
            </div>
          )}

          {filteredResults.length === 0 ? (
            <div style={{ padding: "20px 16px", textAlign: "center", color: "#64748b", fontSize: 13 }}>
              No matching results found for "<strong>{query}</strong>"
            </div>
          ) : (
            <div style={{ overflowY: "auto", padding: "6px" }}>
              {filteredResults.map((item, idx) => {
                const isSelected = idx === selectedIndex;
                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      item.action();
                      setIsOpen(false);
                      setQuery("");
                    }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "9px 12px",
                      borderRadius: 10,
                      backgroundColor: isSelected ? "rgba(13, 148, 136, 0.08)" : "transparent",
                      cursor: "pointer",
                      transition: "all 0.10s ease",
                    }}
                  >
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 8,
                        backgroundColor: isSelected ? "#ffffff" : "#f8fafc",
                        border: `1px solid ${isSelected ? "#99f6e4" : "#e2e8f0"}`,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                      }}
                    >
                      {item.icon}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: isSelected ? "#0f766e" : T.head,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div
                          style={{
                            fontSize: 11,
                            color: "#64748b",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            marginTop: 1,
                          }}
                        >
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div
            style={{
              padding: "6px 14px",
              backgroundColor: "#f8fafc",
              borderTop: "1px solid #e2e8f0",
              fontSize: 11,
              color: "#94a3b8",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <span>Navigate: <strong>↑ ↓</strong></span>
            <span>Select: <strong>Enter</strong></span>
            <span>Close: <strong>Esc</strong></span>
          </div>
        </div>
      )}
    </div>
  );
};
