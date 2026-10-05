import React, { useEffect, useMemo, useState } from "react";
import { CalendarClock, Loader2 } from "lucide-react";
import { getLeaves } from "../../../api/api";

const CARD = {
  primary: "#1a699f",
  text: "#0f172a",
  muted: "#64748b",
  border: "#dbe8f0",
  card: "#ffffff",
} as const;

type PendingLeave = {
  id?: string | number;
  user_name?: string;
  name?: string;
  leave_type?: string;
  type?: string;
  start_date?: string;
  end_date?: string;
  branch_name?: string;
  branchName?: string;
  status?: string;
};

type PendingLeavesCardProps = {
  branchId?: string | number | null;
  showBranchName?: boolean;
  height?: number;
  listHeight?: number;
  items?: PendingLeave[];
  disableFetch?: boolean;
};

function cardStyle(height?: number): React.CSSProperties {
  return {
    height,
    minHeight: height ? undefined : 260,
    background: CARD.card,
    border: `1px solid ${CARD.border}`,
    borderRadius: 18,
    boxShadow: "0 10px 28px rgba(15,45,74,.07)",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  };
}

function resolveLeaveName(item: PendingLeave): string {
  return String(item.user_name || item.name || "Unknown").trim();
}

function resolveLeaveType(item: PendingLeave): string {
  return String(item.leave_type || item.type || "Leave").trim();
}

function formatDateRange(item: PendingLeave): string {
  const start = String(item.start_date || "").slice(0, 10);
  const end = String(item.end_date || "").slice(0, 10);
  if (start && end && start !== end) return `${start} → ${end}`;
  return start || end || "Date not set";
}

/**
 * FIX: this used to hand-roll its own fetch() against "/api/leave-requests",
 * an endpoint that has never existed on the backend (the real route is
 * GET /api/leaves — see app.py's api_get_leaves and the retired
 * /get_pending_leaves shim, which points callers at it explicitly). It also
 * read the auth token from localStorage keys ("client_access_token",
 * "access_token", ...) that don't match the actual key api.ts's http()
 * uses ("dashboardAuthToken"), and never sent organization_id, which
 * api_get_leaves requires (400 without it).
 *
 * Routing through the existing, already-correct getLeaves() fixes all
 * three at once: right endpoint, right auth header, and organization_id
 * supplied automatically from the stored session — same path
 * LeaveManagement's own list view already uses successfully.
 */
async function fetchPendingLeaves(
  branchId?: string | number | null,
): Promise<PendingLeave[]> {
  const rows = await getLeaves({
    status: "pending",
    branch_id: branchId ?? null,
  });
  return (rows as PendingLeave[]).slice(0, 8);
}

export default function PendingLeavesCard({
  branchId,
  showBranchName = false,
  height,
  listHeight = 220,
  items,
  disableFetch = false,
}: PendingLeavesCardProps) {
  const [remoteItems, setRemoteItems] = useState<PendingLeave[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (disableFetch || items) return;

    const controller = new AbortController();
    let active = true;

    async function load() {
      try {
        setIsLoading(true);
        setError(null);
        const data = await fetchPendingLeaves(branchId);
        if (active && !controller.signal.aborted) setRemoteItems(data);
      } catch (err) {
        if (active && !controller.signal.aborted) {
          setError(
            err instanceof Error
              ? err.message
              : "Failed to load pending leaves.",
          );
          setRemoteItems([]);
        }
      } finally {
        if (active && !controller.signal.aborted) setIsLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [branchId, disableFetch, items]);

  const visibleItems = useMemo(
    () => items ?? remoteItems,
    [items, remoteItems],
  );

  return (
    <section style={cardStyle(height)}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <CalendarClock size={17} color={CARD.primary} />
          <h3
            style={{
              margin: 0,
              fontSize: 14,
              color: CARD.text,
              fontWeight: 900,
            }}
          >
            Pending Leaves
          </h3>
        </div>
        <span style={{ fontSize: 12, fontWeight: 900, color: CARD.muted }}>
          {visibleItems.length}
        </span>
      </div>

      <div
        style={{
          height: listHeight,
          overflow: "auto",
          display: "grid",
          alignContent: "start",
          gap: 10,
        }}
      >
        {isLoading ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              color: CARD.muted,
              fontSize: 13,
            }}
          >
            <Loader2
              size={16}
              style={{ animation: "spin .8s linear infinite" }}
            />{" "}
            Loading leaves…
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        ) : null}

        {error ? (
          <div style={{ color: "#dc2626", fontSize: 13, fontWeight: 700 }}>
            {error}
          </div>
        ) : null}

        {!isLoading && !error && visibleItems.length === 0 ? (
          <div style={{ color: CARD.muted, fontSize: 13, fontStyle: "italic" }}>
            No pending leave requests.
          </div>
        ) : null}

        {visibleItems.map((item, index) => {
          const key = item.id ?? `${resolveLeaveName(item)}-${index}`;
          const branchName = String(
            item.branch_name || item.branchName || "",
          ).trim();
          return (
            <article
              key={key}
              style={{
                border: `1px solid ${CARD.border}`,
                borderRadius: 12,
                padding: 10,
                background: "#f8fcff",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <strong style={{ color: CARD.text, fontSize: 13 }}>
                  {resolveLeaveName(item)}
                </strong>
                <span
                  style={{ color: CARD.primary, fontSize: 11, fontWeight: 900 }}
                >
                  {resolveLeaveType(item)}
                </span>
              </div>
              <div style={{ color: CARD.muted, fontSize: 12, marginTop: 4 }}>
                {formatDateRange(item)}
              </div>
              {showBranchName && branchName ? (
                <div style={{ color: CARD.muted, fontSize: 11, marginTop: 4 }}>
                  {branchName}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export { PendingLeavesCard };
