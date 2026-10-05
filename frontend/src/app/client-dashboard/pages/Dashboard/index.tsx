/**
 * Dashboard.tsx — Super Admin dashboard, global scope.
 * ─────────────────────────────────────────────────────────────────────────────
 * /admin index route. Header chrome (org name, branches/modules/roles, badges)
 * lives inside DashboardOverviewTab itself; the shared top tab bar
 * (DashboardTabBar) is rendered once by AdminLayout for the whole /admin tree.
 *
 * This component intentionally imports only global-scope content.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React from "react";
import DashboardOverviewTab from "./DashboardOverviewTab";

const Dashboard: React.FC = () => <DashboardOverviewTab />;

export default Dashboard;
