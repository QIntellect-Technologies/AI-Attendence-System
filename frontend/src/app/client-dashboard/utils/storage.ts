import type {
  User,
  Staff,
  AttendanceRecord,
  OvertimeRequest,
} from "../types/types";

/**
 * Legacy localStorage adapter.
 *
 * Best-approach rule for the Supabase multi-tenant system:
 * - Do NOT seed demo users/staff.
 * - Do NOT use global keys shared by all organizations.
 * - Scope every legacy/local cache by current organization_id.
 *
 * Backend/Supabase remains the source of truth. These functions are kept only
 * for older UI helpers that still import storage.ts.
 */

type IdLike = string | number | null | undefined;

function safeJsonParse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function currentOrganizationId(): string {
  const user = safeJsonParse<Record<string, unknown>>(
    localStorage.getItem("currentUser"),
    {},
  );

  const orgId =
    user.organization_id ??
    user.organizationId ??
    user.org_id ??
    user.orgId ??
    null;

  const normalized = String(orgId ?? "").trim();
  return normalized || "no-org";
}

function scopedKey(key: string): string {
  return `qintellect:${currentOrganizationId()}:${key}`;
}

function legacyKey(key: string): string {
  return key;
}

function readArray<T>(key: string): T[] {
  // Prefer tenant-scoped cache. Legacy key is read only as a temporary fallback
  // for old local-only demo accounts that have no organization_id.
  const scoped = safeJsonParse<T[]>(localStorage.getItem(scopedKey(key)), []);
  if (scoped.length > 0 || currentOrganizationId() !== "no-org") return scoped;

  return safeJsonParse<T[]>(localStorage.getItem(legacyKey(key)), []);
}

function writeArray<T>(key: string, value: T[]): void {
  localStorage.setItem(scopedKey(key), JSON.stringify(value));
}

function idsEqual(a: IdLike, b: IdLike): boolean {
  const left = String(a ?? "").trim();
  const right = String(b ?? "").trim();
  return Boolean(left && right && left === right);
}

// --- Base Getters & Setters ---
export const getUsers = (): User[] => readArray<User>("users");
export const saveUsers = (users: User[]) => writeArray("users", users);

export const getStaff = (): Staff[] => readArray<Staff>("staff");
export const saveStaff = (staff: Staff[]) => writeArray("staff", staff);

export const getAttendance = (): AttendanceRecord[] =>
  readArray<AttendanceRecord>("attendance");
export const saveAttendance = (att: AttendanceRecord[]) =>
  writeArray("attendance", att);

// --- Leave & Overtime Storage Logic ---
export const getLeaveRequests = (): any[] => readArray<any>("leave_requests");
export const saveLeaveRequests = (requests: any[]) =>
  writeArray("leave_requests", requests);

export const getOvertimeRequests = (): OvertimeRequest[] =>
  readArray<OvertimeRequest>("overtime_requests");
export const saveOvertimeRequests = (requests: OvertimeRequest[]) =>
  writeArray("overtime_requests", requests);

// --- Leave & Overtime Actions ---
export const addLeaveRequest = (req: any) => {
  const all = getLeaveRequests();
  saveLeaveRequests([...all, req]);
};

export const updateLeaveStatus = (
  id: string | number,
  status: "Approved" | "Rejected",
) => {
  const all = getLeaveRequests();
  saveLeaveRequests(
    all.map((row) => (idsEqual(row.id, id) ? { ...row, status } : row)),
  );
};

export const addOvertimeRequest = (req: OvertimeRequest) => {
  const all = getOvertimeRequests();
  saveOvertimeRequests([...all, req]);
};

export const updateOvertimeStatus = (
  id: string | number,
  status: "Approved" | "Rejected",
) => {
  const all = getOvertimeRequests();
  saveOvertimeRequests(
    all.map((row) => (idsEqual(row.id, id) ? { ...row, status } : row)),
  );
};

// --- Work Duration & Overtime Logic ---
const calculateWorkStats = (
  inTime: string,
  outTime: string,
  shiftEnd: string,
) => {
  const start = new Date(`2024-01-01T${inTime}:00`);
  const end = new Date(`2024-01-01T${outTime}:00`);
  const sEnd = new Date(`2024-01-01T${shiftEnd}:00`);

  const diffMs = Math.max(end.getTime() - start.getTime(), 0);
  const hrs = Math.floor(diffMs / 3600000);
  const mins = Math.floor((diffMs % 3600000) / 60000);

  const duration = `${hrs}h ${mins}m`;
  let status: "EARLY" | "ON_TIME" | "OVERTIME" = "ON_TIME";

  if (end < sEnd) status = "EARLY";
  else if (end > sEnd) status = "OVERTIME";

  return { duration, status };
};

// --- CRUD Functions (legacy local fallback only) ---
export const addStaff = (staff: Staff, user: User) => {
  const normalizedStaff: Staff = {
    ...staff,
    shift: staff.shift || "Morning",
    shiftStart: staff.shiftStart || "09:00",
    shiftEnd: staff.shiftEnd || "18:00",
  };

  saveStaff([...getStaff(), normalizedStaff]);
  saveUsers([...getUsers(), user]);
};

export const updateStaff = (
  id: string | number,
  updatedStaff: Partial<Staff>,
) => {
  const staff = getStaff();

  saveStaff(
    staff.map((row) => {
      if (!idsEqual(row.id, id)) return row;

      return {
        ...row,
        ...updatedStaff,
        shift: updatedStaff.shift || row.shift || "Morning",
        shiftStart: updatedStaff.shiftStart || row.shiftStart || "09:00",
        shiftEnd: updatedStaff.shiftEnd || row.shiftEnd || "18:00",
      };
    }),
  );
};

export const deleteStaff = (id: string | number) => {
  const staff = getStaff();
  const member = staff.find((row) => idsEqual(row.id, id));

  saveStaff(staff.filter((row) => !idsEqual(row.id, id)));

  if (member) {
    saveUsers(getUsers().filter((user) => !idsEqual(user.id, member.userId)));
  }
};

// --- Helper Functions ---
export const getStaffById = (id: string | number): Staff | undefined => {
  return getStaff().find(
    (row) => idsEqual(row.id, id) || idsEqual(row.userId, id),
  );
};

export const getTodayAttendance = (staffId?: string | number) => {
  const today = new Date().toISOString().split("T")[0];
  const all = getAttendance();

  return staffId
    ? all.find((row) => idsEqual(row.staffId, staffId) && row.date === today)
    : all.filter((row) => row.date === today);
};

// --- Attendance Marking Logic ---
export const autoMarkFaceAttendance = (inputName: string) => {
  const staff = getStaff();
  const staffMember = staff.find(
    (row) => row.name.toLowerCase().trim() === inputName.toLowerCase().trim(),
  );

  if (!staffMember) return "Not Found";

  const today = new Date().toISOString().split("T")[0];
  const now = new Date().toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const allAtt = getAttendance();
  const existingIdx = allAtt.findIndex(
    (row) => idsEqual(row.staffId, staffMember.id) && row.date === today,
  );

  if (existingIdx === -1) {
    const newRecord: AttendanceRecord = {
      id: `att-${Date.now()}`,
      staffId: String(staffMember.id),
      staffName: staffMember.name,
      name: staffMember.name,
      date: today,
      time: now,
      status: "PRESENT",
      createdAt: new Date().toISOString(),
    };

    saveAttendance([...allAtt, newRecord]);
    return "Check-in Marked";
  }

  const record = allAtt[existingIdx];
  if (!record.outTime) {
    const stats = calculateWorkStats(
      record.time || "09:00",
      now,
      staffMember.shiftEnd || "18:00",
    );

    allAtt[existingIdx] = {
      ...record,
      outTime: now,
      workDuration: stats.duration,
      checkOutStatus: stats.status,
    };
    saveAttendance(allAtt);
    return `Check-out: ${stats.status}`;
  }

  return "Already Completed";
};
