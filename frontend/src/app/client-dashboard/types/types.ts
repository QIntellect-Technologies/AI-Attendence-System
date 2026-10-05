export type TenantId = string | number;

export type UserRole =
  | "admin"
  | "hr"
  | "staff"
  | "manager"
  | "developer"
  | "hr_executive"
  | "ceo"
  | "product_lead"
  | "strategic_advisor";

export interface User {
  id: TenantId;
  name: string;
  email: string;
  role: UserRole | string;
  password?: string;
  staffId?: TenantId;
  staff_id?: TenantId;
  userId?: TenantId;
  branchId?: TenantId | null;
  branch_id?: TenantId | null;
  branchName?: string | null;
  branch_name?: string | null;
  organizationId?: TenantId | null;
  organization_id?: TenantId | null;
  organizationStatus?: string;
  organization_status?: string;
  dashboardReady?: boolean;
  dashboard_ready?: boolean;
  requiresOnboarding?: boolean;
  requires_onboarding?: boolean;
  allowedBranchIds?: TenantId[];
  allowedModules?: string[] | string;
  accessModules?: string[] | string;
  moduleAccess?: string[] | string;
  shift?: string;
  duty_start?: string;
  duty_end?: string;
  staff_type?: "office" | "field";
  access_modules?: string[];
  portalAccess?: {
    desktopDashboard?: boolean;
  };
}

export interface Staff {
  id: TenantId;
  name: string;
  email: string;
  phone: string;
  department: string;
  position: string;
  joinDate: string;
  userId: TenantId;
  branchId?: TenantId | null;
  branchName?: string | null;
  organizationId?: TenantId | null;
  organization_id?: TenantId | null;
  backendBranchId?: TenantId | null;
  shiftStart: string;
  shiftEnd: string;
  shift?: string;
  role?: string;
  image?: string;
  salary?: number;
  presentDays?: number;
  staffType?: "office" | "field";
  accessModules?: string[];
}

export interface OvertimeRequest {
  id: TenantId;
  staffId: TenantId;
  staffName: string;
  branchId?: TenantId | null;
  branchName?: string | null;
  department?: string | null;
  date: string;
  hours: number;
  status:
    | "Pending"
    | "Approved"
    | "Rejected"
    | "pending"
    | "approved"
    | "rejected";
  appliedOn: string;
  task: string;
  reason?: string;
  rejectionNote?: string;
  regularEnd?: string;
  overtimeEnd?: string;
}

export interface AttendanceRecord {
  id: TenantId;
  staffId: TenantId;
  staffName: string;
  name: string;
  branchId?: TenantId | null;
  branchName?: string | null;
  organizationId?: TenantId | null;
  date: string;
  time: string;
  status:
    | "PRESENT"
    | "ABSENT"
    | "LATE"
    | "COMPLETED"
    | "left_early"
    | "Early Left"
    | string;
  createdAt: string;
  outTime?: string;
  workDuration?: string;
  checkOutStatus?: "ON_TIME" | "EARLY" | "OVERTIME" | "MISSING";
}

export interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  isAuthenticated: boolean;
  isLoading: boolean;
}
