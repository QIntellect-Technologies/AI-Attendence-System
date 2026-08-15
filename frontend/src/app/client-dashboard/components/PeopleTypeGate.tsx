import React from "react";
import { useOrg, type PeopleType } from "../contexts/OrgConfigContext";
import { getPeopleTypePluralLabel } from "../config/peopleLabels";
import { resolveActivePeopleTypes } from "../utils/templateRendering";

export const PeopleTypeGate: React.FC<{
  peopleType: PeopleType;
  feature?: "attendance" | "directory" | string;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}> = ({ peopleType, feature = "directory", children, fallback = null }) => {
  const { cfg, isOrgReady } = useOrg();
  if (!isOrgReady) return null;
  const active = resolveActivePeopleTypes(cfg as any);
  const enabled = feature === "attendance" ? active : active;
  if (enabled.includes(String(peopleType).toLowerCase()))
    return <>{children}</>;
  return <>{fallback}</>;
};

export const PeopleTypeDisabledMessage: React.FC<{
  peopleType: PeopleType;
  feature?: string;
}> = ({ peopleType, feature = "feature" }) => {
  const { cfg } = useOrg();
  return (
    <div
      style={{
        padding: 16,
        border: "1px solid #e2e8f0",
        borderRadius: 12,
        background: "#fff",
        color: "#64748b",
      }}
    >
      {getPeopleTypePluralLabel(peopleType, cfg)} are not enabled for this{" "}
      {feature} in Support Dashboard.
    </div>
  );
};

export default PeopleTypeGate;
