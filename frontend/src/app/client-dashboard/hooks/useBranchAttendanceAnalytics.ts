/**
 * useBranchAttendanceAnalytics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * One scoped, date-ranged fetch (last 6 months + today) and the active staff
 * roster for the dashboard cards. Replaces the unscoped `getAttendanceLogs(500)`
 * ("most recent 500 rows") that missed back-dated manual entries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOrg } from "../contexts/OrgConfigContext";
import { resolveTenantScope } from "../utils/tenantScope";
import {
    getAttendanceLogs,
    getAttendanceToday,
} from "../pages/attendance_temp/api/attendanceApi";
import { listStaffRecords } from "../pages/StaffManagement/api/staffApi";
import {
    buildMonthlyPerformance,
    buildPresence,
    isActiveStaff,
    recordDayKey,
    toDateKey,
} from "../utils/attendanceAnalytics";

const MONTHS_BACK = 5; // current month + 5 previous = 6 bars
const LOG_LIMIT = 5000;

export function useBranchAttendanceAnalytics(args: {
    branchId?: number | string | null;
    peopleType?: string | null;
    enabled?: boolean;
    /**
     * Optional short look-back window in days (including today). When set, only
     * that many recent days are fetched instead of the default 6 months. Use it
     * for cards that only need recent days (e.g. the weekly / 14-day bars) —
     * `monthlyPerformance` is only meaningful with the default window.
     */
    lookbackDays?: number;
}) {
    const { branchId, peopleType, enabled = true, lookbackDays } = args;
    const { cfg, organizationId } = useOrg();

    const scope = useMemo(
        () =>
            organizationId
                ? resolveTenantScope({ organizationId, branchId: branchId ?? undefined }, cfg.branches)
                : null,
        [cfg.branches, organizationId, branchId],
    );

    const [records, setRecords] = useState<any[] | null>(null);
    const [staff, setStaff] = useState<any[] | null>(null);
    const reqId = useRef(0);

    const load = useCallback(async () => {
        if (!enabled || !scope?.organizationId) return;
        const id = ++reqId.current;
        const now = new Date();
        const start =
            lookbackDays && lookbackDays > 0
                ? toDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (lookbackDays - 1)))
                : toDateKey(new Date(now.getFullYear(), now.getMonth() - MONTHS_BACK, 1));
        const end = toDateKey(now);
        const q = {
            organizationId: scope.organizationId,
            branchId: scope.apiBranchId ?? undefined,
            peopleType: peopleType ?? undefined,
        };
        try {
            const [today, logs, roster] = await Promise.all([
                getAttendanceToday({ ...q, limit: 2000 }).catch(() => []),
                getAttendanceLogs({ ...q, start, end, limit: LOG_LIMIT }),
                listStaffRecords({
                    organizationId: scope.organizationId,
                    branchId: scope.apiBranchId ?? undefined,
                    peopleType: peopleType ?? undefined,
                }),
            ]);
            if (id !== reqId.current) return;
            const seen = new Set<string>();
            const merged = [...logs, ...today].filter((r) => {
                const k = `${r.id}|${recordDayKey(r)}`;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
            setRecords(merged);
            setStaff((roster as any[]).filter(isActiveStaff));
        } catch (err) {
            // Leave state null so the cards fall back to the backend snapshot.
            console.error("Failed to load dashboard attendance analytics", err);
        }
    }, [enabled, scope, peopleType, lookbackDays]);

    useEffect(() => {
        void load();
        const onChange = () => void load();
        window.addEventListener("orgDataChanged", onChange);
        return () => window.removeEventListener("orgDataChanged", onChange);
    }, [load]);

    const ready = records !== null && staff !== null;
    const todayKey = toDateKey(new Date());

    const todayRecords = useMemo(
        () => (records ?? []).filter((r) => recordDayKey(r) === todayKey),
        [records, todayKey],
    );

    const monthlyPerformance = useMemo(
        () => (ready ? buildMonthlyPerformance(buildPresence(records!), staff!) : undefined),
        [ready, records, staff],
    );

    return {
        ready,
        records: ready ? records! : undefined,
        staff: ready ? staff! : undefined,
        todayRecords: ready ? todayRecords : undefined,
        monthlyPerformance,
        refresh: load,
    };
}

export default useBranchAttendanceAnalytics;