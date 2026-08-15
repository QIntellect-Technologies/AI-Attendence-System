import { fetchJson } from "../api/apiClient";
import { VerticalConfig } from "../config/verticalTemplates";

export type TenantConfigResponse = {
  success: boolean;
  message?: string;
  organization: {
    id: string | number;
    name: string;
    business_type: string;
    primary_people_type: string;
    enabled_people_types: string[];
    vertical_config: VerticalConfig;
    attendance_mode?: string;
    max_branches?: number;
    status?: string;
  };
  permissions: {
    can_change_business_type: boolean;
    can_change_attendance_mode: boolean;
    can_change_modules: boolean;
    can_add_branch_beyond_limit: boolean;
  };
};

export async function getTenantConfig(orgId?: string | number): Promise<TenantConfigResponse> {
  const query = orgId ? `?org_id=${encodeURIComponent(String(orgId))}` : "";
  return fetchJson<TenantConfigResponse>(`/api/tenant/config${query}`);
}