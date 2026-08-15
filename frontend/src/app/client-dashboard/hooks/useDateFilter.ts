import { useMemo, useState } from "react";

export type ViewMode = "daily" | "weekly" | "monthly" | "custom";

export interface DateRange {
  startDate: string;
  endDate: string;
}

export interface DateFilterState {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  selectedDate: string;
  setSelectedDate: (d: string) => void;
  selectedWeek: string;
  setSelectedWeek: (d: string) => void;
  selectedMonth: string;
  setSelectedMonth: (m: string) => void;
  customFrom: string;
  setCustomFrom: (d: string) => void;
  customTo: string;
  setCustomTo: (d: string) => void;
  range: DateRange;
  label: string;
  dates: string[];
}

// `date.toISOString()` always converts to UTC before formatting. For any
// positive-UTC-offset timezone (e.g. PKT, UTC+5), local midnight–4:59am is
// still "yesterday" in UTC, so the previous implementation
// (`date.toISOString().split("T")[0]`) returned yesterday's date as
// "today" for part of every single day. Building the local calendar date
// string directly from getFullYear/getMonth/getDate avoids the UTC
// round-trip entirely.
export function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// `new Date("YYYY-MM-DD")` is parsed as UTC midnight (per spec), while
// `new Date(y, m, d)` and Date instance methods (getDate/setDate/
// toLocaleDateString) all operate in local time. Mixing the two — parsing
// a stored date string with `new Date(str)` and then calling local Date
// methods on it — is the other half of the off-by-one bug: it silently
// shifts the date by a day for the same positive-UTC-offset timezones
// `formatDate` above was affected by. Every place that used to parse a
// "YYYY-MM-DD" string with `new Date(str)` now goes through this instead.
export function parseLocalDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function todayStr(): string {
  return formatDate(new Date());
}

export function getWeekStart(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function getWeekRange(weekStartStr: string): DateRange {
  const start = parseLocalDate(weekStartStr);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

export function getMonthRange(monthStr: string): DateRange {
  const [year, month] = monthStr.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  return { startDate: formatDate(start), endDate: formatDate(end) };
}

export function getDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  const current = parseLocalDate(startDate);
  const end = parseLocalDate(endDate);

  while (current <= end) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}

function humanLabel(
  mode: ViewMode,
  state: {
    selectedDate: string;
    selectedWeek: string;
    selectedMonth: string;
    customFrom: string;
    customTo: string;
  },
): string {
  const fmt = (d: string) =>
    parseLocalDate(d).toLocaleDateString("en-US", {
      month: "short",
      day: "2-digit",
      year: "numeric",
    });

  switch (mode) {
    case "daily":
      return fmt(state.selectedDate);
    case "weekly":
      return `Week of ${fmt(state.selectedWeek)}`;
    case "monthly":
      return parseLocalDate(`${state.selectedMonth}-01`).toLocaleDateString(
        "en-US",
        { month: "long", year: "numeric" },
      );
    case "custom":
      return `${fmt(state.customFrom)} → ${fmt(state.customTo)}`;
  }
}

export function useDateFilter(
  defaultMode: ViewMode = "daily",
): DateFilterState {
  const today = todayStr();
  const thisWeekStart = formatDate(getWeekStart(new Date()));
  const thisMonth = today.slice(0, 7);

  const [mode, setModeRaw] = useState<ViewMode>(defaultMode);
  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedWeek, setSelectedWeek] = useState(thisWeekStart);
  const [selectedMonth, setSelectedMonth] = useState(thisMonth);
  const [customFrom, setCustomFrom] = useState(today);
  const [customTo, setCustomTo] = useState(today);

  const setMode = (newMode: ViewMode) => {
    setModeRaw(newMode);
    if (newMode === "daily") setSelectedDate(today);
    if (newMode === "weekly") setSelectedWeek(thisWeekStart);
    if (newMode === "monthly") setSelectedMonth(thisMonth);
    if (newMode === "custom") {
      setCustomFrom(today);
      setCustomTo(today);
    }
  };

  const range = useMemo<DateRange>(() => {
    switch (mode) {
      case "daily":
        return { startDate: selectedDate, endDate: selectedDate };
      case "weekly":
        return getWeekRange(selectedWeek);
      case "monthly":
        return getMonthRange(selectedMonth);
      case "custom":
        return customFrom <= customTo
          ? { startDate: customFrom, endDate: customTo }
          : { startDate: customTo, endDate: customFrom };
    }
  }, [mode, selectedDate, selectedWeek, selectedMonth, customFrom, customTo]);

  const dates = useMemo(
    () => getDatesBetween(range.startDate, range.endDate),
    [range],
  );

  const label = useMemo(
    () =>
      humanLabel(mode, {
        selectedDate,
        selectedWeek,
        selectedMonth,
        customFrom,
        customTo,
      }),
    [mode, selectedDate, selectedWeek, selectedMonth, customFrom, customTo],
  );

  return {
    mode,
    setMode,
    selectedDate,
    setSelectedDate,
    selectedWeek,
    setSelectedWeek,
    selectedMonth,
    setSelectedMonth,
    customFrom,
    setCustomFrom,
    customTo,
    setCustomTo,
    range,
    label,
    dates,
  };
}