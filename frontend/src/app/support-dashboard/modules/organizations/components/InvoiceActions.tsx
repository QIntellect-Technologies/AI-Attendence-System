/**
 * src/app/support-dashboard/modules/organizations/components/InvoiceActions.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Reusable row actions for Support invoices.
 */

import React, { useState } from "react";
import { CircleDollarSign, Download, Loader2, Mail } from "lucide-react";
import type { Invoice } from "../../../packages/shared-types/src/organization";
import { invoiceDeliveryApi } from "../api/invoiceDeliveryApi";
import InvoiceDeliveryModal from "./InvoiceDeliveryModal";

const T = {
  border: "#e2e8f0",
  text: "#334155",
  green: "#16a34a",
} as const;

interface InvoiceActionsProps {
  invoice: Invoice;
  payingId?: string | null;
  onMarkPaid: (invoiceId: string) => void | Promise<void>;
  onInvoiceUpdated?: (invoice: Invoice) => void;
  onError?: (message: string) => void;
}

function extractError(error: unknown, fallback: string): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const anyError = error as { response?: { data?: { message?: string; error?: string } }; message?: string };
    return anyError.response?.data?.message || anyError.response?.data?.error || anyError.message || fallback;
  }
  return fallback;
}

export default function InvoiceActions({
  invoice,
  payingId,
  onMarkPaid,
  onInvoiceUpdated,
  onError,
}: InvoiceActionsProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadPdf = async () => {
    setIsDownloading(true);
    try {
      await invoiceDeliveryApi.downloadPdf(invoice.id);
    } catch (err) {
      onError?.(extractError(err, "Failed to download invoice PDF."));
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
      <button type="button" onClick={() => setIsModalOpen(true)} style={secondaryButtonStyle}>
        <Mail size={13} /> Message
      </button>

      <button
        type="button"
        onClick={downloadPdf}
        disabled={isDownloading}
        style={{ ...secondaryButtonStyle, opacity: isDownloading ? 0.65 : 1 }}
      >
        {isDownloading ? <Loader2 size={13} className="spin" /> : <Download size={13} />}
        PDF
      </button>

      {String(invoice.status).toLowerCase() === "paid" ? (
        <span
          style={{
            color: T.green,
            fontWeight: 800,
            fontSize: 11,
            display: "inline-flex",
            gap: 5,
            alignItems: "center",
            height: 30,
          }}
        >
          Paid
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onMarkPaid(invoice.id)}
          disabled={payingId === invoice.id || String(invoice.status).toLowerCase() === "cancelled"}
          style={{ ...secondaryButtonStyle, opacity: payingId === invoice.id ? 0.65 : 1 }}
        >
          {payingId === invoice.id ? <Loader2 size={13} className="spin" /> : <CircleDollarSign size={13} />}
          Mark Paid
        </button>
      )}

      {isModalOpen && (
        <InvoiceDeliveryModal
          invoice={invoice}
          onClose={() => setIsModalOpen(false)}
          onMarkedSent={(updatedInvoice) => onInvoiceUpdated?.(updatedInvoice)}
        />
      )}
    </div>
  );
}

const secondaryButtonStyle: React.CSSProperties = {
  minHeight: 30,
  border: `1px solid ${T.border}`,
  borderRadius: 9,
  background: "#fff",
  color: T.text,
  fontSize: 11,
  fontWeight: 800,
  padding: "0 9px",
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  cursor: "pointer",
};
