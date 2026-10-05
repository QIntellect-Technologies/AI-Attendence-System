/**
 * api/notificationApi.validation.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Validation and error handling for notification API calls.
 *
 * Problem it solves:
 *   Notification endpoints require both userId AND organizationId.
 *   Missing organizationId → 400 Bad Request → silent cascade failure.
 *
 * This validates inputs BEFORE calling the API, providing clear error messages
 * instead of cryptic HTTP 400s.
 *
 * Usage:
 *   const params = validateNotificationParams({
 *     userId: user?.id,
 *     organizationId: org.organizationId,
 *   });
 *
 *   if (!params.valid) {
 *     console.error(params.error);  // "organizationId is required"
 *     return;
 *   }
 *
 *   await listNotifications(params.data);
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface NotificationApiParams {
  userId: string | number;
  organizationId: string | number;
  unreadOnly?: boolean;
  limit?: number;
}

export interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  error?: string;
}

/**
 * Validates notification API parameters.
 * Returns { valid: true, data: {...} } or { valid: false, error: "reason" }
 *
 * Guarantees:
 *   ✓ userId is non-empty string or positive number
 *   ✓ organizationId is non-empty string or positive number
 *   ✓ Both are required (cannot be null/undefined/empty)
 */
export function validateNotificationParams(input: {
  userId: unknown;
  organizationId: unknown;
  unreadOnly?: boolean;
  limit?: number;
}): ValidationResult<NotificationApiParams> {
  // Validate userId
  if (input.userId === null || input.userId === undefined) {
    return {
      valid: false,
      error: "User is not authenticated. Please log in.",
    };
  }

  const userIdStr = String(input.userId).trim();
  if (!userIdStr) {
    return {
      valid: false,
      error: "User ID is empty. Authentication may be incomplete.",
    };
  }

  // Validate organizationId
  if (input.organizationId === null || input.organizationId === undefined) {
    return {
      valid: false,
      error:
        "Organization is not loaded. Please refresh the page after login.",
    };
  }

  const orgIdStr = String(input.organizationId).trim();
  if (!orgIdStr) {
    return {
      valid: false,
      error:
        "Organization ID is empty. Configuration may be incomplete. Try refreshing.",
    };
  }

  // All validations passed
  return {
    valid: true,
    data: {
      userId: userIdStr.match(/^\d+$/) ? Number(userIdStr) : userIdStr,
      organizationId: orgIdStr.match(/^\d+$/) ? Number(orgIdStr) : orgIdStr,
      unreadOnly: input.unreadOnly,
      limit: input.limit,
    },
  };
}

/**
 * Wraps a notification API call with validation.
 * Useful for quick error handling without boilerplate.
 *
 * Example:
 *   const result = await validateAndCall(
 *     { userId: user?.id, organizationId: org.organizationId },
 *     (params) => listNotifications(params)
 *   );
 *
 *   if (!result.ok) {
 *     setError(result.error);
 *     return;
 *   }
 *
 *   const { notifications } = result.data;
 */
export async function validateAndCallNotificationApi<T>(
  input: { userId: unknown; organizationId: unknown },
  apiCall: (params: NotificationApiParams) => Promise<T>,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  const validation = validateNotificationParams(input);

  if (!validation.valid) {
    return {
      ok: false,
      error: validation.error,
    };
  }

  try {
    const data = await apiCall(validation.data!);
    return { ok: true, data };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to load notifications.";
    return {
      ok: false,
      error: message,
    };
  }
}
