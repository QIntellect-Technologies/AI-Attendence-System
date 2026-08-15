import React, { ReactNode, useMemo, useRef, useState } from "react";

export type FastColumn<T> = {
  key: string;
  title: ReactNode;
  width?: number | string;
  align?: "left" | "center" | "right";
  render: (row: T, index: number) => ReactNode;
  onSort?: () => void;
};

type FastVirtualTableProps<T> = {
  rows: T[];
  columns: FastColumn<T>[];
  rowKey: (row: T, index: number) => string | number;
  height?: number;
  rowHeight?: number;
  overscan?: number;
  emptyText?: ReactNode;
  isFetching?: boolean;
};

export function FastVirtualTable<T>({
  rows,
  columns,
  rowKey,
  height = 560,
  rowHeight = 48,
  overscan = 8,
  emptyText = "No records found.",
  isFetching = false,
}: FastVirtualTableProps<T>) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const totalHeight = rows.length * rowHeight;
  const visibleCount = Math.ceil(height / rowHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(rows.length, startIndex + visibleCount);
  const visibleRows = rows.slice(startIndex, endIndex);

  const gridTemplateColumns = useMemo(
    () => columns.map((column) => (typeof column.width === "number" ? `${column.width}px` : column.width || "1fr")).join(" "),
    [columns],
  );

  return (
    <div style={{ border: "1px solid rgba(148, 163, 184, 0.25)", borderRadius: 12, overflow: "hidden", background: "#fff" }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns,
          minHeight: 44,
          alignItems: "center",
          fontWeight: 700,
          fontSize: 13,
          borderBottom: "1px solid rgba(148, 163, 184, 0.25)",
          background: "rgba(248, 250, 252, 0.95)",
        }}
      >
        {columns.map((column) => (
          <button
            key={column.key}
            type="button"
            onClick={column.onSort}
            disabled={!column.onSort}
            style={{
              textAlign: column.align || "left",
              padding: "0 12px",
              height: 44,
              border: 0,
              background: "transparent",
              font: "inherit",
              fontWeight: 700,
              cursor: column.onSort ? "pointer" : "default",
            }}
          >
            {column.title}
          </button>
        ))}
      </div>

      <div
        ref={viewportRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        style={{ height, overflow: "auto", position: "relative" }}
      >
        {rows.length === 0 ? (
          <div style={{ padding: 24, color: "#64748b", fontSize: 14 }}>{emptyText}</div>
        ) : (
          <div style={{ height: totalHeight, position: "relative" }}>
            {visibleRows.map((row, virtualIndex) => {
              const realIndex = startIndex + virtualIndex;
              return (
                <div
                  key={rowKey(row, realIndex)}
                  style={{
                    display: "grid",
                    gridTemplateColumns,
                    position: "absolute",
                    top: realIndex * rowHeight,
                    left: 0,
                    right: 0,
                    height: rowHeight,
                    alignItems: "center",
                    borderBottom: "1px solid rgba(226, 232, 240, 0.8)",
                    fontSize: 13,
                  }}
                >
                  {columns.map((column) => {
                    const cell = column.render(row, realIndex);
                    return (
                      <div
                        key={column.key}
                        style={{
                          padding: "0 12px",
                          textAlign: column.align || "left",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                        title={typeof cell === "string" ? cell : undefined}
                      >
                        {cell}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}

        {isFetching && rows.length > 0 && (
          <div
            style={{
              position: "sticky",
              bottom: 0,
              padding: "8px 12px",
              background: "rgba(248, 250, 252, 0.92)",
              borderTop: "1px solid rgba(226, 232, 240, 0.8)",
              fontSize: 12,
              color: "#475569",
            }}
          >
            Refreshing…
          </div>
        )}
      </div>
    </div>
  );
}
