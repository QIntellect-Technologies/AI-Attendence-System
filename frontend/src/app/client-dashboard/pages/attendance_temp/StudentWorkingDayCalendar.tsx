import React, { useEffect, useState } from "react";
import { Loader2, X } from "lucide-react";
import usePayrollPolicy from "../Payroll/hooks/usePayrollPolicy";
import type {
  PayrollMonthCalendar,
  PayrollWeekday,
} from "../Payroll/api/payrollApi";
import { T } from "./utils/attendanceDisplay";

const WEEKDAYS: PayrollWeekday[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

function getCurrentMonth(): string {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
}

export default function StudentWorkingDayCalendar() {
  const { policy, loading, saving, error, save } = usePayrollPolicy();
  const [month, setMonth] = useState(getCurrentMonth);
  const [weeklyOffDays, setWeeklyOffDays] = useState<PayrollWeekday[]>([
    "sunday",
  ]);
  const [holidayDates, setHolidayDates] = useState<string[]>([]);
  const [holidaysConfirmed, setHolidaysConfirmed] = useState(false);
  const [holidayDateDraft, setHolidayDateDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const studentCalendar =
    policy.workingDayCalendarsByPeopleType.student ?? {};
  const monthCalendar = studentCalendar.calendarsByMonth?.[month] ?? {};
  const currentMonth = getCurrentMonth();
  const isPastMonth = month < currentMonth;
  const monthEnd = new Date(
    Number(month.slice(0, 4)),
    Number(month.slice(5, 7)),
    0,
  ).getDate();
  const monthEndDate = `${month}-${String(monthEnd).padStart(2, "0")}`;

  useEffect(() => {
    if (loading) return;
    const savedCalendar =
      policy.workingDayCalendarsByPeopleType.student ?? {};
    const savedMonth = savedCalendar.calendarsByMonth?.[month] ?? {};
    const savedWeeklyOffDays =
      month >=
      (savedCalendar.weeklyOffDaysEffectiveFrom ?? currentMonth)
        ? (savedCalendar.weeklyOffDays ?? ["sunday"])
        : (savedMonth.weeklyOffDays ??
          (savedMonth.weeklyOffDay ? [savedMonth.weeklyOffDay] : ["sunday"]));

    setWeeklyOffDays(savedWeeklyOffDays);
    setHolidayDates(savedMonth.holidayDates ?? []);
    setHolidaysConfirmed(
      savedMonth.holidaysConfirmed === true ||
        (savedMonth.holidayDates?.length ?? 0) > 0,
    );
    setHolidayDateDraft("");
  }, [currentMonth, loading, month, policy.workingDayCalendarsByPeopleType]);

  const saveCalendar = async () => {
    setSaveError(null);
    const nextMonthCalendar: PayrollMonthCalendar = {
      ...monthCalendar,
      weeklyOffDays,
      holidayDates,
      holidaysConfirmed:
        holidaysConfirmed || holidayDates.length > 0,
    };
    try {
      await save({
        ...policy,
        workingDayCalendarsByPeopleType: {
          ...policy.workingDayCalendarsByPeopleType,
          student: {
            ...studentCalendar,
            weeklyOffDays,
            weeklyOffDaysEffectiveFrom: month,
            calendarsByMonth: {
              ...studentCalendar.calendarsByMonth,
              [month]: nextMonthCalendar,
            },
          },
        },
      });
    } catch (saveFailure) {
      setSaveError(
        saveFailure instanceof Error
          ? saveFailure.message
          : "Failed to save student working-day settings.",
      );
    }
  };

  return (
    <section
      aria-label="Student working-day calendar"
      style={{
        marginBottom: 24,
        padding: 18,
        border: `1px solid ${T.border}`,
        borderRadius: 14,
        background: T.bgCard,
        boxShadow: T.shadow,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 14,
        }}
      >
        <div>
          <h2 style={{ margin: 0, color: T.textHeading, fontSize: 16 }}>
            Student working days
          </h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 12 }}>
            Set weekly days off and monthly holidays for student attendance.
          </p>
        </div>
        <input
          type="month"
          value={month}
          onChange={(event) => setMonth(event.target.value)}
          aria-label="Calendar month"
          style={{ minHeight: 38, padding: "6px 10px" }}
        />
      </div>

      {loading ? (
        <div
          role="status"
          style={{ display: "flex", alignItems: "center", gap: 8, color: T.textMuted }}
        >
          <Loader2 size={16} className="animate-spin" />
          Loading calendar settings
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                marginBottom: 8,
                color: T.textBody,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Weekly days off
            </div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              {WEEKDAYS.map((day) => (
                <label
                  key={day}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    color: T.textBody,
                    fontSize: 12,
                    opacity: isPastMonth ? 0.7 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={weeklyOffDays.includes(day)}
                    disabled={isPastMonth}
                    onChange={() =>
                      setWeeklyOffDays((current) =>
                        current.includes(day)
                          ? current.filter((value) => value !== day)
                          : [...current, day],
                      )
                    }
                  />
                  {day[0].toUpperCase() + day.slice(1)}
                </label>
              ))}
            </div>
          </div>

          <div style={{ marginBottom: 14 }}>
            <div
              style={{
                marginBottom: 8,
                color: T.textBody,
                fontSize: 12,
                fontWeight: 700,
              }}
            >
              Holidays
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                type="date"
                value={holidayDateDraft}
                min={`${month}-01`}
                max={monthEndDate}
                disabled={isPastMonth}
                onChange={(event) => setHolidayDateDraft(event.target.value)}
                aria-label="Holiday date"
              />
              <button
                type="button"
                disabled={
                  isPastMonth ||
                  !holidayDateDraft ||
                  holidayDates.includes(holidayDateDraft)
                }
                onClick={() => {
                  setHolidayDates((current) =>
                    [...current, holidayDateDraft].sort(),
                  );
                  setHolidaysConfirmed(true);
                  setHolidayDateDraft("");
                }}
              >
                Add holiday
              </button>
            </div>
            {holidayDates.length > 0 ? (
              <ul
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  padding: 0,
                  margin: "10px 0 0",
                  listStyle: "none",
                }}
              >
                {holidayDates.map((date) => (
                  <li
                    key={date}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "5px 8px",
                      borderRadius: 8,
                      background: T.slate100,
                      color: T.textBody,
                      fontSize: 12,
                    }}
                  >
                    {date}
                    {!isPastMonth && (
                      <button
                        type="button"
                        onClick={() =>
                          setHolidayDates((current) =>
                            current.filter((value) => value !== date),
                          )
                        }
                        aria-label={`Remove holiday ${date}`}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              !isPastMonth && (
                <button
                  type="button"
                  onClick={() => setHolidaysConfirmed(true)}
                  disabled={holidaysConfirmed}
                  style={{ marginTop: 8 }}
                >
                  {holidaysConfirmed ? "No holidays confirmed" : "Confirm no holidays"}
                </button>
              )
            )}
          </div>

          {(saveError || error) && (
            <p role="alert" style={{ color: T.red600, fontSize: 12 }}>
              {saveError ?? error}
            </p>
          )}
          <button
            type="button"
            onClick={() => void saveCalendar()}
            disabled={saving || isPastMonth}
            style={{
              padding: "8px 14px",
              border: 0,
              borderRadius: 8,
              background: T.teal600,
              color: "#fff",
              fontWeight: 700,
              cursor: saving || isPastMonth ? "not-allowed" : "pointer",
              opacity: saving || isPastMonth ? 0.6 : 1,
            }}
          >
            {saving ? "Saving…" : "Save calendar"}
          </button>
        </>
      )}
    </section>
  );
}
