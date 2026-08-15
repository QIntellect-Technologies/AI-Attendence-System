/**
 * InvoiceDeliveryModal.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Preview/copy/open/mark-sent workflow for invoices.
 *
 * Best approach:
 * - Backend generates the message from real deal data.
 * - Support can copy or open email app.
 * - Support explicitly marks as sent manually.
 * - No fake automatic email sending.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, ExternalLink, Loader2, MailCheck, X } from "lucide-react";
import { invoiceDeliveryApi, type InvoiceMessagePayload } from "../api/invoiceDeliveryApi";
import type { Invoice } from "../../../packages/shared-types/src/organization";

const T = {
  border: "#e2e8f0",
  text: "#334155",
  textMuted: "#64748b",
  textLight: "#94a3b8",
  red: "#ef4444",
  red50: "#fef2f2",
  green: "#16a34a",
  green50: "#f0fdf4",
  slate50: "#f8fafc",
  teal600: "#0d9488",
} as const;

interface Props {
  invoice: Invoice;
  onClose: () => void;
  onMarkedSent?: (invoice: Invoice) => void;
}

function extractError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const anyError = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return anyError.response?.data?.message || anyError.response?.data?.error || anyError.message || fallback;
  }
  return fallback;
}

function buildMailto(to: string, subject: string, message: string): string {
  const params = new URLSearchParams({ subject, body: message });
  return `mailto:${encodeURIComponent(to)}?${params.toString()}`;
}

export default function InvoiceDeliveryModal({ invoice, onClose, onMarkedSent }: Props) {
  const [data, setData] = useState<InvoiceMessagePayload | null>(null);
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isMarking, setIsMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await invoiceDeliveryApi.getMessage(invoice.id);
      setData(result);
      setTo(result.to || "");
      setSubject(result.subject || "");
      setMessage(result.message || "");
    } catch (err) {
      setError(extractError(err, "Failed to generate invoice message."));
    } finally {
      setIsLoading(false);
    }
  }, [invoice.id]);

  useEffect(() => {
    load();
  }, [load]);

  const canSendManually = useMemo(() => Boolean(to.trim() && subject.trim() && message.trim()), [to, subject, message]);

  const copyMessage = async () => {
    setError(null);
    setSuccess(null);
    try {
      await navigator.clipboard.writeText(message);
      setSuccess("Invoice message copied.");
    } catch {
      setError("Could not copy automatically. Select the text and copy manually.");
    }
  };

  const openEmail = () => {
    if (!canSendManually) {
      setError("Client email, subject, and message are required.");
      return;
    }
    window.location.href = buildMailto(to, subject, message);
  };

  const markSent = async () => {
    if (!canSendManually) {
      setError("Client email, subject, and message are required before marking sent.");
      return;
    }

    setIsMarking(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await invoiceDeliveryApi.markSent(invoice.id, {
        sent_to: to.trim(),
        subject: subject.trim(),
        message: message.trim(),
      });
      setSuccess("Invoice marked as sent manually.");
      onMarkedSent?.(updated);
    } catch (err) {
      setError(extractError(err, "Failed to mark invoice as sent."));
    } finally {
      setIsMarking(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "min(860px, 96vw)", maxHeight: "92vh", overflow: "auto", background: "#fff", borderRadius: 18, border: `1px solid ${T.border}`, boxShadow: "0 18px 55px rgba(15,23,42,0.22)" }}>
        <div style={{ padding: 18, borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <div>
            <h2 style={{ margin: 0, color: T.text, fontSize: 18 }}>Send Invoice Message</h2>
            <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 12 }}>Preview, copy, open email app, and mark this invoice as sent manually.</p>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: T.textMuted }}>
            <X size={20} />
          </button>
        </div>

        <div style={{ padding: 18 }}>
          {error && <div style={{ background: T.red50, color: T.red, border: `1px solid ${T.red}`, borderRadius: 12, padding: 10, marginBottom: 12, fontSize: 12 }}>{error}</div>}
          {success && <div style={{ background: T.green50, color: T.green, border: `1px solid ${T.green}`, borderRadius: 12, padding: 10, marginBottom: 12, fontSize: 12 }}>{success}</div>}

          {isLoading ? (
            <div style={{ padding: 28, textAlign: "center", color: T.textLight }}>
              <Loader2 size={18} className="spin" /> Generating invoice message...
            </div>
          ) : data ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: T.textMuted, marginBottom: 5 }}>Client Email</label>
                <input value={to} onChange={(e) => setTo(e.target.value)} style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", fontSize: 13 }} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: T.textMuted, marginBottom: 5 }}>Subject</label>
                <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 10, padding: "10px 12px", fontSize: 13 }} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: T.textMuted, marginBottom: 5 }}>Invoice Message</label>
                <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={18} style={{ width: "100%", border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.55, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace", resize: "vertical" }} />
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ color: T.textMuted, fontSize: 11 }}>
                  Automatic email send is intentionally disabled until SMTP/Resend/SendGrid is configured.
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button type="button" onClick={copyMessage} style={secondaryButtonStyle}><Copy size={14} /> Copy Message</button>
                  <button type="button" onClick={openEmail} disabled={!canSendManually} style={{ ...secondaryButtonStyle, opacity: canSendManually ? 1 : 0.55 }}><ExternalLink size={14} /> Open Email App</button>
                  <button type="button" onClick={markSent} disabled={!canSendManually || isMarking} style={{ ...primaryButtonStyle, opacity: canSendManually && !isMarking ? 1 : 0.6 }}>
                    {isMarking ? <Loader2 size={14} className="spin" /> : <MailCheck size={14} />}
                    Mark Sent Manually
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const secondaryButtonStyle: React.CSSProperties = {
  height: 34,
  border: `1px solid ${T.border}`,
  borderRadius: 10,
  background: "#fff",
  color: T.text,
  fontSize: 12,
  fontWeight: 800,
  padding: "0 12px",
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  ...secondaryButtonStyle,
  border: "none",
  background: T.teal600,
  color: "#fff",
};
