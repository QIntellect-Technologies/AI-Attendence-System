import { fetchJson } from "./apiClient";
import type { OrgConfig } from "../contexts/OrgConfigContext";

export interface ClientBootstrapOrganization {
  id: string | number;
  name?: string;
  slug?: string;
  status?: string;
  business_type?: string;
  biz_type?: string;
  primary_people_type?: string;
  enabled_people_types?: string[];
  attendance_people_types?: string[];
  vertical_config?: Record<string, unknown>;
  attendance_mode?: string;
  max_branches?: number;
}

export interface ClientBootstrapResponse {
  success: boolean;
  message?: string;
  organization: ClientBootstrapOrganization;
  branches?: unknown[];
  modules?: unknown[];
  active_modules?: string[];
  activeModules?: string[];
  latest_invoice?: unknown;
  latestInvoice?: unknown;
  access_status?: string;
  accessStatus?: string;
  onboarding_config?: unknown;
  onboardingConfig?: unknown;
  onboarding_completed?: boolean;
  onboardingCompleted?: boolean;
  requires_onboarding?: boolean;
  requiresOnboarding?: boolean;
  dashboard_ready?: boolean;
  dashboardReady?: boolean;
  permissions?: Record<string, boolean>;
  config: Partial<OrgConfig> & Record<string, unknown>;
}

export function getClientBootstrap(organizationId: string | number): Promise<ClientBootstrapResponse> {
  return fetchJson<ClientBootstrapResponse>("/api/client/bootstrap", {
    organization_id: organizationId,
  });
}
