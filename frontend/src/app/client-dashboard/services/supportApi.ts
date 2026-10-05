import { fetchJson } from "../api/apiClient";

export type SupportVerticalTemplateOption = {
  business_type: string;
  label: string;
  primary_people_type: string;
};

export async function getSupportVerticalTemplates(): Promise<{
  success: boolean;
  templates: SupportVerticalTemplateOption[];
}> {
  return fetchJson("/api/support/vertical-templates");
}

export async function updateOrganizationTemplate(
  orgId: string | number,
  businessType: string
): Promise<{
  success: boolean;
  organization_id: string | number;
  business_type: string;
  vertical_config: unknown;
}> {
  return fetchJson(`/api/support/organizations/${orgId}/template`, {
    method: "PUT",
    body: JSON.stringify({
      business_type: businessType,
    }),
  });
}