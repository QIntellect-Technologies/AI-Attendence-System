// import React, { useCallback, useEffect, useState } from "react";
// import {
//   AlertCircle,
//   Calendar,
//   CheckCircle2,
//   Clock,
//   DoorOpen,
//   Loader2,
//   RefreshCw,
//   ShieldAlert,
//   Sun,
//   Trash2,
//   X,
// } from "lucide-react";
// import { localNodeApi, type HeldAttendanceRow } from "../api/localNodeApi";

// interface Props {
//   open: boolean;
//   onClose: () => void;
//   /** Called after any action that changes held_attendance_count, so the
//    * caller (App.tsx) can refresh its own status/badge instead of this
//    * panel owning that shared state. */
//   onChanged: () => void;
// }

// const TOKEN = {
//   teal: "#0d9488",
//   tealLight: "#f0fdfa",
//   tealBorder: "#99f6e4",
//   border: "#dbe7ef",
//   head: "#0f172a",
//   muted: "#64748b",
//   amber: "#b45309",
//   amberBg: "#fffbeb",
//   amberBorder: "#fde68a",
//   rose: "#be123c",
//   roseBg: "#fff1f2",
//   roseBorder: "#fecdd3",
// } as const;

// function initialsFor(name: string): string {
//   return (
//     name
//       .split(" ")
//       .map((part) => part[0] ?? "")
//       .join("")
//       .toUpperCase()
//       .slice(0, 2) || "?"
//   );
// }

// function formatSighted(row: HeldAttendanceRow): string {
//   const dt = new Date(
//     row.check_out_hold_reason
//       ? row.check_out_marked_at || row.marked_at
//       : row.marked_at,
//   );
//   return dt.toLocaleString(undefined, {
//     month: "short",
//     day: "numeric",
//     hour: "2-digit",
//     minute: "2-digit",
//   });
// }

// /** attendance_date is a plain YYYY-MM-DD (branch-local calendar day, see
//  * local_db._today()), not a full timestamp — parsed as UTC-midnight and
//  * re-rendered in that same literal day rather than through the browser's
//  * local timezone, so "Jul 15" always means the branch's Jul 15 regardless
//  * of what timezone the operator's browser is in. Held rows have no
//  * expiry, so this is the one field that tells the operator at a glance
//  * which day a stale-looking row actually belongs to. */
// function formatAttendanceDate(row: HeldAttendanceRow): string {
//   const dt = new Date(`${row.attendance_date}T00:00:00Z`);
//   if (Number.isNaN(dt.getTime())) return row.attendance_date;
//   return dt.toLocaleDateString(undefined, {
//     timeZone: "UTC",
//     month: "short",
//     day: "numeric",
//     year: "numeric",
//   });
// }

// type RowBadge = { label: string; style: React.CSSProperties };

// /** Three distinct hold cases share this one list, each needing its own
//  * label: an unconfirmed early check-in stray still waiting on its shift
//  * window, a late check-in held for an operator decision, or a held
//  * CHECKOUT sighting (early departure / late sighting). check_out_hold_reason
//  * takes priority when set, since a row only reaches the checkout leg after
//  * its check-in is already confirmed. */
// function badgeFor(row: HeldAttendanceRow): RowBadge {
//   if (row.check_out_hold_reason === "early") {
//     return { label: "Left early", style: styles.reasonBadgeEarly };
//   }
//   if (row.check_out_hold_reason === "late") {
//     return { label: "Left late", style: styles.reasonBadgeLate };
//   }
//   if (row.check_in_hold_reason === "late") {
//     return { label: "Late arrival", style: styles.reasonBadgeLate };
//   }
//   return { label: "Awaiting shift window", style: styles.reasonBadgeWaiting };
// }

// export default function HeldReviewPanel({ open, onClose, onChanged }: Props) {
//   const [rows, setRows] = useState<HeldAttendanceRow[]>([]);
//   const [loading, setLoading] = useState(false);
//   const [error, setError] = useState<string | null>(null);
//   const [selected, setSelected] = useState<Set<string>>(new Set());
//   const [busyAction, setBusyAction] = useState<
//     | "sync-selected"
//     | "delete-selected"
//     | `delete:${string}`
//     | `confirm-checkout:${string}`
//     | `half-day:${string}`
//     | `leave-open:${string}`
//     | `confirm-checkin:${string}`
//     | `half-day-checkin:${string}`
//     | null
//   >(null);

//   const load = useCallback(async () => {
//     setLoading(true);
//     setError(null);
//     try {
//       const res = await localNodeApi.heldAttendance();
//       setRows(res.held);
//       // Drop selections for rows that no longer exist (synced/deleted
//       // elsewhere) rather than silently keeping stale ids selected.
//       setSelected((current) => {
//         const stillPresent = new Set(res.held.map((r) => r.id));
//         const next = new Set<string>();
//         current.forEach((id) => {
//           if (stillPresent.has(id)) next.add(id);
//         });
//         return next;
//       });
//     } catch (err) {
//       setError(
//         err instanceof Error ? err.message : "Failed to load held detections.",
//       );
//     } finally {
//       setLoading(false);
//     }
//   }, []);

//   useEffect(() => {
//     if (open) void load();
//   }, [open, load]);

//   const toggleRow = (id: string) => {
//     setSelected((current) => {
//       const next = new Set(current);
//       if (next.has(id)) next.delete(id);
//       else next.add(id);
//       return next;
//     });
//   };

//   const toggleAll = () => {
//     setSelected((current) =>
//       current.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)),
//     );
//   };

//   const syncSelected = async () => {
//     if (selected.size === 0) return;
//     setBusyAction("sync-selected");
//     setError(null);
//     try {
//       await localNodeApi.syncSelectedAttendance(Array.from(selected));
//       setSelected(new Set());
//       await load();
//       onChanged();
//     } catch (err) {
//       setError(err instanceof Error ? err.message : "Sync failed.");
//     } finally {
//       setBusyAction(null);
//     }
//   };

//   const deleteSelected = async () => {
//     if (selected.size === 0) return;
//     const confirmed = window.confirm(
//       `Delete ${selected.size} held detection(s) from this node? This cannot be undone — none of these have been synced to the cloud.`,
//     );
//     if (!confirmed) return;
//     setBusyAction("delete-selected");
//     setError(null);
//     try {
//       await localNodeApi.deleteHeldAttendance(Array.from(selected));
//       setSelected(new Set());
//       await load();
//       onChanged();
//     } catch (err) {
//       setError(err instanceof Error ? err.message : "Delete failed.");
//     } finally {
//       setBusyAction(null);
//     }
//   };

//   const deleteOne = async (row: HeldAttendanceRow) => {
//     const confirmed = window.confirm(
//       `Delete ${row.staff_name}'s held detection from this node? This cannot be undone.`,
//     );
//     if (!confirmed) return;
//     setBusyAction(`delete:${row.id}`);
//     setError(null);
//     try {
//       await localNodeApi.deleteHeldAttendance([row.id]);
//       await load();
//       onChanged();
//     } catch (err) {
//       setError(err instanceof Error ? err.message : "Delete failed.");
//     } finally {
//       setBusyAction(null);
//     }
//   };

//   // The three checkout-hold resolution actions share one shape (resolve a
//   // single row, refresh the list, notify the parent) — only the API call
//   // and the busyAction/error-message strings differ, so they're built off
//   // one small runner instead of repeating the same try/catch three times.
//   const runCheckoutResolution = async (
//     row: HeldAttendanceRow,
//     busyKey:
//       | `confirm-checkout:${string}`
//       | `half-day:${string}`
//       | `leave-open:${string}`
//       | `confirm-checkin:${string}`
//       | `half-day-checkin:${string}`,
//     action: (ids: string[]) => Promise<{ resolved_count: number }>,
//     failureMessage: string,
//   ) => {
//     setBusyAction(busyKey);
//     setError(null);
//     try {
//       await action([row.id]);
//       await load();
//       onChanged();
//     } catch (err) {
//       setError(err instanceof Error ? err.message : failureMessage);
//     } finally {
//       setBusyAction(null);
//     }
//   };

//   const confirmCheckoutOne = (row: HeldAttendanceRow) =>
//     runCheckoutResolution(
//       row,
//       `confirm-checkout:${row.id}`,
//       localNodeApi.confirmHeldCheckouts,
//       "Confirm checkout failed.",
//     );

//   const markHalfDayOne = (row: HeldAttendanceRow) =>
//     runCheckoutResolution(
//       row,
//       `half-day:${row.id}`,
//       localNodeApi.markHeldCheckoutsHalfDay,
//       "Mark half-day failed.",
//     );

//   const leaveOpenOne = (row: HeldAttendanceRow) =>
//     runCheckoutResolution(
//       row,
//       `leave-open:${row.id}`,
//       localNodeApi.leaveHeldCheckoutsOpen,
//       "Leave open failed.",
//     );

//   // Check-in-leg counterpart: a late check-in sighting held for review
//   // resolves to either "confirm as check-in" (accept the sighted time as
//   // final) or "mark half-day" (no real check-in that day). Reuses the same
//   // runCheckoutResolution runner since the shape (one row, refresh, notify)
//   // is identical — only the API call and busy/error strings differ.
//   const confirmCheckInOne = (row: HeldAttendanceRow) =>
//     runCheckoutResolution(
//       row,
//       `confirm-checkin:${row.id}`,
//       localNodeApi.confirmHeldCheckIns,
//       "Confirm check-in failed.",
//     );

//   const markHalfDayCheckInOne = (row: HeldAttendanceRow) =>
//     runCheckoutResolution(
//       row,
//       `half-day-checkin:${row.id}`,
//       localNodeApi.markHeldCheckInsHalfDay,
//       "Mark half-day failed.",
//     );

//   if (!open) return null;

//   const allSelected = rows.length > 0 && selected.size === rows.length;
//   const anySelected = selected.size > 0;

//   return (
//     <div style={styles.overlay} role="dialog" aria-modal="true">
//       <div style={styles.modal}>
//         <div style={styles.header}>
//           <div style={styles.headerTitleRow}>
//             <ShieldAlert size={18} color={TOKEN.amber} />
//             <h2 style={styles.title}>Held for review</h2>
//             <span style={styles.countBadge}>{rows.length}</span>
//           </div>
//           <button
//             type="button"
//             onClick={onClose}
//             style={styles.iconButton}
//             aria-label="Close"
//           >
//             <X size={18} />
//           </button>
//         </div>

//         <p style={styles.helperText}>
//           These detections fell outside the person's shift window and were not
//           synced automatically — either a check-in outside the window, or a
//           checkout sighted early or late. Review who was sighted, then confirm,
//           resolve, sync, or delete each one.
//         </p>

//         <div style={styles.toolbar}>
//           <label style={styles.selectAllLabel}>
//             <input
//               type="checkbox"
//               checked={allSelected}
//               onChange={toggleAll}
//               disabled={rows.length === 0}
//               style={styles.checkbox}
//             />
//             Select all
//           </label>

//           <div style={styles.toolbarActions}>
//             <button
//               type="button"
//               onClick={() => void load()}
//               disabled={loading}
//               style={styles.refreshButton}
//               title="Refresh list"
//             >
//               <RefreshCw
//                 size={13}
//                 className={loading ? "hr-spin" : undefined}
//               />
//             </button>
//             <button
//               type="button"
//               onClick={() => void syncSelected()}
//               disabled={!anySelected || busyAction !== null}
//               style={{
//                 ...styles.syncSelectedButton,
//                 opacity: !anySelected || busyAction !== null ? 0.5 : 1,
//                 cursor:
//                   !anySelected || busyAction !== null
//                     ? "not-allowed"
//                     : "pointer",
//               }}
//             >
//               {busyAction === "sync-selected" ? (
//                 <Loader2 size={13} className="hr-spin" />
//               ) : (
//                 <RefreshCw size={13} />
//               )}
//               Sync selected{anySelected ? ` (${selected.size})` : ""}
//             </button>
//             <button
//               type="button"
//               onClick={() => void deleteSelected()}
//               disabled={!anySelected || busyAction !== null}
//               style={{
//                 ...styles.deleteSelectedButton,
//                 opacity: !anySelected || busyAction !== null ? 0.5 : 1,
//                 cursor:
//                   !anySelected || busyAction !== null
//                     ? "not-allowed"
//                     : "pointer",
//               }}
//             >
//               {busyAction === "delete-selected" ? (
//                 <Loader2 size={13} className="hr-spin" />
//               ) : (
//                 <Trash2 size={13} />
//               )}
//               Delete selected
//             </button>
//           </div>
//         </div>

//         {error && (
//           <div style={styles.errorBar}>
//             <AlertCircle size={14} /> {error}
//           </div>
//         )}

//         <div style={styles.list}>
//           <style>{SPIN_KEYFRAMES}</style>
//           {loading && rows.length === 0 ? (
//             <div style={styles.emptyState}>
//               <Loader2 size={20} className="hr-spin" color={TOKEN.teal} />
//               <p style={styles.emptyText}>Loading held detections…</p>
//             </div>
//           ) : rows.length === 0 ? (
//             <div style={styles.emptyState}>
//               <ShieldAlert size={22} color="#94a3b8" />
//               <p style={styles.emptyText}>
//                 Nothing is currently held for review. Detections outside a
//                 person's shift window will appear here.
//               </p>
//             </div>
//           ) : (
//             rows.map((row) => (
//               <div key={row.id} style={styles.row}>
//                 <input
//                   type="checkbox"
//                   checked={selected.has(row.id)}
//                   onChange={() => toggleRow(row.id)}
//                   style={styles.checkbox}
//                 />

//                 <div style={styles.avatarFallback}>
//                   {initialsFor(row.staff_name)}
//                 </div>

//                 <div style={styles.rowInfo}>
//                   <div style={styles.rowTopLine}>
//                     <span style={styles.rowName}>{row.staff_name}</span>
//                     <span
//                       style={{ ...styles.reasonBadge, ...badgeFor(row).style }}
//                     >
//                       {badgeFor(row).label}
//                     </span>
//                   </div>
//                   <div style={styles.rowMeta}>
//                     <span style={styles.rowMetaItem}>
//                       <Calendar size={11} /> {formatAttendanceDate(row)}
//                     </span>
//                     <span style={styles.rowMetaItem}>
//                       <Clock size={11} /> {formatSighted(row)}
//                     </span>
//                     {(row.camera_name || row.camera_id) && (
//                       <span style={styles.rowMetaItem}>
//                         · {row.camera_name || row.camera_id}
//                       </span>
//                     )}
//                     <span style={styles.rowMetaItem}>
//                       · ID {row.person_code}
//                     </span>
//                   </div>
//                   {row.notes && <div style={styles.rowNote}>{row.notes}</div>}

//                   {row.check_in_hold_reason === "late" && (
//                     <div style={styles.checkoutActionsRow}>
//                       <button
//                         type="button"
//                         onClick={() => void confirmCheckInOne(row)}
//                         disabled={busyAction !== null}
//                         style={styles.checkoutActionButton}
//                         title="Accept this sighting as the real check-in time"
//                       >
//                         {busyAction === `confirm-checkin:${row.id}` ? (
//                           <Loader2 size={12} className="hr-spin" />
//                         ) : (
//                           <CheckCircle2 size={12} />
//                         )}
//                         Confirm as check-in
//                       </button>

//                       <button
//                         type="button"
//                         onClick={() => void markHalfDayCheckInOne(row)}
//                         disabled={busyAction !== null}
//                         style={styles.halfDayActionButton}
//                         title="Don't count this as a check-in — mark this day as a half day"
//                       >
//                         {busyAction === `half-day-checkin:${row.id}` ? (
//                           <Loader2 size={12} className="hr-spin" />
//                         ) : (
//                           <Sun size={12} />
//                         )}
//                         Mark half-day
//                       </button>
//                     </div>
//                   )}

//                   {row.check_out_hold_reason && (
//                     <div style={styles.checkoutActionsRow}>
//                       <button
//                         type="button"
//                         onClick={() => void confirmCheckoutOne(row)}
//                         disabled={busyAction !== null}
//                         style={styles.checkoutActionButton}
//                         title="Accept this sighting as the real checkout time"
//                       >
//                         {busyAction === `confirm-checkout:${row.id}` ? (
//                           <Loader2 size={12} className="hr-spin" />
//                         ) : (
//                           <CheckCircle2 size={12} />
//                         )}
//                         Confirm as checkout
//                       </button>

//                       {row.check_out_hold_reason === "early" && (
//                         <button
//                           type="button"
//                           onClick={() => void markHalfDayOne(row)}
//                           disabled={busyAction !== null}
//                           style={styles.halfDayActionButton}
//                           title="No checkout recorded — mark this day as a half day"
//                         >
//                           {busyAction === `half-day:${row.id}` ? (
//                             <Loader2 size={12} className="hr-spin" />
//                           ) : (
//                             <Sun size={12} />
//                           )}
//                           Mark half-day
//                         </button>
//                       )}

//                       {row.check_out_hold_reason === "late" && (
//                         <button
//                           type="button"
//                           onClick={() => void leaveOpenOne(row)}
//                           disabled={busyAction !== null}
//                           style={styles.leaveOpenActionButton}
//                           title="No reliable checkout time — leave this day's checkout open"
//                         >
//                           {busyAction === `leave-open:${row.id}` ? (
//                             <Loader2 size={12} className="hr-spin" />
//                           ) : (
//                             <DoorOpen size={12} />
//                           )}
//                           Leave open
//                         </button>
//                       )}
//                     </div>
//                   )}
//                 </div>

//                 <button
//                   type="button"
//                   onClick={() => void deleteOne(row)}
//                   disabled={busyAction !== null}
//                   style={styles.rowDeleteButton}
//                   title={`Delete ${row.staff_name}'s held detection`}
//                 >
//                   {busyAction === `delete:${row.id}` ? (
//                     <Loader2 size={14} className="hr-spin" />
//                   ) : (
//                     <Trash2 size={14} />
//                   )}
//                 </button>
//               </div>
//             ))
//           )}
//         </div>

//         <div style={styles.footer}>
//           <button type="button" onClick={onClose} style={styles.closeButton}>
//             Close
//           </button>
//         </div>
//       </div>
//     </div>
//   );
// }

// const SPIN_KEYFRAMES = `
//   .hr-spin { animation: heldReviewSpin 0.9s linear infinite; }
//   @keyframes heldReviewSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
// `;

// const styles: Record<string, React.CSSProperties> = {
//   overlay: {
//     position: "fixed",
//     inset: 0,
//     zIndex: 50,
//     background: "rgba(15,23,42,0.45)",
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "center",
//     padding: 16,
//     boxSizing: "border-box",
//   },
//   // width uses min() so this never exceeds the viewport minus padding —
//   // the guard against horizontal overflow on narrow/embedded screens.
//   modal: {
//     width: "min(640px, 100%)",
//     maxHeight: "min(720px, calc(100vh - 32px))",
//     background: "#fff",
//     borderRadius: 18,
//     border: `1px solid ${TOKEN.border}`,
//     boxShadow: "0 24px 60px rgba(15,23,42,0.25)",
//     display: "flex",
//     flexDirection: "column",
//     minWidth: 0,
//     overflow: "hidden",
//   },
//   header: {
//     flexShrink: 0,
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "space-between",
//     padding: "16px 18px 0",
//   },
//   headerTitleRow: {
//     display: "flex",
//     alignItems: "center",
//     gap: 8,
//     minWidth: 0,
//   },
//   title: { margin: 0, fontSize: 16, fontWeight: 800, color: TOKEN.head },
//   countBadge: {
//     background: TOKEN.amberBg,
//     border: `1px solid ${TOKEN.amberBorder}`,
//     color: TOKEN.amber,
//     fontSize: 12,
//     fontWeight: 800,
//     padding: "1px 8px",
//     borderRadius: 20,
//   },
//   iconButton: {
//     border: "none",
//     background: "transparent",
//     color: TOKEN.muted,
//     cursor: "pointer",
//     padding: 6,
//     borderRadius: 8,
//     flexShrink: 0,
//   },
//   helperText: {
//     margin: "8px 18px 0",
//     color: TOKEN.muted,
//     fontSize: 12.5,
//     lineHeight: 1.55,
//   },
//   toolbar: {
//     flexShrink: 0,
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "space-between",
//     gap: 10,
//     flexWrap: "wrap",
//     padding: "12px 18px",
//     marginTop: 6,
//     borderBottom: `1px solid ${TOKEN.border}`,
//   },
//   selectAllLabel: {
//     display: "flex",
//     alignItems: "center",
//     gap: 7,
//     fontSize: 12.5,
//     fontWeight: 700,
//     color: TOKEN.head,
//     cursor: "pointer",
//     userSelect: "none",
//   },
//   checkbox: { width: 15, height: 15, accentColor: TOKEN.teal, flexShrink: 0 },
//   toolbarActions: {
//     display: "flex",
//     alignItems: "center",
//     gap: 8,
//     flexWrap: "wrap",
//   },
//   refreshButton: {
//     display: "inline-flex",
//     alignItems: "center",
//     justifyContent: "center",
//     border: `1px solid ${TOKEN.border}`,
//     background: "#fff",
//     color: TOKEN.muted,
//     borderRadius: 8,
//     width: 28,
//     height: 28,
//     cursor: "pointer",
//   },
//   syncSelectedButton: {
//     display: "inline-flex",
//     alignItems: "center",
//     gap: 6,
//     border: `1px solid ${TOKEN.tealBorder}`,
//     background: TOKEN.tealLight,
//     color: TOKEN.teal,
//     borderRadius: 20,
//     padding: "6px 12px",
//     fontSize: 12.5,
//     fontWeight: 800,
//   },
//   deleteSelectedButton: {
//     display: "inline-flex",
//     alignItems: "center",
//     gap: 6,
//     border: `1px solid ${TOKEN.roseBorder}`,
//     background: TOKEN.roseBg,
//     color: TOKEN.rose,
//     borderRadius: 20,
//     padding: "6px 12px",
//     fontSize: 12.5,
//     fontWeight: 800,
//   },
//   errorBar: {
//     flexShrink: 0,
//     display: "flex",
//     alignItems: "center",
//     gap: 8,
//     margin: "10px 18px 0",
//     border: `1px solid ${TOKEN.roseBorder}`,
//     background: TOKEN.roseBg,
//     color: TOKEN.rose,
//     borderRadius: 10,
//     padding: "8px 10px",
//     fontSize: 12.5,
//     fontWeight: 700,
//   },
//   list: {
//     flex: 1,
//     minHeight: 0,
//     overflowY: "auto",
//     overflowX: "hidden",
//     padding: 12,
//     display: "flex",
//     flexDirection: "column",
//     gap: 8,
//   },
//   row: {
//     display: "flex",
//     alignItems: "center",
//     gap: 10,
//     minWidth: 0,
//     border: `1px solid ${TOKEN.border}`,
//     borderRadius: 12,
//     padding: "10px 12px",
//     background: "#fafcfd",
//   },
//   avatarFallback: {
//     flexShrink: 0,
//     width: 36,
//     height: 36,
//     borderRadius: 10,
//     background: `linear-gradient(135deg, ${TOKEN.teal}, #1d8a84)`,
//     color: "#fff",
//     fontWeight: 800,
//     fontSize: 12.5,
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "center",
//   },
//   rowInfo: { flex: 1, minWidth: 0 },
//   rowTopLine: {
//     display: "flex",
//     alignItems: "center",
//     gap: 8,
//     flexWrap: "wrap",
//     minWidth: 0,
//   },
//   rowName: {
//     fontSize: 13.5,
//     fontWeight: 800,
//     color: TOKEN.head,
//     overflow: "hidden",
//     textOverflow: "ellipsis",
//     whiteSpace: "nowrap",
//     minWidth: 0,
//   },
//   reasonBadge: {
//     flexShrink: 0,
//     fontSize: 10.5,
//     fontWeight: 800,
//     padding: "2px 8px",
//     borderRadius: 20,
//     border: "1px solid",
//     whiteSpace: "nowrap",
//   },
//   reasonBadgeLate: {
//     background: TOKEN.amberBg,
//     borderColor: TOKEN.amberBorder,
//     color: TOKEN.amber,
//   },
//   reasonBadgeWaiting: {
//     background: "#f1f5f9",
//     borderColor: "#e2e8f0",
//     color: TOKEN.muted,
//   },
//   reasonBadgeEarly: {
//     background: "#eff6ff",
//     borderColor: "#bfdbfe",
//     color: "#1d4ed8",
//   },
//   rowMeta: {
//     display: "flex",
//     alignItems: "center",
//     flexWrap: "wrap",
//     gap: 4,
//     marginTop: 3,
//     fontSize: 11.5,
//     color: TOKEN.muted,
//   },
//   rowMetaItem: { display: "inline-flex", alignItems: "center", gap: 3 },
//   rowNote: {
//     marginTop: 4,
//     fontSize: 11.5,
//     fontStyle: "italic",
//     color: TOKEN.amber,
//     overflowWrap: "break-word",
//   },
//   checkoutActionsRow: {
//     display: "flex",
//     alignItems: "center",
//     gap: 6,
//     flexWrap: "wrap",
//     marginTop: 8,
//   },
//   checkoutActionButton: {
//     display: "inline-flex",
//     alignItems: "center",
//     gap: 5,
//     border: `1px solid ${TOKEN.tealBorder}`,
//     background: TOKEN.tealLight,
//     color: TOKEN.teal,
//     borderRadius: 16,
//     padding: "4px 10px",
//     fontSize: 11.5,
//     fontWeight: 800,
//     cursor: "pointer",
//   },
//   halfDayActionButton: {
//     display: "inline-flex",
//     alignItems: "center",
//     gap: 5,
//     border: `1px solid ${TOKEN.amberBorder}`,
//     background: TOKEN.amberBg,
//     color: TOKEN.amber,
//     borderRadius: 16,
//     padding: "4px 10px",
//     fontSize: 11.5,
//     fontWeight: 800,
//     cursor: "pointer",
//   },
//   leaveOpenActionButton: {
//     display: "inline-flex",
//     alignItems: "center",
//     gap: 5,
//     border: "1px solid #e2e8f0",
//     background: "#f8fafc",
//     color: TOKEN.muted,
//     borderRadius: 16,
//     padding: "4px 10px",
//     fontSize: 11.5,
//     fontWeight: 800,
//     cursor: "pointer",
//   },
//   rowDeleteButton: {
//     flexShrink: 0,
//     display: "inline-flex",
//     alignItems: "center",
//     justifyContent: "center",
//     border: `1px solid ${TOKEN.roseBorder}`,
//     background: "#fff",
//     color: TOKEN.rose,
//     borderRadius: 8,
//     width: 28,
//     height: 28,
//     cursor: "pointer",
//   },
//   emptyState: {
//     flex: 1,
//     display: "flex",
//     flexDirection: "column",
//     alignItems: "center",
//     justifyContent: "center",
//     gap: 10,
//     padding: "36px 20px",
//     textAlign: "center",
//   },
//   emptyText: {
//     margin: 0,
//     fontSize: 12.5,
//     color: TOKEN.muted,
//     maxWidth: 320,
//     lineHeight: 1.6,
//   },
//   footer: {
//     flexShrink: 0,
//     display: "flex",
//     justifyContent: "flex-end",
//     padding: "12px 18px",
//     borderTop: `1px solid ${TOKEN.border}`,
//   },
//   closeButton: {
//     border: `1px solid #cbd5e1`,
//     background: "#fff",
//     color: "#0f3557",
//     borderRadius: 10,
//     padding: "8px 16px",
//     fontWeight: 800,
//     fontSize: 13,
//     cursor: "pointer",
//   },
// };

import React, { useCallback, useEffect, useState } from "react";
import { confirmDestructive } from "../lib/confirmDialogue";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  Clock,
  DoorOpen,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sun,
  Timer,
  TrendingUp,
  Trash2,
  X,
} from "lucide-react";
import {
  localNodeApi,
  humanizeError,
  type HeldAttendanceRow,
} from "../api/localNodeApi";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Called after any action that changes held_attendance_count, so the
   * caller (App.tsx) can refresh its own status/badge instead of this
   * panel owning that shared state. */
  onChanged: () => void;
}

const TOKEN = {
  teal: "#0d9488",
  tealLight: "#f0fdfa",
  tealBorder: "#99f6e4",
  border: "#dbe7ef",
  head: "#0f172a",
  muted: "#64748b",
  amber: "#b45309",
  amberBg: "#fffbeb",
  amberBorder: "#fde68a",
  rose: "#be123c",
  roseBg: "#fff1f2",
  roseBorder: "#fecdd3",
} as const;

function initialsFor(name: string): string {
  return (
    name
      .split(" ")
      .map((part) => part[0] ?? "")
      .join("")
      .toUpperCase()
      .slice(0, 2) || "?"
  );
}

function formatSighted(row: HeldAttendanceRow): string {
  const dt = new Date(
    row.check_out_hold_reason
      ? row.check_out_marked_at || row.marked_at
      : row.marked_at,
  );
  return dt.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** attendance_date is a plain YYYY-MM-DD (branch-local calendar day, see
 * local_db._today()), not a full timestamp — parsed as UTC-midnight and
 * re-rendered in that same literal day rather than through the browser's
 * local timezone, so "Jul 15" always means the branch's Jul 15 regardless
 * of what timezone the operator's browser is in. Held rows have no
 * expiry, so this is the one field that tells the operator at a glance
 * which day a stale-looking row actually belongs to. */
function formatAttendanceDate(row: HeldAttendanceRow): string {
  const dt = new Date(`${row.attendance_date}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return row.attendance_date;
  return dt.toLocaleDateString(undefined, {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

type RowBadge = { label: string; style: React.CSSProperties };

/** Three distinct hold cases share this one list, each needing its own
 * label: an unconfirmed early check-in stray still waiting on its shift
 * window, a late check-in held for an operator decision, or a held
 * CHECKOUT sighting (early departure / late sighting). check_out_hold_reason
 * takes priority when set, since a row only reaches the checkout leg after
 * its check-in is already confirmed. */
const STATUS_LABELS: Record<string, string> = {
  late: "Late",
  half_day: "Half Day",
  short_leave: "Short Leave",
  overtime: "Overtime",
};

function badgeFor(row: HeldAttendanceRow): RowBadge {
  if (row.resolved) {
    const label = row.status
      ? (STATUS_LABELS[row.status] ?? row.status)
      : "Resolved";
    return { label: `Resolved: ${label}`, style: styles.reasonBadgeResolved };
  }
  if (row.check_out_hold_reason === "early") {
    return { label: "Left early", style: styles.reasonBadgeEarly };
  }
  if (row.check_out_hold_reason === "late") {
    return { label: "Left late", style: styles.reasonBadgeLate };
  }
  if (row.check_in_hold_reason === "late") {
    return { label: "Late arrival", style: styles.reasonBadgeLate };
  }
  return { label: "Awaiting shift window", style: styles.reasonBadgeWaiting };
}

export default function HeldReviewPanel({ open, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<HeldAttendanceRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busyAction, setBusyAction] = useState<
    | "sync-selected"
    | "delete-selected"
    | `delete:${string}`
    | `mark-late:${string}`
    | `overtime:${string}`
    | `half-day:${string}`
    | `short-leave:${string}`
    | `early-left:${string}`
    | `late-checkin:${string}`
    | `short-leave-checkin:${string}`
    | `half-day-checkin:${string}`
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await localNodeApi.heldAttendance();
      setRows(res.held);
      // Drop selections for rows that no longer exist (synced/deleted
      // elsewhere) rather than silently keeping stale ids selected.
      setSelected((current) => {
        const stillPresent = new Set(res.held.map((r) => r.id));
        const next = new Set<string>();
        current.forEach((id) => {
          if (stillPresent.has(id)) next.add(id);
        });
        return next;
      });
    } catch (err) {
      setError(humanizeError(err, "Failed to load held detections."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const toggleRow = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((current) =>
      current.size === rows.length ? new Set() : new Set(rows.map((r) => r.id)),
    );
  };

  const syncSelected = async () => {
    if (selected.size === 0) return;
    setBusyAction("sync-selected");
    setError(null);
    try {
      await localNodeApi.syncSelectedAttendance(Array.from(selected));
      setSelected(new Set());
      await load();
      onChanged();
    } catch (err) {
      setError(humanizeError(err, "Sync failed."));
    } finally {
      setBusyAction(null);
    }
  };

  const deleteSelected = async () => {
    if (selected.size === 0) return;
    const confirmed = await confirmDestructive({
      title: `Delete ${selected.size} held detection${selected.size === 1 ? "" : "s"}?`,
      text: "This cannot be undone — none of these have been synced to the cloud.",
    });
    if (!confirmed) return;
    setBusyAction("delete-selected");
    setError(null);
    try {
      await localNodeApi.deleteHeldAttendance(Array.from(selected));
      setSelected(new Set());
      await load();
      onChanged();
    } catch (err) {
      setError(humanizeError(err, "Delete failed."));
    } finally {
      setBusyAction(null);
    }
  };

  const deleteOne = async (row: HeldAttendanceRow) => {
    const confirmed = await confirmDestructive({
      title: `Delete ${row.staff_name}'s held detection?`,
      text: "This cannot be undone.",
    });
    if (!confirmed) return;
    setBusyAction(`delete:${row.id}`);
    setError(null);
    try {
      await localNodeApi.deleteHeldAttendance([row.id]);
      await load();
      onChanged();
    } catch (err) {
      setError(humanizeError(err, "Delete failed."));
    } finally {
      setBusyAction(null);
    }
  };

  // The held-checkout/check-in resolution actions share one shape (resolve
  // a single row, refresh the list, notify the parent) — only the API call
  // and the busyAction/error-message strings differ, so they're built off
  // one small runner instead of repeating the same try/catch each time.
  // There is deliberately no "confirm, no decision" runner and no defer
  // option anymore — every held row resolves immediately to one of exactly
  // two decisions for its hold_reason.
  const runCheckoutResolution = async (
    row: HeldAttendanceRow,
    busyKey:
      | `mark-late:${string}`
      | `overtime:${string}`
      | `half-day:${string}`
      | `short-leave:${string}`
      | `early-left:${string}`
      | `late-checkin:${string}`
      | `short-leave-checkin:${string}`
      | `half-day-checkin:${string}`,
    action: (ids: string[]) => Promise<{ resolved_count: number }>,
    failureMessage: string,
  ) => {
    setBusyAction(busyKey);
    setError(null);
    try {
      await action([row.id]);
      await load();
      onChanged();
    } catch (err) {
      setError(humanizeError(err, failureMessage));
    } finally {
      setBusyAction(null);
    }
  };

  // check_out_hold_reason='late' decisions — mirrors the office-staff
  // exception vocabulary (_CHECK_OUT_DECISIONS_BY_HOLD_REASON['late'] ==
  // {late, overtime} in support_db_attendance_exceptions.py): the person
  // WAS genuinely seen after their checkout window closed, and the
  // operator picks whether that's ordinary late-departure (admin decides
  // salary impact later) or overtime worked. The sighted timestamp is
  // accepted as the real checkout either way.
  const markLateCheckoutOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `mark-late:${row.id}`,
      localNodeApi.markHeldCheckoutsLate,
      "Mark late failed.",
    );

  const markOvertimeOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `overtime:${row.id}`,
      localNodeApi.markHeldCheckoutsOvertime,
      "Mark overtime failed.",
    );

  // check_out_hold_reason='early' decisions — half day (no checkout at
  // all that day) or short leave (left a bit early, less than a full
  // half day). Same restriction pattern as the 'late' pair above.
  const markHalfDayOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `half-day:${row.id}`,
      localNodeApi.markHeldCheckoutsHalfDay,
      "Mark half-day failed.",
    );

  const markShortLeaveOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `short-leave:${row.id}`,
      localNodeApi.markHeldCheckoutsShortLeave,
      "Mark short leave failed.",
    );

  // Third 'early' decision: the person really did leave early, and the
  // operator doesn't want to classify it as short_leave or half_day —
  // just record it and move on. Accepts the sighted time as the real
  // checkout but does NOT set a day status, only a note ("Early left"),
  // since status is the arrival-side classification.
  const markEarlyLeftOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `early-left:${row.id}`,
      localNodeApi.markHeldCheckoutsEarlyLeft,
      "Mark early left failed.",
    );

  // Check-in-leg counterpart: a late check-in sighting held for review
  // resolves to "mark late" (a genuine late arrival — accept the sighted
  // time as the real check-in, flag status='late'), "mark short leave"
  // (the late arrival reflects a manager-approved short leave earlier
  // that day — accept the sighted time, flag status='short_leave'), or
  // "mark half-day" (no real check-in that day) — same {late,
  // short_leave, half_day} trio the office-staff exception vocabulary
  // uses. Reuses the same runCheckoutResolution runner since the shape
  // (one row, refresh, notify) is identical — only the API call and
  // busy/error strings differ.
  const markLateCheckInOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `late-checkin:${row.id}`,
      localNodeApi.markHeldCheckInsLate,
      "Mark late failed.",
    );

  const markShortLeaveCheckInOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `short-leave-checkin:${row.id}`,
      localNodeApi.markHeldCheckInsShortLeave,
      "Mark short leave failed.",
    );

  const markHalfDayCheckInOne = (row: HeldAttendanceRow) =>
    runCheckoutResolution(
      row,
      `half-day-checkin:${row.id}`,
      localNodeApi.markHeldCheckInsHalfDay,
      "Mark half-day failed.",
    );

  if (!open) return null;

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const anySelected = selected.size > 0;

  return (
    <div style={styles.overlay} role="dialog" aria-modal="true">
      <div style={styles.modal}>
        <div style={styles.header}>
          <div style={styles.headerTitleRow}>
            <ShieldAlert size={18} color={TOKEN.amber} />
            <h2 style={styles.title}>Held for review</h2>
            <span style={styles.countBadge}>{rows.length}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={styles.iconButton}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <p style={styles.helperText}>
          These detections fell outside the person's shift window and were not
          synced automatically — either a check-in outside the window, or a
          checkout sighted early or late. Review who was sighted, then confirm,
          resolve, sync, or delete each one.
        </p>

        <div style={styles.toolbar}>
          <label style={styles.selectAllLabel}>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              disabled={rows.length === 0}
              style={styles.checkbox}
            />
            Select all
          </label>

          <div style={styles.toolbarActions}>
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              style={styles.refreshButton}
              title="Refresh list"
            >
              <RefreshCw
                size={13}
                className={loading ? "hr-spin" : undefined}
              />
            </button>
            <button
              type="button"
              onClick={() => void syncSelected()}
              disabled={!anySelected || busyAction !== null}
              style={{
                ...styles.syncSelectedButton,
                opacity: !anySelected || busyAction !== null ? 0.5 : 1,
                cursor:
                  !anySelected || busyAction !== null
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {busyAction === "sync-selected" ? (
                <Loader2 size={13} className="hr-spin" />
              ) : (
                <RefreshCw size={13} />
              )}
              Sync selected{anySelected ? ` (${selected.size})` : ""}
            </button>
            <button
              type="button"
              onClick={() => void deleteSelected()}
              disabled={!anySelected || busyAction !== null}
              style={{
                ...styles.deleteSelectedButton,
                opacity: !anySelected || busyAction !== null ? 0.5 : 1,
                cursor:
                  !anySelected || busyAction !== null
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {busyAction === "delete-selected" ? (
                <Loader2 size={13} className="hr-spin" />
              ) : (
                <Trash2 size={13} />
              )}
              Delete selected
            </button>
          </div>
        </div>

        {error && (
          <div style={styles.errorBar}>
            <AlertCircle size={14} /> {error}
          </div>
        )}

        <div style={styles.list}>
          <style>{SPIN_KEYFRAMES}</style>
          {loading && rows.length === 0 ? (
            <div style={styles.emptyState}>
              <Loader2 size={20} className="hr-spin" color={TOKEN.teal} />
              <p style={styles.emptyText}>Loading held detections…</p>
            </div>
          ) : rows.length === 0 ? (
            <div style={styles.emptyState}>
              <ShieldAlert size={22} color="#94a3b8" />
              <p style={styles.emptyText}>
                Nothing is currently held for review. Detections outside a
                person's shift window will appear here.
              </p>
            </div>
          ) : (
            rows.map((row) => (
              <div key={row.id} style={styles.row}>
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  onChange={() => toggleRow(row.id)}
                  disabled={!row.resolved}
                  title={
                    row.resolved
                      ? undefined
                      : "Make a decision for this row before syncing"
                  }
                  style={{
                    ...styles.checkbox,
                    opacity: row.resolved ? 1 : 0.4,
                  }}
                />

                <div style={styles.avatarFallback}>
                  {initialsFor(row.staff_name)}
                </div>

                <div style={styles.rowInfo}>
                  <div style={styles.rowTopLine}>
                    <span style={styles.rowName}>{row.staff_name}</span>
                    <span
                      style={{ ...styles.reasonBadge, ...badgeFor(row).style }}
                    >
                      {badgeFor(row).label}
                    </span>
                  </div>
                  <div style={styles.rowMeta}>
                    <span style={styles.rowMetaItem}>
                      <Calendar size={11} /> {formatAttendanceDate(row)}
                    </span>
                    <span style={styles.rowMetaItem}>
                      <Clock size={11} /> {formatSighted(row)}
                    </span>
                    {(row.camera_name || row.camera_id) && (
                      <span style={styles.rowMetaItem}>
                        · {row.camera_name || row.camera_id}
                      </span>
                    )}
                    <span style={styles.rowMetaItem}>
                      · ID {row.person_code}
                    </span>
                  </div>
                  {row.notes && <div style={styles.rowNote}>{row.notes}</div>}

                  {!row.resolved && row.check_in_hold_reason === "late" && (
                    <div style={styles.checkoutActionsRow}>
                      <button
                        type="button"
                        onClick={() => void markLateCheckInOne(row)}
                        disabled={busyAction !== null}
                        style={styles.lateActionButton}
                        title="A genuine late arrival — accept this sighting as the real check-in time"
                      >
                        {busyAction === `late-checkin:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <Timer size={12} />
                        )}
                        Mark late
                      </button>

                      <button
                        type="button"
                        onClick={() => void markShortLeaveCheckInOne(row)}
                        disabled={busyAction !== null}
                        style={styles.shortLeaveActionButton}
                        title="This late arrival reflects a manager-approved short leave — accept this sighting as the real check-in time"
                      >
                        {busyAction === `short-leave-checkin:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <DoorOpen size={12} />
                        )}
                        Mark short leave
                      </button>

                      <button
                        type="button"
                        onClick={() => void markHalfDayCheckInOne(row)}
                        disabled={busyAction !== null}
                        style={styles.halfDayActionButton}
                        title="Don't count this as a check-in — mark this day as a half day"
                      >
                        {busyAction === `half-day-checkin:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <Sun size={12} />
                        )}
                        Mark half-day
                      </button>
                    </div>
                  )}

                  {!row.resolved && row.check_out_hold_reason === "early" && (
                    <div style={styles.checkoutActionsRow}>
                      <button
                        type="button"
                        onClick={() => void markEarlyLeftOne(row)}
                        disabled={busyAction !== null}
                        style={styles.earlyLeftActionButton}
                        title="They really did leave early — accept this sighting as the real checkout time and just note it, without changing the day's status"
                      >
                        {busyAction === `early-left:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <DoorOpen size={12} />
                        )}
                        Early left
                      </button>

                      <button
                        type="button"
                        onClick={() => void markShortLeaveOne(row)}
                        disabled={busyAction !== null}
                        style={styles.shortLeaveActionButton}
                        title="Left a bit early, less than a full half day — accept this sighting as the real checkout time"
                      >
                        {busyAction === `short-leave:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <DoorOpen size={12} />
                        )}
                        Mark short leave
                      </button>

                      <button
                        type="button"
                        onClick={() => void markHalfDayOne(row)}
                        disabled={busyAction !== null}
                        style={styles.halfDayActionButton}
                        title="No checkout recorded — mark this day as a half day"
                      >
                        {busyAction === `half-day:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <Sun size={12} />
                        )}
                        Mark half-day
                      </button>
                    </div>
                  )}

                  {!row.resolved && row.check_out_hold_reason === "late" && (
                    <div style={styles.checkoutActionsRow}>
                      <button
                        type="button"
                        onClick={() => void markLateCheckoutOne(row)}
                        disabled={busyAction !== null}
                        style={styles.lateActionButton}
                        title="Genuinely seen after checkout window closed, but not overtime — accept this sighting as the real checkout time"
                      >
                        {busyAction === `mark-late:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <Timer size={12} />
                        )}
                        Mark late
                      </button>

                      <button
                        type="button"
                        onClick={() => void markOvertimeOne(row)}
                        disabled={busyAction !== null}
                        style={styles.overtimeActionButton}
                        title="This late departure is overtime worked — accept this sighting as the real checkout time"
                      >
                        {busyAction === `overtime:${row.id}` ? (
                          <Loader2 size={12} className="hr-spin" />
                        ) : (
                          <TrendingUp size={12} />
                        )}
                        Mark overtime
                      </button>
                    </div>
                  )}
                  {row.resolved && (
                    <div style={styles.resolvedRow}>
                      <CheckCircle2 size={12} color={TOKEN.teal} />
                      Decision recorded — select and sync to push to the cloud.
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  onClick={() => void deleteOne(row)}
                  disabled={busyAction !== null}
                  style={styles.rowDeleteButton}
                  title={`Delete ${row.staff_name}'s held detection`}
                >
                  {busyAction === `delete:${row.id}` ? (
                    <Loader2 size={14} className="hr-spin" />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </button>
              </div>
            ))
          )}
        </div>

        <div style={styles.footer}>
          <button type="button" onClick={onClose} style={styles.closeButton}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

const SPIN_KEYFRAMES = `
  .hr-spin { animation: heldReviewSpin 0.9s linear infinite; }
  @keyframes heldReviewSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
`;

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    background: "rgba(15,23,42,0.45)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    boxSizing: "border-box",
  },
  // width uses min() so this never exceeds the viewport minus padding —
  // the guard against horizontal overflow on narrow/embedded screens.
  modal: {
    width: "min(640px, 100%)",
    maxHeight: "min(720px, calc(100vh - 32px))",
    background: "#fff",
    borderRadius: 18,
    border: `1px solid ${TOKEN.border}`,
    boxShadow: "0 24px 60px rgba(15,23,42,0.25)",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    overflow: "hidden",
  },
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "16px 18px 0",
  },
  headerTitleRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    minWidth: 0,
  },
  title: { margin: 0, fontSize: 16, fontWeight: 800, color: TOKEN.head },
  countBadge: {
    background: TOKEN.amberBg,
    border: `1px solid ${TOKEN.amberBorder}`,
    color: TOKEN.amber,
    fontSize: 12,
    fontWeight: 800,
    padding: "1px 8px",
    borderRadius: 20,
  },
  iconButton: {
    border: "none",
    background: "transparent",
    color: TOKEN.muted,
    cursor: "pointer",
    padding: 6,
    borderRadius: 8,
    flexShrink: 0,
  },
  helperText: {
    margin: "8px 18px 0",
    color: TOKEN.muted,
    fontSize: 12.5,
    lineHeight: 1.55,
  },
  toolbar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    flexWrap: "wrap",
    padding: "12px 18px",
    marginTop: 6,
    borderBottom: `1px solid ${TOKEN.border}`,
  },
  selectAllLabel: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 12.5,
    fontWeight: 700,
    color: TOKEN.head,
    cursor: "pointer",
    userSelect: "none",
  },
  checkbox: { width: 15, height: 15, accentColor: TOKEN.teal, flexShrink: 0 },
  toolbarActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  refreshButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${TOKEN.border}`,
    background: "#fff",
    color: TOKEN.muted,
    borderRadius: 8,
    width: 28,
    height: 28,
    cursor: "pointer",
  },
  syncSelectedButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${TOKEN.tealBorder}`,
    background: TOKEN.tealLight,
    color: TOKEN.teal,
    borderRadius: 20,
    padding: "6px 12px",
    fontSize: 12.5,
    fontWeight: 800,
  },
  deleteSelectedButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: `1px solid ${TOKEN.roseBorder}`,
    background: TOKEN.roseBg,
    color: TOKEN.rose,
    borderRadius: 20,
    padding: "6px 12px",
    fontSize: 12.5,
    fontWeight: 800,
  },
  errorBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 8,
    margin: "10px 18px 0",
    border: `1px solid ${TOKEN.roseBorder}`,
    background: TOKEN.roseBg,
    color: TOKEN.rose,
    borderRadius: 10,
    padding: "8px 10px",
    fontSize: 12.5,
    fontWeight: 700,
  },
  list: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    overflowX: "hidden",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    minWidth: 0,
    border: `1px solid ${TOKEN.border}`,
    borderRadius: 12,
    padding: "10px 12px",
    background: "#fafcfd",
  },
  avatarFallback: {
    flexShrink: 0,
    width: 36,
    height: 36,
    borderRadius: 10,
    background: `linear-gradient(135deg, ${TOKEN.teal}, #1d8a84)`,
    color: "#fff",
    fontWeight: 800,
    fontSize: 12.5,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  rowInfo: { flex: 1, minWidth: 0 },
  rowTopLine: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    minWidth: 0,
  },
  rowName: {
    fontSize: 13.5,
    fontWeight: 800,
    color: TOKEN.head,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
  reasonBadge: {
    flexShrink: 0,
    fontSize: 10.5,
    fontWeight: 800,
    padding: "2px 8px",
    borderRadius: 20,
    border: "1px solid",
    whiteSpace: "nowrap",
  },
  reasonBadgeLate: {
    background: TOKEN.amberBg,
    borderColor: TOKEN.amberBorder,
    color: TOKEN.amber,
  },
  reasonBadgeWaiting: {
    background: "#f1f5f9",
    borderColor: "#e2e8f0",
    color: TOKEN.muted,
  },
  reasonBadgeEarly: {
    background: "#eff6ff",
    borderColor: "#bfdbfe",
    color: "#1d4ed8",
  },
  reasonBadgeResolved: {
    background: TOKEN.tealLight,
    borderColor: TOKEN.tealBorder,
    color: TOKEN.teal,
  },
  resolvedRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    marginTop: 8,
    fontSize: 11.5,
    fontWeight: 700,
    color: TOKEN.teal,
  },
  rowMeta: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 3,
    fontSize: 11.5,
    color: TOKEN.muted,
  },
  rowMetaItem: { display: "inline-flex", alignItems: "center", gap: 3 },
  rowNote: {
    marginTop: 4,
    fontSize: 11.5,
    fontStyle: "italic",
    color: TOKEN.amber,
    overflowWrap: "break-word",
  },
  checkoutActionsRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    marginTop: 8,
  },
  lateActionButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: `1px solid ${TOKEN.tealBorder}`,
    background: TOKEN.tealLight,
    color: TOKEN.teal,
    borderRadius: 16,
    padding: "4px 10px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
  },
  overtimeActionButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: "1px solid #c7d2fe",
    background: "#eef2ff",
    color: "#4338ca",
    borderRadius: 16,
    padding: "4px 10px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
  },
  shortLeaveActionButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: "1px solid #bae6fd",
    background: "#f0f9ff",
    color: "#0369a1",
    borderRadius: 16,
    padding: "4px 10px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
  },
  earlyLeftActionButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: "1px solid #bfdbfe",
    background: "#eff6ff",
    color: "#1d4ed8",
    borderRadius: 16,
    padding: "4px 10px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
  },
  halfDayActionButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: `1px solid ${TOKEN.amberBorder}`,
    background: TOKEN.amberBg,
    color: TOKEN.amber,
    borderRadius: 16,
    padding: "4px 10px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: "pointer",
  },
  rowDeleteButton: {
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${TOKEN.roseBorder}`,
    background: "#fff",
    color: TOKEN.rose,
    borderRadius: 8,
    width: 28,
    height: 28,
    cursor: "pointer",
  },
  emptyState: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: "36px 20px",
    textAlign: "center",
  },
  emptyText: {
    margin: 0,
    fontSize: 12.5,
    color: TOKEN.muted,
    maxWidth: 320,
    lineHeight: 1.6,
  },
  footer: {
    flexShrink: 0,
    display: "flex",
    justifyContent: "flex-end",
    padding: "12px 18px",
    borderTop: `1px solid ${TOKEN.border}`,
  },
  closeButton: {
    border: `1px solid #cbd5e1`,
    background: "#fff",
    color: "#0f3557",
    borderRadius: 10,
    padding: "8px 16px",
    fontWeight: 800,
    fontSize: 13,
    cursor: "pointer",
  },
};
