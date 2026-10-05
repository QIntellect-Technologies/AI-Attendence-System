import React from "react";
import ModernSelect from "../ui/ModernSelect";

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

  const btnStyle = (isDisabled: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "6px 14px",
    fontSize: "13px",
    fontWeight: 600,
    color: isDisabled ? "#94a3b8" : "#1e293b",
    backgroundColor: isDisabled ? "#f8fafc" : "#ffffff",
    border: `1px solid ${isDisabled ? "#e2e8f0" : "#cbd5e1"}`,
    borderRadius: "8px",
    cursor: isDisabled ? "not-allowed" : "pointer",
    transition: "all 0.15s ease-in-out",
    boxShadow: isDisabled ? "none" : "0 1px 2px rgba(0, 0, 0, 0.05)",
    userSelect: "none",
  });

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 0" }}>
      <div style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>
        Showing {from}–{to} of {total}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ModernSelect
          value={String(pageSize)}
          options={[25, 50, 100, 150, 250].map((size) => ({
            value: String(size),
            label: `${size} / page`,
          }))}
          onChange={(value) => onPageSizeChange(Number(value))}
          ariaLabel="Rows per page"
          disabled={disabled}
          minWidth={110}
        />
        <button
          type="button"
          onClick={() => onPageChange(Math.max(1, page - 1))}
          disabled={disabled || page <= 1}
          style={btnStyle(Boolean(disabled || page <= 1))}
        >
          Prev
        </button>
        <span style={{ fontSize: 13, color: "#475569", fontWeight: 600, padding: "0 4px" }}>
          Page {page} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
          disabled={disabled || page >= totalPages}
          style={btnStyle(Boolean(disabled || page >= totalPages))}
        >
          Next
        </button>
      </div>
    </div>
  );
}
