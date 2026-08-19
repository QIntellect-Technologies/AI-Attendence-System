import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHasMultipleBranches } from "../../hooks/useHasMultipleBranches";
import {
  Activity,
  Camera,
  Clock,
  LayoutGrid,
  MonitorPlay,
  Users,
  WifiOff,
  Zap,
} from "lucide-react";
import { useLiveStream } from "./hooks/useLiveStream";
import { useOrg } from "../../contexts/OrgConfigContext";
import type { LayoutMode, UseLiveStreamReturn } from "./hooks/useLiveStream";
import {
  fetchStreamToken,
  getAuthenticatedStreamUrl,
  getCameraStreamUrl,
  profilePhotoUrl,
  type LiveCamera,
  type LiveDetection,
} from "./api/liveStreamApi";
import {
  getModulePeopleTypesForBranch,
  peopleLabelForType,
} from "../../utils/templateRendering";
import { T } from "../../components/ui/theme";
import ModernSelect from "../../components/ui/ModernSelect";
import JellyButton from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";
import { useAuthenticatedImageUrl } from "../../hooks/useAuthenticatedImageUrl";

// ─── Design tokens (aligned with the light-card system) ──────────────────────

const TOKEN = {
  // Surface
  pageBg: T.bg,
  cardBg: T.card,
  border: T.border,
  // Camera viewport — keeps its dark background for feed contrast
  camBg: "#080d14",
  camBorder: "#1e293b",
  // Teal accent system
  teal: T.teal600,
  tealLight: T.teal50,
  tealBorder: T.teal200,
  // Text
  head: T.head,
  body: T.body,
  muted: T.muted,
  // Status
  online: T.success,
  onlineBg: T.successBg,
  alert: T.amber,
  alertBg: T.amberBg,
  offline: T.slate300,
  // Detection badge
  matched: "#16a34a",
  matchedBg: "#f0fdf4",
  matchedBorder: "#bbf7d0",
  unknown: "#dc2626",
  unknownBg: "#fef2f2",
  unknownBorder: "#fecaca",
} as const;

// ─── Shared card style ────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background: TOKEN.cardBg,
  borderRadius: 14,
  border: `1px solid ${TOKEN.border}`,
  boxShadow: "0 1px 4px rgba(15,45,74,0.06)",
};

// ─── Clock hook ───────────────────────────────────────────────────────────────

function useClock(): string {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString());
  useEffect(() => {
    const id = window.setInterval(
      () => setTime(new Date().toLocaleTimeString()),
      1_000,
    );
    return () => window.clearInterval(id);
  }, []);
  return time;
}

// ─── Layout picker ────────────────────────────────────────────────────────────

const LAYOUT_MODES: LayoutMode[] = [1, 2, 4, "all"];
const LAYOUT_LABELS: Record<LayoutMode, string> = {
  1: "1 Camera",
  2: "2 Cameras",
  4: "4 Cameras",
  all: "All Cameras",
};
const LAYOUT_DESCRIPTIONS: Record<LayoutMode, string> = {
  1: "Single view",
  2: "Side-by-side",
  4: "2×2 grid",
  all: "Show every camera",
};

function LayoutPicker({
  layout,
  setLayout,
  maxCameras,
}: {
  layout: LayoutMode;
  setLayout: (m: LayoutMode) => void;
  maxCameras: number;
}) {
  const options = useMemo(
    () =>
      LAYOUT_MODES.filter(
        (mode) => mode === "all" || mode === 1 || mode <= maxCameras,
      ).map((mode) => ({
        value: String(mode),
        label: LAYOUT_LABELS[mode],
        description: LAYOUT_DESCRIPTIONS[mode],
      })),
    [maxCameras],
  );

  return (
    <ModernSelect
      value={String(layout)}
      options={options}
      onChange={(v) =>
        setLayout(v === "all" ? "all" : (Number(v) as LayoutMode))
      }
      ariaLabel="Camera layout"
      minWidth={140}
    />
  );
}

// ─── People-type filter ─────────────────────────────────────────────────────

function PeopleTypeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (type: string | null) => void;
}) {
  // options[0] is always the synthetic "All" entry, so <= 2 means at most
  // one real people type — nothing to separate, same convention as
  // peopleTypeOptions in useReportFilters/LiveCCTVTracking.
  if (options.length <= 2) return null;

  return (
    <ModernSelect
      value={value}
      options={options}
      onChange={(v) => onChange(v === "all" ? null : v)}
      ariaLabel="People type filter"
      minWidth={150}
    />
  );
}

// ─── Branch filter ──────────────────────────────────────────────────────────

function BranchSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (branchId: number | null) => void;
}) {
  // Same convention as PeopleTypeSelect: options[0] is the synthetic "All
  // Branches" entry, so <= 2 means at most one real branch — nothing to
  // switch between, so the dropdown would be pure clutter.
  if (options.length <= 2) return null;

  return (
    <ModernSelect
      value={value}
      options={options}
      onChange={(v) => onChange(v === "all" ? null : Number(v))}
      ariaLabel="Branch filter"
      minWidth={160}
    />
  );
}

// ─── KPI stat card ────────────────────────────────────────────────────────────

function StatPill({
  label,
  value,
  icon: Icon,
  highlight,
}: {
  label: string;
  value: number | string;
  icon: React.ElementType;
  highlight?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 16px",
        background: highlight ? TOKEN.tealLight : TOKEN.cardBg,
        border: `1px solid ${highlight ? TOKEN.tealBorder : TOKEN.border}`,
        borderRadius: 10,
        minWidth: 120,
      }}
    >
      <Icon size={16} color={highlight ? TOKEN.teal : TOKEN.muted} />
      <div>
        <p
          style={{
            margin: 0,
            fontSize: 11,
            fontWeight: 900,
            color: TOKEN.muted,
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {label}
        </p>
        <p
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 900,
            color: highlight ? TOKEN.teal : TOKEN.head,
            lineHeight: 1.1,
          }}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

// ─── Page header bar ──────────────────────────────────────────────────────────

function PageHeader({
  clock,
  stream,
}: {
  clock: string;
  stream: UseLiveStreamReturn;
}) {
  const {
    streaming,
    startMonitoring,
    stopMonitoring,
    liveCount,
    matchCount,
    todayCount,
    stats,
    noCameras,
    noStreamable,
    isGlobalScope,
    streamableCameras,
    layout,
    setLayout,
    loading,
    refreshCameras,
    refreshDetections,
    refreshStats,
    scopeLabel,
    personLabel,
    isNodeOffline,
    hasOfflineDetections,
    activePeopleTypes,
    peopleTypeFilter,
    setPeopleTypeFilter,
  } = stream;

  const refreshPage = useCallback(async () => {
    await refreshCameras();
    await refreshStats();
    if (streaming) {
      await refreshDetections();
    }
  }, [refreshCameras, refreshDetections, refreshStats, streaming]);

  const { cfg, activeBranchId, setActiveBranchId } = useOrg();

  const peopleTypeOptions = useMemo(
    () => [
      { value: "all", label: `All ${personLabel.plural}` },
      ...activePeopleTypes.map((type) => ({
        value: type,
        label: peopleLabelForType(type, cfg).plural,
      })),
    ],
    [activePeopleTypes, personLabel.plural, cfg],
  );

  const hasMultipleBranches = useHasMultipleBranches();

  const branchOptions = useMemo(
    () => [
      { value: "all", label: "All Branches" },
      ...(cfg.branches || []).map((branch) => ({
        value: String(branch.id),
        label: branch.name,
      })),
    ],
    [cfg.branches],
  );

  return (
    <div
      style={{
        ...cardStyle,
        borderRadius: "14px 14px 0 0",
        padding: "16px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        flexWrap: "wrap",
        borderBottom: `1px solid ${TOKEN.border}`,
      }}
    >
      {/* Left: title + scope */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div
          style={{
            width: 40,
            height: 40,
            background: TOKEN.tealLight,
            border: `1px solid ${TOKEN.tealBorder}`,
            borderRadius: 10,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: TOKEN.teal,
            flexShrink: 0,
          }}
        >
          <MonitorPlay size={20} />
        </div>
        <div>
          <h1
            style={{
              margin: 0,
              fontSize: 18,
              fontWeight: 800,
              color: TOKEN.head,
            }}
          >
            Live {personLabel.plural} Monitoring
          </h1>
          <p
            style={{
              margin: "2px 0 0",
              fontSize: 12,
              color: TOKEN.muted,
              fontWeight: 600,
            }}
          >
            {isNodeOffline ? `⚠️ Local Node Offline - Fallback Active` : ""}
          </p>
        </div>
      </div>

      {/* Right: stats + controls */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <StatPill
          label="Live Now"
          value={liveCount}
          icon={Zap}
          highlight={liveCount > 0}
        />
        <StatPill label="Matched" value={matchCount} icon={Users} />
        <StatPill label="Today" value={todayCount} icon={Activity} />

        {hasOfflineDetections && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "6px 12px",
              background: TOKEN.alertBg,
              border: "1px solid #fbbf24",
              borderRadius: 8,
              fontSize: 11,
              fontWeight: 700,
              color: TOKEN.alert,
            }}
          >
            📵 Fallback Enabled
          </div>
        )}

        {hasMultipleBranches && (
          <BranchSelect
            value={activeBranchId === null ? "all" : String(activeBranchId)}
            options={branchOptions}
            onChange={setActiveBranchId}
          />
        )}

        <PeopleTypeSelect
          value={peopleTypeFilter ?? "all"}
          options={peopleTypeOptions}
          onChange={setPeopleTypeFilter}
        />

        {streamableCameras.length > 1 && (
          <LayoutPicker
            layout={layout}
            setLayout={setLayout}
            maxCameras={streamableCameras.length}
          />
        )}

        <RefreshButton
          iconOnly
          size="md"
          loading={loading}
          onClick={() => void refreshPage()}
          ariaLabel="Refresh live attendance"
        />

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <JellyButton
            type="button"
            variant="primary"
            size="md"
            disabled={noCameras || noStreamable || streaming}
            onClick={startMonitoring}
          >
            ▶ Start
          </JellyButton>
          <JellyButton
            type="button"
            variant="danger"
            size="md"
            disabled={!streaming}
            onClick={stopMonitoring}
          >
            ⏹ Stop
          </JellyButton>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            color: TOKEN.muted,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          <Clock size={13} />
          <span style={{ fontFamily: "monospace", minWidth: 70 }}>{clock}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Camera tile ──────────────────────────────────────────────────────────────

const CameraTile = memo(function CameraTile({
  camera,
  streaming,
  faceCount,
  matchCount,
  todayCount,
}: {
  camera: LiveCamera;
  streaming: boolean;
  faceCount: number;
  matchCount: number;
  todayCount: number;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [errored, setErrored] = useState(false);
  const streamUrl = getCameraStreamUrl(camera);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    if (!streaming || !streamUrl) {
      img.src = "";
      setErrored(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();

    // GET /api/stream/<camera_id> requires a stream_token query param — an
    // <img> tag can't send the Authorization header every other route
    // uses, so a short-lived token has to be minted first via this
    // authenticated call and appended to the URL instead. Re-minted every
    // ~45s (well inside the token's ~60s TTL) so a token is always ready
    // if the browser needs to reopen the MJPEG connection, e.g. after a
    // network blip — the running connection itself isn't affected by the
    // token expiring, only a fresh connection attempt would be.
    const openStream = async () => {
      try {
        const token = await fetchStreamToken(camera.id, controller.signal);
        if (cancelled) return;
        setErrored(false);
        const url = getAuthenticatedStreamUrl(camera, token);
        const joiner = url.includes("?") ? "&" : "?";
        img.src = `${url}${joiner}t=${Date.now()}`;
      } catch (err) {
        if (cancelled || (err as DOMException).name === "AbortError") return;
        setErrored(true);
      }
    };

    void openStream();
    const refreshId = window.setInterval(() => void openStream(), 45_000);

    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(refreshId);
    };
  }, [streaming, streamUrl, camera]);

  const CORNERS = [
    {
      top: 10,
      left: 10,
      borderTop: `2px solid ${TOKEN.teal}`,
      borderLeft: `2px solid ${TOKEN.teal}`,
      borderRadius: "3px 0 0 0",
    },
    {
      top: 10,
      right: 10,
      borderTop: `2px solid ${TOKEN.teal}`,
      borderRight: `2px solid ${TOKEN.teal}`,
      borderRadius: "0 3px 0 0",
    },
    {
      bottom: 44,
      left: 10,
      borderBottom: `2px solid ${TOKEN.teal}`,
      borderLeft: `2px solid ${TOKEN.teal}`,
      borderRadius: "0 0 0 3px",
    },
    {
      bottom: 44,
      right: 10,
      borderBottom: `2px solid ${TOKEN.teal}`,
      borderRight: `2px solid ${TOKEN.teal}`,
      borderRadius: "0 0 3px 0",
    },
  ] as const;

  return (
    <div
      style={{
        position: "relative",
        borderRadius: 12,
        overflow: "hidden",
        background: TOKEN.camBg,
        border: `1px solid ${TOKEN.camBorder}`,
        boxShadow:
          "0 0 0 1px rgba(58,175,169,0.10), 0 8px 24px rgba(0,0,0,0.18)",
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Corner brackets */}
      {CORNERS.map((s, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            width: 18,
            height: 18,
            zIndex: 4,
            ...s,
          }}
        />
      ))}

      {/* Scan line animation */}
      {streaming && !errored && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            zIndex: 5,
            background: `linear-gradient(90deg, transparent, rgba(58,175,169,0.7), transparent)`,
            animation: "camScan 3s linear infinite",
          }}
        />
      )}

      {/* LIVE badge */}
      {streaming && !errored && (
        <div
          style={{
            position: "absolute",
            top: 10,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "rgba(8,13,20,0.75)",
            backdropFilter: "blur(8px)",
            border: "1px solid rgba(34,197,94,0.35)",
            color: "#22c55e",
            padding: "4px 12px",
            borderRadius: 20,
            fontSize: "0.68em",
            fontWeight: 800,
            letterSpacing: "1.5px",
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              background: "#22c55e",
              borderRadius: "50%",
              animation: "pulseDot 1.5s infinite",
            }}
          />
          LIVE
        </div>
      )}

      {/* Idle / error placeholder */}
      {(!streaming || errored) && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            background:
              "radial-gradient(ellipse at center, #0d1520 0%, #080d14 100%)",
          }}
        >
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              border: "1.5px solid #1e293b",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: errored ? "#ef4444" : "#334155",
            }}
          >
            <Camera size={24} />
          </div>
          <p
            style={{
              fontSize: "0.78em",
              color: "#475569",
              textAlign: "center",
              padding: "0 20px",
              margin: 0,
            }}
          >
            {errored
              ? "Stream unavailable — check camera connection"
              : "Press Start to connect"}
          </p>
        </div>
      )}

      {/* MJPEG feed */}
      <img
        ref={imgRef}
        alt={camera.name}
        style={{
          width: "100%",
          flex: 1,
          objectFit: "cover",
          display: streaming && !errored ? "block" : "none",
        }}
        onError={() => setErrored(true)}
      />

      {/* Footer bar */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 4,
          background:
            "linear-gradient(to top, rgba(4,6,10,0.95) 0%, transparent 100%)",
          padding: "16px 12px 10px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
        }}
      >
        <div>
          <div
            style={{
              fontSize: "0.62em",
              color: "#64748b",
              textTransform: "uppercase",
              letterSpacing: "0.8px",
            }}
          >
            {camera.location}
          </div>
          <div
            style={{
              fontSize: "0.82em",
              color: "#e2e8f0",
              fontWeight: 600,
              marginTop: 2,
            }}
          >
            {camera.name}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [
              ["Faces", faceCount],
              ["Match", matchCount],
              ["Today", todayCount],
            ] as [string, number][]
          ).map(([lbl, val]) => (
            <div
              key={lbl}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                padding: "4px 8px",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 7,
              }}
            >
              <span
                style={{
                  fontSize: "0.85em",
                  fontWeight: 700,
                  color: TOKEN.teal,
                }}
              >
                {val}
              </span>
              <span
                style={{
                  fontSize: "0.52em",
                  color: "#64748b",
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  marginTop: 1,
                }}
              >
                {lbl}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

// ─── No cameras placeholder ───────────────────────────────────────────────────

function NoCamerasState({
  reason,
  scopeLabel,
  personLabel,
}: {
  reason: "none" | "no-stream";
  scopeLabel: string;
  personLabel: { singular: string; plural: string };
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 14,
        borderRadius: 12,
        background:
          "radial-gradient(ellipse at center, #0d1520 0%, #080d14 100%)",
        border: `1px solid ${TOKEN.camBorder}`,
        minHeight: 280,
        padding: 32,
      }}
    >
      <Camera size={36} color="#334155" />
      <p
        style={{
          fontSize: "0.85em",
          color: "#94a3b8",
          textAlign: "center",
          maxWidth: 320,
          lineHeight: 1.6,
          margin: 0,
        }}
      >
        {reason === "none"
          ? `No cameras are configured for ${scopeLabel}. Add cameras in Onboarding or Settings to enable live ${personLabel.singular.toLowerCase()} monitoring.`
          : "Cameras are configured but stream URLs are missing. Add RTSP URLs in Settings → Cameras."}
      </p>
    </div>
  );
}

// ─── Camera grid ──────────────────────────────────────────────────────────────

function CameraGrid({ stream }: { stream: UseLiveStreamReturn }) {
  const {
    noCameras,
    noStreamable,
    visibleCameras,
    layout,
    streaming,
    liveCount,
    matchCount,
    todayCount,
    scopeLabel,
    personLabel,
  } = stream;

  if (noCameras)
    return (
      <NoCamerasState
        reason="none"
        scopeLabel={scopeLabel}
        personLabel={personLabel}
      />
    );
  if (noStreamable)
    return (
      <NoCamerasState
        reason="no-stream"
        scopeLabel={scopeLabel}
        personLabel={personLabel}
      />
    );

  return (
    <div
      style={{
        display: "grid",
        // "all" mode previously used repeat(auto-fill, minmax(280px, 1fr)),
        // which packs as many 280px+ columns as the container is wide —
        // on a normal desktop width that fit 3+ cameras per row. The ask
        // is a fixed 2-column layout for every mode except the single-
        // camera view, with extra cameras wrapping onto additional rows
        // via gridAutoRows rather than widening the row.
        gridTemplateColumns: layout === 1 ? "1fr" : "1fr 1fr",
        gridTemplateRows: layout === 4 ? "1fr 1fr" : undefined,
        gridAutoRows: layout === "all" ? "minmax(220px, 1fr)" : undefined,
        gap: 10,
        flex: 1,
        minHeight: 0,
        overflowY: layout === "all" ? "auto" : undefined,
      }}
    >
      {visibleCameras.map((cam) => (
        <CameraTile
          key={cam.id}
          camera={cam}
          streaming={streaming}
          faceCount={liveCount}
          matchCount={matchCount}
          todayCount={todayCount}
        />
      ))}
    </div>
  );
}

// ─── Detection card ───────────────────────────────────────────────────────────

const DetectionCard = memo(function DetectionCard({
  det,
  compact,
}: {
  det: LiveDetection;
  compact: boolean;
}) {
  const [imgErr, setImgErr] = useState(false);
  // /api/users/<id>/photo sits behind @require_client_dashboard_auth, but a
  // plain <img src> can't attach the Bearer token — route it through the
  // authenticated-fetch hook instead, same fix as the staff directory.
  const authedPhotoUrl = useAuthenticatedImageUrl(
    det.userId != null ? profilePhotoUrl(det.userId) : null,
  );
  const isUnknown = det.name === "Unknown";
  const pct = Math.round((det.confidence ?? 0) * 100);
  const empId =
    det.userId != null ? `EMP-${String(det.userId).padStart(3, "0")}` : "—";
  const initials = det.name
    .split(" ")
    .map((n) => n[0] ?? "?")
    .join("")
    .toUpperCase()
    .slice(0, 2);
  const confColor =
    pct >= 80 ? TOKEN.matched : pct >= 60 ? "#b45309" : TOKEN.unknown;
  const accentColor = isUnknown
    ? "#94a3b8"
    : pct >= 80
      ? TOKEN.teal
      : pct >= 60
        ? TOKEN.alert
        : "#ef4444";

  const time = det.timestamp
    ? new Date(det.timestamp).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";

  const source =
    (det.source ?? "")
      .replace("stream_", "")
      .replace(/_/g, " ")
      .toUpperCase() || "CAMERA";

  return (
    <div
      style={{
        ...cardStyle,
        overflow: "hidden",
        animation: "detEnter 0.3s cubic-bezier(0.34,1.56,0.64,1)",
        transition: "border-color 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = TOKEN.teal;
        e.currentTarget.style.boxShadow = "0 4px 18px rgba(58,175,169,0.12)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = TOKEN.border;
        e.currentTarget.style.boxShadow = "0 1px 4px rgba(15,45,74,0.06)";
      }}
    >
      <div style={{ display: "flex" }}>
        {/* Accent strip */}
        <div style={{ width: 4, background: accentColor, flexShrink: 0 }} />

        <div
          style={{
            flex: 1,
            padding: compact ? "10px 12px" : "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: compact ? 8 : 12,
              flexDirection: compact ? "column" : "row",
            }}
          >
            {/* Avatar */}
            <div style={{ position: "relative", flexShrink: 0 }}>
              <div
                style={{
                  width: compact ? 48 : 60,
                  height: compact ? 48 : 60,
                  borderRadius: 10,
                  background: isUnknown
                    ? "linear-gradient(135deg,#94a3b8,#64748b)"
                    : `linear-gradient(135deg, ${TOKEN.teal}, #1d8a84)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 800,
                  fontSize: compact ? "0.85em" : "1em",
                  color: "#fff",
                  overflow: "hidden",
                  border: `2px solid ${TOKEN.border}`,
                }}
              >
                {det.userId != null && !imgErr && authedPhotoUrl ? (
                  <img
                    src={authedPhotoUrl}
                    alt={det.name}
                    onError={() => setImgErr(true)}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  initials
                )}
              </div>
              <span
                style={{
                  position: "absolute",
                  bottom: -2,
                  right: -2,
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  border: "2px solid #fff",
                  background: isUnknown ? "#94a3b8" : "#22c55e",
                }}
              />
            </div>

            {/* Info */}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: compact ? "center" : "left",
              }}
            >
              <div
                style={{
                  fontSize: compact ? "0.85em" : "0.95em",
                  fontWeight: 800,
                  color: TOKEN.head,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {det.name}
              </div>
              {det.department ? (
                <div
                  style={{
                    fontSize: "0.72em",
                    color: TOKEN.teal,
                    fontWeight: 700,
                    marginTop: 2,
                  }}
                >
                  {det.department}
                </div>
              ) : (
                <div
                  style={{ fontSize: "0.7em", color: "#94a3b8", marginTop: 2 }}
                >
                  No department
                </div>
              )}
              <div
                style={{
                  fontSize: "0.68em",
                  color: TOKEN.muted,
                  fontFamily: "monospace",
                  marginTop: 2,
                }}
              >
                {empId}
              </div>
              <div
                style={{
                  fontSize: "0.67em",
                  color: "#94a3b8",
                  marginTop: 2,
                  display: "flex",
                  gap: 8,
                  justifyContent: compact ? "center" : "flex-start",
                }}
              >
                <span>{time}</span>
                <span>{source}</span>
              </div>
            </div>

            {/* Confidence */}
            <div style={{ flexShrink: 0, textAlign: "center" }}>
              <span
                style={{
                  fontSize: compact ? "1.1em" : "1.3em",
                  fontWeight: 800,
                  fontFamily: "monospace",
                  color: confColor,
                }}
              >
                {pct}%
              </span>
              <div
                style={{
                  fontSize: "0.52em",
                  fontWeight: 600,
                  color: TOKEN.muted,
                  textTransform: "uppercase",
                }}
              >
                Match
              </div>
            </div>
          </div>

          <div style={{ height: 1, background: TOKEN.border }} />

          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                fontSize: "0.62em",
                fontWeight: 800,
                padding: "3px 9px",
                borderRadius: 6,
                background: isUnknown ? TOKEN.unknownBg : TOKEN.matchedBg,
                border: `1px solid ${isUnknown ? TOKEN.unknownBorder : TOKEN.matchedBorder}`,
                color: isUnknown ? TOKEN.unknown : TOKEN.matched,
              }}
            >
              {isUnknown ? "⚠ Unknown" : "✓ Marked Attended"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── Detection sidebar ────────────────────────────────────────────────────────

function DetectionSidebar({ stream }: { stream: UseLiveStreamReturn }) {
  const { stats, detections, liveCount, refreshDetections, personLabel } =
    stream;
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  const statItems = [
    {
      val: stats.enrolledCount ?? "—",
      color: TOKEN.teal,
      label: `Total ${personLabel.plural}`,
    },
    {
      val: stats.presentCount ?? "—",
      color: "#22c55e",
      label: "Present Today",
    },
    { val: stats.totalLogs ?? "—", color: TOKEN.alert, label: "Detections" },
    { val: liveCount, color: "#ef4444", label: "Live" },
  ];

  return (
    <div
      style={{
        ...cardStyle,
        borderRadius: "0 14px 14px 0",
        borderLeft: "none",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        width: 360,
        flexShrink: 0,
      }}
    >
      {/* Sidebar header */}
      <div
        style={{
          padding: "14px 16px 0",
          borderBottom: `1px solid ${TOKEN.border}`,
          flexShrink: 0,
        }}
      >
        {/* Teal accent bar */}
        <div
          style={{
            height: 3,
            background: `linear-gradient(90deg, ${TOKEN.teal} 0%, #2ee8c0 60%, ${TOKEN.teal} 100%)`,
            borderRadius: "2px 2px 0 0",
            marginBottom: 12,
          }}
        />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <div
            style={{ fontSize: "0.82em", fontWeight: 800, color: TOKEN.head }}
          >
            {stream.personLabel?.plural || "Attendance"} Monitor
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              background: TOKEN.onlineBg,
              border: "1px solid #bbf7d0",
              color: "#15803d",
              fontSize: "0.6em",
              fontWeight: 800,
              padding: "3px 9px",
              borderRadius: 20,
              letterSpacing: "0.8px",
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                background: "#22c55e",
                borderRadius: "50%",
                animation: "pulseDot 1.5s infinite",
              }}
            />
            LIVE
          </div>
        </div>

        {/* Aggregate stats */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4,1fr)",
            marginBottom: 14,
          }}
        >
          {statItems.map((s, i) => (
            <div
              key={s.label}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 2,
                borderLeft: i > 0 ? `1px solid ${TOKEN.border}` : "none",
              }}
            >
              <span
                style={{
                  fontSize: "1.4em",
                  fontWeight: 800,
                  lineHeight: 1,
                  color: s.color,
                }}
              >
                {s.val}
              </span>
              <span
                style={{
                  fontSize: "0.55em",
                  fontWeight: 600,
                  color: TOKEN.muted,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                }}
              >
                {s.label}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Detection toolbar */}
      <div
        style={{
          padding: "9px 14px",
          borderBottom: `1px solid ${TOKEN.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <span
            style={{
              fontSize: "0.75em",
              fontWeight: 800,
              color: TOKEN.head,
              textTransform: "uppercase",
              letterSpacing: "0.4px",
            }}
          >
            Detections
          </span>
          <span
            style={{
              background: TOKEN.teal,
              color: "#fff",
              fontSize: "0.62em",
              fontWeight: 800,
              padding: "2px 8px",
              borderRadius: 20,
              minWidth: 22,
              textAlign: "center",
            }}
          >
            {detections.length}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <ModernSelect
            value={viewMode}
            options={[
              { value: "list", label: "List" },
              { value: "grid", label: "Grid" },
            ]}
            onChange={(v) => setViewMode(v as "list" | "grid")}
            ariaLabel="Detection view"
            minWidth={90}
          />
          <JellyButton
            type="button"
            variant="secondary"
            size="sm"
            iconOnly
            aria-label="Refresh detections"
            onClick={refreshDetections}
          >
            ↻
          </JellyButton>
        </div>
      </div>

      {/* Detection feed */}
      <div
        style={{
          flex: 1,
          overflowY: "auto",
          padding: 10,
          display: "grid",
          gridTemplateColumns: viewMode === "grid" ? "1fr 1fr" : "1fr",
          gap: 7,
          alignContent: "start",
        }}
      >
        {detections.length === 0 ? (
          <EmptyDetections />
        ) : (
          detections.map((d) => (
            <DetectionCard key={d.key} det={d} compact={viewMode === "grid"} />
          ))
        )}
      </div>

      {/* Sidebar footer */}
      <div
        style={{
          padding: "8px 16px",
          borderTop: `1px solid ${TOKEN.border}`,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{ fontSize: "0.64em", color: TOKEN.muted, fontWeight: 500 }}
        >
          ⚙ AI Engine
        </span>
        <span
          style={{
            fontSize: "0.68em",
            fontWeight: 700,
            color: TOKEN.teal,
            fontFamily: "monospace",
          }}
        >
          YOLOv8 · InsightFace
        </span>
      </div>
    </div>
  );
}

// ─── Empty detections state ───────────────────────────────────────────────────

function EmptyDetections() {
  return (
    <div
      style={{
        gridColumn: "1 / -1",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        padding: "40px 20px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          width: 52,
          height: 52,
          borderRadius: 14,
          background: TOKEN.tealLight,
          border: `1.5px solid ${TOKEN.tealBorder}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: TOKEN.teal,
          opacity: 0.6,
        }}
      >
        <WifiOff size={22} />
      </div>
      <div>
        <p
          style={{
            fontSize: "0.82em",
            fontWeight: 700,
            color: TOKEN.head,
            margin: 0,
          }}
        >
          No detections yet
        </p>
        <p style={{ fontSize: "0.75em", color: TOKEN.muted, marginTop: 3 }}>
          Start monitoring to begin live attendance tracking.
        </p>
      </div>
    </div>
  );
}

// ─── Error banner ─────────────────────────────────────────────────────────────

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div
      style={{
        margin: "0 0 12px",
        padding: "10px 16px",
        background: TOKEN.unknownBg,
        border: `1px solid ${TOKEN.unknownBorder}`,
        borderRadius: 10,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        fontSize: 13,
        color: TOKEN.unknown,
        fontWeight: 600,
      }}
    >
      <span>⚠ {message}</span>
      <button
        onClick={onDismiss}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: TOKEN.unknown,
          fontWeight: 800,
          fontSize: 16,
          lineHeight: 1,
        }}
      >
        ×
      </button>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function LiveAttendanceMonitor() {
  const clock = useClock();
  const stream = useLiveStream();
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const showError = stream.error && stream.error !== dismissedError;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        background: TOKEN.pageBg,
        fontFamily: "'DM Sans','Inter','Segoe UI',system-ui,sans-serif",
        padding: "20px 24px",
        gap: 0,
        boxSizing: "border-box",
      }}
    >
      <style>{GLOBAL_STYLES}</style>

      {showError && stream.error && (
        <ErrorBanner
          message={stream.error}
          onDismiss={() => setDismissedError(stream.error)}
        />
      )}

      {/* Header + camera grid + sidebar in one visual card unit */}
      <div
        style={{
          ...cardStyle,
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <PageHeader clock={clock} stream={stream} />

        <div
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          {/* Camera area */}
          <div
            style={{
              flex: 1,
              padding: 14,
              display: "flex",
              flexDirection: "column",
              gap: 10,
              minHeight: 0,
              overflow: "hidden",
            }}
          >
            <CameraGrid stream={stream} />

            {/* Layout grid indicator for 4-view */}
            {stream.layout === 4 && stream.streamableCameras.length > 4 && (
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  color: TOKEN.muted,
                  textAlign: "center",
                  fontWeight: 600,
                }}
              >
                Showing {Math.min(4, stream.streamableCameras.length)} of{" "}
                {stream.streamableCameras.length} cameras
              </p>
            )}
          </div>

          {/* Detection sidebar */}
          <DetectionSidebar stream={stream} />
        </div>
      </div>
    </div>
  );
}

// ─── Keyframe animations ──────────────────────────────────────────────────────

const GLOBAL_STYLES = `
  @keyframes pulseDot {
    0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
    70%  { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
    100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
  }
  @keyframes camScan {
    0%   { top: 0; opacity: 1; }
    90%  { opacity: 1; }
    100% { top: 100%; opacity: 0; }
  }
  @keyframes detEnter {
    from { opacity: 0; transform: translateY(8px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #1a699f; }
`;
