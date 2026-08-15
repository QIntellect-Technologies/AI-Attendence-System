import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Activity,
  Loader2,
  RefreshCcw,
  Server,
  ShieldCheck,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast, ToastContainer, type Id } from "react-toastify";

import { confirmDestructive } from "./lib/confirmDialogue";
import {
  localNodeApi,
  humanizeError,
  type LiveAttendanceEvent,
  type NodeStatusResponse,
} from "./api/localNodeApi";
import LiveAttendancePanel from "./live-attendance/LiveAttendancePanel";
import ImportPanel from "./live-attendance/ImportPanel";
import CameraGrid from "./live-attendance/CameraGrid";
import HeldReviewPanel from "./live-attendance/HeldReviewPanel";

const DEFAULT_API_BASE_URL = "http://127.0.0.1:5000";

// Injected once per render path (activation screen / main shell). Handles
// the responsive breakpoints that inline style objects can't express
// (media queries) — this is the fix for the horizontal overflow that used
// to show up once the top bar's pills or the camera/sidebar row ran out of
// room on narrower screens.
const RESPONSIVE_CSS = `
  html, body { margin: 0; padding: 0; overflow-x: hidden; }
  .qia-page { overflow-x: hidden; }
  .qia-top-bar { flex-wrap: wrap; row-gap: 8px; }
  .qia-pill-row { flex-wrap: wrap; row-gap: 8px; }
  .qia-main-row { display: flex; gap: 14px; min-width: 0; overflow: hidden; }
  .qia-camera-col { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; }
  .qia-sidebar-col {
    flex-shrink: 0;
    min-height: 0;
    min-width: 0;
    display: flex;
    width: 360px;
  }
  .qia-brand-org {
    max-width: min(46vw, 420px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  @media (max-width: 900px) {
    .qia-main-row { flex-direction: column; overflow: hidden auto; }
    .qia-sidebar-col { width: 100% !important; height: 460px; }
    .qia-camera-col { min-height: 320px; }
  }
  @media (max-width: 620px) {
    .qia-brand-org { max-width: 60vw; font-size: 17px !important; }
    .qia-top-bar { padding: 10px 12px !important; }
    .qia-pill-row { gap: 6px !important; }
  }

  /* Compact SweetAlert2 popup — overrides the library's consumer-app-sized
     defaults (big icon, loose padding, oversized buttons) to match this
     app's tight, data-dense styling. Used by every confirmDestructive()
     call (see src/lib/confirmDialog.ts) so all confirm dialogs — clear
     today's attendance, delete held detection(s) — look identical and
     match the rest of the UI rather than the default SweetAlert2 look. */
  .qia-swal-popup {
    width: 380px !important;
    border-radius: 14px !important;
    padding: 20px 22px 22px !important;
    font-family: Inter, system-ui, sans-serif !important;
  }
  .qia-swal-icon {
    width: 42px !important;
    height: 42px !important;
    margin: 0 auto 10px !important;
  }
  .qia-swal-icon .swal2-icon-content {
    font-size: 26px !important;
  }
  .qia-swal-title {
    font-size: 15px !important;
    font-weight: 800 !important;
    color: #0f172a !important;
    padding: 0 !important;
    margin: 0 0 6px !important;
    line-height: 1.35 !important;
  }
  .qia-swal-html {
    font-size: 12.5px !important;
    color: #64748b !important;
    line-height: 1.55 !important;
    margin: 0 !important;
    padding: 0 !important;
  }
  .qia-swal-actions {
    margin: 18px 0 0 !important;
    gap: 8px !important;
  }
  .qia-swal-confirm,
  .qia-swal-cancel {
    font-size: 12.5px !important;
    font-weight: 800 !important;
    border-radius: 10px !important;
    padding: 8px 14px !important;
    margin: 0 !important;
    cursor: pointer !important;
    box-shadow: none !important;
  }
  .qia-swal-confirm {
    border: 0 !important;
    background: #be123c !important;
    color: #fff !important;
  }
  .qia-swal-cancel {
    border: 1px solid #cbd5e1 !important;
    background: #fff !important;
    color: #334155 !important;
  }
`;

export default function App() {
  const [status, setStatus] = useState<NodeStatusResponse | null>(null);
  const [events, setEvents] = useState<LiveAttendanceEvent[]>([]);
  const [apiBaseUrl, setApiBaseUrl] = useState(DEFAULT_API_BASE_URL);
  const [installToken, setInstallToken] = useState("");
  const [nodeLabel, setNodeLabel] = useState("");
  const [busy, setBusy] = useState<
    "activate" | "refresh" | "cycle" | "sync" | "clear" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [heldReviewOpen, setHeldReviewOpen] = useState(false);
  const lastCameraChangeAtRef = useRef<string | null>(null);

  // "Lost connectivity" toast — edge-triggered when runtime.offline flips
  // false -> true, and dismissed once it flips back. Stays up (autoClose:
  // false) the whole time offline, since that's the whole point: the
  // operator should see it for as long as it's actually true. We track the
  // toast's id so we can dismiss that exact toast rather than guessing.
  const wasOfflineRef = useRef(false);
  const connectivityToastIdRef = useRef<Id | null>(null);

  const load = useCallback(async () => {
    setBusy((current) => current ?? "refresh");
    try {
      const [nodeStatus, live] = await Promise.all([
        localNodeApi.status(),
        localNodeApi.liveEvents(),
      ]);
      setStatus(nodeStatus);
      setEvents(live.events);
      setError(null);

      const offlineNow = Boolean(nodeStatus.runtime?.offline);
      if (offlineNow && !wasOfflineRef.current) {
        connectivityToastIdRef.current = toast.warning(
          "You have lost internet connectivity, Attendance will be synced when the internet is back",
          { autoClose: false },
        );
      } else if (!offlineNow && wasOfflineRef.current) {
        if (connectivityToastIdRef.current !== null) {
          toast.dismiss(connectivityToastIdRef.current);
          connectivityToastIdRef.current = null;
        }
      }
      wasOfflineRef.current = offlineNow;

      const changedAt = nodeStatus.runtime?.camera_changes_at ?? null;
      const changes = nodeStatus.runtime?.camera_changes ?? [];
      if (
        changedAt &&
        changedAt !== lastCameraChangeAtRef.current &&
        changes.length > 0
      ) {
        lastCameraChangeAtRef.current = changedAt;
        const message = changes
          .map((c) => {
            if (c.change_type === "updated")
              return `${c.camera_name}: URL updated, reconnected`;
            if (c.change_type === "added") return `${c.camera_name}: added`;
            return `${c.camera_name}: removed`;
          })
          .join(" · ");
        toast.info(message, { autoClose: 6000 });
      }
    } catch (err) {
      setError(humanizeError(err, "Failed to load node status."));
    } finally {
      setBusy((current) => (current === "refresh" ? null : current));
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(interval);
  }, [load]);

  const activated = Boolean(status?.activated);
  const runtime = status?.runtime ?? {};
  const isLocalMode =
    String(status?.attendance_mode || "").toLowerCase() === "local";

  // Big brand line in the header. Prefers the organization's display name
  // from the node status; falls back to something sensible before
  // activation or if the backend hasn't populated org_name yet.
  const orgDisplayName =
    status?.org_name?.trim() ||
    (activated ? "Attendance Console" : "QIntellect");

  const modeLabel = useMemo(() => {
    const mode = String(status?.attendance_mode || "").toLowerCase();
    if (mode === "local") return "Local AI mode";
    if (mode === "cloud") return "Cloud frame-pusher mode";
    return "Waiting for activation";
  }, [status?.attendance_mode]);

  const activate = async () => {
    setBusy("activate");
    setError(null);
    try {
      await localNodeApi.activate({
        api_base_url: apiBaseUrl,
        install_token: installToken,
        node_label: nodeLabel || undefined,
      });
      setInstallToken("");
      await load();
    } catch (err) {
      setError(humanizeError(err, "Activation failed."));
    } finally {
      setBusy(null);
    }
  };

  const runCycle = async () => {
    setBusy("cycle");
    setError(null);
    try {
      await localNodeApi.runCycle();
      await load();
    } catch (err) {
      setError(humanizeError(err, "Node cycle failed."));
    } finally {
      setBusy(null);
    }
  };

  const syncAttendance = async () => {
    if (status?.runtime?.offline) {
      toast.error("Internet connection is lost. Can't sync now", {
        autoClose: 6000,
      });
      return;
    }

    setBusy("sync");
    setError(null);
    try {
      const result = await localNodeApi.syncAttendance();
      await load();
      toast.success(
        result.synced_count > 0
          ? `Synced ${result.synced_count} attendance record${
              result.synced_count === 1 ? "" : "s"
            } to the cloud.`
          : "Attendance is already up to date — nothing to sync.",
        { autoClose: 5000 },
      );
    } catch (err) {
      setError(humanizeError(err, "Attendance sync failed."));
    } finally {
      setBusy(null);
    }
  };

  const clearTodayAttendance = async () => {
    // Destructive and irreversible on this machine — deletes today's rows
    // whether pending, held, or already synced — so it needs an explicit
    // confirm rather than firing on a single click like Sync/Refresh do.
    const confirmed = await confirmDestructive({
      title: "Clear today's attendance on this node?",
      html:
        "This deletes every attendance record for today from this machine " +
        "(pending, held, and already-synced alike) and resets the live " +
        "detections feed. It does not remove anything already pushed to " +
        "the cloud.",
      confirmText: "Clear today's data",
    });
    if (!confirmed) return;

    setBusy("clear");
    setError(null);
    try {
      await localNodeApi.clearTodayAttendance();
      await load();
    } catch (err) {
      setError(humanizeError(err, "Clearing today's attendance failed."));
    } finally {
      setBusy(null);
    }
  };

  // Not activated yet: a focused, centered setup card is more usable than a
  // full-bleed empty page — there's nothing else to show until this is done.
  if (!activated) {
    return (
      <main className="qia-page" style={styles.page}>
        <style>{RESPONSIVE_CSS}</style>
        <ToastContainer position="top-right" />
        <div style={styles.centeredWrap}>
          <header style={styles.headerRow}>
            <div>
              <BrandHeader orgName={orgDisplayName} />
              <p style={styles.subtitle}>
                Local operator screen for enrollment, recognition, and
                attendance sync confirmation.
              </p>
            </div>
            <div style={styles.offline}>
              <WifiOff size={16} />
              Not activated
            </div>
          </header>

          {error && (
            <div role="alert" style={styles.error}>
              {error}
            </div>
          )}

          <section style={styles.activationCard}>
            <h2 style={styles.sectionTitle}>Activate this branch machine</h2>
            <p style={styles.helper}>
              Paste the branch install token from the Client Dashboard or
              Support Dashboard. The node will receive only a scoped node API
              key.
            </p>
            <label style={styles.label}>
              Railway API URL
              <input
                style={styles.input}
                value={apiBaseUrl}
                onChange={(event) => setApiBaseUrl(event.target.value)}
              />
            </label>
            <label style={styles.label}>
              Install token
              <input
                style={styles.input}
                value={installToken}
                onChange={(event) => setInstallToken(event.target.value)}
                placeholder="qia_install_..."
              />
            </label>
            <label style={styles.label}>
              Node label
              <input
                style={styles.input}
                value={nodeLabel}
                onChange={(event) => setNodeLabel(event.target.value)}
                placeholder="Reception laptop / Main gate"
              />
            </label>
            <button
              type="button"
              style={styles.primaryButton}
              onClick={activate}
              disabled={busy === "activate"}
            >
              {busy === "activate" ? (
                <Loader2 size={15} />
              ) : (
                <ShieldCheck size={15} />
              )}
              Activate node
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="qia-page" style={styles.page}>
      <style>{RESPONSIVE_CSS}</style>
      <ToastContainer position="top-right" />
      {/* Compact header — condensed so the camera grid gets the vertical space */}
      <header className="qia-top-bar" style={styles.topBar}>
        <div style={styles.topBarLeft}>
          <BrandHeader orgName={orgDisplayName} />
          <div style={styles.online}>
            <Wifi size={14} />
            Activated
          </div>
        </div>
        <div className="qia-pill-row" style={styles.pillRow}>
          <Pill
            icon={<Server size={14} />}
            label="Node"
            value={status?.node_id || "—"}
          />
          <Pill icon={<Activity size={14} />} label="Mode" value={modeLabel} />
          <Pill
            icon={<Wifi size={14} />}
            label="Heartbeat"
            value={runtime.last_heartbeat_status || "waiting"}
          />
        </div>
        <div style={styles.topBarActions}>
          <button
            type="button"
            style={styles.secondaryButton}
            onClick={() => void load()}
            disabled={busy !== null}
          >
            {busy === "refresh" ? (
              <Loader2 size={14} />
            ) : (
              <RefreshCcw size={14} />
            )}
            Refresh
          </button>
          <button
            type="button"
            style={styles.primarySmall}
            onClick={runCycle}
            disabled={busy !== null}
          >
            {busy === "cycle" ? <Loader2 size={14} /> : <Activity size={14} />}
            Run cycle
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" style={styles.errorBar}>
          {error}
        </div>
      )}
      {runtime.last_error && (
        <div role="alert" style={styles.warningBar}>
          {runtime.last_error}
        </div>
      )}

      {isLocalMode && (
        <details style={styles.enrollmentDetails}>
          <summary style={styles.enrollmentSummary}>Enrollment data</summary>
          <ImportPanel />
        </details>
      )}

      {/* Main viewport-filling row: camera grid (flexible) + attendance sidebar (fixed) */}
      <section className="qia-main-row" style={styles.mainRow}>
        <div className="qia-camera-col" style={styles.cameraColumn}>
          {isLocalMode ? (
            <CameraGrid events={events} />
          ) : (
            <div style={styles.cloudModeNotice}>
              Camera streaming is only available in local AI mode.
            </div>
          )}
        </div>
        <div className="qia-sidebar-col" style={styles.sidebarColumn}>
          <LiveAttendancePanel
            events={events}
            heldCount={status?.held_attendance_count ?? 0}
            syncing={busy === "sync"}
            onSync={() => void syncAttendance()}
            clearing={busy === "clear"}
            onClear={() => void clearTodayAttendance()}
            onOpenHeldReview={() => setHeldReviewOpen(true)}
          />
        </div>
      </section>

      <HeldReviewPanel
        open={heldReviewOpen}
        onClose={() => setHeldReviewOpen(false)}
        onChanged={() => void load()}
      />
    </main>
  );
}

function BrandHeader({ orgName }: { orgName: string }) {
  return (
    <div style={styles.brand}>
      <span className="qia-brand-org" style={styles.brandOrg}>
        {orgName}
      </span>
      <span style={styles.brandSub}>QIntellect Technologies</span>
    </div>
  );
}

function Pill({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div style={styles.pill}>
      <span style={styles.pillIcon}>{icon}</span>
      <span style={styles.pillLabel}>{label}</span>
      <strong style={styles.pillValue}>{value}</strong>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    height: "100vh",
    width: "100%",
    display: "flex",
    flexDirection: "column",
    background: "#f4f8fb",
    fontFamily: "Inter, system-ui, sans-serif",
    boxSizing: "border-box",
    overflow: "hidden",
  },
  centeredWrap: {
    maxWidth: 720,
    margin: "48px auto",
    padding: "0 24px",
    width: "100%",
    boxSizing: "border-box",
  },
  headerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    marginBottom: 24,
  },
  brand: {
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.15,
    minWidth: 0,
  },
  brandOrg: {
    color: "#0f3557",
    fontSize: 20,
    fontWeight: 800,
    letterSpacing: "-0.03em",
  },
  brandSub: {
    marginTop: 2,
    color: "#64748b",
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  subtitle: { margin: "6px 0 0", color: "#64748b", fontSize: 13 },
  online: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 11px",
    borderRadius: 999,
    color: "#0f766e",
    background: "#ccfbf1",
    fontWeight: 800,
    fontSize: 12,
  },
  offline: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 14px",
    borderRadius: 999,
    color: "#be123c",
    background: "#ffe4e6",
    fontWeight: 900,
    fontSize: 13,
  },
  activationCard: {
    border: "1px solid #dbe7ef",
    borderRadius: 18,
    padding: 20,
    background: "#f8fbfd",
  },
  sectionTitle: { margin: "0 0 12px", color: "#12385a", fontSize: 18 },
  helper: {
    margin: "0 0 16px",
    color: "#64748b",
    fontSize: 13,
    lineHeight: 1.6,
  },
  label: {
    display: "block",
    color: "#334155",
    fontSize: 12,
    fontWeight: 900,
    marginBottom: 13,
  },
  input: {
    display: "block",
    width: "100%",
    boxSizing: "border-box",
    height: 42,
    marginTop: 6,
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    padding: "0 12px",
    fontSize: 14,
  },
  primaryButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    border: 0,
    borderRadius: 10,
    background: "#0d9488",
    color: "#fff",
    padding: "11px 16px",
    fontWeight: 900,
    cursor: "pointer",
  },
  error: {
    border: "1px solid #fecdd3",
    background: "#fff1f2",
    color: "#be123c",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 800,
    marginBottom: 16,
  },

  // Full-page shell
  topBar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    padding: "12px 20px",
    background: "#fff",
    borderBottom: "1px solid #dbe7ef",
  },
  topBarLeft: { display: "flex", alignItems: "center", gap: 12 },
  pillRow: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  pill: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "6px 10px",
    background: "#f8fafc",
  },
  pillIcon: { color: "#0d9488", display: "flex" },
  pillLabel: {
    color: "#64748b",
    fontSize: 10,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: ".05em",
  },
  pillValue: {
    color: "#0f172a",
    fontSize: 12,
    maxWidth: 160,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  topBarActions: { display: "flex", alignItems: "center", gap: 8 },
  primarySmall: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    border: 0,
    borderRadius: 10,
    background: "#0d9488",
    color: "#fff",
    padding: "8px 12px",
    fontWeight: 900,
    cursor: "pointer",
    fontSize: 13,
  },
  secondaryButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    border: "1px solid #cbd5e1",
    borderRadius: 10,
    background: "#fff",
    color: "#0f3557",
    padding: "8px 12px",
    fontWeight: 800,
    cursor: "pointer",
    fontSize: 13,
  },

  errorBar: {
    flexShrink: 0,
    border: "1px solid #fecdd3",
    background: "#fff1f2",
    color: "#be123c",
    padding: "8px 20px",
    fontSize: 13,
    fontWeight: 800,
  },
  warningBar: {
    flexShrink: 0,
    border: "1px solid #fed7aa",
    background: "#fff7ed",
    color: "#c2410c",
    padding: "8px 20px",
    fontSize: 13,
    fontWeight: 800,
  },

  enrollmentDetails: {
    flexShrink: 0,
    padding: "8px 20px",
    background: "#fff",
    borderBottom: "1px solid #dbe7ef",
  },
  enrollmentSummary: {
    cursor: "pointer",
    fontWeight: 800,
    color: "#12385a",
    fontSize: 13,
    padding: "4px 0",
  },

  mainRow: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    gap: 14,
    padding: 16,
    boxSizing: "border-box",
  },
  cameraColumn: { flex: 1, minWidth: 0, minHeight: 0, display: "flex" },
  sidebarColumn: { flexShrink: 0, minWidth: 0, minHeight: 0, display: "flex" },
  cloudModeNotice: {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#64748b",
    fontSize: 13,
    border: "1px dashed #cbd5e1",
    borderRadius: 12,
    background: "#fff",
  },
};
