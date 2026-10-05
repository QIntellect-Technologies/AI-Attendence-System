/**
 * attendanceAnalytics.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure helpers that turn raw attendance rows + the staff roster into the
 * numbers the dashboard cards show (donut, weekly bars, monthly performance).
 *
 * Why this exists: the cards used to count only rows that exist. An absent
 * person usually has NO row, so absences were never counted, and the charts
 * only saw the most recent N rows, so back-dated manual entries were dropped.
 * Everything here is derived from (roster × days) so both are handled.
 */

export type DayState = "present" | "late" | "absent";

type Rec = Record<string, any>;

export const ABSENT_STATUSES = new Set(["absent"]);
/** Statuses that are neither attended nor absent (don't count against anyone). */
export const EXCUSED_STATUSES = new Set(["leave", "on_leave", "holiday"]);

export function toDateKey(d: Date): string {
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
}

export function recordDayKey(r: Rec): string {
    const raw = r.logDate ?? r.log_date ?? r.date ?? r.timestamp ?? r.checkIn ?? r.check_in ?? "";
    return String(raw).slice(0, 10);
}

export function recordStaffKey(r: Rec): string {
    const raw = r.staffId ?? r.staff_id ?? r.userId ?? r.user_id ?? "";
    return String(raw);
}

/** Every id a staff row may be referenced by in attendance rows. */
export function staffKeys(s: Rec): string[] {
    return [s.id, s.staffId, s.staff_id, s.userId, s.user_id]
        .filter((v) => v !== undefined && v !== null && v !== "")
        .map(String);
}

const INACTIVE = new Set(["inactive", "terminated", "resigned", "archived", "deleted", "suspended"]);
export function isActiveStaff(s: Rec): boolean {
    return !INACTIVE.has(String(s.status ?? "active").toLowerCase());
}

export function staffDepartment(s: Rec): string {
    return String(s.department_name || s.department || "").trim() || "Unassigned";
}

function isLateRecord(r: Rec): boolean {
    return [r.status, r.checkInStatus, r.check_in_status, r.dayStatus, r.day_status].some(
        (v) => String(v ?? "").toLowerCase() === "late",
    );
}

/** date → staffKey → state. Attended beats an explicit "absent" row. */
export function buildPresence(records: Rec[]): Map<string, Map<string, DayState>> {
    const out = new Map<string, Map<string, DayState>>();
    for (const r of records) {
        const day = recordDayKey(r);
        const key = recordStaffKey(r);
        if (!day || !key) continue;
        const status = String(r.status ?? "").toLowerCase();
        if (EXCUSED_STATUSES.has(status)) continue;

        let dayMap = out.get(day);
        if (!dayMap) out.set(day, (dayMap = new Map()));
        const prev = dayMap.get(key);

        if (ABSENT_STATUSES.has(status)) {
            if (!prev) dayMap.set(key, "absent");
            continue;
        }
        const state: DayState = isLateRecord(r) ? "late" : "present";
        // A later on-time row for the same person/day wins over "late"; either wins over "absent".
        if (!prev || prev === "absent" || (prev === "late" && state === "present")) {
            dayMap.set(key, state);
        }
    }
    return out;
}

/** State of one staff member on one day: present/late if a row says so, else absent. */
export function staffStateOnDay(
    staff: Rec,
    dayMap: Map<string, DayState> | undefined,
): DayState {
    if (!dayMap) return "absent";
    for (const k of staffKeys(staff)) {
        const s = dayMap.get(k);
        if (s === "present" || s === "late") return s;
    }
    return "absent";
}

/** Unique attended staff per date (restricted to the roster when one is given). */
export function dailyAttendedCounts(
    presence: Map<string, Map<string, DayState>>,
    staff: Rec[],
): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [day, dayMap] of presence) {
        if (staff.length) {
            out[day] = staff.filter((s) => staffStateOnDay(s, dayMap) !== "absent").length;
        } else {
            out[day] = [...dayMap.values()].filter((v) => v !== "absent").length;
        }
    }
    return out;
}

/**
 * Last `months` calendar months as stacked percentages (On Time / Late / Absent).
 * Expected = roster size × "working days", where a working day is any day (≤ today)
 * on which at least one attendance row exists, plus today.
 */
export function buildMonthlyPerformance(
    presence: Map<string, Map<string, DayState>>,
    staff: Rec[],
    today: Date = new Date(),
    months = 6,
): { month: string; "On Time": number; Late: number; Absent: number }[] {
    const todayKey = toDateKey(today);
    const rows = [];
    for (let i = months - 1; i >= 0; i--) {
        const first = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const prefix = toDateKey(first).slice(0, 7);
        const label = first.toLocaleDateString("en-US", { month: "short" });

        const days = new Set<string>();
        for (const day of presence.keys()) {
            if (day.startsWith(prefix) && day <= todayKey) days.add(day);
        }
        if (todayKey.startsWith(prefix)) days.add(todayKey);

        let onTime = 0;
        let late = 0;
        for (const day of days) {
            const dayMap = presence.get(day);
            for (const s of staff) {
                const st = staffStateOnDay(s, dayMap);
                if (st === "present") onTime++;
                else if (st === "late") late++;
            }
        }
        const expected = days.size * staff.length;
        if (!expected) {
            rows.push({ month: label, "On Time": 0, Late: 0, Absent: 0 });
            continue;
        }
        const a = Math.round((onTime / expected) * 100);
        const b = Math.round((late / expected) * 100);
        rows.push({ month: label, "On Time": a, Late: b, Absent: Math.max(0, 100 - a - b) });
    }
    return rows;
}