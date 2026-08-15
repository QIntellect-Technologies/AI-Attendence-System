/**
 * BranchDashboard.tsx — Branch Admin / HR dashboard, branch scope.
 * ─────────────────────────────────────────────────────────────────────────────
 * /admin/branch/:branchId — layout wrapper for the entire branch-scoped
 * subtree. Renders DashboardHeader once above the matched child route.
 *
 * Tenant-safety notes:
 *   • Branch ids are treated as opaque ids, not forced to Number(). Supabase
 *     UUID/string ids and legacy numeric ids both work.
 *   • The route is considered valid only when the id exists in the active org
 *     config. Stale or cross-tenant ids are redirected away.
 */

import React from "react";
import { Navigate, Outlet, useParams } from "react-router-dom";
import { useOrg } from "../../contexts/OrgConfigContext";
import DashboardHeader from "../../components/ui/DashboardHeader";
import BranchOverviewTab from "./BranchOverviewTab";

type BranchRouteParams = {
  branchId?: string;
};

const sameId = (a: unknown, b: unknown): boolean => String(a) === String(b);

const BranchDashboard: React.FC = () => {
  const { cfg } = useOrg();
  const { branchId: branchIdParam } = useParams<BranchRouteParams>();

  const branchId = String(branchIdParam ?? "").trim();
  const branchExists =
    Boolean(branchId) &&
    cfg.branches.some((branch) => sameId(branch.id, branchId));

  if (!branchExists) {
    return <Navigate to="/admin/branches" replace />;
  }

  return (
    <>
      <DashboardHeader />
      <Outlet />
    </>
  );
};

export const BranchOverviewPage: React.FC = () => {
  const { branchId: branchIdParam } = useParams<BranchRouteParams>();
  const branchId = String(branchIdParam ?? "").trim();

  if (!branchId) {
    return <Navigate to="/admin/branches" replace />;
  }

  return <BranchOverviewTab branchId={branchId} />;
};

export default BranchDashboard;
