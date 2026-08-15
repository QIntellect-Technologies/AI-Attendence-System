import type { Dispatch, SetStateAction } from "react";
import type { BizPreset } from "../../../config/bizConfig";

/**
 * BranchId is intentionally opaque.
 * Legacy local demo data may still use numbers, while Supabase tenants usually
 * use UUID/string ids. Do not coerce route ids with Number().
 */
export type BranchId = string | number;

export interface Branch {
  id: BranchId;
  name: string;
  city: string;
}

export interface Department {
  id: number;
  name: string;
}

export interface Role {
  id: number;
  name: string;
  level: number;
}

export interface Camera {
  id: string;
  branchId: BranchId;
  name: string;
  location: string;
  rtspUrl: string;
  streamPath?: string;
  status?: "Normal" | "Alert" | "Offline";
  lastSeen?: string;
}

export interface OrgConfig {
  bizType: string | null;
  orgName: string;
  tagline: string;
  address: string;
  size: string;
  logo?: string | null;
  branches: Branch[];
  /** Object keys are String(branch.id), so numeric and UUID branch ids both work. */
  departments: Record<string, Department[]>;
  modules: string[];
  roles: Record<string, Role[]>;
  cameras: Record<string, Camera[]>;
}

export interface WizardInputs {
  branch: string;
  dept: string;
  role: string;
}

export interface LevelMeta {
  label: string;
  color: string;
  bg: string;
}

export type WizardStepId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export type SetOrgConfig = Dispatch<SetStateAction<OrgConfig>>;
export type SetWizardInputs = Dispatch<SetStateAction<WizardInputs>>;
export type BizType = BizPreset;

export const EMPTY_ORG_CONFIG: OrgConfig = {
  bizType: null,
  orgName: "",
  tagline: "",
  address: "",
  size: "",
  logo: null,
  branches: [],
  departments: {},
  modules: [],
  roles: {},
  cameras: {},
};

export const STEPS: { id: WizardStepId; label: string }[] = [
  { id: 1, label: "Business Type" },
  { id: 2, label: "Organization Info" },
  { id: 3, label: "Branches" },
  { id: 4, label: "Cameras" },
  { id: 5, label: "Departments" },
  { id: 6, label: "Modules" },
  { id: 7, label: "Roles & Access" },
  { id: 8, label: "Review & Launch" },
];
