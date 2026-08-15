/**
 * DateFilterBar.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure presentational component — renders the Daily / Weekly / Monthly /
 * Custom toggle + the matching date input(s).
 *
 * Owns ZERO state. All state lives in the useDateFilter() hook instance that
 * belongs to the calling component — guaranteeing full filter isolation
 * between pages.
 *
 * Styled exclusively with inline styles via T theme tokens (no Tailwind).
 * This matches the rest of the codebase and ensures styles are always visible
 * regardless of Tailwind's content-scan / purge configuration.
 *
 * Props
 * ─────
 *   filter      — DateFilterState returned by useDateFilter()
 *   modes?      — which buttons to show (default: all four)
 *   compact?    — tighter padding/font for header rows
 *   maxDate?    — upper bound for selectable dates ("YYYY-MM-DD").
 *                 Defaults to today. Pass `null` for modules (e.g. Leave)
 *                 that need to select future dates.
 *
 * Usage
 * ─────
 *   const filter = useDateFilter("daily");
 *   <DateFilterBar filter={filter} />
 *
 *   const filter = useDateFilter("monthly");
 *   <DateFilterBar filter={filter} compact />
 *
 *   // A module that needs future dates (e.g. Leave):
 *   <DateFilterBar filter={filter} maxDate={null} />
 */

import React from "react";
import { LayoutGrid, CalendarDays, Calendar, Sliders } from "lucide-react";
import { T } from "./theme";
import JellyButton from "./JellyButton";
import type { DateFilterState, ViewMode } from "../../hooks/useDateFilter";
import {
  getWeekStart,
  formatDate,
  parseLocalDate,
} from "../../hooks/useDateFilter";

// ─── Types ────────────────────────────────────────────────────────────────────

interface DateFilterBarProps {
  filter: DateFilterState;
  modes?: ViewMode[];
  compact?: boolean;
  /**
   * Upper bound for selectable dates, as "YYYY-MM-DD".
   *
   * Defaults to today — correct for modules like Attendance/Overtime,
   * where you can't act on a day that hasn't happened yet. Pass `null`
   * to remove the ceiling entirely for modules that legitimately need
   * future dates (e.g. Leave, which is applied for upcoming days).
   *
   * Omit this prop for the historical (pre-existing) "today" ceiling;
   * every current caller keeps working unchanged.
   */
  maxDate?: string | null;
}

// ─── Mode metadata — defined once, DRY ───────────────────────────────────────

const MODE_META: Record<ViewMode, { label: string; icon: React.ReactNode }> = {
  daily: { label: "Daily", icon: <LayoutGrid size={13} /> },
  weekly: { label: "Weekly", icon: <Calendar size={13} /> },
  monthly: { label: "Monthly", icon: <CalendarDays size={13} /> },
  custom: { label: "Custom", icon: <Sliders size={13} /> },
};

const ALL_MODES: ViewMode[] = ["daily", "weekly", "monthly", "custom"];

// ─── Shared date-input style ──────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  fontSize: 12,
  border: `1.5px solid ${T.border}`,
  borderRadius: 8,
  padding: "6px 10px",
  color: T.head,
  background: T.card,
  fontFamily: "'DM Sans', sans-serif",
  outline: "none",
  cursor: "pointer",
};

// ─── Week-picker helpers ──────────────────────────────────────────────────────

/** "YYYY-Www"  →  Monday as "YYYY-MM-DD" */
function weekInputToMonday(weekValue: string): string {
  const [yearStr, weekStr] = weekValue.split("-W");
  const year = Number(yearStr);
  const week = Number(weekStr);
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay() || 7;
  const weekOneMonday = new Date(jan4);
  weekOneMonday.setDate(jan4.getDate() - (jan4Day - 1));
  weekOneMonday.setDate(weekOneMonday.getDate() + (week - 1) * 7);
  return formatDate(weekOneMonday);
}

/** Monday as "YYYY-MM-DD"  →  "YYYY-Www" for <input type="week"> */
function mondayToWeekInput(mondayStr: string): string {
  const d = new Date(mondayStr);
  const thursday = new Date(d);
  thursday.setDate(d.getDate() + 3);
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const weekNum = Math.ceil(
    ((thursday.getTime() - jan1.getTime()) / 86_400_000 + jan1.getDay() + 1) /
      7,
  );
  return `${year}-W${String(weekNum).padStart(2, "0")}`;
}

// ─── Component ────────────────────────────────────────────────────────────────

const DateFilterBar: React.FC<DateFilterBarProps> = ({
  filter,
  modes = ALL_MODES,
  compact = false,
  maxDate,
}) => {
  const btnPadding = compact ? "5px 10px" : "7px 14px";
  const btnFontSize = compact ? 11 : 12;

  // Backward-compatible default: omitting `maxDate` reproduces the
  // original "today" ceiling exactly. Passing `maxDate={null}` removes
  // the ceiling on every input below, uniformly, for one source of truth
  // instead of a per-input override.
  const resolvedMaxDate =
    maxDate === undefined ? formatDate(new Date()) : maxDate;
  const maxWeekInput = resolvedMaxDate
    ? mondayToWeekInput(
        formatDate(getWeekStart(parseLocalDate(resolvedMaxDate))),
      )
    : undefined;
  const maxMonthInput = resolvedMaxDate
    ? resolvedMaxDate.slice(0, 7)
    : undefined;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        fontFamily: "'DM Sans', sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {modes.map((m) => {
          const meta = MODE_META[m];
          const active = filter.mode === m;
          return (
            <JellyButton
              key={m}
              type="button"
              variant={active ? "primary" : "secondary"}
              size="sm"
              leftIcon={meta.icon}
              onClick={() => filter.setMode(m)}
              style={{
                padding: btnPadding,
                fontSize: btnFontSize,
              }}
            >
              {meta.label}
            </JellyButton>
          );
        })}
      </div>

      {/* ── Date input for the active mode ── */}

      {filter.mode === "daily" && (
        <input
          type="date"
          value={filter.selectedDate}
          max={resolvedMaxDate ?? undefined}
          onChange={(e) => filter.setSelectedDate(e.target.value)}
          style={inputStyle}
        />
      )}

      {filter.mode === "weekly" && (
        <input
          type="week"
          value={mondayToWeekInput(filter.selectedWeek)}
          max={maxWeekInput}
          onChange={(e) =>
            filter.setSelectedWeek(weekInputToMonday(e.target.value))
          }
          style={inputStyle}
        />
      )}

      {filter.mode === "monthly" && (
        <input
          type="month"
          value={filter.selectedMonth}
          max={maxMonthInput}
          onChange={(e) => filter.setSelectedMonth(e.target.value)}
          style={inputStyle}
        />
      )}

      {filter.mode === "custom" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="date"
            value={filter.customFrom}
            max={filter.customTo || resolvedMaxDate || undefined}
            onChange={(e) => filter.setCustomFrom(e.target.value)}
            style={inputStyle}
          />
          <span style={{ fontSize: 11, color: T.muted, fontWeight: 600 }}>
            →
          </span>
          <input
            type="date"
            value={filter.customTo}
            min={filter.customFrom}
            max={resolvedMaxDate ?? undefined}
            onChange={(e) => filter.setCustomTo(e.target.value)}
            style={inputStyle}
          />
        </div>
      )}
    </div>
  );
};

export default DateFilterBar;
