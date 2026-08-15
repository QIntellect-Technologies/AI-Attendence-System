import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";
import {
  fetchLiveCCTVTracking,
  type LiveCCTVViewModel,
  type LiveSourceStatus,
  type ScopeParams,
} from "../../LiveAttendance/api/liveStreamApi";

export interface UseLiveCctvTrackingOptions {
  routeBranchId?: string | number | null;
  pollingMs?: number;
  enabled?: boolean;
  /**
   * Optional single people-type filter (e.g. "student"). null/undefined
   * means "all currently active types" — the backend then defaults to
   * attendance_people_types on its own. See app.py's
   * /api/cctv/live-tracking for the server-side scoping rule.
   */
  peopleType?: string | null;
}

export interface UseLiveCctvTrackingResult {
  data: LiveCCTVViewModel;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  scope: ScopeParams;
  scopeLabel: string;
  isGlobalScope: boolean;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
}

const EMPTY_MODEL: LiveCCTVViewModel = {
  employees: [],
  cameras: [],
  registeredCount: 0,
  activeFeedCount: 0,
  activeNowCount: 0,
  sourceStatus: "loading",
  sourceLabel: "Backend source",
};

function asSourceStatus(
  value: LiveSourceStatus,
  hasError: boolean,
): LiveSourceStatus {
  return hasError ? "error" : value;
}

export function useLiveCctvTracking({
  routeBranchId,
  pollingMs = 2_000,
  enabled = true,
  peopleType = null,
}: UseLiveCctvTrackingOptions = {}): UseLiveCctvTrackingResult {
  const { activeBranchId, organizationId, cfg, isOrgReady } = useOrg();
  const [data, setData] = useState<LiveCCTVViewModel>(EMPTY_MODEL);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const requestedBranch = routeBranchId ?? activeBranchId ?? null;

  const scope = useMemo<ScopeParams>(() => {
    const resolved = resolveTenantScope(
      {
        organizationId,
        branchId: requestedBranch,
      },
      cfg.branches,
    );

    return {
      organizationId: resolved.organizationId,
      branchId: resolved.apiBranchId,
      peopleType: peopleType || undefined,
    };
  }, [cfg.branches, organizationId, requestedBranch, peopleType]);

  const isGlobalScope = scope.branchId === undefined || scope.branchId === null;

  const scopeLabel = useMemo(() => {
    if (isGlobalScope) return "All Branches";

    const branch = cfg.branches.find((item) => {
      const candidate = item as typeof item & {
        backendBranchId?: string | null;
        backend_branch_id?: string | null;
      };

      return (
        String(
          candidate.backendBranchId ?? candidate.backend_branch_id ?? item.id,
        ) === String(scope.branchId) ||
        String(item.id) === String(requestedBranch)
      );
    });

    return (
      branch?.name ?? `Branch ${String(requestedBranch ?? scope.branchId)}`
    );
  }, [cfg.branches, isGlobalScope, requestedBranch, scope.branchId]);

  const load = useCallback(async () => {
    abortRef.current?.abort();

    if (!enabled || !isOrgReady || !scope.organizationId) {
      setData({ ...EMPTY_MODEL, sourceStatus: "ready" });
      setLoading(false);
      setRefreshing(false);
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRefreshing(true);
    setError(null);

    try {
      const next = await fetchLiveCCTVTracking(scope, controller.signal);
      setData({
        ...next,
        sourceStatus: asSourceStatus(next.sourceStatus ?? "ready", false),
        sourceLabel: next.sourceLabel || "Backend source",
      });
    } catch (err) {
      if ((err as DOMException).name === "AbortError") return;
      const message =
        err instanceof Error
          ? err.message
          : "Failed to load live CCTV tracking.";
      setError(message);
      setData((current) => ({
        ...current,
        sourceStatus: "error",
        sourceLabel: "Backend source",
      }));
    } finally {
      if (controller.signal.aborted) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [enabled, isOrgReady, scope]);

  useEffect(() => {
    void load();
    return () => abortRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!enabled || !isOrgReady || !scope.organizationId) return undefined;

    const interval = window.setInterval(
      () => {
        void load();
      },
      Math.max(1_500, pollingMs),
    );

    return () => window.clearInterval(interval);
  }, [enabled, isOrgReady, load, pollingMs, scope.organizationId]);

  return {
    data,
    loading,
    refreshing,
    error,
    scope,
    scopeLabel,
    isGlobalScope,
    refresh: load,
    reload: load,
  };
}