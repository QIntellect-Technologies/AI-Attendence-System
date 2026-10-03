export type PendingPayrollSalaryAction = "preserve" | "update";

export interface PendingPayrollPeriod {
  period_start: string;
  period_end: string;
}

export function parsePendingPayrollPeriods(
  value: unknown,
): PendingPayrollPeriod[] | null {
  if (!Array.isArray(value)) return null;

  const periods = value.filter(
    (period): period is PendingPayrollPeriod =>
      typeof period === "object" &&
      period !== null &&
      "period_start" in period &&
      "period_end" in period &&
      typeof period.period_start === "string" &&
      typeof period.period_end === "string",
  );
  return periods.length === value.length && periods.length > 0 ? periods : null;
}

export class PendingPayrollSalaryDecisionError extends Error {
  constructor(readonly periods: PendingPayrollPeriod[]) {
    super("A decision is required for pending payroll periods.");
    this.name = "PendingPayrollSalaryDecisionError";
  }
}

export async function saveWithPendingPayrollSalaryDecision<T>(
  save: (action?: PendingPayrollSalaryAction) => Promise<T>,
  chooseAction: (
    periods: PendingPayrollPeriod[],
  ) => Promise<PendingPayrollSalaryAction | null>,
): Promise<{ cancelled: true } | { cancelled: false; value: T }> {
  try {
    return { cancelled: false, value: await save() };
  } catch (error) {
    if (!(error instanceof PendingPayrollSalaryDecisionError)) throw error;

    const action = await chooseAction(error.periods);
    if (!action) return { cancelled: true };
    return { cancelled: false, value: await save(action) };
  }
}
