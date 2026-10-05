import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { resolveTenantScope } from "../../../utils/tenantScope";
import {
  fetchLiveCCTVTracking,
  LiveCctvError,
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
  /** True once polling has given up after MAX_FAILURES consecutive errors. */
  stopped: boolean;
  scope: ScopeParams;
  scopeLabel: string;
  isGlobalScope: boolean;
  refresh: () => Promise<void>;
  reload: () => Promise<void>;
  /** Clears the failure count and restarts polling from the base interval. */
  retry: () => void;
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

/**
 * Consecutive failures before polling stops entirely and hands control to
 * the user's Retry button. Five attempts across the backoff schedule below
 * spans roughly a minute — long enough to ride out a backend restart or a
 * slow Supabase window, short enough that a genuinely broken scope (bad
 * branch_id, revoked session) stops hammering the endpoint quickly.
 */
const MAX_FAILURES = 5;

/** Never back off further than this, so recovery is still detected. */
const MAX_BACKOFF_MS = 60_000;

function asSourceStatus(
  value: LiveSourceStatus,
  hasError: boolean,
): LiveSourceStatus {
  return hasError ? "error" : value;
}

/**
 * Delay before the next poll. Zero failures polls at the caller's interval;
 * each consecutive failure doubles it (4s, 8s, 16s, 32s at the 2s default)
 * so a failing endpoint is not hit 30x/minute indefinitely.
 */
function nextDelayMs(baseMs: number, failures: number): number {
  if (failures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** failures, MAX_BACKOFF_MS);
}

/**
 * User-facing text for a failed poll. Never surfaces response bodies,
 * status codes, or exception strings — those go to console.error for
 * debugging. LiveCctvError carries a `friendly` string built from the HTTP
 * status in liveStreamApi.ts; anything else (a TypeError from fetch, i.e.
 * the network is down) falls back to the connection message.
 */
function messageFor(err: unknown): string {
  if (err instanceof LiveCctvError) return err.friendly;
  return "Camera feed unavailable. Check your connection.";
}

/**
 * Auth and scope failures never fix themselves on a retry, so they consume
 * the whole failure budget at once instead of burning through the backoff
 * schedule first.
 */
function isTerminal(err: unknown): boolean {
  if (!(err instanceof LiveCctvError)) return false;
  return err.status === 401 || err.status === 403 || err.status === 404;
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
  const [stopped, setStopped] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<number | null>(null);
  /**
   * Guards against overlapping polls. The backend fans out five parallel
   * Supabase queries per request and can exceed the 2s interval under load;
   * without this, every tick aborted the in-flight request and started a new
   * one, so the page could never complete a single fetch while continuously
   * re-hitting a struggling endpoint.
   */
  const inFlightRef = useRef(false);
  const failuresRef = useRef(0);

  /** Bumped by retry() to force the scheduler effect to restart. */
  const [restartNonce, setRestartNonce] = useState(0);

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

  const load = useCallback(
    async (manual = false) => {
      // A scheduled tick yields to a poll that is still running; a manual
      // refresh takes precedence and cancels it.
      if (inFlightRef.current && !manual) return;

      abortRef.current?.abort();

      if (!enabled || !isOrgReady || !scope.organizationId) {
        setData({ ...EMPTY_MODEL, sourceStatus: "ready" });
        setLoading(false);
        setRefreshing(false);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      inFlightRef.current = true;
      setRefreshing(true);

      try {
        const next = await fetchLiveCCTVTracking(scope, controller.signal);

        failuresRef.current = 0;
        setStopped(false);
        // Cleared only on success. Clearing at the top of every attempt made
        // the banner flicker off and on at the poll interval.
        setError(null);
        setData({
          ...next,
          sourceStatus: asSourceStatus(next.sourceStatus ?? "ready", false),
          sourceLabel: next.sourceLabel || "Backend source",
        });
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;

        failuresRef.current = isTerminal(err)
          ? MAX_FAILURES
          : failuresRef.current + 1;

        // Full detail stays in the console; the UI gets messageFor() only.
        console.error("Live CCTV fetch failed", err);

        setError(messageFor(err));
        setData((current) => ({
          ...current,
          sourceStatus: "error",
          sourceLabel: "Backend source",
        }));

        if (failuresRef.current >= MAX_FAILURES) setStopped(true);
      } finally {
        inFlightRef.current = false;
        if (!controller.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [enabled, isOrgReady, scope],
  );

  const refresh = useCallback(() => load(true), [load]);

  const retry = useCallback(() => {
    failuresRef.current = 0;
    setStopped(false);
    setError(null);
    setRestartNonce((n) => n + 1);
  }, []);

  /**
   * Self-scheduling poll loop. Replaces setInterval so the delay can grow
   * with the failure count and so the chain can simply stop scheduling once
   * the budget is spent — an interval has no way to express either.
   */
  useEffect(() => {
    if (!enabled || !isOrgReady || !scope.organizationId || stopped) {
      return undefined;
    }

    let cancelled = false;

    const tick = async () => {
      await load();
      if (cancelled) return;
      if (failuresRef.current >= MAX_FAILURES) return; // give up; retry() restarts

      const base = Math.max(1_500, pollingMs);
      timerRef.current = window.setTimeout(
        tick,
        nextDelayMs(base, failuresRef.current),
      );
    };

    timerRef.current = window.setTimeout(tick, 0);

    return () => {
      cancelled = true;
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      abortRef.current?.abort();
    };
  }, [
    enabled,
    isOrgReady,
    load,
    pollingMs,
    scope.organizationId,
    stopped,
    restartNonce,
  ]);

  /**
   * A backgrounded tab does not need live camera data. Pausing on hide keeps
   * an unattended dashboard from polling all night; showing again resets the
   * failure count so a tab that failed while hidden reconnects immediately.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        failuresRef.current = 0;
        setStopped(false);
        setRestartNonce((n) => n + 1);
      } else if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return {
    data,
    loading,
    refreshing,
    error,
    stopped,
    scope,
    scopeLabel,
    isGlobalScope,
    refresh,
    reload: refresh,
    retry,
  };
}
