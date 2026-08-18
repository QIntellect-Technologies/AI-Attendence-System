import Swal from "sweetalert2";

/**
 * One shared confirm dialog for every destructive action in the app
 * (clear today's attendance, delete held detection(s)). SweetAlert2's
 * stock popup is sized for consumer apps — big icon, loose padding,
 * oversized text/buttons — which reads as out of place in this compact,
 * data-dense UI. All sizing here is overridden via the .qia-swal-* classes
 * defined in App.tsx's injected stylesheet (SWEETALERT_CSS) so every
 * confirm looks like part of the app rather than a generic SweetAlert2
 * popup, and there's exactly one place to adjust the look going forward.
 */
export async function confirmDestructive(options: {
  title: string;
  /** Plain text body. Use `html` instead if you need line breaks/markup. */
  text?: string;
  html?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<boolean> {
  const result = await Swal.fire({
    icon: "warning",
    title: options.title,
    text: options.html ? undefined : options.text,
    html: options.html,
    showCancelButton: true,
    confirmButtonText: options.confirmText ?? "Delete",
    cancelButtonText: options.cancelText ?? "Cancel",
    focusCancel: true,
    buttonsStyling: false,
    width: 380,
    customClass: {
      popup: "qia-swal-popup",
      icon: "qia-swal-icon",
      title: "qia-swal-title",
      htmlContainer: "qia-swal-html",
      actions: "qia-swal-actions",
      confirmButton: "qia-swal-confirm",
      cancelButton: "qia-swal-cancel",
    },
  });
  return result.isConfirmed;
}