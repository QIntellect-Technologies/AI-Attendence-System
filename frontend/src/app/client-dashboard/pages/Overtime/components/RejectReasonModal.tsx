/**
 * src/modules/overtime/components/RejectReasonModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Confirmation modal for rejecting an overtime request with a reason.
 * Pure presentational component — local textarea state only, no entity data.
 */

import React, { useState } from "react";
import { T } from "../../../components/ui/theme";
import type { OvertimeRequest } from "../../../contexts/ModuleContext";

export interface RejectReasonModalProps {
  request: OvertimeRequest;
  onConfirm: (id: string, reason: string) => void;
  onClose: () => void;
}

export default function RejectReasonModal({
  request,
  onConfirm,
  onClose,
}: RejectReasonModalProps) {
  const [reason, setReason] = useState("");

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        background: "rgba(15,23,42,0.48)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 500,
          background: T.card,
          borderRadius: 16,
          boxShadow: "0 20px 70px rgba(15,23,42,0.25)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "18px 22px",
            borderBottom: `1px solid ${T.border}`,
          }}
        >
          <h3 style={{ margin: 0, color: T.head, fontSize: 16 }}>
            Reject Overtime Request
          </h3>
          <p style={{ margin: "4px 0 0", color: T.muted, fontSize: 12 }}>
            {request.staffName} · {request.staffId}
          </p>
        </div>
        <div style={{ padding: 22 }}>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Write rejection reason..."
            style={{
              width: "100%",
              minHeight: 110,
              resize: "vertical",
              border: `1px solid ${T.border}`,
              borderRadius: 12,
              padding: 12,
              fontFamily: "inherit",
              fontSize: 13,
              color: T.head,
              boxSizing: "border-box",
            }}
          />
        </div>
        <div
          style={{
            padding: "14px 22px",
            borderTop: `1px solid ${T.border}`,
            display: "flex",
            justifyContent: "flex-end",
            gap: 10,
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 38,
              borderRadius: 9,
              border: `1px solid ${T.border}`,
              background: T.card,
              cursor: "pointer",
              padding: "0 16px",
              fontSize: 12,
              fontWeight: 900,
              color: T.head,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() =>
              onConfirm(request.id, reason.trim() || "Rejected by admin")
            }
            style={{
              border: "none",
              background: "#e11d48",
              color: "#fff",
              borderRadius: 10,
              padding: "9px 14px",
              cursor: "pointer",
              fontWeight: 900,
            }}
          >
            Reject Request
          </button>
        </div>
      </div>
    </div>
  );
}
