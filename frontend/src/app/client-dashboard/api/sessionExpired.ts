import Swal from "sweetalert2";
import "sweetalert2/dist/sweetalert2.min.css";
import { toastError } from "../utils/notifications";

const DASHBOARD_AUTH_TOKEN_KEY = "dashboardAuthToken";
const STORAGE_KEY_USER = "currentUser";
const STORAGE_KEY_AUTH = "isAuthenticated";
const ORG_STORAGE_PREFIX = "orgConfig:";
const LEGACY_ORG_STORAGE_KEY = "orgConfig";
let sessionExpiryHandled = false;

function clearDashboardAuthToken(): void {
  try {
    localStorage.removeItem(DASHBOARD_AUTH_TOKEN_KEY);
  } catch {
    // Ignore storage access errors.
  }
}

function clearAuthStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_USER);
    localStorage.removeItem(STORAGE_KEY_AUTH);
    localStorage.removeItem(LEGACY_ORG_STORAGE_KEY);
    Object.keys(localStorage).forEach((key) => {
      if (key.startsWith(ORG_STORAGE_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  } catch {
    // Ignore storage access errors.
  }
}

export function handleSessionExpired(
  message = "Session expired. Please log in again.",
): void {
  if (sessionExpiryHandled) return;
  sessionExpiryHandled = true;

  clearDashboardAuthToken();
  clearAuthStorage();

  toastError(message);

  void Swal.fire({
    icon: "warning",
    title: "Session expired",
    text: message,
    confirmButtonText: "Login",
    timer: 4500,
    timerProgressBar: true,
    showCloseButton: false,
    allowOutsideClick: false,
    allowEscapeKey: false,
    allowEnterKey: true,
  }).then(() => {
    window.location.replace("/login");
  });

  setTimeout(() => {
    window.location.replace("/login");
  }, 5000);
}
