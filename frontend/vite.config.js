/**
 * vite.config.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Vite dev-server configuration for QIntellect Client Dashboard.
 *
 * Written as plain JS (not TS) because the project uses vite.config.js.
 * If you rename this file to vite.config.ts, the TypeScript version with
 * `type ProxyOptions` and typed function signatures is preferred instead.
 *
 * Proxy design:
 *   All /api/*, /v1/support/*, and static asset paths are forwarded to the
 *   Flask backend transparently. The browser sees same-origin requests —
 *   zero CORS exposure in development.
 *
 *   Production : set VITE_BACKEND_URL in Railway / deployment environment.
 *   Development: falls back to http://localhost:5000.
 *
 * Removed legacy proxy entries:
 *   /get_staff_list, /get_attendance_today, /get_detected_name,
 *   /video_feed, /add_staff — all return 410 Gone from Flask and have no
 *   active callers in the current codebase.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { defineConfig, loadEnv } from "vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

/**
 * Shared proxy rule factory — define once, spread everywhere.
 *
 * @param {string} target - Backend origin, e.g. "http://localhost:5000"
 * @returns {import("vite").ProxyOptions}
 *
 * `secure: false`    — local Flask runs plain HTTP, not HTTPS.
 * `changeOrigin: true` — rewrites Host header so Flask doesn't reject
 *                        requests arriving with the Vite origin (localhost:5173).
 */
function proxyRule(target) {
  return {
    target,
    changeOrigin: true,
    secure: false,
  };
}

export default defineConfig(({ mode }) => {
  // loadEnv reads .env / .env.local / .env.<mode> from the project root (".").
  // Third arg "" loads all variables, not just VITE_-prefixed ones.
  const env = loadEnv(mode, ".", "");
  const backendUrl = env.VITE_BACKEND_URL || "http://localhost:5000";

  return {
    plugins: [react(), tailwindcss()],

    server: {
      port: 5173,
      strictPort: true, // Fail fast instead of silently binding to next port

      proxy: {
        // ── Primary API ────────────────────────────────────────────────────
        // All /api/* → Flask app.py endpoints
        "/api": proxyRule(backendUrl),

        // ── Support Dashboard internal API ─────────────────────────────────
        // /v1/support/* → support_routes.py blueprint
        // Kept under /v1 (not /api) because the blueprint is internal-only
        // and must never be confused with client-facing /api routes.
        "/v1": proxyRule(backendUrl),

        // ── Flask-served static assets ─────────────────────────────────────
        // Legacy SQLite user profile photos
        "/profile_photos": proxyRule(backendUrl),

        // Supabase client_users profile photos (UUID accounts)
        "/client_profile_photos": proxyRule(backendUrl),
      },
    },
  };
});
