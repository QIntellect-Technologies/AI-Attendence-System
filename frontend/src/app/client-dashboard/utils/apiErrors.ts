/**
 * Maps an HTTP status code to a plain-language fallback message.
 *
 * Used only as the LAST resort in each page's requestJson-style helper
 * (attendanceApi.ts, notificationApi.ts, payrollApi.ts, ...) — i.e. only
 * when the backend's JSON error body has no message/error field of its
 * own. A missing message almost always means the failure never reached
 * application code at all (a 502/503/504 from a proxy or load balancer in
 * front of the API, a timeout, the service being redeployed) rather than a
 * validation error the backend meant for the person to read. When the
 * backend DOES send a message/error, that string is shown as-is instead of
 * this fallback — it's already written for the person (e.g. "Branch
 * capacity limit reached."), not a technical detail worth hiding.
 *
 * Before this existed, every one of these API modules fell back to
 * `` `${label} request failed: ${response.status}` ``, so a plain 502 from
 * an upstream proxy surfaced verbatim as "Attendance request failed: 502"
 * in a dashboard banner — meaningless and alarming to a non-technical
 * user, and it leaked infrastructure detail (raw HTTP status codes) that
 * has no reason to be user-facing.
 */
export function friendlyRequestFailureMessage(
  status: number,
  // What the person was trying to load/save, lowercase, no trailing
  // punctuation — e.g. "attendance", "notification", "payroll". Folded
  // into the 404 and generic-4xx copy only; the more specific branches
  // (auth, rate limit, upstream outage) read fine without it.
  resourceLabel = "request",
): string {
  if (status === 401 || status === 403) {
    return "Your session has expired or you don't have permission for this action. Please sign in again.";
  }
  if (status === 404) {
    return `We couldn't find the requested ${resourceLabel} data.`;
  }
  if (status === 429) {
    return "Too many requests right now. Please wait a moment and try again.";
  }
  if (status === 502 || status === 503 || status === 504) {
    return "The server is temporarily unavailable. Please try again in a moment.";
  }
  if (status >= 500) {
    return "Something went wrong on our end. Please try again, and contact support if this keeps happening.";
  }
  if (status >= 400) {
    return `We couldn't complete that ${resourceLabel} request. Please check your input and try again.`;
  }
  return "Something went wrong. Please try again.";
}
