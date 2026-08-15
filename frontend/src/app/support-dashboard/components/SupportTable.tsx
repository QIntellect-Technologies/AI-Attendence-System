import React from "react";
import { SupportCard, supportTheme } from "./SupportPageShell";

export interface SupportColumn<T> {
  key: string;
  header: string;
  width?: number | string;
  render: (row: T) => React.ReactNode;
}

interface Props<T> {
  columns: SupportColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  isLoading?: boolean;
  emptyText?: string;
}

export function SupportTable<T>({ columns, rows, getRowKey, isLoading, emptyText = "No records found." }: Props<T>) {
  return (
    <SupportCard>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 820 }}>
          <thead>
            <tr style={{ background: "#f8fafc" }}>
              {columns.map((column) => (
                <th key={column.key} style={{ textAlign: "left", padding: "11px 14px", color: supportTheme.light, fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.07em", borderBottom: `1px solid ${supportTheme.border}`, width: column.width }}>
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, idx) => (
                <tr key={`loading-${idx}`}>
                  <td colSpan={columns.length} style={{ padding: 14, borderBottom: `1px solid ${supportTheme.border}` }}>
                    <div style={{ height: 16, width: `${55 + idx * 7}%`, background: "#eef2f7", borderRadius: 999 }} />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr><td colSpan={columns.length} style={{ padding: 28, textAlign: "center", color: supportTheme.muted, fontSize: 13 }}>{emptyText}</td></tr>
            ) : rows.map((row) => (
              <tr key={getRowKey(row)}>
                {columns.map((column) => <td key={column.key} style={{ padding: "12px 14px", borderBottom: `1px solid ${supportTheme.border}`, color: supportTheme.text, fontSize: 12, verticalAlign: "middle" }}>{column.render(row)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SupportCard>
  );
}
