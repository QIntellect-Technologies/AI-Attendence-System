/**
 * modules/staff/components/StaffCredentialsModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * One-time display of generated login credentials, with copy/download.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { type FC, useState } from "react";
import { Copy, Download, KeyRound, X } from "lucide-react";
import { T } from "../../../components/ui/theme";
import {
  buildCredentialsFile,
  downloadTextFile,
  safeSlug,
  type StaffLoginCredentials,
} from "../utils/staffCredentials";

// ─── Generated Credentials Modal ─────────────────────────────────────────────

export const StaffCredentialsModal: FC<{
  credentials: StaffLoginCredentials;
  onClose: () => void;
}> = ({ credentials, onClose }) => {
  const fileText = buildCredentialsFile(credentials);
  const filename = `${safeSlug(credentials.employeeName)}_login_credentials.txt`;

  // This password is shown here once and never again — it isn't stored
  // in plaintext anywhere the admin can retrieve it later. Require an
  // explicit save (download or copy) before the modal can be dismissed,
  // so an admin can't click away and lock themselves out of handing the
  // employee their credentials.
  const [saved, setSaved] = useState(false);

  const requestClose = () => {
    if (saved) onClose();
  };

  const copyCredentials = () => {
    if (navigator.clipboard) {
      navigator.clipboard
        .writeText(fileText)
        .then(() => setSaved(true))
        .catch(() => undefined);
    }
  };

  const downloadCredentials = () => {
    downloadTextFile(filename, fileText);
    setSaved(true);
  };

  const fieldStyle: React.CSSProperties = {
    background: T.slate50,
    border: `1px solid ${T.border}`,
    borderRadius: 10,
    padding: "10px 12px",
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1200,
        background: "rgba(15,23,42,0.48)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
      onClick={(e) => e.target === e.currentTarget && requestClose()}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 520,
          background: T.card,
          borderRadius: 18,
          boxShadow: "0 24px 70px rgba(15,23,42,0.28)",
          overflow: "hidden",
          fontFamily: "'DM Sans','Inter','Segoe UI',sans-serif",
        }}
      >
        <div
          style={{
            padding: "18px 22px",
            borderBottom: `1px solid ${T.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: T.teal50,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                background: T.teal600,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <KeyRound size={16} color="#fff" />
            </span>
            <div>
              <div style={{ fontSize: 15, fontWeight: 900, color: T.head }}>
                Login Credentials Generated
              </div>
              <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
                Employee can use these credentials only in the staff portal and
                selected dashboard modules.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={requestClose}
            disabled={!saved}
            title={
              saved
                ? "Close"
                : "Download or copy the credentials before closing"
            }
            style={{
              background: "none",
              border: "none",
              cursor: saved ? "pointer" : "not-allowed",
              color: saved ? T.muted : T.border,
            }}
          >
            <X size={18} />
          </button>
        </div>

        <div
          style={{
            padding: 22,
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          <div style={fieldStyle}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                color: T.muted,
                textTransform: "uppercase",
              }}
            >
              Employee
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 800,
                color: T.head,
                marginTop: 3,
              }}
            >
              {credentials.employeeName}
            </div>
            <div style={{ fontSize: 12, color: T.muted, marginTop: 2 }}>
              {credentials.branchName} ·{" "}
              {credentials.staffType === "field"
                ? "Field Staff"
                : "Office Staff"}
            </div>
          </div>

          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}
          >
            <div style={fieldStyle}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  color: T.muted,
                  textTransform: "uppercase",
                }}
              >
                Username / Number
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 900,
                  color: T.teal600,
                  marginTop: 4,
                }}
              >
                {credentials.username}
              </div>
            </div>
            <div style={fieldStyle}>
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 800,
                  color: T.muted,
                  textTransform: "uppercase",
                }}
              >
                Password
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 900,
                  color: T.teal600,
                  marginTop: 4,
                }}
              >
                {credentials.password}
              </div>
            </div>
          </div>

          <div style={fieldStyle}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                color: T.muted,
                textTransform: "uppercase",
              }}
            >
              Access
            </div>
            <div
              style={{
                fontSize: 12,
                color: T.head,
                marginTop: 5,
                lineHeight: 1.6,
              }}
            >
              Staff Portal: <strong>Enabled</strong>
              <br />
              Desktop Dashboard: <strong>Enabled — branch only</strong>
              <br />
              Dashboard Modules:{" "}
              <strong>
                {credentials.allowedModules.length
                  ? credentials.allowedModules.join(", ")
                  : "Basic staff portal"}
              </strong>
            </div>
          </div>

          {!saved && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11,
                fontWeight: 700,
                color: T.amber,
                background: T.amberBg,
                border: `1px solid ${T.amber}40`,
                borderRadius: 8,
                padding: "8px 10px",
              }}
            >
              This password won't be shown again. Download or copy it before
              closing.
            </div>
          )}

          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 10,
              marginTop: 6,
            }}
          >
            {saved && (
              <button
                type="button"
                onClick={onClose}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  border: `1px solid ${T.border}`,
                  background: T.card,
                  color: T.head,
                  borderRadius: 10,
                  padding: "9px 14px",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 800,
                }}
              >
                Close
              </button>
            )}
            <button
              type="button"
              onClick={copyCredentials}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                border: `1px solid ${T.border}`,
                background: T.card,
                color: T.head,
                borderRadius: 10,
                padding: "9px 14px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 800,
              }}
            >
              <Copy size={14} color={T.teal600} /> Copy
            </button>
            <button
              type="button"
              onClick={downloadCredentials}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                border: "none",
                background: T.teal600,
                color: "#fff",
                borderRadius: 10,
                padding: "9px 14px",
                cursor: "pointer",
                fontSize: 12,
                fontWeight: 900,
              }}
            >
              <Download size={14} color="#fff" /> Download Credentials
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
