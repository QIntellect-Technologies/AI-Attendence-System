import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import { toast, type ToastOptions } from "react-toastify";
import { T } from "../components/ui/theme";
import {
  type PendingPayrollPeriod,
  type PendingPayrollSalaryAction,
} from "./pendingPayrollSalary";

const DEFAULT_TOAST_OPTS: ToastOptions = {
  position: "top-right",
  autoClose: 3000,
  closeOnClick: true,
  pauseOnHover: true,
};

export function toastSuccess(message: string, opts?: ToastOptions) {
  return toast.success(message, { ...DEFAULT_TOAST_OPTS, ...opts });
}

export function toastError(message: string, opts?: ToastOptions) {
  return toast.error(message, { ...DEFAULT_TOAST_OPTS, ...opts });
}

export function toastInfo(message: string, opts?: ToastOptions) {
  return toast.info(message, { ...DEFAULT_TOAST_OPTS, ...opts });
}

const swalDefaults = {
  width: 560,
  padding: "18px",
  background: T.card,
  color: T.head,
  customClass: {
    popup: "swal2-popup-custom",
    title: "swal2-title-custom",
    content: "swal2-content-custom",
    confirmButton: "swal2-confirm-custom",
    cancelButton: "swal2-cancel-custom",
  },
};

export async function confirmDialog(opts: {
  title?: string;
  text?: string;
  icon?: "warning" | "info" | "question" | "success" | "error";
  confirmButtonText?: string;
  cancelButtonText?: string;
  loadingButtonText?: string;
  preConfirm?: () => unknown | Promise<unknown>;
}) {
  const {
    title,
    text,
    icon = "warning",
    confirmButtonText = "OK",
    cancelButtonText = "Cancel",
    loadingButtonText,
    preConfirm,
  } = opts;
  return Swal.fire({
    ...swalDefaults,
    title,
    text,
    icon,
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText,
    focusCancel: true,
    confirmButtonColor: T.teal600,
    showLoaderOnConfirm: false,
    allowOutsideClick: () => !Swal.isLoading(),
    preConfirm: preConfirm
      ? async () => {
          if (loadingButtonText) {
            Swal.update({ confirmButtonText: loadingButtonText });
          }
          const result = await preConfirm();
          if (result === false) {
            Swal.update({ confirmButtonText });
          }
          return result;
        }
      : undefined,
  });
}

export async function pendingPayrollSalaryDialog(
  periods: PendingPayrollPeriod[],
): Promise<PendingPayrollSalaryAction | null> {
  const months = periods
    .map((period) => period.period_start.slice(0, 7))
    .join(", ");
  const result = await Swal.fire({
    ...swalDefaults,
    title: "Previous payroll is pending",
    text:
      `The following previous payroll period(s) are still pending: ${months}. ` +
      "Choose whether to recalculate them using the new compensation or keep their previous compensation.",
    icon: "warning",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "Update pending payroll",
    denyButtonText: "Keep previous payroll",
    cancelButtonText: "Cancel changes",
    focusCancel: true,
    confirmButtonColor: T.teal600,
    denyButtonColor: T.muted,
  });

  if (result.isConfirmed) return "update";
  if (result.isDenied) return "preserve";
  return null;
}

export async function pendingPayrollPolicyDialog(
  month: string,
): Promise<"override" | "keep" | null> {
  const result = await Swal.fire({
    ...swalDefaults,
    title: "Previous month's payroll is pending",
    text:
      `All payroll staff are still pending for ${month}. ` +
      "Choose whether these new rules should also recalculate that month.",
    icon: "warning",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "Apply to previous month",
    denyButtonText: "Keep previous month as is",
    cancelButtonText: "Cancel",
    focusCancel: true,
    confirmButtonColor: T.teal600,
    denyButtonColor: T.muted,
  });

  if (result.isConfirmed) return "override";
  if (result.isDenied) return "keep";
  return null;
}

export async function payrollPolicyScopeDialog(
  scope: "organization" | "branch",
): Promise<"default" | "override" | null> {
  const target =
    scope === "organization"
      ? "all branches, departments, and staff"
      : "all departments and staff in this branch";
  const result = await Swal.fire({
    ...swalDefaults,
    title: "Apply rules to existing overrides?",
    text:
      `No department is selected. Save these rules as the ${scope} default, ` +
      `or override existing rules for ${target}.`,
    icon: "question",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "Override existing rules",
    denyButtonText: "Save as default",
    cancelButtonText: "Cancel",
    focusDeny: true,
    confirmButtonColor: T.teal600,
    denyButtonColor: T.muted,
  });

  if (result.isConfirmed) return "override";
  if (result.isDenied) return "default";
  return null;
}

export async function confirmPreviousMonthPayrollPolicyDialog(
  month: string,
  staffCount: number,
): Promise<boolean> {
  const result = await Swal.fire({
    ...swalDefaults,
    title: `Confirm rules for ${month}`,
    text:
      `These rules will be used to recalculate the previous month's payroll ` +
      `for all ${staffCount} pending staff members in this scope. ` +
      "Already-paid payroll entries will not be changed.",
    icon: "warning",
    showCancelButton: true,
    confirmButtonText: "Confirm and apply",
    cancelButtonText: "Go back",
    focusCancel: true,
    confirmButtonColor: T.teal600,
  });

  return result.isConfirmed;
}

/**
 * Confirm dialog with a required free-text reason. Resolves to the trimmed
 * reason when confirmed, or null when cancelled.
 */
export async function reasonDialog(opts: {
  title?: string;
  text?: string;
  placeholder?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  minLength?: number;
}): Promise<string | null> {
  const {
    title,
    text,
    placeholder = "Write the reason here…",
    confirmButtonText = "Confirm",
    cancelButtonText = "Cancel",
    minLength = 3,
  } = opts;
  const result = await Swal.fire({
    ...swalDefaults,
    title,
    text,
    icon: "warning",
    input: "textarea",
    inputPlaceholder: placeholder,
    inputAttributes: { maxlength: "500", "aria-label": "Reason" },
    showCancelButton: true,
    confirmButtonText,
    cancelButtonText,
    focusCancel: false,
    confirmButtonColor: T.teal600,
    preConfirm: (value: string) => {
      const reason = (value ?? "").trim();
      if (reason.length < minLength) {
        Swal.showValidationMessage("A reason is required.");
        return false;
      }
      return reason;
    },
  });
  return result.isConfirmed ? String(result.value ?? "").trim() : null;
}

export async function alertDialog(opts: {
  title?: string;
  text?: string;
  icon?: "warning" | "info" | "question" | "success" | "error";
  confirmButtonText?: string;
}) {
  const { title, text, icon = "error", confirmButtonText = "OK" } = opts;
  return Swal.fire({
    ...swalDefaults,
    title,
    text,
    icon,
    confirmButtonText,
    confirmButtonColor: T.teal600,
  });
}

export default {
  toastSuccess,
  reasonDialog,
  toastError,
  toastInfo,
  confirmDialog,
  alertDialog,
};
