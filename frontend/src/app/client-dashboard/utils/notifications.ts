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
}) {
  const {
    title,
    text,
    icon = "warning",
    confirmButtonText = "OK",
    cancelButtonText = "Cancel",
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
      "Choose whether to recalculate them using the new salary or keep their previous salary.",
    icon: "warning",
    showDenyButton: true,
    showCancelButton: true,
    confirmButtonText: "Update pending payroll",
    denyButtonText: "Keep previous salary",
    cancelButtonText: "Cancel salary change",
    focusCancel: true,
    confirmButtonColor: T.teal600,
    denyButtonColor: T.muted,
  });

  if (result.isConfirmed) return "update";
  if (result.isDenied) return "preserve";
  return null;
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
