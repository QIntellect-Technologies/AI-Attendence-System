import { useTenantConfig } from "../contexts/TenantConfigContext";
import {
  getPeopleLabel,
  getPeoplePluralLabel,
  getPrimaryPeopleType,
  getPrimaryStructure,
  getUnitLabel,
  getUnitPluralLabel,
} from "../config/verticalTemplates";

export function useVerticalLabels() {
  const { tenantConfig } = useTenantConfig();

  const verticalConfig = tenantConfig?.organization.vertical_config;
  const primaryPeopleType = getPrimaryPeopleType(verticalConfig);
  const primaryStructure = getPrimaryStructure(verticalConfig);

  return {
    businessType: tenantConfig?.organization.business_type || "company",
    primaryPeopleType,
    primaryPeopleLabel: getPeopleLabel(verticalConfig, primaryPeopleType),
    primaryPeoplePluralLabel: getPeoplePluralLabel(
      verticalConfig,
      primaryPeopleType,
    ),

    unit1Type: primaryStructure.unit_1 || "department",
    unit2Type: primaryStructure.unit_2 || "designation",

    unit1Label: getUnitLabel(verticalConfig, primaryStructure.unit_1),
    unit1PluralLabel: getUnitPluralLabel(
      verticalConfig,
      primaryStructure.unit_1,
    ),

    unit2Label: getUnitLabel(verticalConfig, primaryStructure.unit_2),
    unit2PluralLabel: getUnitPluralLabel(
      verticalConfig,
      primaryStructure.unit_2,
    ),

    verticalConfig,
  };
}
