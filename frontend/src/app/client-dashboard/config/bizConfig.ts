/**
 * src/config/bizConfig.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CHANGE: CORE_MODULES now uses canonical moduleRegistry.ts keys.
 *
 * Previous:  "liveattendancemonitoring", "livecctv"
 * Fixed:     "liveattendance",           "cctv"
 *
 * These strings flow into org.modules[] via the onboarding wizard and
 * ultimately into the PUT /modules payload. If they don't match
 * _VALID_MODULES in support_db.py the save fails with a 400.
 */

import {
  GraduationCap,
  Building2,
  Globe,
  Utensils,
  Cpu,
  Stethoscope,
  type LucideIcon,
} from "lucide-react";

export interface BizPreset {
  label: string;
  Icon: LucideIcon;
  desc: string;
  branches: string[];
  departments: string[];
  modules: string[];
  roles: { name: string; level: number }[];
}

/**
 * Core modules available to every biz type.
 * Keys MUST match ClientModuleKey / moduleRegistry.ts / _VALID_MODULES.
 */
const CORE_MODULES = [
  "employees", // was "employees" ✓
  "attendance", // was "attendance" ✓
  "liveattendance", // was "liveattendancemonitoring" ✗ → FIXED
  "cctv", // was "livecctv"               ✗ → FIXED
  "payroll", // was "payroll" ✓
  "leave", // was "leave" ✓
  "overtime", // was "overtime" ✓
  "reports", // was "reports" ✓
];

export const BIZ: Record<string, BizPreset> = {
  school: {
    label: "School / College",
    Icon: GraduationCap,
    desc: "Educational institutions with student lifecycle management",
    departments: [
      "Administration",
      "Academics",
      "Accounts & Finance",
      "Examination",
      "Library",
      "Transport",
      "Sports & Culture",
    ],
    modules: [
      ...CORE_MODULES,
      "students",
      "examination",
      "fees",
      "library",
      "transport",
      "timetable",
      "communication",
    ],
    roles: [
      { name: "Principal", level: 1 },
      { name: "Vice Principal", level: 2 },
      { name: "Department Head", level: 3 },
      { name: "Teacher", level: 4 },
      { name: "Accountant", level: 4 },
      { name: "Librarian", level: 4 },
      { name: "Student", level: 5 },
      { name: "Parent / Guardian", level: 5 },
    ],
    branches: ["Main Campus", "Secondary Campus"],
  },

  hospital: {
    label: "Hospital / Clinic",
    Icon: Stethoscope,
    desc: "Healthcare facilities with patient and clinical management",
    departments: [
      "Emergency",
      "Cardiology",
      "Orthopedics",
      "Neurology",
      "Pharmacy",
      "Laboratory",
      "Radiology",
      "Administration",
      "Billing",
    ],
    modules: [
      ...CORE_MODULES,
      "patients",
      "appointments",
      "pharmacy",
      "billing",
      "laboratory",
      "wards",
      "doctors",
    ],
    roles: [
      { name: "Medical Director", level: 1 },
      { name: "Head of Department", level: 2 },
      { name: "Doctor / Consultant", level: 3 },
      { name: "Nurse", level: 4 },
      { name: "Pharmacist", level: 4 },
      { name: "Lab Technician", level: 4 },
      { name: "Receptionist", level: 5 },
      { name: "Billing Staff", level: 5 },
    ],
    branches: ["Main Hospital", "Outpatient Clinic"],
  },

  company: {
    label: "Company / Corporate",
    Icon: Building2,
    desc: "Businesses with HR, payroll, and full resource management",
    departments: [
      "Human Resources",
      "Finance & Accounts",
      "Sales & Marketing",
      "IT Department",
      "Operations",
      "Legal & Compliance",
      "R&D",
    ],
    modules: [...CORE_MODULES, "crm", "projects", "assets", "finance"],
    roles: [
      { name: "CEO / Director", level: 1 },
      { name: "Department Manager", level: 2 },
      { name: "Team Lead", level: 3 },
      { name: "Senior Employee", level: 4 },
      { name: "Employee", level: 4 },
      { name: "Accountant", level: 4 },
      { name: "HR Officer", level: 4 },
    ],
    branches: [
      "Head Office",
      "Regional Office – North",
      "Regional Office – South",
    ],
  },

  factory: {
    label: "Factory / Manufacturing",
    Icon: Cpu,
    desc: "Production facilities with inventory, QC, and workforce management",
    departments: [
      "Production",
      "Quality Control",
      "Raw Material Store",
      "Finished Goods",
      "Maintenance",
      "HR & Admin",
      "Dispatch & Logistics",
    ],
    modules: [
      ...CORE_MODULES,
      "inventory",
      "production",
      "quality",
      "maintenance",
      "suppliers",
    ],
    roles: [
      { name: "Plant Manager", level: 1 },
      { name: "Production Supervisor", level: 2 },
      { name: "QC Inspector", level: 3 },
      { name: "Machine Operator", level: 4 },
      { name: "Store Keeper", level: 4 },
      { name: "Maintenance Technician", level: 4 },
      { name: "HR Officer", level: 5 },
    ],
    branches: ["Plant A", "Plant B"],
  },

  ngo: {
    label: "NGO / Non-Profit",
    Icon: Globe,
    desc: "Non-governmental organizations with donor and program management",
    departments: [
      "Programs & Projects",
      "Fundraising",
      "Finance & Compliance",
      "Communications",
      "Field Operations",
      "HR",
      "M&E",
    ],
    modules: [
      ...CORE_MODULES,
      "donors",
      "projects",
      "volunteers",
      "campaigns",
      "beneficiaries",
    ],
    roles: [
      { name: "Executive Director", level: 1 },
      { name: "Program Manager", level: 2 },
      { name: "Field Coordinator", level: 3 },
      { name: "Finance Officer", level: 4 },
      { name: "Field Officer", level: 4 },
      { name: "Volunteer", level: 5 },
    ],
    branches: ["Head Office", "Field Office – District A"],
  },

  restaurant: {
    label: "Restaurant / Hospitality",
    Icon: Utensils,
    desc: "Food & hospitality businesses with orders, tables, and POS",
    departments: [
      "Kitchen",
      "Front of House",
      "Bar & Beverages",
      "Management",
      "Accounts",
      "Procurement",
      "Delivery",
    ],
    modules: [
      ...CORE_MODULES,
      "orders",
      "inventory",
      "billing",
      "tables",
      "menu",
      "suppliers",
    ],
    roles: [
      { name: "Restaurant Manager", level: 1 },
      { name: "Head Chef", level: 2 },
      { name: "Sous Chef", level: 3 },
      { name: "Waiter", level: 4 },
      { name: "Cashier", level: 4 },
      { name: "Bartender", level: 4 },
      { name: "Delivery Staff", level: 5 },
    ],
    branches: ["Main Branch", "Branch 2"],
  },
};
