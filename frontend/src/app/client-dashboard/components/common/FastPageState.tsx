import React, { ReactNode } from "react";

type FastPageStateProps = {
  isLoading?: boolean;
  isFetching?: boolean;
  error?: Error | null;
  hasData?: boolean;
  children: ReactNode;
};

export function FastPageState({ isLoading, isFetching, error, hasData, children }: FastPageStateProps) {
  if (isLoading && !hasData) {
    return (
      <div style={{ padding: 24, borderRadius: 12, background: "#fff", border: "1px solid rgba(148, 163, 184, 0.25)" }}>
        Loading…
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      {children}
      {error && (
        <div style={{ marginTop: 10, padding: 10, borderRadius: 8, background: "#fff1f2", color: "#be123c", fontSize: 13 }}>
          {error.message}
        </div>
      )}
      {isFetching && hasData && (
        <div style={{ position: "absolute", top: 8, right: 8, fontSize: 12, color: "#64748b", background: "rgba(255,255,255,0.9)", padding: "4px 8px", borderRadius: 999 }}>
          Updating…
        </div>
      )}
    </div>
  );
}
