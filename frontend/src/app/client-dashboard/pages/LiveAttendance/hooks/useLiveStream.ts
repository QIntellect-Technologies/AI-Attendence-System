/**
 * useLiveStream.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Production backend-first live attendance logic.
 *
 * Source of truth:
 *   /api/cameras
 *   /api/stats
 *   /api/live-detections
 *
 * Responsibilities:
 * - Apply organization + branch scope.
 * - Load backend cameras.
 * - Start/stop monitoring.
 * - Poll live detections and scoped attendance stats.
 * - Keep UI components pure and fetch-free.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import {
  fetchLiveCameras,
  fetchLiveDetections,
  fetchLiveStats,
  type LiveCamera,
  type LiveDetection,
  type LiveStats,
} from "../api/liveStreamApi";
import {
  resolveActivePeopleTypes,
  peopleLabelForType,
} from "../../../utils/templateRendering";

export type LayoutMode = 1 | 2 | 4 | "all";

export interface UseLiveStreamReturn {
  isGlobalScope: boolean;
  allCameras: LiveCamera[];
  streamableCameras: LiveCamera[];
  visibleCameras: LiveCamera[];
  noCameras: boolean;
  noStreamable: boolean;

  layout: LayoutMode;
  setLayout: (mode: LayoutMode) => void;

  streaming: boolean;
  startMonitoring: () => void;
  stopMonitoring: () => void;

  stats: LiveStats;
  detections: LiveDetection[];
  refreshCameras: () => Promise<void>;
  refreshDetections: () => Promise<void>;
  refreshStats: () => Promise<void>;

  liveCount: number;
  faceCount: number;
  matchCount: number;
  todayCount: number;

  loading: boolean;
  error: string | null;

  // Template awareness additions
  activePeopleTypes: string[];
  personLabel: { singular: string; plural: string };
  scopeLabel: string;
  isNodeOffline: boolean;
  hasOfflineDetections: boolean;

  // People-type filter (dropdown). null/"all" means every active type.
  // Cameras are hardware and are never scoped by this — only stats and
  // detections are.
  peopleTypeFilter: string | null;
  setPeopleTypeFilter: (type: string | null) => void;
}

const EMPTY_STATS: LiveStats = {
  enrolledCount: 0,
  presentCount: 0,
  totalLogs: 0,
};

function isStreamable(camera: LiveCamera): boolean {
  return Boolean(camera.streamUrl || camera.streamPath || camera.id);
}

export function useLiveStream(): UseLiveStreamReturn {
  const { activeBranchId, organizationId, isOrgReady, cfg } = useOrg();

  // Template awareness: resolve enabled people types
  const activePeopleTypes = useMemo(() => resolveActivePeopleTypes(cfg), [cfg]);
  const primaryPeopleType = activePeopleTypes[0] || "staff";

  const [peopleTypeFilter, setPeopleTypeFilterState] = useState<string | null>(
    null,
  );

  // personLabel drives the page title, the sidebar heading, and the "Total
  // X" stat label — it must track whatever the person-type dropdown is
  // currently set to, not just the org's first configured type. Previously
  // this was computed once from primaryPeopleType alone, so selecting
  // "Staff" in the dropdown left every one of those labels reading
  // "Students" (or whichever type happened to be first) no matter what was
  // selected. When the filter is "All" and the org has more than one active
  // type, combine both labels (e.g. "Students & Staff") rather than
  // silently picking one — showing only one type's name while the data
  // underneath covers both would be its own version of the same bug.
  const personLabel = useMemo(() => {
    if (peopleTypeFilter) {
      return peopleLabelForType(peopleTypeFilter, cfg);
    }
    if (activePeopleTypes.length > 1) {
      const labels = activePeopleTypes.map((type) =>
        peopleLabelForType(type, cfg),
      );
      return {
        singular: labels.map((l) => l.singular).join(" / "),
        plural: labels.map((l) => l.plural).join(" & "),
      };
    }
    return peopleLabelForType(primaryPeopleType, cfg);
  }, [peopleTypeFilter, activePeopleTypes, primaryPeopleType, cfg]);

  const [layout, setLayoutState] = useState<LayoutMode>(2);
  const [streaming, setStreaming] = useState(false);
  const [stats, setStats] = useState<LiveStats>(EMPTY_STATS);
  const [allCameras, setAllCameras] = useState<LiveCamera[]>([]);
  const [detections, setDetections] = useState<LiveDetection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isNodeOffline, setIsNodeOffline] = useState(false);

  // If a support-side toggle removes the currently-selected type from scope
  // (e.g. org switched from "staff" to "student" while "staff" was selected
  // here), fall back to "all" rather than silently filtering everything out.
  useEffect(() => {
    if (peopleTypeFilter && !activePeopleTypes.includes(peopleTypeFilter)) {
      setPeopleTypeFilterState(null);
    }
  }, [activePeopleTypes, peopleTypeFilter]);

  const setPeopleTypeFilter = useCallback((type: string | null) => {
    setPeopleTypeFilterState(type && type !== "all" ? type : null);
  }, []);

  const camerasAbortRef = useRef<AbortController | null>(null);
  const detectionsAbortRef = useRef<AbortController | null>(null);
  const statsAbortRef = useRef<AbortController | null>(null);

  const isGlobalScope = activeBranchId === null;

  // Scope label for branch-aware messages
  const scopeLabel = useMemo(() => {
    if (isGlobalScope) return "All Branches";

    const branch = (cfg?.branches || []).find((item: any) => {
      return String(item.id) === String(activeBranchId);
    });

    return branch?.name || `Branch ${activeBranchId}`;
  }, [isGlobalScope, activeBranchId, cfg?.branches]);

  const backendBranchId = useMemo(() => {
    if (activeBranchId === null) return undefined;

    const branch = cfg.branches.find(
      (item) => String(item.id) === String(activeBranchId),
    ) as
      | ((typeof cfg.branches)[number] & {
          backendBranchId?: string | null;
          backend_branch_id?: string | null;
        })
      | undefined;

    return (
      branch?.backendBranchId ||
      branch?.backend_branch_id ||
      (activeBranchId !== null ? String(activeBranchId) : undefined)
    );
  }, [activeBranchId, cfg.branches]);

  // Cameras are physical hardware, not people — this scope intentionally
  // excludes peopleType so /api/cameras is never asked to filter by it.
  const scope = useMemo(
    () => ({
      organizationId,
      branchId: backendBranchId,
    }),
    [backendBranchId, organizationId],
  );

  // Stats and detections are people-scoped; this is the one that carries
  // the dropdown's current selection through to the backend.
  const filterScope = useMemo(
    () => ({
      ...scope,
      peopleType: peopleTypeFilter ?? undefined,
    }),
    [scope, peopleTypeFilter],
  );

  const streamableCameras = useMemo(
    () => allCameras.filter(isStreamable),
    [allCameras],
  );

  const visibleCameras = useMemo(
    () =>
      layout === "all" ? streamableCameras : streamableCameras.slice(0, layout),
    [layout, streamableCameras],
  );

  const noCameras = allCameras.length === 0;
  const noStreamable = allCameras.length > 0 && streamableCameras.length === 0;

  // Check if any detections are from fallback (offline node)
  const hasOfflineDetections = useMemo(
    () => detections.some((det) => det.source?.includes("fallback")),
    [detections],
  );

  const setLayout = useCallback((mode: LayoutMode) => {
    setLayoutState(mode);
  }, []);

  const refreshCameras = useCallback(async () => {
    camerasAbortRef.current?.abort();

    if (!isOrgReady || !organizationId) {
      setAllCameras([]);
      return;
    }

    const controller = new AbortController();
    camerasAbortRef.current = controller;

    try {
      setLoading(true);
      const cameras = await fetchLiveCameras(scope, controller.signal);
      setAllCameras(cameras);
      setError(null);
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;

      // A failed fetch for the current scope must never leave the previous
      // scope's cameras on screen — e.g. switching to a branch with zero
      // cameras must not keep showing another branch's feed just because
      // this request errored instead of returning an empty list.
      setAllCameras([]);
      setError(
        err instanceof Error ? err.message : "Failed to load backend cameras.",
      );
    } finally {
      setLoading(false);
    }
  }, [isOrgReady, organizationId, scope]);

  const refreshStats = useCallback(async () => {
    statsAbortRef.current?.abort();

    if (!isOrgReady || !organizationId) {
      setStats(EMPTY_STATS);
      return;
    }

    const controller = new AbortController();
    statsAbortRef.current = controller;

    try {
      setLoading(true);
      const nextStats = await fetchLiveStats(filterScope, controller.signal);
      setStats(nextStats);
      setError(null);
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;

      setError(
        err instanceof Error ? err.message : "Failed to load attendance stats.",
      );
    } finally {
      setLoading(false);
    }
  }, [isOrgReady, organizationId, filterScope]);

  const refreshDetections = useCallback(async () => {
    detectionsAbortRef.current?.abort();

    if (!isOrgReady || !organizationId) {
      setDetections([]);
      return;
    }

    const controller = new AbortController();
    detectionsAbortRef.current = controller;

    try {
      const nextDetections = await fetchLiveDetections(
        {
          ...filterScope,
          cameraIds: streamableCameras.map((camera) => camera.id),
        },
        controller.signal,
      );

      setDetections(nextDetections);
      setError(null);
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;

      setError(
        err instanceof Error ? err.message : "Failed to load live detections.",
      );
    }
  }, [isOrgReady, organizationId, filterScope, streamableCameras]);

  const startMonitoring = useCallback(() => {
    if (noCameras || noStreamable) return;

    setStreaming(true);
    void refreshStats();
    void refreshDetections();
  }, [noCameras, noStreamable, refreshDetections, refreshStats]);

  const stopMonitoring = useCallback(() => {
    setStreaming(false);
    detectionsAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    void refreshCameras();
    void refreshStats();

    const id = window.setInterval(() => {
      void refreshCameras();
      void refreshStats();
    }, 30_000);

    return () => window.clearInterval(id);
  }, [refreshCameras, refreshStats]);

  useEffect(() => {
    if (!streaming) return undefined;

    const id = window.setInterval(() => {
      void refreshDetections();
    }, 1_500);

    return () => window.clearInterval(id);
  }, [refreshDetections, streaming]);

  useEffect(() => {
    if (streamableCameras.length === 0) {
      setStreaming(false);
      setLayoutState(1);
      return;
    }

    setLayoutState((current) => {
      if (streamableCameras.length === 1) return 1;
      if (streamableCameras.length === 2 && current === 4) return 2;
      return current;
    });
  }, [streamableCameras.length]);

  useEffect(() => {
    return () => {
      camerasAbortRef.current?.abort();
      detectionsAbortRef.current?.abort();
      statsAbortRef.current?.abort();
    };
  }, []);

  const liveCount = detections.length;
  const matchCount = detections.filter(
    (item) => item.name !== "Unknown",
  ).length;
  const todayCount = stats.presentCount ?? 0;
  const faceCount = liveCount;

  return {
    isGlobalScope,
    allCameras,
    streamableCameras,
    visibleCameras,
    noCameras,
    noStreamable,

    layout,
    setLayout,

    streaming,
    startMonitoring,
    stopMonitoring,

    stats,
    detections,
    refreshCameras,
    refreshDetections,
    refreshStats,

    liveCount,
    faceCount,
    matchCount,
    todayCount,

    loading,
    error,

    // Template awareness and offline detection additions
    activePeopleTypes,
    personLabel,
    scopeLabel,
    isNodeOffline,
    hasOfflineDetections,

    peopleTypeFilter,
    setPeopleTypeFilter,
  };
}