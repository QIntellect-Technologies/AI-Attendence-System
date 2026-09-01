/**
 * Single source of truth for backend route paths used by the API tier.
 * All confirmed directly against app.py (2026-08-31) — no guessed paths.
 *
 * Auth note: every route below except /login requires the Bearer token
 * from auth.ts's loginAndGetToken(). org_id/branch_id are almost never
 * read from query params — the backend derives them from the verified
 * token itself (g.dashboard_user['org_id']) as a deliberate security
 * fix. bootstrap is the one notable exception: it still reads
 * organization_id from the query string, then checks it against the
 * token's own org.
 *
 * NOTE: /api/staff/attendance/mark (referenced in the attendance-pipeline
 * area notes) is NOT in app.py — it must live in one of the imported
 * blueprints (client_staff_attendance_bp or client_field_attendance_bp).
 * Left out here rather than guessed; paste those blueprint files and
 * I'll add it correctly.
 */
export const ENDPOINTS = {
  // Auth
  login: '/api/login',
  logout: '/api/client/auth/logout',

  // Bootstrap / session (bootstrap is the one route that still reads
  // organization_id from the query string, checked against the token)
  bootstrap: '/api/client/bootstrap',
  clientSession: (userId: string) => `/api/client/session/${userId}`,

  // Attendance — attendanceToday is the exact route from today's 404
  // incident: real path is /api/attendance/today, NOT /attendance/today
  // and NOT /api/client/attendance/today.
  attendanceToday: '/api/attendance/today',
  attendanceLogs: '/api/attendance/logs',
  attendanceMarkAbsent: '/api/attendance/mark-absent',
  attendanceManual: '/api/attendance/manual',
  attendanceRecord: (id: string) => `/api/attendance/${id}`,
  attendanceExceptions: '/api/client/attendance/exceptions',

  // Staff
  staffList: '/api/staff',
  staffArchived: '/api/staff/archived',
  staffDetail: (id: string) => `/api/staff/${id}`,

  // Leaves
  leaves: '/api/leaves',
  leaveTypes: '/api/leaves/types',
  leaveDetail: (id: string) => `/api/leaves/${id}`,

  // Overtime
  overtime: '/api/overtime',
  overtimeDetail: (id: string) => `/api/overtime/${id}`,

  // Payroll
  payrollPolicy: '/api/payroll/policy',
  payrollMarkPaid: '/api/payroll/mark-paid',
  payrollMarkPending: '/api/payroll/mark-pending',
  payrollPageV2: '/api/v2/payroll/page',
  salary: '/api/salary',
  salaryDetail: (userId: string) => `/api/salary/${userId}`,

  // Dashboard aggregates
  dashboardOverviewV2: '/api/v2/dashboard/overview',
  tenantSummary: '/api/tenant/summary',
  tenantSummaryV2: '/api/v2/tenant/summary',
  branchesSummary: '/api/branches/summary',

  // Cameras / live detection
  cameras: '/api/cameras',
  cctvLiveTracking: '/api/cctv/live-tracking',
  liveDetections: '/api/live-detections',
  streamToken: '/api/stream/token',

  // Notifications
  notifications: '/api/notifications',
  notificationsUnreadCount: '/api/notifications/unread-count',

  // Health (no auth required — good canary check)
  health: '/api/health',
  systemHealth: '/api/system/health',
} as const;
