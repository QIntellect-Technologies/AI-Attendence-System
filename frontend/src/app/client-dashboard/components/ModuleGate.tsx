import React from "react";
import { Navigate } from "react-router-dom";
import { useOrg } from "../contexts/OrgConfigContext";

const MODULE_ALIASES: Record<string, string> = {
  staff: "employees",
  employee: "employees",
  employees: "employees",
  staff_directory: "employees",
  staffmanagement: "employees",
  leave_management: "leave",
  leaves: "leave",
  live_attendance: "liveattendance",
  live_attendance_monitoring: "liveattendance",
  liveattendancemonitoring: "liveattendance",
  live_cctv: "cctv",
  livecctv: "cctv",
};

export function normalizeModuleKey(key: unknown): string {
  const raw = String(key ?? "").trim().toLowerCase();
  return MODULE_ALIASES[raw] ?? raw;
}

export function isModuleEnabled(enabledModules: readonly string[], moduleKey: string): boolean {
  const normalized = new Set(enabledModules.map(normalizeModuleKey));
  return normalized.has("*") || normalized.has("all") || normalized.has(normalizeModuleKey(moduleKey));
}

const ModuleBlocked: React.FC<{ moduleKey: string }> = ({ moduleKey }) => (
  <div style={{ padding: 24 }}>
    <div style={{ background: "#fff", border: "1px solid #e2e8f0", borderRadius: 16, padding: 22, color: "#475569" }}>
      This module is not enabled for this organization. Contact QIntellect Support to enable <strong>{moduleKey}</strong>.
    </div>
  </div>
);

export const ModuleGate: React.FC<{
  moduleKey: string;
  children: React.ReactNode;
  redirectTo?: string;
  showMessage?: boolean;
}> = ({ moduleKey, children, redirectTo = "/admin", showMessage = false }) => {
  const { cfg, isOrgReady } = useOrg();

  if (!isOrgReady) return null;
  if (isModuleEnabled(cfg.modules, moduleKey)) return <>{children}</>;

  if (showMessage) return <ModuleBlocked moduleKey={moduleKey} />;
  return <Navigate to={redirectTo} replace />;
};

export default ModuleGate;
