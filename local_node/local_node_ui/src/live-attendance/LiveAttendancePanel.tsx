import React, { useState, useMemo } from "react";
import {
  Activity,
  AlertTriangle,
  Calendar,
  Camera,
  CheckCircle2,
  Clock,
  CloudOff,
  Info,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserCheck,
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
  tealDark: "#0f766e",
  tealLight: "#f0fdfa",
  tealBorder: "#99f6e4",
  border: "#e2e8f0",
  head: "#0f172a",
  muted: "#64748b",
  matched: "#16a34a",
  matchedBg: "#f0fdf4",
  matchedBorder: "#bbf7d0",
  unknown: "#dc2626",
  unknownBg: "#fef2f2",
  unknownBorder: "#fecaca",
  late: "#d97706",
  lateBg: "#fffbeb",
  lateBorder: "#fde68a",
  sky: "#0284c7",
  skyBg: "#f0f9ff",
  skyBorder: "#bae6fd",
} as const;

const LIVE_WINDOW_MS = 60_000;

const PANEL_KEYFRAMES = `
  @keyframes liveSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  .spin { animation: liveSpin 0.9s linear infinite; }

  @keyframes livePulseDot {
    0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
    70% { transform: scale(1.05); box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
    100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
  }
  .live-dot-ping {
    animation: livePulseDot 2s infinite;
  }

  @keyframes cardSlideIn {
    from { opacity: 0; transform: translateY(-10px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .detection-card-anim {
    animation: cardSlideIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }

  .qa-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .qa-actions-group { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; }
  
  .qa-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    flex: 1 1 135px; min-width: 0; white-space: nowrap;
    border-radius: 12px; font-size: 12.5px; font-weight: 700;
    padding: 10px 14px; cursor: pointer; transition: all 0.18s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: 0 2px 5px rgba(15, 23, 42, 0.04);
  }
  .qa-btn span.qa-btn-label { overflow: hidden; text-overflow: ellipsis; }
  .qa-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(15, 23, 42, 0.08); }
  .qa-btn:active:not(:disabled) { transform: translateY(1px); }
  .qa-btn:focus-visible { outline: 2px solid #0d9488; outline-offset: 2px; }
  .qa-btn:disabled { opacity: 0.55; cursor: not-allowed; }

  .qa-btn--sync { border: 1px solid #99f6e4; background: linear-gradient(135deg, #f0fdfa 0%, #ccfbf1 100%); color: #0f766e; }
  .qa-btn--sync:hover:not(:disabled) { background: linear-gradient(135deg, #ccfbf1 0%, #99f6e4 100%); border-color: #5eead4; }

  .qa-btn--held { border: 1px solid #fde68a; background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%); color: #b45309; }
  .qa-btn--held:hover:not(:disabled) { background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%); border-color: #fcd34d; }

  .qa-btn--clear { border: 1px solid #e2e8f0; background: #ffffff; color: #64748b; flex: 0 1 auto; }
  .qa-btn--clear:hover:not(:disabled) { background: #fef2f2; border-color: #fecaca; color: #be123c; }

  .detection-card-hover {
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .detection-card-hover:hover {
    transform: translateY(-2px);
    box-shadow: 0 10px 28px -4px rgba(15, 23, 42, 0.1) !important;
    border-color: #cbd5e1 !important;
  }

  @media (max-width: 380px) {
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

function describeStatus(event: LiveAttendanceEventView): {
  label: string;
  isCheckOut: boolean;
  isSynced: boolean;
} {
  const status = event.status.toLowerCase();
  const synced = event.sync_status === "synced";

  if (status === "checked_out") {
    return {
      label: synced ? "Checked out · Synced" : "Checked out",
      isCheckOut: true,
      isSynced: synced,
    };
  }
  if (status === "checked_in") {
    return {
      label: synced ? "Checked in · Synced" : "Checked in",
      isCheckOut: false,
      isSynced: synced,
    };
  }
  return {
    label: synced ? "Synced to cloud" : "Marked present",
    isCheckOut: false,
    isSynced: synced,
  };
}

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
  const eventDate = new Date(event.marked_at);
  const time = eventDate.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const date = eventDate.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const legNote = noteForLeg(event.notes, status, time);
  const statusInfo = describeStatus(event);

  const isLateNote = (legNote || "").toLowerCase().includes("late");

  return (
    <div className="detection-card-anim detection-card-hover" style={styles.card}>
      <div
        style={{
          ...styles.accentStrip,
          background: failed
            ? TOKEN.unknown
            : isLateNote
              ? TOKEN.late
              : statusInfo.isCheckOut
                ? TOKEN.sky
                : TOKEN.teal,
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
              className={failed ? "" : "live-dot-ping"}
              style={{
                ...styles.presenceDot,
                background: failed ? "#94a3b8" : "#22c55e",
              }}
            />
          </div>

          <div style={styles.cardInfo}>
            <div style={styles.cardHeaderFlex}>
              <span style={styles.cardName}>{event.name}</span>
              {pct > 0 && (
                <span style={styles.confidencePill}>
                  {pct}% match
                </span>
              )}
            </div>

            <div style={styles.metaRow}>
              <span style={styles.metaBadge}>
                <Clock size={11} style={{ flexShrink: 0, color: TOKEN.muted }} />
                {date} · {time}
              </span>
              {event.staff_id && (
                <span style={styles.codeBadge}>
                  {event.staff_id}
                </span>
              )}
              {event.camera_name && (
                <span style={styles.cameraBadge}>
                  <Camera size={11} />
                  {event.camera_name}
                </span>
              )}
            </div>
          </div>
        </div>

        {legNote && (
          <div
            style={{
              ...styles.noteLine,
              background: isLateNote ? TOKEN.lateBg : "#f8fafc",
              borderColor: isLateNote ? TOKEN.lateBorder : "#e2e8f0",
              color: isLateNote ? "#92400e" : "#334155",
            }}
          >
            {isLateNote ? (
              <AlertTriangle
                size={13}
                color="#d97706"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
            ) : (
              <Info
                size={13}
                color="#0284c7"
                style={{ flexShrink: 0, marginTop: 1 }}
              />
            )}
            <span>{legNote}</span>
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <div
            style={{
              ...styles.statusBadge,
              background: failed
                ? TOKEN.unknownBg
                : statusInfo.isCheckOut
                  ? TOKEN.skyBg
                  : TOKEN.matchedBg,
              borderColor: failed
                ? TOKEN.unknownBorder
                : statusInfo.isCheckOut
                  ? TOKEN.skyBorder
                  : TOKEN.matchedBorder,
              color: failed
                ? TOKEN.unknown
                : statusInfo.isCheckOut
                  ? TOKEN.sky
                  : TOKEN.matched,
            }}
          >
            {failed ? (
              <>
                <AlertTriangle size={12} />
                <span>Sync failed</span>
              </>
            ) : statusInfo.isCheckOut ? (
              <>
                <LogOut size={12} />
                <span>{statusInfo.label}</span>
              </>
            ) : (
              <>
                <UserCheck size={12} />
                <span>{statusInfo.label}</span>
              </>
            )}
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
  const todayDateStr = useMemo(() => new Date().toDateString(), []);

  const todayEvents = useMemo(() => {
    return events.filter(
      (event) => new Date(event.marked_at).toDateString() === todayDateStr,
    );
  }, [events, todayDateStr]);

  const stats = useMemo(() => {
    const now = Date.now();
    let live = 0;
    let synced = 0;
    let pending = 0;
    for (const event of todayEvents) {
      if (now - new Date(event.marked_at).getTime() <= LIVE_WINDOW_MS)
        live += 1;
      if (event.sync_status === "synced") synced += 1;
      if (event.sync_status === "pending") pending += 1;
    }
    return { live, synced, pending, total: todayEvents.length };
  }, [todayEvents]);

  const statItems = [
    { value: stats.total, color: TOKEN.teal, label: "Events" },
    { value: stats.synced, color: "#16a34a", label: "Synced" },
    { value: stats.pending, color: "#d97706", label: "Pending" },
    { value: stats.live, color: "#dc2626", label: "Live" },
  ];

  return (
    <section style={styles.panel}>
      <style>{PANEL_KEYFRAMES}</style>
      
      {/* Header Container */}
      <div style={styles.header}>
        <div style={styles.accentBar} />
        <div style={styles.headerRow}>
          <div style={styles.titleWrap}>
            <div style={styles.iconBox}>
              <Activity size={18} color={TOKEN.teal} />
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span style={styles.headerTitle}>Attendance Monitor</span>
              <span style={styles.headerSubtitle}>Real-time face recognition stream</span>
            </div>
          </div>
          <div style={styles.liveBadge}>
            <span className="live-dot-ping" style={styles.liveDot} />
            LIVE
          </div>
        </div>

        {/* 4 KPICard Stat Grid */}
        <div style={styles.statGrid}>
          {statItems.map((item, index) => (
            <div
              key={item.label}
              style={{
                ...styles.statCell,
                borderRight: index < statItems.length - 1 ? `1px solid ${TOKEN.border}` : "none",
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

      {/* Action Buttons Toolbar */}
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
                  <ShieldAlert size={14} />
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
                    size={14}
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
                title="Delete today's attendance on this node (local only)"
              >
                {clearing ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                <span className="qa-btn-label">Clear today</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Detections Header */}
      <div style={styles.toolbar}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={styles.toolbarLabel}>Today's Detections</span>
          <span style={styles.toolbarBadge}>{todayEvents.length}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.74em", fontWeight: 700, color: TOKEN.muted }}>
          <Calendar size={13} color={TOKEN.teal} />
          {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}
        </div>
      </div>

      {/* Detections Stream Feed */}
      <div style={styles.feed}>
        {todayEvents.length === 0 ? (
          <div style={styles.empty}>
            <div style={styles.emptyIcon}>
              <CloudOff size={28} />
            </div>
            <p style={styles.emptyTitle}>Listening for today's face detections...</p>
            <p style={styles.emptySubtitle}>
              When a camera recognizes an employee face today, real-time check-in/out logs will appear here automatically.
            </p>
          </div>
        ) : (
          todayEvents.map((event) => <DetectionCard key={event.id} event={event} />)
        )}
      </div>
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: "100%",
    border: `1px solid ${TOKEN.border}`,
    borderRadius: 20,
    background: "#ffffff",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    boxShadow: "0 12px 36px -8px rgba(15, 23, 42, 0.08)",
  },
  header: {
    flexShrink: 0,
    padding: "18px 20px 0",
    borderBottom: `1px solid ${TOKEN.border}`,
    background: "linear-gradient(180deg, #fafcfd 0%, #ffffff 100%)",
  },
  accentBar: {
    height: 4,
    background: `linear-gradient(90deg, ${TOKEN.teal} 0%, #2ee8c0 50%, ${TOKEN.tealDark} 100%)`,
    borderRadius: "2px 2px 0 0",
    marginBottom: 16,
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  titleWrap: {
    display: "flex",
    alignItems: "center",
    gap: 12,
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    background: "rgba(13, 148, 136, 0.1)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerTitle: { fontSize: "1em", fontWeight: 800, color: TOKEN.head, letterSpacing: "-0.02em", lineHeight: 1.2 },
  headerSubtitle: { fontSize: "0.75em", color: TOKEN.muted, marginTop: 2, fontWeight: 500 },
  liveBadge: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "#dcfce7",
    border: "1px solid #86efac",
    color: "#15803d",
    fontSize: "0.7em",
    fontWeight: 800,
    padding: "4px 10px",
    borderRadius: 20,
    letterSpacing: "0.8px",
    boxShadow: "0 2px 6px rgba(34, 197, 94, 0.12)",
  },
  liveDot: { width: 7, height: 7, background: "#22c55e", borderRadius: "50%" },
  actionsBar: {
    flexShrink: 0,
    padding: "12px 18px",
    borderBottom: `1px solid ${TOKEN.border}`,
    background: "#fafcfd",
  },
  heldBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 20,
    background: "#b45309",
    color: "#fff",
    fontSize: "0.85em",
    fontWeight: 800,
  },
  syncBadge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 18,
    height: 18,
    padding: "0 5px",
    borderRadius: 20,
    background: "#b45309",
    color: "#fff",
    fontSize: "0.85em",
    fontWeight: 800,
  },
  statGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    paddingBottom: 16,
    gap: 0,
  },
  statCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
    padding: "4px 8px",
  },
  statCellValue: { fontSize: "1.4em", fontWeight: 800, lineHeight: 1 },
  statCellLabel: {
    fontSize: "0.62em",
    fontWeight: 700,
    color: TOKEN.muted,
    textTransform: "uppercase",
    letterSpacing: "0.6px",
  },
  toolbar: {
    flexShrink: 0,
    padding: "12px 18px",
    borderBottom: `1px solid ${TOKEN.border}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    background: "#f8fafc",
  },
  toolbarLabel: {
    fontSize: "0.8em",
    fontWeight: 800,
    color: TOKEN.head,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
  },
  toolbarBadge: {
    background: TOKEN.teal,
    color: "#fff",
    fontSize: "0.72em",
    fontWeight: 800,
    padding: "2px 9px",
    borderRadius: 20,
    minWidth: 24,
    textAlign: "center",
  },
  feed: {
    padding: 16,
    display: "grid",
    gap: 14,
    alignContent: "start",
  },
  card: {
    display: "flex",
    border: `1px solid ${TOKEN.border}`,
    borderRadius: 16,
    overflow: "hidden",
    background: "#ffffff",
    boxShadow: "0 2px 8px rgba(15, 23, 42, 0.04)",
  },
  accentStrip: { width: 5, flexShrink: 0 },
  cardBody: {
    flex: 1,
    padding: "14px 16px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  cardTopRow: { display: "flex", alignItems: "center", gap: 14 },
  avatarWrap: { position: "relative", flexShrink: 0 },
  avatarImg: {
    width: 52,
    height: 52,
    borderRadius: 14,
    objectFit: "cover",
    border: "2px solid #ffffff",
    boxShadow: "0 4px 10px rgba(15, 23, 42, 0.08)",
  },
  avatarFallback: {
    width: 52,
    height: 52,
    borderRadius: 14,
    background: `linear-gradient(135deg, ${TOKEN.teal}, #0f766e)`,
    color: "#fff",
    fontWeight: 800,
    fontSize: "1em",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 10px rgba(13, 148, 136, 0.22)",
  },
  presenceDot: {
    position: "absolute",
    bottom: -2,
    right: -2,
    width: 13,
    height: 13,
    borderRadius: "50%",
    border: "2.5px solid #ffffff",
  },
  cardInfo: { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 },
  cardHeaderFlex: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
  cardName: {
    fontSize: "0.96em",
    fontWeight: 800,
    color: TOKEN.head,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  confidencePill: {
    fontSize: "0.7em",
    fontWeight: 800,
    color: TOKEN.tealDark,
    background: TOKEN.tealLight,
    border: `1px solid ${TOKEN.tealBorder}`,
    padding: "2px 7px",
    borderRadius: 6,
    fontFamily: "monospace",
    whiteSpace: "nowrap",
  },
  metaRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 },
  metaBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: "0.74em",
    color: TOKEN.muted,
    fontWeight: 600,
  },
  codeBadge: {
    fontSize: "0.7em",
    fontWeight: 700,
    fontFamily: "monospace",
    color: "#334155",
    background: "#f1f5f9",
    border: "1px solid #e2e8f0",
    padding: "2px 6px",
    borderRadius: 5,
  },
  cameraBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    fontSize: "0.7em",
    fontWeight: 700,
    color: "#0284c7",
    background: "#f0f9ff",
    border: "1px solid #bae6fd",
    padding: "2px 7px",
    borderRadius: 5,
  },
  noteLine: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    fontSize: "0.78em",
    fontWeight: 600,
    padding: "9px 12px",
    borderRadius: 10,
    border: "1px solid",
    lineHeight: 1.45,
  },
  statusBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: "0.74em",
    fontWeight: 800,
    padding: "5px 12px",
    borderRadius: 8,
    border: "1px solid",
    boxShadow: "0 1px 3px rgba(15, 23, 42, 0.04)",
  },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    padding: "54px 28px",
    textAlign: "center",
  },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 18,
    background: TOKEN.tealLight,
    border: `1.5px solid ${TOKEN.tealBorder}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: TOKEN.teal,
    boxShadow: "0 6px 16px rgba(13, 148, 136, 0.12)",
  },
  emptyTitle: {
    fontSize: "0.95em",
    fontWeight: 800,
    color: TOKEN.head,
    margin: 0,
  },
  emptySubtitle: {
    fontSize: "0.8em",
    color: TOKEN.muted,
    marginTop: 2,
    maxWidth: 290,
    lineHeight: 1.55,
  },
  segmentedControl: {
    display: "inline-flex",
    alignItems: "center",
    background: "#e2e8f0",
    padding: 3,
    borderRadius: 9,
    gap: 2,
  },
  segmentActive: {
    border: 0,
    background: "#ffffff",
    color: TOKEN.tealDark,
    fontSize: "0.72em",
    fontWeight: 800,
    padding: "3px 10px",
    borderRadius: 7,
    cursor: "pointer",
    boxShadow: "0 1px 3px rgba(15, 23, 42, 0.1)",
    transition: "all 0.15s ease",
  },
  segmentInactive: {
    border: 0,
    background: "transparent",
    color: "#64748b",
    fontSize: "0.72em",
    fontWeight: 700,
    padding: "3px 10px",
    borderRadius: 7,
    cursor: "pointer",
    transition: "all 0.15s ease",
  },
  switchScopeBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: `1px solid ${TOKEN.tealBorder}`,
    background: TOKEN.tealLight,
    color: TOKEN.tealDark,
    fontSize: "0.76em",
    fontWeight: 800,
    padding: "8px 14px",
    borderRadius: 10,
    cursor: "pointer",
    marginTop: 4,
    transition: "all 0.15s ease",
  },
};
