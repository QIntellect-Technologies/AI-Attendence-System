import { useMemo } from "react";
import { useOrg } from "../../../contexts/OrgConfigContext";
import { isModuleEnabled } from "../../../utils/moduleAccess";

export type PayrollGatedModule = "leave" | "overtime";

export interface PayrollModuleGates {
    leave: boolean;
    overtime: boolean;
    /** Items with no `requires` are always visible. */
    isVisible: (requires?: PayrollGatedModule) => boolean;
    filterByGate: <T extends { requires?: PayrollGatedModule }>(
        items: readonly T[],
    ) => T[];
}

export function usePayrollModuleGates(): PayrollModuleGates {
    const { cfg } = useOrg();

    return useMemo(() => {
        const enabled: Record<PayrollGatedModule, boolean> = {
            leave: isModuleEnabled(cfg.modules, "leave"),
            overtime: isModuleEnabled(cfg.modules, "overtime"),
        };
        const isVisible = (requires?: PayrollGatedModule) =>
            !requires || enabled[requires];

        return {
            ...enabled,
            isVisible,
            filterByGate: <T extends { requires?: PayrollGatedModule }>(
                items: readonly T[],
            ) => items.filter((item) => isVisible(item.requires)),
        };
    }, [cfg.modules]);
}