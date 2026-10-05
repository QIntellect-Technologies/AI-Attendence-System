/**
 * useEmployeeProfileSettings.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin helper around the existing OrgConfigContext + generateOrgDummyData flow.
 * It does not introduce a second employee store.
 *
 * Single source of truth:
 *   cfg.employeeProfiles  → generateOrgDummyData(cfg) → orgDummy.staff
 */

import { useCallback, useMemo } from "react";
import { useOrg } from "../contexts/OrgConfigContext";
import type {
  EmployeeProfileOverride,
  OrgConfig,
} from "../contexts/OrgConfigContext";

export interface EmployeeProfilePatch {
  name?: string;
  email?: string;
  phone?: string;
  profileImageUrl?: string;
  profileImageName?: string;
  passwordChangedAt?: string;
  mustChangePassword?: boolean;
}

export function useEmployeeProfileSettings(employeeId?: string) {
  const { cfg, updateCfg, orgDummy } = useOrg();

  const employees = orgDummy.staff;

  const employee = useMemo<DummyStaffMember | undefined>(() => {
    if (!employeeId) return employees[0];

    return employees.find(
      (member) =>
        member.id === employeeId ||
        member.userId === employeeId ||
        member.employeeId === employeeId,
    );
  }, [employeeId, employees]);

  const profile = useMemo<EmployeeProfileOverride | undefined>(() => {
    if (!employee) return undefined;

    return (
      cfg.employeeProfiles[employee.id] ??
      (employee.userId ? cfg.employeeProfiles[employee.userId] : undefined) ??
      (employee.employeeId
        ? cfg.employeeProfiles[employee.employeeId]
        : undefined)
    );
  }, [cfg.employeeProfiles, employee]);

  const updateEmployeeProfile = useCallback(
    (targetEmployeeId: string, patch: EmployeeProfilePatch) => {
      const targetEmployee = employees.find(
        (member) =>
          member.id === targetEmployeeId ||
          member.userId === targetEmployeeId ||
          member.employeeId === targetEmployeeId,
      );

      const stableEmployeeId = targetEmployee?.id ?? targetEmployeeId;
      const existing = cfg.employeeProfiles[stableEmployeeId];

      const nextProfile: EmployeeProfileOverride = {
        ...existing,
        ...patch,
        employeeId: stableEmployeeId,
        userId: existing?.userId ?? targetEmployee?.userId,
        updatedAt: new Date().toISOString(),
      };

      updateCfg({
        employeeProfiles: {
          ...cfg.employeeProfiles,
          [stableEmployeeId]: nextProfile,
        },
      } satisfies Partial<OrgConfig>);
    },
    [cfg.employeeProfiles, employees, updateCfg],
  );

  return {
    employees,
    employee,
    profile,
    updateEmployeeProfile,
  };
}

export default useEmployeeProfileSettings;
