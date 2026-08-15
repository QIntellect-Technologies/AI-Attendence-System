import React from "react";
import { supportTheme } from "./SupportPageShell";

export interface PageMeta { page: number; page_size?: number; pageSize?: number; total: number; total_pages?: number; totalPages?: number; has_more?: boolean; hasMore?: boolean }

interface Props { page: PageMeta; onPageChange: (page: number) => void; disabled?: boolean }

export const SupportPagination: React.FC<Props> = ({ page, onPageChange, disabled }) => {
  const current = Number(page.page || 1);
  const totalPages = Number(page.total_pages || page.totalPages || 1);
  const pageSize = Number(page.page_size || page.pageSize || 25);
  const total = Number(page.total || 0);
  const start = total ? (current - 1) * pageSize + 1 : 0;
  const end = Math.min(total, current * pageSize);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap", color: supportTheme.muted, fontSize: 12 }}>
      <span>{start}–{end} of {total}</span>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" disabled={disabled || current <= 1} onClick={() => onPageChange(current - 1)} style={buttonStyle(disabled || current <= 1)}>Previous</button>
        <span style={{ alignSelf: "center", fontWeight: 800, color: supportTheme.text }}>Page {current} / {totalPages}</span>
        <button type="button" disabled={disabled || current >= totalPages} onClick={() => onPageChange(current + 1)} style={buttonStyle(disabled || current >= totalPages)}>Next</button>
      </div>
    </div>
  );
};

function buttonStyle(disabled?: boolean): React.CSSProperties {
  return { border: `1px solid ${supportTheme.border}`, background: disabled ? "#f1f5f9" : "#fff", color: disabled ? supportTheme.light : supportTheme.text, borderRadius: 9, padding: "8px 12px", fontSize: 12, fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer" };
}
