import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import { toast, type ToastOptions } from "react-toastify";
import { T } from "../components/ui/theme";

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

export default {
  toastSuccess,
  toastError,
  toastInfo,
  confirmDialog,
};
