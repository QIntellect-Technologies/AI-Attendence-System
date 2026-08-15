/**
 * NotificationsPage.tsx — CORRECTED VERSION
 * ─────────────────────────────────────────────────────────────────────────────
 * Fixes:
 *   [Fix-1] useOrgReady() ensures organizationId is loaded before API calls
 *   [Fix-2] validateNotificationParams() checks userId + organizationId before request
 *   [Fix-3] useEffect now depends on isReady to prevent race conditions
 *   [Fix-4] Error messages are clear and actionable (not cryptic HTTP 400s)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  Clock,
  DollarSign,
  TimerReset,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";

import { useAuth } from "../../contexts/useAuth";
import { useOrgReady } from "../../hooks/useOrgReady";
import { T } from "../../components/ui/theme";
import { JellyButton } from "../../components/ui/JellyButton";
import RefreshButton from "../../components/ui/RefreshButton";
import {
  bulkDeleteNotifications,
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type DashboardNotification,
} from "./api/notificationApi";
import {
  validateNotificationParams,
  validateAndCallNotificationApi,
} from "./api/notificationApi.validation";
import { setPayrollDecision } from "../attendance_temp/api/attendanceExceptionsApi";

// ─────────────────────────────────────────────────────────────────────────────
// TYPES & UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const PAYROLL_DECISION_EVENT_TYPE = "attendance.payroll_decision.pending";

function isPayrollDecisionNotification(
  notification: DashboardNotification,
): boolean {
  return notification.event_type === PAYROLL_DECISION_EVENT_TYPE;
}

type AuthUser = {
  id?: number | string;
  organizationId?: number | string | null;
  organization_id?: number | string | null;
};

function cleanId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function notificationIcon(
  notification: DashboardNotification,
): React.ComponentType<{ size?: number; color?: string }> {
  if (notification.event_type === "employee_added") return UserPlus;
  if (notification.event_type === "leave_applied") return CalendarDays;
  if (notification.event_type === "overtime_applied") return TimerReset;
  if (isPayrollDecisionNotification(notification)) return DollarSign;
  return Bell;
}

function notificationAccent(notification: DashboardNotification): string {
  if (notification.event_type === "employee_added") return T.teal600;
  if (notification.event_type === "leave_applied") return "#2563eb";
  if (notification.event_type === "overtime_applied") return "#d97706";
  if (isPayrollDecisionNotification(notification)) return "#d97706";
  return T.navy600;
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/** Icon badge for a single notification row. */
const NotificationIconBadge: React.FC<{
  notification: DashboardNotification;
}> = ({ notification }) => {
  const Icon = notificationIcon(notification);
  const accent = notificationAccent(notification);
  return (
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 14,
        background: `${accent}18`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <Icon size={18} color={accent} />
    </div>
  );
};

/** Text body for a single notification row. */
const NotificationBody: React.FC<{
  notification: DashboardNotification;
}> = ({ notification }) => {
  const unread = !notification.is_read;
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <strong style={{ color: T.head, fontSize: 13 }}>
          {notification.title}
        </strong>
        {unread && (
          <span
            style={{
              background: T.teal600,
              color: "#fff",
              borderRadius: 20,
              padding: "2px 7px",
              fontSize: 10,
              fontWeight: 900,
            }}
          >
            New
          </span>
        )}
      </div>
      <div
        style={{
          marginTop: 4,
          color: T.muted,
          fontSize: 12,
          lineHeight: 1.45,
        }}
      >
        {notification.body || "Open notification details."}
      </div>
      <div
        style={{
          marginTop: 7,
          display: "flex",
          alignItems: "center",
          gap: 7,
          color: T.muted,
          fontSize: 11,
        }}
      >
        <Clock size={12} />
        {formatTime(notification.created_at)}
        <span>·</span>
        <span style={{ textTransform: "capitalize" }}>
          {notification.module_key}
        </span>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PAGE COMPONENT — CORRECTED
// ─────────────────────────────────────────────────────────────────────────────

export default function NotificationsPage() {
  const navigate = useNavigate();
  const { user: rawUser } = useAuth() as { user?: AuthUser | null };

  // [Fix-1] useOrgReady ensures organizationId is loaded before using it
  const { isReady, organizationId } = useOrgReady();

  const userId = cleanId(rawUser?.id);

  const [items, setItems] = useState<DashboardNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [decidingId, setDecidingId] = useState<number | null>(null);

  // [Fix-2] load() validates params before calling API
  const load = useCallback(async () => {
    // Defensive: check userId exists (should be from useAuth)
    if (!userId) {
      setError("User is not authenticated.");
      setLoading(false);
      return;
    }

    // [Fix-1] Don't call API until organization is ready
    if (!isReady || !organizationId) {
      // Still initializing or no org — don't error, just wait
      return;
    }

    try {
      setRefreshing(true);
      setError(null);

      // [Fix-2] Validate params before sending to API
      const validation = validateNotificationParams({
        userId,
        organizationId,
      });

      if (!validation.valid) {
        setError(validation.error || "Invalid parameters.");
        setLoading(false);
        return;
      }

      // Make the API call with validated params
      const response = await listNotifications({
        userId: validation.data!.userId,
        organizationId: validation.data!.organizationId,
        limit: 100,
      });

      // Merge incoming notifications with any locally-recorded payroll
      // decisions so UI immediately reflects includes/excludes even if
      // the server-side notifications table doesn't store that flag.
      setItems((prev) =>
        response.notifications.map((n) => {
          try {
            const prevMatch = prev.find((p) => {
              const a = String(
                (p.metadata && p.metadata.attendance_id) ||
                  p.target_entity_id ||
                  "",
              );
              const b = String(
                (n.metadata && n.metadata.attendance_id) ||
                  n.target_entity_id ||
                  "",
              );
              return a && b && a === b;
            });
            if (prevMatch) {
              const existingDecision =
                (prevMatch.metadata &&
                  (prevMatch.metadata.check_out_payroll_decision ||
                    prevMatch.metadata.checkOutPayrollDecision)) ||
                undefined;
              if (existingDecision) {
                return {
                  ...n,
                  metadata: {
                    ...(n.metadata || {}),
                    check_out_payroll_decision: existingDecision,
                    checkOutPayrollDecision: existingDecision,
                  },
                };
              }
            }
          } catch (e) {
            // ignore
          }
          return n;
        }),
      );
      setUnreadCount(response.unread_count);
      const liveIds = new Set(response.notifications.map((n) => n.id));
      setSelectedIds((current) => {
        const next = new Set([...current].filter((id) => liveIds.has(id)));
        return next.size === current.size ? current : next;
      });
    } catch (err) {
      // [Fix-4] Clear error messages instead of cryptic HTTP errors
      const message =
        err instanceof Error
          ? err.message
          : "Failed to load notifications. Please try again.";

      setError(message);
      console.error("Notification load error:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [userId, isReady, organizationId]);

  // [Fix-3] Only load when BOTH userId and org are ready
  useEffect(() => {
    if (!userId || !isReady) {
      // Not ready yet, don't load
      return;
    }

    void load();
  }, [userId, isReady, load]);

  const unreadItems = useMemo(
    () => items.filter((item) => !item.is_read).length,
    [items],
  );

  const handleMarkRead = useCallback(
    async (notification: DashboardNotification) => {
      if (!userId || !organizationId || notification.is_read) return;

      try {
        await markNotificationRead({
          notificationId: notification.id,
          userId,
          organizationId,
        });
        setItems((current) =>
          current.map((item) =>
            item.id === notification.id
              ? { ...item, is_read: true, read_at: new Date().toISOString() }
              : item,
          ),
        );
        setUnreadCount((current) => Math.max(0, current - 1));
      } catch (err) {
        console.error("Failed to mark notification as read:", err);
        setError("Failed to mark notification as read.");
      }
    },
    [userId, organizationId],
  );

  const handleOpen = useCallback(
    async (notification: DashboardNotification) => {
      await handleMarkRead(notification);
      if (notification.target_route) navigate(notification.target_route);
    },
    [handleMarkRead, navigate],
  );

  const handleMarkAllRead = useCallback(async () => {
    if (!userId || !isReady || !organizationId) return;

    try {
      await markAllNotificationsRead({
        userId,
        organizationId,
      });
      setItems((current) =>
        current.map((item) => ({
          ...item,
          is_read: true,
          read_at: item.read_at ?? new Date().toISOString(),
        })),
      );
      setUnreadCount(0);
    } catch (err) {
      console.error("Failed to mark all as read:", err);
      setError("Failed to mark all as read.");
    }
  }, [userId, isReady, organizationId]);

  const handleSetPayrollDecision = useCallback(
    async (
      notification: DashboardNotification,
      decision: "include" | "exclude",
    ) => {
      if (!userId || !organizationId) return;
      const attendanceId =
        cleanId(notification.metadata?.attendance_id) ??
        cleanId(notification.target_entity_id);
      if (!attendanceId) {
        setError("This notification is missing its attendance reference.");
        return;
      }

      setDecidingId(notification.id);
      try {
        const resp = await setPayrollDecision({
          organizationId,
          attendanceId,
          decision,
          decidedBy: userId,
        });
        // Update the notification item(s) locally so the include/exclude
        // buttons reflect the saved payroll decision immediately without
        // depending on a full reload.
        const newDecision =
          (resp?.checkOutPayrollDecision as string) ||
          (resp?.check_out_payroll_decision as string) ||
          decision;
        setItems((cur) =>
          cur.map((it) => {
            try {
              const meta = it.metadata || {};
              const target = String(
                meta?.attendance_id || it.target_entity_id || "",
              );
              if (target && String(attendanceId) === target) {
                return {
                  ...it,
                  metadata: {
                    ...meta,
                    check_out_payroll_decision: newDecision,
                    checkOutPayrollDecision: newDecision,
                  },
                };
              }
            } catch (e) {
              // ignore malformed metadata
            }
            return it;
          }),
        );
        // Re-fetch rather than patch in place -- same reasoning
        // AttendanceExceptions.tsx uses for the underlying decision
        // action: simpler and safer than reimplementing "what does this
        // notification look like now" client-side.
        await handleMarkRead(notification);
        await load();
      } catch (err) {
        console.error("Failed to set payroll decision:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to set payroll decision.",
        );
      } finally {
        setDecidingId(null);
      }
    },
    [userId, organizationId, handleMarkRead, load],
  );

  const toggleSelected = useCallback((id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allSelected = items.length > 0 && selectedIds.size === items.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((current) =>
      current.size === items.length
        ? new Set()
        : new Set(items.map((item) => item.id)),
    );
  }, [items]);

  const handleDelete = useCallback(
    async (notification: DashboardNotification) => {
      if (!userId || !organizationId) return;

      const wasUnread = !notification.is_read;
      try {
        await deleteNotification({
          notificationId: notification.id,
          userId,
          organizationId,
        });
        setItems((current) =>
          current.filter((item) => item.id !== notification.id),
        );
        setSelectedIds((current) => {
          if (!current.has(notification.id)) return current;
          const next = new Set(current);
          next.delete(notification.id);
          return next;
        });
        if (wasUnread) setUnreadCount((current) => Math.max(0, current - 1));
      } catch (err) {
        console.error("Failed to delete notification:", err);
        setError("Failed to delete notification.");
      }
    },
    [userId, organizationId],
  );

  const handleBulkDelete = useCallback(async () => {
    if (!userId || !organizationId || selectedIds.size === 0) return;

    const ids = Array.from(selectedIds);
    const confirmed = window.confirm(
      `Delete ${ids.length} notification${ids.length === 1 ? "" : "s"}? This can't be undone.`,
    );
    if (!confirmed) return;

    setDeleting(true);
    try {
      await bulkDeleteNotifications({
        notificationIds: ids,
        userId,
        organizationId,
      });
      const removedIds = new Set(ids);
      setItems((current) => current.filter((item) => !removedIds.has(item.id)));
      setUnreadCount((current) =>
        Math.max(
          0,
          current -
            items.filter((item) => removedIds.has(item.id) && !item.is_read)
              .length,
        ),
      );
      setSelectedIds(new Set());
    } catch (err) {
      console.error("Failed to bulk delete notifications:", err);
      setError("Failed to delete selected notifications.");
    } finally {
      setDeleting(false);
    }
  }, [userId, organizationId, selectedIds, items]);

  // ── Render ─────────────────────────────────────────────────────────────────

  // [Fix-3] Show loading state while org is initializing
  if (!isReady) {
    return (
      <div
        style={{
          fontFamily: "'DM Sans','Inter',sans-serif",
          padding: 38,
          color: T.muted,
          textAlign: "center",
        }}
      >
        Initializing dashboard...
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'DM Sans','Inter',sans-serif",
        display: "grid",
        gap: 18,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <h2
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 900,
              color: T.head,
              letterSpacing: "-.4px",
            }}
          >
            Notifications
          </h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: T.muted }}>
            Module-aware alerts for your dashboard access · {unreadCount} unread
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* Refresh — secondary variant (white bg, slate fill on hover) */}
          <RefreshButton
            variant="secondary"
            size="md"
            loading={refreshing}
            onClick={() => void load()}
          />

          {/* Delete selected — only meaningful once something is checked */}
          {selectedIds.size > 0 && (
            <JellyButton
              variant="danger"
              size="md"
              leftIcon={<Trash2 />}
              disabled={deleting}
              onClick={() => void handleBulkDelete()}
            >
              Delete {selectedIds.size} selected
            </JellyButton>
          )}

          {/* Mark all read — primary when unread exist, ghost when done */}
          <JellyButton
            variant={unreadItems > 0 ? "primary" : "ghost"}
            size="md"
            leftIcon={<CheckCheck />}
            disabled={unreadItems === 0}
            onClick={() => void handleMarkAllRead()}
          >
            Mark all as read
          </JellyButton>
        </div>
      </div>

      {/* Notification list card */}
      <div
        style={{
          background: T.card,
          border: `1px solid ${T.border}`,
          borderRadius: 16,
          boxShadow: "0 1px 3px rgba(15,45,74,0.06)",
        }}
      >
        {loading ? (
          <div style={{ padding: 38, color: T.muted, textAlign: "center" }}>
            Loading notifications...
          </div>
        ) : error ? (
          <div style={{ padding: 24, color: "#e11d48", fontWeight: 800 }}>
            {error}
          </div>
        ) : items.length === 0 ? (
          <div style={{ padding: 46, color: T.muted, textAlign: "center" }}>
            <Bell size={30} color={T.teal600} style={{ opacity: 0.45 }} />
            <div style={{ marginTop: 10, fontWeight: 800 }}>
              No notifications yet
            </div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              Leave, overtime, and new employee events will appear here.
            </div>
          </div>
        ) : (
          <div style={{ display: "grid" }}>
            {/* Select-all row */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 18px",
                borderBottom: `1px solid ${T.teal50}`,
                fontSize: 12,
                color: T.muted,
              }}
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleSelectAll}
                aria-label="Select all notifications"
                style={{ width: 15, height: 15, cursor: "pointer" }}
              />
              <span>
                {selectedIds.size > 0
                  ? `${selectedIds.size} selected`
                  : "Select all"}
              </span>
            </div>

            {items.map((notification) => {
              const unread = !notification.is_read;
              const checked = selectedIds.has(notification.id);
              return (
                <div
                  key={notification.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void handleOpen(notification)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleOpen(notification);
                  }}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "20px 42px minmax(0, 1fr) auto",
                    gap: 14,
                    padding: "16px 18px",
                    borderBottom: `1px solid ${T.teal50}`,
                    background: unread ? T.teal50 : T.card,
                    cursor: "pointer",
                    alignItems: "center",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelected(notification.id)}
                    aria-label={`Select notification: ${notification.title}`}
                    style={{ width: 15, height: 15, cursor: "pointer" }}
                  />
                  <NotificationIconBadge notification={notification} />
                  <NotificationBody notification={notification} />

                  <div
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    {isPayrollDecisionNotification(notification) ? (
                      (() => {
                        const meta = notification.metadata || {};
                        const payrollDecision =
                          (meta.checkOutPayrollDecision as
                            | "include"
                            | "exclude"
                            | undefined) ||
                          (meta.check_out_payroll_decision as
                            | "include"
                            | "exclude"
                            | undefined) ||
                          (meta.payroll_decision as
                            | "include"
                            | "exclude"
                            | undefined) ||
                          undefined;

                        // No decision yet: show both include + exclude.
                        if (!payrollDecision) {
                          return (
                            <>
                              <JellyButton
                                variant="primary"
                                size="sm"
                                leftIcon={<Check />}
                                disabled={decidingId !== null}
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  void handleSetPayrollDecision(
                                    notification,
                                    "include",
                                  );
                                }}
                              >
                                {decidingId === notification.id
                                  ? "Saving…"
                                  : "Include"}
                              </JellyButton>
                              <JellyButton
                                variant="ghost"
                                size="sm"
                                leftIcon={<X />}
                                disabled={decidingId !== null}
                                onClick={(e: React.MouseEvent) => {
                                  e.stopPropagation();
                                  void handleSetPayrollDecision(
                                    notification,
                                    "exclude",
                                  );
                                }}
                              >
                                {decidingId === notification.id
                                  ? "Saving…"
                                  : "Exclude"}
                              </JellyButton>
                            </>
                          );
                        }

                        // Already included: show only Exclude button.
                        if (payrollDecision === "include") {
                          return (
                            <JellyButton
                              variant="ghost"
                              size="sm"
                              leftIcon={<X />}
                              disabled={decidingId !== null}
                              onClick={(e: React.MouseEvent) => {
                                e.stopPropagation();
                                void handleSetPayrollDecision(
                                  notification,
                                  "exclude",
                                );
                              }}
                            >
                              {decidingId === notification.id
                                ? "Saving…"
                                : "Exclude"}
                            </JellyButton>
                          );
                        }

                        // Already excluded: show only Include button.
                        return (
                          <JellyButton
                            variant="primary"
                            size="sm"
                            leftIcon={<Check />}
                            disabled={decidingId !== null}
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              void handleSetPayrollDecision(
                                notification,
                                "include",
                              );
                            }}
                          >
                            {decidingId === notification.id
                              ? "Saving…"
                              : "Include"}
                          </JellyButton>
                        );
                      })()
                    ) : (
                      <>
                        {/*
                         * "Mark read" inline action.
                         * ghost variant: transparent bg, teal icon, teal fill on hover.
                         * disabled when already read → opacity 0.52 automatically.
                         */}
                        <JellyButton
                          variant="ghost"
                          size="sm"
                          leftIcon={<Check />}
                          disabled={!unread}
                          onClick={(e: React.MouseEvent) => {
                            // Prevent the row's own onClick from also firing.
                            e.stopPropagation();
                            void handleMarkRead(notification);
                          }}
                        >
                          {unread ? "Mark read" : "Read"}
                        </JellyButton>

                        {/* Single-delete inline action. */}
                        <JellyButton
                          variant="ghost"
                          size="sm"
                          leftIcon={<Trash2 />}
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            void handleDelete(notification);
                          }}
                        >
                          Delete
                        </JellyButton>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
