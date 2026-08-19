// import React, { useMemo } from "react";
// import {
//   Activity,
//   CloudOff,
//   Loader2,
//   RefreshCw,
//   ShieldAlert,
//   Trash2,
// } from "lucide-react";
// import type { LiveAttendanceEventView } from "./types";

// interface Props {
//   events: LiveAttendanceEventView[];
//   heldCount?: number;
//   syncing?: boolean;
//   onSync?: () => void;
//   clearing?: boolean;
//   onClear?: () => void;
//   onOpenHeldReview?: () => void;
// }

// const TOKEN = {
//   teal: "#0d9488",
//   tealLight: "#f0fdfa",
//   tealBorder: "#99f6e4",
//   border: "#dbe7ef",
//   head: "#0f172a",
//   muted: "#64748b",
//   matched: "#16a34a",
//   matchedBg: "#f0fdf4",
//   matchedBorder: "#bbf7d0",
//   unknown: "#dc2626",
//   unknownBg: "#fef2f2",
//   unknownBorder: "#fecaca",
// } as const;

// const LIVE_WINDOW_MS = 60_000;

// const SPIN_KEYFRAMES = `
//   .spin { animation: liveAttendanceSpin 0.9s linear infinite; }
//   @keyframes liveAttendanceSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

//   .qa-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
//   .qa-actions-group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
//   .qa-btn {
//     display: inline-flex; align-items: center; justify-content: center; gap: 6px;
//     flex: 1 1 132px; min-width: 0; white-space: nowrap;
//     border-radius: 10px; font-size: 12px; font-weight: 800; letter-spacing: 0.1px;
//     padding: 8px 12px; cursor: pointer; transition: background-color 0.15s ease,
//     border-color 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
//   }
//   .qa-btn span.qa-btn-label { overflow: hidden; text-overflow: ellipsis; }
//   .qa-btn:active:not(:disabled) { transform: translateY(1px); }
//   .qa-btn:focus-visible { outline: 2px solid #0d9488; outline-offset: 2px; }
//   .qa-btn:disabled { opacity: 0.55; cursor: not-allowed; }

//   .qa-btn--sync { border: 1px solid #99f6e4; background: #f0fdfa; color: #0d9488; }
//   .qa-btn--sync:hover:not(:disabled) { background: #ccfbf1; border-color: #5eead4; box-shadow: 0 1px 2px rgba(13,148,136,0.15); }

//   .qa-btn--held { border: 1px solid #fde68a; background: #fffbeb; color: #b45309; }
//   .qa-btn--held:hover:not(:disabled) { background: #fef3c7; border-color: #fcd34d; box-shadow: 0 1px 2px rgba(180,83,9,0.15); }

//   .qa-btn--clear { border: 1px solid #e2e8f0; background: #fff; color: #64748b; flex: 0 1 auto; }
//   .qa-btn--clear:hover:not(:disabled) { background: #fef2f2; border-color: #fecaca; color: #be123c; }

//   @media (max-width: 340px) {
//     .qa-btn { flex-basis: 100%; }
//   }
// `;

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

// /** Single source of truth for the status badge text. event.status now
//  * carries "checked_in" / "checked_out" (see camera_stream_manager.py's
//  * _detect_and_record) — this is where that finally surfaces in the UI,
//  * instead of the old one-size-fits-all "Marked present". Unrecognized/
//  * legacy status values (e.g. events still in the feed from before this
//  * change) fall back to the previous wording rather than showing nothing. */
// function describeStatus(event: LiveAttendanceEventView): string {
//   const status = event.status.toLowerCase();
//   const synced = event.sync_status === "synced";

//   if (status === "checked_out")
//     return synced ? "✓ Checked out · Synced" : "✓ Checked out";
//   if (status === "checked_in")
//     return synced ? "✓ Checked in · Synced" : "✓ Checked in";
//   return synced ? "✓ Synced to cloud" : "✓ Marked present";
// }

// /**
//  * `notes` on the wire is the FULL day's merged string, one line per leg,
//  * tagged by local_db.py's _merge_note ("Check-in: ...", "Check-out: ...").
//  * A single card only ever reports on ONE leg — rendering the whole blob
//  * leaks the OTHER leg's (often hours-stale) note onto this card, e.g. a
//  * "Checked out" card still showing the morning's "late check-in, awaiting
//  * operator decision" text, because a normal in-window checkout clears its
//  * OWN note line (nothing exceptional to report) while the check-in line
//  * is still sitting in the same string. This pulls out only the line for
//  * the leg this card is actually reporting on, and falls back to a plain
//  * "Checked out at <time>" when that leg genuinely has no note (the
//  * ordinary, unexceptional case) instead of silently borrowing the other
//  * leg's text.
//  */
// function noteForLeg(
//   notes: string | null | undefined,
//   status: string,
//   time: string,
// ): string | null {
//   const prefix = status === "checked_out" ? "Check-out: " : "Check-in: ";
//   const line = (notes || "").split("\n").find((l) => l.startsWith(prefix));
//   if (line) return line.slice(prefix.length);
//   return status === "checked_out" ? `Checked out at ${time}.` : null;
// }

// function DetectionCard({ event }: { event: LiveAttendanceEventView }) {
//   const failed = event.status.toLowerCase() === "failed";
//   const status = event.status.toLowerCase();
//   const pct = Math.round((Number(event.confidence) || 0) * 100);
//   const time = new Date(event.marked_at).toLocaleTimeString("en-US", {
//     hour: "2-digit",
//     minute: "2-digit",
//     second: "2-digit",
//   });
//   const legNote = noteForLeg(event.notes, status, time);

//   return (
//     <div style={styles.card}>
//       <div
//         style={{
//           ...styles.accentStrip,
//           background: failed ? TOKEN.unknown : TOKEN.teal,
//         }}
//       />
//       <div style={styles.cardBody}>
//         <div style={styles.cardTopRow}>
//           <div style={styles.avatarWrap}>
//             {event.snapshot ? (
//               <img
//                 src={`data:image/jpeg;base64,${event.snapshot}`}
//                 alt={event.name}
//                 style={styles.avatarImg}
//               />
//             ) : (
//               <div style={styles.avatarFallback}>{initialsFor(event.name)}</div>
//             )}
//             <span
//               style={{
//                 ...styles.presenceDot,
//                 background: failed ? "#94a3b8" : "#22c55e",
//               }}
//             />
//           </div>

//           <div style={styles.cardInfo}>
//             <div style={styles.cardName}>{event.name}</div>
//             <div style={styles.cardMeta}>
//               {time}
//               {event.camera_name || event.camera_id
//                 ? ` · ${event.camera_name || event.camera_id}`
//                 : ""}
//             </div>
//           </div>
//         </div>

//         <div style={styles.cardDivider} />

//         {legNote && <div style={styles.noteLine}>{legNote}</div>}

//         <div style={{ display: "flex", justifyContent: "flex-end" }}>
//           <div
//             style={{
//               ...styles.statusBadge,
//               background: failed ? TOKEN.unknownBg : TOKEN.matchedBg,
//               borderColor: failed ? TOKEN.unknownBorder : TOKEN.matchedBorder,
//               color: failed ? TOKEN.unknown : TOKEN.matched,
//             }}
//           >
//             {failed ? "⚠ Sync failed" : describeStatus(event)}
//           </div>
//         </div>
//       </div>
//     </div>
//   );
// }

// export default function LiveAttendancePanel({
//   events,
//   heldCount = 0,
//   syncing = false,
//   onSync,
//   clearing = false,
//   onClear,
//   onOpenHeldReview,
// }: Props) {
//   // Derived from the node's own /api/live-events feed. There is no
//   // /api/stats endpoint on the local node (unlike the cloud dashboard), so
//   // these are computed client-side from data the node actually returns.
//   const stats = useMemo(() => {
//     const now = Date.now();
//     let live = 0;
//     let synced = 0;
//     let pending = 0;
//     for (const event of events) {
//       if (now - new Date(event.marked_at).getTime() <= LIVE_WINDOW_MS)
//         live += 1;
//       if (event.sync_status === "synced") synced += 1;
//       if (event.sync_status === "pending") pending += 1;
//     }
//     return { live, synced, pending, total: events.length };
//   }, [events]);

//   const statItems = [
//     { value: stats.total, color: TOKEN.teal, label: "Events" },
//     { value: stats.synced, color: "#22c55e", label: "Synced" },
//     { value: stats.pending, color: "#b45309", label: "Pending" },
//     { value: stats.live, color: "#ef4444", label: "Live" },
//   ];

//   return (
//     <section style={styles.panel}>
//       <style>{SPIN_KEYFRAMES}</style>
//       <div style={styles.header}>
//         <div style={styles.accentBar} />
//         <div style={styles.headerRow}>
//           <div style={styles.headerTitle}>Attendance Monitor</div>
//           <div style={styles.liveBadge}>
//             <span style={styles.liveDot} />
//             LIVE
//           </div>
//         </div>
//         <div style={styles.statGrid}>
//           {statItems.map((item, index) => (
//             <div
//               key={item.label}
//               style={{
//                 ...styles.statCell,
//                 borderLeft: index > 0 ? `1px solid ${TOKEN.border}` : "none",
//               }}
//             >
//               <span style={{ ...styles.statCellValue, color: item.color }}>
//                 {item.value}
//               </span>
//               <span style={styles.statCellLabel}>{item.label}</span>
//             </div>
//           ))}
//         </div>
//       </div>

//       {(onOpenHeldReview || onSync || onClear) && (
//         <div style={styles.actionsBar}>
//           <div className="qa-actions">
//             <div className="qa-actions-group">
//               {onOpenHeldReview && (
//                 <button
//                   type="button"
//                   className="qa-btn qa-btn--held"
//                   onClick={onOpenHeldReview}
//                   title="Review detections held for manual approval"
//                 >
//                   <ShieldAlert size={13} />
//                   <span className="qa-btn-label">Held for review</span>
//                   {heldCount > 0 && (
//                     <span style={styles.heldBadge}>{heldCount}</span>
//                   )}
//                 </button>
//               )}
//               {onSync && (
//                 <button
//                   type="button"
//                   className="qa-btn qa-btn--sync"
//                   onClick={onSync}
//                   disabled={syncing}
//                   title={
//                     heldCount > 0
//                       ? `${heldCount} attendance record(s) held for review — sync pushes those too`
//                       : "Push any pending attendance to the cloud now"
//                   }
//                 >
//                   <RefreshCw
//                     size={13}
//                     className={syncing ? "spin" : undefined}
//                   />
//                   <span className="qa-btn-label">Sync attendance</span>
//                   {heldCount > 0 && (
//                     <span style={styles.syncBadge}>{heldCount}</span>
//                   )}
//                 </button>
//               )}
//             </div>
//             {onClear && (
//               <button
//                 type="button"
//                 className="qa-btn qa-btn--clear"
//                 onClick={onClear}
//                 disabled={clearing}
//                 title="Delete today's attendance on this node (local only — does not remove anything already synced to the cloud)"
//               >
//                 {clearing ? (
//                   <Loader2 size={13} className="spin" />
//                 ) : (
//                   <Trash2 size={13} />
//                 )}
//                 <span className="qa-btn-label">Clear today</span>
//               </button>
//             )}
//           </div>
//         </div>
//       )}

//       <div style={styles.toolbar}>
//         <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
//           <span style={styles.toolbarLabel}>Detections</span>
//           <span style={styles.toolbarBadge}>{events.length}</span>
//         </div>
//         <Activity size={14} color={TOKEN.muted} />
//       </div>

//       <div style={styles.feed}>
//         {events.length === 0 ? (
//           <div style={styles.empty}>
//             <div style={styles.emptyIcon}>
//               <CloudOff size={22} />
//             </div>
//             <p style={styles.emptyTitle}>No detections yet</p>
//             <p style={styles.emptySubtitle}>
//               When a trained face is recognized, this screen will confirm local
//               marking and cloud sync.
//             </p>
//           </div>
//         ) : (
//           events.map((event) => <DetectionCard key={event.id} event={event} />)
//         )}
//       </div>
//     </section>
//   );
// }

// const styles: Record<string, React.CSSProperties> = {
//   panel: {
//     width: "100%",
//     height: "100%",
//     minHeight: 0,
//     border: `1px solid ${TOKEN.border}`,
//     borderRadius: 18,
//     background: "#fff",
//     display: "flex",
//     flexDirection: "column",
//     overflow: "hidden",
//   },
//   header: {
//     flexShrink: 0,
//     padding: "14px 16px 0",
//     borderBottom: `1px solid ${TOKEN.border}`,
//   },
//   accentBar: {
//     height: 3,
//     background: `linear-gradient(90deg, ${TOKEN.teal} 0%, #2ee8c0 60%, ${TOKEN.teal} 100%)`,
//     borderRadius: "2px 2px 0 0",
//     marginBottom: 12,
//   },
//   headerRow: {
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "space-between",
//     marginBottom: 12,
//   },
//   headerTitle: { fontSize: "0.9em", fontWeight: 800, color: TOKEN.head },
//   liveBadge: {
//     display: "flex",
//     alignItems: "center",
//     gap: 5,
//     background: "#dcfce7",
//     border: "1px solid #bbf7d0",
//     color: "#15803d",
//     fontSize: "0.65em",
//     fontWeight: 800,
//     padding: "3px 9px",
//     borderRadius: 20,
//     letterSpacing: "0.8px",
//   },
//   liveDot: { width: 5, height: 5, background: "#22c55e", borderRadius: "50%" },
//   actionsBar: {
//     flexShrink: 0,
//     padding: "10px 16px",
//     borderBottom: `1px solid ${TOKEN.border}`,
//     background: "#fafcfd",
//   },
//   heldBadge: {
//     display: "inline-flex",
//     alignItems: "center",
//     justifyContent: "center",
//     minWidth: 15,
//     height: 15,
//     padding: "0 4px",
//     borderRadius: 20,
//     background: "#b45309",
//     color: "#fff",
//     fontSize: "0.85em",
//   },
//   syncBadge: {
//     display: "inline-flex",
//     alignItems: "center",
//     justifyContent: "center",
//     minWidth: 15,
//     height: 15,
//     padding: "0 4px",
//     borderRadius: 20,
//     background: "#b45309",
//     color: "#fff",
//     fontSize: "0.85em",
//   },
//   statGrid: {
//     display: "grid",
//     gridTemplateColumns: "repeat(4,1fr)",
//     marginBottom: 14,
//   },
//   statCell: {
//     display: "flex",
//     flexDirection: "column",
//     alignItems: "center",
//     gap: 2,
//     padding: "0 4px",
//   },
//   statCellValue: { fontSize: "1.3em", fontWeight: 800, lineHeight: 1 },
//   statCellLabel: {
//     fontSize: "0.55em",
//     fontWeight: 600,
//     color: TOKEN.muted,
//     textTransform: "uppercase",
//     letterSpacing: "0.5px",
//   },
//   toolbar: {
//     flexShrink: 0,
//     padding: "9px 14px",
//     borderBottom: `1px solid ${TOKEN.border}`,
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "space-between",
//   },
//   toolbarLabel: {
//     fontSize: "0.78em",
//     fontWeight: 800,
//     color: TOKEN.head,
//     textTransform: "uppercase",
//     letterSpacing: "0.4px",
//   },
//   toolbarBadge: {
//     background: TOKEN.teal,
//     color: "#fff",
//     fontSize: "0.68em",
//     fontWeight: 800,
//     padding: "2px 8px",
//     borderRadius: 20,
//     minWidth: 22,
//     textAlign: "center",
//   },
//   feed: {
//     flex: 1,
//     minHeight: 0,
//     overflowY: "auto",
//     padding: 10,
//     display: "grid",
//     gap: 10,
//     alignContent: "start",
//   },
//   card: {
//     display: "flex",
//     border: `1px solid ${TOKEN.border}`,
//     borderRadius: 14,
//     overflow: "hidden",
//     background: "#fff",
//   },
//   accentStrip: { width: 4, flexShrink: 0 },
//   cardBody: {
//     flex: 1,
//     padding: "12px 14px",
//     display: "flex",
//     flexDirection: "column",
//     gap: 8,
//   },
//   cardTopRow: { display: "flex", alignItems: "center", gap: 12 },
//   avatarWrap: { position: "relative", flexShrink: 0 },
//   avatarImg: {
//     width: 46,
//     height: 46,
//     borderRadius: 10,
//     objectFit: "cover",
//     border: `1px solid ${TOKEN.border}`,
//   },
//   avatarFallback: {
//     width: 46,
//     height: 46,
//     borderRadius: 10,
//     background: `linear-gradient(135deg, ${TOKEN.teal}, #1d8a84)`,
//     color: "#fff",
//     fontWeight: 800,
//     fontSize: "0.9em",
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "center",
//   },
//   presenceDot: {
//     position: "absolute",
//     bottom: -2,
//     right: -2,
//     width: 12,
//     height: 12,
//     borderRadius: "50%",
//     border: "2px solid #fff",
//   },
//   cardInfo: { flex: 1, minWidth: 0 },
//   cardName: {
//     fontSize: "0.92em",
//     fontWeight: 800,
//     color: TOKEN.head,
//     whiteSpace: "nowrap",
//     overflow: "hidden",
//     textOverflow: "ellipsis",
//   },
//   cardMeta: { fontSize: "0.72em", color: TOKEN.muted, marginTop: 2 },
//   confidenceWrap: { flexShrink: 0, textAlign: "center" },
//   confidenceValue: {
//     fontSize: "1.15em",
//     fontWeight: 800,
//     fontFamily: "monospace",
//   },
//   confidenceLabel: {
//     fontSize: "0.55em",
//     fontWeight: 600,
//     color: TOKEN.muted,
//     textTransform: "uppercase",
//   },
//   cardDivider: { height: 1, background: TOKEN.border },
//   noteLine: {
//     fontSize: "0.72em",
//     fontStyle: "italic",
//     color: "#b45309",
//     overflowWrap: "break-word",
//   },
//   statusBadge: {
//     display: "inline-flex",
//     alignItems: "center",
//     gap: 4,
//     fontSize: "0.65em",
//     fontWeight: 800,
//     padding: "3px 9px",
//     borderRadius: 6,
//     border: "1px solid",
//   },
//   empty: {
//     display: "flex",
//     flexDirection: "column",
//     alignItems: "center",
//     justifyContent: "center",
//     gap: 10,
//     padding: "40px 20px",
//     textAlign: "center",
//   },
//   emptyIcon: {
//     width: 52,
//     height: 52,
//     borderRadius: 14,
//     background: TOKEN.tealLight,
//     border: `1.5px solid ${TOKEN.tealBorder}`,
//     display: "flex",
//     alignItems: "center",
//     justifyContent: "center",
//     color: TOKEN.teal,
//     opacity: 0.7,
//   },
//   emptyTitle: {
//     fontSize: "0.85em",
//     fontWeight: 700,
//     color: TOKEN.head,
//     margin: 0,
//   },
//   emptySubtitle: {
//     fontSize: "0.78em",
//     color: TOKEN.muted,
//     marginTop: 3,
//     maxWidth: 260,
//   },
// };

import React, { useMemo } from "react";
import {
  Activity,
  CloudOff,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { LiveAttendanceEventView } from "./types";

interface Props {
  events: LiveAttendanceEventView[];
  heldCount?: number;
  syncing?: boolean;
  onSync?: () => void;
  clearing?: boolean;
  onClear?: () => void;
  onOpenHeldReview?: () => void;
}

const TOKEN = {
  teal: "#0d9488",
  tealLight: "#f0fdfa",
  tealBorder: "#99f6e4",
  border: "#dbe7ef",
  head: "#0f172a",
  muted: "#64748b",
  matched: "#16a34a",
  matchedBg: "#f0fdf4",
  matchedBorder: "#bbf7d0",
  unknown: "#dc2626",
  unknownBg: "#fef2f2",
  unknownBorder: "#fecaca",
} as const;

const LIVE_WINDOW_MS = 60_000;

const SPIN_KEYFRAMES = `
  .spin { animation: liveAttendanceSpin 0.9s linear infinite; }
  @keyframes liveAttendanceSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

  .qa-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .qa-actions-group { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; }
  .qa-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    flex: 1 1 132px; min-width: 0; white-space: nowrap;
    border-radius: 10px; font-size: 12px; font-weight: 800; letter-spacing: 0.1px;
    padding: 8px 12px; cursor: pointer; transition: background-color 0.15s ease,
    border-color 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
  }
  .qa-btn span.qa-btn-label { overflow: hidden; text-overflow: ellipsis; }
  .qa-btn:active:not(:disabled) { transform: translateY(1px); }
  .qa-btn:focus-visible { outline: 2px solid #0d9488; outline-offset: 2px; }
  .qa-btn:disabled { opacity: 0.55; cursor: not-allowed; }

  .qa-btn--sync { border: 1px solid #99f6e4; background: #f0fdfa; color: #0d9488; }
  .qa-btn--sync:hover:not(:disabled) { background: #ccfbf1; border-color: #5eead4; box-shadow: 0 1px 2px rgba(13,148,136,0.15); }

  .qa-btn--held { border: 1px solid #fde68a; background: #fffbeb; color: #b45309; }
  .qa-btn--held:hover:not(:disabled) { background: #fef3c7; border-color: #fcd34d; box-shadow: 0 1px 2px rgba(180,83,9,0.15); }

  .qa-btn--clear { border: 1px solid #e2e8f0; background: #fff; color: #64748b; flex: 0 1 auto; }
  .qa-btn--clear:hover:not(:disabled) { background: #fef2f2; border-color: #fecaca; color: #be123c; }

  @media (max-width: 340px) {
    .qa-btn { flex-basis: 100%; }
  }
`;

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

/** Single source of truth for the status badge text. event.status now
 * carries "checked_in" / "checked_out" (see camera_stream_manager.py's
 * _detect_and_record) — this is where that finally surfaces in the UI,
 * instead of the old one-size-fits-all "Marked present". Unrecognized/
 * legacy status values (e.g. events still in the feed from before this
 * change) fall back to the previous wording rather than showing nothing. */
function describeStatus(event: LiveAttendanceEventView): string {
  const status = event.status.toLowerCase();
  const synced = event.sync_status === "synced";

  if (status === "checked_out")
    return synced ? "✓ Checked out · Synced" : "✓ Checked out";
  if (status === "checked_in")
    return synced ? "✓ Checked in · Synced" : "✓ Checked in";
  return synced ? "✓ Synced to cloud" : "✓ Marked present";
}

/**
 * `notes` on the wire is the FULL day's merged string, one line per leg,
 * tagged by local_db.py's _merge_note ("Check-in: ...", "Check-out: ...").
 * A single card only ever reports on ONE leg — rendering the whole blob
 * leaks the OTHER leg's (often hours-stale) note onto this card, e.g. a
 * "Checked out" card still showing the morning's "late check-in, awaiting
 * operator decision" text, because a normal in-window checkout clears its
 * OWN note line (nothing exceptional to report) while the check-in line
 * is still sitting in the same string. This pulls out only the line for
 * the leg this card is actually reporting on, and falls back to a plain
 * "Checked out at <time>" when that leg genuinely has no note (the
 * ordinary, unexceptional case) instead of silently borrowing the other
 * leg's text.
 */
function noteForLeg(
  notes: string | null | undefined,
  status: string,
  time: string,
): string | null {
  const prefix = status === "checked_out" ? "Check-out: " : "Check-in: ";
  const line = (notes || "").split("\n").find((l) => l.startsWith(prefix));
  if (line) return line.slice(prefix.length);
  return status === "checked_out" ? `Checked out at ${time}.` : null;
}

function DetectionCard({ event }: { event: LiveAttendanceEventView }) {
  const failed = event.status.toLowerCase() === "failed";
  const status = event.status.toLowerCase();
  const pct = Math.round((Number(event.confidence) || 0) * 100);
  const time = new Date(event.marked_at).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const legNote = noteForLeg(event.notes, status, time);

  return (
    <div style={styles.card}>
      <div
        style={{
          ...styles.accentStrip,
          background: failed ? TOKEN.unknown : TOKEN.teal,
        }}
      />
      <div style={styles.cardBody}>
        <div style={styles.cardTopRow}>
          <div style={styles.avatarWrap}>
            {event.snapshot ? (
              <img
                src={`data:image/jpeg;base64,${event.snapshot}`}
                alt={event.name}
                style={styles.avatarImg}
              />
            ) : (
              <div style={styles.avatarFallback}>{initialsFor(event.name)}</div>
            )}
            <span
              style={{
                ...styles.presenceDot,
                background: failed ? "#94a3b8" : "#22c55e",
              }}
            />
          </div>

          <div style={styles.cardInfo}>
            <div style={styles.cardName}>{event.name}</div>
            <div style={styles.cardMeta}>
              {time}
              {event.camera_name || event.camera_id
                ? ` · ${event.camera_name || event.camera_id}`
                : ""}
            </div>
          </div>
        </div>

        <div style={styles.cardDivider} />

        {legNote && <div style={styles.noteLine}>{legNote}</div>}

        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <div
            style={{
              ...styles.statusBadge,
              background: failed ? TOKEN.unknownBg : TOKEN.matchedBg,
              borderColor: failed ? TOKEN.unknownBorder : TOKEN.matchedBorder,
              color: failed ? TOKEN.unknown : TOKEN.matched,
            }}
          >
            {failed ? "⚠ Sync failed" : describeStatus(event)}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LiveAttendancePanel({
  events,
  heldCount = 0,
  syncing = false,
  onSync,
  clearing = false,
  onClear,
  onOpenHeldReview,
}: Props) {
  // Derived from the node's own /api/live-events feed. There is no
  // /api/stats endpoint on the local node (unlike the cloud dashboard), so
  // these are computed client-side from data the node actually returns.
  const stats = useMemo(() => {
    const now = Date.now();
    let live = 0;
    let synced = 0;
    let pending = 0;
    for (const event of events) {
      if (now - new Date(event.marked_at).getTime() <= LIVE_WINDOW_MS)
        live += 1;
      if (event.sync_status === "synced") synced += 1;
      if (event.sync_status === "pending") pending += 1;
    }
    return { live, synced, pending, total: events.length };
  }, [events]);

  const statItems = [
    { value: stats.total, color: TOKEN.teal, label: "Events" },
    { value: stats.synced, color: "#22c55e", label: "Synced" },
    { value: stats.pending, color: "#b45309", label: "Pending" },
    { value: stats.live, color: "#ef4444", label: "Live" },
  ];

  return (
    <section style={styles.panel}>
      <style>{SPIN_KEYFRAMES}</style>
      <div style={styles.header}>
        <div style={styles.accentBar} />
        <div style={styles.headerRow}>
          <div style={styles.headerTitle}>Attendance Monitor</div>
          <div style={styles.liveBadge}>
            <span style={styles.liveDot} />
            LIVE
          </div>
        </div>
        <div style={styles.statGrid}>
          {statItems.map((item, index) => (
            <div
              key={item.label}
              style={{
                ...styles.statCell,
                borderLeft: index > 0 ? `1px solid ${TOKEN.border}` : "none",
              }}
            >
              <span style={{ ...styles.statCellValue, color: item.color }}>
                {item.value}
              </span>
              <span style={styles.statCellLabel}>{item.label}</span>
            </div>
          ))}
        </div>
      </div>

      {(onOpenHeldReview || onSync || onClear) && (
        <div style={styles.actionsBar}>
          <div className="qa-actions">
            <div className="qa-actions-group">
              {onOpenHeldReview && (
                <button
                  type="button"
                  className="qa-btn qa-btn--held"
                  onClick={onOpenHeldReview}
                  title="Review detections held for manual approval"
                >
                  <ShieldAlert size={13} />
                  <span className="qa-btn-label">Held for review</span>
                  {heldCount > 0 && (
                    <span style={styles.heldBadge}>{heldCount}</span>
                  )}
                </button>
              )}
              {onSync && (
                <button
                  type="button"
                  className="qa-btn qa-btn--sync"
                  onClick={onSync}
                  disabled={syncing}
                  title={
                    heldCount > 0
                      ? `${heldCount} attendance record(s) held for review — sync pushes those too`
                      : "Push any pending attendance to the cloud now"
                  }
                >
                  <RefreshCw
                    size={13}
                    className={syncing ? "spin" : undefined}
                  />
                  <span className="qa-btn-label">Sync attendance</span>
                  {heldCount > 0 && (
                    <span style={styles.syncBadge}>{heldCount}</span>
                  )}
                </button>
              )}
            </div>
            {onClear && (
              <button
                type="button"
                className="qa-btn qa-btn--clear"
                onClick={onClear}
                disabled={clearing}
                title="Delete today's attendance on this node (local only — does not remove anything already synced to the cloud)"
              >
                {clearing ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Trash2 size={13} />
                )}
                <span className="qa-btn-label">Clear today</span>
              </button>
            )}
          </div>
        </div>
      )}

      <div style={styles.toolbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span style={styles.toolbarLabel}>Detections</span>
          <span style={styles.toolbarBadge}>{events.length}</span>
        </div>
        <Activity size={14} color={TOKEN.muted} />
      </div>

      <div style={styles.feed}>
        {events.length === 0 ? (
          <div style={styles.empty}>
            <div style={styles.emptyIcon}>
              <CloudOff size={22} />
            </div>
            <p style={styles.emptyTitle}>No detections yet</p>
            <p style={styles.emptySubtitle}>
              When a trained face is recognized, this screen will confirm local
              marking and cloud sync.
            </p>
          </div>
        ) : (
          events.map((event) => <DetectionCard key={event.id} event={event} />)
        )}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    // No height: "100%" anymore — the panel used to be forced to fill its
    // column's full height, which is what made .feed below need its own
    // internal overflowY: "auto" scrollbar. Now the panel is just as tall
    // as its content (header + actions + all detection cards), and the
    // single shared scrollbar lives on App.tsx's main row instead.
    // overflow: "hidden" is kept purely to clip square corners under the
    // rounded border — it can't create a second scrollbar since the box
    // never exceeds its own content height.
    width: "100%",
    border: `1px solid ${TOKEN.border}`,
    borderRadius: 18,
    background: "#fff",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  header: {
    flexShrink: 0,
    padding: "14px 16px 0",
    borderBottom: `1px solid ${TOKEN.border}`,
  },
  accentBar: {
    height: 3,
    background: `linear-gradient(90deg, ${TOKEN.teal} 0%, #2ee8c0 60%, ${TOKEN.teal} 100%)`,
    borderRadius: "2px 2px 0 0",
    marginBottom: 12,
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  headerTitle: { fontSize: "0.9em", fontWeight: 800, color: TOKEN.head },
  liveBadge: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "#dcfce7",
    border: "1px solid #bbf7d0",
    color: "#15803d",
    fontSize: "0.65em",
    fontWeight: 800,
    padding: "3px 9px",
    borderRadius: 20,
    letterSpacing: "0.8px",
  },
  liveDot: { width: 5, height: 5, background: "#22c55e", borderRadius: "50%" },
  actionsBar: {
    flexShrink: 0,
    padding: "10px 16px",
    borderBottom: `1px solid ${TOKEN.border}`,
    background: "#fafcfd",
  },
  heldBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 15,
    height: 15,
    padding: "0 4px",
    borderRadius: 20,
    background: "#b45309",
    color: "#fff",
    fontSize: "0.85em",
  },
  syncBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 15,
    height: 15,
    padding: "0 4px",
    borderRadius: 20,
    background: "#b45309",
    color: "#fff",
    fontSize: "0.85em",
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4,1fr)",
    marginBottom: 14,
  },
  statCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 2,
    padding: "0 4px",
  },
  statCellValue: { fontSize: "1.3em", fontWeight: 800, lineHeight: 1 },
  statCellLabel: {
    fontSize: "0.55em",
    fontWeight: 600,
    color: TOKEN.muted,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  toolbar: {
    flexShrink: 0,
    padding: "9px 14px",
    borderBottom: `1px solid ${TOKEN.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
  toolbarLabel: {
    fontSize: "0.78em",
    fontWeight: 800,
    color: TOKEN.head,
    textTransform: "uppercase",
    letterSpacing: "0.4px",
  },
  toolbarBadge: {
    background: TOKEN.teal,
    color: "#fff",
    fontSize: "0.68em",
    fontWeight: 800,
    padding: "2px 8px",
    borderRadius: 20,
    minWidth: 22,
    textAlign: "center",
  },
  // No flex: 1 / overflowY: "auto" anymore — this used to be the sidebar's
  // own independent scroll region. It now just renders all cards at their
  // natural height; App.tsx's main row is the single scrollbar for both
  // the sidebar and the camera grid together.
  feed: {
    padding: 10,
    display: "grid",
    gap: 10,
    alignContent: "start",
  },
  card: {
    display: "flex",
    border: `1px solid ${TOKEN.border}`,
    borderRadius: 14,
    overflow: "hidden",
    background: "#fff",
  },
  accentStrip: { width: 4, flexShrink: 0 },
  cardBody: {
    flex: 1,
    padding: "12px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  cardTopRow: { display: "flex", alignItems: "center", gap: 12 },
  avatarWrap: { position: "relative", flexShrink: 0 },
  avatarImg: {
    width: 46,
    height: 46,
    borderRadius: 10,
    objectFit: "cover",
    border: `1px solid ${TOKEN.border}`,
  },
  avatarFallback: {
    width: 46,
    height: 46,
    borderRadius: 10,
    background: `linear-gradient(135deg, ${TOKEN.teal}, #1d8a84)`,
    color: "#fff",
    fontWeight: 800,
    fontSize: "0.9em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  presenceDot: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 12,
    height: 12,
    borderRadius: "50%",
    border: "2px solid #fff",
  },
  cardInfo: { flex: 1, minWidth: 0 },
  cardName: {
    fontSize: "0.92em",
    fontWeight: 800,
    color: TOKEN.head,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardMeta: { fontSize: "0.72em", color: TOKEN.muted, marginTop: 2 },
  confidenceWrap: { flexShrink: 0, textAlign: "center" },
  confidenceValue: {
    fontSize: "1.15em",
    fontWeight: 800,
    fontFamily: "monospace",
  },
  confidenceLabel: {
    fontSize: "0.55em",
    fontWeight: 600,
    color: TOKEN.muted,
    textTransform: "uppercase",
  },
  cardDivider: { height: 1, background: TOKEN.border },
  noteLine: {
    fontSize: "0.72em",
    fontStyle: "italic",
    color: "#b45309",
    overflowWrap: "break-word",
  },
  statusBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: "0.65em",
    fontWeight: 800,
    padding: "3px 9px",
    borderRadius: 6,
    border: "1px solid",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    padding: "40px 20px",
    textAlign: "center",
  },
  emptyIcon: {
    width: 52,
    height: 52,
    borderRadius: 14,
    background: TOKEN.tealLight,
    border: `1.5px solid ${TOKEN.tealBorder}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: TOKEN.teal,
    opacity: 0.7,
  },
  emptyTitle: {
    fontSize: "0.85em",
    fontWeight: 700,
    color: TOKEN.head,
    margin: 0,
  },
  emptySubtitle: {
    fontSize: "0.78em",
    color: TOKEN.muted,
    marginTop: 3,
    maxWidth: 260,
  },
};
