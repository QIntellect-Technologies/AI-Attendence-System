import React, { useEffect, useState } from "react";
import { CalendarDays, Loader2, X } from "lucide-react";
import usePayrollPolicy from "../Payroll/hooks/usePayrollPolicy";
import type {
  PayrollMonthCalendar,
  PayrollPolicyWrite,
  PayrollWeekday,
} from "../Payroll/api/payrollApi";
import type { PayrollId } from "../Payroll/api/payrollApi";
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

interface WorkingDayCalendarProps {
  peopleType: "staff" | "student";
  branchId?: PayrollId | null;
  modal?: boolean;
  onClose?: () => void;
}

export default function WorkingDayCalendar({
  peopleType,
  branchId,
  modal = false,
  onClose,
}: WorkingDayCalendarProps) {
  const { policy, loading, saving, error, save } = usePayrollPolicy(
    branchId ? { branchId } : undefined,
  );
  const [month, setMonth] = useState(getCurrentMonth);
  const [weeklyOffDays, setWeeklyOffDays] = useState<PayrollWeekday[]>([
    "sunday",
  ]);
  const [holidayDates, setHolidayDates] = useState<string[]>([]);
  const [holidaysConfirmed, setHolidaysConfirmed] = useState(false);
  const [holidayDateDraft, setHolidayDateDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const isStudentCalendar = peopleType === "student";
  const workingDayCalendar = isStudentCalendar
    ? policy.workingDayCalendarsByPeopleType.student ?? {}
    : {
        weeklyOffDays: policy.payrollWeeklyOffDays,
        weeklyOffDaysEffectiveFrom: policy.payrollWeeklyOffDaysEffectiveFrom,
        calendarsByMonth: policy.payrollCalendarsByMonth,
      };
  const monthCalendar = workingDayCalendar.calendarsByMonth?.[month] ?? {};
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
    const savedCalendar = isStudentCalendar
      ? policy.workingDayCalendarsByPeopleType.student ?? {}
      : {
          weeklyOffDays: policy.payrollWeeklyOffDays,
          weeklyOffDaysEffectiveFrom:
            policy.payrollWeeklyOffDaysEffectiveFrom,
          calendarsByMonth: policy.payrollCalendarsByMonth,
        };
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
  }, [
    currentMonth,
    isStudentCalendar,
    loading,
    month,
    policy.payrollCalendarsByMonth,
    policy.payrollWeeklyOffDays,
    policy.payrollWeeklyOffDaysEffectiveFrom,
    policy.workingDayCalendarsByPeopleType,
  ]);

  const saveCalendar = async () => {
    setSaveError(null);
    if (month < currentMonth) {
      setSaveError("Choose the current month or a future month.");
      return;
    }
    const nextMonthCalendar: PayrollMonthCalendar = {
      ...monthCalendar,
      weeklyOffDays,
      holidayDates,
      holidaysConfirmed:
        holidaysConfirmed || holidayDates.length > 0,
    };
    const nextPolicy: PayrollPolicyWrite = isStudentCalendar
      ? {
          ...policy,
          workingDayCalendarsByPeopleType: {
            ...policy.workingDayCalendarsByPeopleType,
            student: {
              ...workingDayCalendar,
              weeklyOffDays,
              weeklyOffDaysEffectiveFrom: month,
              calendarsByMonth: {
                ...workingDayCalendar.calendarsByMonth,
                [month]: nextMonthCalendar,
              },
            },
          },
        }
      : {
          ...policy,
          payrollWeeklyOffDays: weeklyOffDays,
          payrollWeeklyOffDaysEffectiveFrom: month,
          payrollCalendarsByMonth: {
            ...policy.payrollCalendarsByMonth,
            [month]: nextMonthCalendar,
          },
        };
    // Calendar-only configuration is also available when payroll is not
    // purchased; do not submit its unused default OT rate to payroll rules
    // validation, which correctly requires configured rates to be >= 1.
    if (
      nextPolicy.otRatePerHour !== undefined &&
      nextPolicy.otRatePerHour < 1
    ) {
      delete nextPolicy.otRatePerHour;
    }
    try {
      await save(nextPolicy);
      onClose?.();
    } catch (saveFailure) {
      setSaveError(
        saveFailure instanceof Error
          ? saveFailure.message
          : "Failed to save working-day settings.",
      );
    }
  };

  const calendarForm = (
    <section
      aria-label={`${isStudentCalendar ? "Student" : "Staff"} working-day calendar`}
      role={modal ? "dialog" : undefined}
      aria-modal={modal ? true : undefined}
      style={{
        marginBottom: modal ? 0 : 24,
        padding: modal ? 24 : 18,
        border: `1px solid ${T.border}`,
        borderRadius: 18,
        background: T.bgCard,
        boxShadow: modal ? "0 24px 64px rgba(15, 23, 42, 0.22)" : T.shadow,
        width: modal ? "min(100%, 640px)" : undefined,
        maxHeight: modal ? "min(90vh, 760px)" : undefined,
        overflowY: modal ? "auto" : undefined,
        position: modal ? "relative" : undefined,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          flexWrap: "wrap",
          paddingRight: modal ? 48 : 0,
          marginBottom: 20,
          paddingBottom: 18,
          borderBottom: `1px solid ${T.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            aria-hidden="true"
            style={{
              display: "grid",
              placeItems: "center",
              width: 42,
              height: 42,
              flexShrink: 0,
              borderRadius: 12,
              background: "#e8f6f4",
              color: T.teal600,
            }}
          >
            <CalendarDays size={21} />
          </div>
          <div>
            <h2
              style={{
                margin: 0,
                color: T.textHeading,
                fontSize: 18,
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              {isStudentCalendar ? "Student" : "Staff"} working days
            </h2>
            <p style={{ margin: "5px 0 0", color: T.textMuted, fontSize: 13 }}>
              Set weekly days off and monthly holidays for attendance.
            </p>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center" }}>
          <input
            type="month"
            value={month}
            min={currentMonth}
            onChange={(event) => {
              if (event.target.value >= currentMonth) {
                setMonth(event.target.value);
              }
            }}
            aria-label="Calendar month"
            style={{
              minHeight: 40,
              padding: "7px 10px",
              border: `1px solid ${T.border}`,
              borderRadius: 10,
              background: "#fff",
              color: T.textHeading,
              fontSize: 13,
              fontWeight: 600,
            }}
          />
        </div>
      </div>
      {modal && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close working-day settings"
          disabled={saving}
          style={{
            position: "absolute",
            top: 18,
            right: 18,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 36,
            height: 36,
            border: `1px solid ${T.border}`,
            borderRadius: 10,
            background: "#fff",
            color: T.textBody,
            cursor: saving ? "not-allowed" : "pointer",
          }}
        >
          <X size={18} />
        </button>
      )}

      {loading ? (
        <div
          role="status"
          aria-label="Loading calendar settings"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            minHeight: 200,
            color: T.textMuted,
          }}
        >
          <Loader2 size={20} className="animate-spin" aria-hidden="true" />
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 22 }}>
            <div
              style={{
                marginBottom: 10,
                color: T.textBody,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              Weekly days off
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {WEEKDAYS.map((day) => (
                <label
                  key={day}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "8px 10px",
                    border: `1px solid ${
                      weeklyOffDays.includes(day) ? "#a9dcd5" : T.border
                    }`,
                    borderRadius: 10,
                    background: weeklyOffDays.includes(day)
                      ? "#eff9f7"
                      : "#fff",
                    color: T.textBody,
                    fontSize: 12,
                    opacity: isPastMonth ? 0.7 : 1,
                    cursor: isPastMonth ? "not-allowed" : "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={weeklyOffDays.includes(day)}
                    disabled={isPastMonth}
                    style={{ margin: 0, accentColor: T.teal600 }}
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

          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                marginBottom: 10,
                color: T.textBody,
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              Holidays
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <input
                type="date"
                value={holidayDateDraft}
                min={`${month}-01`}
                max={monthEndDate}
                disabled={isPastMonth}
                onChange={(event) => setHolidayDateDraft(event.target.value)}
                aria-label="Holiday date"
                style={{
                  minHeight: 40,
                  padding: "7px 10px",
                  border: `1px solid ${T.border}`,
                  borderRadius: 10,
                  background: "#fff",
                  color: T.textHeading,
                  fontSize: 13,
                }}
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
                style={{
                  minHeight: 40,
                  padding: "0 16px",
                  border: 0,
                  borderRadius: 10,
                  background: T.teal600,
                  color: "#fff",
                  fontWeight: 700,
                  fontSize: 13,
                  cursor:
                    isPastMonth ||
                    !holidayDateDraft ||
                    holidayDates.includes(holidayDateDraft)
                      ? "not-allowed"
                      : "pointer",
                  opacity:
                    isPastMonth ||
                    !holidayDateDraft ||
                    holidayDates.includes(holidayDateDraft)
                      ? 0.6
                      : 1,
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
                  margin: "12px 0 0",
                  listStyle: "none",
                }}
              >
                {holidayDates.map((date) => (
                  <li
                    key={date}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 10px",
                      border: `1px solid ${T.border}`,
                      borderRadius: 9,
                      background: "#f8fafc",
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
                        style={{
                          display: "inline-flex",
                          padding: 2,
                          border: 0,
                          borderRadius: 5,
                          background: "transparent",
                          color: T.textMuted,
                          cursor: "pointer",
                        }}
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
            <p role="alert" style={{ color: T.red600, fontSize: 13 }}>
              {saveError ?? error}
            </p>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              paddingTop: 16,
              borderTop: `1px solid ${T.border}`,
            }}
          >
            <button
              type="button"
              onClick={() => void saveCalendar()}
              disabled={saving || isPastMonth}
              style={{
                minHeight: 42,
                padding: "0 18px",
                border: 0,
                borderRadius: 10,
                background: T.teal600,
                color: "#fff",
                fontWeight: 700,
                fontSize: 13,
                cursor: saving || isPastMonth ? "not-allowed" : "pointer",
                opacity: saving || isPastMonth ? 0.6 : 1,
                boxShadow: "0 2px 5px rgba(15, 118, 110, 0.18)",
              }}
            >
              {saving ? "Saving…" : "Save calendar"}
            </button>
          </div>
        </>
      )}
    </section>
  );

  if (!modal) return calendarForm;

  return (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose?.();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        padding: 16,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(5px)",
      }}
    >
      {calendarForm}
    </div>
  );
}
