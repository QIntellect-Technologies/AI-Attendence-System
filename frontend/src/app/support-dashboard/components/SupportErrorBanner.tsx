import React from "react";

export const SupportErrorBanner: React.FC<{ message?: string | null }> = ({ message }) => {
  if (!message) return null;
  return <div style={{ border: "1px solid #fecaca", background: "#fff1f2", color: "#dc2626", borderRadius: 12, padding: "10px 12px", marginBottom: 12, fontSize: 12, fontWeight: 700 }}>{message}</div>;
};
