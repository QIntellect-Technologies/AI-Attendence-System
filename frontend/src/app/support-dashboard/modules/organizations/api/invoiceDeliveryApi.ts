/**
 * src/app/support-dashboard/modules/organizations/api/invoiceDeliveryApi.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Invoice delivery API for Support Dashboard.
 *
 * Phase 1 only:
 * - Preview message from backend source-of-truth deal data.
 * - Download invoice PDF.
 * - Mark invoice as sent manually.
 *
 * No fake automatic email sending.
 */

import { supportApiClient } from "../../../api/supportApiClient";
import type { Invoice } from "../../../packages/shared-types/src/organization";

export interface InvoiceMessagePayload {
  to: string;
  subject: string;
  message: string;
  invoice: Invoice;
  organization?: Record<string, unknown>;
}

interface InvoiceMessageEnvelope {
  success: boolean;
  invoice_message: InvoiceMessagePayload;
}

interface InvoiceEnvelope {
  success: boolean;
  invoice: Invoice;
}

function safeDownloadFilename(invoiceId: string): string {
  return `qintellect-invoice-${encodeURIComponent(invoiceId)}.pdf`;
}

export const invoiceDeliveryApi = {
  getMessage: (invoiceId: string): Promise<InvoiceMessagePayload> =>
    supportApiClient
      .get<InvoiceMessageEnvelope>(`/v1/support/invoices/${encodeURIComponent(invoiceId)}/message`)
      .then((r) => r.data.invoice_message),

  markSent: (invoiceId: string, payload: { sent_to?: string; subject?: string; message?: string }): Promise<Invoice> =>
    supportApiClient
      .patch<InvoiceEnvelope>(`/v1/support/invoices/${encodeURIComponent(invoiceId)}/mark-sent`, payload)
      .then((r) => r.data.invoice),

  downloadPdf: async (invoiceId: string): Promise<void> => {
    const response = await supportApiClient.get(`/v1/support/invoices/${encodeURIComponent(invoiceId)}/pdf`, {
      responseType: "blob",
    });

    const contentDisposition = String(response.headers?.["content-disposition"] || "");
    const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const filename = match?.[1] ? decodeURIComponent(match[1]) : safeDownloadFilename(invoiceId);

    const blob = new Blob([response.data], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
} as const;
