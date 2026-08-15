/**
 * src/app/support-dashboard/api/supportApiClient.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Typed Axios instance exclusively for Support Dashboard API calls.
 */

import axios, {
  type AxiosError,
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";

const SUPPORT_TOKEN_KEY = "support_access_token";

export const SUPPORT_API_TIMEOUT_MS = 15_000;
export const SUPPORT_DOWNLOAD_TIMEOUT_MS = 180_000;

type RuntimeEnv = Record<string, string | undefined>;

function cleanBaseUrl(value?: string | null): string {
  return String(value || "")
    .trim()
    .replace(/\/+$/, "");
}

function readViteEnv(): RuntimeEnv {
  return ((import.meta as unknown as { env?: RuntimeEnv }).env ??
    {}) as RuntimeEnv;
}

function getSupportApiBaseUrl(): string {
  const env = readViteEnv();

  const configured =
    env.VITE_SUPPORT_API_BASE_URL ||
    env.VITE_API_BASE_URL ||
    env.VITE_BACKEND_URL ||
    env.VITE_API_URL;

  const cleaned = cleanBaseUrl(configured);
  if (cleaned) return cleaned;

  const host = window.location.hostname;
  const port = window.location.port;

  if ((host === "localhost" || host === "127.0.0.1") && port === "5173") {
    return "http://127.0.0.1:5000";
  }

  return "";
}

export const getSupportToken = (): string | null =>
  localStorage.getItem(SUPPORT_TOKEN_KEY);

export const setSupportToken = (token: string): void =>
  localStorage.setItem(SUPPORT_TOKEN_KEY, token);

export const clearSupportToken = (): void =>
  localStorage.removeItem(SUPPORT_TOKEN_KEY);

const createSupportApiClient = (): AxiosInstance => {
  const client = axios.create({
    baseURL: getSupportApiBaseUrl(),
    timeout: SUPPORT_API_TIMEOUT_MS,
    withCredentials: false,
    headers: { "Content-Type": "application/json" },
  });

  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const token = getSupportToken();
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });

  client.interceptors.response.use(
    (res: AxiosResponse) => res,
    (err: AxiosError) => {
      if (err.response?.status === 401) {
        clearSupportToken();
        if (!window.location.pathname.startsWith("/support/login")) {
          window.location.replace("/support/login");
        }
      }
      return Promise.reject(err);
    },
  );

  return client;
};

export const supportApiClient = createSupportApiClient();
