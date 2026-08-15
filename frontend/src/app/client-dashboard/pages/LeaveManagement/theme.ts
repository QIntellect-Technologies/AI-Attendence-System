/**
 * modules/leave/theme.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Design tokens shared across the Leave Management module (the "Leaves"
 * table in LeaveManagement.tsx and the "Leave History" table in
 * LeaveHistoryTable.tsx).
 *
 * This lives in its own module — not re-exported from LeaveManagement.tsx
 * — specifically to avoid a circular import: LeaveManagement.tsx imports
 * LeaveHistoryTable.tsx (to render the History tab), so if
 * LeaveHistoryTable.tsx imported T back from LeaveManagement.tsx, the two
 * modules would import each other. ES module circular imports don't
 * necessarily fail, but they made LeaveHistoryTable.tsx's module-level
 * `thStyle`/`tdStyle` (which read `T.textLight` etc. at module-evaluation
 * time, not render time) execute before LeaveManagement.tsx had finished
 * initializing its `T` export, throwing "Cannot access 'T' before
 * initialization". Giving T its own leaf module with no dependents in
 * this cycle removes the ordering problem entirely rather than working
 * around it.
 */

export const T = {
  teal600: "#0d9488",
  teal50: "#f0fdfa",
  teal100: "#ccfbf1",
  navy700: "#134471",
  slate50: "#f8fafc",
  slate100: "#f1f5f9",
  slate200: "#e2e8f0",
  green600: "#16a34a",
  green100: "#f0fdf4",
  red600: "#e11d48",
  red100: "#fff1f2",
  amber600: "#d97706",
  amber100: "#fffbeb",
  bgPage: "#f5f6fa",
  bgCard: "#ffffff",
  border: "#e2e8f0",
  textHeading: "#1a699f",
  textBody: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  shadow: "0 1px 3px rgba(15,45,74,0.07),0 1px 2px rgba(15,45,74,0.04)",
} as const;

export default T;
