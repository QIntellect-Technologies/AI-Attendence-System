import React from "react";

const DashboardLoader: React.FC = () => (
  <div
    role="status"
    aria-live="polite"
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      color: "var(--text-light, #94a3b8)",
      background: "var(--dashboard-background, #f1f5f9)",
    }}
  >
    <div
      aria-hidden="true"
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        border: "3px solid var(--teal-100, #e6f3f9)",
        borderTopColor: "var(--teal-600, #1a699f)",
        animation: "spin .65s linear infinite",
      }}
    />
    <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    <span style={{ fontSize: 13, fontWeight: 500 }}>Loading</span>
  </div>
);

export default DashboardLoader;
