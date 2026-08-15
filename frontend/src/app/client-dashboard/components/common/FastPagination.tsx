import React from "react";

type FastPaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  disabled?: boolean;
};

export function FastPagination({ page, pageSize, total, onPageChange, onPageSizeChange, disabled }: FastPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0" }}>
      <div style={{ fontSize: 13, color: "#64748b" }}>
        Showing {from}–{to} of {total}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <select value={pageSize} onChange={(event) => onPageSizeChange(Number(event.target.value))} disabled={disabled}>
          {[25, 50, 100, 150, 250].map((size) => (
            <option key={size} value={size}>{size} / page</option>
          ))}
        </select>
        <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={disabled || page <= 1}>Prev</button>
        <span style={{ fontSize: 13 }}>Page {page} / {totalPages}</span>
        <button type="button" onClick={() => onPageChange(Math.min(totalPages, page + 1))} disabled={disabled || page >= totalPages}>Next</button>
      </div>
    </div>
  );
}
