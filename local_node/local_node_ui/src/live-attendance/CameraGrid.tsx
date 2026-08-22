import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Camera as CameraIcon,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Maximize2,
  Play,
  Square,
} from "lucide-react";
import {
  localNodeApi,
  humanizeError,
  type CameraInfo,
} from "../api/localNodeApi";
import type { LiveAttendanceEventView } from "./types";

type ViewMode = "grid" | "tabs";
type PageSize = 4 | 6;

interface Props {
  events: LiveAttendanceEventView[];
}

const RECENT_MATCH_WINDOW_MS = 4000;
const CAMERA_LIST_REFRESH_MS = 15000;
const LIVE_WINDOW_MS = 60_000;

// How long a tile can sit hidden (Tabs view, not the selected tab) before
// its MJPEG connection is actually closed. A browser allows only ~6
// concurrent connections per origin on HTTP/1.1; with every enabled camera
// streaming at once (previously true regardless of view — see the comment
// above the grid render below) those connections crowd out /api/status and
// /api/live-events polling and the whole UI feels frozen. A short grace
// period — instead of tearing down the instant a tile is hidden — is what
// keeps quick back-and-forth tab clicks from paying a full reconnect each
// time; only a tile that stays genuinely unwatched past this window gives
// its connection back.
const HIDDEN_TILE_TEARDOWN_DELAY_MS = 5000;

// Every tile — grid or single-camera tab — is sized off this ratio instead
// of a parent-height fraction (the old `1fr`/`minmax` grid-row approach).
// That's what lets tiles stay a constant, comfortable size no matter how
// many cameras are enrolled: the grid's own height simply grows by one row
// per pair of cameras and the page scrolls, rather than every tile
// shrinking to keep the whole grid inside the viewport.
const TILE_ASPECT_RATIO = "16 / 9";

// Grid view no longer streams every enabled camera at once. Past ~6
// simultaneous MJPEG connections, the browser's per-origin connection cap
// (HTTP/1.1, ~6 concurrent) starves /api/status and /api/live-events
// polling and the UI stalls — the same problem Tabs view already solves by
// only keeping the selected tile connected. Paging applies that same fix
// to Grid view: only the cameras on the current page are ever `isVisible`
// (see the render loop below), so only they hold an open stream. Off-page
// tiles reuse CameraTile's existing hidden-tile teardown grace period
// (HIDDEN_TILE_TEARDOWN_DELAY_MS) rather than any new mechanism.
const PAGE_SIZE_OPTIONS: PageSize[] = [4, 6];
const DEFAULT_PAGE_SIZE: PageSize = 4;

const TOKEN = {
  camBg: "#080d14",
  camBorder: "#1e293b",
  teal: "#0d9488",
  tealLight: "#f0fdfa",
  tealBorder: "#99f6e4",
  border: "#dbe7ef",
  head: "#0f172a",
  muted: "#64748b",
} as const;

function CameraTile({
  camera,
  streaming,
  isVisible,
  matchEvent,
  faceCount,
  matchCount,
  todayCount,
}: {
  camera: CameraInfo;
  streaming: boolean;
  isVisible: boolean;
  matchEvent: LiveAttendanceEventView | undefined;
  faceCount: number;
  matchCount: number;
  todayCount: number;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [errored, setErrored] = useState(false);
  const streamUrl = localNodeApi.cameraStreamUrl(camera.id);
  const teardownTimerRef = useRef<number | null>(null);

  // Imperative src assignment (not React-rendered `src`) so Stop actually
  // closes the MJPEG connection instead of leaving it open off-screen, and
  // Start reconnects with a cache-busting timestamp instead of reusing a
  // browser-cached, possibly-stale multipart stream.
  //
  // Visible tiles connect immediately and cancel any pending teardown.
  // Hidden tiles (Tabs view, not the selected tab) get a grace period
  // (HIDDEN_TILE_TEARDOWN_DELAY_MS) before their connection is actually
  // closed, so switching tabs back and forth doesn't reconnect every time —
  // only a tile that stays hidden past the grace period gives its
  // connection back.
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;

    const clearPendingTeardown = () => {
      if (teardownTimerRef.current !== null) {
        window.clearTimeout(teardownTimerRef.current);
        teardownTimerRef.current = null;
      }
    };

    if (!streaming) {
      clearPendingTeardown();
      // Clear any stale error from a previous connection attempt — this is
      // an intentional stop, not a failure, and should show "Press Start
      // to connect", not the red error state.
      setErrored(false);
      img.src = "";
      return clearPendingTeardown;
    }

    if (isVisible) {
      clearPendingTeardown();
      setErrored(false);
      const joiner = streamUrl.includes("?") ? "&" : "?";
      img.src = `${streamUrl}${joiner}t=${Date.now()}`;
    } else {
      clearPendingTeardown();
      teardownTimerRef.current = window.setTimeout(() => {
        img.src = "";
        teardownTimerRef.current = null;
      }, HIDDEN_TILE_TEARDOWN_DELAY_MS);
    }

    return clearPendingTeardown;
  }, [streaming, isVisible, streamUrl]);

  return (
    <div style={styles.tile}>
      <div
        style={{
          ...styles.corner,
          top: 10,
          left: 10,
          borderTop: `2px solid ${TOKEN.teal}`,
          borderLeft: `2px solid ${TOKEN.teal}`,
          borderRadius: "3px 0 0 0",
        }}
      />
      <div
        style={{
          ...styles.corner,
          top: 10,
          right: 10,
          borderTop: `2px solid ${TOKEN.teal}`,
          borderRight: `2px solid ${TOKEN.teal}`,
          borderRadius: "0 3px 0 0",
        }}
      />
      <div
        style={{
          ...styles.corner,
          bottom: 44,
          left: 10,
          borderBottom: `2px solid ${TOKEN.teal}`,
          borderLeft: `2px solid ${TOKEN.teal}`,
          borderRadius: "0 0 0 3px",
        }}
      />
      <div
        style={{
          ...styles.corner,
          bottom: 44,
          right: 10,
          borderBottom: `2px solid ${TOKEN.teal}`,
          borderRight: `2px solid ${TOKEN.teal}`,
          borderRadius: "0 0 3px 0",
        }}
      />

      {streaming && !errored && (
        <div style={styles.liveBadge}>
          <span style={styles.liveDot} />
          LIVE
        </div>
      )}

      {(!streaming || errored) && (
        <div style={styles.errorState}>
          <CameraIcon size={24} color={errored ? "#ef4444" : "#334155"} />
          <p style={styles.errorText}>
            {errored
              ? "Stream unavailable — check camera connection"
              : "Press Start to connect"}
          </p>
        </div>
      )}

      <img
        ref={imgRef}
        alt={camera.name}
        style={{
          ...styles.feed,
          display: streaming && !errored ? "block" : "none",
        }}
        onError={() => {
          // Guard against the empty-`src` teardown above (setting img.src =
          // "" fires a spurious error in some browsers) — only a failure
          // while we're actually trying to stream counts as a real error.
          if (streaming) setErrored(true);
        }}
      />

      <div className="qia-cam-footer" style={styles.footer}>
        <div>
          <div style={styles.footerLocation}>
            {camera.location || "Unassigned"}
          </div>
          <div style={styles.footerName}>{camera.name}</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {(
            [
              ["Faces", faceCount],
              ["Match", matchCount],
              ["Today", todayCount],
            ] as [string, number][]
          ).map(([label, value]) => (
            <div key={label} style={styles.statChip}>
              <span style={styles.statValue}>{value}</span>
              <span style={styles.statLabel}>{label}</span>
            </div>
          ))}
        </div>
      </div>

      {streaming && matchEvent && (
        <div style={styles.matchToast}>
          {matchEvent.snapshot && (
            <img
              src={`data:image/jpeg;base64,${matchEvent.snapshot}`}
              alt={matchEvent.name}
              style={styles.thumb}
            />
          )}
          <div>
            <strong style={styles.matchName}>{matchEvent.name}</strong>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CameraGrid({ events }: Props) {
  const [cameras, setCameras] = useState<CameraInfo[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<PageSize>(DEFAULT_PAGE_SIZE);
  const [currentPage, setCurrentPage] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await localNodeApi.cameras();
        if (!cancelled) {
          setCameras(res.cameras);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(humanizeError(err, "Failed to load cameras."));
      }
    };
    void load();
    const interval = window.setInterval(
      () => void load(),
      CAMERA_LIST_REFRESH_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // Tabs are built straight from whatever the dashboard currently reports,
  // so the selection self-heals if a camera is renamed/removed there — no
  // effect needed to "repair" a stale id, this just re-derives on render.
  const selectedCamera = useMemo(
    () =>
      cameras.find((camera) => camera.id === selectedCameraId) ??
      cameras[0] ??
      null,
    [cameras, selectedCameraId],
  );

  const totalPages = Math.max(1, Math.ceil(cameras.length / pageSize));

  // Clamp instead of resetting to 0 outright, so shrinking from e.g. page 3
  // to a 2-page list lands on the new last page rather than always
  // snapping back to page 1.
  useEffect(() => {
    setCurrentPage((page) => Math.min(page, totalPages - 1));
  }, [totalPages]);

  const visiblePageIds = useMemo(() => {
    const start = currentPage * pageSize;
    return new Set(cameras.slice(start, start + pageSize).map((c) => c.id));
  }, [cameras, currentPage, pageSize]);

  const matchByCamera = useMemo(() => {
    const map = new Map<string, LiveAttendanceEventView>();
    const now = Date.now();
    const activityTimestamp = (event: LiveAttendanceEventView) =>
      new Date(event.check_out_marked_at || event.marked_at).getTime();
    for (const event of events) {
      if (!event.camera_id) continue;
      if (now - activityTimestamp(event) > RECENT_MATCH_WINDOW_MS) continue;
      const existing = map.get(event.camera_id);
      if (!existing || activityTimestamp(event) > activityTimestamp(existing)) {
        map.set(event.camera_id, event);
      }
    }
    return map;
  }, [events]);

  // Aggregate KPIs computed from the node's own /api/live-events feed — there
  // is no /api/stats endpoint on the local node the way there is on the cloud
  // dashboard, so these are derived rather than fetched.
  const { faceCount, matchCount, todayCount } = useMemo(() => {
    const now = Date.now();
    const today = new Date().toDateString();
    let live = 0;
    let matched = 0;
    let marked = 0;
    for (const event of events) {
      if (now - new Date(event.marked_at).getTime() <= LIVE_WINDOW_MS)
        live += 1;
      if (event.status !== "failed") matched += 1;
      if (new Date(event.marked_at).toDateString() === today) marked += 1;
    }
    return { faceCount: live, matchCount: matched, todayCount: marked };
  }, [events]);

  if (error) return <div style={styles.error}>{error}</div>;

  if (cameras.length === 0) {
    return (
      <div style={styles.empty}>
        <CameraIcon size={36} color="#334155" />
        <p style={styles.emptyText}>
          No cameras are configured for this branch, or the node hasn't started
          streaming yet.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.wrap}>
      <style>{KEYFRAMES}</style>
      <div className="qia-cam-toolbar" style={styles.toolbar}>
        <div
          className="qia-view-toggle"
          style={styles.viewToggle}
          role="tablist"
          aria-label="Camera view mode"
        >
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "grid"}
            onClick={() => setViewMode("grid")}
            style={{
              ...styles.viewToggleButton,
              ...(viewMode === "grid" ? styles.viewToggleButtonActive : {}),
            }}
          >
            <LayoutGrid size={14} />
            Grid
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "tabs"}
            onClick={() => setViewMode("tabs")}
            style={{
              ...styles.viewToggleButton,
              ...(viewMode === "tabs" ? styles.viewToggleButtonActive : {}),
            }}
          >
            <Maximize2 size={14} />
            Tabs
          </button>
        </div>

        {viewMode === "grid" && cameras.length > PAGE_SIZE_OPTIONS[0] && (
          <div
            className="qia-page-size-toggle"
            style={styles.viewToggle}
            role="group"
            aria-label="Cameras per page"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <button
                key={size}
                type="button"
                onClick={() => {
                  setPageSize(size);
                  setCurrentPage(0);
                }}
                style={{
                  ...styles.viewToggleButton,
                  ...(pageSize === size ? styles.viewToggleButtonActive : {}),
                }}
              >
                {size}/page
              </button>
            ))}
          </div>
        )}

        {viewMode === "grid" && totalPages > 1 && (
          <div className="qia-page-nav" style={styles.pageNav}>
            <button
              type="button"
              onClick={() => setCurrentPage((page) => Math.max(0, page - 1))}
              disabled={currentPage === 0}
              aria-label="Previous page"
              style={{
                ...styles.pageNavButton,
                opacity: currentPage === 0 ? 0.4 : 1,
                cursor: currentPage === 0 ? "not-allowed" : "pointer",
              }}
            >
              <ChevronLeft size={14} />
            </button>
            <span style={styles.pageNavLabel}>
              Page {currentPage + 1} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() =>
                setCurrentPage((page) => Math.min(totalPages - 1, page + 1))
              }
              disabled={currentPage >= totalPages - 1}
              aria-label="Next page"
              style={{
                ...styles.pageNavButton,
                opacity: currentPage >= totalPages - 1 ? 0.4 : 1,
                cursor:
                  currentPage >= totalPages - 1 ? "not-allowed" : "pointer",
              }}
            >
              <ChevronRight size={14} />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => setStreaming(true)}
          disabled={streaming}
          style={{
            ...styles.controlButton,
            ...styles.startButton,
            opacity: streaming ? 0.5 : 1,
            cursor: streaming ? "not-allowed" : "pointer",
          }}
        >
          <Play size={13} /> Start
        </button>
        <button
          type="button"
          onClick={() => setStreaming(false)}
          disabled={!streaming}
          style={{
            ...styles.controlButton,
            ...styles.stopButton,
            opacity: !streaming ? 0.5 : 1,
            cursor: !streaming ? "not-allowed" : "pointer",
          }}
        >
          <Square size={13} /> Stop
        </button>

        <span className="qia-cam-count" style={styles.count}>
          {cameras.length} camera(s) enabled
        </span>
      </div>
      {viewMode === "tabs" && (
        <div
          className="qia-cam-tabbar"
          style={styles.tabBar}
          role="tablist"
          aria-label="Cameras"
        >
          {cameras.map((camera) => (
            <button
              key={camera.id}
              type="button"
              role="tab"
              aria-selected={camera.id === selectedCamera?.id}
              onClick={() => setSelectedCameraId(camera.id)}
              style={{
                ...styles.tab,
                ...(camera.id === selectedCamera?.id ? styles.tabActive : {}),
              }}
            >
              {camera.name}
            </button>
          ))}
        </div>
      )}

      {/*
        Every enabled camera is mounted here ALWAYS, in both view modes —
        Grid vs. Tabs only ever changes CSS (grid-template-columns + which
        tiles are display:none), never which CameraTile instances exist.

        This used to be two separate branches, each with its own
        `cameras.map(...)` / conditional single-camera render. Switching
        between them meant React tore down every <img> (and the browser's
        underlying MJPEG connection with it) and rebuilt them from
        scratch — which is real, unavoidable network latency, made worse
        by the backend's fixed waitress thread pool (each open stream
        holds a worker thread for its whole lifetime; see main.py). Always
        mounting every CameraTile fixes that: switching Grid/Tabs never
        remounts a component or drops a connection that was already open.

        The MJPEG connection itself is a separate concern from mounting,
        handled inside CameraTile via the `isVisible` prop below: a tile
        that's actually on-screen stays connected, but a hidden tile gives
        its connection back after a short grace period. A browser only
        allows ~6 concurrent connections per origin (HTTP/1.1) — with every
        camera streaming regardless of visibility, a full grid of cameras
        starves /api/status and /api/live-events polling of a connection
        and the whole UI feels frozen. Tabs view has always avoided this by
        only connecting the selected camera; Grid view now does the same
        via paging — only the cameras on the current page (visiblePageIds)
        are `isVisible`, so a 15-camera branch never opens more than
        `pageSize` streams at once, no matter how many cameras it has.
      */}
      <div
        className={`qia-cam-grid${viewMode === "tabs" ? " qia-cam-grid--single" : ""}`}
        style={viewMode === "grid" ? styles.grid : styles.singleGrid}
      >
        {cameras.map((camera) => {
          const isVisible =
            viewMode === "grid"
              ? visiblePageIds.has(camera.id)
              : camera.id === selectedCamera?.id;
          return (
            <div
              key={camera.id}
              style={isVisible ? undefined : styles.hiddenTile}
            >
              <CameraTile
                camera={camera}
                streaming={streaming}
                isVisible={isVisible}
                matchEvent={matchByCamera.get(camera.id)}
                faceCount={faceCount}
                matchCount={matchCount}
                todayCount={todayCount}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  // No `flex: 1` / `minHeight: 0` here anymore: this column used to be a
  // bounded box with its own internal scrollbar (styles.grid below used to
  // set overflowY: "auto"). It's now an ordinary block that grows to fit
  // however many camera rows exist, and the shared scrollbar lives one
  // level up on App.tsx's main row.
  wrap: {
    display: "flex",
    flexDirection: "column",
    // .qia-camera-col (App.tsx) is a row-direction flex container; a
    // flex item with no flex-grow shrink-wraps to its content instead of
    // filling the row. Without an explicit width here, the grid below
    // has no definite container size, so its `1fr` columns collapse to
    // max-content — tiny tiles pinned to the left instead of filling the
    // panel. This is what was making tiles look wrong AND made the
    // Tabs view visibly "grow into" its final size once a frame arrived.
    width: "100%",
    gap: 10,
  },
  toolbar: { flexShrink: 0, display: "flex", alignItems: "center", gap: 10 },
  viewToggle: {
    display: "inline-flex",
    padding: 3,
    background: "#f1f5f9",
    border: "1px solid #dbe7ef",
    borderRadius: 9,
    gap: 2,
  },
  viewToggleButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    background: "transparent",
    color: TOKEN.muted,
    borderRadius: 6,
    padding: "5px 10px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  viewToggleButtonActive: {
    background: "#fff",
    color: TOKEN.head,
    boxShadow: "0 1px 2px rgba(15,23,42,0.12)",
  },
  pageNav: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
  },
  pageNavButton: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid #dbe7ef",
    background: "#fff",
    color: TOKEN.head,
    borderRadius: 6,
    width: 26,
    height: 26,
    padding: 0,
  },
  pageNavLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: TOKEN.muted,
    padding: "0 4px",
    whiteSpace: "nowrap",
  },
  tabBar: {
    flexShrink: 0,
    display: "flex",
    gap: 6,
    overflowX: "auto",
    paddingBottom: 2,
  },
  tab: {
    flexShrink: 0,
    border: "1px solid #dbe7ef",
    background: "#fff",
    color: TOKEN.muted,
    borderRadius: 8,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  tabActive: {
    border: `1px solid ${TOKEN.teal}`,
    background: TOKEN.tealLight,
    color: TOKEN.teal,
  },
  controlButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    border: "none",
    borderRadius: 8,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 800,
  },
  startButton: { background: TOKEN.teal, color: "#fff" },
  stopButton: {
    background: "#fff",
    color: "#be123c",
    border: "1px solid #fecdd3",
  },
  count: { fontSize: 12, color: TOKEN.muted },
  // Always 2 fixed columns — no more branching on a selected layout count.
  // No flex/minHeight/overflow: height is purely the sum of however many
  // aspect-ratio-sized rows the camera count needs.
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
  },
  // Tabs view: a single column, single tile — still aspect-ratio sized (via
  // CameraTile's own styles.tile), just full-width instead of half-width.
  singleGrid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 10,
  },
  // Keeps a camera's tile (and its live <img> connection) mounted while
  // it's just not the one currently on screen — see the render comment
  // above. display:none removes it from layout without unmounting it.
  hiddenTile: { display: "none" },
  tile: {
    position: "relative",
    borderRadius: 12,
    overflow: "hidden",
    background: TOKEN.camBg,
    border: `1px solid ${TOKEN.camBorder}`,
    boxShadow: "0 0 0 1px rgba(58,175,169,0.10), 0 8px 24px rgba(0,0,0,0.18)",
    display: "flex",
    flexDirection: "column",
    aspectRatio: TILE_ASPECT_RATIO,
  },
  corner: { position: "absolute", width: 18, height: 18, zIndex: 4 },
  liveBadge: {
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
  },
  liveDot: {
    width: 7,
    height: 7,
    background: "#22c55e",
    borderRadius: "50%",
    animation: "pulseDot 1.5s infinite",
  },
  // Height comes from the tile's own aspect-ratio now (see styles.tile)
  // instead of a flex-fill parent, so this is a plain 100%/100% fill.
  feed: { width: "100%", height: "100%", objectFit: "contain" },
  errorState: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    background: "radial-gradient(ellipse at center, #0d1520 0%, #080d14 100%)",
  },
  errorText: {
    fontSize: "0.78em",
    color: "#94a3b8",
    textAlign: "center",
    padding: "0 20px",
    margin: 0,
  },
  footer: {
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
  },
  footerLocation: {
    fontSize: "0.62em",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.8px",
  },
  footerName: {
    fontSize: "0.82em",
    color: "#e2e8f0",
    fontWeight: 600,
    marginTop: 2,
  },
  statChip: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    padding: "4px 8px",
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 7,
  },
  statValue: { fontSize: "0.85em", fontWeight: 700, color: TOKEN.teal },
  statLabel: {
    fontSize: "0.52em",
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    marginTop: 1,
  },
  matchToast: {
    position: "absolute",
    left: 10,
    right: 10,
    top: 44,
    zIndex: 7,
    display: "flex",
    alignItems: "center",
    gap: 10,
    background: "rgba(236,253,245,.97)",
    border: "1px solid #a7f3d0",
    borderRadius: 12,
    padding: 8,
  },
  thumb: { width: 40, height: 40, borderRadius: 8, objectFit: "cover" },
  matchName: { display: "block", fontSize: 13, color: "#047857" },
  matchMeta: { fontSize: 11, color: "#0f766e", fontWeight: 700 },
  empty: {
    flex: 1,
    minHeight: 260,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
    borderRadius: 12,
    background: "radial-gradient(ellipse at center, #0d1520 0%, #080d14 100%)",
    border: `1px solid ${TOKEN.camBorder}`,
    padding: 32,
  },
  emptyText: {
    fontSize: "0.85em",
    color: "#94a3b8",
    textAlign: "center",
    maxWidth: 320,
    lineHeight: 1.6,
    margin: 0,
  },
  error: {
    border: "1px solid #fecdd3",
    background: "#fff1f2",
    color: "#be123c",
    borderRadius: 12,
    padding: "10px 12px",
    fontSize: 13,
    fontWeight: 700,
  },
};

const KEYFRAMES = `
  @keyframes pulseDot {
    0%   { box-shadow: 0 0 0 0 rgba(34,197,94,0.6); }
    70%  { box-shadow: 0 0 0 6px rgba(34,197,94,0); }
    100% { box-shadow: 0 0 0 0 rgba(34,197,94,0); }
  }
  /* Toolbar and tile footer used to be plain flex rows with no wrap, so
     the select + Start/Stop buttons + camera count would push past the
     panel edge and cause horizontal scrolling on narrower screens. */
  .qia-cam-toolbar { flex-wrap: wrap; row-gap: 8px; }
  .qia-cam-count { margin-left: auto; }
  .qia-cam-footer { flex-wrap: wrap; row-gap: 6px; }

  .qia-cam-tabbar { scrollbar-width: thin; }
  .qia-cam-tabbar::-webkit-scrollbar { height: 4px; }

  @media (max-width: 640px) {
    .qia-cam-grid:not(.qia-cam-grid--single) { grid-template-columns: 1fr !important; }
    .qia-cam-count { margin-left: 0; width: 100%; }
  }
`;
