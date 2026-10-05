/**
 * hooks/useManagerTeamView.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Resolves whether the current dashboard session should show a
 * My Team / Whole Branch toggle, and holds the local selection.
 *
 * Eligibility rules (see client_dashboard_auth.py's get_effective_scope_ids
 * for the matching backend contract):
 *   - user.dashboard_scope === 'team'  -> this account is PERMANENTLY
 *     restricted to their team server-side, unconditionally. There is no
 *     legitimate "Whole Branch" state to offer — showing a toggle here
 *     would be UI fiction the backend ignores. `locked: true`,
 *     `teamView: 'team'`, no options rendered.
 *   - user.dashboard_scope === 'branch' AND this account has ≥1 direct
 *     report -> real toggle: default 'branch' (today's unrestricted view,
 *     unchanged), user may opt into 'team' as a personal convenience
 *     filter.
 *   - anything else (admin/org-wide client_users, or a client_staff
 *     account with zero direct reports) -> not a manager portal session at
 *     all; hook returns `eligible: false`, callers should not render the
 *     toggle or pass teamView to useDashboardOverviewData.
 */

import { useEffect, useState } from "react";
import { useAuth } from "../contexts/useAuth";
import { getStaffDirectReports } from "../../client-dashboard/pages/StaffManagement/api/staffApi";

export interface UseManagerTeamViewResult {
  eligible: boolean;
  locked: boolean;
  teamView: "team" | "branch";
  setTeamView: (value: "team" | "branch") => void;
  loading: boolean;
}

export function useManagerTeamView(): UseManagerTeamViewResult {
  const { user } = useAuth();
  const dashboardScope = user?.dashboard_scope;

  const [hasDirectReports, setHasDirectReports] = useState<boolean | null>(
    null,
  );
  const [teamView, setTeamView] = useState<"team" | "branch">("branch");

  const shouldCheckReports =
    dashboardScope === "branch" && Boolean(user?.id) && Boolean(user?.organization_id);

  useEffect(() => {
    let cancelled = false;

    if (!shouldCheckReports) {
      setHasDirectReports(null);
      return;
    }

    getStaffDirectReports(user!.id!, user!.organization_id!)
      .then((res) => {
        if (!cancelled) {
          setHasDirectReports((res.reports || []).length > 0);
        }
      })
      .catch(() => {
        if (!cancelled) setHasDirectReports(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shouldCheckReports, user?.id, user?.organization_id]);

  if (dashboardScope === "team") {
    return {
      eligible: true,
      locked: true,
      teamView: "team",
      setTeamView: () => {},
      loading: false,
    };
  }

  if (dashboardScope === "branch") {
    const loading = hasDirectReports === null;
    const eligible = hasDirectReports === true;
    return {
      eligible,
      locked: false,
      teamView: eligible ? teamView : "branch",
      setTeamView,
      loading,
    };
  }

  return {
    eligible: false,
    locked: false,
    teamView: "branch",
    setTeamView: () => {},
    loading: false,
  };
}

export default useManagerTeamView;